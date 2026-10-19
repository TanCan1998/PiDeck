/**
 * fork/clone 命令层的「失败必须留痕」契约（2026-10 真机事故回归）。
 *
 * 背景：远端会话点 Fork 会先花 8–16s 激活 runtime，再发一次最长 120s 的 fork RPC。
 * 原先失败路径只经 forkCommandError 把码带回渲染层，**主进程一行日志都没有**：
 * 现场表现为「点了没反应」，5s 后 toast 也消失了，e2e 只能等到 240s 超时，
 * 完全无法判断是渲染层没发、RPC 卡住、还是 cdatalog 换绑失败。
 *
 * 本测试用假 deps 直接驱动真实模块，钉住三件事：
 *   ① 失败时写 warn 日志，带 code + debugDetails + elapsedMs；
 *   ② 入口先写 info（区分「没进来」与「进来了但失败」）；
 *   ③ 成功时仍写 "Session forked"（不要因为加日志把成功路径改成 warn）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createSessionForkCommands } = loadTsCommonJs("src/main/sessions/sessionForkCommands.ts");

/** 记录所有日志调用，供断言检索。 */
function createLogger() {
	const entries = [];
	return {
		entries,
		info(channel, message, data) {
			entries.push({ level: "info", channel, message, data });
		},
		warn(channel, message, data) {
			entries.push({ level: "warn", channel, message, data });
		},
		find(message) {
			return entries.find((entry) => entry.message === message);
		},
	};
}

/** 最小可通过 validateTarget 的 target。 */
const TARGET = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 3 };

/**
 * 构造 fork 命令层。overrides 覆盖单个依赖，其余按「成功路径」默认。
 * @param {{ forkFails?: Error | null, validateFails?: boolean, logger?: ReturnType<typeof createLogger> }} options
 */
function harness(options = {}) {
	const logger = options.logger ?? createLogger();
	const notified = [];
	const deps = {
		sessionRuntimeCoordinator: {
			validateTarget: () => (options.validateFails ? { ok: false, error: { code: "SESSION_RUNTIME_CHANGED", debugDetails: "generation changed" } } : { ok: true, value: TARGET }),
			withRuntimeReservation: async (_sessionId, _agentId, fn) => fn(),
		},
		agentManager: {
			forkSession: async () => {
				if (options.forkFails) throw options.forkFails;
				return { text: "原句", targetSessionId: "session-2" };
			},
			cloneSession: async () => ({ targetSessionId: "session-2" }),
		},
		replaceAgentSession: async (_agentId, replace) => replace(),
		isDshAgent: () => false,
		logger,
		notifyForkCatalogRefreshed: (sessionId) => notified.push(sessionId),
	};
	return { commands: createSessionForkCommands(deps), logger, notified };
}

test("fork 失败：写 warn 日志并保留稳定码、debugDetails 与耗时", async () => {
	const { commands, logger, notified } = harness({ forkFails: new Error("REMOTE_SESSION_REPLACEMENT_RPC_FAILED") });
	const result = await commands.forkRuntimeSession(TARGET, "entry-1");

	assert.equal(result.ok, false, "失败必须如实返回 ok:false");
	assert.equal(result.error.code, "SESSION_COMMAND_FAILED");
	const failure = logger.find("Session fork failed");
	assert.ok(failure, "fork 失败必须写日志（否则现场完全不可诊断）");
	assert.equal(failure.level, "warn");
	assert.equal(failure.data.code, "SESSION_COMMAND_FAILED");
	assert.equal(failure.data.debugDetails, "REMOTE_SESSION_REPLACEMENT_RPC_FAILED", "底层原因必须进日志，不能被折叠丢掉");
	assert.equal(typeof failure.data.elapsedMs, "number", "必须带耗时，才能区分「立刻失败」与「卡在 RPC 超时」");
	assert.deepEqual(notified, [], "失败不得推送 catalog 刷新");
});

test("fork 入口先写 info：区分「渲染层没发」与「发了但失败」", async () => {
	const { commands, logger } = harness({ forkFails: new Error("boom") });
	await commands.forkRuntimeSession(TARGET, "entry-9", { branchMode: true });

	const entry = logger.find("Session fork requested");
	assert.ok(entry, "必须留下入口日志");
	assert.equal(entry.data.sessionId, TARGET.sessionId);
	assert.equal(entry.data.entryId, "entry-9");
	assert.equal(entry.data.branchMode, true);
	// 入口日志必须早于失败日志，否则事后无法判断顺序。
	assert.ok(logger.entries.indexOf(entry) < logger.entries.indexOf(logger.find("Session fork failed")));
});

test("target 校验失败：也要留痕，且不进入 fork 实现", async () => {
	const { commands, logger } = harness({ validateFails: true });
	const result = await commands.forkRuntimeSession(TARGET, "entry-1");

	assert.equal(result.ok, false);
	assert.equal(result.error.code, "SESSION_RUNTIME_CHANGED", "校验失败原样返回，不折叠成 SESSION_COMMAND_FAILED");
	const rejected = logger.find("Session fork rejected (target invalid)");
	assert.ok(rejected, "target 失效是最常见的静默分支，必须留痕");
	assert.equal(rejected.level, "warn");
	assert.equal(rejected.data.code, "SESSION_RUNTIME_CHANGED");
});

test("fork 成功：仍写 Session forked（带耗时），并推送 catalog 刷新", async () => {
	const { commands, logger, notified } = harness();
	const result = await commands.forkRuntimeSession(TARGET, "entry-1");

	assert.equal(result.ok, true);
	assert.equal(result.value.targetSessionId, "session-2");
	const forked = logger.find("Session forked");
	assert.ok(forked);
	assert.equal(forked.level, "info", "成功路径保持 info，不要被改成 warn");
	assert.equal(typeof forked.data.elapsedMs, "number");
	assert.deepEqual(notified, [TARGET.sessionId]);
	assert.equal(logger.find("Session fork failed"), undefined, "成功时不得出现失败日志");
});
