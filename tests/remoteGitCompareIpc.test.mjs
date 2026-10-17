import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const oid = (char) => char.repeat(40);
const baseRef = "refs/heads/main";
const headRef = "refs/tags/v2.0";
const compareValue = {
	base: { ref: baseRef, oid: oid("a") },
	head: { ref: headRef, oid: oid("b") },
	files: [
		{ status: "M", path: "tracked.txt" },
		{ status: "R100", path: "renamed.txt", oldPath: "old.txt" },
		{ status: "A", path: "added.txt" },
	],
};
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.refs", "git.refFileDiff", "git.compare"] };
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Drive the registered IPC handler through the real remote service, no network and no local Git fallback. */
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
			if (method === "git.compare") return compareValue;
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

test("remote compare IPC is a read with no token and answers the bounded file list", async () => {
	const f = fixture();
	const result = await f.handlers.get(ipcChannels.gitRemoteCompare)(f.event, projectId, baseRef, headRef);
	assert.equal(result.ok, true);
	assert.deepEqual(plain(result.compare), compareValue);
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello", "git.compare"],
	);
	assert.deepEqual(plain(f.calls[1].params), { base: baseRef, head: headRef });
	// The handler signature carries no token: a renderer cannot spend one on a read.
	const parameters = f.handlers.get(ipcChannels.gitRemoteCompare).length;
	assert.equal(parameters, 5, "handler takes (event, projectId, base, head, repo)");
	assert.equal(f.sender.listenerCount("destroyed"), 0);
});

test("invalid, option-like and cross-namespace refs are refused before any SSH session is opened", async () => {
	const f = fixture();
	const cases = [
		["refs/heads/-x", headRef],
		["refs/heads/@", headRef],
		["HEAD", headRef],
		[baseRef, "HEAD"],
		[oid("c"), headRef],
		["refs/remotes/origin/main", headRef],
		["refs/heads/x..y", headRef],
		["refs/tags/v1.0{}", headRef],
		["refs/heads/a b", headRef],
		["refs/heads/", headRef],
		[baseRef, undefined],
		[null, headRef],
		[baseRef, 7],
		["refs/heads/" + "x".repeat(1100), headRef],
	];
	for (const [base, head] of cases) {
		const result = await f.handlers.get(ipcChannels.gitRemoteCompare)(f.event, projectId, base, head);
		assert.equal(result.ok, false, String(base).slice(0, 40));
		assert.equal(result.code, "GIT_RESULT_INVALID", String(base).slice(0, 40));
	}
	assert.equal(f.calls.length, 0, "an unusable ref pair must not open a helper session");
});

test("compare IPC re-validates the helper answer instead of trusting the remote", async () => {
	const cases = [
		{ ...compareValue, base: { ref: "refs/heads/other", oid: oid("a") } },
		{ ...compareValue, base: { ref: baseRef, oid: "not-a-hash" } },
		{ ...compareValue, files: [{ status: "A", path: "x.txt" }], extra: true },
		{ ...compareValue, files: [{ status: "R100", path: "renamed.txt" }] },
		{ ...compareValue, files: [{ status: "M", path: "tracked.txt", oldPath: "old.txt" }] },
		{ ...compareValue, files: [{ status: "M", path: "a\u0000b" }], expected: "PATH_OUTSIDE_ROOT" },
		{ ...compareValue, files: [{ status: "M", path: "../escape.txt" }], expected: "PATH_OUTSIDE_ROOT" },
		{ ...compareValue, files: [{ status: "M", path: "-option.txt" }], expected: "PATH_OUTSIDE_ROOT" },
		{ ...compareValue, files: [{ status: "Z", path: "tracked.txt" }] },
		{ ...compareValue, files: Array.from({ length: 4097 }, (_, index) => ({ status: "A", path: "f" + index + ".txt" })) },
	];
	for (const candidate of cases) {
		// `expected` is the test's own expectation label; the helper answer must only ever carry base/head/files.
		const { expected, ...value } = candidate;
		const f = fixture();
		f.session.request = async (method) => (method === "hello" ? hello : value);
		const result = await f.handlers.get(ipcChannels.gitRemoteCompare)(f.event, projectId, baseRef, headRef);
		assert.equal(result.ok, false, JSON.stringify(value).slice(0, 120));
		// A malformed path is refused by the shared path validator (PATH_OUTSIDE_ROOT), like every other remote read.
		assert.equal(result.code, expected ?? "GIT_RESULT_INVALID");
	}
});

test("disabled and disposed remote compare refuse with zero helper work", async () => {
	const disabled = fixture({ enabled: false });
	const refused = await disabled.handlers.get(ipcChannels.gitRemoteCompare)(disabled.event, projectId, baseRef, headRef);
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "REMOTE_FEATURE_DISABLED");
	assert.equal(disabled.calls.length, 0);
	const disposed = fixture();
	disposed.port.dispose();
	const after = await disposed.handlers.get(ipcChannels.gitRemoteCompare)(disposed.event, projectId, baseRef, headRef);
	assert.equal(after.ok, false);
	assert.equal(after.code, "REQUEST_CANCELLED");
	assert.equal(disposed.calls.length, 0);
});

test("a compare whose helper answer is lost is reported, never retried", async () => {
	const f = fixture();
	let replies = 0;
	f.session.request = async (method) => {
		if (method === "hello") return hello;
		replies += 1;
		throw new Error("REMOTE_CONNECTION_LOST");
	};
	const result = await f.handlers.get(ipcChannels.gitRemoteCompare)(f.event, projectId, baseRef, headRef);
	assert.equal(result.ok, false);
	assert.equal(result.code, "REMOTE_CONNECTION_LOST");
	assert.equal(replies, 1, "a read is never replayed automatically");
});
