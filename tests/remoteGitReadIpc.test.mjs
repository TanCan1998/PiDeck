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
			calls.push({ method, params, ...(options?.repo === undefined ? {} : { repo: options.repo }) });
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

test("remote Git boundary rejects escaping/cross-project scopes before connecting and accepts a nested repo", async () => {
	const f = fixture();
	// G5d: a project-relative nested path is a legal read scope (the helper anchors and checks the repository).
	await f.port.status(f.event, projectId, { projectId, relativePath: "nested" });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.status", params: {}, repo: "nested" });
	f.calls.length = 0;
	for (const repo of [{ projectId: "other", relativePath: "" }, "/local/absolute", "../outside", "nested/../root", "a\\b", "dir/.git", "x.lock/y"]) await assert.rejects(f.port.status(f.event, projectId, repo));
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

test("every read channel carries the repository scope into the helper frame", async () => {
	const f = fixture();
	const readCapabilities = ["git.status", "git.log", "git.commitDetail", "git.refs", "git.compare", "git.refFileDiff", "git.recoveryList", "git.syncFacts"];
	f.session.request = async (method, params, options) => {
		f.calls.push({ method, params, repo: options?.repo });
		options?.onRequestId?.("request-" + f.calls.length);
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: readCapabilities };
		if (method === "git.status") return snapshot;
		if (method === "git.log") return logPage;
		if (method === "git.commitDetail") return { ...detailValue, oid: params.oid };
		if (method === "git.refs") return refsValue;
		if (method === "git.compare") return { base: { ref: params.base, oid: oid("a") }, head: { ref: params.head, oid: oid("b") }, files: [] };
		if (method === "git.recoveryList") return { entries: [], truncated: false };
		if (method === "git.syncFacts") return { branch: "main", upstream: null, ahead: 0, behind: 0, remotes: [] };
		return { originalContent: "base\n", modifiedContent: "working\n" };
	};
	const scoped = "packages/nested";
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId, scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteLog)(f.event, projectId, { maxCount: 10 }, scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteCommitDetail)(f.event, projectId, oid("d"), scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefs)(f.event, projectId, scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteCompare)(f.event, projectId, "refs/heads/main", "refs/tags/v1", scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId, relativePath: "x.txt" }, scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRecoveryList)(f.event, projectId, scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteSyncFacts)(f.event, projectId, scoped)).ok, true);
	const scopedCalls = f.calls.filter((call) => call.method !== "hello");
	assert.equal(scopedCalls.length, 8, "eight scoped reads reach the helper");
	for (const call of scopedCalls) assert.equal(call.repo, scoped, call.method + " must carry the selected repository");
});

test("a nested snapshot never mints a write grant, while the root snapshot keeps them", async () => {
	const f = fixture();
	f.session.hostRevision = 1;
	const capabilities = ["git.status", "git.stage", "git.unstage", "git.commit", "git.createBranch", "git.switchBranch", "git.discard", "git.recoveryRestore", "git.recoveryDrop", "git.fetch", "git.push", "git.pull"];
	f.session.request = async (method) => {
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities };
		return { ...snapshot, revision: "a".repeat(64) };
	};
	const nested = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId, "packages/nested");
	assert.equal(nested.ok, true);
	for (const field of ["mutationToken", "commitToken", "branchToken", "switchToken", "discardToken", "restoreToken", "dropToken", "fetchToken", "pushToken", "pullToken"]) assert.equal(nested.snapshot[field], undefined, field + " must not be issued for a nested scope");
	const root = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.equal(root.ok, true);
	assert.ok(root.snapshot.mutationToken && root.snapshot.commitToken && root.snapshot.fetchToken, "the root scope keeps its grants");
});

