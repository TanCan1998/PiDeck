import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";

/*
 * G3b branch write face: creating one branch is a create-only native compare-and-swap and must never move
 * HEAD; switching runs native git switch against an existing local branch and must refuse a conflicting
 * worktree instead of forcing it. Every claim below is checked with native Git and with bytes on disk, and
 * each refusal has to leave the worktree exactly as the user left it.
 */

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
function baseline(f, content = "base\n") {
	writeFileSync(join(f.root, "a.txt"), content);
	writeFileSync(join(f.root, "only-default.txt"), "default only\n");
	f.git("add", "--", ".");
	f.git(...IDENTITY, "commit", "-qm", "baseline");
}
/** A branch that differs in a tracked file, so a switch has something real to change. */
function featureBranch(f) {
	const head = f.git("rev-parse", "HEAD").trim();
	const branch = f.git("symbolic-ref", "--short", "HEAD").trim();
	f.git(...IDENTITY, "branch", "feature");
	// The extra commit belongs to the feature branch, so the default branch stays where the caller left it.
	f.git("checkout", "-q", "feature");
	writeFileSync(join(f.root, "a.txt"), "feature\n");
	f.git("add", "--", "a.txt");
	f.git(...IDENTITY, "commit", "-qm", "feature work");
	const feature = f.git("rev-parse", "refs/heads/feature").trim();
	f.git("checkout", "-q", branch);
	return { head, branch, feature };
}
async function code(f, method, params) {
	const frame = await f.request(method, params);
	assert.equal(frame.ok, false, `expected ${method} to refuse, got ${JSON.stringify(frame.result)}`);
	return frame.error?.code;
}
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** HEAD, every ref, and the whole worktree: what a branch operation must never touch except the branch it moved. */
function witness(f) {
	return {
		head: f.git("rev-parse", "HEAD"),
		symbolic: f.git("symbolic-ref", "HEAD"),
		refs: f.git("for-each-ref", "--format=%(refname) %(objectname)"),
		index: hash(join(f.root, ".git/index")),
		files: readdirSync(f.root)
			.filter((name) => name !== ".git")
			.sort()
			.map((name) => `${name} ${hash(join(f.root, name))}`)
			.join("\n"),
	};
}
function assertNoLeftovers(f) {
	assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
	assert.deepEqual(
		readdirSync(join(f.root, ".git")).filter((name) => name.startsWith("pideck-index-")),
		[],
	);
}

test("creating a branch moves no HEAD, touches no worktree file and writes exactly one ref", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const head = f.git("rev-parse", "HEAD").trim();
	const before = witness(f);
	const created = successful(await f.request("git.createBranch", { name: "feature/new", expectedHead: head }));
	assert.deepEqual(created, { applied: true, branch: "feature/new" });
	assert.equal(f.git("rev-parse", "refs/heads/feature/new").trim(), head, "the new branch must point at the HEAD the caller confirmed");
	assert.equal(f.git("reflog", "show", "feature/new", "-1", "--format=%gs").trim(), "branch: created feature/new");
	const after = witness(f);
	// Only the ref list may differ; HEAD, the index and every worktree byte stay as they were.
	assert.equal(after.head, before.head);
	assert.equal(after.symbolic, before.symbolic);
	assert.equal(after.index, before.index);
	assert.equal(after.files, before.files);
	const refLines = (value) => value.trim().split("\n").sort();
	assert.deepEqual(refLines(after.refs), refLines(before.refs).concat(`refs/heads/feature/new ${head}`).sort());
	// A tag with the same name is a different ref: it must not block the branch.
	f.git("tag", "--", "taken");
	successful(await f.request("git.createBranch", { name: "taken", expectedHead: head }));
	assert.equal(f.git("rev-parse", "refs/heads/taken").trim(), head);
	assertNoLeftovers(f);
});

test("an existing branch is refused without touching it or HEAD", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const head = f.git("rev-parse", "HEAD").trim();
	f.git("branch", "taken", head);
	const before = witness(f);
	assert.equal(await code(f, "git.createBranch", { name: "taken", expectedHead: head }), "GIT_REF_EXISTS");
	assert.equal(f.git("rev-parse", "refs/heads/taken").trim(), head);
	assert.deepEqual(witness(f), before);
	assertNoLeftovers(f);
});

