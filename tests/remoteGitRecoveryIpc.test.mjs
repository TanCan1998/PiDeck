import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const head = "a".repeat(40);
const revision = "d".repeat(64);
const oid = "b".repeat(40);
const ref = "refs/pideck/recovery/20261016120000-ab12cd34";
const snapshot = { status: Buffer.from("").toString("base64"), head, branch: "main", revision };
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff", "git.recoveryList", "git.recoveryRestore", "git.recoveryDrop"] };
const entry = { ref, oid, path: "sub/dir/file.txt", bytes: 42, at: 1792138005 };
const plain = (value) => JSON.parse(JSON.stringify(value));

/** G4b recovery IPC: a read-only listing plus two writes, each with its own single-use grant. */
function fixture(overrides = {}) {
	const handlers = new Map();
	const calls = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		hostRevision: 5,
		request: async (method, params, options) => {
			calls.push({ method, params });
			options?.onRequestId?.("request-id");
			if (method === "hello") return hello;
			if (method === "git.status") return snapshot;
			if (method === "git.recoveryList") return { entries: [entry], truncated: false };
			if (method === "git.recoveryRestore") return { applied: true, path: params.path, bytes: 42 };
			return { applied: true };
		},
		cancel: async (id) => calls.push({ method: "cancel", id }),
	};
	const input = { enabled: true, locator: (id) => (id === projectId ? locator : undefined), trusted: async () => true, service: async () => ({ withProjectSession: async (hostId, root, work) => ({ ok: true, value: await work(session) }) }), ...overrides };
	const port = registerRemoteGitReadIpc(input);
	const event = { sender };
	const grant = async () => (await handlers.get(ipcChannels.gitRemoteSnapshot)(event, projectId)).snapshot;
	return { port, handlers, calls, sender, session, grant, event };
}

test("a snapshot grants one restore token and one drop token, and the listing needs neither", async () => {
	const f = fixture();
	const grants = await f.grant();
	assert.match(grants.restoreToken ?? "", /^[0-9a-f]{32}$/);
	assert.match(grants.dropToken ?? "", /^[0-9a-f]{32}$/);
	assert.notEqual(grants.restoreToken, grants.dropToken);
	const listed = await f.handlers.get(ipcChannels.gitRemoteRecoveryList)(f.event, projectId);
	assert.deepEqual(plain(listed), { ok: true, entries: [entry], truncated: false });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.recoveryList", params: {} });
	const restored = await f.handlers.get(ipcChannels.gitRemoteRecoveryRestore)(f.event, projectId, ref, oid, entry.path, grants.restoreToken);
	assert.deepEqual(plain(restored), { ok: true, path: entry.path, bytes: 42 });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.recoveryRestore", params: { ref, oid, path: entry.path, expectedRevision: revision } });
	const second = await f.handlers.get(ipcChannels.gitRemoteRecoveryRestore)(f.event, projectId, ref, oid, entry.path, grants.restoreToken);
	assert.equal(second.code, "GIT_WRITE_SNAPSHOT_EXPIRED", "a grant is single use");
	const dropped = await f.handlers.get(ipcChannels.gitRemoteRecoveryDrop)(f.event, projectId, ref, oid, grants.dropToken);
	assert.deepEqual(plain(dropped), { ok: true });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.recoveryDrop", params: { ref, oid, expectedRevision: revision } });
});

test("a recovery action handed the other action's token is refused without burning it", async () => {
	const f = fixture();
	const grants = await f.grant();
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRecoveryRestore)(f.event, projectId, ref, oid, entry.path, grants.dropToken)).code, "GIT_RESULT_INVALID");
	// The drop grant still works after the crossed attempt.
	assert.deepEqual(plain(await f.handlers.get(ipcChannels.gitRemoteRecoveryDrop)(f.event, projectId, ref, oid, grants.dropToken)), { ok: true });
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRecoveryDrop)(f.event, projectId, ref, oid, "c".repeat(32))).code, "GIT_WRITE_SNAPSHOT_EXPIRED");
});

test("a ref outside the recovery namespace, a malformed oid or an escaping path never reaches the helper", async () => {
	const f = fixture();
	for (const bad of ["refs/heads/main", "HEAD", "refs/pideck/recovery/", "refs/pideck/recovery/x y", 42, null]) {
		const token = (await f.grant()).restoreToken;
		assert.equal((await f.handlers.get(ipcChannels.gitRemoteRecoveryRestore)(f.event, projectId, bad, oid, entry.path, token)).code, "GIT_RESULT_INVALID", String(bad));
		const dropToken = (await f.grant()).dropToken;
		assert.equal((await f.handlers.get(ipcChannels.gitRemoteRecoveryDrop)(f.event, projectId, bad, oid, dropToken)).code, "GIT_RESULT_INVALID", String(bad));
	}
	for (const badOid of ["zz", "b".repeat(39), "B".repeat(40), null]) {
		const token = (await f.grant()).restoreToken;
		assert.equal((await f.handlers.get(ipcChannels.gitRemoteRecoveryRestore)(f.event, projectId, ref, badOid, entry.path, token)).code, "GIT_RESULT_INVALID", String(badOid));
	}
	const escaping = (await f.grant()).restoreToken;
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRecoveryRestore)(f.event, projectId, ref, oid, "../outside.txt", escaping)).code, "PATH_OUTSIDE_ROOT");
	assert.equal(f.calls.filter((call) => call.method.startsWith("git.recovery")).length, 0, "a refused call opens no helper request");
});