test("write channels refuse a supplied repository scope before any host work", async () => {
	const f = fixture();
	const writeCalls = [
		["gitRemoteMutateIndex", [projectId, "stage", "workingTree", { projectId, relativePath: "a.txt" }, "token"]],
		["gitRemoteCommit", [projectId, "message", "token"]],
		["gitRemoteCreateBranch", [projectId, "feature", "token"]],
		["gitRemoteSwitchBranch", [projectId, "feature", "token"]],
		["gitRemoteDiscard", [projectId, "workingTree", { projectId, relativePath: "a.txt" }, "token"]],
		["gitRemoteRecoveryRestore", [projectId, "refs/pideck/recovery/x", oid("a"), "a.txt", "token"]],
		["gitRemoteRecoveryDrop", [projectId, "refs/pideck/recovery/x", oid("a"), "token"]],
		["gitRemoteFetch", [projectId, "origin", "token"]],
		["gitRemotePush", [projectId, "origin", "main", "token"]],
		["gitRemotePull", [projectId, "origin", "main", "token"]],
		["gitRemoteInit", [projectId]],
	];
	for (const [channel, args] of writeCalls) {
		const result = await f.handlers.get(ipcChannels[channel])(f.event, ...args, "packages/nested");
		assert.equal(result.ok, false, channel);
		assert.equal(result.code, "GIT_RESULT_INVALID", channel + " must refuse a supplied repository scope");
	}
	assert.equal(f.calls.length, 0, "no write channel may reach the host with a supplied scope");
	// A write without the extra argument keeps its exact old frame: no repo field at all.
	f.session.request = async (method, params, options) => {
		f.calls.push({ method, params, repo: options?.repo });
		options?.onRequestId?.("request-" + f.calls.length);
		if (method === "hello") return { ...hello, capabilities: [...hello.capabilities, "git.init"] };
		return { applied: true };
	};
	await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, projectId);
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello", "git.init"],
	);
	assert.equal(f.calls[1].repo, undefined);
});

test("remote repo discovery is a token-free read with a re-validated answer", async () => {
	const f = fixture();
	f.session.request = async (method, params, options) => {
		f.calls.push({ method, params, repo: options?.repo });
		options?.onRequestId?.("request-" + f.calls.length);
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.repos"] };
		return {
			repos: [
				{ path: "", name: "project" },
				{ path: "packages/nested", name: "nested" },
			],
			truncated: true,
		};
	};
	const result = await f.handlers.get(ipcChannels.gitRemoteRepos)(f.event, projectId);
	assert.deepEqual(plain(result), {
		ok: true,
		repos: [
			{ path: "", name: "project" },
			{ path: "packages/nested", name: "nested" },
		],
		truncated: true,
	});
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello", "git.repos"],
	);
	assert.equal(f.calls[1].repo, undefined, "discovery names no repository scope itself");
	// Trust refusal and disabled mode issue zero helper requests.
	const untrusted = fixture({ trusted: async () => false });
	assert.deepEqual(plain(await untrusted.handlers.get(ipcChannels.gitRemoteRepos)(untrusted.event, projectId)), { ok: false, code: "GIT_TRUST_REQUIRED" });
	assert.equal(untrusted.calls.length, 0);
	const disabled = fixture({ enabled: false });
	assert.deepEqual(plain(await disabled.handlers.get(ipcChannels.gitRemoteRepos)(disabled.event, projectId)), { ok: false, code: "REMOTE_FEATURE_DISABLED" });
	assert.equal(disabled.calls.length, 0);
	// Duplicate or escaping paths are refused, never silently filtered.
	for (const reply of [
		{
			repos: [
				{ path: "", name: "project" },
				{ path: "", name: "again" },
			],
			truncated: false,
		},
		{ repos: [{ path: "../outside", name: "escape" }], truncated: false },
	]) {
		const broken = fixture();
		broken.session.request = async (method) => (method === "hello" ? { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.repos"] } : reply);
		assert.deepEqual(plain(await broken.handlers.get(ipcChannels.gitRemoteRepos)(broken.event, projectId)), { ok: false, code: "GIT_RESULT_INVALID" });
	}
});
