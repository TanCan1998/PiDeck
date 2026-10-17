import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const tokensModule = loadTsCommonJs("src/main/git/RemoteGitMutationTokens.ts");
const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const head = "a".repeat(40);
const revision = "d".repeat(64);
const snapshot = { status: Buffer.from("").toString("base64"), head, branch: "main", revision };
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff", "git.createBranch", "git.switchBranch"] };
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Branch write face over the real IPC handlers: no network, no local Git, one main-owned token per action. */
function fixture(overrides = {}) {
	const handlers = new Map();
	const calls = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		hostRevision: 7,
		request: async (method, params, options) => {
			calls.push({ method, params });
			options?.onRequestId?.("request-id");
			if (method === "hello") return hello;
			if (method === "git.status") return snapshot;
			return { applied: true, branch: params.name, ...(method === "git.switchBranch" ? { head } : {}) };
		},
		cancel: async (id) => calls.push({ method: "cancel", id }),
	};
	const input = {
		enabled: true,
		locator: (id) => (id === projectId ? locator : undefined),
		trusted: async () => true,
		service: async () => ({
			withProjectSession: async (hostId, root, work, options) => ({ ok: true, value: await work(session) }),
		}),
		...overrides,
	};
	const port = registerRemoteGitReadIpc(input);
	const snapshotEvent = { sender };
	const grant = async () => (await handlers.get(ipcChannels.gitRemoteSnapshot)(snapshotEvent, projectId)).snapshot;
	return { port, handlers, calls, sender, session, input, grant, event: snapshotEvent };
}

test("a snapshot grants one branch token and one switch token, and both name the confirmed HEAD", async () => {
	const f = fixture();
	const grants = await f.grant();
	assert.match(grants.branchToken ?? "", /^[0-9a-f]{32}$/);
	assert.match(grants.switchToken ?? "", /^[0-9a-f]{32}$/);
	assert.notEqual(grants.branchToken, grants.switchToken);
	// The renderer sends a name; main adds the HEAD from the grant it issued, never from the caller.
	const created = await f.handlers.get(ipcChannels.gitRemoteCreateBranch)(f.event, projectId, "feature/one", grants.branchToken);
	assert.deepEqual(plain(created), { ok: true });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.createBranch", params: { name: "feature/one", expectedHead: head } });
	const switched = await f.handlers.get(ipcChannels.gitRemoteSwitchBranch)(f.event, projectId, "feature/one", grants.switchToken);
	assert.deepEqual(plain(switched), { ok: true });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.switchBranch", params: { name: "feature/one", expectedHead: head } });
	// A token is single use: the same grant cannot drive a second branch.
	const again = await f.handlers.get(ipcChannels.gitRemoteCreateBranch)(f.event, projectId, "feature/two", grants.branchToken);
	assert.equal(again.code, "GIT_WRITE_SNAPSHOT_EXPIRED");
});

