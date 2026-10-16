import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const oid = (char) => char.repeat(40);
const snapshot = { status: Buffer.from(" M tracked.txt\0").toString("base64"), head: oid("a"), branch: "main" };
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff", "git.log", "git.commitDetail", "git.refs", "git.refFileDiff"] };
const logPage = { commits: [{ oid: oid("a"), parents: [oid("b")], authorName: "Fixture", authorEmail: "fixture@example.invalid", authorTimeSec: 1700000000, subject: "one" }], hasMore: true };
const detailValue = {
	parents: [oid("b")],
	authorName: "Fixture",
	authorEmail: "fixture@example.invalid",
	authorTimeSec: 1700000000,
	committerName: "Fixture",
	committerEmail: "fixture@example.invalid",
	committerTimeSec: 1700000000,
	subject: "subject",
	message: "subject\n\nbody\n",
	files: [{ status: "R100", path: "renamed.txt", oldPath: "old.txt" }],
};
const refsValue = {
	head: oid("a"),
	branch: "main",
	refs: [
		{ fullName: "refs/heads/main", name: "main", oid: oid("a"), kind: "branch" },
		{ fullName: "refs/tags/v1", name: "v1", oid: oid("c"), kind: "tag" },
	],
};
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Drive registered IPC handlers with the real remote service, no network and no local Git fallback. */
function fixture(overrides = {}) {
	const handlers = new Map();
	const calls = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		request: async (method, params, options) => {
			calls.push({ method, params });
			options?.onRequestId?.("request-id");
			if (method === "hello") return hello;
			if (method === "git.status") return snapshot;
			if (method === "git.log") return logPage;
			if (method === "git.commitDetail") return { ...detailValue, oid: params.oid };
			if (method === "git.refs") return refsValue;
			return { originalContent: "base\n", modifiedContent: "working\n" };
		},
		cancel: async (id) => {
			calls.push({ method: "cancel", id });
		},
	};
	const input = {
		enabled: true,
		locator: (id) => (id === projectId ? locator : undefined),
		trusted: async () => true,
		service: async () => ({
			withProjectSession: async (hostId, root, work, options) => {
				assert.equal(options.requireReady, true);
				assert.ok(options.signal instanceof AbortSignal);
				return { ok: true, value: await work(session) };
			},
		}),
		...overrides,
	};
	const port = registerRemoteGitReadIpc(input);
	return { port, handlers, calls, sender, session, input, event: { sender } };
}

test("remote Git snapshot IPC resolves only the main-owned target and returns branch/status facts", async () => {
	const f = fixture();
	const result = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.equal(result.ok, true);
	assert.equal(result.snapshot.branch, "main");
	assert.equal(result.snapshot.groups.workingTree[0].path, "tracked.txt");
	assert.deepEqual(plain(result.snapshot.groups.workingTree[0].target), { projectId, relativePath: "tracked.txt" });
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello", "git.status"],
	);
	assert.equal(f.sender.listenerCount("destroyed"), 0);
});

test("remote Git status/diff ports retain existing IPC shapes without any local cwd", async () => {
	const f = fixture();
	const groups = await f.port.status(f.event, projectId);
	assert.equal(groups.workingTree.length, 1);
	const diff = await f.port.workspaceDiff(f.event, projectId, "workingTree", { projectId, relativePath: "tracked.txt" });
	assert.equal(diff.originalContent, "base\n");
	assert.equal(diff.modifiedContent, "working\n");
	assert.deepEqual(plain(f.calls.at(-1).params), { group: "workingTree", path: "tracked.txt" });
});

test("disabled remote Git refuses snapshot and compatibility ports with zero helper work", async () => {
	const f = fixture({ enabled: false });
	const result = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.equal(result.ok, false);
	assert.equal(result.code, "REMOTE_FEATURE_DISABLED");
	await assert.rejects(f.port.status(f.event, projectId), /REMOTE_FEATURE_DISABLED/);
	assert.equal(f.calls.length, 0);
});

test("remote Git boundary rejects cross-project/nested repo/invalid target before connecting", async () => {
	const f = fixture();
	for (const repo of [{ projectId: "other", relativePath: "" }, { projectId, relativePath: "nested" }, "/local/absolute"]) await assert.rejects(f.port.status(f.event, projectId, repo));
	await assert.rejects(f.port.workspaceDiff(f.event, projectId, "workingTree", { projectId: "other", relativePath: "tracked.txt" }));
	await assert.rejects(f.port.workspaceDiff(f.event, projectId, "workingTree", { projectId, relativePath: "../outside" }));
	await assert.rejects(f.port.workspaceDiff(f.event, projectId, "invalid", { projectId, relativePath: "tracked.txt" }));
	assert.equal(f.calls.length, 0);
});

test("destroying the IPC sender cancels the exact active read and discards late success", async () => {
	const f = fixture();
	f.session.request = async (method, params, options) => {
		if (method === "hello") return hello;
		options.onRequestId("active-request");
		f.sender.emit("destroyed");
		return snapshot;
	};
	const result = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.equal(result.ok, false);
	assert.equal(result.code, "REQUEST_CANCELLED");
	assert.deepEqual(f.calls, [{ method: "cancel", id: "active-request" }]);
	assert.equal(f.sender.listenerCount("destroyed"), 0);
});

