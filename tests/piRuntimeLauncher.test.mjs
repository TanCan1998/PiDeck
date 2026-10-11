import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 本地 pi 启动器（Phase 4 P4.0 抽取）。
 *
 * 判据是「抽取前后逐字一致」：spawn 选项、停止顺序（Windows 先整树后根 / Unix 先 SIGTERM 后组兜底）、
 * spawn 失败只发 error 不发 exit、事件不丢（含"先结算后注册"的重放）。用真实的 EventEmitter + 假 child
 * 驱动，不启动任何真实进程。
 */

const { LocalPiRuntimeLauncher, LOCAL_PI_GROUP_KILL_DELAY_MS } = loadTsCommonJs("src/main/pi/LocalPiRuntimeLauncher.ts");

const PLAN = { kind: "local", command: "/usr/bin/pi", args: ["--mode", "rpc", "--offline"], cwd: "/srv/app", env: { PATH: "/usr/bin" }, shell: false, windowsVerbatimArguments: true };

function fakeChild({ pid = 4321 } = {}) {
	const child = new EventEmitter();
	child.pid = pid;
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kills = [];
	child.kill = (signal) => {
		child.kills.push(signal ?? "SIGTERM");
		return true;
	};
	return child;
}

function flushMicrotasks() {
	return new Promise((resolve) => setImmediate(resolve));
}

function makeLauncher(overrides = {}) {
	return new LocalPiRuntimeLauncher({ platform: "linux", ...overrides });
}

test("launch 把 plan 逐字段交给 spawn（含 Unix detached 与 Windows 的差异）", async () => {
	const calls = [];
	const child = fakeChild();
	const launcher = makeLauncher({
		spawn: (command, args, options) => {
			calls.push({ command, args: [...args], options });
			return child;
		},
	});
	const handle = await launcher.launch(PLAN);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, "/usr/bin/pi");
	assert.deepEqual(calls[0].args, ["--mode", "rpc", "--offline"]);
	assert.equal(calls[0].options.cwd, "/srv/app");
	assert.deepEqual([...calls[0].options.stdio], ["pipe", "pipe", "pipe"]);
	assert.equal(calls[0].options.shell, false);
	// Unix：pi 必须是进程组组长，stop() 才能用 -pid 兜底清理子代理。
	assert.equal(calls[0].options.detached, true);
	assert.equal(calls[0].options.windowsHide, true);
	assert.equal(calls[0].options.windowsVerbatimArguments, true);
	assert.deepEqual({ ...calls[0].options.env }, { PATH: "/usr/bin" });
	assert.equal(handle.pid, 4321);
	assert.equal(handle.stdout, child.stdout);
	assert.equal(handle.stdin, child.stdin);
	assert.equal(handle.stderr, child.stderr);

	const winCalls = [];
	const winLauncher = new LocalPiRuntimeLauncher({
		platform: "win32",
		spawn: (_command, _args, options) => {
			winCalls.push(options);
			return fakeChild();
		},
	});
	await winLauncher.launch(PLAN);
	assert.equal(winCalls[0].detached, false, "Windows 不用进程组（树杀走 taskkill /T）");
});

test("非法 plan 一律在 spawn 之前被拒（稳定码），不接受陌生 kind", async () => {
	const launcher = makeLauncher({
		spawn: () => {
			throw new Error("不得走到 spawn");
		},
	});
	const bad = [undefined, {}, { ...PLAN, kind: "remote-ssh" }, { ...PLAN, command: "" }, { ...PLAN, command: "   " }, { ...PLAN, args: ["--mode", 7] }, { ...PLAN, args: "not-an-array" }, { ...PLAN, cwd: "" }, { ...PLAN, shell: "yes" }, { ...PLAN, env: null }, { ...PLAN, windowsVerbatimArguments: "true" }];
	for (const plan of bad) {
		await assert.rejects(() => launcher.launch(plan), /PI_RUNTIME_LAUNCH_PLAN_INVALID/);
	}
});

test("同步 spawn 失败 ⇒ launch reject；异步 spawn 失败 ⇒ onSpawnError（注册前后都能收到）", async () => {
	const rejecting = makeLauncher({
		spawn: () => {
			throw new Error("spawn ENOENT");
		},
	});
	await assert.rejects(() => rejecting.launch(PLAN), /spawn ENOENT/);

	const child = fakeChild();
	child.pid = undefined;
	const launcher = makeLauncher({ spawn: () => child });
	const handle = await launcher.launch(PLAN);
	assert.equal(handle.pid, undefined, "spawn 未成功时 pid 必须是 undefined（调用方据此归因启动失败）");

	const seen = [];
	handle.onSpawnError((error) => seen.push(error.message));
	child.emit("error", new Error("ENOENT: pi missing"));
	assert.deepEqual(seen, ["ENOENT: pi missing"]);

	// 先结算后注册：必须重放给她一次，否则这条错误路径会静默。
	let late;
	handle.onSpawnError((error) => {
		late = error.message;
	});
	await flushMicrotasks();
	assert.equal(late, "ENOENT: pi missing");

	// 已注册的监听器不得因为别人注册而收到第二次。
	assert.deepEqual(seen, ["ENOENT: pi missing"]);
});

