import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";

/*
 * G5d nested repository discovery and read-only repository scope, driven through the deployed helper bytes and native
 * Git. Discovery must mirror the local walker (bounded depth/counts, fixed skip names, no symlink descent), and every
 * repository-scoped read must equal the native answer while a byte witness proves it wrote nothing. Windows is
 * skipped because the frozen worker refuses Git work off Linux.
 */

const GIT_ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NESTED = "packages/nested";

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Recursive identity+content witness of one tree; enough to prove a read wrote nothing at all. */
function witness(directory) {
	const entries = [];
	const walk = (current, prefix) => {
		for (const name of readdirSync(current).sort()) {
			const absolute = join(current, name);
			const stats = lstatSync(absolute, { bigint: true });
			if (stats.isSymbolicLink()) entries.push(prefix + name + ":link");
			else if (stats.isDirectory()) {
				entries.push(prefix + name + "/");
				walk(absolute, prefix + name + "/");
			} else entries.push(prefix + name + ":" + String(stats.ino) + ":" + String(stats.mode) + ":" + String(stats.size) + ":" + sha256(absolute));
		}
	};
	walk(directory, "");
	return entries;
}

/** Native facts a scoped read must not change: index bytes+identity, HEAD/refs, and the working tree bytes. */
function repoWitness(f, repo) {
	const index = join(f.root, repo, ".git", "index");
	const indexStats = existsSync(index) ? lstatSync(index, { bigint: true }) : undefined;
	return {
		index: indexStats === undefined ? "absent" : [sha256(index), String(indexStats.ino), String(indexStats.size), String(indexStats.mtimeNs), String(indexStats.ctimeNs)].join(":"),
		head: f.git("-C", repo, "rev-parse", "HEAD").trim(),
		branch: f.git("-C", repo, "symbolic-ref", "--short", "HEAD").trim(),
		refs: f.git("-C", repo, "for-each-ref", "--format=%(refname) %(objectname)").trim(),
		files: witness(join(f.root, repo)).filter((entry) => !entry.includes(".git")),
	};
}

function decodeStatus(result) {
	return Buffer.from(result.status, "base64").toString("utf8");
}

function refusal(f, method, params, repo) {
	return f
		.request(method, params, 3_000, () => undefined, repo)
		.then((frame) => {
			assert.equal(frame.ok, false, "expected a refusal, got " + JSON.stringify(frame.result));
			return frame.error?.code;
		});
}

function commitAll(f, repo, message) {
	f.git(...["-C", repo, ...GIT_ID, "add", "-A"]);
	f.git("-C", repo, ...GIT_ID, "commit", "-qm", message);
}

function initRepo(f, repo, files) {
	mkdirSync(join(f.root, repo), { recursive: true });
	f.git("-C", repo, "init", "-q");
	for (const [name, content] of Object.entries(files)) writeFileSync(join(f.root, repo, name), content);
	commitAll(f, repo, "baseline");
}

/** Root repository (fixture) plus a nested repository with a working change, a tag and a remote name. */
function multiRepoFixture(t) {
	const f = fixture(t, true);
	writeFileSync(join(f.root, "root.txt"), "ROOT\n");
	commitAll(f, ".", "root base");
	initRepo(f, NESTED, { "tracked.txt": "NESTED BASE\n", "removed.txt": "GONE\n" });
	f.git("-C", NESTED, "tag", "v1.0");
	writeFileSync(join(f.root, NESTED, "tracked.txt"), "NESTED WORKING\r\n");
	commitAll(f, NESTED, "nested second");
	// A committed step that differs from the working bytes: status, workspaceDiff and the read-only witness all see it.
	writeFileSync(join(f.root, NESTED, "tracked.txt"), "NESTED MODIFIED\r\n");
	writeFileSync(join(f.root, NESTED, "fresh.txt"), "FRESH\n");
	f.git("-C", NESTED, "remote", "add", "origin", join(f.directory, "origin.git"));
	initRepo(f, "apps/site", { "site.txt": "SITE\n" });
	return f;
}

