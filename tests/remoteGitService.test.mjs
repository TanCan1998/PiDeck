import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitService, readRemoteGitStatus, validateRemoteGitPath } = loadTsCommonJs("src/main/git/RemoteGitService.ts");
const { GitStatus } = loadTsCommonJs("src/shared/types/git.ts");
const projectId = "project-a";
const oid = "a".repeat(40);
const locator = { hostId: "host-a", remotePath: "/work/project-a" };
const encode = (raw) => ({ status: Buffer.from(raw).toString("base64"), head: oid, branch: "main" });
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Bound substitute records protocol traffic; it never exposes a local cwd or fs operation. */
function fixture(overrides = {}) {
	const calls = [];
	const session = {
		request: async (method, params, options) => {
			calls.push({ method, params });
			options?.onRequestId?.(`request-${calls.length}`);
			if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff"] };
			if (method === "git.workspaceDiff") return { originalContent: "old\n", modifiedContent: "new\n" };
			return encode("MM tracked.txt\0?? 中文 file.txt\0");
		},
		cancel: async (id) => {
			calls.push({ method: "cancel", id });
		},
	};
	const ports = { locator: () => locator, trusted: async () => true, withProject: async (target, task) => task(session), ...overrides };
	return { calls, ports, session, service: createRemoteGitService(ports) };
}

test("remote status reuses local SCM semantics and emits only project-relative targets", () => {
	const result = readRemoteGitStatus(encode("MM tracked.txt\0R  current.txt\0old.txt\0?? 中文 file.txt\0UU conflict.txt\0"), projectId);
	assert.equal(result.groups.index.length, 2);
	assert.equal(result.groups.workingTree.length, 1);
	assert.equal(result.groups.merge[0].status, GitStatus.BOTH_MODIFIED);
	assert.equal(result.groups.index[0].status, GitStatus.INDEX_MODIFIED);
	assert.equal(result.groups.workingTree[0].status, GitStatus.MODIFIED);
	assert.deepEqual(plain(result.groups.index[1].oldTarget), { projectId, relativePath: "old.txt" });
	assert.deepEqual(plain(result.groups.untracked[0].target), { projectId, relativePath: "中文 file.txt" });
	assert.equal(result.head, oid);
	assert.equal(result.branch, "main");
});

test("remote intent-to-add appears in workingTree without confusing rename old paths", () => {
	const result = readRemoteGitStatus(encode(" A intent.txt\0R  renamed.txt\0 A old-name\0"), projectId);
	assert.equal(result.groups.workingTree.length, 1);
	assert.equal(result.groups.workingTree[0].path, "intent.txt");
	assert.equal(result.groups.workingTree[0].status, GitStatus.INTENT_TO_ADD);
	assert.equal(result.groups.index[0].oldPath, " A old-name");
});

test("remote status rejects truncated records, invalid base64, UTF-8 and path escapes", () => {
	for (const value of [
		encode(" M missing-terminator"),
		encode("R  only-current.txt\0"),
		encode("?? ../outside\0"),
		encode("ZZ unknown.txt\0"),
		{ ...encode(""), status: "%%%%" },
		{ ...encode(""), status: Buffer.from([0xc3, 0x28]).toString("base64") },
		{ ...encode(""), head: "HEAD" },
		{ ...encode(""), branch: undefined },
	]) {
		assert.throws(() => readRemoteGitStatus(value, projectId));
	}
});

test("remote filenames retain literal pathspec punctuation while control and option-like paths are refused", () => {
	assert.equal(validateRemoteGitPath("dir/[literal]* file.txt"), "dir/[literal]* file.txt");
	for (const value of ["-option.txt", "/absolute", "../outside", "dir/../file", "dir\\file", "a\nline", "C:/file", ".", "", "%2e%2e/file"]) assert.throws(() => validateRemoteGitPath(value), /PATH_OUTSIDE_ROOT/);
});

test("untrusted remote repository issues no helper request and does not connect", async () => {
	let entered = false;
	const { calls, service } = fixture({
		trusted: async () => false,
		withProject: async () => {
			entered = true;
		},
	});
	await assert.rejects(service.status(projectId), /GIT_TRUST_REQUIRED/);
	assert.equal(entered, false);
	assert.equal(calls.length, 0);
});

test("old helper lacking Git capability is refused without issuing a Git operation", async () => {
	const f = fixture();
	f.session.request = async (method) => {
		f.calls.push({ method });
		return { protocolVersion: 1, root: locator.remotePath, capabilities: ["fs.read"] };
	};
	await assert.rejects(f.service.status(projectId), /UNSUPPORTED_CAPABILITY/);
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello"],
	);
});

test("queued host operation rechecks trust at the actual Git request boundary", async () => {
	let checks = 0;
	const f = fixture({ trusted: async () => ++checks === 1 });
	await assert.rejects(f.service.status(projectId), /GIT_TRUST_REQUIRED/);
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello"],
	);
});

test("project locator drift during trust resolution refuses the host operation", async () => {
	const current = { ...locator };
	let entered = false;
	const f = fixture({
		locator: () => current,
		trusted: async () => {
			current.hostId = "host-b";
			return true;
		},
		withProject: async () => {
			entered = true;
		},
	});
	await assert.rejects(f.service.status(projectId), /GIT_TARGET_CHANGED/);
	assert.equal(entered, false);
});

test("project locator drift while helper responds discards the stale result", async () => {
	const current = { ...locator };
	const f = fixture({ locator: () => current });
	const original = f.session.request;
	f.session.request = async (...args) => {
		const value = await original(...args);
		if (args[0] === "git.status") current.remotePath = "/work/replaced";
		return value;
	};
	await assert.rejects(f.service.status(projectId), /GIT_TARGET_CHANGED/);
});

test("remote workspace diff preserves the requested scope and verifies response byte budgets", async () => {
	const f = fixture();
	const file = { projectId, relativePath: "dir/space name.txt" };
	const result = await f.service.workspaceDiff(projectId, "index", file);
	assert.deepEqual(plain(result.target), file);
	assert.equal(result.originalContent, "old\n");
	assert.deepEqual(plain(f.calls[1].params), { group: "index", path: file.relativePath });
	f.session.request = async (method) => (method === "hello" ? { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.workspaceDiff"] } : { originalContent: "a".repeat(262145), modifiedContent: "" });
	await assert.rejects(f.service.workspaceDiff(projectId, "index", file), /GIT_RESULT_INVALID/);
	assert.throws(() => f.service.workspaceDiff(projectId, "index", { ...file, projectId: "other" }), /GIT_RESULT_INVALID/);
});

test("raw remote diagnostics cannot become IPC error messages", async () => {
	const f = fixture({
		withProject: async () => {
			throw new Error("private path or credential diagnostic");
		},
	});
	await assert.rejects(f.service.status(projectId), (error) => error.message === "GIT_COMMAND_FAILED");
});

test("aborting a read cancels its exact request and discards any late success", async () => {
	const f = fixture();
	const controller = new AbortController();
	f.session.request = async (method, params, options) => {
		f.calls.push({ method });
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status"] };
		options.onRequestId("exact-read-id");
		controller.abort();
		return encode("");
	};
	await assert.rejects(f.service.status(projectId, controller.signal), /REQUEST_CANCELLED/);
	assert.deepEqual(
		f.calls.filter((call) => call.method === "cancel"),
		[{ method: "cancel", id: "exact-read-id" }],
	);
	f.calls.length = 0;
	await assert.rejects(f.service.status(projectId, controller.signal), /REQUEST_CANCELLED/);
	assert.equal(f.calls.length, 0);
});