test("a name Git would reject, or one this protocol rejects itself, never creates a ref", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const head = f.git("rev-parse", "HEAD").trim();
	const refs = f.git("for-each-ref", "--format=%(refname)");
	const names = ["-dash", "a b", "a..b", ".dot", "x.lock", "HEAD", "FETCH_HEAD", "ORIG_HEAD", "a@{b}", "@", "refs/heads/other", "a/b/", "a\\b", "tab\tname", "nul\u0000name", "line\nname", head, "x".repeat(1025)];
	for (const name of names) assert.equal(await code(f, "git.createBranch", { name, expectedHead: head }), "GIT_RESULT_INVALID", JSON.stringify(name));
	assert.equal(f.git("for-each-ref", "--format=%(refname)"), refs, "no refused name may create a ref");
	assertNoLeftovers(f);
});

test("the expected HEAD is re-checked, so a stale read cannot create a branch somewhere else", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "second.txt"), "second\n");
	f.git("add", "--", "second.txt");
	f.git(...IDENTITY, "commit", "-qm", "second");
	const head = f.git("rev-parse", "HEAD").trim();
	const parent = f.git("rev-parse", "HEAD^").trim();
	assert.equal(parent.length, 40);
	// A caller that confirmed the parent (or nothing at all) must not get a branch at the current HEAD.
	assert.equal(await code(f, "git.createBranch", { name: "stale", expectedHead: parent }), "GIT_COMMIT_HEAD_CHANGED");
	assert.equal(await code(f, "git.createBranch", { name: "unborn", expectedHead: null }), "GIT_COMMIT_HEAD_CHANGED");
	assert.equal(f.git("branch", "--list", "stale"), "");
	assert.equal(await code(f, "git.createBranch", { name: "bad", expectedHead: "nope" }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, "git.createBranch", { name: "bad", expectedHead: head, extra: 1 }), "GIT_RESULT_INVALID");
	assertNoLeftovers(f);
});

