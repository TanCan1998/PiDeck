import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const projectId = "project";
const locator = { hostId: "host", remotePath: "/owned/project" };
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff", "git.stage", "git.unstage"] };
function fixture(capabilities = hello.capabilities, commitFails = false) {
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
			if (method === "git.commit" && commitFails) throw new Error("REQUEST_TIMEOUT");
			return method === "hello"
				? { ...hello, capabilities }
				: method === "git.status"
					? { status: Buffer.from(" M file.txt\0").toString("base64"), head: "a".repeat(40), branch: "main", revision: "b".repeat(64) }
					: method === "git.commit"
						? { applied: true, head: "c".repeat(40), tree: "d".repeat(40) }
						: { applied: true };
		},
	};
	let current = locator;
	const port = registerRemoteGitReadIpc({ enabled: true, locator: () => current, trusted: async () => true, service: () => ({ withProjectSession: async (host, root, task) => ({ ok: true, value: await task(session) }) }) });
	const snapshot = () => handlers.get(ipcChannels.gitRemoteSnapshot)({ sender }, projectId);
	const mutation = (token, event = { sender }, target = { projectId, relativePath: "file.txt" }) => handlers.get(ipcChannels.gitRemoteMutateIndex)(event, projectId, "stage", "workingTree", target, token);
	const commit = (token, message = "subject\n", event = { sender }) => handlers.get(ipcChannels.gitRemoteCommit)(event, projectId, message, token);
	return {
		handlers,
		calls,
		sender,
		session,
		port,
		snapshot,
		mutation,
		commit,
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

test("remote commit grants its own action, sends the message verbatim and never reuses an index grant", async () => {
	const f = fixture([...hello.capabilities, "git.commit"]);
	const read = await f.snapshot();
	assert.match(read.snapshot.commitToken, /^[a-f0-9]{32}$/);
	assert.notEqual(read.snapshot.commitToken, read.snapshot.mutationToken, "each action gets its own opaque grant");
	// A grant issued for the index channel cannot be spent on the commit channel, and is not burned by trying.
	assert.equal((await f.commit(read.snapshot.mutationToken)).code, "GIT_RESULT_INVALID");
	// A malformed message is refused before the grant is consumed.
	assert.equal((await f.commit(read.snapshot.commitToken, "   \n")).code, "GIT_COMMIT_MESSAGE_EMPTY");
	assert.equal((await f.commit(read.snapshot.commitToken, "subject\n\nbody\n")).ok, true);
	assert.deepEqual(JSON.parse(JSON.stringify(f.calls.filter((call) => call.method === "git.commit"))), [{ method: "git.commit", params: { message: "subject\n\nbody\n", expectedRevision: "b".repeat(64) } }]);
	assert.equal((await f.commit(read.snapshot.commitToken)).code, "GIT_WRITE_SNAPSHOT_EXPIRED", "a grant is consumed exactly once");
	f.port.dispose();
});

test("remote commit maps a lost reply to unconfirmed and never replays it", async () => {
	const f = fixture([...hello.capabilities, "git.commit"], true);
	const read = await f.snapshot();
	assert.equal((await f.commit(read.snapshot.commitToken)).code, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal((await f.commit(read.snapshot.commitToken)).code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	assert.equal(f.calls.filter((call) => call.method === "git.commit").length, 1, "an unknown commit is never replayed");
	f.port.dispose();
});

test("remote commit requires the owner window and the project it was granted for", async () => {
	const f = fixture([...hello.capabilities, "git.commit"]);
	const read = await f.snapshot();
	const other = new EventEmitter();
	other.id = 2;
	other.isDestroyed = () => false;
	assert.equal((await f.commit(read.snapshot.commitToken, "subject\n", { sender: other })).code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteCommit)({ sender: f.sender }, "other-project", "subject\n", read.snapshot.commitToken)).code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	assert.equal(f.calls.filter((call) => call.method === "git.commit").length, 0);
	f.port.dispose();
});
