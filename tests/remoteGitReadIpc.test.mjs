import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const snapshot = { status: Buffer.from(" M tracked.txt\0").toString("base64"), head: "a".repeat(40), branch: "main" };
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff"] };
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
			return method === "hello" ? hello : method === "git.status" ? snapshot : { originalContent: "base\n", modifiedContent: "working\n" };
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
