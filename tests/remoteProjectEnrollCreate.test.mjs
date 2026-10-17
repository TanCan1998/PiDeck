import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const HOST = "11111111-1111-4111-8111-111111111111";
const realCreate = loadTsCommonJs("src/main/remote/RemoteProjectCreateCommands.ts");

test("create-project path splitting and command shapes reuse the browse-root rules", () => {
	assert.deepEqual({ ...realCreate.splitRemoteProjectCreatePath("/srv/app/new-dir") }, { path: "/srv/app/new-dir", parent: "/srv/app", leaf: "new-dir" });
	for (const value of ["relative/path", "/", "/srv/app/", "/srv//app/x", "/srv/a/../b", "/srv/a\nb", "", 42]) assert.throws(() => realCreate.splitRemoteProjectCreatePath(value), /REMOTE_(BROWSE_ROOT|PROJECT_PARENT)/);
	for (const leaf of [".git", ".pi", ".pideck-trash", "x.pideck-tmp"]) assert.throws(() => realCreate.splitRemoteProjectCreatePath("/srv/app/" + leaf), /REMOTE_PROJECT_TARGET_INVALID/);
	const parsed = realCreate.splitRemoteProjectCreatePath("/srv/app with 'quotes'/new");
	const probe = realCreate.buildRemoteProjectCreateProbeCommand(parsed);
	const mkdir = realCreate.buildRemoteProjectCreateMkdirCommand(parsed);
	// 命令必须把所有路径作为单引号字面量，不拼 shell 语法。
	assert.match(probe, /readlink -f -- '/);
	assert.match(probe, /quotes/);
	assert.match(probe, /\/new/);
	assert.match(probe, /exit 3/);
	assert.match(probe, /exit 6/);
	assert.match(mkdir, /mkdir -- '/);
	assert.match(mkdir, /exit 6/);
	assert.match(mkdir, /exit 8/);
	assert.equal(realCreate.remoteProjectCreateProbeCode(0), undefined);
	assert.equal(realCreate.remoteProjectCreateProbeCode(3), "REMOTE_PROJECT_PARENT_NOT_FOUND");
	assert.equal(realCreate.remoteProjectCreateProbeCode(4), "REMOTE_PROJECT_ROOT_CHANGED");
	assert.equal(realCreate.remoteProjectCreateProbeCode(6), "REMOTE_PROJECT_TARGET_EXISTS");
	assert.equal(realCreate.remoteProjectCreateProbeCode(9), "REMOTE_BROWSE_ROOT_PROBE_FAILED");
	assert.equal(realCreate.remoteProjectCreateMkdirCode(0), "REMOTE_PROJECT_CREATE_OK");
	assert.equal(realCreate.remoteProjectCreateMkdirCode(6), "REMOTE_PROJECT_TARGET_EXISTS");
	assert.equal(realCreate.remoteProjectCreateMkdirCode(3), "REMOTE_PROJECT_PARENT_NOT_FOUND");
	assert.equal(realCreate.remoteProjectCreateMkdirCode(8), "REMOTE_FILE_PERMISSION_DENIED");
	assert.equal(realCreate.remoteProjectCreateMkdirCode(7), "REMOTE_PROJECT_CREATE_FAILED");
});

function createHarness(options = {}) {
	const handlers = new Map();
	const sent = [];
	const calls = [];
	const enrolled = [];
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	sender.send = (channel, payload) => sent.push({ channel, payload });
	const exits = { probe: options.probe ?? [0, 0], mkdir: options.mkdir ?? [0], resolve: options.resolve };
	const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) } },
			"../remote/RemoteBrowseRoot": {
				resolveRemoteBrowseRoot: async ({ userPath }) => ({ canonicalPath: exits.resolve ? exits.resolve(userPath) : userPath }),
			},
			"../remote/RemoteSearchReader": { REMOTE_SEARCH_READER_CODES: { queryInvalid: "REMOTE_SEARCH_QUERY_INVALID" }, createRemoteSearchReader: () => ({}) },
			"../remote/RemoteWorkspaceReader": { createRemoteWorkspaceReader: () => ({}) },
			"../remote/RemoteProjectCreateCommands": {
				splitRemoteProjectCreatePath: (value) => {
					if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.endsWith("/")) throw new Error("REMOTE_BROWSE_ROOT_INVALID");
					const index = value.lastIndexOf("/");
					return { path: value, parent: index === 0 ? "/" : value.slice(0, index), leaf: value.slice(index + 1) };
				},
				buildRemoteProjectCreateProbeCommand: (parsed) => "probe:" + parsed.path,
				buildRemoteProjectCreateMkdirCommand: (parsed) => "mkdir:" + parsed.path,
				runRemoteProjectCreateCommand: async (input) => {
					calls.push(input.command);
					if (input.command.startsWith("mkdir:")) {
						if (options.mkdirThrows) throw new Error("ssh transport lost");
						return { exitCode: exits.mkdir.shift(), stdout: "" };
					}
					return { exitCode: exits.probe.shift(), stdout: "" };
				},
				remoteProjectCreateProbeCode: (exitCode) => (exitCode === 0 ? undefined : exitCode === 3 ? "REMOTE_PROJECT_PARENT_NOT_FOUND" : exitCode === 4 ? "REMOTE_PROJECT_ROOT_CHANGED" : exitCode === 6 ? "REMOTE_PROJECT_TARGET_EXISTS" : "REMOTE_BROWSE_ROOT_PROBE_FAILED"),
				remoteProjectCreateMkdirCode: (exitCode) => (exitCode === 0 ? "REMOTE_PROJECT_CREATE_OK" : exitCode === 6 ? "REMOTE_PROJECT_TARGET_EXISTS" : exitCode === 3 ? "REMOTE_PROJECT_PARENT_NOT_FOUND" : exitCode === 8 ? "REMOTE_FILE_PERMISSION_DENIED" : "REMOTE_PROJECT_CREATE_FAILED"),
			},
		},
	});
	registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp",
		service: async () => ({ client: {}, withProjectSession: async (_hostId, _root, task) => ({ ok: true, value: await task({}) }) }),
		projects: {
			enroll: async (input) => {
				enrolled.push(input);
				return { projectId: "project-1" };
			},
			locator: () => undefined,
		},
	});
	return { handlers, sent, calls, enrolled, sender, invoke: (channel, ...args) => handlers.get(channel)({ sender }, ...args) };
}

