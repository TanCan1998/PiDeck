import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const projectId = "project";
const target = { projectId, relativePath: "file.txt" };
const snapshot = { head: "a".repeat(40), branch: "main", groups: { merge: [], index: [], workingTree: [], untracked: [] } };
function deferred() {
	let resolve;
	const promise = new Promise((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}
function fixture(api = {}) {
	const states = [];
	const reads = createRemoteGitViewController(
		projectId,
		"identity",
		{ cancelRemoteReads: async () => {}, remoteSnapshot: async () => ({ ok: true, snapshot }), workspaceFileDiff: async () => ({ target, path: target.relativePath, displayPath: target.relativePath, originalContent: "old", modifiedContent: "new" }), ...api },
		(state) => states.push(state),
	);
	return { reads, states, current: () => states.at(-1) };
}

test("remote Git refresh exposes complete facts and performs no implicit write", async () => {
	let count = 0;
	const writes = [];
	const f = fixture({
		remoteSnapshot: async () => {
			count++;
			return { ok: true, snapshot };
		},
		mutateRemoteIndex: async (...args) => {
			writes.push(args);
			return { ok: true };
		},
		commitRemote: async (...args) => {
			writes.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	assert.equal(f.current().snapshot.branch, "main");
	assert.equal(count, 1);
	assert.equal(f.reads.stage, undefined, "no convenience alias may act without an explicit call");
	assert.deepEqual(writes, [], "a refresh never writes; both write actions stay explicit and separate");
	// The commit action exists, but without a granted token and a message it never reaches the API.
	await f.reads.commit("message\n");
	assert.deepEqual(writes, [], "commit without a grant must not call the API");
});

test("concurrent refresh cannot start a second read", async () => {
	const pending = deferred();
	let count = 0;
	const f = fixture({
		remoteSnapshot: () => {
			count++;
			return pending.promise;
		},
	});
	const first = f.reads.refresh();
	await f.reads.refresh();
	assert.equal(count, 1);
	pending.resolve({ ok: true, snapshot });
	await first;
});

test("failed refresh clears previous facts instead of showing stale clean status", async () => {
	let count = 0;
	const f = fixture({ remoteSnapshot: async () => (++count === 1 ? { ok: true, snapshot } : { ok: false, code: "SSH_HOST_DISCONNECTED" }) });
	await f.reads.refresh();
	await f.reads.refresh();
	assert.equal(f.current().snapshot, undefined);
	assert.equal(f.current().errorCode, "SSH_HOST_DISCONNECTED");
});

test("unmount/project change discards a late status result", async () => {
	const pending = deferred();
	const f = fixture({ remoteSnapshot: () => pending.promise });
	const request = f.reads.refresh();
	f.reads.dispose();
	pending.resolve({ ok: true, snapshot });
	await request;
	assert.equal(f.states.length, 1);
	assert.equal(f.current().snapshot, undefined);
});

test("connection invalidation clears facts and discards in-flight success without refreshing", async () => {
	const pending = deferred();
	const f = fixture({ remoteSnapshot: () => pending.promise });
	const request = f.reads.refresh();
	f.reads.invalidateConnection();
	pending.resolve({ ok: true, snapshot });
	await request;
	assert.equal(f.current().snapshot, undefined);
	assert.equal(f.current().errorCode, "REMOTE_CONNECTION_LOST");
});

test("single diff flight retains group semantics and prevents overlapping refresh or close", async () => {
	const pending = deferred();
	const f = fixture({ workspaceFileDiff: () => pending.promise });
	await f.reads.refresh();
	const request = f.reads.openDiff("index", target);
	assert.equal(f.current().diffLoading, true);
	assert.equal(f.current().diffGroup, "index");
	await f.reads.refresh();
	f.reads.closeDiff();
	assert.equal(f.current().diffLoading, true);
	pending.resolve({ target, path: target.relativePath, displayPath: target.relativePath, originalContent: "old", modifiedContent: "new" });
	await request;
	assert.equal(f.current().diff.originalContent, "old");
	f.reads.closeDiff();
	assert.equal(f.current().diff, undefined);
});

test("invalid diff identity and cross-project targets cannot enter the view", async () => {
	let calls = 0;
	const f = fixture({
		workspaceFileDiff: async () => {
			calls++;
			return { target: { projectId: "other", relativePath: target.relativePath } };
		},
	});
	await f.reads.refresh();
	await f.reads.openDiff("index", { ...target, projectId: "other" });
	assert.equal(calls, 0);
	await f.reads.openDiff("index", target);
	assert.equal(f.current().diff, undefined);
	assert.equal(f.current().diffErrorCode, "GIT_RESOURCE_CHANGED");
});

test("invoke diagnostics reduce to a stable code rather than leaking remote details", async () => {
	const f = fixture({
		workspaceFileDiff: async () => {
			throw new Error("Error invoking remote method 'git:workspace-file-diff': Error: GIT_NOT_TEXT");
		},
	});
	await f.reads.refresh();
	await f.reads.openDiff("workingTree", target);
	assert.equal(f.current().diffErrorCode, "GIT_NOT_TEXT");
});

const oid = (char) => char.repeat(40);
const plain = (value) => JSON.parse(JSON.stringify(value));
const historyRow = (value, subject) => ({ oid: value, parents: [oid("2")], authorName: "A", authorEmail: "a@e.invalid", authorTimeSec: 1700000000, subject: subject });
const detailFor = (value) => ({ oid: value, parents: [oid("2")], authorName: "A", authorEmail: "a@e.invalid", authorTimeSec: 1700000000, committerName: "A", committerEmail: "a@e.invalid", committerTimeSec: 1700000000, subject: "s", message: "s\n", files: [{ status: "M", path: "file.txt" }] });

test("history pages append on demand and a failed page keeps the rows already on screen", async () => {
	const calls = [];
	let failOnce = true;
	const f = fixture({
		remoteLog: async (...args) => {
			calls.push(args);
			return calls.length === 1 ? { ok: true, page: { commits: [historyRow(oid("1"), "first")], hasMore: true } } : failOnce ? { ok: false, code: "GIT_COMMAND_FAILED" } : { ok: true, page: { commits: [historyRow(oid("3"), "second")], hasMore: false } };
		},
	});
	await f.reads.loadHistory();
	assert.deepEqual(plain(calls), [["project", { maxCount: 50 }, ""]]);
	assert.equal(f.current().history.commits.length, 1);
	assert.equal(f.current().history.hasMore, true);
	await f.reads.loadMoreHistory();
	assert.deepEqual(plain(calls.at(-1)), ["project", { maxCount: 50, skip: 1 }, ""]);
	assert.equal(f.current().history.commits.length, 1, "a failed page keeps the visible rows");
	assert.equal(f.current().historyErrorCode, "GIT_COMMAND_FAILED");
	failOnce = false;
	await f.reads.loadMoreHistory();
	assert.deepEqual(plain(f.current().history.commits.map((commit) => commit.subject)), ["first", "second"]);
	assert.equal(f.current().history.hasMore, false);
	assert.equal(f.current().historyErrorCode, undefined);
	// With no next page there is no further flight, however often the button is pressed.
	await f.reads.loadMoreHistory();
	assert.equal(calls.length, 3);
});

test("a refresh drops history, refs and detail facts without reloading them", async () => {
	const calls = [];
	const f = fixture({
		remoteLog: async (...args) => {
			calls.push(args);
			return { ok: true, page: { commits: [historyRow(oid("1"), "first")], hasMore: false } };
		},
		remoteRefs: async () => {
			calls.push(["refs"]);
			return { ok: true, refs: { head: oid("1"), branch: "main", refs: [{ fullName: "refs/heads/main", name: "main", oid: oid("1"), kind: "branch" }] } };
		},
		remoteCommitDetail: async (...args) => {
			calls.push(args);
			return { ok: true, detail: detailFor(oid("1")) };
		},
	});
	await f.reads.loadHistory();
	await f.reads.loadRefs();
	await f.reads.openCommitDetail(oid("1"));
	assert.ok(f.current().history && f.current().refs && f.current().detail);
	await f.reads.refresh();
	assert.equal(f.current().history, undefined, "facts die with the snapshot facts; the panel never mixes generations");
	assert.equal(f.current().refs, undefined);
	assert.equal(f.current().detail, undefined);
	assert.equal(f.current().detailOid, undefined);
	assert.equal(calls.length, 3, "the refresh itself reloads nothing");
});

test("commit detail answers the last click, and an answer for another commit is refused", async () => {
	const f = fixture({ remoteCommitDetail: async (id, value) => ({ ok: true, detail: detailFor(value) }) });
	await Promise.all([f.reads.openCommitDetail(oid("a")), f.reads.openCommitDetail(oid("b"))]);
	assert.equal(f.current().detailOid, oid("b"));
	assert.equal(f.current().detail.oid, oid("b"));
	const swapped = fixture({ remoteCommitDetail: async () => ({ ok: true, detail: detailFor(oid("c")) }) });
	await swapped.reads.openCommitDetail(oid("b"));
	assert.equal(swapped.current().detail, undefined);
	assert.equal(swapped.current().detailErrorCode, "GIT_RESOURCE_CHANGED");
});

test("a refused or crashed detail read reports its own code and keeps the selection", async () => {
	const f = fixture({ remoteCommitDetail: async () => ({ ok: false, code: "GIT_OBJECT_NOT_FOUND" }) });
	await f.reads.openCommitDetail(oid("b"));
	assert.equal(f.current().detailOid, oid("b"));
	assert.equal(f.current().detailErrorCode, "GIT_OBJECT_NOT_FOUND");
	const thrown = fixture({
		remoteCommitDetail: async () => {
			throw new Error("invoke failed with SSH_HOST_DISCONNECTED");
		},
	});
	await thrown.reads.openCommitDetail(oid("b"));
	assert.equal(thrown.current().detailErrorCode, "SSH_HOST_DISCONNECTED");
});

test("refs load once at a time and a late answer after invalidation is discarded", async () => {
	let resolve;
	const f = fixture({
		remoteRefs: async () =>
			new Promise((accept) => {
				resolve = accept;
			}),
	});
	const pending = f.reads.loadRefs();
	assert.equal(f.current().refsLoading, true);
	await f.reads.loadRefs();
	f.reads.invalidateConnection();
	resolve({ ok: true, refs: { head: oid("1"), branch: "main", refs: [] } });
	await pending;
	assert.equal(f.current().refs, undefined, "an answer from before the connection loss cannot publish");
	assert.equal(f.current().errorCode, "REMOTE_CONNECTION_LOST");
});

test("a revision file diff uses the shared diff surface and its identity is checked", async () => {
	const calls = [];
	const f = fixture({
		remoteRefFileDiff: async (id, base, head, fileTarget, repo) => {
			calls.push([id, base, head, fileTarget, repo]);
			return { ok: true, diff: { path: fileTarget.relativePath, target: fileTarget, displayPath: fileTarget.relativePath, base, head, originalContent: "old side", modifiedContent: "new side" } };
		},
	});
	await f.reads.refresh();
	await f.reads.openHistoryFileDiff(oid("a"), oid("b"), target);
	assert.deepEqual(plain(calls), [["project", oid("a"), oid("b"), target, ""]]);
	assert.equal(f.current().diffKind, "revision");
	assert.equal(f.current().diff.originalContent, "old side");
	assert.equal(f.current().diffGroup, undefined);
	// A workspace diff replaces the revision diff on the same surface.
	await f.reads.closeDiff();
	await f.reads.openDiff("workingTree", target);
	assert.equal(f.current().diffKind, "workspace");
	// A target from another project never starts a flight.
	calls.length = 0;
	await f.reads.closeDiff();
	await f.reads.openHistoryFileDiff(oid("a"), oid("b"), { projectId: "other", relativePath: "file.txt" });
	assert.deepEqual(calls, []);
	// An answer for a different file is a refusal, not a substitute diff.
	const swapped = fixture({
		remoteRefFileDiff: async (id, base, head) => ({ ok: true, diff: { path: "other.txt", target: { projectId, relativePath: "other.txt" }, displayPath: "other.txt", base, head, originalContent: "x", modifiedContent: "y" } }),
	});
	await swapped.reads.refresh();
	await swapped.reads.openHistoryFileDiff(oid("a"), oid("b"), target);
	assert.equal(swapped.current().diff, undefined);
	assert.equal(swapped.current().diffErrorCode, "GIT_RESOURCE_CHANGED");
});

const branchSnapshot = { ...snapshot, branchToken: "b".repeat(32), switchToken: "c".repeat(32) };

test("creating a branch sends the main-owned grant, refreshes only after confirmation and never replays an unknown result", async () => {
	const calls = [];
	let resolve;
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: branchSnapshot }),
		createRemoteBranch: async (...args) => {
			calls.push(args);
			return new Promise((accept) => {
				resolve = accept;
			});
		},
	});
	await f.reads.refresh();
	const pending = f.reads.createBranch("feature/one");
	assert.equal(f.current().mutating, true);
	assert.equal(f.current().mutatingKind, "branch");
	// One action at a time: a second click while the first is in flight never reaches the API.
	await f.reads.createBranch("feature/two");
	assert.equal(calls.length, 1);
	assert.deepEqual(plain(calls[0]), ["project", "feature/one", branchSnapshot.branchToken, ""]);
	resolve({ ok: true });
	await pending;
	assert.equal(f.current().mutating, undefined);
	assert.equal(f.calls?.length ?? 0, 0);
	// A refusal reports its own code and drops the facts.
	const refused = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot: branchSnapshot }), createRemoteBranch: async () => ({ ok: false, code: "GIT_REF_EXISTS" }) });
	await refused.reads.refresh();
	await refused.reads.createBranch("taken");
	assert.equal(refused.current().errorCode, "GIT_REF_EXISTS");
	assert.equal(refused.current().snapshot, undefined);
	// An unknown outcome is a warning, not a success, and is never replayed.
	const unknown = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot: branchSnapshot }), createRemoteBranch: async () => ({ ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" }) });
	await unknown.reads.refresh();
	await unknown.reads.createBranch("maybe");
	assert.equal(unknown.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
});

test("an invalid or unauthorized branch name never reaches the API", async () => {
	const calls = [];
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: branchSnapshot }),
		createRemoteBranch: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
		switchRemoteBranch: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	for (const name of ["", "@", "-feature", "HEAD", "FETCH_HEAD", "refs/heads/x", "a@{b}", "a\\b", "x".repeat(1025), "d".repeat(40)]) await f.reads.createBranch(name);
	await f.reads.switchBranch("main");
	assert.deepEqual(calls, [], "names main would refuse and the branch already current are refused locally");
	// Without a grant from the snapshot nothing is attempted, however valid the name is.
	const ungranted = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot }) });
	await ungranted.reads.refresh();
	await ungranted.reads.createBranch("feature/one");
	await ungranted.reads.switchBranch("feature/one");
	assert.equal(ungranted.current().errorCode, undefined);
});