test("the listing and the writes re-validate what the helper answers", async () => {
	const listing = fixture();
	listing.session.request = async (method) => (method === "hello" ? hello : method === "git.status" ? snapshot : { entries: [{ ...entry, ref: "refs/heads/main" }], truncated: false });
	const listingGrant = await listing.grant();
	assert.equal((await listing.handlers.get(ipcChannels.gitRemoteRecoveryList)(listing.event, projectId)).code, "GIT_RESULT_INVALID");
	assert.ok(listingGrant.restoreToken, "the snapshot grant is unaffected by a bad listing");

	const shape = fixture();
	shape.session.request = async (method, params) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		if (method === "git.recoveryList") return { entries: [{ ...entry, bytes: -1, at: 1.5 }], truncated: false };
		return { applied: true, path: params.path, bytes: 42 };
	};
	const shapeGrant = await shape.grant();
	assert.equal((await shape.handlers.get(ipcChannels.gitRemoteRecoveryList)(shape.event, projectId)).code, "GIT_RESULT_INVALID");

	// A write that was dispatched but answered with a different path is unknown, never a success.
	const swapped = fixture();
	swapped.session.request = async (method) => (method === "hello" ? hello : method === "git.status" ? snapshot : method === "git.recoveryList" ? { entries: [entry], truncated: false } : { applied: true, path: "elsewhere.txt", bytes: 42 });
	const swappedGrant = await swapped.grant();
	assert.equal((await swapped.handlers.get(ipcChannels.gitRemoteRecoveryRestore)(swapped.event, projectId, ref, oid, entry.path, swappedGrant.restoreToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
	const verbose = fixture();
	verbose.session.request = async (method) => (method === "hello" ? hello : method === "git.status" ? snapshot : method === "git.recoveryList" ? { entries: [entry], truncated: false } : { applied: true, extra: 1 });
	const verboseGrant = await verbose.grant();
	assert.equal((await verbose.handlers.get(ipcChannels.gitRemoteRecoveryDrop)(verbose.event, projectId, ref, oid, verboseGrant.dropToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
});

test("the helper's own refusals pass through and a lost reply is unknown", async () => {
	const conflicts = fixture();
	conflicts.session.request = async (method) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		throw new Error("GIT_RESTORE_CONFLICT");
	};
	const conflictGrant = await conflicts.grant();
	assert.equal((await conflicts.handlers.get(ipcChannels.gitRemoteRecoveryRestore)(conflicts.event, projectId, ref, oid, entry.path, conflictGrant.restoreToken)).code, "GIT_RESTORE_CONFLICT");
	const missing = fixture();
	missing.session.request = async (method) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		throw new Error("GIT_RECOVERY_ENTRY_NOT_FOUND");
	};
	const missingGrant = await missing.grant();
	assert.equal((await missing.handlers.get(ipcChannels.gitRemoteRecoveryDrop)(missing.event, projectId, ref, oid, missingGrant.dropToken)).code, "GIT_RECOVERY_ENTRY_NOT_FOUND");
	const lost = fixture();
	lost.session.request = async (method) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		throw new Error("socket closed");
	};
	const lostGrant = await lost.grant();
	assert.equal((await lost.handlers.get(ipcChannels.gitRemoteRecoveryRestore)(lost.event, projectId, ref, oid, entry.path, lostGrant.restoreToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
});

test("a disabled feature and a disposed port never reach the helper", async () => {
	const disabled = fixture({ enabled: false });
	assert.equal((await disabled.handlers.get(ipcChannels.gitRemoteRecoveryList)(disabled.event, projectId)).code, "REMOTE_FEATURE_DISABLED");
	assert.equal((await disabled.handlers.get(ipcChannels.gitRemoteRecoveryRestore)(disabled.event, projectId, ref, oid, entry.path, "a".repeat(32))).code, "REMOTE_FEATURE_DISABLED");
	assert.equal(disabled.calls.length, 0);
	const disposed = fixture();
	const grants = await disposed.grant();
	disposed.port.dispose();
	assert.equal((await disposed.handlers.get(ipcChannels.gitRemoteRecoveryDrop)(disposed.event, projectId, ref, oid, grants.dropToken)).code, "REQUEST_CANCELLED");
});