test("create mode probes, pushes an independent confirmation, then mkdir + canonical re-check + enroll", async () => {
	const h = createHarness();
	const pending = await h.invoke("remote:project-enroll", HOST, "/srv/new-dir", "create");
	assert.equal(pending.ok, true);
	assert.equal(pending.status, "pending");
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].channel, "remote:project-create-confirm");
	assert.equal(h.sent[0].payload.parentPath, "/srv");
	assert.equal(h.sent[0].payload.leaf, "new-dir");
	assert.equal(h.sent[0].payload.requestedPath, "/srv/new-dir");
	const requestId = h.sent[0].payload.requestId;
	const answered = await h.invoke("remote:project-create-answer", requestId, "approve");
	assert.equal(answered.ok, true);
	assert.equal(answered.enrolled, true);
	assert.equal(answered.projectId, "project-1");
	// 确认前探针 1 次 + 批准后复核探针 1 次 + mkdir 1 次 = 3（§8 caps）。
	assert.deepEqual(h.calls, ["probe:/srv/new-dir", "probe:/srv/new-dir", "mkdir:/srv/new-dir"]);
	assert.deepEqual(
		h.enrolled.map((entry) => ({ ...entry })),
		[{ hostId: HOST, canonicalRemotePath: "/srv/new-dir" }],
	);
});

test("denying the create confirmation writes nothing; a consumed request cannot be answered twice", async () => {
	const h = createHarness();
	await h.invoke("remote:project-enroll", HOST, "/srv/new-dir", "create");
	const requestId = h.sent[0].payload.requestId;
	h.calls.length = 0;
	const denied = await h.invoke("remote:project-create-answer", requestId, "deny");
	assert.equal(denied.ok, true);
	assert.equal(denied.enrolled, false);
	assert.deepEqual(h.calls, []);
	assert.equal(h.enrolled.length, 0);
	assert.equal((await h.invoke("remote:project-create-answer", requestId, "approve")).code, "REMOTE_PROJECT_ENROLL_CONFIRMATION_REQUIRED");
});

test("probe refusal (target exists / parent missing) never pushes a confirmation", async () => {
	for (const [probeExit, code] of [
		[6, "REMOTE_PROJECT_TARGET_EXISTS"],
		[3, "REMOTE_PROJECT_PARENT_NOT_FOUND"],
		[4, "REMOTE_PROJECT_ROOT_CHANGED"],
	]) {
		const h = createHarness({ probe: [probeExit] });
		const result = await h.invoke("remote:project-enroll", HOST, "/srv/new-dir", "create");
		assert.equal(result.code, code);
		assert.equal(h.sent.length, 0);
		assert.deepEqual(h.calls, ["probe:/srv/new-dir"]);
	}
});

test("mkdir failures are typed: transport loss is UNCONFIRMED, permission is PERMISSION_DENIED, exit 7 is CREATE_FAILED", async () => {
	const transport = createHarness({ mkdirThrows: true });
	await transport.invoke("remote:project-enroll", HOST, "/srv/new-dir", "create");
	assert.equal((await transport.invoke("remote:project-create-answer", transport.sent[0].payload.requestId, "approve")).code, "REMOTE_PROJECT_CREATE_UNCONFIRMED");
	assert.equal(transport.enrolled.length, 0);
	const denied = createHarness({ mkdir: [8] });
	await denied.invoke("remote:project-enroll", HOST, "/srv/new-dir", "create");
	assert.equal((await denied.invoke("remote:project-create-answer", denied.sent[0].payload.requestId, "approve")).code, "REMOTE_FILE_PERMISSION_DENIED");
	const failed = createHarness({ mkdir: [7] });
	await failed.invoke("remote:project-enroll", HOST, "/srv/new-dir", "create");
	assert.equal((await failed.invoke("remote:project-create-answer", failed.sent[0].payload.requestId, "approve")).code, "REMOTE_PROJECT_CREATE_FAILED");
});

test("canonical re-check mismatch refuses enrollment (the directory may exist but is not registered)", async () => {
	const h = createHarness({ resolve: (path) => path + "-elsewhere" });
	await h.invoke("remote:project-enroll", HOST, "/srv/new-dir", "create");
	assert.equal((await h.invoke("remote:project-create-answer", h.sent[0].payload.requestId, "approve")).code, "REMOTE_PROJECT_ROOT_CHANGED");
	assert.equal(h.enrolled.length, 0);
});

test("unknown mode is refused before any remote command; existing mode keeps its prior behavior", async () => {
	const invalid = createHarness();
	assert.equal((await invalid.invoke("remote:project-enroll", HOST, "/srv/app", "clone")).code, "REMOTE_PROJECT_TARGET_INVALID");
	assert.deepEqual(invalid.calls, []);
	const existing = createHarness();
	const pending = await existing.invoke("remote:project-enroll", HOST, "/srv/app", "existing");
	assert.equal(pending.ok, true);
	assert.equal(pending.canonicalPath, "/srv/app");
	assert.equal(existing.sent[0].channel, "remote:project-enroll-confirm");
	assert.deepEqual(existing.calls, []);
});
