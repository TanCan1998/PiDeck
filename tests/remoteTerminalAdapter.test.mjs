import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REMOTE_TERMINAL_READY_MARKER, REMOTE_TERMINAL_START_MARKER, REMOTE_TERMINAL_FRAME_RS, REMOTE_TERMINAL_FRAME_US, REMOTE_TERMINAL_FRAME_TERMINATOR } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ROUTE = "c".repeat(64);
const BUNDLE = "a".repeat(64);
const DEPLOY_ROOT = "/home/dev/.pideck/remote-host";
const TICKET = "b".repeat(32);

/** The real adapter: ticket request, fixed runner command, pinned spawn, launcher handshake, paired cleanup. */
function adapterFixture(overrides = {}) {
	const calls = [],
		events = [],
		disposals = [];
	let onData, onExit;
	const native = {
		write: (data) => calls.push({ write: data }),
		resize: () => undefined,
		pause: () => undefined,
		resume: () => undefined,
		kill: () => calls.push("kill"),
		onData: (callback) => {
			onData = callback;
			return { dispose: () => disposals.push("data") };
		},
		onExit: (callback) => {
			onExit = callback;
			return { dispose: () => disposals.push("exit") };
		},
	};
	const clientEnv = { PATH: "/usr/bin", HOME: "/local/home" };
	const session = {
		hostId: HOST_ID,
		hostRouteDigest: ROUTE,
		nodePath: "/remote/node/bin/node",
		deployRoot: DEPLOY_ROOT,
		bundleSha256: BUNDLE,
		request: async (method, params) => {
			calls.push({ method, params });
			if (overrides.request) return overrides.request();
			return { ticketRef: TICKET };
		},
		withTerminalInvocation: async (command, launch) => {
			calls.push({ command });
			return launch({ executable: "/verified/ssh", args: ["-tt", "--", "work", command], env: clientEnv }, async () => {});
		},
		...overrides.session,
	};
	const service = { withProjectSession: async (host, root, work) => ({ ok: true, value: await work(session) }) };
	const { createRemoteTerminalManager } = loadTsCommonJs("src/main/terminal/createRemoteTerminalManager.ts", {
		stubs: {
			// 合并后终端原生模块统一走 nodePtyRuntime 的惰性 createRequire 入口；
			// 测试桩必须落在该模块边界（直接 stub "node-pty" 不会经过 loadNodePty）。
			"./nodePtyRuntime": {
				loadNodePty: () => ({
					spawn: (file, args, options) => {
						calls.push({ file, args: Array.from(args), cwd: options.cwd, env: { ...options.env } });
						return native;
					},
				}),
			},
		},
	});
	let project = { id: "p", name: "P", locator: { kind: "ssh", hostId: HOST_ID, remotePath: "/remote/project" }, lastOpenedAt: 0 };
	if (overrides.project) project = overrides.project(project);
	const manager = createRemoteTerminalManager({ project: () => project, service: async () => overrides.service ?? service, emit: (...args) => events.push(args) });
	return {
		manager,
		calls,
		events,
		disposals,
		clientEnv,
		ready: (shell) =>
			onData(
				REMOTE_TERMINAL_FRAME_RS +
					REMOTE_TERMINAL_READY_MARKER +
					REMOTE_TERMINAL_FRAME_US +
					REMOTE_TERMINAL_FRAME_TERMINATOR +
					(shell === undefined ? "" : REMOTE_TERMINAL_FRAME_RS + REMOTE_TERMINAL_START_MARKER + Buffer.from(shell, "utf8").toString("base64url") + REMOTE_TERMINAL_FRAME_US + REMOTE_TERMINAL_FRAME_TERMINATOR + "$ "),
			),
		exit: (code) => onExit({ exitCode: code }),
	};
}

test("remote terminal adapter mints a ticket, spawns the verified ssh PTY and pairs cleanup", async (t) => {
	const f = adapterFixture();
	t.after(() => f.manager.closeAll());
	const pending = f.manager.ensure(7, "p");
	for (let index = 0; index < 50 && !f.calls.some((call) => call.method === "terminal.prepare"); index += 1) await new Promise((resolve) => setImmediate(resolve));
	const prepare = f.calls.find((call) => call.method === "terminal.prepare");
	assert.deepEqual(JSON.parse(JSON.stringify(prepare.params)), { kind: "project", projectId: "p", hostId: HOST_ID, routeDigest: ROUTE });
	const command = f.calls.find((call) => call.command).command;
	assert.ok(command.includes("/remote/node/bin/node"));
	assert.ok(command.includes(DEPLOY_ROOT + "/bundles/" + BUNDLE + "/terminal-runner.mjs"));
	const spawnCall = f.calls.find((call) => call.file);
	assert.equal(spawnCall.file, "/verified/ssh");
	assert.equal(spawnCall.args[0], "-tt");
	assert.equal(spawnCall.cwd, process.cwd());
	assert.notEqual(spawnCall.cwd, "/remote/project");
	assert.equal(spawnCall.env.TERM, "xterm-256color");
	assert.equal(f.clientEnv.TERM, undefined);
	f.ready("/bin/bash");
	const [tab] = await pending;
	assert.equal(tab.shell, "sh");
	assert.equal(tab.location, "ssh");
	f.manager.close(7, tab.id);
	assert.deepEqual(f.disposals, ["data", "exit"]);
	assert.equal(f.calls.filter((call) => call === "kill").length, 1);
	const count = f.events.length;
	f.exit(0);
	assert.equal(f.events.length, count);
});

test("project changes during invocation preparation refuse the native spawn itself", async (t) => {
	let project = { id: "p", name: "P", locator: { kind: "ssh", hostId: HOST_ID, remotePath: "/remote/old" }, lastOpenedAt: 0 };
	let spawned = 0;
	const f = adapterFixture({
		project: () => project,
		session: {
			withTerminalInvocation: async (command, launch) => {
				project.locator = { kind: "ssh", hostId: "other", remotePath: "/remote/new" };
				return launch({ executable: "/verified/ssh", args: [], env: {} }, async () => undefined);
			},
		},
	});
	f.calls.push({ file: "unexpected" });
	const realSpawn = f.calls.find((call) => call.file === "unexpected");
	t.after(() => f.manager.closeAll());
	await assert.rejects(f.manager.ensure(1, "p"), /REMOTE_TERMINAL_TARGET_CHANGED/);
	assert.equal(spawned, 0);
});

test("disabled remote terminal adapter never invokes node-pty or a local fallback shell", async (t) => {
	let spawned = 0;
	const { createRemoteTerminalManager } = loadTsCommonJs("src/main/terminal/createRemoteTerminalManager.ts", {
		stubs: {
			"node-pty": {
				spawn: () => {
					spawned += 1;
				},
			},
		},
	});
	const manager = createRemoteTerminalManager({ project: () => ({ id: "p", name: "P", locator: { kind: "ssh", hostId: HOST_ID, remotePath: "/remote/project" }, lastOpenedAt: 0 }), service: () => undefined, emit: () => {} });
	t.after(() => manager.closeAll());
	await assert.rejects(manager.ensure(1, "p"), /REMOTE_FEATURE_DISABLED/);
	assert.equal(spawned, 0);
});
