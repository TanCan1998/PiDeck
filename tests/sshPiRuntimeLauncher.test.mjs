import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端 pi 启动器（Phase 4 P4.2）：把一条 pinned ssh + 冻结 runner 交接成 `PiSpawnHandle`。
 *
 * 这组用例锁的是**握手纪律**，不重复测 runner 自己（那是 `remoteRunnerEntry` 的职责），也不重复测
 * 「订阅前到达的行会被保留」（那是 `sshLauncherOutput.test.mjs` 第 73 行那条既有不变量）：
 * 1. 命令只由 `buildRemoteRunnerCommand` 构造，cwd/pi 参数/用户文本**不进命令行**，走 init 帧；
 * 2. `lifetime: "session"`（远端会话不得被固定 wall-clock 掐断）+ 未消费字节预算给到上限；
 * 3. ready 之前的任何异常（非帧行、非法帧、nonce 不符、ssh 退出、超时）都**失败关闭并停掉会话语**；
 * 4. runner 的 error 码原样带出去（它是远端没起来的唯一权威归因）；
 * 5. 交接后的三根流与 stop 转接语义。
 */

const SSH = { executable: "/usr/bin/ssh", args: ["-T", "-o", "BatchMode=yes", "--", "pideck-alias"], env: {}, openSshVersion: "OpenSSH_10.0p2" };
const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const NONCE = "abcdefghijklmnop1234";
const NODE_PATH = "/home/u/.nvm/versions/node/v24.11.0/bin/node";
const PI_PATH = "/home/u/.nvm/versions/node/v24.11.0/bin/pi";
const RUNNER_PATH = "/home/u/.pideck/remote-host/bundles/deadbeef/runner.mjs";

const PLAN = {
	kind: "remote-ssh",
	hostId: HOST_ID,
	generation: 2,
	nodePath: NODE_PATH,
	piPath: PI_PATH,
	runnerPath: RUNNER_PATH,
	cwd: "/srv/app",
	args: ["--mode", "rpc", "--no-themes", "--offline"],
	nonce: NONCE,
};