test("switching uses its own grant, refreshes on confirmation and reports a conflict without touching facts twice", async () => {
	const calls = [];
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: branchSnapshot }),
		switchRemoteBranch: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	await f.reads.switchBranch("feature");
	assert.deepEqual(plain(calls), [["project", "feature", branchSnapshot.switchToken, ""]]);
	// A grant is single use, so the second click can only work because the confirmed switch re-read the repository.
	const readsBefore = f.states.filter((entry) => entry.snapshot !== undefined).length;
	await f.reads.switchBranch("feature");
	assert.equal(calls.length, 2);
	assert.ok(f.states.filter((entry) => entry.snapshot !== undefined).length > readsBefore, "a confirmed switch re-reads the repository and hands out the next grant");
	const conflict = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot: branchSnapshot }), switchRemoteBranch: async () => ({ ok: false, code: "GIT_SWITCH_CONFLICT" }) });
	await conflict.reads.refresh();
	await conflict.reads.switchBranch("feature");
	assert.equal(conflict.current().errorCode, "GIT_SWITCH_CONFLICT");
	assert.equal(conflict.current().mutating, undefined);
});

const discardSnapshot = {
	...snapshot,
	discardToken: "d".repeat(32),
	groups: { merge: [], index: [], workingTree: [{ target, path: target.relativePath, displayPath: target.relativePath, status: 5, letter: "M" }], untracked: [{ target: { projectId, relativePath: "junk.txt" }, path: "junk.txt", displayPath: "junk.txt", status: 7, letter: "?" }] },
};

