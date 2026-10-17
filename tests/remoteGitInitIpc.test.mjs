import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { createRemoteGitService } = loadTsCommonJs("src/main/git/RemoteGitService.ts");
const { REMOTE_GIT_READ_TIMEOUT_MS } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.init"] };
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Drive the registered IPC handler through the real remote service: no network, no local Git fallback. */
function fixture(overrides = {}) {
	const handlers = new Map();
	const calls = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		request: async (method, params, options) => {
			calls.push({ method, params, timeoutMs: options?.timeoutMs });
			options?.onRequestId?.("request-id");
			if (method === "hello") return hello;
			if (method === "git.init") return { branch: "master" };
			throw new Error("unexpected method " + method);
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

test("remote init is a write with no token and reports the branch of the created repository", async () => {
	const f = fixture();
	const result = await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, projectId);
	assert.deepEqual(plain(result), { ok: true, branch: "master" });
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello", "git.init"],
	);
	assert.deepEqual(plain(f.calls[1].params), {});
	// No renderer authority travels with the request: only projectId, and the handler takes exactly two arguments.
	assert.equal(f.handlers.get(ipcChannels.gitRemoteInit).length, 2, "handler takes (event, projectId)");
	assert.equal(f.sender.listenerCount("destroyed"), 0);
	// Init is a fast local write: it keeps the read deadline, not the network sync budget.
	assert.equal(f.calls[0].timeoutMs, REMOTE_GIT_READ_TIMEOUT_MS);
	assert.equal(f.calls[1].timeoutMs, REMOTE_GIT_READ_TIMEOUT_MS);
});

test("the service exposes init through the same trust/locator boundary as a read", async () => {
	const f = fixture();
	const service = createRemoteGitService({
		locator: () => locator,
		trusted: async () => true,
		withProject: async (target, task) => task(f.session),
	});
	assert.deepEqual(plain(await service.init(projectId)), { branch: "master" });
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello", "git.init"],
	);
});

test("an unconfirmed repository refusal is passed through as its stable code", async () => {
	const f = fixture();
	f.session.request = async (method) => {
		if (method === "hello") return hello;
		throw new Error("GIT_REPO_EXISTS");
	};
	const result = await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, projectId);
	assert.deepEqual(plain(result), { ok: false, code: "GIT_REPO_EXISTS" });
});

test("trust refusal issues zero helper requests and never enters the host operation", async () => {
	let entered = false;
	const f = fixture({
		trusted: async () => false,
		withProject: async () => {
			entered = true;
		},
	});
	const result = await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, projectId);
	assert.deepEqual(plain(result), { ok: false, code: "GIT_TRUST_REQUIRED" });
	assert.equal(entered, false);
	assert.equal(f.calls.length, 0);
});

test("cross-project and malformed project identities are refused before any session", async () => {
	const f = fixture();
	for (const [id, code] of [
		["other-project", "GIT_TARGET_CHANGED"],
		["", "GIT_RESULT_INVALID"],
		[7, "GIT_RESULT_INVALID"],
		[null, "GIT_RESULT_INVALID"],
		[" remote-project", "GIT_RESULT_INVALID"],
	]) {
		const result = await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, id);
		assert.deepEqual(plain(result), { ok: false, code }, String(id));
	}
	assert.equal(f.calls.length, 0);
	// The locator changing between resolution and dispatch is the same identity refusal.
	const drifted = fixture({ locator: () => undefined });
	assert.deepEqual(plain(await drifted.handlers.get(ipcChannels.gitRemoteInit)(drifted.event, projectId)), { ok: false, code: "GIT_TARGET_CHANGED" });
	assert.equal(drifted.calls.length, 0);
});

test("the helper answer is re-validated: a null branch is allowed, a malformed branch is not trusted", async () => {
	const nullBranch = fixture();
	nullBranch.session.request = async (method) => (method === "hello" ? hello : { branch: null });
	assert.deepEqual(plain(await nullBranch.handlers.get(ipcChannels.gitRemoteInit)(nullBranch.event, projectId)), { ok: true, branch: null });
	for (const value of [{ branch: 5 }, { branch: "" }, { branch: "a\u0000b" }, { branch: "x".repeat(4097) }, { branch: "master", extra: true }, { branch: undefined }, { notBranch: "master" }]) {
		const f = fixture();
		f.session.request = async (method) => (method === "hello" ? hello : value);
		const result = await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, projectId);
		// A malformed answer after dispatch is an unknown result, not a denial: the repository may exist.
		assert.deepEqual(plain(result), { ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" }, JSON.stringify(value).slice(0, 80));
	}
});

test("a helper lacking the init capability is refused with zero Git work", async () => {
	const f = fixture();
	f.session.request = async (method) => {
		f.calls.push({ method });
		return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status"] };
	};
	const result = await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, projectId);
	assert.deepEqual(plain(result), { ok: false, code: "UNSUPPORTED_CAPABILITY" });
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello"],
	);
});

test("an unknown failure after dispatch is unconfirmed and is never retried", async () => {
	const f = fixture();
	let gitInitCalls = 0;
	f.session.request = async (method) => {
		if (method === "hello") return hello;
		gitInitCalls += 1;
		throw new Error("private diagnostic that must never reach IPC");
	};
	const result = await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, projectId);
	assert.deepEqual(plain(result), { ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" });
	assert.equal(gitInitCalls, 1, "a write is never replayed automatically");
});

test("a lost reply after dispatch is unconfirmed, not a denial", async () => {
	const f = fixture();
	let gitInitCalls = 0;
	f.session.request = async (method) => {
		if (method === "hello") return hello;
		gitInitCalls += 1;
		throw new Error("REMOTE_CONNECTION_LOST");
	};
	const result = await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, projectId);
	assert.deepEqual(plain(result), { ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" });
	assert.equal(gitInitCalls, 1);
});

test("a sender that goes away while init runs reports the result as unconfirmed", async () => {
	const f = fixture();
	f.session.request = async (method) => {
		if (method === "hello") return hello;
		f.sender.emit("destroyed");
		return { branch: "master" };
	};
	const result = await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, projectId);
	assert.deepEqual(plain(result), { ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" });
});

test("disabled and disposed remote init refuse with zero helper work", async () => {
	const disabled = fixture({ enabled: false });
	assert.deepEqual(plain(await disabled.handlers.get(ipcChannels.gitRemoteInit)(disabled.event, projectId)), { ok: false, code: "REMOTE_FEATURE_DISABLED" });
	assert.equal(disabled.calls.length, 0);
	const disposed = fixture();
	disposed.port.dispose();
	assert.deepEqual(plain(await disposed.handlers.get(ipcChannels.gitRemoteInit)(disposed.event, projectId)), { ok: false, code: "REQUEST_CANCELLED" });
	assert.equal(disposed.calls.length, 0);
});
