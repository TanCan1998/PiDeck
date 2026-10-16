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
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff", "git.syncFacts", "git.fetch", "git.push", "git.pull"] };
const facts = { branch: "main", upstream: "refs/remotes/origin/main", ahead: 1, behind: 2, remotes: ["origin"] };
const plain = (value) => JSON.parse(JSON.stringify(value));

/** G5a sync IPC: facts are read-only, each network verb needs its own grant, and a URL never crosses the boundary. */
function fixture(overrides = {}) {
	const handlers = new Map();
	const calls = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		hostRevision: 9,
		request: async (method, params, options) => {
			calls.push({ method, params });
			options?.onRequestId?.("request-id");
			if (method === "hello") return hello;
			if (method === "git.status") return snapshot;
			if (method === "git.syncFacts") return facts;
			if (method === "git.fetch") return { applied: true, upToDate: false, updated: [{ ref: "refs/remotes/origin/main", before: null, after: head }] };
			if (method === "git.push") return { applied: true, outcome: "pushed", refspec: "refs/heads/main:refs/heads/main" };
			return { applied: true, mode: "fast-forward", head };
		},
		cancel: async (id) => calls.push({ method: "cancel", id }),
	};
	const input = { enabled: true, locator: (id) => (id === projectId ? locator : undefined), trusted: async () => true, service: async () => ({ withProjectSession: async (hostId, root, work) => ({ ok: true, value: await work(session) }) }), ...overrides };
	const port = registerRemoteGitReadIpc(input);
	const event = { sender };
	const grant = async () => (await handlers.get(ipcChannels.gitRemoteSnapshot)(event, projectId)).snapshot;
	return { port, handlers, calls, sender, session, grant, event };
}

test("one token per verb, read-only facts, and a URL never crosses the boundary", async () => {
	const f = fixture();
	const grants = await f.grant();
	for (const key of ["fetchToken", "pushToken", "pullToken"]) assert.match(grants[key] ?? "", /^[0-9a-f]{32}$/, key);
	assert.notEqual(grants.fetchToken, grants.pushToken);
	const listed = await f.handlers.get(ipcChannels.gitRemoteSyncFacts)(f.event, projectId);
	assert.deepEqual(plain(listed), { ok: true, facts });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.syncFacts", params: {} });
	// One verb's grant is not another verb's, and a crossed attempt does not burn the grant it belongs to.
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteFetch)(f.event, projectId, "origin", grants.pushToken)).code, "GIT_RESULT_INVALID");
	const fetched = await f.handlers.get(ipcChannels.gitRemoteFetch)(f.event, projectId, "origin", grants.fetchToken);
	assert.deepEqual(plain(fetched.outcome), { upToDate: false, updated: [{ ref: "refs/remotes/origin/main", before: null, after: head }] });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.fetch", params: { remote: "origin", expectedRevision: revision } });
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteFetch)(f.event, projectId, "origin", grants.fetchToken)).code, "GIT_WRITE_SNAPSHOT_EXPIRED", "a grant is single use");
	// The other grants are untouched and still work.
	assert.deepEqual(plain((await f.handlers.get(ipcChannels.gitRemotePush)(f.event, projectId, "origin", "main", grants.pushToken)).outcome), { outcome: "pushed", refspec: "refs/heads/main:refs/heads/main" });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.push", params: { remote: "origin", branch: "main", expectedRevision: revision } });
	assert.deepEqual(plain((await f.handlers.get(ipcChannels.gitRemotePull)(f.event, projectId, "origin", "main", grants.pullToken)).outcome), { mode: "fast-forward", head });
});

test("a URL-shaped remote, a flag-shaped remote or branch and an unscoped branch never reach the helper", async () => {
	const f = fixture();
	for (const remote of ["https://user:token@example.invalid/repo.git", "--force", "origin/../evil", "origin extra", "", 42, null]) {
		const token = (await f.grant()).fetchToken;
		assert.equal((await f.handlers.get(ipcChannels.gitRemoteFetch)(f.event, projectId, remote, token)).code, "GIT_RESULT_INVALID", String(remote));
	}
	for (const branch of ["-x", "refs/heads/main", "@", "a b", "a..b"]) {
		const token = (await f.grant()).pushToken;
		assert.equal((await f.handlers.get(ipcChannels.gitRemotePush)(f.event, projectId, "origin", branch, token)).code, "GIT_RESULT_INVALID", branch);
	}
	assert.equal(f.calls.filter((call) => call.method === "git.fetch" || call.method === "git.push").length, 0, "a refused parameter opens no helper request");
});

test("helper refusals pass through, a substituted answer is unknown, and a lost reply is never a success", async () => {
	const refused = fixture();
	refused.session.request = async (method) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		if (method === "git.syncFacts") return facts;
		if (method === "git.push") throw new Error("GIT_PUSH_REJECTED");
		if (method === "git.pull") throw new Error("GIT_PULL_CONFLICTS");
		throw new Error("GIT_SYNC_DIRTY");
	};
	const first = await refused.grant();
	assert.equal((await refused.handlers.get(ipcChannels.gitRemotePush)(refused.event, projectId, "origin", "main", first.pushToken)).code, "GIT_PUSH_REJECTED");
	const second = await refused.grant();
	assert.equal((await refused.handlers.get(ipcChannels.gitRemotePull)(refused.event, projectId, "origin", "main", second.pullToken)).code, "GIT_PULL_CONFLICTS");
	const third = await refused.grant();
	assert.equal((await refused.handlers.get(ipcChannels.gitRemoteFetch)(refused.event, projectId, "origin", third.fetchToken)).code, "GIT_SYNC_DIRTY");
	// The helper's own words are re-validated: another refspec or an unknown pull mode is not a success.
	const swapped = fixture();
	swapped.session.request = async (method) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		if (method === "git.syncFacts") return facts;
		if (method === "git.push") return { applied: true, outcome: "pushed", refspec: "refs/heads/other:refs/heads/other" };
		return { applied: true, mode: "rebase", head };
	};
	const swappedGrant = await swapped.grant();
	assert.equal((await swapped.handlers.get(ipcChannels.gitRemotePush)(swapped.event, projectId, "origin", "main", swappedGrant.pushToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
	const modeGrant = await swapped.grant();
	assert.equal((await swapped.handlers.get(ipcChannels.gitRemotePull)(swapped.event, projectId, "origin", "main", modeGrant.pullToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
	const lost = fixture();
	lost.session.request = async (method) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		if (method === "git.syncFacts") return facts;
		throw new Error("socket closed");
	};
	const lostGrant = await lost.grant();
	assert.equal((await lost.handlers.get(ipcChannels.gitRemoteFetch)(lost.event, projectId, "origin", lostGrant.fetchToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
});

test("a disabled feature and a disposed port never reach the helper", async () => {
	const disabled = fixture({ enabled: false });
	assert.equal((await disabled.handlers.get(ipcChannels.gitRemoteSyncFacts)(disabled.event, projectId)).code, "REMOTE_FEATURE_DISABLED");
	assert.equal((await disabled.handlers.get(ipcChannels.gitRemoteFetch)(disabled.event, projectId, "origin", "a".repeat(32))).code, "REMOTE_FEATURE_DISABLED");
	assert.equal(disabled.calls.length, 0);
	const disposed = fixture();
	const grants = await disposed.grant();
	disposed.port.dispose();
	assert.equal((await disposed.handlers.get(ipcChannels.gitRemotePull)(disposed.event, projectId, "origin", "main", grants.pullToken)).code, "REQUEST_CANCELLED");
});
