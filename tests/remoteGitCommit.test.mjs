import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";

/*
 * Managed commit: the tree comes from the verified index, the commit object carries the repository's own
 * identity, and the ref moves through a native compare-and-swap against the HEAD the caller confirmed.
 *
 * These tests drive the real deployed helper bytes as a child process and check the repository with native
 * Git afterwards, so "the commit happened" is never the helper's own word. The reachable refusals are all
 * asserted together with their side effects: no ref move, no index write and no owned residue.
 */

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];

function baseline(f) {
	writeFileSync(join(f.root, "one.txt"), "base\n");
	f.git("add", "--", "one.txt");
	f.git(...IDENTITY, "commit", "-qm", "baseline");
}
/** Repository-local identity, which is what a user would set in the terminal; the helper only ever reads it. */
function localIdentity(f, name = "Repo Local", email = "repo@example.invalid") {
	f.git("config", "user.name", name);
	f.git("config", "user.email", email);
	return `${name} <${email}>`;
}
async function revision(f) {
	const value = successful(await f.request("git.status")).revision;
	assert.match(value, /^[a-f0-9]{64}$/, "status must carry the fingerprint the commit is bound to");
	return value;
}
async function code(f, params, timeoutMs) {
	const frame = await f.request("git.commit", params, timeoutMs);
	assert.equal(frame.ok, false, "expected a refusal, got " + JSON.stringify(frame.result));
	return frame.error?.code;
}
async function commit(f, message, expected) {
	return successful(await f.request("git.commit", { message, expectedRevision: expected }));
}
function noScratch(f) {
	assert.equal(existsSync(join(f.root, ".git/index.lock")), false, "the helper must release its own lock");
	assert.deepEqual(
		readdirSync(join(f.root, ".git")).filter((name) => name.startsWith("pideck-index-")),
		[],
		"an owned scratch directory must not survive",
	);
}
/** Identity of the real index file: a commit must not rewrite it at all, not even its stat cache. */
function indexFacts(f) {
	const stats = statSync(join(f.root, ".git/index"), { bigint: true });
	return {
		sha: createHash("sha256")
			.update(readFileSync(join(f.root, ".git/index")))
			.digest("hex"),
		ino: String(stats.ino),
		mtimeNs: String(stats.mtimeNs),
		size: String(stats.size),
	};
}

test("the helper advertises the managed commit capability it implements", options, async (t) => {
	const f = fixture(t);
	const hello = successful(await f.request("hello"));
	assert.ok(Array.from(hello.capabilities).includes("git.commit"), "hello must negotiate git.commit: " + JSON.stringify(hello.capabilities));
});

test("a commit writes the confirmed tree, moves the ref and publishes no index bytes", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	localIdentity(f);
	const before = f.git("rev-parse", "HEAD").trim();
	writeFileSync(join(f.root, "one.txt"), "latest\n");
	f.git("add", "--", "one.txt");
	const expected = await revision(f);
	const index = indexFacts(f);
	const result = await commit(f, "subject line\n\nbody line\n# kept verbatim\n", expected);
	assert.deepEqual(Object.keys(result).sort(), ["applied", "head", "tree"]);
	assert.equal(f.git("rev-parse", "HEAD").trim(), result.head);
	assert.equal(f.git("rev-parse", "HEAD^{tree}").trim(), result.tree);
	assert.equal(f.git("rev-parse", "HEAD^").trim(), before);
	assert.equal(f.git("log", "-1", "--format=%s", result.head), "subject line\n");
	assert.equal(f.git("log", "-1", "--format=%B", result.head).trimEnd(), "subject line\n\nbody line\n# kept verbatim");
	assert.equal(f.git("log", "-1", "--format=%an <%ae>|%cn <%ce>", result.head).trimEnd(), "Repo Local <repo@example.invalid>|Repo Local <repo@example.invalid>");
	assert.equal(f.git("reflog", "-1", "--format=%gs").trimEnd(), "commit: subject line");
	assert.equal(f.git("--no-optional-locks", "status", "--porcelain=v1"), "", "the index now equals the new HEAD tree");
	assert.equal(readFileSync(join(f.root, "one.txt"), "utf8"), "latest\n", "the working tree is never touched");
	assert.deepEqual(indexFacts(f), index, "a commit must not write the real index");
	noScratch(f);
});

test("an unborn repository commits a root commit through the same compare-and-swap", options, async (t) => {
	const f = fixture(t);
	localIdentity(f);
	writeFileSync(join(f.root, "first.txt"), "first\n");
	f.git("add", "--", "first.txt");
	const result = await commit(f, "root commit\n", await revision(f));
	assert.equal(f.git("rev-parse", "HEAD").trim(), result.head);
	assert.equal(f.git("rev-list", "--parents", "-n", "1", result.head).trim().split(" ").length, 1, "the first commit has no parent");
	assert.equal(f.git("log", "-1", "--format=%s"), "root commit\n");
	assert.equal(f.git("--no-optional-locks", "status", "--porcelain=v1"), "");
	noScratch(f);
});

