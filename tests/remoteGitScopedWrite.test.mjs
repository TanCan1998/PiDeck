import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";

/*
 * G5e nested repository write face, driven through the deployed helper bytes and native Git. Every write verb must
 * act on the repository the frame named and on nothing else: the sibling repository is witnessed before and after
 * each action (index bytes+identity, HEAD, refs, status and worktree bytes). Windows is skipped because the frozen
 * worker refuses Git work off Linux.
 */

const NESTED = "packages/nested";
const GIT_ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Recursive identity+content witness of one directory, .git included. */
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

/** Native facts of one repository; a scoped write must change only the repository the frame named. */
function repoWitness(f, repo) {
	const index = join(f.root, repo, ".git", "index");
	const stats = existsSync(index) ? lstatSync(index, { bigint: true }) : undefined;
	const at = (args) => f.git(...(repo === "" ? args : ["-C", repo, ...args]));
	return {
		// Content identity only: our own native `git status` oracle may refresh the index stat cache (same bytes, new inode),
		// so the invariant a scoped write must respect is that the other repository's index bytes never change.
		index: stats === undefined ? "absent" : [sha256(index), String(stats.size)].join(":"),
		head: at(["rev-parse", "HEAD"]).trim(),
		branch: at(["symbolic-ref", "--short", "HEAD"]).trim(),
		refs: at(["for-each-ref", "--format=%(refname) %(objectname)"]).trim(),
		status: at(["status", "--porcelain=v1", "--untracked-files=all"]),
		worktree: witness(join(f.root, repo)).filter((entry) => !entry.startsWith(".git/") && (repo !== "" || !entry.startsWith(NESTED + "/"))),
	};
}

function refusal(f, method, params, repo) {
	return f
		.request(method, params, 3_000, () => undefined, repo)
		.then((frame) => {
			assert.equal(frame.ok, false, "expected a refusal, got " + JSON.stringify(frame.result));
			return frame.error?.code;
		});
}

function scoped(f, method, params, repo) {
	return f.request(method, params, 3_000, () => undefined, repo);
}

async function nestedStatusRevision(f) {
	return successful(await f.request("git.status", {}, 3_000, () => undefined, NESTED)).revision;
}

async function rootStatusRevision(f) {
	return successful(await f.request("git.status")).revision;
}

function commitIn(f, repo, message) {
	f.git(...["-C", repo, ...GIT_ID, "add", "-A"]);
	f.git("-C", repo, ...GIT_ID, "commit", "-qm", message);
}

/** Root repository with its own commit/staged/working state plus a nested repository under packages/nested. */
function scopedFixture(t) {
	const f = fixture(t, true);
	writeFileSync(join(f.root, "root.txt"), "ROOT BASE\n");
	writeFileSync(join(f.root, "root-staged.txt"), "ROOT STAGED\n");
	f.git("config", "user.name", "Fixture");
	f.git("config", "user.email", "fixture@example.invalid");
	commitIn(f, ".", "root baseline");
	writeFileSync(join(f.root, "root-staged.txt"), "ROOT STAGED NEXT\n");
	f.git("add", "--", "root-staged.txt");
	writeFileSync(join(f.root, "root-working.txt"), "ROOT WORKING\n");
	mkdirSync(join(f.root, NESTED), { recursive: true });
	f.git("-C", NESTED, "init", "-q");
	f.git("-C", NESTED, "config", "user.name", "Fixture");
	f.git("-C", NESTED, "config", "user.email", "fixture@example.invalid");
	writeFileSync(join(f.root, NESTED, "nested.txt"), "NESTED BASE\n");
	writeFileSync(join(f.root, NESTED, "other.txt"), "OTHER BASE\n");
	commitIn(f, NESTED, "nested baseline");
	return f;
}

test("nested stage/unstage writes only the nested index and leaves the root repository untouched", options, async (t) => {
	const f = scopedFixture(t);
	writeFileSync(join(f.root, NESTED, "nested.txt"), "NESTED EDITED\r\n");
	const rootBefore = repoWitness(f, "");
	const nestedBefore = repoWitness(f, NESTED);
	const revision = await nestedStatusRevision(f);
	successful(await scoped(f, "git.stage", { path: "nested.txt", group: "workingTree", expectedRevision: revision }, NESTED));
	assert.equal(f.git("-C", NESTED, "show", ":nested.txt"), "NESTED EDITED\r\n", "the nested index holds the staged bytes");
	assert.deepEqual(repoWitness(f, ""), rootBefore, "staging a nested path must not touch the root repository");
	// Unstage needs the revision the staged status confirms, exactly like the root scope.
	successful(await scoped(f, "git.unstage", { path: "nested.txt", group: "index", expectedRevision: await nestedStatusRevision(f) }, NESTED));
	assert.equal(f.git("-C", NESTED, "show", ":nested.txt"), "NESTED BASE\n");
	assert.equal(readFileSync(join(f.root, NESTED, "nested.txt"), "utf8"), "NESTED EDITED\r\n", "unstage keeps the worktree bytes");
	assert.deepEqual(repoWitness(f, ""), rootBefore, "unstaging a nested path must not touch the root repository");
	assert.notDeepEqual(repoWitness(f, NESTED), nestedBefore, "the nested repository is the one that changed");
});

