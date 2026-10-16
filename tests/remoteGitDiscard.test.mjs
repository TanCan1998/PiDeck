import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";

/*
 * G4a recoverable discard: throwing away a working-tree change or an untracked file is only allowed once the
 * exact bytes are in the repository's own object store behind a recovery ref. Every case below checks the
 * snapshot with native Git, checks what happened to the file, and checks that a refusal changed nothing.
 */

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
function baseline(f) {
	writeFileSync(join(f.root, "a.txt"), "base\n");
	writeFileSync(join(f.root, "other.txt"), "untouched\n");
	mkdirSync(join(f.root, "sub", "dir"), { recursive: true });
	writeFileSync(join(f.root, "sub", "dir", "nested.txt"), "nested base\n");
	f.git("add", "--", ".");
	f.git(...IDENTITY, "commit", "-qm", "baseline");
}
async function code(f, params) {
	const frame = await f.request("git.discard", params);
	assert.equal(frame.ok, false, `expected git.discard to refuse, got ${JSON.stringify(frame.result)}`);
	return frame.error?.code;
}
/** The fingerprint the panel would have confirmed; the same computation the read path publishes. */
async function revision(f) {
	const status = successful(await f.request("git.status"));
	assert.ok(status.revision);
	return status.revision;
}
const recoveryRefs = (f) => f.git("for-each-ref", "--format=%(refname)", "refs/pideck").trim();
function assertNoLeftovers(f) {
	assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
	assert.deepEqual(
		readdirSync(join(f.root, ".git")).filter((name) => name.startsWith("pideck-index-")),
		[],
	);
}

test("discarding a modified tracked file snapshots the raw bytes first and restores the staged version", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	f.git("add", "--", "other.txt");
	writeFileSync(join(f.root, "other.txt"), "staged version\n");
	const branch = f.git("symbolic-ref", "--short", "HEAD").trim();
	const refsBefore = f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags");
	// A staged version that differs from HEAD: discard restores the worktree to the index, not to HEAD.
	writeFileSync(join(f.root, "other.txt"), "staged version\n");
	f.git("add", "--", "other.txt");
	const stagedBefore = f.git("ls-files", "--stage", "--", "other.txt");
	writeFileSync(join(f.root, "other.txt"), "my work in progress\n");
	const expected = await revision(f);
	const result = successful(await f.request("git.discard", { path: "other.txt", group: "workingTree", expectedRevision: expected }));
	assert.equal(result.applied, true);
	assert.equal(result.mode, "restored");
	assert.ok(result.recoveryRef.startsWith("refs/pideck/recovery/"), result.recoveryRef);
	assert.equal(readFileSync(join(f.root, "other.txt"), "utf8"), "staged version\n", "the worktree becomes the staged version");
	// The snapshot is the byte-exact thing that was thrown away, and it is reachable through the returned ref.
	assert.equal(f.git("show", result.recoveryRef + ":other.txt"), "my work in progress\n");
	assert.equal(f.git("reflog", "show", result.recoveryRef, "--format=%gs", "-1").trim(), "discard: other.txt");
	// The staged content is untouched, other files are untouched, and HEAD/refs did not move.
	assert.equal(f.git("ls-files", "--stage", "--", "other.txt"), stagedBefore);
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "base\n");
	assert.equal(f.git("symbolic-ref", "--short", "HEAD").trim(), branch);
	assert.equal(f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"), refsBefore, "a discard moves no branch or tag");
	// The recovery commit is PiDeck's own journal entry, not a user commit.
	assert.equal(f.git("log", "-1", "--format=%an <%ae>", result.recoveryRef).trim(), "PiDeck recovery <pideck-recovery@localhost>");
	assertNoLeftovers(f);
});

test("a deleted-in-worktree file needs no snapshot and is restored from the index", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	// Only the file on disk goes away: the index still holds it, which is what makes this recoverable by restore.
	rmSync(join(f.root, "a.txt"));
	const expected = await revision(f);
	const result = successful(await f.request("git.discard", { path: "a.txt", group: "workingTree", expectedRevision: expected }));
	assert.equal(result.applied, true);
	assert.equal(result.mode, "restored");
	assert.equal(result.recoveryRef, null, "the discarded change was the deletion itself: there are no bytes to preserve");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "base\n");
	assert.equal(recoveryRefs(f), "", "no snapshot is created when nothing can be lost");
	assertNoLeftovers(f);
});