test("nothing staged is refused after a commit instead of creating an empty commit", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const expected = await revision(f);
	const head = f.git("rev-parse", "HEAD").trim();
	assert.equal(await code(f, { message: "again\n", expectedRevision: expected }), "GIT_COMMIT_NOTHING_STAGED");
	assert.equal(f.git("rev-parse", "HEAD").trim(), head);
	noScratch(f);
});

test("the message is validated before anything is written", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	localIdentity(f);
	writeFileSync(join(f.root, "two.txt"), "other\n");
	f.git("add", "--", "two.txt");
	const expected = await revision(f);
	const head = f.git("rev-parse", "HEAD").trim();
	for (const [message, expectedCode] of [
		["", "GIT_COMMIT_MESSAGE_EMPTY"],
		["   \n\t\n", "GIT_COMMIT_MESSAGE_EMPTY"],
		["x".repeat(4097), "GIT_RESULT_INVALID"],
		["a\u0000b", "GIT_RESULT_INVALID"],
	]) {
		assert.equal(await code(f, { message, expectedRevision: expected }), expectedCode, JSON.stringify(message.slice(0, 20)));
	}
	assert.equal(await code(f, { message: "ok\n", expectedRevision: expected, path: "two.txt" }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, { message: 7, expectedRevision: expected }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, { message: "ok\n", expectedRevision: "nope" }), "GIT_RESULT_INVALID");
	assert.equal(f.git("rev-parse", "HEAD").trim(), head, "no refusal may move HEAD");
	noScratch(f);
});

test("identity is read from the repository, then from the global file, and otherwise refuses", options, async (t) => {
	const repo = fixture(t);
	baseline(repo);
	const local = localIdentity(repo);
	writeFileSync(join(repo.root, "two.txt"), "other\n");
	repo.git("add", "--", "two.txt");
	const committed = await commit(repo, "with local identity\n", await revision(repo));
	assert.equal(repo.git("log", "-1", "--format=%an <%ae>", committed.head).trimEnd(), local);

	const global = fixture(t);
	baseline(global);
	mkdirSync(join(global.directory, "home"), { recursive: true });
	writeFileSync(join(global.directory, "home", ".gitconfig"), "[user]\n\tname = Global User\n\temail = global@example.invalid\n");
	writeFileSync(join(global.root, "two.txt"), "other\n");
	global.git("add", "--", "two.txt");
	const viaGlobal = await commit(global, "with global identity\n", await revision(global));
	assert.equal(global.git("log", "-1", "--format=%an <%ae>", viaGlobal.head).trimEnd(), "Global User <global@example.invalid>");

	const none = fixture(t);
	baseline(none);
	writeFileSync(join(none.root, "two.txt"), "other\n");
	none.git("add", "--", "two.txt");
	const head = none.git("rev-parse", "HEAD").trim();
	assert.equal(await code(none, { message: "no identity\n", expectedRevision: await revision(none) }), "GIT_COMMIT_IDENTITY_REQUIRED");
	assert.equal(none.git("rev-parse", "HEAD").trim(), head);
	noScratch(none);
});

