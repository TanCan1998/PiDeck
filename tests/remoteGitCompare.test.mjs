import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";

/*
 * G5b refs compare: two full local refs, their trees, a bounded changed-file list. These tests drive the
 * deployed helper as a child process and check every answer against native Git, so "the comparison is right"
 * never rests on the helper's own wording. The rename pre-image assertion is deliberate: a refactor that flips
 * the two path tokens would still produce a plausible list, and only the direction check catches it.
 */

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LONG_TIMEOUT = { timeout: 180_000, skip: process.platform !== "linux" };

function baseline(f) {
	// Annotated tags need a committer identity too: the fixture's HOME is isolated, so pin it locally once.
	f.git("config", "user.name", "Fixture");
	f.git("config", "user.email", "fixture@example.invalid");
	writeFileSync(join(f.root, "a.txt"), "base-a\n");
	writeFileSync(join(f.root, "b.txt"), "base-b\n");
	writeFileSync(join(f.root, "c.txt"), "base-c\n");
	f.git("add", "-A");
	f.git(...IDENTITY, "commit", "-qm", "baseline");
	f.git("tag", "v1.0");
}
function second(f) {
	writeFileSync(join(f.root, "a.txt"), "changed-a\n");
	f.git("mv", "--", "b.txt", "d.txt");
	f.git("rm", "-q", "--", "c.txt");
	writeFileSync(join(f.root, "e.txt"), "added-e\n");
	f.git("add", "-A");
	f.git(...IDENTITY, "commit", "-qm", "second");
	f.git("tag", "-a", "-m", "annotated", "v2.0");
}
/** The read batch must not write anything: this is the witness around every call below. */
function readOnlyWitness(f) {
	const stats = statSync(join(f.root, ".git/index"), { bigint: true });
	return {
		index: createHash("sha256")
			.update(readFileSync(join(f.root, ".git/index")))
			.digest("hex"),
		ino: String(stats.ino),
		mtimeNs: String(stats.mtimeNs),
		refs: f.git("for-each-ref", "--format=%(refname) %(objectname)"),
		head: f.git("rev-parse", "HEAD") + f.git("symbolic-ref", "HEAD"),
	};
}
function assertReadOnly(f, before) {
	const stats = statSync(join(f.root, ".git/index"), { bigint: true });
	assert.equal(
		createHash("sha256")
			.update(readFileSync(join(f.root, ".git/index")))
			.digest("hex"),
		before.index,
		"a compare must not rewrite the index",
	);
	assert.equal(String(stats.ino), before.ino);
	assert.equal(String(stats.mtimeNs), before.mtimeNs);
	assert.equal(f.git("for-each-ref", "--format=%(refname) %(objectname)"), before.refs, "a compare must not move a ref");
	assert.equal(f.git("rev-parse", "HEAD") + f.git("symbolic-ref", "HEAD"), before.head);
	assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
	assert.deepEqual(
		readdirSync(join(f.root, ".git")).filter((name) => name.startsWith("pideck-index-")),
		[],
	);
}
async function code(f, params) {
	const frame = await f.request("git.compare", params);
	assert.equal(frame.ok, false, "expected a refusal, got " + JSON.stringify(frame.result));
	return frame.error?.code;
}
/** Native oracle for the same two commits, parsed the same way the protocol defines the records. */
function nativeFiles(f, base, head) {
	const raw = f.git("diff", "--name-status", "-z", "--find-renames", base, head);
	const tokens = raw.length === 0 ? [] : raw.split("\u0000");
	if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
	const files = [];
	for (let index = 0; index < tokens.length; ) {
		const status = tokens[index++],
			renamed = status.startsWith("R") || status.startsWith("C");
		const first = tokens[index++];
		files.push(renamed ? { status, path: tokens[index++], oldPath: first } : { status, path: first });
	}
	return files;
}
function sortFiles(files) {
	return [...files].sort((left, right) => left.path.localeCompare(right.path) || (left.oldPath ?? "").localeCompare(right.oldPath ?? ""));
}

test("the helper advertises the compare capability it implements", options, async (t) => {
	const f = fixture(t);
	const hello = successful(await f.request("hello"));
	assert.ok(Array.from(hello.capabilities).includes("git.compare"));
});

test("comparing a ref with itself (or two refs at one OID) is an empty no-op", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	f.git("tag", "same", "refs/tags/v1.0^{commit}");
	const before = readOnlyWitness(f);
	const self = successful(await f.request("git.compare", { base: "refs/tags/v1.0", head: "refs/tags/v1.0" }));
	assert.deepEqual(Array.from(self.files), []);
	assert.equal(self.base.ref, "refs/tags/v1.0");
	assert.equal(self.base.oid, f.git("rev-parse", "v1.0^{commit}").trim());
	const same = successful(await f.request("git.compare", { base: "refs/tags/v1.0", head: "refs/tags/same" }));
	assert.deepEqual(Array.from(same.files), []);
	assertReadOnly(f, before);
});