test("deleting an untracked file snapshots it first, so the user can always get it back", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "scratch notes ü.txt"), "private thoughts\r\nsecond\r\n");
	const expected = await revision(f);
	const result = successful(await f.request("git.discard", { path: "scratch notes ü.txt", group: "untracked", expectedRevision: expected }));
	assert.equal(result.applied, true);
	assert.equal(result.mode, "removed");
	assert.equal(existsSync(join(f.root, "scratch notes ü.txt")), false);
	// Byte-exact, including CRLF and a space plus non-ASCII in the path.
	assert.equal(f.git("show", result.recoveryRef + ":scratch notes ü.txt"), "private thoughts\r\nsecond\r\n");
	assert.equal(f.git("status", "--porcelain=v1", "--untracked-files=all").includes("scratch"), false);
	assertNoLeftovers(f);
});

test("the snapshot stores raw bytes even for a path an attribute would convert", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	// "text" makes git add strip CR; the snapshot must still be the bytes the user actually had.
	writeFileSync(join(f.root, ".gitattributes"), "*.txt text\n");
	f.git("add", "--", ".gitattributes");
	f.git(...IDENTITY, "commit", "-qm", "attributes");
	writeFileSync(join(f.root, "a.txt"), "line one\r\nline two\r\n");
	const raw = f.git("hash-object", "-w", "--no-filters", "--", "a.txt").trim();
	// The contrast is the conversion git itself applies for this path; it is the reason --no-filters matters.
	f.git("add", "--", "a.txt");
	const filtered = f.git("rev-parse", ":a.txt").trim();
	assert.notEqual(raw, filtered, "the fixture really does convert this path, so the snapshot proves it bypasses that");
	f.git("reset", "-q", "--", "a.txt");
	writeFileSync(join(f.root, "a.txt"), "line one\r\nline two\r\n");
	const expected = await revision(f);
	const result = successful(await f.request("git.discard", { path: "a.txt", group: "workingTree", expectedRevision: expected }));
	assert.equal(f.git("rev-parse", result.recoveryRef + ":a.txt").trim(), raw, "the snapshot is the raw bytes, CR and all");
	assert.equal(f.git("show", result.recoveryRef + ":a.txt"), "line one\r\nline two\r\n");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "base\n");
	assertNoLeftovers(f);
});

test("every refusal happens before the snapshot and changes nothing", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "mine\n");
	const expected = await revision(f);
	const headsBefore = f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags");
	// A stale confirmation cannot discard anything.
	assert.equal(await code(f, { path: "a.txt", group: "workingTree", expectedRevision: "f".repeat(64) }), "GIT_RESOURCE_CHANGED");
	// Wrong groups, an unobserved path and malformed parameters are refused by the protocol.
	assert.equal(await code(f, { path: "a.txt", group: "index", expectedRevision: expected }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, { path: "a.txt", group: "merge", expectedRevision: expected }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, { path: "missing.txt", group: "workingTree", expectedRevision: expected }), "GIT_RESOURCE_CHANGED");
	assert.equal(await code(f, { path: "a.txt", group: "untracked", expectedRevision: expected }), "GIT_RESOURCE_CHANGED");
	assert.equal(await code(f, { path: "../escape.txt", group: "workingTree", expectedRevision: expected }), "PATH_OUTSIDE_ROOT");
	assert.equal(await code(f, { path: "a.txt", group: "workingTree", expectedRevision: expected, extra: 1 }), "GIT_RESULT_INVALID");
	assert.equal(recoveryRefs(f), "", "a refusal must not leave a snapshot behind");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "mine\n");
	assert.equal(f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"), headsBefore);
	assertNoLeftovers(f);
});