test("git.repos finds the root and nested repositories with bounded, link-free walk semantics", options, async (t) => {
	const f = multiRepoFixture(t);
	// Noise the walker must skip: dependencies, hidden directories, a symlinked directory, and depth beyond the cap.
	mkdirSync(join(f.root, "node_modules", "dep", ".git"), { recursive: true });
	mkdirSync(join(f.root, ".hidden-repo", ".git"), { recursive: true });
	mkdirSync(join(f.root, "depth", "one", "two", "three", ".git"), { recursive: true });
	mkdirSync(join(f.root, "depth", "one", "two", "three", "four", ".git"), { recursive: true });
	symlinkSync(join("packages", "nested"), join(f.root, "link-repo"), "dir");
	symlinkSync("apps", join(f.root, "linked-tree"), "dir");
	const before = witness(f.root);
	const result = successful(await f.request("git.repos"));
	assert.equal(result.truncated, false, "a small tree must not claim truncation");
	assert.deepEqual(
		result.repos.map((repo) => repo.path),
		["", "apps/site", "depth/one/two/three", NESTED],
		"root first, then project-relative paths in stable order; skipped and link entries never appear",
	);
	assert.equal(result.repos[0].name, "project", "the root repository is labelled by its directory name");
	assert.equal(result.repos.find((repo) => repo.path === NESTED).name, "nested");
	for (const repo of result.repos) {
		assert.ok(typeof repo.name === "string" && repo.name.length > 0);
		assert.ok(!repo.path.startsWith("/") && !repo.path.includes("\\"));
	}
	// Discovery is a read: the whole tree, .git metadata included, is byte/identity identical afterwards.
	assert.deepEqual(witness(f.root), before, "git.repos must not write anything");
});

test("git.repos works on a root without a repository and reports the nested ones", options, async (t) => {
	const f = fixture(t, false);
	initRepo(f, "nested", { "one.txt": "ONE\n" });
	writeFileSync(join(f.root, "keep.txt"), "KEEP\n");
	const result = successful(await f.request("git.repos"));
	assert.deepEqual(
		result.repos.map((repo) => repo.path),
		["nested"],
	);
	assert.equal(result.truncated, false);
	// The root scope is still honestly "not a repository"; the nested scope serves the nested facts.
	assert.equal(await refusal(f, "git.status", {}, ""), "GIT_NOT_REPOSITORY");
	const status = successful(await f.request("git.status", {}, 3_000, () => undefined, "nested"));
	assert.equal(decodeStatus(status), "");
});

test("git.repos truncates honestly at the repository cap and never silently cuts", options, async (t) => {
	const f = fixture(t, true);
	// The root repository already occupies one slot: 50 more make 51 and must be reported as truncated.
	for (let index = 0; index < 50; index += 1) {
		const name = "many/r" + String(index).padStart(2, "0");
		mkdirSync(join(f.root, name), { recursive: true });
		f.git("-C", name, "init", "-q");
	}
	const result = successful(await f.request("git.repos"));
	assert.equal(result.repos.length, 50, "the repository cap is 50");
	assert.equal(result.truncated, true, "a cap that cut more repositories must say so");
	assert.equal(result.repos[0].path, "");
	assert.ok(!result.repos.some((repo) => repo.path === "many/r49"), "the cap is enforced, not exceeded");
});

test("git.repos truncates honestly at the visited-directory cap", options, async (t) => {
	const f = fixture(t, true);
	// More directories than the walk may visit; the only nested repository sits past the cap and must be reported as
	// possibly missing instead of pretending the list is complete.
	for (let index = 0; index < 520; index += 1) mkdirSync(join(f.root, "bulk", "d" + String(index).padStart(3, "0")), { recursive: true });
	mkdirSync(join(f.root, "bulk", "d519", ".git"));
	const result = successful(await f.request("git.repos"));
	assert.equal(result.truncated, true, "the visited-directory cap must be reported");
	assert.deepEqual(
		result.repos.map((repo) => repo.path),
		[""],
		"one repository was found before the cap stopped the walk",
	);
});

