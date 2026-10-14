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

test("remote Git refresh exposes complete facts and has no implicit polling or mutation API", async () => {
	let count = 0;
	const f = fixture({
		remoteSnapshot: async () => {
			count++;
			return { ok: true, snapshot };
		},
	});
	await f.reads.refresh();
	assert.equal(f.current().snapshot.branch, "main");
	assert.equal(count, 1);
	assert.equal(f.reads.stage, undefined);
	assert.equal(f.reads.commit, undefined);
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
