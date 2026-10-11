import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * `PiProcess` 的远端模式（Phase 4 P4.2）：参数与 cwd 来自 plan，本地专属准备一律不参与。
 *
 * 这组用例锁的是**分叉边界**，而不是 runner/launcher（那些各自有套件）：
 * 1. 远端 plan ⇒ 只走注入的 launcher，**不碰**本地命令定位/版本探测/扩展白名单；
 * 2. 起来之后的接线与本地完全一致（RPC 帧进出、退出收尾）——这是 P4.0 抽出启动面的意义；
 * 3. 与本地启动器配错时必须**当场拒绝**（`PI_RUNTIME_LAUNCH_PLAN_INVALID`），不静默降级；
 * 4. launch 失败时按本地同款写诊断并 emit error（AgentManager 靠它把原因写到会话卡片上）。
 */

const REMOTE_PLAN = {
	kind: "remote-ssh",
	hostId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
	generation: 1,
	nodePath: "/home/u/.nvm/versions/node/v24.11.0/bin/node",
	piPath: "/home/u/.nvm/versions/node/v24.11.0/bin/pi",
	runnerPath: "/home/u/.pideck/remote-host/bundles/deadbeef/runner.mjs",
	cwd: "/srv/app",
	args: ["--mode", "rpc", "--no-themes", "--offline"],
	nonce: "abcdefghijklmnop1234",
};

const LOCAL_PLAN = { kind: "local", command: "/usr/bin/pi", args: ["--mode", "rpc"], cwd: "/tmp", env: {}, shell: false };

/** 让「本地专属准备被调用」这件事**响亮地失败**：远端路径一旦用到它们，用例立刻红。 */
function forbiddenLocalDependencies(record) {
	return {
		"node:child_process": {
			execFile: () => {
				record.push("execFile");
				throw new Error("the remote path must not spawn a local process");
			},
			spawn: () => {
				record.push("spawn");
				throw new Error("the remote path must not spawn a local process");
			},
		},
		"./PiLocator": {
			PiLocator: class {
				constructor() {
					record.push("PiLocator");
				}
			},
		},
		"../extensions/builtInExtensions": {
			appendBuiltInExtensionArgs: () => {
				record.push("appendBuiltInExtensionArgs");
				return [];
			},
		},
	};
}

function loadPiProcess(options) {
	const record = [];
	const load = createTsSandbox({
		stubs: {
			...forbiddenLocalDependencies(record),
			...options.stubs,
			"../logging/sharedLogger": { getAppLogger: () => null },
			"../sessions/sessionProxyPolicy": { applyPiProxyMode: (env) => env },
		},
		globals: { console: { log() {}, warn() {}, error() {} } },
	});
	return { PiProcess: load("src/main/pi/PiProcess.ts").PiProcess, record };
}

/** 一条假的远端运行时：三根流由用例摆布，stop 记录调用。 */
function fakeRemoteHandle() {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const exitListeners = new Set();
	const state = { stops: [], lines: [] };
	stdin.on("data", (chunk) => state.lines.push(chunk.toString("utf8")));
	return {
		handle: {
			stdin,
			stdout,
			stderr,
			pid: 5150,
			stop(reason) {
				state.stops.push(reason);
				return Promise.resolve();
			},
			onExit(listener) {
				exitListeners.add(listener);
				return () => exitListeners.delete(listener);
			},
			onSpawnError() {
				return () => undefined;
			},
		},
		state,
		feed: (line) => stdout.write(`${line}\n`),
		emitExit: (exit) => {
			for (const listener of [...exitListeners]) listener(exit);
		},
	};
}

test("远端 plan：只走注入的 launcher，本地专属准备一个都不碰", async () => {
	const fake = fakeRemoteHandle();
	const launches = [];
	const { PiProcess, record } = loadPiProcess({
		stubs: {
			"./PiRpcClient": { PiRpcClient: class extends EventEmitter {} },
		},
	});
	const process0 = new PiProcess(
		"/tmp/project",
		{},
		{ resolveCommand: () => "/usr/bin/pi", createInvocation: (_command, args) => ({ command: "/usr/bin/pi", args: [...args], shell: false }), createProcessEnv: () => ({}), resolveArgCharBudget: () => 100_000 },
		{
			runtimePlan: REMOTE_PLAN,
			runtimeLauncher: {
				async launch(plan) {
					launches.push(plan);
					return fake.handle;
				},
			},
		},
	);
	await process0.start();
	assert.equal(launches.length, 1);
	assert.equal(launches[0].kind, "remote-ssh");
	assert.equal(launches[0].hostId, REMOTE_PLAN.hostId);
	assert.equal(launches[0].cwd, "/srv/app", "cwd 必须是远端路径，不能是本机 projectPath");
	assert.deepEqual(record, [], "远端路径不得触发任何本地专属准备");
	const diagnostics = process0.getDiagnostics();
	assert.equal(diagnostics.command, REMOTE_PLAN.piPath);
	assert.equal(diagnostics.cwd, "/srv/app");
	assert.deepEqual([...diagnostics.args], [...REMOTE_PLAN.args]);
	process0.stop();
});

