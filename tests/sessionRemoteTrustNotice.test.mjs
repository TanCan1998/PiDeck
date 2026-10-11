import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端会话 trust 现状提示（Phase 4 P4.2 收口第 1 项）。
 *
 * 这组用例锁两件事：
 * 1. **标记 → 提示的判据**（行为级，真 atom + 真事件）：
 *    `agents:state` 载荷带 `remoteTrustUnhandled: true` ⇒ 选择器为 true（提示渲染）；
 *    本地会话 / 旧 main 的载荷不带这个字段 ⇒ false（不渲染），且整个链路不抛错。
 * 2. **提示的形态**（源码级，本仓无 DOM 装置）：
 *    常驻 inline 条（不是一次性 toast）、双语文案 key 齐备、挂载点在会话头下方、
 *    没有为它新增手写 CSS class。
 *
 * 安全边界不在这组用例里放宽：提示只做「如实告知」，不参与任何 trust 决策
 * （不传 trust flag 的守卫在 `agentManagerRemoteRuntime.test.mjs`）。
 */
const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

const noticeSource = () => readFileSync("src/renderer/src/components/session/RemoteSessionTrustNotice.tsx", "utf8");
const viewSource = () => readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const zh = () => readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = () => readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

const SESSION_ID = "session-remote";
const AGENT_ID = "agent-remote";

/** `agents:state` 的载荷形状：主进程下发的是整条 AgentTab（远端分支会带 remoteTrustUnhandled）。 */
function agentsStateEvent(payload) {
	return {
		kind: "event",
		sessionId: SESSION_ID,
		agentId: AGENT_ID,
		runtimeGeneration: 1,
		sourceChannel: "agents:state",
		payload: {
			id: AGENT_ID,
			projectId: "project-remote",
			cwd: "/srv/remote-app",
			title: "远端会话",
			status: "idle",
			createdAt: 1,
			...payload,
		},
	};
}

test("远端会话的 agents:state 载荷带标记 ⇒ 提示判据为 true", () => {
	const store = createStore();
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: true }));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), true);
	// 标记落在会话自己的 runtime 视图状态上（按 sessionId 隔离，不是全局开关）。
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)[SESSION_ID]?.remoteTrustUnhandled, true);
});

test("本地/旧载荷不带标记 ⇒ 提示判据为 false，且不报错", () => {
	const store = createStore();
	// 情形 1：本地会话（现在的 tab 形状，压根没这个字段）
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({}));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), false);
	// 情形 2：显式 false（旧 payload / 未来的显式「已处理」形态）
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: false }));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), false);
	// 情形 3：非布尔垃圾值不得把提示点亮（IPC 载荷不可信）
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: "true" }));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), false);
	// 情形 4：没有任何 runtime 记录的会话照样返回 false，不抛错
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily("session-unknown")), false);
});

test("标记变化本身要触发 runtime 状态写入（不被「无变化」判定吞掉）", () => {
	const store = createStore();
	// 先来一条不带标记的同代事件（模拟标记到达前的状态），再来带标记的：
	// 「无变化」判定若漏比这个字段，第二次事件会被跳过写入，提示永远不出现。
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({}));
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: true }));
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), true);
});

test("标记跟着会话走：send 路径的绑定刷新不把它抹掉", () => {
	const store = createStore();
	store.set(atoms.applySessionRuntimeEventAtom, agentsStateEvent({ remoteTrustUnhandled: true }));
	// bindSessionRuntimeAtom 是「只写绑定字段」的刷新（useSessionSend 在每次发送后调用）。
	store.set(atoms.bindSessionRuntimeAtom, { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: 1, status: "running" });
	assert.equal(store.get(atoms.sessionRemoteTrustUnhandledAtomFamily(SESSION_ID)), true);
});

test("提示条：常驻 inline + 文案走 i18n + 无标记整体不渲染", () => {
	const notice = noticeSource();
	// 判据来自按 sessionId 隔离的选择器，缺失/为假时直接 return null（不渲染、不报错）
	assert.match(notice, /sessionRemoteTrustUnhandledAtomFamily\(props\.sessionId\)/);
	assert.match(notice, /if \(!remoteTrustUnhandled\) return null;/);
	// 双语文案 key（JSX 里禁止硬编码中英文）
	assert.match(notice, /t\("session\.remoteTrust\.title"\)/);
	assert.match(notice, /t\("session\.remoteTrust\.hint"\)/);
	// 常驻 inline 条：不是一次性 toast（代码里不引 notice 工具/不弹窗；断言前先剥掉注释，
	// 因为「不是一次性 toast」这句说明本身出现在注释里）。
	const noticeCode = notice.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/[^\n]*/gm, "");
	assert.doesNotMatch(noticeCode, /showNotice|utils\/notice|toast/i);
	// 会话头下方的挂载点（与分支条同层，时间线/引导页都在它下面）
	assert.match(viewSource(), /<RemoteSessionTrustNotice sessionId=\{sessionId\} \/>/);
});

test("两条文案在两个 locale 字典里都存在且非空", () => {
	for (const locale of [zh(), en()]) {
		assert.match(locale, /"session\.remoteTrust\.title": "/);
		assert.match(locale, /"session\.remoteTrust\.hint": "[^"]+/);
	}
	assert.match(zh(), /"session\.remoteTrust\.hint": "[^"]*远端项目目录里的 \.pi 资源[^"]*"/);
	assert.match(en(), /"session\.remoteTrust\.hint": "[^"]*\.pi resources[^"]*"/);
});

test("提示用既有 Tailwind 语义 token，没有为它新增手写 CSS class", () => {
	const notice = noticeSource();
	assert.match(notice, /border-border-subtle/);
	assert.match(notice, /bg-bg-panel/);
	for (const name of readdirSync("src/renderer/src/styles")) {
		if (!name.endsWith(".css")) continue;
		assert.doesNotMatch(readFileSync(join("src/renderer/src/styles", name), "utf8"), /remote-?trust/i, `${name} 不应为远端 trust 提示新增手写 class`);
	}
});
