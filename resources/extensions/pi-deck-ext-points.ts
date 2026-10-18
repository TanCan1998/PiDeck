/**
 * pi-deck-ext-points —— 扩展点面板（pi 扩展，内置到 PiDeck）。
 *
 * ## 它解决什么问题
 *
 * 写 pi 扩展最难的一步不是写代码，而是**说清自己要挂在哪**：「挂载点」「事件名」
 * 这些标识符散在运行时里，靠记靠猜都容易写错。这个扩展把 pi + PiDeck 的
 * 可挂载点摆出来，标好桥接状态，勾完生成一份可以直接交给 agent 的草稿。
 *
 * ## 数据全部**运行时推导**，零同步
 *
 * 这是刻意的设计选择 —— 之前那版把清单做成构建期快照 + 一份手写文档，
 * 结果 pi / PiDeck 一升级就要手动同步两处，还漏过一次。
 *
 * | 类别 | 来源 | 为什么不用快照 |
 * |---|---|---|
 * | `ctx.ui.*` 方法 | 运行时读 pi 的 `types.d.ts` | 永远与当前 pi 一致 |
 * | pi 扩展事件 | 同上（扫 `ExtensionAPI.on()` 签名） | 同上 |
 * | `ctx.gui.*` 落点 | **import 桥的 spec 模块** | 同一个源文件，天然不漂 |
 *
 * 读 `.d.ts` 失败时**降级为只列桥的落点**，不报错、不影响会话。
 *
 * ## 为什么能读 .d.ts
 *
 * 扩展跑在 pi 的 Node 进程里，`fs` 可用。pi 的安装位置由桥的
 * `piTuiResolvedPath()` 反推（它已经解析过 pi-tui 的绝对路径）。
 *
 * ## 状态归属
 *
 * 勾选、分组折叠、每行「说明/收起」、每行用途与草稿名称都是**这个扩展自己的 UI 状态**，
 * 存在 pi 进程的闭包里 —— 既不写 pi 配置（那会让顶部「保存」按钮变脏），也不写 localStorage
 * （扩展跑在 pi 进程，碰不到渲染层的存储）。
 * 代价：pi 进程重启后勾选清空。可接受 —— 它本来就是「构思草稿」的临时状态。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GUI_SLOT_METHODS } from "./pi-deck-gui-bridge-gui-spec";
import { locatePiTui, piTuiResolvedPath } from "./pi-deck-gui-bridge-tui";

const SECTION_KEY = "ext-points";
const DRAFT_NAME_MAX = 60;

/** 一个可挂载点。 */
type ExtPoint = {
	/** 稳定 id：草稿里用它，也是勾选状态的键。 */
	id: string;
	/** 分组：ui 方法 / 事件 / GUI 落点。 */
	group: "ui" | "event" | "gui";
	/** 展示用标识符（`ctx.ui.setStatus` / `tool_call` / `ctx.gui.setBanner`）。 */
	label: string;
	/** 调用形态（草稿里带上，agent 不用猜参数）。 */
	signature?: string;
	/** 在 PiDeck 里的桥接状态。 */
	status?: "wired" | "passthrough" | "not-bridged";
	/** 一句话说明。 */
	note?: string;
};

// ── 1. 定位 pi 的 types.d.ts ────────────────────────────────────

/**
 * 从某个路径往上找 `<pi 包>/dist/core/extensions/types.d.ts`。
 * seed 可以是文件（如 pi-tui 的 dist/index.js）或目录（如 cli.js 所在目录）。
 */