test("an effective post-checkout hook is a refusal for both branch operations, and the hook never runs", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const { head, branch } = featureBranch(f);
	const marker = join(f.root, "hook-ran.txt");
	// A real switch would execute this hook; PiDeck refuses the repository instead of running Git around it.
	mkdirSync(join(f.root, ".git", "hooks"), { recursive: true });
	writeFileSync(join(f.root, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho post-checkout >> ${marker}\nexit 0\n`, { mode: 0o755 });
	assert.equal(await code(f, "git.createBranch", { name: "blocked", expectedHead: head }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(await code(f, "git.switchBranch", { name: "feature", expectedHead: head }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(existsSync(marker), false, "the post-checkout hook must never execute");
	assert.equal(f.git("symbolic-ref", "--short", "HEAD").trim(), branch);
	assert.equal(f.git("branch", "--list", "blocked"), "");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "base\n");
	assertNoLeftovers(f);
});

test("an effective hooksPath is a refusal for both branch operations", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const { head, branch } = featureBranch(f);
	// A configured hook directory is the same refusal even when the default hooks directory looks innocent.
	f.git("config", "core.hooksPath", "custom-hooks");
	assert.equal(await code(f, "git.createBranch", { name: "blocked", expectedHead: head }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(await code(f, "git.switchBranch", { name: "feature", expectedHead: head }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(f.git("symbolic-ref", "--short", "HEAD").trim(), branch);
	assert.equal(f.git("branch", "--list", "blocked"), "");
	assertNoLeftovers(f);
});

test("switching to an existing branch checks it out for real and leaves the refs alone", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const { head, feature } = featureBranch(f);
	writeFileSync(join(f.root, "user-new.txt"), "user work\n");
	const refs = f.git("for-each-ref", "--format=%(refname) %(objectname)");
	const result = successful(await f.request("git.switchBranch", { name: "feature", expectedHead: head }));
	assert.deepEqual(result, { applied: true, branch: "feature", head: feature });
	assert.equal(f.git("symbolic-ref", "--short", "HEAD").trim(), "feature");
	assert.equal(f.git("rev-parse", "HEAD").trim(), feature);
	// The worktree is the branch's tree, and the untracked file the user had is still there.
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "feature\n");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), f.git("show", "feature:a.txt"));
	assert.equal(readFileSync(join(f.root, "only-default.txt"), "utf8"), "default only\n");
	assert.equal(readFileSync(join(f.root, "user-new.txt"), "utf8"), "user work\n");
	assert.equal(f.git("for-each-ref", "--format=%(refname) %(objectname)"), refs, "switching moves no ref");
	// The next read sees the new branch, which is what the panel refreshes into.
	const refsPayload = successful(await f.request("git.refs"));
	assert.equal(refsPayload.branch, "feature");
	assert.equal(refsPayload.head, feature);
	assertNoLeftovers(f);
});

test("a conflicting worktree change is refused and preserved byte for byte", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const { head, branch } = featureBranch(f);
	writeFileSync(join(f.root, "a.txt"), "my work in progress\n");
	const refs = f.git("for-each-ref", "--format=%(refname) %(objectname)");
	assert.equal(await code(f, "git.switchBranch", { name: "feature", expectedHead: head }), "GIT_SWITCH_CONFLICT");
	assert.equal(f.git("symbolic-ref", "--short", "HEAD").trim(), branch);
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "my work in progress\n", "a refusal must not touch the user's file");
	assert.equal(f.git("for-each-ref", "--format=%(refname) %(objectname)"), refs);
	assertNoLeftovers(f);
});

test("an untracked file the target branch tracks is a refusal, and the file stays", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const { head, branch } = featureBranch(f);
	// The file is tracked by the feature branch and unknown to the branch we are on: switching would overwrite it.
	f.git("checkout", "-q", "feature");
	writeFileSync(join(f.root, "feature-only.txt"), "feature only\n");
	f.git("add", "--", "feature-only.txt");
	f.git(...IDENTITY, "commit", "-qm", "add feature-only");
	f.git("checkout", "-q", branch);
	assert.equal(existsSync(join(f.root, "feature-only.txt")), false, "Git itself moved the tracked file away with the checkout");
	writeFileSync(join(f.root, "feature-only.txt"), "user's own file\n");
	assert.equal(await code(f, "git.switchBranch", { name: "feature", expectedHead: head }), "GIT_SWITCH_CONFLICT");
	assert.equal(readFileSync(join(f.root, "feature-only.txt"), "utf8"), "user's own file\n");
	assert.equal(f.git("symbolic-ref", "--short", "HEAD").trim(), branch);
	assertNoLeftovers(f);
});

test("switching refuses an unknown branch, a stale HEAD and a non-branch name", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const { head, branch } = featureBranch(f);
	assert.equal(await code(f, "git.switchBranch", { name: "nope", expectedHead: head }), "GIT_REF_NOT_FOUND");
	assert.equal(await code(f, "git.switchBranch", { name: "feature", expectedHead: null }), "GIT_COMMIT_HEAD_CHANGED");
	// A caller that confirmed a different commit than the current HEAD must not move the worktree.
	assert.equal(await code(f, "git.switchBranch", { name: "feature", expectedHead: f.git("rev-parse", "refs/heads/feature").trim() }), "GIT_COMMIT_HEAD_CHANGED");
	for (const name of ["HEAD", "@", "refs/heads/feature", "-feature", "feature@{1}"]) assert.equal(await code(f, "git.switchBranch", { name, expectedHead: head }), "GIT_RESULT_INVALID", name);
	assert.equal(await code(f, "git.switchBranch", { name: "feature", expectedHead: head, extra: 1 }), "GIT_RESULT_INVALID");
	assert.equal(f.git("symbolic-ref", "--short", "HEAD").trim(), branch);
	assertNoLeftovers(f);
});

test("switching to the branch that is already current is an explicit no-op", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const head = f.git("rev-parse", "HEAD").trim();
	const branch = f.git("symbolic-ref", "--short", "HEAD").trim();
	const before = witness(f);
	const result = successful(await f.request("git.switchBranch", { name: branch, expectedHead: head }));
	assert.deepEqual(result, { applied: true, branch, head });
	assert.deepEqual(witness(f), before, "a no-op switch changes nothing at all");
	assert.equal(await code(f, "git.createBranch", { name: branch, expectedHead: head }), "GIT_REF_EXISTS");
	assertNoLeftovers(f);
});

test("an unborn repository has no branch to switch to and cannot create one", options, async (t) => {
	const f = fixture(t);
	const created = await f.request("git.createBranch", { name: "first", expectedHead: null });
	assert.equal(created.ok, false);
	assert.equal(created.error.code, "GIT_COMMIT_HEAD_CHANGED");
	assert.equal(await code(f, "git.switchBranch", { name: "first", expectedHead: null }), "GIT_REF_NOT_FOUND");
	assert.equal(f.git("for-each-ref", "--format=%(refname)"), "");
	assertNoLeftovers(f);
});

test("a branch created by the helper is a branch the read batch lists, and nothing else changed", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const head = f.git("rev-parse", "HEAD").trim();
	successful(await f.request("git.createBranch", { name: "topic/one", expectedHead: head }));
	const refs = successful(await f.request("git.refs"));
	const entry = Array.from(refs.refs).find((ref) => ref.fullName === "refs/heads/topic/one");
	assert.ok(entry, "the created branch must appear in the refs list");
	assert.equal(entry.oid, head);
	assert.equal(entry.kind, "branch");
	assert.equal(refs.branch, f.git("symbolic-ref", "--short", "HEAD").trim());
	// Git's own verifier agrees with what the helper reported.
	assert.equal(f.git("check-ref-format", "--branch", "topic/one").trim(), "topic/one");
	assertNoLeftovers(f);
});
