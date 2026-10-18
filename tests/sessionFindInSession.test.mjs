/**
 * 会话内查找（useSessionMessageSearch）的请求生命周期回归。
 *
 * 这条链路是「输入框 → 160ms 防抖 → sessions:search-in-session → 命中列表 → 上下跳」，
 * 出错形态都很安静：切会话后迟到回包贴到新会话、null（索引未就绪）被当成「没有匹配」、
 * 查询清空后旧命中还留在列表里。这里用确定性 React 宿主 + window.piDesktop 替身钉住这些行为。
 *
 * 读状态前必须 h.render()：宿主把 state 快照进返回值，setState 不触发重渲染。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function hookHarness() {
	const host = quickMessageHookHost();
	const calls = [];
	const windowStub = {
		piDesktop: {
			sessions: {
				searchInSession: (sessionPath, query) => {
					const call = { sessionPath, query };
					calls.push(call);
					return new Promise((resolve, reject) => {
						call.resolve = resolve;
						call.reject = reject;
					});
				},
			},
		},
	};
	const { useSessionMessageSearch, SESSION_FIND_DEBOUNCE_MS, SESSION_FIND_MIN_QUERY_LENGTH } = loadTsCommonJs("src/renderer/src/hooks/useSessionMessageSearch.ts", {
		stubs: { react: host.react },
		globals: { window: windowStub },
	});

	let state = null;
	const render = (sessionPath, query, enabled = true) => (state = host.render(() => useSessionMessageSearch(sessionPath, query, enabled)));
	return { host, calls, render, view: () => state, SESSION_FIND_DEBOUNCE_MS, SESSION_FIND_MIN_QUERY_LENGTH };
}

const HIT = {
	sessions: [{ filePath: "C:/s/a.jsonl", updatedAtMs: 1, matches: [{ messageId: "m1", role: "user", timestampMs: 1, snippet: "alpha 命中" }], hitCount: 1 }],
	totalHitSessions: 1,
	truncated: false,
};

test("输入停顿防抖后按会话文件路径发起检索，并落命中结果", async () => {
	const h = hookHarness();
	h.render("C:/s/a.jsonl", "alpha");
	await flush();
	// 防抖期内不发请求，且立刻进入「查找中」
	assert.equal(h.calls.length, 0);
	h.render("C:/s/a.jsonl", "alpha");
	assert.equal(h.view().isSearching, true);
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].sessionPath, "C:/s/a.jsonl");
	assert.equal(h.calls[0].query, "alpha");
	h.calls[0].resolve(HIT);
	await flush();
	h.render("C:/s/a.jsonl", "alpha");
	assert.equal(h.view().result.sessions[0].matches[0].messageId, "m1");
	assert.equal(h.view().isSearching, false);
	assert.equal(h.view().unavailable, false);
	h.host.unmount();
});

test("主进程返回 null（索引未就绪/降级）标为 unavailable，而不是「没有匹配」", async () => {
	const h = hookHarness();
	h.render("C:/s/a.jsonl", "alpha");
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	h.calls[0].resolve(null);
	await flush();
	h.render("C:/s/a.jsonl", "alpha");
	assert.equal(h.view().result, null);
	assert.equal(h.view().unavailable, true);
	h.host.unmount();
});

test("切会话后迟到回包被丢弃：上一个会话的命中不会贴到新会话", async () => {
	const h = hookHarness();
	h.render("C:/s/a.jsonl", "alpha");
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	assert.equal(h.calls.length, 1);
	// 切到另一个会话（同一关键词）：新一代请求发出
	h.render("C:/s/b.jsonl", "alpha");
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[1].sessionPath, "C:/s/b.jsonl");
	// 新的一代先回
	h.calls[1].resolve({ ...HIT, sessions: [{ ...HIT.sessions[0], filePath: "C:/s/b.jsonl", matches: [{ ...HIT.sessions[0].matches[0], messageId: "b1" }] }] });
	await flush();
	h.render("C:/s/b.jsonl", "alpha");
	assert.equal(h.view().result.sessions[0].matches[0].messageId, "b1");
	// 旧一代后回：必须被丢弃
	h.calls[0].resolve(HIT);
	await flush();
	h.render("C:/s/b.jsonl", "alpha");
	assert.equal(h.view().result.sessions[0].matches[0].messageId, "b1");
	h.host.unmount();
});

test("空查询与关闭（enabled=false）都不发请求且清空结果", async () => {
	const h = hookHarness();
	h.render("C:/s/a.jsonl", "");
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	assert.equal(h.calls.length, 0);
	assert.equal(h.view().result, null);
	assert.equal(h.view().isSearching, false);

	h.render("C:/s/a.jsonl", "alpha", false);
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	assert.equal(h.calls.length, 0, "浮层收起时不检索");
	h.host.unmount();
});

test("请求失败只把状态标为 unavailable，不抛出到渲染层", async () => {
	const h = hookHarness();
	h.render("C:/s/a.jsonl", "alpha");
	await new Promise((resolve) => setTimeout(resolve, h.SESSION_FIND_DEBOUNCE_MS + 20));
	h.calls[0].reject(new Error("ipc boom"));
	await flush();
	h.render("C:/s/a.jsonl", "alpha");
	assert.equal(h.view().unavailable, true);
	assert.equal(h.view().isSearching, false);
	h.host.unmount();
});

test("渠道与契约接线：IPC 常量、preload 白名单、主进程 handler、快捷键与装配点齐全", async () => {
	const { readFileSync } = await import("node:fs");
	const read = (path) => readFileSync(path, "utf8");
	const ipc = read("src/shared/ipc.ts");
	assert.match(ipc, /sessionsSearchInSession:\s*"sessions:search-in-session"/);
	const preload = read("src/preload/index.ts");
	assert.match(preload, /searchInSession:\s*\(sessionPath: string, query: string\) => ipcRenderer\.invoke\(ipcChannels\.sessionsSearchInSession, sessionPath, query\)/);
	const handler = read("src/main/ipc/sessionIpc.ts");
	// 入参校验：路径必须像会话文件（.jsonl），查询长度有上界
	assert.match(handler, /ipcMain\.handle\(ipcChannels\.sessionsSearchInSession/);
	assert.match(handler, /\\\.jsonl\$\/i\.test\(trimmedPath\)/);
	assert.match(handler, /trimmed\.length > 256/);
	// 短路：未装配 / 校验不过一律 null（渲染层据此显示不可用态）
	assert.match(handler, /const searcher = deps\.sessionMessageSearch;\s*\n\s*if \(!searcher\) return null;/);
	const wiring = read("src/main/index.ts");
	assert.match(wiring, /sessionMessageSearch: async \(sessionPath, query\) => \{[\s\S]{0,600}?sessionIndexService\.searchInSession\(roots, sessionPath, query\)/);
	// 主进程快捷键分支 + 聚焦栏响应
	assert.match(wiring, /isShortcutInput\("findInSession", input\)[\s\S]{0,200}?"findInSession"/);
	const shortcuts = read("src/shared/shortcuts.ts");
	assert.match(shortcuts, /id: "findInSession"[\s\S]{0,400}?other: "Ctrl\+Shift\+F"/);
	const pane = read("src/renderer/src/components/session/ChatSessionPane.tsx");
	assert.match(pane, /id !== "findInSession"/);
	assert.match(pane, /<SessionFindOverlay/);
	assert.match(pane, /sessionId=\{record\?\.filePath \?\? sessionId\}/);
	// 锚点必须是本栏消息区（时间线视口）：锚整栏聊天区会让图标落到窗口关闭键那一行
	assert.match(pane, /anchorRef=\{sessionTimeline\.timelineRef\}/);
	assert.doesNotMatch(pane, /layoutRefs\.chatPaneRef/);
	// Go 侧协议与单文件过滤
	const goMain = read("native/session-index/main.go");
	assert.match(goMain, /case "search-session":/);
	assert.match(goMain, /empty path/);
	const goSearch = read("native/session-index/search.go");
	assert.match(goSearch, /func \(ix \*Indexer\) SearchInSession\(query, sessionPath string, limit int\) searchResult/);
	assert.match(goSearch, /if e\.fileRef == fileID/);
});

// ── 浮层锚点（纯函数）──────────────────────────────────────────────────
// 历史上的搜索弹框就是「落点算到屏幕外」；这里把换算逻辑从组件里抽出来钉住。

test("浮层锚点：聊天区右侧有抽屉时贴聊天区右缘，而不是视口右缘", async () => {
	const { resolveSessionFindAnchor } = loadTsCommonJs("src/renderer/src/components/session/sessionFindAnchor.ts");
	// 视口 1600，聊天区右缘 1200（右侧抽屉 400），顶 48（顶栏）
	const anchor = resolveSessionFindAnchor({ top: 48, right: 1200, width: 800 }, { width: 1600, height: 900 });
	assert.deepEqual({ ...anchor }, { top: 60, right: 412 });
});

test("浮层锚点：锚点未就绪/宽度为 0 时退回视口右上角下方（永不落到屏幕外或压住窗口控件）", async () => {
	const { resolveSessionFindAnchor, SESSION_FIND_TITLEBAR_MIN_TOP } = loadTsCommonJs("src/renderer/src/components/session/sessionFindAnchor.ts");
	assert.deepEqual({ ...resolveSessionFindAnchor(null, { width: 1200, height: 900 }) }, { top: SESSION_FIND_TITLEBAR_MIN_TOP, right: 12 });
	assert.deepEqual({ ...resolveSessionFindAnchor({ top: 100, right: 800, width: 0 }, { width: 1200, height: 900 }) }, { top: SESSION_FIND_TITLEBAR_MIN_TOP, right: 12 });
});

test("浮层锚点：聊天区顶到窗口上沿时也不落进窗口控件条（关闭键位置）", async () => {
	const { resolveSessionFindAnchor, SESSION_FIND_TITLEBAR_MIN_TOP } = loadTsCommonJs("src/renderer/src/components/session/sessionFindAnchor.ts");
	// 自定义标题栏下聊天区矩形 top=0、右缘=视口宽：旧实现在这里把搜索图标叠到关闭键上
	const anchor = resolveSessionFindAnchor({ top: 0, right: 1600, width: 800 }, { width: 1600, height: 900 });
	assert.equal(anchor.right, 12);
	assert.equal(anchor.top, SESSION_FIND_TITLEBAR_MIN_TOP);
	assert.ok(anchor.top >= 40, "必须落在 40px 高的窗口控件条之下");
});

test("浮层锚点：异常矩形被夹在视口内（负 right / 超出高度都不会出屏）", async () => {
	const { resolveSessionFindAnchor } = loadTsCommonJs("src/renderer/src/components/session/sessionFindAnchor.ts");
	// 锚点右缘超过视口宽（窗口刚缩小的陈旧 rect）→ right 收到底线 12
	assert.equal(resolveSessionFindAnchor({ top: 10, right: 5000, width: 800 }, { width: 1200, height: 900 }).right, 12);
	// 锚点 top 超过视口高 → top 收到 height-12
	assert.equal(resolveSessionFindAnchor({ top: 5000, right: 800, width: 800 }, { width: 1200, height: 900 }).top, 888);
});

// ── 入口渲染（真实组件，portal 到 body）────────────────────────────────
// 「会话内搜索在哪」的答案就是这个常驻放大镜按钮：它必须默认就出现在聊天区右上角，
// 而不是等某个状态才挂载（否则用户永远找不到入口）。

test("入口按钮真实渲染：默认常驻、portal 到 body、带可访问名称", async () => {
	const { createElement } = await import("react");
	const { renderToStaticMarkup } = await import("react-dom/server");
	const portals = [];
	const { SessionFindOverlay } = loadTsCommonJs("src/renderer/src/components/session/SessionFindOverlay.tsx", {
		stubs: {
			"../../i18n": { t: (key) => key },
			"../../hooks/useSessionMessageSearch": { SESSION_FIND_MIN_QUERY_LENGTH: 1, useSessionMessageSearch: () => ({ result: null, isSearching: false, unavailable: false }) },
			"../ui-shadcn/button": { Button: ({ children, ...rest }) => createElement("button", rest, children) },
			"../ui-shadcn/input": { Input: (props) => createElement("input", props) },
			"lucide-react": { Search: () => null, ChevronUp: () => null, ChevronDown: () => null, X: () => null },
			"react-dom": {
				createPortal: (children, container) => {
					portals.push({ children, container });
					return null;
				},
			},
		},
		globals: { window: { innerWidth: 1200, innerHeight: 900, addEventListener: () => undefined, removeEventListener: () => undefined }, document: { body: { tag: "body" } } },
	});
	renderToStaticMarkup(createElement(SessionFindOverlay, { sessionId: "C:/s/a.jsonl", anchorRef: { current: null }, openSignal: 0, onJump: () => undefined }));
	assert.equal(portals.length, 1);
	assert.equal(portals[0].container.tag, "body");
	const html = renderToStaticMarkup(portals[0].children);
	assert.match(html, /aria-label="sessionFind\.open"/);
	assert.match(html, /title="sessionFind\.open"/);
});
