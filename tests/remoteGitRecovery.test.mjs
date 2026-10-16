import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";

/*
 * G4b recovery store: the snapshots a discard leaves behind can be listed, restored and dropped. Every case here
 * drives the real helper and checks the repository with native Git, because "you can get it back" is a promise
 * that has to hold byte for byte.
 */

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
function baseline(f) {
	writeFileSync(join(f.root, "a.txt"), "base\n");
	mkdirSync(join(f.root, "sub", "dir"), { recursive: true });
	writeFileSync(join(f.root, "sub", "dir", "nested.txt"), "nested base\n");
	f.git("add", "--", ".");
	f.git(...IDENTITY, "commit", "-qm", "baseline");
}
async function code(f, method, params) {
	const frame = await f.request(method, params);
	assert.equal(frame.ok, false, `expected ${method} to refuse, got ${JSON.stringify(frame.result)}`);
	return frame.error?.code;
}
async function revision(f) {
	const status = successful(await f.request("git.status"));
	assert.ok(status.revision);
	return status.revision;
}
/** Discard one file through the product, so the snapshot under test is the one the product really writes. */
async function discard(f, path, group) {
	const result = successful(await f.request("git.discard", { path, group, expectedRevision: await revision(f) }));
	assert.equal(result.applied, true);
	return result;
}
function assertNoLeftovers(f) {
	assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
	assert.deepEqual(
		readdirSync(join(f.root, ".git")).filter((name) => name.startsWith("pideck-index-")),
		[],
	);
}
const refNames = (f) => f.git("for-each-ref", "--format=%(refname)", "refs/pideck").trim().split("\n").filter(Boolean);

test("a discard shows up in the recovery list with its path, size and time", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "my uncommitted work\n");
	const snap = await discard(f, "a.txt", "workingTree");
	const list = successful(await f.request("git.recoveryList"));
	assert.equal(list.truncated, false);
	assert.equal(list.entries.length, 1);
	const entry = list.entries[0];
	assert.equal(entry.ref, snap.recoveryRef);
	assert.equal(entry.path, "a.txt");
	assert.equal(entry.bytes, "my uncommitted work\n".length);
	assert.ok(Number.isSafeInteger(entry.at) && entry.at > 1600000000, `a plausible commit time, got ${entry.at}`);
	assert.equal(entry.oid, f.git("rev-parse", String(snap.recoveryRef)).trim());
	// Listing is read-only: the repository and the working tree are exactly as they were.
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "base\n");
	assert.equal(f.git("status", "--porcelain=v1").trim(), "");
	assertNoLeftovers(f);
});

test("restoring puts the discarded bytes back and leaves nothing else changed", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "sub", "dir", "nested.txt"), "my nested work\r\nsecond\r\n");
	const snap = await discard(f, "sub/dir/nested.txt", "workingTree");
	assert.equal(readFileSync(join(f.root, "sub", "dir", "nested.txt"), "utf8"), "nested base\n");
	const entry = successful(await f.request("git.recoveryList")).entries[0];
	const restored = successful(await f.request("git.recoveryRestore", { ref: entry.ref, oid: entry.oid, path: entry.path, expectedRevision: await revision(f) }));
	assert.equal(restored.applied, true);
	assert.equal(restored.path, "sub/dir/nested.txt");
	assert.equal(restored.bytes, "my nested work\r\nsecond\r\n".length);
	// Byte for byte, CRLF included, and Git now sees the file as modified again - which is the point.
	assert.equal(readFileSync(join(f.root, "sub", "dir", "nested.txt"), "utf8"), "my nested work\r\nsecond\r\n");
	// Not trimmed: the leading space is the "worktree only" column and belongs to the assertion.
	assert.equal(f.git("status", "--porcelain=v1"), " M sub/dir/nested.txt\n");
	// The snapshot is still there: restoring reads it, it does not consume it.
	assert.equal(refNames(f).length, 1);
	assert.equal(snap.recoveryRef, entry.ref);
	assertNoLeftovers(f);
});

