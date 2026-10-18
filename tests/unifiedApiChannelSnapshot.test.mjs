/**
 * F3 · IPC 通道快照守卫（TEST-PLAN §F3，6 例，锚定数字见 TEST-PLAN §0）。
 *
 * src/shared/ipc.ts 的 ipcChannels 常量表是全部 IPC 通道的唯一来源；本测试把它的
 * 规模与形状锚定为快照（743 通道 / 85 前缀 / 排序摘要）。快照变更只允许显式发生
 * 且附领域正当理由——本轮（T4 契约层）任何快照红 = 违例。
 *
 * 2026-10-18 远端合并显式刷新（678 → 743，+65 通道，均附领域正当理由）：
 *   远端开发面 39 条 remote:*（SSH 主机/项目/文件/会话/信任/模型探测）；
 *   远端 Git 面 21 条 git:*（status/log/commit/refs/diff/compare/init/branch/recovery/fetch/push/pull/cancel-reads）；
 *   远端会话归档 3 条 sessions:*（unarchive/delete/answerDelete archived remote）；
 *   远端终端输出 ACK 1 条 terminal:acknowledge；
 *   以上 64 条为远端特性通道，另 1 条为 dev 并行演进通道（dev 已到 679）。
 * 2026-10-16 显式刷新（+4 通道，均附领域正当理由）：
 *   yaoPromptsDbState / yaoPromptsDbRetry（#2 提示词库 db 远程化：下载进度与重试）
 *   sessionsSearchContent（#3 跨会话正文全文搜索：session-index sidecar）
 *   skillHubInstallProgress（技能商店安装进度：spawn 流式解析推送）
 * 2026-10-17 显式刷新（+1 通道，附领域正当理由）：
 *   filesSearchContent（工作区文件内容检索：Go file-index sidecar；未就绪/不可用返回 null）
 * 刷新方式：entries.map(([k, v]) => `${k}=${v}`).sort().join("\n") 重算 sha256，写入 CHANNEL_DIGEST。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const CHANNEL_TOTAL = 743;
const PREFIX_COUNT = 85;
const CHANNEL_DIGEST = "ece9b935e3c1a8339383034e48d3a22df93b97ab6688afaec6205579a4878ed1";

const ipcChannels = loadTsCommonJs("src/shared/ipc.ts").ipcChannels;
const entries = Object.entries(ipcChannels);
const values = entries.map(([, value]) => value);

test("F3-1 通道常量总数 === 743", () => {
	assert.equal(entries.length, CHANNEL_TOTAL);
});

test("F3-2 通道值唯一数 === 743（无重复通道字符串）", () => {
	assert.equal(new Set(values).size, CHANNEL_TOTAL);
});

test("F3-3 全部通道值匹配 domain:action 形态", () => {
	for (const [key, value] of entries) {
		assert.match(value, /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/, `通道 ${key}=${value} 形态非法`);
	}
});

test("F3-4 key=value 排序串联 sha256 与快照摘要一致", () => {
	const serialized = entries
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join("\n");
	const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
	assert.equal(digest, CHANNEL_DIGEST);
});

test("F3-5 锚点抽查：appGetChannel=update:get-channel、sessionsBridgeEvent=sessions:bridge-event、git=59、enhance=3", () => {
	assert.equal(ipcChannels.appGetChannel, "update:get-channel");
	assert.equal(ipcChannels.sessionsBridgeEvent, "sessions:bridge-event");
	const countByPrefix = (prefix) => values.filter((value) => value.startsWith(`${prefix}:`)).length;
	assert.equal(countByPrefix("git"), 59);
	assert.equal(countByPrefix("enhance"), 3);
});

test("F3-6 通道域前缀种类 === 85", () => {
	const prefixes = new Set(values.map((value) => value.split(":")[0]));
	assert.equal(prefixes.size, PREFIX_COUNT);
});