test("a file too large to snapshot is refused instead of being copied", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	// One byte past the 8 MiB snapshot bound; the panel must say so rather than quietly growing the object store.
	writeFileSync(join(f.root, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
	const expected = await revision(f);
	assert.equal(await code(f, { path: "big.bin", group: "untracked", expectedRevision: expected }), "RESULT_TOO_LARGE");
	assert.equal(existsSync(join(f.root, "big.bin")), true);
	assert.equal(recoveryRefs(f), "");
	assertNoLeftovers(f);
});

test("a worktree typechange to a symlink is refused without a snapshot", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	// The index still says 100644 while the worktree entry is a link: a checkout would replace it, so this is a refusal.
	rmSync(join(f.root, "a.txt"));
	symlinkSync("other.txt", join(f.root, "a.txt"));
	const expected = await revision(f);
	assert.equal(await code(f, { path: "a.txt", group: "workingTree", expectedRevision: expected }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(lstatSync(join(f.root, "a.txt")).isSymbolicLink(), true, "the link is left exactly as the user made it");
	assert.equal(recoveryRefs(f), "");
	assertNoLeftovers(f);
});

test("a repository with a gitlink is refused by the repository gate before any discard", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const expected = await revision(f);
	writeFileSync(join(f.root, "a.txt"), "mine\n");
	f.git("update-index", "--add", "--cacheinfo", "160000," + f.git("rev-parse", "HEAD").trim() + ",mod");
	assert.equal(await code(f, { path: "a.txt", group: "workingTree", expectedRevision: expected }), "GIT_UNSUPPORTED_REPOSITORY");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "mine\n");
	assert.equal(recoveryRefs(f), "");
	assertNoLeftovers(f);
});