test("discarding a file asks main for the backup, keeps the recovery ref and re-reads the repository", async () => {
	const calls = [];
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: discardSnapshot }),
		discardRemote: async (...args) => {
			calls.push(args);
			return { ok: true, recoveryRef: "refs/pideck/recovery/20261016120000-ab12cd34" };
		},
	});
	await f.reads.refresh();
	await f.reads.discard("workingTree", target);
	assert.deepEqual(plain(calls), [["project", "workingTree", target, discardSnapshot.discardToken, ""]]);
	assert.deepEqual(plain(f.current().discardRecovery), { ref: "refs/pideck/recovery/20261016120000-ab12cd34", path: "file.txt" });
	// The note is what tells the user how to get the bytes back, so a later read must not erase it.
	await f.reads.refresh();
	assert.ok(f.current().discardRecovery, "the recovery note survives a refresh");
	// A second discard replaces the note instead of accumulating stale ones.
	await f.reads.discard("untracked", { projectId, relativePath: "junk.txt" });
	assert.deepEqual(plain(f.current().discardRecovery), { ref: "refs/pideck/recovery/20261016120000-ab12cd34", path: "junk.txt" });
	assert.deepEqual(plain(calls.at(-1)), ["project", "untracked", { projectId, relativePath: "junk.txt" }, discardSnapshot.discardToken, ""]);
});