test("both directions match native Git, and a rename keeps its pre-image as oldPath", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	second(f);
	const baseOid = f.git("rev-parse", "refs/tags/v1.0^{commit}").trim();
	const headOid = f.git("rev-parse", "refs/tags/v2.0^{commit}").trim();
	const before = readOnlyWitness(f);

	const forward = successful(await f.request("git.compare", { base: "refs/tags/v1.0", head: "refs/tags/v2.0" }));
	assert.equal(forward.base.oid, baseOid);
	assert.equal(forward.head.oid, headOid);
	assert.equal(forward.base.ref, "refs/tags/v1.0");
	assert.equal(forward.head.ref, "refs/tags/v2.0");
	assert.deepEqual(sortFiles(forward.files), sortFiles(nativeFiles(f, baseOid, headOid)));
	// Direction matters: the pre-image is the old path, the post-image is the current path.
	const forwardRename = forward.files.find((file) => file.status === "R100");
	assert.deepEqual({ status: forwardRename.status, path: forwardRename.path, oldPath: forwardRename.oldPath }, { status: "R100", path: "d.txt", oldPath: "b.txt" }, "forward rename must be b.txt -> d.txt");

	const reverse = successful(await f.request("git.compare", { base: "refs/tags/v2.0", head: "refs/tags/v1.0" }));
	assert.deepEqual(sortFiles(reverse.files), sortFiles(nativeFiles(f, headOid, baseOid)));
	const reverseRename = reverse.files.find((file) => file.status === "R100");
	assert.deepEqual({ status: reverseRename.status, path: reverseRename.path, oldPath: reverseRename.oldPath }, { status: "R100", path: "b.txt", oldPath: "d.txt" }, "reverse rename must be d.txt -> b.txt");
	assertReadOnly(f, before);
});

test("branches compare by committed tree: ahead, behind and a fast-forward ancestor", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const branch = f.git("symbolic-ref", "--short", "HEAD").trim();
	// feature/x stays on the baseline commit; the checked-out branch gains one edit on top of it.
	f.git("branch", "--", "feature/x");
	writeFileSync(join(f.root, "a.txt"), "on-branch\n");
	f.git("add", "-A");
	f.git(...IDENTITY, "commit", "-qm", "branch edit");
	const ahead = successful(await f.request("git.compare", { base: "refs/heads/" + branch, head: "refs/heads/feature/x" }));
	assert.deepEqual(Array.from(ahead.files), [{ status: "M", path: "a.txt" }]);
	// The other direction is the same set: two-dot tree comparison carries no merge-base arithmetic.
	const behind = successful(await f.request("git.compare", { base: "refs/heads/feature/x", head: "refs/heads/" + branch }));
	assert.deepEqual(Array.from(behind.files), [{ status: "M", path: "a.txt" }]);
	// An ancestor pair still lists the changes between the two trees, it does not look for a merge base.
	const ancestor = successful(await f.request("git.compare", { base: "refs/tags/v1.0", head: "refs/heads/" + branch }));
	assert.deepEqual(Array.from(ancestor.files), [{ status: "M", path: "a.txt" }]);
	// The same two OIDs told the other way round is a delete/add pair, not a rename.
	const unicode = successful(await f.request("git.compare", { base: "refs/heads/" + branch, head: "refs/tags/v1.0" }));
	assert.deepEqual(Array.from(unicode.files), [{ status: "M", path: "a.txt" }]);
});

test("a unicode local branch name is a legal full ref once it exists", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	f.git("branch", "--", "ünïcode");
	writeFileSync(join(f.root, "a.txt"), "unicode\n");
	f.git("add", "-A");
	f.git(...IDENTITY, "commit", "-qm", "unicode branch");
	const unicode = successful(await f.request("git.compare", { base: "refs/heads/ünïcode", head: "refs/heads/ünïcode" }));
	assert.deepEqual(Array.from(unicode.files), []);
});

test("a missing ref and a ref that does not name a commit have their own stable answers", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	assert.equal(await code(f, { base: "refs/heads/nope", head: "refs/heads/master" }), "GIT_REF_NOT_FOUND");
	const blob = f.git("rev-parse", "HEAD:a.txt").trim();
	const tree = f.git("rev-parse", "HEAD^{tree}").trim();
	f.git("tag", "blobtag", blob);
	f.git("tag", "treetag", tree);
	assert.equal(await code(f, { base: "refs/tags/blobtag", head: "refs/heads/master" }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, { base: "refs/heads/master", head: "refs/tags/treetag" }), "GIT_RESULT_INVALID");
});