function makeFakeSession() {
	const stdoutListeners = new Set();
	const stderrListeners = new Set();
	const exitListeners = new Set();
	const state = { writes: [], stops: 0, pid: 4242 };
	const handle = {
		get pid() {
			return state.pid;
		},
		onExit(listener) {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		onStdoutLine(listener) {
			stdoutListeners.add(listener);
			return () => stdoutListeners.delete(listener);
		},
		onStderrLine(listener) {
			stderrListeners.add(listener);
			return () => stderrListeners.delete(listener);
		},
		write(line) {
			state.writes.push(line);
		},
		async stop() {
			state.stops += 1;
		},
	};
	return {
		handle,
		state,
		emitStdout: (line) => {
			for (const listener of [...stdoutListeners]) listener(line);
		},
		emitStderr: (line) => {
			for (const listener of [...stderrListeners]) listener(line);
		},
		emitExit: (exit) => {
			for (const listener of [...exitListeners]) listener(exit);
		},
	};
}

function loadLauncher(options = {}) {
	const starts = [];
	const commands = [];
	const session = makeFakeSession();
	const mod = loadTsCommonJs("src/main/remote/SshPiRuntimeLauncher.ts", {
		stubs: {
			"./SshVerifiedConnection": {
				async buildPinnedSshInvocation(userDataDir, hostId, kind, opts) {
					commands.push({ userDataDir, hostId, kind, remoteCommand: opts.remoteCommand });
					return { ...SSH, args: opts.remoteCommand === undefined ? SSH.args : [...SSH.args, opts.remoteCommand] };
				},
			},
		},
	});
	const launcher = mod.createSshPiRuntimeLauncher({
		userDataDir: options.userDataDir ?? "/tmp/pideck-userdata",
		client: { sshPath: SSH.executable, scpPath: "/usr/bin/scp", env: {}, run: async () => ({ exitCode: 0, stdout: "" }) },
		launcher: {
			async start(request) {
				starts.push(request);
				return options.failingStart ? Promise.reject(new Error("SSH_LAUNCHER_SPAWN_FAILED")) : session.handle;
			},
		},
		...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
	});
	return { launcher, starts, commands, session };
}

const readyFrame = (overrides = {}) => JSON.stringify({ v: 1, op: "ready", nonce: NONCE, pid: 4242, pgid: 4242, startedAt: "2026-10-11T08:32:46.319Z", ...overrides });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("launch 只接受远端 plan；本地 plan 在发任何帧之前被拒", async () => {
	const { launcher, starts, commands } = loadLauncher();
	await assert.rejects(() => launcher.launch({ kind: "local", command: "/usr/bin/pi", args: [], cwd: "/srv", env: {}, shell: false }), /REMOTE_RUNTIME_LAUNCH_PLAN_INVALID/);
	await assert.rejects(() => launcher.launch(undefined), /REMOTE_RUNTIME_LAUNCH_PLAN_INVALID/);
	assert.equal(starts.length, 0, "invalid plans must not start an ssh process");
	assert.equal(commands.length, 0, "invalid plans must not even build an invocation");
});

test("启动请求：session 档 + 打开 stdin + 未消费字节给到上限；命令只由 runner 命令构造器拼", async () => {
	const { launcher, starts, commands, session } = loadLauncher();
	const pending = launcher.launch(PLAN);
	await flush();
	assert.equal(commands.length, 1);
	assert.equal(commands[0].kind, "ssh-batch");
	assert.match(commands[0].remoteCommand, /^'\/home\/u\/\.nvm\/versions\/node\/v24\.11\.0\/bin\/node' '\/home\/u\/\.pideck\/remote-host\/bundles\/deadbeef\/runner\.mjs'$/);
	assert.equal(starts.length, 1);
	assert.equal(starts[0].lifetime, "session", "远端会话必须能活过任何固定预算");
	assert.equal(starts[0].stdin, true);
	assert.equal(starts[0].hostId, HOST_ID);
	assert.equal(starts[0].generation, 2);
	assert.equal(starts[0].timeoutMs, undefined, "session 档不得同时带 timeoutMs（launcher 会直接拒）");
	assert.ok(starts[0].maxOutputBytes >= 1024 * 1024, "未消费字节预算不能被 64 KiB 默认值掐掉");
	session.emitStdout(readyFrame());
	await pending;
});

test("init 帧：cwd 与 pi 参数走 stdin，命令行里没有它们", async () => {
	const { launcher, commands, session } = loadLauncher();
	const pending = launcher.launch(PLAN);
	await flush();
	const command = commands[0].remoteCommand;
	for (const forbidden of [PLAN.cwd, "--mode", "--offline", "--session"]) {
		assert.equal(command.includes(forbidden), false, `the remote command must not contain ${forbidden}`);
	}
	assert.equal(session.state.writes.length, 1);
	const frame = JSON.parse(session.state.writes[0]);
	assert.deepEqual(frame, { v: 1, op: "start", nonce: NONCE, cwd: "/srv/app", argv: [NODE_PATH, PI_PATH, "--mode", "rpc", "--no-themes", "--offline"] });
	session.emitStdout(readyFrame());
	const handle = await pending;
	assert.equal(handle.pid, 4242);
});

test("ready 之后的行直通给 PiSpawnHandle.stdout；stderr 同理", async () => {
	const { launcher, session } = loadLauncher();
	const pending = launcher.launch(PLAN);
	await flush();
	session.emitStdout(readyFrame());
	const handle = await pending;
	const lines = [];
	const errs = [];
	handle.stdout.on("data", (chunk) => lines.push(chunk.toString("utf8")));
	handle.stderr.on("data", (chunk) => errs.push(chunk.toString("utf8")));
	session.emitStdout('{"type":"message_update","delta":"hi"}');
	session.emitStdout("second");
	session.emitStderr("a diagnostic");
	await flush();
	assert.deepEqual(lines, ['{"type":"message_update","delta":"hi"}\n', "second\n"]);
	assert.deepEqual(errs, ["a diagnostic\n"]);
});

test("stdin 逐行转发到会话语，且不把行尾换行混进帧", async () => {
	const { launcher, session } = loadLauncher();
	const pending = launcher.launch(PLAN);
	await flush();
	session.emitStdout(readyFrame());
	const handle = await pending;
	handle.stdin.write('{"type":"prompt","message":"hi"}\n');
	handle.stdin.write("one\ntwo\n");
	await flush();
	// 第 0 条是握手期的 init 帧；之后才是本次写入的行。
	assert.deepEqual(session.state.writes.slice(1), ['{"type":"prompt","message":"hi"}', "one", "two"]);
});

test("runner 的 error 码原样带出，并且会话语被停掉", async () => {
	const { launcher, session } = loadLauncher();
	const pending = launcher.launch(PLAN);
	await flush();
	session.emitStdout(JSON.stringify({ v: 1, op: "error", code: "RUNNER_SPAWN_FAILED" }));
	await assert.rejects(pending, (error) => {
		assert.equal(error.message, "RUNNER_SPAWN_FAILED", "the runner's code must be the whole message");
		return true;
	});
	assert.equal(session.state.stops, 1, "a failed handshake must release the ssh session");
});

test("ready 之前的失败关闭：非帧行 / 非法帧 / nonce 不符 / ssh 退出 / 超时，都会停会话语", async () => {
	for (const scenario of ["not-a-frame", "invalid-frame", "wrong-nonce", "exit", "timeout"]) {
		const { launcher, session } = loadLauncher({ handshakeTimeoutMs: 30 });
		const pending = launcher.launch(PLAN);
		await flush();
		if (scenario === "not-a-frame") session.emitStdout("hello from nowhere");
		if (scenario === "invalid-frame") session.emitStdout(JSON.stringify({ v: 1, op: "ready", nonce: NONCE }));
		if (scenario === "wrong-nonce") session.emitStdout(readyFrame({ nonce: "someone-elses-nonce" }));
		if (scenario === "exit") session.emitExit({ kind: "exited", code: 255, signal: null });
		const expected = scenario === "timeout" ? /REMOTE_RUNTIME_HANDSHAKE_TIMEOUT/ : /REMOTE_RUNTIME_HANDSHAKE_(INVALID|UNCONFIRMED)/;
		await assert.rejects(pending, expected, `scenario ${scenario}`);
		assert.equal(session.state.stops, 1, `scenario ${scenario} must release the session`);
	}
});

test("handle：stop 幂等转接、exit 映射到 PiRuntimeExit、onSpawnError 是安全的空订阅", async () => {
	const { launcher, session } = loadLauncher();
	const pending = launcher.launch(PLAN);
	await flush();
	session.emitStdout(readyFrame());
	const handle = await pending;
	const exits = [];
	handle.onExit((exit) => exits.push(exit));
	handle.onSpawnError(() => assert.fail("remote handles never report a spawn error after ready"));
	assert.equal(typeof handle.stop("abort"), "object");
	await handle.stop("shutdown");
	await flush();
	assert.equal(session.state.stops, 1, "repeated stop must not issue a second teardown");
	session.emitExit({ kind: "exited", code: 7, signal: "SIGTERM" });
	await flush();
	assert.equal(exits.length, 1);
	assert.equal(exits[0].code, 7);
	assert.equal(exits[0].signal, "SIGTERM");
});

test("启动 ssh 失败 ⇒ launch 直接 reject（远端没有「起来了一半」的中间态）", async () => {
	const { launcher } = loadLauncher({ failingStart: true });
	await assert.rejects(() => launcher.launch(PLAN), /SSH_LAUNCHER_SPAWN_FAILED/);
});