test("an untracked file comes back from the recovery store, and the parent directory must still exist", async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "note.txt"), "note to keep\n");
	const snap = await discard(f, "note.txt", "untracked");
	assert.equal(existsSync(join(f.root, "note.txt")), false);
	const entry = successful(await f.request("git.recoveryList")).entries[0];
	assert.equal(entry.ref, snap.recoveryRef);
	successful(await f.request("git.recoveryRestore", { ref: entry.ref, oid: entry.oid, path: entry.path, expectedRevision: await revision(f) }));
	assert.equal(readFileSync(join(f.root, "note.txt"), "utf8"), "note to keep\n");
	// A directory that disappeared is not recreated behind the user's back: the restore is refused instead.
	writeFileSync(join(f.root, "sub", "dir", "gone.txt"), "in a directory\n");
	await discard(f, "sub/dir/gone.txt", "untracked");
	const second = successful(await f.request("git.recoveryList")).entries.find((candidate) => candidate.path === "sub/dir/gone.txt");
	// The directory itself goes away, tracked file and all: a restore must not recreate it behind the user's back.
	rmSync(join(f.root, "sub"), { recursive: true });
	assert.equal(existsSync(join(f.root, "sub")), false);
	assert.equal(await code(f, "git.recoveryRestore", { ref: second.ref, oid: second.oid, path: second.path, expectedRevision: await revision(f) }), "GIT_RESTORE_CONFLICT");
	assert.equal(existsSync(join(f.root, "sub")), false, "a refusal creates nothing");
	assertNoLeftovers(f);
});

test("a file the user changed again is never overwritten", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "first discarded text\n");
	await discard(f, "a.txt", "workingTree");
	const entry = successful(await f.request("git.recoveryList")).entries[0];
	// The user edits the file after the discard: that newer work outranks the old snapshot.
	writeFileSync(join(f.root, "a.txt"), "newer work in progress\n");
	assert.equal(await code(f, "git.recoveryRestore", { ref: entry.ref, oid: entry.oid, path: entry.path, expectedRevision: await revision(f) }), "GIT_RESTORE_CONFLICT");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "newer work in progress\n", "the refusal must not touch the file");
	assertNoLeftovers(f);
});

test("a stale or foreign entry is refused, and nothing is written", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "mine\n");
	await discard(f, "a.txt", "workingTree");
	const entry = successful(await f.request("git.recoveryList")).entries[0];
	const expected = await revision(f);
	// A commit id that is not what the ref points at: the caller's list is out of date.
	assert.equal(await code(f, "git.recoveryRestore", { ref: entry.ref, oid: "f".repeat(40), path: entry.path, expectedRevision: expected }), "GIT_RECOVERY_ENTRY_NOT_FOUND");
	assert.equal(await code(f, "git.recoveryDrop", { ref: entry.ref, oid: "f".repeat(40), expectedRevision: expected }), "GIT_RECOVERY_ENTRY_NOT_FOUND");
	// A ref outside the recovery namespace is never an entry, whatever it points at.
	const head = f.git("rev-parse", "HEAD").trim();
	assert.equal(await code(f, "git.recoveryRestore", { ref: "refs/heads/main", oid: head, path: "a.txt", expectedRevision: expected }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, "git.recoveryDrop", { ref: "HEAD", oid: head, expectedRevision: expected }), "GIT_RESULT_INVALID");
	// A path that is not the one inside the snapshot is refused rather than guessed.
	assert.equal(await code(f, "git.recoveryRestore", { ref: entry.ref, oid: entry.oid, path: "other.txt", expectedRevision: expected }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, "git.recoveryRestore", { ref: entry.ref, oid: entry.oid, path: "../escape.txt", expectedRevision: expected }), "PATH_OUTSIDE_ROOT");
	assert.equal(refNames(f).length, 1, "no refusal may create or delete a ref");
	assertNoLeftovers(f);
});

