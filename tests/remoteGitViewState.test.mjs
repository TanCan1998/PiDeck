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
			return calls.length === 1
				? { ok: true, page: { commits: [historyRow(oid("1"), "first")], hasMore: true } }
				: failOnce
					? { ok: false, code: "GIT_COMMAND_FAILED" }
					: { ok: true, page: { commits: [historyRow(oid("3"), "second")], hasMore: false } };
		},
	});
	await f.reads.loadHistory();
	assert.deepEqual(plain(calls), [["project", { maxCount: 50 }]]);
	assert.equal(f.current().history.commits.length, 1);
	assert.equal(f.current().history.hasMore, true);
	await f.reads.loadMoreHistory();
	assert.deepEqual(plain(calls.at(-1)), ["project", { maxCount: 50, skip: 1 }]);
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
	const thrown = fixture({ remoteCommitDetail: async () => { throw new Error("invoke failed with SSH_HOST_DISCONNECTED"); } });
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
		remoteRefFileDiff: async (id, base, head, fileTarget) => {
			calls.push([id, base, head, fileTarget]);
			return { ok: true, diff: { path: fileTarget.relativePath, target: fileTarget, displayPath: fileTarget.relativePath, base, head, originalContent: "old side", modifiedContent: "new side" } };
		},
	});
	await f.reads.refresh();
	await f.reads.openHistoryFileDiff(oid("a"), oid("b"), target);
	assert.deepEqual(plain(calls), [["project", oid("a"), oid("b"), target]]);
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
	assert.deepEqual(plain(calls[0]), ["project", "feature/one", branchSnapshot.branchToken]);
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
	assert.deepEqual(plain(calls), [["project", "feature", branchSnapshot.switchToken]]);
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
