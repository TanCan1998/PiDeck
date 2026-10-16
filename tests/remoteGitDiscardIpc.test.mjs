import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const head = "a".repeat(40);
const revision = "d".repeat(64);
const snapshot = { status: Buffer.from("").toString("base64"), head, branch: "main", revision };
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff", "git.createBranch", "git.switchBranch", "git.discard"] };
const plain = (value) => JSON.parse(JSON.stringify(value));

/** G4a discard over the real IPC handlers: one main-owned grant, one project, one path. */
function fixture(overrides = {}) {
	const handlers = new Map();
	const calls = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		hostRevision: 3,
		request: async (method, params, options) => {
			calls.push({ method, params });
			options?.onRequestId?.("request-id");
			if (method === "hello") return hello;
			if (method === "git.status") return snapshot;
			if (method === "git.createBranch") return { applied: true, branch: params.name };
			return { applied: true, recoveryRef: "refs/pideck/recovery/20261016120000-ab12cd34", path: params.path, mode: params.group === "untracked" ? "removed" : "restored" };
		},
		cancel: async (id) => calls.push({ method: "cancel", id }),
	};
	const input = { enabled: true, locator: (id) => (id === projectId ? locator : undefined), trusted: async () => true, service: async () => ({ withProjectSession: async (hostId, root, work) => ({ ok: true, value: await work(session) }) }), ...overrides };
	const port = registerRemoteGitReadIpc(input);
	const event = { sender };
	const grant = async () => (await handlers.get(ipcChannels.gitRemoteSnapshot)(event, projectId)).snapshot;
	return { port, handlers, calls, sender, session, grant, event };
}

test("a snapshot grants one discard token, and the discard names the path with main's confirmed revision", async () => {
	const f = fixture();
	const grants = await f.grant();
	assert.match(grants.discardToken ?? "", /^[0-9a-f]{32}$/);
	assert.notEqual(grants.discardToken, grants.branchToken);
	const result = await f.handlers.get(ipcChannels.gitRemoteDiscard)(f.event, projectId, "workingTree", { projectId, relativePath: "sub/dir/file.txt" }, grants.discardToken);
	assert.deepEqual(plain(result), { ok: true, recoveryRef: "refs/pideck/recovery/20261016120000-ab12cd34" });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.discard", params: { path: "sub/dir/file.txt", group: "workingTree", expectedRevision: revision } });
	const again = await f.handlers.get(ipcChannels.gitRemoteDiscard)(f.event, projectId, "untracked", { projectId, relativePath: "note.txt" }, grants.discardToken);
	assert.equal(again.code, "GIT_WRITE_SNAPSHOT_EXPIRED", "a grant is single use");
});

test("a discard handed another action's token is refused without burning it", async () => {
	const f = fixture();
	const grants = await f.grant();
	const crossed = await f.handlers.get(ipcChannels.gitRemoteDiscard)(f.event, projectId, "workingTree", { projectId, relativePath: "a.txt" }, grants.branchToken);
	assert.equal(crossed.code, "GIT_RESULT_INVALID");
	// The branch grant still works after the crossed attempt.
	const created = await f.handlers.get(ipcChannels.gitRemoteCreateBranch)(f.event, projectId, "kept", grants.branchToken);
	assert.deepEqual(plain(created), { ok: true });
	const forged = await f.handlers.get(ipcChannels.gitRemoteDiscard)(f.event, projectId, "workingTree", { projectId, relativePath: "a.txt" }, "b".repeat(32));
	assert.equal(forged.code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteDiscard)(f.event, projectId, "workingTree", { projectId, relativePath: "a.txt" }, undefined)).code, "GIT_WRITE_SNAPSHOT_EXPIRED");
});