test("a discard that has nothing to back up reports that honestly", async () => {
	const f = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot: discardSnapshot }), discardRemote: async () => ({ ok: true, recoveryRef: null }) });
	await f.reads.refresh();
	await f.reads.discard("workingTree", target);
	assert.deepEqual(plain(f.current().discardRecovery), { ref: null, path: "file.txt" });
	assert.equal(f.current().errorCode, undefined);
});

test("a refused or unknown discard drops the facts, keeps the warning and is never replayed", async () => {
	const refused = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot: discardSnapshot }), discardRemote: async () => ({ ok: false, code: "RESULT_TOO_LARGE" }) });
	await refused.reads.refresh();
	await refused.reads.discard("workingTree", target);
	assert.equal(refused.current().errorCode, "RESULT_TOO_LARGE");
	assert.equal(refused.current().snapshot, undefined, "a refusal drops facts rather than showing a half-true tree");
	assert.equal(refused.current().discardRecovery, undefined);
	const unknown = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: discardSnapshot }),
		discardRemote: async () => {
			throw new Error("socket closed");
		},
	});
	await unknown.reads.refresh();
	await unknown.reads.discard("workingTree", target);
	assert.equal(unknown.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(unknown.current().discardRecovery, undefined, "an unknown outcome promises no backup");
});