test("effective hooks, hooksPath and signing refuse the commit and are never executed", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	localIdentity(f);
	const marker = join(f.directory, "hook-ran");
	mkdirSync(join(f.root, ".git/hooks"), { recursive: true });
	writeFileSync(join(f.root, ".git/hooks/pre-commit"), `#!/bin/sh\nprintf ran > "${marker}"\nexit 1\n`);
	chmodSync(join(f.root, ".git/hooks/pre-commit"), 0o700);
	const outside = join(f.directory, "hooks-outside");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "pre-commit"), `#!/bin/sh\nprintf ran > "${marker}"\n`);
	chmodSync(join(outside, "pre-commit"), 0o700);
	writeFileSync(join(f.root, "two.txt"), "other\n");
	f.git("add", "--", "two.txt");
	const head = f.git("rev-parse", "HEAD").trim();
	assert.equal(await code(f, { message: "hooks\n", expectedRevision: await revision(f) }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(existsSync(marker), false, "a refused commit must not run any hook");
	f.git("config", "core.hooksPath", outside);
	assert.equal(await code(f, { message: "hooksPath\n", expectedRevision: await revision(f) }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(existsSync(marker), false);
	f.git("config", "--unset", "core.hooksPath");
	f.git("config", "commit.gpgSign", "true");
	assert.equal(await code(f, { message: "signed\n", expectedRevision: await revision(f) }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(f.git("rev-parse", "HEAD").trim(), head);
	noScratch(f);
});

test("an operation in progress refuses the commit instead of finishing someone else's merge", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	localIdentity(f);
	writeFileSync(join(f.root, "two.txt"), "other\n");
	f.git("add", "--", "two.txt");
	writeFileSync(join(f.root, ".git/MERGE_HEAD"), f.git("rev-parse", "HEAD"));
	const head = f.git("rev-parse", "HEAD").trim();
	assert.equal(await code(f, { message: "merge\n", expectedRevision: await revision(f) }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(f.git("rev-parse", "HEAD").trim(), head);
	noScratch(f);
});

test("an existing official index lock is refused and preserved", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	localIdentity(f);
	writeFileSync(join(f.root, "two.txt"), "other\n");
	f.git("add", "--", "two.txt");
	const expected = await revision(f);
	writeFileSync(join(f.root, ".git/index.lock"), "OTHER WRITER\n");
	assert.equal(await code(f, { message: "locked\n", expectedRevision: expected }), "GIT_INDEX_LOCKED");
	assert.equal(readFileSync(join(f.root, ".git/index.lock"), "utf8"), "OTHER WRITER\n", "the foreign lock is never touched");
	// A foreign lock must not poison the next attempt once its owner is gone.
	assert.equal(await code(f, { message: "locked again\n", expectedRevision: expected }), "GIT_INDEX_LOCKED");
	assert.equal(readFileSync(join(f.root, ".git/index.lock"), "utf8"), "OTHER WRITER\n");
	assert.deepEqual(
		readdirSync(join(f.root, ".git")).filter((name) => name.startsWith("pideck-index-")),
		[],
		"a refused commit leaves no scratch",
	);
	// Once the other writer releases it, the same expectation still commits.
	unlinkSync(join(f.root, ".git/index.lock"));
	const committed = await commit(f, "after the lock\n", expected);
	assert.equal(f.git("rev-parse", "HEAD").trim(), committed.head);
	noScratch(f);
});

test("a stale expectation refuses without creating a commit", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	localIdentity(f);
	writeFileSync(join(f.root, "two.txt"), "other\n");
	f.git("add", "--", "two.txt");
	const expected = await revision(f);
	writeFileSync(join(f.root, "three.txt"), "third\n");
	f.git("add", "--", "three.txt");
	const head = f.git("rev-parse", "HEAD").trim();
	assert.equal(await code(f, { message: "stale\n", expectedRevision: expected }), "GIT_RESOURCE_CHANGED");
	assert.equal(f.git("rev-parse", "HEAD").trim(), head);
	noScratch(f);
});

test("a HEAD that moved outside PiDeck refuses instead of committing onto the new head", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	localIdentity(f);
	writeFileSync(join(f.root, "two.txt"), "other\n");
	f.git("add", "--", "two.txt");
	const expected = await revision(f);
	f.git(...IDENTITY, "commit", "-qm", "native commit");
	const head = f.git("rev-parse", "HEAD").trim();
	assert.equal(await code(f, { message: "too late\n", expectedRevision: expected }), "GIT_RESOURCE_CHANGED");
	assert.equal(f.git("rev-parse", "HEAD").trim(), head, "the native commit stays HEAD");
	assert.equal(f.git("log", "-1", "--format=%s"), "native commit\n");
	noScratch(f);
});

test("a ref lock refuses the compare-and-swap without claiming a commit was created", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	localIdentity(f);
	writeFileSync(join(f.root, "two.txt"), "other\n");
	f.git("add", "--", "two.txt");
	const expected = await revision(f);
	const head = f.git("rev-parse", "HEAD").trim();
	const branch = f.git("symbolic-ref", "--short", "HEAD").trim();
	writeFileSync(join(f.root, ".git/refs/heads", branch + ".lock"), "OTHER WRITER\n");
	assert.equal(await code(f, { message: "ref locked\n", expectedRevision: expected }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(f.git("rev-parse", "HEAD").trim(), head, "HEAD must not move while the ref is locked elsewhere");
	noScratch(f);
});

test("a request that expires before it runs leaves no lock, no scratch and no commit", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	localIdentity(f);
	writeFileSync(join(f.root, "two.txt"), "other\n");
	f.git("add", "--", "two.txt");
	const expected = await revision(f);
	const head = f.git("rev-parse", "HEAD").trim();
	assert.equal(await code(f, { message: "too slow\n", expectedRevision: expected }, 1), "REQUEST_TIMEOUT");
	assert.equal(f.git("rev-parse", "HEAD").trim(), head);
	noScratch(f);
});