function walkUpForTypesDts(seed: string): string | null {
	let dir = dirname(seed);
	for (let depth = 0; depth < 10; depth += 1) {
		const candidate = join(dir, "dist", "core", "extensions", "types.d.ts");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * 定位 pi 的 types.d.ts。
 *
 * 原先只看桥那边的 pi-tui 解析缓存（`piTuiResolvedPath()`），但那是**跨模块赌博**：
 * 两个扩展各自 import `pi-deck-gui-bridge-tui` 时未必共享同一份模块实例，
 * ext-points 自己没 locatePiTui 过就永远拿到 null，于是清单永久降级为只列 PiDeck 专属落点（当时 14 个）。
 *
 * 现在自给自足，按代价从低到高试三个种子：
 * 1. 桥已定位的 pi-tui 路径（热缓存，零成本）
 * 2. 自己 locatePiTui 一次（拿到本实例的解析结果；失败不报错）
 * 3. `process.argv[1]` —— pi 的 cli.js 路径（桥日志已证其含 pi-coding-agent）
 */
function resolvePiTypesDts(): string | null {
	const fromBridgeCache = piTuiResolvedPath();
	if (fromBridgeCache) {
		const hit = walkUpForTypesDts(fromBridgeCache);
		if (hit) return hit;
	}
	try {
		const located = locatePiTui();
		const fromSelf = located.path;
		if (fromSelf) {
			const hit = walkUpForTypesDts(fromSelf);
			if (hit) return hit;
		}
	} catch {
		// 自己定位失败不影响会话，继续走 argv 兜底
	}
	const entry = process.argv[1];
	if (entry) {
		const hit = walkUpForTypesDts(entry);
		if (hit) return hit;
	}
	return null;
}

// ── 2. 从 .d.ts 抽 ui 方法与事件 ────────────────────────────────

/** 抽 `ExtensionUIContext` 的成员（方法签名 + 只读属性）。 */
function parseUiPoints(source: string): ExtPoint[] {
	const block = source.match(/export interface ExtensionUIContext \{([\s\S]*?)\n\}/);
	if (!block) return [];
	const body = block[1];
	const points: ExtPoint[] = [];
	// 泛型参数要容忍 —— `custom<T>(...)` 就是这种，漏了它会少一个点
	for (const m of body.matchAll(/^\s{4}(\w+)\s*(<[^>]*>)?\s*\(([\s\S]*?)\)\s*:\s*([^;]+);/gm)) {
		const params = m[3].replace(/\s+/g, " ").trim();
		points.push({
			id: `ui:${m[1]}`,
			group: "ui",
			label: `ctx.ui.${m[1]}`,
			signature: `${m[1]}(${params}): ${m[4].replace(/\s+/g, " ").trim()}`,
		});
	}
	for (const m of body.matchAll(/^\s{4}readonly\s+(\w+)\s*:\s*([^;]+);/gm)) {
		points.push({ id: `ui:${m[1]}`, group: "ui", label: `ctx.ui.${m[1]}`, signature: `readonly ${m[1]}: ${m[2].trim()}` });
	}
	return points;
}

/**
 * 抽 pi 的扩展事件名。
 *
 * 扫 `ExtensionAPI` 的 `on(event: "...")` 签名，**不扫**各 `XxxEvent` 接口的
 * `type` 字面量 —— 后者会漏掉没有简单字面量的那几个（实测漏 3 个）。
 */
function parseEvents(source: string): ExtPoint[] {
	const api = source.match(/export interface ExtensionAPI \{([\s\S]*?)\n\}/);
	if (!api) return [];
	const names = new Set<string>();
	for (const m of api[1].matchAll(/on\(event:\s*"([^"]+)"/g)) names.add(m[1]);
	return [...names].sort().map((name) => ({ id: `event:${name}`, group: "event", label: name, signature: `pi.on("${name}", handler)` }));
}

// ── 3. 桥的 GUI 落点（同源，不漂）──────────────────────────────

/** 每个落点的桥接状态与一句话说明（策展，人工维护但**只有这一处**）。 */
const GUI_SLOT_META: Record<string, { note: string }> = {
	"sidebar.panel": { note: "侧边栏面板列表" },
	"sidebar.section": { note: "侧边栏内分区" },
	"content.view": { note: "主内容区" },
	"composer.toolbar": { note: "输入框工具栏" },
	"titlebar.action": { note: "窗口/标签栏动作按钮" },
	banner: { note: "顶部横幅通知区" },
	"tool.extra": { note: "工具结果卡内部（key = toolName）" },
	"message.extra": { note: "消息气泡内部下方（key = role）" },
	"thinking.extra": { note: "折叠思考块内" },
	"dialog.action": { note: "交互对话框按钮区" },
	"dialog.body": { note: "交互对话框主体下方" },
	"settings.section": { note: "设置弹窗内" },
	"config.page": { note: "「Pi 管理」侧栏的独立整页" },
	"session.item": { note: "会话列表条目" },
	"context.menu": { note: "右键菜单" },
	"timeline.event": { note: "会话时间线底部的事件条" },
	"statusbar.item": { note: "底部状态栏条目" },
	"terminal.toolbar": { note: "终端面板工具栏" },
	"git.panel.section": { note: "Git 面板分区" },
};

function buildGuiPoints(): ExtPoint[] {
	return Object.entries(GUI_SLOT_METHODS).map(([method, slot]) => ({
		id: `gui:${slot}`,
		group: "gui" as const,
		label: `ctx.gui.${method}`,
		signature: `${method}(key, factory, opts?)  →  落点 "${slot}"`,
		status: "wired" as const,
		note: GUI_SLOT_META[slot]?.note,
	}));
}

/**
 * pi 原生扩展点在 PiDeck 里的处理方式。
 *
 * 这份表**必须人工维护** —— 「桥对某个 pi 方法做了什么」是实现事实，推不出来。
 * 但它是**唯一一处**：面板、草稿都读它，不再另存文档。
 */
const UI_HANDLING: Record<string, { status: ExtPoint["status"]; note: string }> = {
	setStatus: { status: "wired", note: "全量接管为状态栏条目（多 key 共存）" },
	setWidget: { status: "wired", note: "字符串形式保持原路；组件形式由桥接" },
	setFooter: { status: "wired", note: "底部状态区" },
	setHeader: { status: "wired", note: "聊天区顶部" },
	setWorkingMessage: { status: "wired", note: "流式状态行文案" },
	setWorkingVisible: { status: "wired", note: "流式状态行显隐" },
	setWorkingIndicator: { status: "wired", note: "流式状态行指示器" },
	setHiddenThinkingLabel: { status: "wired", note: "折叠思考块标签" },
	setTitle: { status: "wired", note: "会话标题（document.title）" },
	select: { status: "passthrough", note: "PiDeck 已有时间线卡片" },
	confirm: { status: "passthrough", note: "PiDeck 已有确认卡片" },
	input: { status: "passthrough", note: "PiDeck 已有输入卡片" },
	notify: { status: "passthrough", note: "PiDeck 已有 toast" },
	editor: { status: "passthrough", note: "PiDeck 已有多行编辑器弹框" },
	pasteToEditor: { status: "passthrough", note: "走 setEditorText 原路" },
	// 注：桥的 createGuiNamespace 是显式列举（不是 Proxy 透传 ctx.ui），没有 setEditorText；
	// 在 PiDeck 里取不到这个方法，所以草稿改为在面板内展示 + 复制。
	setEditorText: { status: "passthrough", note: "pi 原生方法；桥未透传（PiDeck 面板里取不到）" },
	getEditorText: { status: "passthrough", note: "同步读，RPC 下返回空串" },
	getEditorComponent: { status: "passthrough", note: "RPC 下恒返回 undefined" },
	getToolsExpanded: { status: "passthrough", note: "已有落点" },
	setToolsExpanded: { status: "passthrough", note: "已有落点" },
	theme: { status: "passthrough", note: "桥另供一份哨兵 theme" },
	getAllThemes: { status: "passthrough", note: "RPC 下返回空数组" },
	getTheme: { status: "passthrough", note: "RPC 下返回 undefined" },
	setTheme: { status: "passthrough", note: "RPC 下返回失败" },
	custom: { status: "not-bridged", note: "画的是字符行；GUI 对应物是 ctx.gui.custom()" },
	onTerminalInput: { status: "not-bridged", note: "GUI 里没有终端" },
	addAutocompleteProvider: { status: "not-bridged", note: "GUI 输入框有自己的补全机制" },
	setEditorComponent: { status: "not-bridged", note: "拦截但不替换：草稿状态在 PiDeck 侧，替换会做出死控件" },
};

// ── 4. 汇总 ─────────────────────────────────────────────────────

type Catalog = { points: ExtPoint[]; piVersion: string | null; typesPath: string | null };

/** 读一次 pi 的 .d.ts 并组装清单；失败则降级为只列桥的落点。 */
function loadCatalog(): Catalog {
	const typesPath = resolvePiTypesDts();
	const guiPoints = buildGuiPoints();
	if (!typesPath) {
		return { points: guiPoints, piVersion: null, typesPath: null };
	}
	try {
		const source = readFileSync(typesPath, "utf8");
		const uiPoints = parseUiPoints(source).map((point) => {
			const name = point.id.slice("ui:".length);
			const handling = UI_HANDLING[name];
			return { ...point, status: handling?.status ?? ("passthrough" as const), note: handling?.note };
		});
		return { points: [...uiPoints, ...parseEvents(source), ...guiPoints], piVersion: readPiVersion(typesPath), typesPath };
	} catch {
		return { points: guiPoints, piVersion: null, typesPath: null };
	}
}

/** 从 pi 包目录读版本号（诊断用）。 */
function readPiVersion(typesPath: string): string | null {
	let dir = dirname(typesPath);
	for (let depth = 0; depth < 8; depth += 1) {
		const pkg = join(dir, "package.json");
		if (existsSync(pkg)) {
			try {
				const parsed = JSON.parse(readFileSync(pkg, "utf8"));
				if (parsed?.name === "@earendil-works/pi-coding-agent" && typeof parsed.version === "string") return parsed.version;
			} catch {
				// 继续向上找
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// ── 5. 草稿生成 ─────────────────────────────────────────────────

/** 勾选顺序 = 草稿编号顺序（不是列表顺序）。 */
function buildDraft(selectedIds: string[], purposes: Map<string, string>, name: string, catalog: Catalog): string {
	const byId = new Map(catalog.points.map((p) => [p.id, p]));
	const lines: string[] = [];
	lines.push(`扩展名称和大概功能：${name.trim() || "（未命名，请先问我）"}`);
	lines.push("");
	lines.push("本次扩展需要依赖的扩展点：");
	let index = 0;
	for (const id of selectedIds) {
		const point = byId.get(id);
		if (!point) continue; // 已下线的点跳过，不渲染成 undefined
		index += 1;
		lines.push(`${index}. ${point.label}`);
		if (point.signature) lines.push(`   - 签名：${point.signature}`);
		if (point.note) lines.push(`   - 说明：${point.note}`);
		lines.push(`   - 主要用来：${purposes.get(id)?.trim() || "（未填写，请先问我这块具体想做什么）"}`);
	}
	if (index === 0) lines.push("（还没勾选任何扩展点）");
	lines.push("");
	lines.push("约束提示：这些只是我的初步构想，如果你开发过程中有依赖需要增删，可以先询问。");
	lines.push("");
	lines.push("## 参考文档");
	lines.push("- docs/gui-extension-bridge.md（ctx.ui / ctx.gui 完整 API、移植指南与不映射点）");
	lines.push("");
	// 置底提示：防作者把这份清单当「完备清单」照搬
	lines.push("注意：上面勾选的扩展点**未必是全部扩展点**，勾选的扩展点主要起指引作用，你需要根据扩展的开发需求自行选择。");
	return lines.join("\n");
}

// ── 6. 面板渲染 ─────────────────────────────────────────────────

const GROUP_TITLE: Record<ExtPoint["group"], string> = { ui: "pi 原生 UI 扩展点", event: "pi 扩展事件", gui: "PiDeck 专属落点" };

/** 分组顺序（折叠按钮的排列顺序）。 */
const GROUPS: readonly { id: ExtPoint["group"]; title: string }[] = [
	{ id: "ui", title: GROUP_TITLE.ui },
	{ id: "event", title: GROUP_TITLE.event },
	{ id: "gui", title: GROUP_TITLE.gui },
];

const STATUS_TONE: Record<string, "success" | "muted" | "danger"> = { wired: "success", passthrough: "muted", "not-bridged": "danger" };
const STATUS_LABEL: Record<string, string> = { wired: "已桥接", passthrough: "走原路", "not-bridged": "GUI 里没反应" };

/** 渲染层 `key` 事件回灌的 payload 是**键名**（见桥的 `eventPayload`）—— 别把它当输入值。 */
const KEY_NAMES = new Set(["enter", "escape", "tab", "backspace", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

/** 取出输入框回灌的值：`key` 事件给的是键名（回车等），不是输入内容，丢弃。 */
function inputValueOf(payload: unknown): string | undefined {
	return typeof payload === "string" && !KEY_NAMES.has(payload.toLowerCase()) ? payload : undefined;
}

/**
 * 渲染面板。
 *
 * 勾选状态与搜索词存在闭包里（pi 进程内存），点击/输入通过 `actionId` 回灌到 `handleAction`。
 *
 * **折叠由渲染器持有**（桥的 `collapse` 节点，v1.1.1）：展开/收起是纯本地交互 ——
 * 不走一次 pi 往返，也不会因为重推被重置。所以这里**不再**维护 openGroups/expanded，
 * 扩展只在勾选/搜索变化时推新树。
 *
 * 节点 id 一律用**语义 id**（`cb:<point.id>` 而不是自增序号）：扩展每次重推的是整棵树，
 * 而渲染层靠 id 当 React key 保住折叠态与输入回显；用自增序号的话，搜索过滤一改变、
 * 前面节点一增删，后面所有节点的 key 都会漂移，折叠态和输入框都会被重置。
 */
function sid(prefix: string, key: string): string {
	return `${prefix}:${key}`;
}

function renderPanel(catalog: Catalog, selected: Set<string>, purposes: Map<string, string>, query: string, draftName: string, draftText: string): unknown {
	const keyword = query.trim().toLowerCase();
	const matched = (point: ExtPoint): boolean =>
		!keyword || [point.label, point.id, point.signature, point.note].some((field) => (field ?? "").toLowerCase().includes(keyword));
	const hitGroups = GROUPS.map((group) => ({ group, points: catalog.points.filter((p) => p.group === group.id && matched(p)) })).filter((entry) => entry.points.length > 0);

	// 头部 + 搜索都走**宿主原生设置行**（§2 直接复用 PiDeck UI）：
	// 字号 / 行高 / 分隔线 / 260px 控件列全由 SettingRow 决定，这里不拼样式。
	const children: unknown[] = [
		{
			kind: "setting-row",
			id: "head",
			level: 1,
			title: "扩展点",
			description: catalog.typesPath
				? `共 ${catalog.points.length} 个可挂载点 · 快照来源 pi ${catalog.piVersion}（运行时读取，无构建期快照）`
				: `共 ${catalog.points.length} 个可挂载点 · 未读到 pi 类型定义`,
			children: [{ kind: "button", id: "btn-collapse", label: "收起", variant: "ghost", actionId: "collapse" }],
		},
		// 单列堆叠（stacked）：输入框占满整行，与设置页其它长文本项一致。
		// 本地态输入（`local: true`）：先本地回显再上报；否则每个键都要等一次 pi 往返，打字会丢字
		{
			kind: "setting-row",
			id: "search-row",
			stacked: true,
			title: "搜索",
			description: "按名称 / 签名 / 说明过滤",
			children: [{ kind: "input", id: "search", value: query, placeholder: "搜索名称 / 签名 / 说明", local: true, actionId: "search" }],
		},
	];
	if (!catalog.typesPath) {
		children.push({ kind: "banner", id: "warn", tone: "warning", message: "读不到 pi 的类型定义，只列出 PiDeck 专属落点。pi 升级后重开会话即可。" });
	}

	if (hitGroups.length === 0) {
		children.push({ kind: "setting-row", id: "empty", title: "没有匹配项", description: `没有匹配「${query}」的挂载点。`, children: [] });
	} else {
		const rows: unknown[] = [];
		for (const { group, points } of hitGroups) {
			// 每个点 = 一条原生设置行：左列标题+签名说明，右列开关；勾选后再补一条
			// 单列堆叠行放「主要用来」输入框。不再自拼 hstack/badge 的三行小格子。
			const body = points.flatMap((point): unknown[] => {
				const chosen = selected.has(point.id);
				const detail = [point.signature, point.note ? `　${point.note}` : ""].filter(Boolean).join("　");
				const controls: unknown[] = [{ kind: "switch", id: sid("cb", point.id), label: "", checked: chosen, local: true, actionId: `toggle:${point.id}` }];
				if (point.status) controls.push({ kind: "badge", id: sid("bd", point.id), label: STATUS_LABEL[point.status] ?? point.status, tone: STATUS_TONE[point.status] ?? "muted" });
				const out: unknown[] = [{ kind: "setting-row", id: sid("row", point.id), title: point.label, description: detail || undefined, children: controls }];
				if (chosen) {
					out.push({
						kind: "setting-row",
						id: sid("pur", point.id),
						stacked: true,
						title: "主要用来",
						children: [{ kind: "input", id: sid("purpose", point.id), value: purposes.get(point.id) ?? "", placeholder: "一句话：它在这个扩展里承担什么", local: true, actionId: `purpose:${point.id}` }],
					});
				}
				return out;
			});
			// 分组默认收起（82 个点全展开会把设置页顶穿）；搜索命中时自动展开，结果即时可见
			rows.push({ kind: "collapse", id: sid("grp", group.id), label: group.title, count: points.length, collapsed: !keyword, children: body });
		}
		// 列表封高（px）：不会把设置弹窗顶穿；页脚（已选 / 草稿）常驻可见
		children.push({ kind: "scroll", id: "list", maxHeight: 220, children: rows });
	}

	// 名称输入同样是本地态：敲键不重推整棵树，只在生成草稿时读取（见 handleAction 的 draft-name 分支）
	children.push({
		kind: "setting-row",
		id: "draft-name-row",
		stacked: true,
		title: "扩展名称",
		description: "留空则按勾选内容自动命名",
		children: [{ kind: "input", id: "draft-name", value: draftName, placeholder: "扩展名称（可选）", local: true, actionId: "draft-name" }],
	});
	children.push({
		kind: "setting-row",
		id: "actions",
		title: `已选 ${selected.size} 项`,
		children: [
			{ kind: "button", id: "btn-draft", label: "生成草稿", variant: "solid", actionId: "draft", disabled: selected.size === 0 },
			{ kind: "button", id: "btn-clear", label: "清空勾选", variant: "ghost", actionId: "clear", disabled: selected.size === 0 },
		],
	});

	// 草稿在面板内展示（原先想写进聊天输入框，但那个输入框被配置弹窗盖着；
	// 且桥的 gui 命名空间没有 setEditorText —— 面板内展示 + 复制按钮才是真能用的路径）
	if (draftText) {
		children.push({
			kind: "setting-row",
			id: "draft-ready",
			stacked: true,
			title: "草稿已生成",
			description: "点右上角「复制」带走，粘给 agent 即可",
			children: [{ kind: "codeblock", id: "draft-text", code: draftText }],
		});
	}

	return { kind: "setting-box", id: "ext-points-card", children };
}

// ── 7. 扩展入口 ─────────────────────────────────────────────────

export default function piDeckExtPoints(pi: ExtensionAPI): void {
	// 勾选顺序即草稿编号顺序 —— 用数组保序，Set 只用于 O(1) 查
	let selectedOrder: string[] = [];
	const selected = new Set<string>();
	const purposes = new Map<string, string>();
	let draftName = "";
	/** 已生成的草稿（面板内展示）。清空勾选时一并清掉，避免拿着旧草稿。 */
	let draftText = "";
	/** 搜索词（本地态输入框回灌）。 */
	let query = "";
	let catalog: Catalog | null = null;
	/** 是否已挂载（贡献已设置）。 */

	const log = (message: string): void => {
		process.stderr.write(`[pi-deck-ext-points] ${message}\n`);
	};

	function ensureCatalog(): Catalog {
		if (!catalog) {
			catalog = loadCatalog();
			log(`清单已加载：${catalog.points.length} 个点${catalog.piVersion ? `（pi ${catalog.piVersion}）` : "（读不到 pi 类型定义，已降级）"}`);
		}
		return catalog;
	}

	let mounted = false;
	/** 最近一次事件的 ctx：单次宏任务重试用（桥可能在本 handler 之后才挂上 gui）。 */
	let pendingCtx: ExtensionContext | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	/** 取 gui 扩展点：`ctx.ui.gui`（共享单例，桥 v1.1.0 起）优先，`ctx.gui` 兼容兑底。 */
	function guiOf(ctx: ExtensionContext | null): Record<string, unknown> | undefined {
		const anyCtx = ctx as unknown as { ui?: { gui?: Record<string, unknown> }; gui?: Record<string, unknown> } | null;
		const gui = anyCtx?.ui?.gui ?? anyCtx?.gui;
		// 桥 v1.3.0 起有 setConfigPage；老桥只有 setSettingsSection（退化回设置弹窗底部，不静默失效）
		return gui && (typeof gui.setConfigPage === "function" || typeof gui.setSettingsSection === "function") ? gui : undefined;
	}

	/** 落点设置函数：优先独立配置页（新桥），缺失则退化回设置弹窗底部（老桥）。 */
	function pageSetterOf(gui: Record<string, unknown>): (key: string, factory: unknown, opts?: unknown) => void {
		return (gui.setConfigPage ?? gui.setSettingsSection) as (key: string, factory: unknown, opts?: unknown) => void;
	}

	function mount(ctx: ExtensionContext): boolean {
		if (mounted) return true;
		const gui = guiOf(ctx);
		if (!gui) {
			// 桥没挂上（未装 / 被禁用 / 纯终端）→ 静默不工作，pi 行为不变
			return false;
		}
		const setPage = pageSetterOf(gui);

		const handleAction = (actionId: string, payload?: unknown): void => {
			if (actionId.startsWith("toggle:")) {
				const id = actionId.slice("toggle:".length);
				if (selected.has(id)) {
					selected.delete(id);
					selectedOrder = selectedOrder.filter((x) => x !== id);
				} else {
					selected.add(id);
					selectedOrder.push(id);
				}
				refresh();
				return;
			}
			if (actionId === "search") {
				// input 事件回灌的是输入值；key 事件（回车）回灌的是键名，别当搜索词
				const value = inputValueOf(payload);
				if (value !== undefined) {
					query = value;
					refresh();
				}
				return;
			}
			if (actionId === "draft-name") {
				// 只记不发：重推整棵树会打断正在输入的光标与回显
				const value = inputValueOf(payload);
				if (value !== undefined) draftName = value;
				return;
			}
			if (actionId.startsWith("purpose:")) {
				// 同上：用途只记在闭包里，生成草稿时才读
				const value = inputValueOf(payload);
				if (value !== undefined) {
					const id = actionId.slice("purpose:".length);
					if (value.trim()) purposes.set(id, value);
					else purposes.delete(id);
				}
				return;
			}
			if (actionId === "clear") {
				selected.clear();
				selectedOrder = [];
				purposes.clear();
				draftText = "";
				refresh();
				return;
			}
			if (actionId === "draft") {
				draftText = buildDraft(selectedOrder, purposes, draftName, ensureCatalog());
				log(`草稿已生成（${selectedOrder.length} 个点，${draftText.length} 字符），已展示在面板内`);
				void payload;
				refresh();
			}
		};

		function refresh(): void {
			// 每次重设会替换旧贡献；勾选/用途变化都走这里。
			// 整页落点不需要折叠态：PiDeck 的 TabsContent 只在选中时挂载，
			// 所以「没点进去就不解析 82 个挂载点」由宿主天然保证（`ensureCatalog()` 仍推迟到首次渲染）。
			setPage(
				SECTION_KEY,
				() => ({
					render: () => renderPanel(ensureCatalog(), selected, purposes, query, draftName, draftText),
					handleAction,
				}),
				{ title: "扩展点", order: 900 },
			);
		}

		refresh();
		mounted = true;
		log("扩展点面板已挂到「Pi 管理」侧栏（config.page）");
		return true;
	}

	/**
	 * 单次宏任务重试：本扩展排在桥之后（内置数组顺序），同一 emit 里桥先挂；
	 * 但若桥不按内置顺序注入（显式 -e / 全局扩展），一个 setTimeout(0) 必然晚于
	 * 本次 emit 全部 handler，届时 `ctx.ui.gui` 已就绪 —— 无需指数退避。
	 */
	function scheduleRetry(): void {
		if (retryTimer || mounted) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (mounted || !pendingCtx) return;
			mount(pendingCtx);
		}, 0);
	}

	function handleSession(ctx: ExtensionContext): void {
		pendingCtx = ctx;
		if (!mount(ctx)) scheduleRetry();
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			handleSession(ctx);
		} catch (error) {
			log(`挂载失败（已吞，pi 不受影响）: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	// agent_start 兑底：此时桥的 session_start 已跑完（/reload 等路径也覆盖），ctx 可能换新。
	pi.on("agent_start", async (_event, ctx) => {
		try {
			handleSession(ctx);
		} catch (error) {
			log(`挂载失败（已吞，pi 不受影响）: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	// 会话结束：清掉贡献 + 复位挂载状态（下个会话重新挂）。
	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const gui = guiOf(ctx) ?? guiOf(pendingCtx);
			if (gui) (pageSetterOf(gui) as (key: string, factory: undefined) => void)(SECTION_KEY, undefined);
		} catch {
			// 清理失败无副作用
		}
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		pendingCtx = null;
		mounted = false;
	});
}

/** 供测试直接调用（不经 pi 运行时）。 */
export const __test__ = { parseUiPoints, parseEvents, buildGuiPoints, buildDraft, loadCatalog };