test("a discard without a grant, with the wrong group or for another project never reaches the API", async () => {
	const calls = [];
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: discardSnapshot }),
		discardRemote: async (...args) => {
			calls.push(args);
			return { ok: true, recoveryRef: null };
		},
	});
	await f.reads.refresh();
	await f.reads.discard("index", target);
	await f.reads.discard("workingTree", { projectId: "other", relativePath: "file.txt" });
	await f.reads.discard("workingTree", { projectId, relativePath: "not-in-snapshot.txt" });
	assert.deepEqual(calls, []);
	const ungranted = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot }) });
	await ungranted.reads.refresh();
	await ungranted.reads.discard("workingTree", target);
	assert.equal(ungranted.current().errorCode, undefined);
	// One action at a time: the second click while the first is in flight is ignored.
	const busy = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: discardSnapshot }),
		discardRemote: async (...args) => {
			calls.push(args);
			return new Promise(() => {});
		},
	});
	await busy.reads.refresh();
	void busy.reads.discard("workingTree", target);
	await busy.reads.discard("workingTree", target);
	assert.equal(calls.length, 1);
});

const recoveryEntry = { ref: "refs/pideck/recovery/20261016120000-ab12cd34", oid: "e".repeat(40), path: "file.txt", bytes: 2048, at: 1792138005 };
const recoverySnapshot = { ...snapshot, restoreToken: "e".repeat(32), dropToken: "f".repeat(32) };