test("远端 plan：起来之后的接线与本地一致（RPC 帧进出、退出收尾）", async () => {
	const fake = fakeRemoteHandle();
	const load = createTsSandbox({
		stubs: {
			...forbiddenLocalDependencies([]),
			"../logging/sharedLogger": { getAppLogger: () => null },
			"../sessions/sessionProxyPolicy": { applyPiProxyMode: (env) => env },
		},
		globals: { console: { log() {}, warn() {}, error() {} } },
	});
	// 真实 PiRpcClient：用它证明「RPC 解析接在远端 handle 的流上」这件事真的成立。
	const { PiProcess } = load("src/main/pi/PiProcess.ts");
	const process0 = new PiProcess(
		"/tmp/project",
		{},
		{ resolveCommand: () => "/usr/bin/pi", createInvocation: (_command, args) => ({ command: "/usr/bin/pi", args: [...args], shell: false }), createProcessEnv: () => ({}), resolveArgCharBudget: () => 100_000 },
		{
			runtimePlan: REMOTE_PLAN,
			runtimeLauncher: {
				async launch() {
					return fake.handle;
				},
			},
		},
	);
	const events = [];
	process0.on("event", (event) => events.push(event));
	const exited = new Promise((resolve) => process0.on("exit", resolve));
	await process0.start();
	// pi 的 JSONL 从远端直通上来：必须被解析成事件。
	fake.feed(JSON.stringify({ type: "message_update", delta: "hi" }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "message_update");
	assert.equal(process0.pid, 5150, "pid 应来自远端 handle");
	// 退出收尾：诊断记下 code/signal，且 isRunning 归位。
	fake.emitExit({ code: 0, signal: null });
	const exit = await exited;
	assert.equal(exit.code, 0);
	assert.equal(exit.signal, null);
	assert.equal(process0.isRunning(), false);
	assert.equal(process0.getDiagnostics()?.exitCode, 0);
});

test("与本地启动器配错 ⇒ 当场拒绝，不静默降级成本地 pi", async () => {
	const { PiProcess } = loadPiProcess({ stubs: { "./PiRpcClient": { PiRpcClient: class extends EventEmitter {} } } });
	const process0 = new PiProcess("/tmp/project", {}, { resolveCommand: () => "/usr/bin/pi", createInvocation: (_command, args) => ({ command: "/usr/bin/pi", args: [...args], shell: false }), createProcessEnv: () => ({}), resolveArgCharBudget: () => 100_000 }, { runtimePlan: REMOTE_PLAN });
	await assert.rejects(() => process0.start(), /PI_RUNTIME_LAUNCH_PLAN_INVALID/);
});

test("launch 失败 ⇒ 诊断标 spawnFailed + exitCode=-1，并 emit error", async () => {
	const { PiProcess } = loadPiProcess({ stubs: { "./PiRpcClient": { PiRpcClient: class extends EventEmitter {} } } });
	const errors = [];
	const process0 = new PiProcess(
		"/tmp/project",
		{},
		{ resolveCommand: () => "/usr/bin/pi", createInvocation: (_command, args) => ({ command: "/usr/bin/pi", args: [...args], shell: false }), createProcessEnv: () => ({}), resolveArgCharBudget: () => 100_000 },
		{
			runtimePlan: REMOTE_PLAN,
			runtimeLauncher: {
				async launch() {
					throw new Error("REMOTE_RUNTIME_HANDSHAKE_UNCONFIRMED");
				},
			},
		},
	);
	process0.on("error", (error) => errors.push(error.message));
	await assert.rejects(() => process0.start(), /REMOTE_RUNTIME_HANDSHAKE_UNCONFIRMED/);
	const diagnostics = process0.getDiagnostics();
	assert.equal(diagnostics.spawnFailed, true);
	assert.equal(diagnostics.exitCode, -1);
	assert.equal(diagnostics.stderr.join(""), "REMOTE_RUNTIME_HANDSHAKE_UNCONFIRMED");
	assert.deepEqual(errors, ["REMOTE_RUNTIME_HANDSHAKE_UNCONFIRMED"]);
});