test("renderer cancellation is scoped to the sender and project, then cancels the exact helper request", async () => {
	const f = fixture();
	let resolve;
	const pending = new Promise((accept) => {
		resolve = accept;
	});
	f.session.request = async (method, params, options) => {
		if (method === "hello") return hello;
		options.onRequestId("active-read");
		return pending;
	};
	const request = f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	await new Promise((accept) => setImmediate(accept));
	const cancel = f.handlers.get(ipcChannels.gitRemoteCancelReads);
	cancel({ sender: { id: 2 } }, projectId);
	cancel(f.event, "other-project");
	assert.equal(f.calls.length, 0);
	cancel(f.event, projectId);
	assert.deepEqual(f.calls, [{ method: "cancel", id: "active-read" }]);
	resolve(snapshot);
	const result = await request;
	assert.equal(result.ok, false);
	assert.equal(result.code, "REQUEST_CANCELLED");
});

test("remote Git IPC disposal cancels reads and admits no further operations", async () => {
	const f = fixture();
	f.port.dispose();
	const result = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.equal(result.ok, false);
	assert.equal(result.code, "REQUEST_CANCELLED");
	assert.equal(f.calls.length, 0);
});

test("remote history IPC answers log, detail, refs and ref-file diff through the real service", async () => {
	const f = fixture();
	const page = await f.handlers.get(ipcChannels.gitRemoteLog)(f.event, projectId, { maxCount: 10, skip: 5 });
	assert.equal(page.ok, true);
	assert.equal(page.page.hasMore, true);
	assert.deepEqual(plain(page.page.commits), logPage.commits);
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.log", params: { maxCount: 10, skip: 5 } });
	const defaults = await f.handlers.get(ipcChannels.gitRemoteLog)(f.event, projectId);
	assert.equal(defaults.ok, true);
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.log", params: { maxCount: 50, skip: 0 } });
	const detail = await f.handlers.get(ipcChannels.gitRemoteCommitDetail)(f.event, projectId, oid("d"));
	assert.equal(detail.ok, true);
	assert.equal(detail.detail.oid, oid("d"));
	assert.equal(detail.detail.message, "subject\n\nbody\n");
	assert.deepEqual(plain(detail.detail.files), [{ status: "R100", path: "renamed.txt", oldPath: "old.txt" }]);
	const refs = await f.handlers.get(ipcChannels.gitRemoteRefs)(f.event, projectId);
	assert.equal(refs.ok, true);
	assert.equal(refs.refs.branch, "main");
	assert.deepEqual(
		refs.refs.refs.map((entry) => entry.kind),
		["branch", "tag"],
	);
	const diff = await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId, relativePath: "renamed.txt" });
	assert.equal(diff.ok, true);
	assert.equal(diff.diff.originalContent, "base\n");
	assert.equal(diff.diff.modifiedContent, "working\n");
	assert.deepEqual(plain(diff.diff.target), { projectId, relativePath: "renamed.txt" });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.refFileDiff", params: { base: null, head: oid("d"), path: "renamed.txt" } });
});

test("remote history IPC rejects invalid parameters before any helper session is opened", async () => {
	const f = fixture();
	for (const options of [0, 101, 1.5, "10", null, { maxCount: 10, extra: 1 }, { skip: -1 }, { skip: 100001 }]) {
		const result = await f.handlers.get(ipcChannels.gitRemoteLog)(f.event, projectId, options);
		assert.equal(result.ok, false, JSON.stringify(options));
		assert.equal(result.code, "GIT_RESULT_INVALID");
	}
	for (const value of ["abc", oid("d").toUpperCase(), 42, null]) {
		const result = await f.handlers.get(ipcChannels.gitRemoteCommitDetail)(f.event, projectId, value);
		assert.equal(result.ok, false, String(value));
		assert.equal(result.code, "GIT_RESULT_INVALID");
	}
	const cross = await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId: "other", relativePath: "renamed.txt" });
	assert.equal(cross.code, "GIT_RESULT_INVALID");
	const escape = await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId, relativePath: "../outside" });
	assert.equal(escape.code, "PATH_OUTSIDE_ROOT");
	const namedBase = await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, "main", oid("d"), { projectId, relativePath: "renamed.txt" });
	assert.equal(namedBase.code, "GIT_RESULT_INVALID");
	assert.equal(f.calls.length, 0, "refused parameters must not open a helper session");
});

test("remote history IPC re-validates helper answers and refuses anything outside the frozen shape", async () => {
	const f = fixture();
	f.session.request = async (method, params) => {
		if (method === "hello") return hello;
		if (method === "git.log") return { commits: Array.from({ length: 101 }, () => ({ oid: oid("a"), parents: [], authorName: "F", authorEmail: "f@e.invalid", authorTimeSec: 1, subject: "s" })), hasMore: false };
		if (method === "git.commitDetail") return { ...detailValue, oid: oid("e") };
		if (method === "git.refs") return { head: oid("a"), branch: "main", refs: [{ fullName: "refs/remotes/origin/main", name: "origin/main", oid: oid("b"), kind: "branch" }] };
		return { originalContent: "a\0b", modifiedContent: "" };
	};
	// A page longer than the ceiling, an answer for a different commit, a remote-tracking ref and a NUL byte.
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteLog)(f.event, projectId)).code, "GIT_RESULT_INVALID");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteCommitDetail)(f.event, projectId, oid("d"))).code, "GIT_RESULT_INVALID");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefs)(f.event, projectId)).code, "GIT_RESULT_INVALID");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId, relativePath: "x.txt" })).code, "GIT_RESULT_INVALID");
});

test("disabled remote history IPC refuses with zero helper work", async () => {
	const f = fixture({ enabled: false });
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteLog)(f.event, projectId)).code, "REMOTE_FEATURE_DISABLED");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteCommitDetail)(f.event, projectId, oid("d"))).code, "REMOTE_FEATURE_DISABLED");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefs)(f.event, projectId)).code, "REMOTE_FEATURE_DISABLED");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId, relativePath: "x.txt" })).code, "REMOTE_FEATURE_DISABLED");
	assert.equal(f.calls.length, 0);
});
