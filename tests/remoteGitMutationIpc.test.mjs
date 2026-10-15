import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const projectId = "project";
const locator = { hostId: "host", remotePath: "/owned/project" };
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff", "git.stage", "git.unstage"] };
function fixture() {
	const handlers = new Map(),
		calls = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (key, work) => handlers.set(key, work) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		hostRevision: 7,
		cancel: async () => undefined,
		request: async (method, params, options) => {
			calls.push({ method, params });
			options?.onRequestId?.("active");
			return method === "hello" ? hello : method === "git.status" ? { status: Buffer.from(" M file.txt\0").toString("base64"), head: "a".repeat(40), branch: "main", revision: "b".repeat(64) } : { applied: true };
		},
	};
	let current = locator;
	const port = registerRemoteGitReadIpc({ enabled: true, locator: () => current, trusted: async () => true, service: () => ({ withProjectSession: async (host, root, task) => ({ ok: true, value: await task(session) }) }) });
	const snapshot = () => handlers.get(ipcChannels.gitRemoteSnapshot)({ sender }, projectId);
	const mutation = (token, event = { sender }, target = { projectId, relativePath: "file.txt" }) => handlers.get(ipcChannels.gitRemoteMutateIndex)(event, projectId, "stage", "workingTree", target, token);
	return {
		handlers,
		calls,
		sender,
		session,
		port,
		snapshot,
		mutation,
		changeTarget: () => {
			current = { ...locator, remotePath: "/other" };
		},
	};
}

test("remote index IPC issues opaque owner-scoped token, hides expectation, consumes once and sends only main-owned revision", async () => {
	const f = fixture();
	const first = await f.snapshot();
	assert.match(first.snapshot.mutationToken, /^[a-f0-9]{32}$/);
	assert.equal(first.snapshot.writeExpectation, undefined);
	const other = new EventEmitter();
	other.id = 2;
	other.isDestroyed = () => false;
	assert.equal((await f.mutation(first.snapshot.mutationToken, { sender: other })).code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	assert.equal((await f.mutation(first.snapshot.mutationToken)).ok, true);
	assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), { method: "git.stage", params: { path: "file.txt", group: "workingTree", expectedRevision: "b".repeat(64) } });
	assert.equal((await f.mutation(first.snapshot.mutationToken)).code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	assert.equal(f.calls.filter((call) => call.method === "git.stage").length, 1);
	f.port.dispose();
	assert.equal(f.sender.listenerCount("destroyed"), 0);
});

test("remote index token rejects locator/host revision changes before dispatching a mutation", async () => {
	for (const kind of ["locator", "hostRevision"]) {
		const f = fixture(),
			first = await f.snapshot();
		if (kind === "locator") f.changeTarget();
		else f.session.hostRevision = 8;
		assert.equal((await f.mutation(first.snapshot.mutationToken)).code, "GIT_TARGET_CHANGED");
		assert.equal(
			f.calls.some((call) => call.method === "git.stage"),
			false,
		);
		f.port.dispose();
	}
});

test("remote index token is revoked on refresh, sender destruction and explicit read cancellation", async () => {
	for (const kind of ["refresh", "destroy", "cancel"]) {
		const f = fixture(),
			first = await f.snapshot();
		if (kind === "refresh") await f.snapshot();
		if (kind === "destroy") f.sender.emit("destroyed");
		if (kind === "cancel") f.handlers.get(ipcChannels.gitRemoteCancelReads)({ sender: f.sender }, projectId);
		assert.equal((await f.mutation(first.snapshot.mutationToken)).code, "GIT_WRITE_SNAPSHOT_EXPIRED");
		assert.equal(
			f.calls.some((call) => call.method === "git.stage"),
			false,
		);
		f.port.dispose();
	}
});

test("remote index transport timeout after dispatch is unconfirmed, never replayed", async () => {
	const f = fixture(),
		first = await f.snapshot(),
		previous = f.session.request;
	f.session.request = async (method, params, options) => {
		if (method === "git.stage") {
			f.calls.push({ method });
			throw new Error("REQUEST_TIMEOUT");
		}
		return previous(method, params, options);
	};
	assert.equal((await f.mutation(first.snapshot.mutationToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal((await f.mutation(first.snapshot.mutationToken)).code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	assert.equal(f.calls.filter((call) => call.method === "git.stage").length, 1);
	f.port.dispose();
});

test("remote index malformed/cross-project targets cannot consume a valid token or supply path authority", async () => {
	const f = fixture(),
		first = await f.snapshot();
	for (const target of [
		{ projectId: "other", relativePath: "file.txt" },
		{ projectId, relativePath: "file.txt", hostId: "other" },
		{ projectId, relativePath: "../outside" },
	])
		assert.equal((await f.mutation(first.snapshot.mutationToken, { sender: f.sender }, target)).ok, false);
	assert.equal((await f.mutation(first.snapshot.mutationToken)).ok, true);
	f.port.dispose();
});
