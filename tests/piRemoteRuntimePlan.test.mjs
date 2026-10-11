import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端运行时计划与参数（Phase 4 P4.2）。
 *
 * 这组用例锁三件事：
 * 1. 本地与远端共用同一份**基础参数**（同一个 pi 不能有两套基础参数）；
 * 2. 远端 plan 的每个路径字段都是**远端绝对 POSIX 形状**——本机 Windows 路径、相对路径、含 `.`/`..`
 *    的路径一律当场拒绝（本机路径出现在远端命令行里是静默错误，最难查）；
 * 3. 身份字段与别处同源：hostId 走 shared 的权威取值域，nonce 走与引导握手同一个形态。
 */

const { basePiRpcArgs, buildRemotePiArgs } = loadTsCommonJs("src/main/pi/piRpcArgs.ts");
const { buildRemotePiRuntimePlan } = loadTsCommonJs("src/main/pi/piRemoteRuntimePlan.ts");
/** 远端路径形状门对外抛的稳定码（消息即码本身）。 */
const REMOTE_RUNTIME_PATH_INVALID = "REMOTE_RUNTIME_PATH_INVALID";

const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const NONCE = "a1b2c3d4e5f6a7b8";
const PLAN_INPUT = {
	hostId: HOST_ID,
	generation: 3,
	remoteCwd: "/srv/app",
	nodePath: "/home/u/.nvm/versions/node/v24.11.0/bin/node",
	piPath: "/home/u/.nvm/versions/node/v24.11.0/bin/pi",
	runnerPath: "/home/u/.pideck/remote-host/bundles/deadbeef/runner.mjs",
	nonce: NONCE,
};

test("基础参数只有一份：本地与远端都从 basePiRpcArgs 取", () => {
	assert.deepEqual([...basePiRpcArgs()], ["--mode", "rpc", "--no-themes", "--offline"]);
	// 显式关闭离线时去掉 --offline，其余不变。
	assert.deepEqual([...basePiRpcArgs({ piRpcOffline: false })], ["--mode", "rpc", "--no-themes"]);
	// 远端参数 = 基础参数（无会话文件时不追加任何东西）。
	assert.deepEqual([...buildRemotePiArgs()], [...basePiRpcArgs()]);
});

test("重开会话时把远端会话文件作为 --session 附上；形状非法一律拒绝", () => {
	assert.deepEqual([...buildRemotePiArgs({ sessionFile: "/srv/app/.pi/agent/sessions/x.jsonl" })], ["--mode", "rpc", "--no-themes", "--offline", "--session", "/srv/app/.pi/agent/sessions/x.jsonl"]);
	const bad = ["C:\\Users\\u\\s.jsonl", "relative/x.jsonl", "/srv/app/", "/srv/../app/x.jsonl", "/srv/\u0000/x.jsonl", ""];
	for (const sessionFile of bad) {
		assert.throws(() => buildRemotePiArgs({ sessionFile }), new RegExp(REMOTE_RUNTIME_PATH_INVALID), `must refuse ${JSON.stringify(sessionFile)}`);
	}
});

test("远端 plan：正常输入逐字段落地，kind 是 remote-ssh", () => {
	const plan = buildRemotePiRuntimePlan(PLAN_INPUT);
	assert.equal(plan.kind, "remote-ssh");
	assert.equal(plan.hostId, HOST_ID);
	assert.equal(plan.generation, 3);
	assert.equal(plan.cwd, "/srv/app");
	assert.equal(plan.nodePath, PLAN_INPUT.nodePath);
	assert.equal(plan.piPath, PLAN_INPUT.piPath);
	assert.equal(plan.runnerPath, PLAN_INPUT.runnerPath);
	assert.equal(plan.nonce, NONCE);
	assert.deepEqual([...plan.args], ["--mode", "rpc", "--no-themes", "--offline"]);
	// 计划里不得出现本机语义字段（本地 plan 才有的 cwd 之外的本机字段）。
	assert.equal("command" in plan === false, true, "remote plans must not carry a local command");
});

test("远端 plan 的路径形状门：本机 Windows 路径 / 相对路径 / `.`段一律拒绝", () => {
	const cases = [
		{ key: "remoteCwd", value: "C:\\Users\\u\\app" },
		{ key: "remoteCwd", value: "relative/app" },
		{ key: "remoteCwd", value: "/srv/app/" },
		{ key: "remoteCwd", value: "/srv/../app" },
		{ key: "nodePath", value: "node" },
		{ key: "piPath", value: "D:/pi" },
		{ key: "runnerPath", value: "/home/u/x\u0000y" },
	];
	for (const { key, value } of cases) {
		assert.throws(() => buildRemotePiRuntimePlan({ ...PLAN_INPUT, [key]: value }), /REMOTE_RUNTIME_PATH_INVALID/, `must refuse ${key}=${JSON.stringify(value)}`);
	}
});

test("远端 plan 的身份字段与别处同源：hostId 走 shared 取值域，nonce 走引导握手形态", () => {
	assert.throws(() => buildRemotePiRuntimePlan({ ...PLAN_INPUT, hostId: "not-a-uuid" }), /REMOTE_RUNTIME_HOST_ID_INVALID/);
	assert.throws(() => buildRemotePiRuntimePlan({ ...PLAN_INPUT, hostId: "9c2f0f6a-7f2e-4a19-9d1b-0d5f9f2dd0aa".toUpperCase() }), /REMOTE_RUNTIME_HOST_ID_INVALID/);
	for (const nonce of ["", "short", "-starts-with-dash-1234", "a".repeat(65), "has space in it 1234"]) {
		assert.throws(() => buildRemotePiRuntimePlan({ ...PLAN_INPUT, nonce }), /REMOTE_RUNTIME_NONCE_INVALID/, `must refuse nonce ${JSON.stringify(nonce)}`);
	}
	assert.throws(() => buildRemotePiRuntimePlan({ ...PLAN_INPUT, generation: -1 }), /REMOTE_RUNTIME_GENERATION_INVALID/);
	assert.throws(() => buildRemotePiRuntimePlan({ ...PLAN_INPUT, generation: 1.5 }), /REMOTE_RUNTIME_GENERATION_INVALID/);
});

test("参数上限与 runner 的 argv 上限同源耦合（不靠两处各写一个数）", () => {
	const { REMOTE_RUNNER_MAX_ARGV_LENGTH } = loadTsCommonJs("src/main/remote/RemoteRunnerContract.ts");
	// 行为侧不变量：runner 收到的 argv 是 [解释器, pi 入口, ...pi 参数]，所以计划产出的 argv 必须装得下。
	const plan = buildRemotePiRuntimePlan(PLAN_INPUT);
	assert.ok([plan.nodePath, plan.piPath, ...plan.args].length <= REMOTE_RUNNER_MAX_ARGV_LENGTH, "a plan must always fit the runner's argv ceiling");
	// 常量侧耦合：上限只能由 runner 的常量推导（写死第二个数字迟早漂移成「计划通过、runner 拒收」）。
	const withSession = buildRemotePiRuntimePlan({ ...PLAN_INPUT, sessionFile: "/srv/app/.pi/agent/sessions/x.jsonl" });
	assert.ok(withSession.args.length + 2 <= REMOTE_RUNNER_MAX_ARGV_LENGTH);
	const source = readFileSync("src/main/pi/piRemoteRuntimePlan.ts", "utf8");
	assert.match(source, /MAX_REMOTE_ARGS\s*=\s*REMOTE_RUNNER_MAX_ARGV_LENGTH\s*-\s*2/, "the plan cap must derive from the runner cap");
});