test("a token of the other branch kind is refused without burning the token its owner still holds", async () => {
	const f = fixture();
	const grants = await f.grant();
	const crossed = await f.handlers.get(ipcChannels.gitRemoteCreateBranch)(f.event, projectId, "feature/one", grants.switchToken);
	assert.equal(crossed.code, "GIT_RESULT_INVALID");
	// The crossed token was not consumed, so the action it really authorizes still works.
	const switched = await f.handlers.get(ipcChannels.gitRemoteSwitchBranch)(f.event, projectId, "feature/one", grants.switchToken);
	assert.deepEqual(plain(switched), { ok: true });
	const forged = await f.handlers.get(ipcChannels.gitRemoteCreateBranch)(f.event, projectId, "feature/two", "b".repeat(32));
	assert.equal(forged.code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	const missing = await f.handlers.get(ipcChannels.gitRemoteSwitchBranch)(f.event, projectId, "feature/two", undefined);
	assert.equal(missing.code, "GIT_WRITE_SNAPSHOT_EXPIRED");
});

test("a name that is not a plain local branch name is refused before any helper session exists", async () => {
	const f = fixture();
	const grants = await f.grant();
	const calls = f.calls.length;
	for (const name of ["", "@", "-feature", "refs/heads/x", "FETCH_HEAD", "a@{b}", "a\\b", "line\nbreak", "tab\tname", "x".repeat(1025), head]) {
		for (const channel of [ipcChannels.gitRemoteCreateBranch, ipcChannels.gitRemoteSwitchBranch]) {
			const token = channel === ipcChannels.gitRemoteCreateBranch ? (await f.grant()).branchToken : (await f.grant()).switchToken;
			const result = await f.handlers.get(channel)(f.event, projectId, name, token);
			assert.equal(result.code, "GIT_RESULT_INVALID", `${channel} ${JSON.stringify(name)}`);
		}
	}
	for (const value of [null, 42, {}, ["name"]]) {
		const token = (await f.grant()).branchToken;
		assert.equal((await f.handlers.get(ipcChannels.gitRemoteCreateBranch)(f.event, projectId, value, token)).code, "GIT_RESULT_INVALID");
	}
	assert.equal(f.calls.filter((call) => call.method === "git.createBranch" || call.method === "git.switchBranch").length, 0, "a refused name opens no helper request");
});

test("the helper's own refusals and an answer that does not match the request reach the caller as codes", async () => {
	const f = fixture();
	f.session.request = async (method, params) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		if (method === "git.createBranch") throw new Error("GIT_REF_EXISTS");
		if (method === "git.switchBranch") throw new Error("GIT_SWITCH_CONFLICT");
		return {};
	};
	const grants = await f.grant();
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteCreateBranch)(f.event, projectId, "feature", grants.branchToken)).code, "GIT_REF_EXISTS");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteSwitchBranch)(f.event, projectId, "feature", grants.switchToken)).code, "GIT_SWITCH_CONFLICT");
	// An answer for another branch, or one carrying extra authority, is never a success; both happen after the write
	// was dispatched, so the honest answer is "unknown", not a refusal that pretends nothing could have happened.
	const swapped = fixture();
	swapped.session.request = async (method, params) => (method === "hello" ? hello : method === "git.status" ? snapshot : { applied: true, branch: "other" });
	const swappedGrants = await swapped.grant();
	assert.equal((await swapped.handlers.get(ipcChannels.gitRemoteCreateBranch)(swapped.event, projectId, "feature", swappedGrants.branchToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
	const verbose = fixture();
	verbose.session.request = async (method, params) => (method === "hello" ? hello : method === "git.status" ? snapshot : { applied: true, branch: params.name, extra: 1 });
	const verboseGrants = await verbose.grant();
	assert.equal((await verbose.handlers.get(ipcChannels.gitRemoteCreateBranch)(verbose.event, projectId, "feature", verboseGrants.branchToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
	// A lost reply after the write was dispatched is unknown, never a refusal that pretends nothing happened.
	const lost = fixture();
	lost.session.request = async (method) => {
		if (method === "hello") return hello;
		if (method === "git.status") return snapshot;
		throw new Error("socket closed");
	};
	const lostGrants = await lost.grant();
	assert.equal((await lost.handlers.get(ipcChannels.gitRemoteCreateBranch)(lost.event, projectId, "feature", lostGrants.branchToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
});

test("a cross-project call, a disabled feature and a disposed port never reach the helper", async () => {
	const cross = fixture();
	const crossGrants = await cross.grant();
	const crossCalls = cross.calls.length;
	// The grant is bound to one project, so a call naming another one cannot spend it at all.
	assert.equal((await cross.handlers.get(ipcChannels.gitRemoteCreateBranch)(cross.event, "other-project", "feature", crossGrants.branchToken)).code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	assert.equal(cross.calls.length, crossCalls);
	const disabled = fixture({ enabled: false });
	assert.equal((await disabled.handlers.get(ipcChannels.gitRemoteCreateBranch)(disabled.event, projectId, "feature", "a".repeat(32))).code, "REMOTE_FEATURE_DISABLED");
	assert.equal((await disabled.handlers.get(ipcChannels.gitRemoteSwitchBranch)(disabled.event, projectId, "feature", "a".repeat(32))).code, "REMOTE_FEATURE_DISABLED");
	assert.equal(disabled.calls.length, 0);
	const disposed = fixture();
	const disposedGrants = await disposed.grant();
	disposed.port.dispose();
	assert.equal((await disposed.handlers.get(ipcChannels.gitRemoteCreateBranch)(disposed.event, projectId, "feature", disposedGrants.branchToken)).code, "REQUEST_CANCELLED");
});

test("issuing a branch grant twice replaces only that kind, leaving the other actions usable", () => {
	const tokens = tokensModule.createRemoteGitMutationTokens();
	const base = { revision, hostRevision: 1, target: locator, head, repoPath: "" };
	const first = tokens.issue(1, projectId, { kind: "branch", ...base });
	const second = tokens.issue(1, projectId, { kind: "branch", ...base });
	const switcher = tokens.issue(1, projectId, { kind: "switch", ...base });
	const index = tokens.issue(1, projectId, { kind: "index", ...base });
	assert.throws(() => tokens.take(1, projectId, "branch", "", first), /GIT_WRITE_SNAPSHOT_EXPIRED/, "the replaced grant of the same kind is gone");
	assert.equal(tokens.take(1, projectId, "branch", "", second).kind, "branch");
	assert.equal(tokens.take(1, projectId, "switch", "", switcher).kind, "switch");
	assert.equal(tokens.take(1, projectId, "index", "", index).kind, "index");
	// Another window cannot burn this window's branch grant.
	const foreign = tokens.issue(1, projectId, { kind: "branch", ...base });
	assert.throws(() => tokens.take(2, projectId, "branch", "", foreign), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	assert.equal(tokens.take(1, projectId, "branch", "", foreign).kind, "branch");
});