test("nested commit moves only the nested HEAD with the nested index and message", options, async (t) => {
	const f = scopedFixture(t);
	writeFileSync(join(f.root, NESTED, "nested.txt"), "NESTED COMMIT\n");
	f.git("-C", NESTED, "add", "--", "nested.txt");
	const nestedHead = f.git("-C", NESTED, "rev-parse", "HEAD").trim();
	const rootBefore = repoWitness(f, "");
	const result = successful(await scoped(f, "git.commit", { message: "nested scoped commit\n\n# kept verbatim", expectedRevision: await nestedStatusRevision(f) }, NESTED));
	assert.equal(result.applied, true);
	assert.equal(result.head, f.git("-C", NESTED, "rev-parse", "HEAD").trim(), "the answer names the moved nested HEAD");
	assert.equal(f.git("-C", NESTED, "rev-parse", "HEAD^").trim(), nestedHead, "the new commit is a child of the confirmed nested HEAD");
	assert.equal(f.git("-C", NESTED, "show", "HEAD:nested.txt"), "NESTED COMMIT\n");
	assert.match(f.git("-C", NESTED, "show", "-s", "--format=%B", "HEAD"), /nested scoped commit\n\n# kept verbatim/);
	assert.deepEqual(repoWitness(f, ""), rootBefore, "a nested commit must not move the root HEAD, index or refs");
});

test("nested create/switch branch touch only the nested refs and worktree", options, async (t) => {
	const f = scopedFixture(t);
	const nestedHead = f.git("-C", NESTED, "rev-parse", "HEAD").trim();
	const nestedBranch = f.git("-C", NESTED, "symbolic-ref", "--short", "HEAD").trim();
	const rootBefore = repoWitness(f, "");
	successful(await scoped(f, "git.createBranch", { name: "nested-work", expectedHead: nestedHead }, NESTED));
	assert.equal(f.git("-C", NESTED, "rev-parse", "refs/heads/nested-work").trim(), nestedHead, "the branch exists in the nested repository");
	assert.equal(f.git("-C", NESTED, "symbolic-ref", "--short", "HEAD").trim(), nestedBranch, "creating a branch never moves nested HEAD");
	successful(await scoped(f, "git.switchBranch", { name: "nested-work", expectedHead: nestedHead }, NESTED));
	assert.equal(f.git("-C", NESTED, "symbolic-ref", "--short", "HEAD").trim(), "nested-work", "the nested HEAD switched");
	assert.deepEqual(repoWitness(f, ""), rootBefore, "branch writes in a nested repository must not touch the root repository");
});

test("nested discard snapshots into the nested repository and rewrites only that worktree file", options, async (t) => {
	const f = scopedFixture(t);
	writeFileSync(join(f.root, NESTED, "other.txt"), "OTHER DISCARDED\r\n");
	const rootBefore = repoWitness(f, "");
	const result = successful(await scoped(f, "git.discard", { path: "other.txt", group: "workingTree", expectedRevision: await nestedStatusRevision(f) }, NESTED));
	assert.match(result.recoveryRef, /^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/);
	assert.equal(readFileSync(join(f.root, NESTED, "other.txt"), "utf8"), "OTHER BASE\n", "discard restored the nested index version");
	assert.equal(f.git("-C", NESTED, "show", result.recoveryRef + ":other.txt"), "OTHER DISCARDED\r\n", "the snapshot holds the discarded nested bytes");
	assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/pideck/recovery").trim(), "", "the root repository got no recovery ref");
	assert.deepEqual(repoWitness(f, ""), rootBefore, "a nested discard must not touch the root repository");
});

test("nested recovery restore/drop use the nested recovery refs, not the root ones", options, async (t) => {
	const f = scopedFixture(t);
	const writable = (repo, args) => execFileSync("git", ["-C", join(f.root, repo), ...GIT_ID, ...args], { encoding: "utf8" }).trim();
	// The same ref name exists in both repositories: the scope decides which one restore/drop can see.
	const makeSnapshot = (repo, name, content) => {
		writeFileSync(join(f.root, repo, name), content);
		const blob = writable(repo, ["hash-object", "-w", "--no-filters", "--", name]);
		const tree = execFileSync("git", ["-C", join(f.root, repo), "mktree"], { input: "100644 blob " + blob + "\t" + name + "\n", encoding: "utf8" }).trim();
		const commit = writable(repo, ["commit-tree", tree, "-m", "discard: " + name]);
		writable(repo, ["update-ref", "refs/pideck/recovery/20261017120000-abcd1234", commit]);
		unlinkSync(join(f.root, repo, name));
		return { ref: "refs/pideck/recovery/20261017120000-abcd1234", oid: commit, path: name };
	};
	const nestedEntry = makeSnapshot(NESTED, "nested-note.txt", "NESTED RECOVERY\n");
	const rootEntry = makeSnapshot(".", "root-note.txt", "ROOT RECOVERY\n");
	const rootBefore = repoWitness(f, "");
	const restored = successful(await scoped(f, "git.recoveryRestore", { ref: nestedEntry.ref, oid: nestedEntry.oid, path: nestedEntry.path, expectedRevision: await nestedStatusRevision(f) }, NESTED));
	assert.equal(restored.path, "nested-note.txt");
	assert.equal(readFileSync(join(f.root, NESTED, "nested-note.txt"), "utf8"), "NESTED RECOVERY\n");
	assert.equal(existsSync(join(f.root, "root-note.txt")), false, "restoring the nested snapshot never writes the root path");
	assert.deepEqual(repoWitness(f, ""), rootBefore, "a nested restore must not touch the root repository");
	const listed = successful(await scoped(f, "git.recoveryList", {}, NESTED));
	assert.deepEqual(
		listed.entries.map((entry) => entry.path),
		["nested-note.txt"],
		"the nested listing sees the nested snapshot",
	);
	successful(await scoped(f, "git.recoveryDrop", { ref: nestedEntry.ref, oid: nestedEntry.oid, expectedRevision: await nestedStatusRevision(f) }, NESTED));
	assert.equal(f.git("-C", NESTED, "for-each-ref", "--format=%(refname)", "refs/pideck/recovery").trim(), "", "the nested snapshot is gone");
	assert.equal(f.git("rev-parse", rootEntry.ref).trim(), rootEntry.oid, "the root snapshot with the same ref name is untouched");
	assert.deepEqual(repoWitness(f, ""), rootBefore, "dropping a nested snapshot must not touch the root repository");
});

/** A nested fixture with its own bare remote and a second clone that plays the remote teammate. */
function syncFixture(t) {
	const f = scopedFixture(t);
	const bare = join(f.directory, "nested-origin.git");
	f.git("init", "--bare", "-q", bare);
	f.git("-C", NESTED, "remote", "add", "origin", bare);
	return { f, bare };
}

function bareRef(f, bare, ref) {
	return f.git("--git-dir", bare, "rev-parse", "--verify", "--quiet", ref).trim();
}

test("nested fetch updates only the nested remote-tracking refs", options, async (t) => {
	const { f, bare } = syncFixture(t);
	const branch = f.git("-C", NESTED, "symbolic-ref", "--short", "HEAD").trim();
	const nestedHead = f.git("-C", NESTED, "rev-parse", "HEAD").trim();
	const rootBefore = repoWitness(f, "");
	// A teammate pushes one commit through a second clone: the nested repository has not seen it yet.
	const second = join(f.directory, "teammate");
	f.git("clone", "-q", bare, second);
	f.git("-C", second, "checkout", "-q", "-B", branch);
	writeFileSync(join(second, "remote.txt"), "REMOTE COMMIT\n");
	commitIn(f, second, "teammate commit");
	f.git("-C", second, "push", "-q", "origin", branch).length;
	const remoteHead = f.git("-C", second, "rev-parse", "HEAD").trim();
	assert.match(remoteHead, HASH);
	successful(await scoped(f, "git.fetch", { remote: "origin", expectedRevision: await nestedStatusRevision(f) }, NESTED));
	assert.equal(f.git("-C", NESTED, "rev-parse", "refs/remotes/origin/" + branch).trim(), remoteHead, "fetch moved the nested remote-tracking ref");
	assert.equal(f.git("-C", NESTED, "rev-parse", "HEAD").trim(), nestedHead, "fetch never moves nested HEAD");
	assert.deepEqual(repoWitness(f, ""), rootBefore, "a nested fetch must not touch the root repository");
	assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/remotes").trim(), "", "the root repository has no remote-tracking refs");
});

test("nested push publishes only the nested branch to the nested remote", options, async (t) => {
	const { f, bare } = syncFixture(t);
	const branch = f.git("-C", NESTED, "symbolic-ref", "--short", "HEAD").trim();
	const rootBefore = repoWitness(f, "");
	writeFileSync(join(f.root, NESTED, "pushed.txt"), "PUSHED FROM NESTED\n");
	commitIn(f, NESTED, "nested push commit");
	const nestedHead = f.git("-C", NESTED, "rev-parse", "HEAD").trim();
	const result = successful(await scoped(f, "git.push", { remote: "origin", branch, expectedRevision: await nestedStatusRevision(f) }, NESTED));
	assert.deepEqual(result, { applied: true, outcome: "new", refspec: "refs/heads/" + branch + ":refs/heads/" + branch });
	assert.equal(bareRef(f, bare, "refs/heads/" + branch), nestedHead, "the bare remote received exactly the nested HEAD");
	assert.deepEqual(repoWitness(f, ""), rootBefore, "a nested push must not touch the root repository");
});

test("nested pull fast-forwards only the nested branch from its own upstream", options, async (t) => {
	const { f, bare } = syncFixture(t);
	const branch = f.git("-C", NESTED, "symbolic-ref", "--short", "HEAD").trim();
	// Publish the nested baseline, give it an upstream, then let a teammate advance the remote.
	successful(await scoped(f, "git.push", { remote: "origin", branch, expectedRevision: await nestedStatusRevision(f) }, NESTED));
	successful(await scoped(f, "git.fetch", { remote: "origin", expectedRevision: await nestedStatusRevision(f) }, NESTED));
	f.git("-C", NESTED, "branch", "--set-upstream-to=origin/" + branch);
	const second = join(f.directory, "teammate");
	f.git("clone", "-q", "-b", branch, bare, second);
	writeFileSync(join(second, "pull.txt"), "PULLED\n");
	commitIn(f, second, "teammate pull commit");
	f.git("-C", second, "push", "-q", "origin", "HEAD:" + branch);
	const remoteHead = f.git("-C", second, "rev-parse", "HEAD").trim();
	const rootBefore = repoWitness(f, "");
	const result = successful(await scoped(f, "git.pull", { remote: "origin", branch, expectedRevision: await nestedStatusRevision(f) }, NESTED));
	assert.equal(result.mode, "fast-forward");
	assert.equal(result.head, remoteHead);
	assert.equal(f.git("-C", NESTED, "rev-parse", "HEAD").trim(), remoteHead, "the nested HEAD fast-forwarded to the remote commit");
	assert.equal(readFileSync(join(f.root, NESTED, "pull.txt"), "utf8"), "PULLED\n");
	assert.deepEqual(repoWitness(f, ""), rootBefore, "a nested pull must not touch the root repository");
});

test("a write verb refuses a scope that is missing, a link or not a repository, before any Git child", options, async (t) => {
	const f = scopedFixture(t);
	const revision = await nestedStatusRevision(f);
	const rootRevision = await rootStatusRevision(f);
	symlinkSync(join("packages", "nested"), join(f.root, "link-repo"), "dir");
	const rootBefore = repoWitness(f, "");
	const nestedBefore = repoWitness(f, NESTED);
	// Unsafe shapes are refused by the shared repo rule before the anchor walks anything.
	for (const repo of ["../outside", "/absolute", "packages/nested/.git", "x.lock/y"]) {
		assert.equal(await refusal(f, "git.stage", { path: "nested.txt", group: "workingTree", expectedRevision: revision }, repo), "GIT_RESULT_INVALID", repo);
	}
	// A legal shape that is not a repository is GIT_NOT_REPOSITORY and starts no Git child.
	for (const repo of ["missing", "packages", "link-repo"]) {
		assert.equal(await refusal(f, "git.commit", { message: "m", expectedRevision: revision }, repo), "GIT_NOT_REPOSITORY", repo);
	}
	// A revision confirmed for one repository never authorizes another: the nested index is untouched.
	assert.equal(await refusal(f, "git.stage", { path: "nested.txt", group: "workingTree", expectedRevision: rootRevision }, NESTED), "GIT_RESOURCE_CHANGED");
	assert.deepEqual(repoWitness(f, NESTED), nestedBefore, "a refused scoped write publishes nothing");
	assert.deepEqual(repoWitness(f, ""), rootBefore);
});

test("git.init and git.repos stay root-only and still refuse a non-empty scope", options, async (t) => {
	const f = scopedFixture(t);
	assert.equal(await refusal(f, "git.init", {}, NESTED), "GIT_RESULT_INVALID");
	assert.equal(await refusal(f, "git.repos", {}, NESTED), "GIT_RESULT_INVALID");
	// Root behaviour is unchanged: init on an existing root repository is the honest GIT_REPO_EXISTS.
	assert.equal(await refusal(f, "git.init", {}, ""), "GIT_REPO_EXISTS");
});