test("option-like and malformed refs are refused before any Git work", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const commit = f.git("rev-parse", "HEAD").trim();
	const long = "refs/heads/" + "x".repeat(1100);
	const cases = [
		["refs/heads/-x", "refs/heads/master"],
		["refs/heads/-x", "refs/heads/-x"],
		["-refs/heads/master", "refs/heads/master"],
		["HEAD", "refs/heads/master"],
		["refs/heads/master", "HEAD"],
		[commit, "refs/heads/master"],
		["refs/remotes/origin/main", "refs/heads/master"],
		["refs/heads/master", "refs/tags/v1.0{}"],
		["refs/heads/@", "refs/heads/master"],
		["refs/heads/a b", "refs/heads/master"],
		["refs/heads/x..y", "refs/heads/master"],
		["refs/heads/x.lock", "refs/heads/master"],
		["refs/heads/.hidden", "refs/heads/master"],
		["refs/heads/master/", "refs/heads/master"],
		["refs/heads//master", "refs/heads/master"],
		["refs/heads/", "refs/heads/master"],
		[long, "refs/heads/master"],
		["refs/heads/master\u0000x", "refs/heads/master"],
	];
	for (const [base, head] of cases) assert.equal(await code(f, { base, head }), "GIT_RESULT_INVALID", base.slice(0, 40));
	// Missing, extra and wrongly typed fields are protocol refusals, not guessed defaults.
	assert.equal(await code(f, { head: "refs/heads/master" }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, { base: "refs/heads/master" }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, { base: "refs/heads/master", head: "refs/tags/v1.0", extra: 1 }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, { base: 1, head: "refs/heads/master" }), "GIT_RESULT_INVALID");
	const before = readOnlyWitness(f);
	assert.equal(successful(await f.request("git.compare", { base: "refs/heads/master", head: "refs/tags/v1.0" })).files.length, 0, "a refused request must not poison the next one");
	assertReadOnly(f, before);
});

test("the file cap is inclusive at 4096 and a bigger answer is refused whole", LONG_TIMEOUT, async (t) => {
	const f = fixture(t);
	f.git("config", "user.name", "Fixture");
	f.git("config", "user.email", "fixture@example.invalid");
	writeFileSync(join(f.root, "seed.txt"), "seed\n");
	f.git("add", "-A");
	f.git("commit", "-qm", "seed");
	f.git("tag", "seed");
	// Exactly at the bound: 4096 records must be answered, not truncated and not refused.
	for (let index = 0; index < 4096; index += 1) writeFileSync(join(f.root, "f" + String(index).padStart(4, "0") + ".txt"), "x\n");
	f.git("add", "-A");
	f.git("commit", "-qm", "at bound");
	f.git("tag", "at-bound");
	const atBound = successful(await f.request("git.compare", { base: "refs/tags/seed", head: "refs/tags/at-bound" }, 20_000));
	assert.equal(atBound.files.length, 4096);
	assert.ok(atBound.files.every((file) => file.status === "A"));
	// One record past the bound is refused as a whole: a truncated list would look complete.
	writeFileSync(join(f.root, "over.txt"), "over\n");
	f.git("add", "-A");
	f.git("commit", "-qm", "over bound");
	f.git("tag", "over-bound");
	assert.equal(await code(f, { base: "refs/tags/seed", head: "refs/tags/over-bound" }), "RESULT_TOO_LARGE");
});

test("a raw answer over 1 MiB is refused instead of truncated", LONG_TIMEOUT, async (t) => {
	const f = fixture(t);
	f.git("config", "user.name", "Fixture");
	f.git("config", "user.email", "fixture@example.invalid");
	writeFileSync(join(f.root, "seed.txt"), "seed\n");
	f.git("add", "-A");
	f.git("commit", "-qm", "seed");
	f.git("tag", "seed");
	// 4200 records of 255 byte names: about 1.05 MiB of raw -z output, above the byte budget.
	for (let index = 0; index < 4200; index += 1) writeFileSync(join(f.root, String(index).padStart(4, "0") + "-" + "x".repeat(250)), "x\n");
	f.git("add", "-A");
	f.git("commit", "-qm", "long names");
	f.git("tag", "long-names");
	const frame = await f.request("git.compare", { base: "refs/tags/seed", head: "refs/tags/long-names" }, 20_000);
	assert.equal(frame.ok, false);
	assert.equal(frame.error?.code, "RESULT_TOO_LARGE");
});