test("parameters a discard must never accept are refused before any helper session exists", async () => {
	const f = fixture();
	for (const group of ["index", "merge", "nope", null, 7]) {
		const token = (await f.grant()).discardToken;
		assert.equal((await f.handlers.get(ipcChannels.gitRemoteDiscard)(f.event, projectId, group, { projectId, relativePath: "a.txt" }, token)).code, "GIT_RESULT_INVALID", String(group));
	}
	const crossProject = (await f.grant()).discardToken;
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteDiscard)(f.event, projectId, "workingTree", { projectId: "other", relativePath: "a.txt" }, crossProject)).code, "GIT_RESULT_INVALID");
	const extra = (await f.grant()).discardToken;
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteDiscard)(f.event, projectId, "workingTree", { projectId, relativePath: "a.txt", extra: 1 }, extra)).code, "GIT_RESULT_INVALID");
	const escape = (await f.grant()).discardToken;
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteDiscard)(f.event, projectId, "workingTree", { projectId, relativePath: "../outside.txt" }, escape)).code, "PATH_OUTSIDE_ROOT");
	assert.equal(f.calls.filter((call) => call.method === "git.discard").length, 0, "a refused discard opens no helper request");
});

test("the helper's own refusals reach the caller, and an answer that is not ours never becomes a success", async () => {
	const refuse = fixture();
	refuse.session.request = async (method, params) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		throw new Error(params.group === "untracked" ? "RESULT_TOO_LARGE" : "GIT_WRITE_UNSUPPORTED");
	};
	const first = await refuse.grant();
	assert.equal((await refuse.handlers.get(ipcChannels.gitRemoteDiscard)(refuse.event, projectId, "workingTree", { projectId, relativePath: "big" }, first.discardToken)).code, "GIT_WRITE_UNSUPPORTED");
	const second = await refuse.grant();
	assert.equal((await refuse.handlers.get(ipcChannels.gitRemoteDiscard)(refuse.event, projectId, "untracked", { projectId, relativePath: "big" }, second.discardToken)).code, "RESULT_TOO_LARGE");

	// A foreign ref name is not a recovery ref: the write already happened, so the honest answer is "unknown".
	const foreign = fixture();
	foreign.session.request = async (method, params) => (method === "hello" ? hello : method === "git.status" ? snapshot : { applied: true, recoveryRef: "refs/heads/main", path: params.path, mode: "restored" });
	// (the stub answers only the discard shape; the branch channels are not exercised in this case)
	const foreignGrant = await foreign.grant();
	assert.equal((await foreign.handlers.get(ipcChannels.gitRemoteDiscard)(foreign.event, projectId, "workingTree", { projectId, relativePath: "a.txt" }, foreignGrant.discardToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
	// A deletion has nothing to snapshot, and that null travels through unchanged.
	const deleted = fixture();
	deleted.session.request = async (method, params) => (method === "hello" ? hello : method === "git.status" ? snapshot : { applied: true, recoveryRef: null, path: params.path, mode: "restored" });
	const deletedGrant = await deleted.grant();
	assert.deepEqual(plain(await deleted.handlers.get(ipcChannels.gitRemoteDiscard)(deleted.event, projectId, "workingTree", { projectId, relativePath: "a.txt" }, deletedGrant.discardToken)), { ok: true, recoveryRef: null });
	// A lost reply after the write was dispatched is unknown, never a refusal that pretends nothing happened.
	const lost = fixture();
	lost.session.request = async (method) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		throw new Error("socket closed");
	};
	const lostGrant = await lost.grant();
	assert.equal((await lost.handlers.get(ipcChannels.gitRemoteDiscard)(lost.event, projectId, "workingTree", { projectId, relativePath: "a.txt" }, lostGrant.discardToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
});

test("a disabled feature and a disposed port never reach the helper", async () => {
	const disabled = fixture({ enabled: false });
	assert.equal((await disabled.handlers.get(ipcChannels.gitRemoteDiscard)(disabled.event, projectId, "workingTree", { projectId, relativePath: "a.txt" }, "a".repeat(32))).code, "REMOTE_FEATURE_DISABLED");
	assert.equal(disabled.calls.length, 0);
	const disposed = fixture();
	const grants = await disposed.grant();
	disposed.port.dispose();
	assert.equal((await disposed.handlers.get(ipcChannels.gitRemoteDiscard)(disposed.event, projectId, "workingTree", { projectId, relativePath: "a.txt" }, grants.discardToken)).code, "REQUEST_CANCELLED");
});