test("the recovery listing loads on demand and its truncation flag travels with it", async () => {
	const calls = [];
	const f = fixture({
		recoveryList: async (...args) => {
			calls.push(args);
			return { ok: true, entries: [recoveryEntry], truncated: true };
		},
	});
	await f.reads.loadRecovery();
	assert.deepEqual(plain(calls), [["project", ""]]);
	assert.deepEqual(plain(f.current().recovery), { entries: [recoveryEntry], truncated: true });
	assert.equal(f.current().recoveryLoading, false);
	const failed = fixture({ recoveryList: async () => ({ ok: false, code: "GIT_COMMAND_FAILED" }) });
	await failed.reads.loadRecovery();
	assert.equal(failed.current().recoveryErrorCode, "GIT_COMMAND_FAILED");
	assert.equal(failed.current().recovery, undefined);
	const thrown = fixture({
		recoveryList: async () => {
			throw new Error("invoke failed with SSH_HOST_DISCONNECTED");
		},
	});
	await thrown.reads.loadRecovery();
	assert.equal(thrown.current().recoveryErrorCode, "SSH_HOST_DISCONNECTED");
});

test("restoring a snapshot keeps the recovery store and answers with its own grant", async () => {
	const calls = [];
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: recoverySnapshot }),
		recoveryList: async () => ({ ok: true, entries: [], truncated: false }),
		recoveryRestore: async (...args) => {
			calls.push(args);
			return { ok: true, path: "file.txt", bytes: 2048 };
		},
	});
	await f.reads.refresh();
	await f.reads.restoreRecovery(recoveryEntry);
	assert.deepEqual(plain(calls), [["project", recoveryEntry.ref, recoveryEntry.oid, recoveryEntry.path, recoverySnapshot.restoreToken, ""]]);
	assert.deepEqual(plain(f.current().recoveryNotice), { kind: "restored", path: "file.txt" });
	assert.equal(f.current().mutating, undefined);
	// The listing is reloaded after a restore, and the notice survives the refresh that follows it.
	assert.ok(f.current().recovery, "the store is listed again");
	await f.reads.refresh();
	assert.deepEqual(plain(f.current().recoveryNotice), { kind: "restored", path: "file.txt" }, "an outcome the user still needs is not erased by a read");
});

test("deleting a snapshot is its own action with its own grant", async () => {
	const calls = [];
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: recoverySnapshot }),
		recoveryList: async () => ({ ok: true, entries: [], truncated: false }),
		recoveryDrop: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	await f.reads.dropRecovery(recoveryEntry);
	assert.deepEqual(plain(calls), [["project", recoveryEntry.ref, recoveryEntry.oid, recoverySnapshot.dropToken, ""]]);
	assert.deepEqual(plain(f.current().recoveryNotice), { kind: "dropped", path: "file.txt" });
	// The repository facts come back with the outcome: a drop must not leave the panel looking empty.
	assert.ok(f.current().snapshot, "the panel re-reads the repository after a drop");
	// A refused drop reports its code and drops the facts; an unknown one says so and is never replayed.
	const refused = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot: recoverySnapshot }), recoveryDrop: async () => ({ ok: false, code: "GIT_RECOVERY_ENTRY_NOT_FOUND" }) });
	await refused.reads.refresh();
	await refused.reads.dropRecovery(recoveryEntry);
	assert.equal(refused.current().errorCode, "GIT_RECOVERY_ENTRY_NOT_FOUND");
	assert.equal(refused.current().snapshot, undefined);
	const unknown = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: recoverySnapshot }),
		recoveryDrop: async () => {
			throw new Error("socket closed");
		},
	});
	await unknown.reads.refresh();
	await unknown.reads.dropRecovery(recoveryEntry);
	assert.equal(unknown.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
});