test("repository-scoped reads answer exactly the native facts and write nothing", options, async (t) => {
	const f = multiRepoFixture(t);
	// A snapshot ref planted with native Git before the witness: recoveryList is a read and must not touch it.
	writeFileSync(join(f.root, NESTED, "note.txt"), "RECOVER\n");
	const blob = execFileSync("git", ["-C", join(f.root, NESTED), "hash-object", "-w", "--no-filters", "--", "note.txt"], { encoding: "utf8" }).trim();
	const tree = execFileSync("git", ["-C", join(f.root, NESTED), "mktree"], { input: "100644 blob " + blob + "\tnote.txt\n", encoding: "utf8" }).trim();
	const snapshotCommit = execFileSync("git", ["-C", join(f.root, NESTED), ...GIT_ID, "commit-tree", tree, "-m", "discard: note.txt"], { encoding: "utf8" }).trim();
	execFileSync("git", ["-C", join(f.root, NESTED), "update-ref", "refs/pideck/recovery/20261017120000-abcd1234", snapshotCommit], { encoding: "utf8" });
	rmSync(join(f.root, NESTED, "note.txt"));
	// The native status oracle can refresh and rewrite the index stat cache (the helper runs with optional locks
	// disabled), so every native read that is allowed to touch the index is taken before the witness snapshot.
	const nativeStatus = f.git("-C", NESTED, "status", "--porcelain=v1", "-z", "--untracked-files=all");
	const before = repoWitness(f, NESTED);
	const branch = f.git("-C", NESTED, "symbolic-ref", "--short", "HEAD").trim();
	const head = f.git("-C", NESTED, "rev-parse", "HEAD").trim();
	const baseCommit = f.git("-C", NESTED, "rev-parse", "v1.0^{commit}").trim();

	// status: the machine format equals native Git for the nested repository.
	const status = successful(await f.request("git.status", {}, 3_000, () => undefined, NESTED));
	assert.equal(decodeStatus(status), nativeStatus);
	assert.match(decodeStatus(status), /fresh\.txt/);

	// workspaceDiff: both sides equal the index version and the working bytes.
	const diff = successful(await f.request("git.workspaceDiff", { group: "workingTree", path: "tracked.txt" }, 3_000, () => undefined, NESTED));
	assert.equal(diff.originalContent, f.git("-C", NESTED, "show", ":tracked.txt"));
	assert.equal(diff.modifiedContent, readFileSync(join(f.root, NESTED, "tracked.txt"), "utf8"));

	// log / commitDetail: the commit identifiers and the message are the native ones.
	const page = successful(await f.request("git.log", { maxCount: 10 }, 3_000, () => undefined, NESTED));
	assert.equal(page.commits.length, 2);
	assert.ok(page.commits.every((commit) => HASH.test(commit.oid)));
	assert.equal(page.commits[0].oid, head);
	assert.equal(page.commits[0].subject, f.git("-C", NESTED, "log", "-1", "--format=%s").trim());
	const detail = successful(await f.request("git.commitDetail", { oid: head }, 3_000, () => undefined, NESTED));
	assert.equal(detail.oid, head);
	assert.ok(detail.message.includes("nested second"));
	assert.deepEqual(detail.files.map((file) => file.path).sort(), ["tracked.txt"]);

	// refs: branch and tags come from the nested repository, not the root one.
	const refs = successful(await f.request("git.refs", {}, 3_000, () => undefined, NESTED));
	assert.equal(refs.branch, branch);
	assert.ok(refs.refs.some((ref) => ref.kind === "tag" && ref.name === "v1.0"));

	// compare: the native two-tree diff of the tag and HEAD, with the same resolved OIDs in the answer.
	const comparison = successful(await f.request("git.compare", { base: "refs/tags/v1.0", head: "refs/heads/" + branch }, 3_000, () => undefined, NESTED));
	assert.deepEqual(comparison.base, { ref: "refs/tags/v1.0", oid: baseCommit });
	assert.deepEqual(comparison.head, { ref: "refs/heads/" + branch, oid: head });
	const nativeDiff = f
		.git("-C", NESTED, "diff", "--name-status", "v1.0", "HEAD")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status, path] = line.split("\t");
			return { status, path };
		});
	assert.deepEqual(comparison.files, nativeDiff);

	// refFileDiff: both sides equal the native blobs of the two commits.
	const fileDiff = successful(await f.request("git.refFileDiff", { base: baseCommit, head, path: "tracked.txt" }, 3_000, () => undefined, NESTED));
	assert.equal(fileDiff.originalContent, f.git("-C", NESTED, "show", baseCommit + ":tracked.txt"));
	assert.equal(fileDiff.modifiedContent, f.git("-C", NESTED, "show", head + ":tracked.txt"));

	// syncFacts: names and counts from the nested repository (never a URL).
	const facts = successful(await f.request("git.syncFacts", {}, 3_000, () => undefined, NESTED));
	assert.equal(facts.branch, branch);
	assert.equal(facts.upstream, null);
	assert.deepEqual(facts.remotes, ["origin"]);

	// recoveryList: the snapshot planted above is listed for the nested repository only.
	const recovery = successful(await f.request("git.recoveryList", {}, 3_000, () => undefined, NESTED));
	assert.equal(recovery.truncated, false);
	assert.deepEqual(
		recovery.entries.map((entry) => [entry.ref, entry.oid, entry.path]),
		[["refs/pideck/recovery/20261017120000-abcd1234", snapshotCommit, "note.txt"]],
	);
	const rootRecovery = successful(await f.request("git.recoveryList"));
	assert.deepEqual(rootRecovery.entries, [], "the root repository has no snapshots; the scope did not fall back");

	// Nothing above wrote: index bytes+metadata, HEAD/refs and the worktree are byte/identity identical.
	assert.deepEqual(repoWitness(f, NESTED), before, "every scoped read must leave the nested repository untouched");
});

