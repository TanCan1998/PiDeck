import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Actual adapter consumes only a pinned absolute executable and releases native subscriptions with its PTY. */
test("remote terminal adapter spawns verified SSH in a local cwd and pairs kill/listener cleanup", async (t) => {
	const calls = [],
		events = [],
		disposals = [];
	let data, exit;
	const native = {
		write() {},
		resize() {},
		pause() {},
		resume() {},
		kill: () => calls.push("kill"),
		onData: (callback) => {
			data = callback;
			return { dispose: () => disposals.push("data") };
		},
		onExit: (callback) => {
			exit = callback;
			return { dispose: () => disposals.push("exit") };
		},
	};
	const clientEnv = { PATH: "/usr/bin", HOME: "/local/home" };
	const service = {
		withProjectSession: async (host, root, work) => ({
			ok: true,
			value: await work({
				nodePath: "/remote/node/bin/node",
				withTerminalInvocation: async (command, launch) => {
					calls.push({ host, root, command });
					const resource = launch({ executable: "/verified/ssh", args: ["-tt", "--", "work", command], env: clientEnv }, async () => {});
					const nonce = /PIDECK_TERM_([0-9a-f]{32})/.exec(command)?.[1];
					setImmediate(() => data("\x1ePIDECK_TERM_" + nonce + "\x1f$ "));
					return resource;
				},
			}),
		}),
	};
	const { createRemoteTerminalManager } = loadTsCommonJs("src/main/terminal/createRemoteTerminalManager.ts", {
		stubs: {
			"node-pty": {
				spawn: (file, args, options) => {
					calls.push({ file, args: Array.from(args), cwd: options.cwd, env: { ...options.env } });
					return native;
				},
			},
		},
	});
	const manager = createRemoteTerminalManager({ project: () => ({ id: "p", name: "P", locator: { kind: "ssh", hostId: "h", remotePath: "/remote/project" }, lastOpenedAt: 0 }), service: async () => service, emit: (...args) => events.push(args) });
	t.after(() => manager.closeAll());
	const [tab] = await manager.ensure(7, "p");
	assert.equal(calls[1].file, "/verified/ssh");
	assert.equal(calls[1].args[0], "-tt");
	assert.equal(calls[1].cwd, process.cwd());
	assert.notEqual(calls[1].cwd, "/remote/project");
	assert.equal(calls[1].env.TERM, "xterm-256color");
	assert.equal(clientEnv.TERM, undefined);
	manager.close(7, tab.id);
	assert.deepEqual(disposals, ["data", "exit"]);
	assert.equal(calls.filter((call) => call === "kill").length, 1);
	const count = events.length;
	data("late");
	exit({ exitCode: 0 });
	assert.equal(events.length, count);
});

test("project changes during invocation preparation refuse the native spawn itself", async (t) => {
	let spawned = 0;
	let project = { id: "p", name: "P", locator: { kind: "ssh", hostId: "h", remotePath: "/remote/old" }, lastOpenedAt: 0 };
	const service = {
		withProjectSession: async (_host, _root, work) => ({
			ok: true,
			value: await work({
				nodePath: "/remote/node/bin/node",
				withTerminalInvocation: async (_command, launch) => {
					project = { ...project, locator: { kind: "ssh", hostId: "other", remotePath: "/remote/new" } };
					return launch({ executable: "/verified/ssh", args: [], env: {} }, async () => {});
				},
			}),
		}),
	};
	const { createRemoteTerminalManager } = loadTsCommonJs("src/main/terminal/createRemoteTerminalManager.ts", {
		stubs: {
			"node-pty": {
				spawn: () => {
					spawned++;
					throw new Error("UNEXPECTED_NATIVE_SPAWN");
				},
			},
		},
	});
	const manager = createRemoteTerminalManager({ project: () => project, service: async () => service, emit: () => {} });
	t.after(() => manager.closeAll());
	await assert.rejects(manager.ensure(1, "p"), /REMOTE_TERMINAL_TARGET_CHANGED/);
	assert.equal(spawned, 0);
});

test("disabled remote terminal adapter never invokes node-pty or a local fallback shell", async (t) => {
	let spawned = 0;
	const { createRemoteTerminalManager } = loadTsCommonJs("src/main/terminal/createRemoteTerminalManager.ts", {
		stubs: {
			"node-pty": {
				spawn: () => {
					spawned++;
				},
			},
		},
	});
	const manager = createRemoteTerminalManager({ project: () => ({ id: "p", name: "P", locator: { kind: "ssh", hostId: "h", remotePath: "/remote/project" }, lastOpenedAt: 0 }), service: () => undefined, emit: () => {} });
	t.after(() => manager.closeAll());
	await assert.rejects(manager.ensure(1, "p"), /REMOTE_FEATURE_DISABLED/);
	assert.equal(spawned, 0);
});