test("onExit 收到退出事实；先退出后注册同样能收到（只重放给新监听器一次）", async () => {
	const child = fakeChild();
	const handle = await makeLauncher({ spawn: () => child }).launch(PLAN);
	const exits = [];
	handle.onExit((exit) => exits.push(exit));
	child.emit("exit", 3, null);
	assert.equal(exits.length, 1);
	assert.equal(exits[0].code, 3);
	assert.equal(exits[0].signal, null);

	let late;
	handle.onExit((exit) => {
		late = exit;
	});
	await flushMicrotasks();
	assert.equal(late.code, 3);
	assert.equal(exits.length, 1, "重放只给新监听器，不得重复通知已注册的");
});

test("Unix 停止：先 SIGTERM、再延迟对进程组兜底；stop 幂等且等待退出", async () => {
	const child = fakeChild();
	const scheduled = [];
	const groupKills = [];
	const handle = await makeLauncher({
		spawn: () => child,
		schedule: (task, delayMs) => scheduled.push({ task, delayMs }),
		groupKill: (pid) => groupKills.push(pid),
	}).launch(PLAN);

	const stopping = handle.stop("abort");
	assert.deepEqual(child.kills, ["SIGTERM"], "Unix 保持先优雅停的原语义");
	assert.equal(scheduled.length, 1);
	assert.equal(scheduled[0].delayMs, LOCAL_PI_GROUP_KILL_DELAY_MS, "组兜底延迟与抽取前一致");
	assert.deepEqual(groupKills, [], "兜底只能在延迟到点时发生");

	// 幂等：重复 stop 不重复发信号、不重复武装兜底。
	void handle.stop("restart");
	assert.deepEqual(child.kills, ["SIGTERM"]);
	assert.equal(scheduled.length, 1);

	scheduled[0].task();
	assert.deepEqual(groupKills, [4321], "注入的 groupKill 收正 pid；默认实现才转成 -pid 的组杀");

	child.emit("exit", 0, null);
	await stopping;
});

test("Windows 停止：先整树 taskkill、再杀根，且不武装 Unix 的组兜底", async () => {
	const child = fakeChild();
	const treeKills = [];
	const handle = await makeLauncher({
		platform: "win32",
		spawn: () => child,
		killTree: (pid) => treeKills.push(pid),
		schedule: () => {
			throw new Error("win32 不得武装组兜底");
		},
		groupKill: () => {
			throw new Error("win32 不得组杀");
		},
	}).launch(PLAN);

	const stopping = handle.stop("shutdown");
	assert.deepEqual(treeKills, [4321], "先整树（子代理是 pi 自己 spawn 的独立进程）");
	assert.deepEqual(child.kills, ["SIGTERM"], "再杀根");
	child.emit("exit", 0, null);
	await stopping;
});

test("已退出的进程再 stop：立即 resolve，不补发信号", async () => {
	const child = fakeChild();
	const scheduled = [];
	const handle = await makeLauncher({ spawn: () => child, schedule: (task, delayMs) => scheduled.push({ task, delayMs }) }).launch(PLAN);
	child.emit("exit", 0, null);
	await handle.stop("shutdown");
	assert.deepEqual(child.kills, []);
	assert.deepEqual(scheduled, []);
});

/** 假 child 测不到真实信号与退出码语义，这两条用**真实子进程**（node 自己）跑。 */
test("真实子进程：退出码原样上报，且已经退出的进程 stop 不补发信号", async () => {
	const handle = await makeLauncher().launch({ ...PLAN, command: process.execPath, args: ["-e", "setTimeout(() => process.exit(7), 20)"], cwd: process.cwd(), env: process.env });
	const exit = await new Promise((resolve) => handle.onExit(resolve));
	assert.equal(exit.code, 7);
	assert.equal(exit.signal, null);
	await handle.stop("shutdown");
});

test("真实子进程：stop 真的把进程收掉（SIGTERM），不会悬挂", async () => {
	const handle = await makeLauncher().launch({ ...PLAN, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), env: process.env });
	const pid = handle.pid;
	assert.equal(typeof pid, "number");
	const exited = new Promise((resolve) => handle.onExit(resolve));
	await handle.stop("abort");
	await exited;
	// 进程确实没了：kill(pid, 0) 抛 ESRCH（僵尸已被父进程回收）。
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