test("the root scope and a nested scope never answer for each other", options, async (t) => {
	const f = multiRepoFixture(t);
	writeFileSync(join(f.root, "root-extra.txt"), "ROOT EXTRA\n");
	const root = successful(await f.request("git.status"));
	const nested = successful(await f.request("git.status", {}, 3_000, () => undefined, NESTED));
	const rootText = decodeStatus(root);
	assert.ok(rootText.includes("?? root-extra.txt\u0000"), "the root repository sees its own untracked file");
	assert.ok(!rootText.includes("fresh.txt"), "the root scope never answers for a nested repository");
	assert.ok(rootText.includes("?? packages/nested/"), "an untracked embedded repository is a directory entry, not a parse failure");
	const nestedText = decodeStatus(nested);
	assert.ok(nestedText.includes("tracked.txt") && nestedText.includes("fresh.txt"));
	assert.equal(root.head, f.git("rev-parse", "HEAD").trim());
	assert.equal(nested.head, f.git("-C", NESTED, "rev-parse", "HEAD").trim());
	assert.notEqual(root.head, nested.head);
});

test("a repository scope with an unsafe shape is refused before the filesystem", options, async (t) => {
	const f = multiRepoFixture(t);
	for (const repo of ["../outside", "/absolute", "a\\b", "C:/drive", "-option", "nested/.git", "nested/x.lock", "a\u0000b", "a".repeat(4097), "..", "."]) {
		assert.equal(await refusal(f, "git.repos", {}, repo), "GIT_RESULT_INVALID", "git.repos " + JSON.stringify(repo));
		assert.equal(await refusal(f, "git.status", {}, repo), "GIT_RESULT_INVALID", "git.status " + JSON.stringify(repo));
	}
	assert.equal(await refusal(f, "git.status", {}, 7), "GIT_RESULT_INVALID", "a non-string scope is refused");
	// The worker stays usable after every refusal.
	assert.equal(successful(await f.request("git.status")).head, f.git("rev-parse", "HEAD").trim());
});

test("a scope that is missing, not a directory, a link or not a repository is GIT_NOT_REPOSITORY", options, async (t) => {
	const f = multiRepoFixture(t);
	symlinkSync(join("packages", "nested"), join(f.root, "link-repo"), "dir");
	writeFileSync(join(f.root, "plain-file.txt"), "FILE\n");
	for (const repo of ["missing", "packages", "plain-file.txt", "link-repo", "link-repo/deeper"]) {
		assert.equal(await refusal(f, "git.status", {}, repo), "GIT_NOT_REPOSITORY", repo);
	}
	// A symlinked segment is never followed, even when the target would be a real nested repository.
	const linked = successful(await f.request("git.repos"));
	assert.ok(!linked.repos.some((repo) => repo.path.startsWith("link-repo")));
});

test("git.init and git.repos refuse a non-empty repository scope; writes are scoped since G5e", options, async (t) => {
	const f = multiRepoFixture(t);
	// Discovery and the explicit root init are the two methods that never take a scope (G5e keeps them root-only).
	assert.equal(await refusal(f, "git.init", {}, NESTED), "GIT_RESULT_INVALID");
	assert.equal(await refusal(f, "git.repos", {}, NESTED), "GIT_RESULT_INVALID");
	// The same methods keep their root behaviour: init is refused because the root already is a repository.
	assert.equal(await refusal(f, "git.init", {}, ""), "GIT_REPO_EXISTS");
	// The write batch is exercised against a nested repository by tests/remoteGitScopedWrite.test.mjs.
	const revision = successful(await f.request("git.status")).revision;
	assert.equal(await refusal(f, "git.stage", { path: "root.txt", group: "workingTree", expectedRevision: revision }, "missing-repo"), "GIT_NOT_REPOSITORY");
});

test("git.repos takes no parameters and keeps the bounded shapes", options, async (t) => {
	const f = fixture(t, true);
	for (const params of [{ extra: 1 }, { path: "" }, null, [], "repos"]) {
		const frame = await f.request("git.repos", params);
		assert.equal(frame.ok, false, JSON.stringify(params));
		assert.equal(frame.error?.code, "GIT_RESULT_INVALID", JSON.stringify(params));
	}
	const result = successful(await f.request("git.repos"));
	assert.deepEqual(result, { repos: [{ path: "", name: "project" }], truncated: false });
});