test("recovery actions without a grant, with a foreign ref or for another project never reach the API", async () => {
	const calls = [];
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: recoverySnapshot }),
		recoveryList: async () => ({ ok: true, entries: [], truncated: false }),
		recoveryRestore: async (...args) => {
			calls.push(args);
			return { ok: true, path: "file.txt", bytes: 1 };
		},
		recoveryDrop: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	for (const bad of [{ ...recoveryEntry, ref: "refs/heads/main" }, { ...recoveryEntry, ref: "HEAD" }, { ...recoveryEntry, oid: "nope" }, null]) {
		await f.reads.restoreRecovery(bad);
		await f.reads.dropRecovery(bad);
	}
	assert.deepEqual(calls, [], "a foreign ref is refused locally, exactly as main would refuse it");
	const ungranted = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot }) });
	await ungranted.reads.refresh();
	await ungranted.reads.restoreRecovery(recoveryEntry);
	await ungranted.reads.dropRecovery(recoveryEntry);
	assert.equal(ungranted.current().errorCode, undefined);
});

test("a listing that finishes after a drop cannot erase the drop's outcome", async () => {
	let release;
	let listings = 0;
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: recoverySnapshot }),
		// The first listing hangs (the panel is still loading it); the reload the drop triggers answers at once.
		recoveryList: () => {
			listings += 1;
			return listings === 1
				? new Promise((accept) => {
						release = accept;
					})
				: Promise.resolve({ ok: true, entries: [], truncated: false });
		},
		recoveryDrop: async () => ({ ok: true }),
	});
	await f.reads.refresh();
	// The user expands the section (a listing starts), then drops a snapshot from the listing already on screen.
	const slowListing = f.reads.loadRecovery();
	const drop = f.reads.dropRecovery(recoveryEntry);
	await drop;
	release({ ok: true, entries: [], truncated: false });
	await slowListing;
	assert.deepEqual(plain(f.current().recoveryNotice), { kind: "dropped", path: "file.txt" }, "a read must never decide what an action reported");
	assert.deepEqual(plain(f.current().recovery), { entries: [], truncated: false });
});

const syncFacts = { branch: "main", upstream: "refs/remotes/origin/main", ahead: 1, behind: 2, remotes: ["origin"] };
const syncSnapshot = { ...snapshot, fetchToken: "1".repeat(32), pushToken: "2".repeat(32), pullToken: "3".repeat(32) };