test("an effective hook is a refusal for a discard too, and the hook never runs", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "mine\n");
	mkdirSync(join(f.root, ".git", "hooks"), { recursive: true });
	const marker = join(f.root, "hook-ran.txt");
	writeFileSync(join(f.root, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho ran >> ${marker}\nexit 0\n`, { mode: 0o755 });
	const expected = await revision(f);
	assert.equal(await code(f, { path: "a.txt", group: "workingTree", expectedRevision: expected }), "GIT_WRITE_UNSUPPORTED");
	assert.equal(existsSync(marker), false);
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "mine\n");
	assert.equal(recoveryRefs(f), "");
	assertNoLeftovers(f);
});

test("an external index lock is reported and the file is left alone", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "mine\n");
	const expected = await revision(f);
	const lock = join(f.root, ".git", "index.lock");
	writeFileSync(lock, "");
	assert.equal(await code(f, { path: "a.txt", group: "workingTree", expectedRevision: expected }), "GIT_INDEX_LOCKED");
	assert.equal(existsSync(lock), true, "the foreign lock is preserved for the owner to inspect");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "mine\n");
	assert.equal(recoveryRefs(f), "");
});

test("a repository without a configured identity can still discard, and the snapshot says who wrote it", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "mine\n");
	const expected = await revision(f);
	const result = successful(await f.request("git.discard", { path: "a.txt", group: "workingTree", expectedRevision: expected }));
	assert.equal(f.git("log", "-1", "--format=%cn <%ce>", result.recoveryRef).trim(), "PiDeck recovery <pideck-recovery@localhost>");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "base\n");
	assertNoLeftovers(f);
});

test("two discards of the same shape create two distinct refs, each holding its own bytes", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "a.txt"), "first edit\n");
	const first = successful(await f.request("git.discard", { path: "a.txt", group: "workingTree", expectedRevision: await revision(f) }));
	writeFileSync(join(f.root, "a.txt"), "second edit\n");
	const second = successful(await f.request("git.discard", { path: "a.txt", group: "workingTree", expectedRevision: await revision(f) }));
	assert.notEqual(first.recoveryRef, second.recoveryRef);
	assert.equal(f.git("show", first.recoveryRef + ":a.txt"), "first edit\n");
	assert.equal(f.git("show", second.recoveryRef + ":a.txt"), "second edit\n");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "base\n");
	assertNoLeftovers(f);
});

test("a discarded nested path keeps its directory shape inside the snapshot", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "sub", "dir", "nested.txt"), "nested edit\n");
	const result = successful(await f.request("git.discard", { path: "sub/dir/nested.txt", group: "workingTree", expectedRevision: await revision(f) }));
	assert.equal(f.git("show", result.recoveryRef + ":sub/dir/nested.txt"), "nested edit\n");
	assert.equal(readFileSync(join(f.root, "sub", "dir", "nested.txt"), "utf8"), "nested base\n");
	assert.equal(statSync(join(f.root, "sub", "dir")).isDirectory(), true);
	assertNoLeftovers(f);
});

/**
 * Set a file's timestamp to exactly the one its index entry recorded, so a stat-cache-driven implementation would
 * consider it current. The bytes still differ, so a correct implementation must rewrite the file anyway.
 */
function withCachedTimestamp(f, path, replacement) {
	const debug = f.git("ls-files", "--debug", "--", path);
	const match = /mtime: (\d+):(\d+)/.exec(debug);
	assert.ok(match, `the index must carry stat data for ${path}: ${debug}`);
	writeFileSync(join(f.root, path), replacement);
	const seconds = Number(match[1]) + Number(match[2]) / 1e9;
	utimesSync(join(f.root, path), seconds, seconds);
	const staged = f.git("show", `:${path}`);
	assert.notEqual(staged, replacement, "the bytes on disk must really differ from the staged version");
	return { staged, replacement };
}

test("a discard writes the file even when its timestamp matches the cached index entry", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const forged = withCachedTimestamp(f, "a.txt", "mine\n");
	const result = successful(await f.request("git.discard", { path: "a.txt", group: "workingTree", expectedRevision: await revision(f) }));
	assert.equal(result.applied, true);
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), forged.staged, "the staged version must really be on disk, not only in git's cache");
	assert.equal(f.git("show", `${result.recoveryRef}:a.txt`), forged.replacement);
	assert.equal(f.git("status", "--porcelain=v1").trim(), "");
	assertNoLeftovers(f);
});

test("a restore refuses to overwrite a file the index does not know about", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "note.txt"), "snapshot me\n");
	const snapshot = successful(await f.request("git.discard", { path: "note.txt", group: "untracked", expectedRevision: await revision(f) }));
	// The user creates a different file at the same path: it is untracked, so nothing in the index can vouch for it.
	writeFileSync(join(f.root, "note.txt"), "my own new file\n");
	const entry = successful(await f.request("git.recoveryList")).entries[0];
	assert.equal(entry.ref, snapshot.recoveryRef);
	const refused = await f.request("git.recoveryRestore", { ref: entry.ref, oid: entry.oid, path: entry.path, expectedRevision: await revision(f) });
	assert.equal(refused.ok, false);
	assert.equal(refused.error?.code, "GIT_RESTORE_CONFLICT");
	assert.equal(readFileSync(join(f.root, "note.txt"), "utf8"), "my own new file\n", "an untracked file is never overwritten by a restore");
	assertNoLeftovers(f);
});

test("a discard in a repository whose attributes convert the file still produces the checkout form", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	// The index stores the normalised (LF) form; the worktree file is checked out as CRLF. A byte comparison against
	// the index blob would call this "not restored", while git's own comparison - with no stat cache in the way -
	// is exactly the right verdict.
	writeFileSync(join(f.root, ".gitattributes"), "*.txt text eol=crlf\n");
	f.git("add", "--", ".gitattributes");
	f.git(...IDENTITY, "commit", "-qm", "attributes");
	writeFileSync(join(f.root, "a.txt"), "my converted edit\r\n");
	const result = successful(await f.request("git.discard", { path: "a.txt", group: "workingTree", expectedRevision: await revision(f) }));
	assert.equal(result.applied, true);
	assert.equal(f.git("show", `${result.recoveryRef}:a.txt`), "my converted edit\r\n", "the snapshot keeps the bytes the user had");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "base\r\n", "the worktree holds the checkout form of the staged version");
	// git diff is the content verdict here: with text/eol attributes git status can still say "modified" for a file
	// whose converted content equals the index, and the product's own post-check therefore compares through git diff.
	assert.equal(f.git("diff", "--", "a.txt").trim(), "");
	assertNoLeftovers(f);
});