test("dropping a snapshot is a compare-and-swap that only removes the listed commit", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "one\n");
	await discard(f, "a.txt", "workingTree");
	writeFileSync(join(f.root, "a.txt"), "two\n");
	await discard(f, "a.txt", "workingTree");
	const entries = successful(await f.request("git.recoveryList")).entries;
	assert.equal(entries.length, 2);
	// Two discards in the same second tie on the committer date, and a tie has no defined order: identify the
	// entries by the content they hold instead of by position.
	const content = (entry) => f.git("cat-file", "blob", `${entry.ref}:${entry.path}`);
	const oldest = entries.find((entry) => content(entry) === "one\n");
	const newest = entries.find((entry) => content(entry) === "two\n");
	assert.ok(oldest && newest && oldest.ref !== newest.ref, "both snapshots must be listed with their own bytes");
	const dropped = successful(await f.request("git.recoveryDrop", { ref: newest.ref, oid: newest.oid, expectedRevision: await revision(f) }));
	assert.deepEqual(dropped, { applied: true });
	assert.equal(refNames(f).includes(newest.ref), false, "the dropped ref is gone");
	assert.deepEqual(refNames(f), [oldest.ref]);
	// The other snapshot still restores, so dropping one entry did not touch its neighbour.
	successful(await f.request("git.recoveryRestore", { ref: oldest.ref, oid: oldest.oid, path: oldest.path, expectedRevision: await revision(f) }));
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "one\n");
	assertNoLeftovers(f);
});

test("a foreign ref or a tree with several paths in the namespace is not listed as a recovery entry", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "real snapshot\n");
	const snap = await discard(f, "a.txt", "workingTree");
	// Two things a recovery entry is not: a commit that holds more than one path, and a ref that is not a commit.
	const tree = f.git("rev-parse", "HEAD^{tree}").trim();
	const multi = f.git(...IDENTITY, "commit-tree", tree, "-m", "not ours").trim();
	f.git("update-ref", "refs/pideck/recovery/20200101000000-deadbeef", multi);
	f.git("update-ref", "refs/pideck/recovery/20200101000001-cafebabe", f.git("rev-parse", "HEAD:sub/dir/nested.txt").trim());
	const list = successful(await f.request("git.recoveryList"));
	assert.deepEqual(
		Array.from(list.entries, (entry) => entry.ref),
		[snap.recoveryRef],
		"only the entry this product wrote is served",
	);
	// The foreign refs are still there, untouched: listing does not clean up after anyone else.
	assert.equal(refNames(f).length, 3);
	assertNoLeftovers(f);
});

test("the list is bounded and says so instead of pretending to be complete", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "filler source\n");
	// The bound is about the number of refs, and the tree is the single-path tree of a real snapshot: a commit
	// whose tree holds several paths is not a recovery entry and would be skipped rather than counted.
	const bound = 64;
	const snapshot = await discard(f, "a.txt", "workingTree");
	const tree = f.git("rev-parse", `${snapshot.recoveryRef}^{tree}`).trim();
	for (let index = 0; index < bound + 1; index += 1) {
		const commit = f.git(...IDENTITY, "commit-tree", tree, "-m", "discard: a.txt").trim();
		f.git("update-ref", `refs/pideck/recovery/20260101${String(index).padStart(6, "0")}-${index.toString(16).padStart(8, "0")}`, commit);
	}
	const list = successful(await f.request("git.recoveryList"));
	assert.equal(list.truncated, true);
	assert.equal(list.entries.length, bound, "a labelled truncation serves exactly the bound");
	assertNoLeftovers(f);
});

test("stat the recovery store after a drop leaves one file per remaining entry", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "keep\n");
	await discard(f, "a.txt", "workingTree");
	const entry = successful(await f.request("git.recoveryList")).entries[0];
	assert.equal(statSync(join(f.root, ".git")).isDirectory(), true);
	successful(await f.request("git.recoveryDrop", { ref: entry.ref, oid: entry.oid, expectedRevision: await revision(f) }));
	assert.deepEqual(await f.request("git.recoveryList").then((frame) => Array.from(frame.result.entries)), []);
	assert.equal(refNames(f).length, 0);
	assertNoLeftovers(f);
});