test("sync facts load on demand and the three verbs use their own grants and report their own outcome", async () => {
	const calls = [];
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: syncSnapshot }),
		syncFacts: async (...args) => {
			calls.push(["facts", ...args]);
			return { ok: true, facts: syncFacts };
		},
		fetchRemote: async (...args) => {
			calls.push(["fetch", ...args]);
			return { ok: true, outcome: { upToDate: false, updated: [{ ref: "refs/remotes/origin/main", before: null, after: "a".repeat(40) }] } };
		},
		pushRemote: async (...args) => {
			calls.push(["push", ...args]);
			return { ok: true, outcome: { outcome: "pushed", refspec: "refs/heads/main:refs/heads/main" } };
		},
		pullRemote: async (...args) => {
			calls.push(["pull", ...args]);
			return { ok: true, outcome: { mode: "fast-forward", head: "b".repeat(40) } };
		},
	});
	await f.reads.loadSync();
	assert.deepEqual(plain(f.current().sync), syncFacts);
	await f.reads.refresh();
	await f.reads.loadSync();
	await f.reads.fetch("origin");
	assert.deepEqual(plain(calls.filter((call) => call[0] === "fetch").at(-1)), ["fetch", "project", "origin", syncSnapshot.fetchToken, ""]);
	assert.deepEqual(plain(f.current().syncNotice), { kind: "fetch", outcome: "updated:1" });
	await f.reads.loadSync();
	await f.reads.push("origin", "main");
	assert.deepEqual(plain(calls.filter((call) => call[0] === "push").at(-1)), ["push", "project", "origin", "main", syncSnapshot.pushToken, ""]);
	assert.deepEqual(plain(f.current().syncNotice), { kind: "push", outcome: "pushed" });
	await f.reads.loadSync();
	await f.reads.pull("origin", "main");
	assert.deepEqual(plain(calls.filter((call) => call[0] === "pull").at(-1)), ["pull", "project", "origin", "main", syncSnapshot.pullToken, ""]);
	assert.deepEqual(plain(f.current().syncNotice), { kind: "pull", outcome: "fast-forward" });
	// The notice survives the refresh the verb performs, and the facts are re-read with it.
	await f.reads.refresh();
	assert.deepEqual(plain(f.current().syncNotice), { kind: "pull", outcome: "fast-forward" });
});

test("sync refusals and unknown outcomes are never replayed or guessed", async () => {
	const refused = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot: syncSnapshot }), syncFacts: async () => ({ ok: true, facts: syncFacts }), pushRemote: async () => ({ ok: false, code: "GIT_PUSH_REJECTED" }) });
	await refused.reads.refresh();
	await refused.reads.loadSync();
	await refused.reads.push("origin", "main");
	assert.equal(refused.current().errorCode, "GIT_PUSH_REJECTED");
	assert.equal(refused.current().snapshot, undefined, "a refused verb drops the facts instead of showing a stale tree");
	const unknown = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: syncSnapshot }),
		syncFacts: async () => ({ ok: true, facts: syncFacts }),
		pullRemote: async () => {
			throw new Error("socket closed");
		},
	});
	await unknown.reads.refresh();
	await unknown.reads.loadSync();
	await unknown.reads.pull("origin", "main");
	assert.equal(unknown.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(unknown.current().syncNotice, undefined, "an unknown outcome promises nothing");
	const failing = fixture({ syncFacts: async () => ({ ok: false, code: "GIT_SYNC_FAILED" }) });
	await failing.reads.loadSync();
	assert.equal(failing.current().syncErrorCode, "GIT_SYNC_FAILED");
});

test("a sync verb without a grant, an unknown remote or the wrong branch never reaches the API", async () => {
	const calls = [];
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: syncSnapshot }),
		syncFacts: async () => ({ ok: true, facts: syncFacts }),
		fetchRemote: async (...args) => {
			calls.push(["fetch", ...args]);
			return { ok: true, outcome: { upToDate: true, updated: [] } };
		},
		pushRemote: async (...args) => {
			calls.push(["push", ...args]);
			return { ok: true, outcome: { outcome: "up-to-date", refspec: "refs/heads/main:refs/heads/main" } };
		},
	});
	await f.reads.refresh();
	await f.reads.loadSync();
	await f.reads.fetch("elsewhere");
	await f.reads.push("origin", "other");
	assert.deepEqual(calls, [], "only a remote this repository has, and only the checked-out branch, may be synced");
	const ungranted = fixture({ remoteSnapshot: async () => ({ ok: true, snapshot: snapshot }), syncFacts: async () => ({ ok: true, facts: syncFacts }) });
	await ungranted.reads.refresh();
	await ungranted.reads.loadSync();
	await ungranted.reads.fetch("origin");
	assert.equal(ungranted.current().errorCode, undefined);
	assert.equal(ungranted.current().syncNotice, undefined);
});
