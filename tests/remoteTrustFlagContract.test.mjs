/**
 * P4.4a 契约门禁：**远端链路不得传递 trust flag**（2026-10）。
 *
 * 为什么要有这条测试：本地会话的 trust 由 PiDeck 处理（spawn 时按决策传 `--approve/--no-approve`），
 * 而远端**刻意不传任何 trust flag**——远端 pi 的项目 `.pi` 资源（扩展/技能/提示词/项目设置）因此不会被信任加载，
 * PiDeck 只把现状如实告知（`RemoteSessionTrustNotice`）。这不是"没做完"，而是**安全边界**：一旦传了 flag，
 * 就等于由 PiDeck 决定「远端项目里的代码是否执行」，那属 P4.4b，**必须单独授权**。
 *
 * 所以：任何让远端 plan/launcher 出现 trust 字样的改动，都必须**显式修改本测试**——把"悄悄开始传 flag"变成
 * 一个看得见的动作。（本地那套 `trustOverride` 不受本测试约束，它在 `AgentManager` 的本地分支里。）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const REMOTE_TRUST_FREE_FILES = ["src/main/pi/piRemoteRuntimePlan.ts", "src/main/remote/SshPiRuntimeLauncher.ts"];

test("远端 plan/launcher 源码里不得出现 trust / approve 字样", () => {
	for (const file of REMOTE_TRUST_FREE_FILES) {
		const source = readFileSync(file, "utf8");
		// 允许注释里讨论"不传 trust"（本仓就是这么写的），所以只禁代码形态：flag 字面量或 trustOverride 传递。
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/[^\n]*/gm, "");
		assert.doesNotMatch(code, /--no-approve|--approve/, `${file} 出现了 trust flag 字面量（远端不得传；若这是 P4.4b，请显式改本测试）`);
		assert.doesNotMatch(code, /trustOverride/, `${file} 透传了 trustOverride（远端不得传；若这是 P4.4b，请显式改本测试）`);
	}
});

test("远端 plan 的类型里没有 trust 字段（结构上就传不出去）", () => {
	// 类型定义在 PiSpawnHandle（远端与本地共用的 spawn 句柄模块），不在 plan 组装器里。
	const file = "src/main/pi/PiSpawnHandle.ts";
	const source = readFileSync(file, "utf8");
	const start = source.indexOf("export type RemoteSshPiRuntimeLaunchPlan");
	assert.ok(start >= 0, `${file} 里找不到远端 plan 类型（改名了？请同步本测试）`);
	const end = source.indexOf("\n};", start);
	assert.ok(end > start, "远端 plan 类型定义形态变了（请同步本测试）");
	const block = source.slice(start, end + 3);
	assert.doesNotMatch(block, /trust|approve/i, "远端 plan 类型出现了 trust 字段（若这是 P4.4b，请显式改本测试）");
});
