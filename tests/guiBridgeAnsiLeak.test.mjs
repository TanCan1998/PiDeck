/**
 * pi-deck-gui-bridge —— ANSI 泄漏回归（逐通道）。
 *
 * ## 事故
 *
 * 2026-09 用户截图：会话输入框下方的桥状态栏出现**原样显示**的转义码
 *
 * ```
 * [38;2;138;190;183m 🔌 MCP: 3 servers enabled[39m
 * ```
 *
 * 真凶已定位到铁证（pi 的 stdio 帧）：
 *
 * ```
 * {"type":"extension_ui_request","method":"setStatus","statusKey":"mcp",
 *  "statusText":"\u001b[38;2;138;190;183m🔌 MCP: 3 servers enabled\u001b[39m"}
 * ```
 *
 * 来源扩展 `pi-mcp-adapter`（`~/.pi/agent/npm/node_modules/pi-mcp-adapter`）的
 * `init.ts:659` / `index.ts:1128` 把 `formatMcpFooterStatus()` 的结果交给
 * `ui.theme.fg("accent", …)`；pi 的 `Theme.fg` 产的是**真 ANSI**
 * （dark 主题 accent `#8abeb7` → `ESC[38;2;138;190;183m` + `ESC[39m`）。
 *
 * ## 本文件守什么
 *
 * 「**任何**入帧通道都不得把 ESC 带到渲染层」。两条纪律：
 *
 * 1. **纯文本通道**（status / working / thinking-label / title）→ `toPlainText`
 *    （只剥不译：这些落点渲染的是纯文本，没有样式位可挂）；
 * 2. **组件通道**（footer / header / widget / editor / ctx.gui 各落点）→
 *    ANSI **尽量译成声明式 `styles`**（保留颜色，MCP 那行本意是青色 = accent），
 *    译不出的序列（非 SGR 的 CSI / OSC / 字符集 / 裸 ESC）**必须剥干净**。
 *
 * 断言口径统一为「序列化后的产物里一个 `\u001b` 都不剩」——JSON 化后扫
 * `\u001b` 字面量，覆盖嵌套的全部字符串字段（不逐字段点断言，避免漏字段）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const loadBridge = createTsSandbox({ globals: { fetch: globalThis.fetch } });
const BRIDGE_DIR = "resources/extensions/";

const themeMod = loadBridge(`${BRIDGE_DIR}pi-deck-gui-bridge-theme.ts`);
const serializeMod = loadBridge(`${BRIDGE_DIR}pi-deck-gui-bridge-serialize.ts`);
const runtimeMod = loadBridge(`${BRIDGE_DIR}pi-deck-gui-bridge-runtime.ts`);
const guiMod = loadBridge(`${BRIDGE_DIR}pi-deck-gui-bridge-gui.ts`);

const loadShared = createTsSandbox();
const bridgeTextMod = loadShared("src/shared/bridgeText.ts");

guiMod.setOwnerDetectorForTests(() => "unknown");

/** 事故现场的原始字节：真彩色开 + 复位（pi dark 主题 accent `#8abeb7`）。 */
const MCP_ANSI = "\u001b[38;2;138;190;183m🔌 MCP: 3 servers enabled\u001b[39m";
const MCP_CLEAN = "🔌 MCP: 3 servers enabled";

/** 非 SGR 的转义形态（`stripAnsi`/旧 `ANSI_RE` 都认不出，正是残留直出的根因之一）。 */
const CSI_ERASE = "\u001b[2K";
const CSI_CURSOR = "\u001b[1A";
const OSC_LINK = "\u001b]8;;https://example.com\u0007docs\u001b]8;;\u0007";
const CHARSET = "\u001b(B";

/** 断言任意嵌套结构里没有 ESC（JSON 化后 ESC 一律呈现为 `\u001b`）。 */
function assertNoEscapes(value, label) {
	const json = JSON.stringify(value ?? null);
	assert.ok(!json.includes("\\u001b"), `${label} 不得残留 ESC：${json.slice(0, 300)}`);
}

function ctx() {
	return { width: 80, depth: 0, count: { value: 0 } };
}

function makeTransport() {
	const pushed = [];
	return { pushed, transport: { available: true, push: (u) => pushed.push(u), onEvent: () => {}, close: () => {} } };
}

function makeGui() {
	const { pushed, transport } = makeTransport();
	return { pushed, runtime: runtimeMod.createBridgeRuntime(transport) };
}

/** 最小 pi-tui 替身：只要能构造出「形状对得上」的组件即可。 */
function makeTui() {
	class Text {
		constructor(text) {
			this.text = text ?? "";
		}
		render() {
			return [this.text];
		}
	}
	class TruncatedText extends Text {}
	class Box extends Text {
		constructor() {
			super("");
			this.children = [];
		}
		addChild(c) {
			this.children.push(c);
		}
	}
	class Loader extends Text {
		constructor(message, frames) {
			super(message);
			this.message = message;
			this.frames = frames;
		}
	}
	class CancellableLoader extends Loader {}
	class Unknown {
		constructor(lines) {
			this.lines = lines;
		}
		render() {
			return this.lines;
		}
	}
	return { Text, TruncatedText, Box, Loader, CancellableLoader, Unknown };
}

/** 最小 ctx.ui 替身（记录原实现调用，语义与 guiBridge.test.mjs 一致）。 */
function makeFakeUi() {
	return {
		__calls: [],
		setStatus(key, text) {
			this.__calls.push({ method: "setStatus", key, text });
		},
		setWidget(key, content, options) {
			this.__calls.push({ method: "setWidget", key, content, options });
		},
		setFooter(f) {
			this.__calls.push({ method: "setFooter", f });
		},
		setHeader(f) {
			this.__calls.push({ method: "setHeader", f });
		},
		setWorkingMessage(m) {
			this.__calls.push({ method: "setWorkingMessage", m });
		},
		setWorkingIndicator(o) {
			this.__calls.push({ method: "setWorkingIndicator", o });
		},
		setHiddenThinkingLabel(l) {
			this.__calls.push({ method: "setHiddenThinkingLabel", l });
		},
		setTitle(t) {
			this.__calls.push({ method: "setTitle", t });
		},
		setEditorComponent(f) {
			this.__calls.push({ method: "setEditorComponent", f });
		},
	};
}

// ── 1. 主题层：ANSI → 样式 / 纯文本 ─────────────────────────────

describe("bridge ANSI: 主题层的剥离与翻译口径", () => {
	it("stripStyledText 认真彩色 SGR（事故现场那条）", () => {
		assert.equal(themeMod.stripStyledText(MCP_ANSI), MCP_CLEAN);
	});

	it("parseAnsiText 把真彩色译成语义 tone（accent），不是一律剥掉", () => {
		const runs = themeMod.parseAnsiText(MCP_ANSI);
		assert.equal(runs.map((r) => r.text).join(""), MCP_CLEAN);
		assert.ok(runs[0].styles.includes("accent"), `真彩色青色应译成 accent，实际 ${JSON.stringify(runs[0].styles)}`);
		// 回归：`38;2;…` 里的 `2` 曾被当成独立的「dim」SGR 码吞下去 → 状态行显示成灰字
		assert.ok(!runs[0].styles.includes("dim"), "扩展色的参数不得被当成独立的 SGR 码（38;2 里的 2 ≠ dim）");
	});

	it("256 色 / 基本色也译成语义 tone", () => {
		assert.ok(themeMod.parseAnsiText("\u001b[38;5;51mcyan\u001b[0m")[0].styles.includes("accent"), "256 色青应译 accent");
		assert.ok(themeMod.parseAnsiText("\u001b[38;2;0;255;0mgreen\u001b[39m")[0].styles.includes("success"), "真彩色绿应译 success");
		assert.ok(themeMod.parseAnsiText("\u001b[32mok\u001b[0m")[0].styles.includes("success"), "基本绿仍译 success");
	});

	it("★ 非 SGR 转义（CSI / OSC / 字符集 / 裸 ESC）必须剥净", () => {
		// 旧 ANSI_RE 只认 `ESC[…m`：`ESC[2K`、OSC 超链接这些会**原样直出**
		assert.equal(themeMod.stripStyledText(`${CSI_ERASE}${CSI_CURSOR}hello`), "hello", "CSI 非 SGR 终止字节必须剥净");
		assert.equal(themeMod.stripStyledText(OSC_LINK), "docs", "OSC 8 超链接必须剥净（留文字不留序列）");
		assert.equal(themeMod.stripStyledText(`${CHARSET}text`), "text", "字符集指定序列必须剥净");
		assert.equal(themeMod.stripStyledText("before\u001bafter"), "beforeafter", "裸 ESC 也必须剥净");

		const runs = themeMod.parseAnsiText(`${CSI_ERASE}\u001b[32mok\u001b[0m${OSC_LINK}`);
		assert.equal(runs.map((r) => r.text).join(""), "okdocs", "解析路径同样不得留下非 SGR 序列");
		assert.ok(runs[0].styles.includes("success"), "剥离残留序列不得吃掉 SGR 样式");
	});

	it("哨兵 + ANSI 混合仍剥净（不回归）", () => {
		const t = themeMod.createBridgeTheme();
		assert.equal(themeMod.stripStyledText(`${t.fg("accent", "A")}${MCP_ANSI}`), `A${MCP_CLEAN}`);
	});
});

// ── 2. 组件通道：pi-tui 适配器 ──────────────────────────────────

describe("bridge ANSI: pi-tui 组件树（footer/header/widget/editor 同一条路）", () => {
	const tui = makeTui();

	it("Text 适配器：真彩色 → text 节点（净文本 + style）", () => {
		const node = serializeMod.serializeComponent(new tui.Text(MCP_ANSI), ctx());
		assertNoEscapes(node, "Text 节点");
		// 单行单 run → 直接是 text 节点
		assert.equal(node.kind, "text");
		assert.equal(node.text, MCP_CLEAN);
		assert.ok((node.style ?? []).includes("accent"), `style 应保留 accent，实际 ${JSON.stringify(node.style)}`);
	});

	it("TruncatedText / Loader 的字符串字段不得带 ESC", () => {
		assertNoEscapes(serializeMod.serializeComponent(new tui.TruncatedText(MCP_ANSI), ctx()), "TruncatedText 节点");
		const styled = themeMod.createBridgeTheme().fg("accent", "loading");
		assertNoEscapes(serializeMod.serializeComponent(new tui.Loader(`${CSI_ERASE}${styled}`, [`${CSI_ERASE}|`]), ctx()), "Loader 节点");
	});

	it("★ 未知组件降级 ansi：非 SGR 残留必须剥净", () => {
		const node = serializeMod.serializeComponent(new tui.Unknown([`${CSI_ERASE}${MCP_ANSI}`, OSC_LINK, `${CHARSET}tail`]), ctx());
		assert.equal(node.kind, "ansi");
		assertNoEscapes(node, "ansi 降级节点");
		assert.deepEqual([...node.lines], [MCP_CLEAN, "docs", "tail"]);
	});

	it("★ serialize() 单一收口：整棵树深扫无 ESC（含嵌套 children）", () => {
		const box = new tui.Box();
		box.addChild(new tui.Text(MCP_ANSI));
		box.addChild(new tui.Unknown([`${CSI_ERASE}x`]));
		assertNoEscapes(serializeMod.serialize(box), "serialize 整树");
	});

	it("setFooter 链路端到端：factory → serialize → 帧里无 ESC", () => {
		const { pushed, transport } = makeTransport();
		const runtime = runtimeMod.createBridgeRuntime(transport);
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setFooter(() => ({ render: () => [`${CSI_ERASE}${MCP_ANSI}`] }));
		const frame = pushed.filter((u) => u.type === "ui-update" && u.targetId === "footer").pop();
		assert.ok(frame?.node, "footer 应推出一帧内容");
		assertNoEscapes(frame.node, "footer 帧");
	});

	it("setHeader / setWidget(组件) / setEditorComponent 同样无 ESC", () => {
		const { pushed, transport } = makeTransport();
		const runtime = runtimeMod.createBridgeRuntime(transport);
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setHeader(() => ({ render: () => [MCP_ANSI] }));
		ui.setWidget("k", () => ({ render: () => [`${CSI_ERASE}${MCP_ANSI}`] }));
		ui.setEditorComponent(() => ({ render: () => [OSC_LINK] }));
		for (const targetId of ["header", "widget:k", "editor"]) {
			const frame = pushed.filter((u) => u.type === "ui-update" && u.targetId === targetId).pop();
			assert.ok(frame?.node, `${targetId} 应推出一帧内容`);
			assertNoEscapes(frame.node, `${targetId} 帧`);
		}
	});
});

// ── 3. 纯文本通道：status / working / thinking-label / title ────

describe("bridge ANSI: 纯文本通道（净文本 + 独立 tone，保色）", () => {
	it("★ 事故现场：setStatus 的 MCP 行不得带 ESC，且保色（tone=accent）", () => {
		const { pushed, transport } = makeTransport();
		const runtime = runtimeMod.createBridgeRuntime(transport);
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setStatus("mcp", MCP_ANSI);
		assertNoEscapes(pushed, "status 帧批次");
		const frame = pushed.filter((u) => u.type === "status").pop();
		assert.equal(frame?.text, MCP_CLEAN);
		assert.equal(frame?.tone, "accent", '本意是青色（theme.fg("accent", …)）→ 必须量化成 accent，不是丢色');
		// 非 SGR 残留同样要剥
		ui.setStatus("other", `${CSI_ERASE}${OSC_LINK}`);
		assert.equal(pushed.filter((u) => u.type === "status").pop()?.text, "docs");
		// 保色但不残留：tone 是**独立字段**，字符串里绝不能有 ESC
		// （否则宿主侧 stripAnsi 兜底会把颜色一起吃掉 —— 两件事互相打架）
		assert.equal(runtime.state.status.get("mcp"), MCP_CLEAN, "state 存净文本");
		assert.equal(runtime.state.statusTone.get("mcp"), "accent", "state 里 tone 与文本分开存");
		runtime.resync();
		const repush = pushed.filter((u) => u.type === "status" && u.key === "mcp").pop();
		assert.equal(repush?.text, MCP_CLEAN);
		assert.equal(repush?.tone, "accent", "resync 重推也必须带 tone（否则刷新后变灰）");
	});

	it("★ setWorkingIndicator 的 frames 也要净化（纯字形，无配色位）", () => {
		const { pushed, transport } = makeTransport();
		const runtime = runtimeMod.createBridgeRuntime(transport);
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setWorkingIndicator({ frames: [`${CSI_ERASE}${MCP_ANSI}`, "plain"] });
		assertNoEscapes(pushed, "working 帧批次");
		assert.deepEqual([...runtime.state.workingFrames], [MCP_CLEAN, "plain"]);
	});

	it("working 文案同样是「净文本 + tone」", () => {
		const { pushed, transport } = makeTransport();
		const runtime = runtimeMod.createBridgeRuntime(transport);
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setWorkingMessage(MCP_ANSI);
		const frame = pushed.filter((u) => u.type === "working" && u.message !== undefined).pop();
		assert.equal(frame?.message, MCP_CLEAN);
		assert.equal(frame?.tone, "accent");
		assertNoEscapes(pushed, "working 帧批次");
	});

	it("resync 重推的 status / working / thinking-label / title 同样干净", () => {
		const { pushed, transport } = makeTransport();
		const runtime = runtimeMod.createBridgeRuntime(transport);
		const ui = makeFakeUi();
		runtime.wrapUI(ui);
		ui.setStatus("k", MCP_ANSI);
		ui.setTitle(MCP_ANSI);
		ui.setHiddenThinkingLabel(MCP_ANSI);
		ui.setWorkingIndicator({ frames: [`${CSI_ERASE}${MCP_ANSI}`] });
		pushed.length = 0;
		runtime.resync();
		assertNoEscapes(pushed, "resync 帧批次");
	});
});

// ── 4. ctx.gui：扩展直接给节点/字符串（原本完全无净化）─────────

describe("bridge ANSI: ctx.gui 通道（扩展直接给字符串/节点）", () => {
	it("★ gui.toast 的 message / 按钮 label 不得带 ESC", () => {
		const { pushed, runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.toast(MCP_ANSI, { actions: [{ label: `${CSI_ERASE}${MCP_ANSI}`, onPress: () => {} }] });
		const frame = pushed.filter((u) => u.type === "ui-update" && String(u.targetId).startsWith("gui:toast:")).pop();
		assert.ok(frame?.node, "toast 应推出一帧");
		assertNoEscapes(frame.node, "toast 帧");
		assert.equal(frame.node.message, MCP_CLEAN);
	});

	it("★ 落点 setter：text 节点保留颜色（style），残留序列剥净", () => {
		const { pushed, runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setBanner("k", () => ({ kind: "text", id: "t1", text: MCP_ANSI }));
		const frame = pushed.filter((u) => u.type === "ui-update" && String(u.targetId).startsWith("gui:banner:")).pop();
		assert.ok(frame?.node);
		assertNoEscapes(frame.node, "banner 帧");
		assert.equal(frame.node.kind, "text");
		assert.equal(frame.node.text, MCP_CLEAN);
		assert.ok((frame.node.style ?? []).includes("accent"), `扩展的 text 节点也要保留 accent，实际 ${JSON.stringify(frame.node.style)}`);

		// 非 SGR 残留：条带里的文字保留，序列剥净
		gui.setBanner("k", () => ({ kind: "text", id: "t2", text: `${CSI_ERASE}top${OSC_LINK}` }));
		const frame2 = pushed.filter((u) => u.type === "ui-update" && String(u.targetId).startsWith("gui:banner:")).pop();
		assertNoEscapes(frame2.node, "banner 帧（非 SGR）");
		assert.equal(JSON.stringify(frame2.node).includes("docs"), true, "文字内容必须保留");
	});

	it("★ 多段落 ANSI（颜色不一致）拆成声明式结构而不是丢色/丢字", () => {
		const { pushed, runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setBanner("k", () => ({ kind: "text", id: "t3", text: `${MCP_ANSI} / plain` }));
		const frame = pushed.filter((u) => u.type === "ui-update" && String(u.targetId).startsWith("gui:banner:")).pop();
		assertNoEscapes(frame.node, "banner 帧（多 run）");
		const flat = JSON.stringify(frame.node);
		assert.ok(flat.includes("🔌 MCP: 3 servers enabled"), "第一段文本必须原样保留");
		assert.ok(flat.includes("accent"), "第一段的 accent 必须保留");
	});

	it("★ overlay：嵌套字段（table / list / tree / keyvalue / codeblock / tabs）全都要净化", () => {
		const { pushed, runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.overlay({
			kind: "vstack",
			id: "root",
			children: [
				{ kind: "table", id: "tb", columns: [`${CSI_ERASE}列`], rows: [[MCP_ANSI]] },
				{ kind: "list", id: "ls", selected: 0, items: [{ label: OSC_LINK, value: "v", description: `${CHARSET}desc` }] },
				{ kind: "tree", id: "tr", nodes: [{ label: `${CSI_ERASE}节点`, children: [{ label: MCP_ANSI }] }] },
				{ kind: "keyvalue", id: "kv", entries: [{ key: `${CSI_ERASE}k`, value: MCP_ANSI }] },
				{ kind: "codeblock", id: "cb", code: `${CSI_CURSOR}code` },
				{ kind: "tabs", id: "tabs", active: 0, tabs: [{ label: `${CSI_ERASE}页`, content: { kind: "text", id: "c1", text: MCP_ANSI } }] },
				{ kind: "button", id: "btn", label: MCP_ANSI, actionId: "a1" },
			],
		});
		const frame = pushed.filter((u) => u.type === "overlay").pop();
		assert.ok(frame?.node, "overlay 应推出一帧");
		assertNoEscapes(frame, "overlay 帧");
	});

	it("★ confirm：title / body / 按钮文案都要净化", () => {
		const { pushed, runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		void gui.confirm(`${CSI_ERASE}确认?`, { kind: "text", id: "b", text: MCP_ANSI }, { confirmLabel: `${CSI_CURSOR}好`, cancelLabel: OSC_LINK });
		const frame = pushed.filter((u) => u.type === "overlay").pop();
		assertNoEscapes(frame, "confirm 帧");
	});

	it("落点贡献的 slot.title 也要净化", () => {
		const { pushed, runtime } = makeGui();
		const gui = guiMod.createGuiNamespace(runtime);
		gui.setSettingsSection("sec", () => ({ kind: "text", id: "s", text: "ok" }), { title: MCP_ANSI });
		const frame = pushed.filter((u) => u.type === "ui-update" && String(u.targetId).startsWith("gui:settings.section:")).pop();
		assertNoEscapes(frame.node, "落点帧（slot.title）");
	});
});

// ── 5. 宿主侧兜底（渲染层收口用同一份实现）─────────────────────

describe("host: shared 层的桥帧净化兜底", () => {
	const ansiDeep = {
		type: "ui-update",
		targetId: "footer",
		node: {
			kind: "vstack",
			id: "root",
			children: [
				{ kind: "text", id: "t", text: MCP_ANSI },
				{ kind: "ansi", id: "a", lines: [`${CSI_ERASE}x`, OSC_LINK] },
				{ kind: "card", id: "c", title: `${CHARSET}标题`, children: [{ kind: "badge", id: "b", label: MCP_ANSI }] },
			],
		},
	};

	it("stripBridgeAnsi 剥净全部形态", () => {
		assert.equal(bridgeTextMod.stripBridgeAnsi(MCP_ANSI), MCP_CLEAN);
		assert.equal(bridgeTextMod.stripBridgeAnsi(`${CSI_ERASE}a${OSC_LINK}`), "adocs");
		assert.equal(bridgeTextMod.stripBridgeAnsi("plain\u001b"), "plain");
	});

	it("★ sanitizeBridgeNode 深扫整棵树（第三方帧带码也漏不进界面）", () => {
		const clean = bridgeTextMod.sanitizeBridgeNode(ansiDeep.node);
		assertNoEscapes(clean, "净化后的节点");
		assert.equal(clean.children[0].text, MCP_CLEAN);
		assert.equal(clean.children[1].lines[1], "docs");
		assert.equal(clean.children[2].title, "标题");
		// 结构与数值字段必须原样保留（净化不是重建）
		assert.equal(clean.kind, "vstack");
		assert.equal(clean.id, "root");
		assert.equal(clean.children.length, 3);
		assert.equal(clean.children[2].children[0].kind, "badge");
	});

	it("★ sanitizeBridgeUpdate 覆盖每一种帧类型", () => {
		const cases = [
			ansiDeep,
			{ type: "status", key: "mcp", text: MCP_ANSI },
			{ type: "working", message: MCP_ANSI, frames: [`${CSI_ERASE}${MCP_ANSI}`] },
			{ type: "title", title: MCP_ANSI },
			{ type: "thinking-label", label: MCP_ANSI },
			{ type: "overlay", elementId: "o1", node: ansiDeep.node, options: { modal: true } },
			{ type: "overlay-update", elementId: "o1", node: ansiDeep.node },
			{ type: "resync" },
		];
		for (const update of cases) {
			assertNoEscapes(bridgeTextMod.sanitizeBridgeUpdate(update), `帧类型 ${update.type}`);
		}
		assert.equal(bridgeTextMod.sanitizeBridgeUpdate({ type: "status", key: "mcp", text: MCP_ANSI }).text, MCP_CLEAN);
	});

	it("幂等 + 不改动干净帧（含 undefined / null 字段）", () => {
		// 净化器跑在 vm 沙箱里，产物是**另一个 realm** 的对象；跨 realm 做 deepStrictEqual
		// 会被原型链判不等，所以先 JSON 归一化再比结构（断言口径不变）。
		const round = (value) => JSON.parse(JSON.stringify(value));
		const cleanFrame = { type: "status", key: "k", text: "干净文本" };
		assert.deepEqual(round(bridgeTextMod.sanitizeBridgeUpdate(cleanFrame)), cleanFrame);
		const once = round(bridgeTextMod.sanitizeBridgeUpdate(ansiDeep));
		assert.deepEqual(round(bridgeTextMod.sanitizeBridgeUpdate(once)), once);
		// ★ tone 必须也是幂等的：出帧口会过两遍（emitPlain 一次 + 净化通路一次），
		// 第二遍时 ANSI 已经没了 —— 若不带过已有 tone，颜色会在第二遍被抹掉。
		const toned = round(themeMod.sanitizeBridgeUpdate({ type: "status", key: "mcp", text: MCP_ANSI }));
		assert.equal(toned.tone, "accent");
		assert.equal(round(themeMod.sanitizeBridgeUpdate(toned)).tone, "accent", "二次净化不得抹掉 tone");
		assert.equal(bridgeTextMod.sanitizeBridgeUpdate(toned).tone, "accent", "宿主侧兜底同样不得抹掉 tone");
		assert.equal(bridgeTextMod.sanitizeBridgeUpdate(toned).text, MCP_CLEAN);
		assert.equal(bridgeTextMod.sanitizeBridgeNode(null), null);
		assert.equal(bridgeTextMod.sanitizeBridgeNode(undefined), undefined);
	});
});

// ── 6. 结构性守卫：契约里新增 kind / 字符串字段必须被覆盖 ────────

/**
 * 「逐通道打补丁」防不住的是**新增**：新加一个节点种类、新加一个字符串字段，
 * 净化器照样能过（它只做通用深扫），但**测试**必须逼人回来确认一次。
 *
 * 下面这张表是**表驱动**的：每个 kind 一个最小节点，所有文本字段都塞真彩色 ANSI；
 * 若契约里多出一个 kind 或一个字符串字段而表里没有，断言立刻变红。
 */

/** 真彩色开 + 复位（事故现场 `pi-mcp-adapter` 用的就是这一对）。 */
const A = (text) => `\u001b[38;2;138;190;183m${text}\u001b[39m`;

/** 契约里**结构性**的字符串字段：不是用户可见文本（不值得往里面塞 ANSI）。 */
const STRUCTURAL_STRING_FIELDS = new Set([
	"kind", // 节点种类本身
	"id", // 节点主键（事件回灌用）
	"actionId", // 动作主键（回调不下发）
	"bg", // 色值（桥的 `bg:` 哨兵通道，不进文本）
	"align", // 布局枚举
	"direction", // 布局枚举
	"src", // 图片 data URL
	"language", // 代码语言标识
	"anchor", // 宿主深链 slug
]);

const TEXT_NODE = { kind: "text", id: "n-text", text: A("t"), style: undefined, slot: { order: 1, title: A("slot-title"), placement: "above" } };

/** kind → 最小节点（文本字段一律带真彩色 ANSI）。 */
const FIXTURES = [
	["ansi", { kind: "ansi", id: "n", lines: [A("l1"), A("l2")] }],
	["badge", { kind: "badge", id: "n", label: A("l"), tone: "accent" }],
	["banner", { kind: "banner", id: "n", message: A("m"), tone: "accent" }],
	["box", { kind: "box", id: "n", padding: [1, 1], children: [TEXT_NODE] }],
	["button", { kind: "button", id: "n", label: A("l"), actionId: "a1", variant: "solid", disabled: false }],
	["card", { kind: "card", id: "n", title: A("t"), children: [TEXT_NODE] }],
	["checkbox", { kind: "checkbox", id: "n", label: A("l"), checked: true, actionId: "a1", local: true }],
	["codeblock", { kind: "codeblock", id: "n", code: A("c"), language: "ts" }],
	["collapse", { kind: "collapse", id: "n", label: A("l"), collapsed: false, count: 1, actionId: "a1", children: [TEXT_NODE] }],
	["divider", { kind: "divider", id: "n", label: A("l") }],
	["editor", { kind: "editor", id: "n", value: A("v"), title: A("t"), actionId: "a1", local: true }],
	["grid", { kind: "grid", id: "n", columns: 2, children: [TEXT_NODE] }],
	["hstack", { kind: "hstack", id: "n", gap: 1, children: [TEXT_NODE] }],
	["icon", { kind: "icon", id: "n", name: A("plug"), tone: "accent" }],
	["image", { kind: "image", id: "n", src: "data:image/png;base64,AAAA", alt: A("a") }],
	["input", { kind: "input", id: "n", value: A("v"), placeholder: A("p"), actionId: "a1", local: true }],
	["keyvalue", { kind: "keyvalue", id: "n", entries: [{ key: A("k"), value: A("v") }] }],
	["list", { kind: "list", id: "n", items: [{ label: A("l"), value: A("v"), description: A("d") }], selected: 0, local: true }],
	["loader", { kind: "loader", id: "n", label: A("l"), frames: [A("f")], cancellable: true }],
	["markdown", { kind: "markdown", id: "n", md: A("md") }],
	["modal", { kind: "modal", id: "n", title: A("t"), children: [TEXT_NODE], actions: [{ kind: "button", id: "act", label: A("l"), actionId: "a1" }] }],
	["progress", { kind: "progress", id: "n", value: 1, max: 10, label: A("l") }],
	["scroll", { kind: "scroll", id: "n", maxHeight: 200, children: [TEXT_NODE] }],
	["scrollarea", { kind: "scrollarea", id: "n", maxHeight: 200, children: [TEXT_NODE] }],
	["select", { kind: "select", id: "n", items: [{ label: A("l"), value: A("v"), description: A("d") }], selected: 0, filter: A("f") }],
	["selectinput", { kind: "selectinput", id: "n", value: A("v"), options: [{ label: A("ol"), value: A("ov") }], placeholder: A("p"), actionId: "a1", local: true }],
	["setting-box", { kind: "setting-box", id: "n", children: [TEXT_NODE] }],
	["setting-row", { kind: "setting-row", id: "n", title: A("t"), description: A("d"), level: 2, stacked: true, alignEnd: false, anchor: "slug", children: [TEXT_NODE] }],
	["settings", { kind: "settings", id: "n", settingsItems: [{ id: "s1", label: A("l"), currentValue: A("c"), description: A("d"), values: [A("v")] }] }],
	["slider", { kind: "slider", id: "n", label: A("l"), value: 1, min: 0, max: 10, step: 1, actionId: "a1", local: true }],
	["spacer", { kind: "spacer", id: "n", size: 1 }],
	["spinner", { kind: "spinner", id: "n", label: A("l") }],
	["split", { kind: "split", id: "n", direction: "row", ratio: 1, children: [TEXT_NODE] }],
	["stack", { kind: "stack", id: "n", direction: "column", gap: 1, align: "stretch", children: [TEXT_NODE] }],
	["switch", { kind: "switch", id: "n", label: A("l"), checked: true, actionId: "a1", local: true }],
	["table", { kind: "table", id: "n", tableColumns: [A("c")], rowsData: [[A("r")]] }],
	["tabs", { kind: "tabs", id: "n", tabs: [{ label: A("l"), content: TEXT_NODE }], active: 0, actionId: "a1", local: true }],
	["text", TEXT_NODE],
	["textarea", { kind: "textarea", id: "n", value: A("v"), placeholder: A("p"), rows: 3, actionId: "a1", local: true }],
	["toast", { kind: "toast", id: "n", message: A("m"), tone: "accent", actions: [{ label: A("l"), actionId: "a1" }] }],
	["tree", { kind: "tree", id: "n", nodes: [{ label: A("l"), expanded: true, children: [{ label: A("c") }] }] }],
	["vstack", { kind: "vstack", id: "n", gap: 1, children: [TEXT_NODE] }],
];

/** 递归收集「值里带 ESC 的键名」（含字符串数组：frames / lines / rowsData / tableColumns…）。 */
function keysWithAnsi(value, out = new Set(), key = undefined) {
	if (typeof value === "string") {
		if (key && value.includes("\u001b")) out.add(key);
		return out;
	}
	if (Array.isArray(value)) {
		for (const item of value) keysWithAnsi(item, out, key);
		return out;
	}
	if (!value || typeof value !== "object") return out;
	for (const [childKey, item] of Object.entries(value)) keysWithAnsi(item, out, childKey);
	return out;
}

describe("structural: 契约里每个 kind / 字符串字段都被净化覆盖", () => {
	const bridgeTypesSource = readFileSync("resources/extensions/pi-deck-gui-bridge-types.ts", "utf8");
	const contractKinds = [...new Set([...bridgeTypesSource.matchAll(/kind:\s*"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]))].sort();

	const sharedSource = readFileSync("src/shared/types/bridge.ts", "utf8");
	const nodeBodyStart = sharedSource.indexOf("export type BridgeUINode = {");
	const nodeBodyEnd = sharedSource.indexOf("\n};", nodeBodyStart);
	const nodeBody = sharedSource.slice(nodeBodyStart, nodeBodyEnd);
	const contractStringFields = [...new Set([...nodeBody.matchAll(/^[\t ]*([A-Za-z][A-Za-z0-9_]*)\??:[\t ]*string(?:\[\])*(?:[\t ]*\|[\t ]*undefined)?[\t ]*;/gm)].map((m) => m[1]))].sort();

	it("契约解析本身有效（kind 与字符串字段都取到了）", () => {
		assert.ok(contractKinds.length >= 40, `应从桥侧契约解析出全部节点种类，实际 ${contractKinds.length}`);
		assert.ok(contractStringFields.length >= 20, `应从共享契约解析出全部字符串字段，实际 ${contractStringFields.length}`);
	});

	it("★ 每个节点种类都有一个 fixture（新增 kind 而未覆盖 → 变红）", () => {
		const fixtureKinds = FIXTURES.map(([kind]) => kind).sort();
		assert.deepEqual(fixtureKinds, contractKinds, "契约里的节点种类与 fixture 表不一致");
	});

	it("★ 每个字符串字段都被分类：结构性 或 带 ANSI 的 fixture 覆盖（新增字段 → 变红）", () => {
		const ansiKeys = new Set();
		for (const [, node] of FIXTURES) keysWithAnsi(node, ansiKeys);
		const unclassified = contractStringFields.filter((field) => !STRUCTURAL_STRING_FIELDS.has(field) && !ansiKeys.has(field));
		assert.deepEqual(unclassified, [], "这些字符串字段既没被标为结构性、也没被 fixture 以带 ANSI 的值覆盖；新增字段必须同步本表");
	});

	it("★ 逐个 kind：桥侧与宿主侧净化器都不得留下 ESC", () => {
		for (const [kind, node] of FIXTURES) {
			const bridgeClean = themeMod.sanitizeNodeText(node);
			assertNoEscapes(bridgeClean, `桥侧净化（kind=${kind}）`);
			const hostClean = bridgeTextMod.sanitizeBridgeNode(node);
			assertNoEscapes(hostClean, `宿主侧净化（kind=${kind}）`);
			// 净化不得吃掉节点身份（事件回灌主键）
			assert.equal(hostClean.kind, kind);
			assert.equal(hostClean.id, node.id);
		}
	});

	it("★ 帧类型全覆盖：每种 BridgeUpdate 过宿主净化器都无 ESC", () => {
		const frameTypes = [...new Set([...sharedSource.matchAll(/type:\s*"([a-z-]+)"/g)].map((m) => m[1]))].filter(
			(type) =>
				// 后六位不是 updates 下行帧：select…action 是回灌事件；service-call 由主进程在
				// 转发前拦截（渲染层永远看不到，bridge.ts 契约注释），service-result 走事件队列。
				!["select", "navigate", "input", "key", "filter", "action", "service-call", "service-result"].includes(type),
		);
		assert.ok(frameTypes.includes("status") && frameTypes.includes("ui-update"), `应解析出帧类型，实际 ${frameTypes.join(",")}`);
		const node = FIXTURES.find(([kind]) => kind === "card")[1];
		const frames = {
			"ui-update": { type: "ui-update", targetId: "footer", node },
			status: { type: "status", key: "mcp", text: A("x") },
			working: { type: "working", message: A("x"), frames: [A("x")] },
			title: { type: "title", title: A("x") },
			"thinking-label": { type: "thinking-label", label: A("x") },
			resync: { type: "resync" },
			overlay: { type: "overlay", elementId: "o", node },
			"overlay-update": { type: "overlay-update", elementId: "o", node },
		};
		assert.deepEqual([...Object.keys(frames)].sort(), [...new Set(frameTypes)].sort(), "帧类型表与共享契约不一致");
		for (const [type, frame] of Object.entries(frames)) {
			assertNoEscapes(bridgeTextMod.sanitizeBridgeUpdate(frame), `宿主净化（帧=${type}）`);
			assertNoEscapes(themeMod.sanitizeBridgeUpdate(frame), `桥侧净化（帧=${type}）`);
		}
	});
});

// ── 7. 方案 B：真彩色 → 语义 tone（保色，不写成字符串）─────────

describe("bridge tone: 真彩色量化成语义色档", () => {
	const toneOf = (sgrText) => themeMod.splitToneAndText(sgrText);

	it("★ 事故现场 138;190;183（青绿）→ accent，不是 muted / 不是丢色", () => {
		const { text, tone } = toneOf(MCP_ANSI);
		assert.equal(text, MCP_CLEAN);
		assert.equal(tone, "accent");
	});

	it("常见颜色各有其档（色相量化表可解释）", () => {
		const cases = [
			["\u001b[38;2;255;0;0mred\u001b[39m", "danger"],
			["\u001b[38;2;220;50;47mred2\u001b[39m", "danger"],
			["\u001b[38;2;0;255;0mgreen\u001b[39m", "success"],
			["\u001b[38;2;255;200;0myellow\u001b[39m", "warning"],
			["\u001b[38;2;0;0;255mblue\u001b[39m", "accent"],
			["\u001b[38;2;0;255;255mcyan\u001b[39m", "accent"],
			["\u001b[38;2;180;180;180mgray\u001b[39m", "default"],
			["\u001b[38;2;60;60;60mdark\u001b[39m", "muted"],
			// 基本色 / 256 色走同一张表
			["\u001b[32mbasic-green\u001b[0m", "success"],
			["\u001b[38;5;51m256-cyan\u001b[0m", "accent"],
		];
		for (const [input, expected] of cases) {
			const { text, tone } = toneOf(input);
			assert.equal(tone, expected, `${JSON.stringify(input)} 应量化成 ${expected}，实际 ${tone}`);
			assert.ok(!text.includes("\u001b"), "净文本不得带 ESC");
		}
	});

	it("无颜色 / 只有样式 → 无 tone（但净文本照旧）", () => {
		assert.deepEqual({ ...toneOf("plain") }, { text: "plain" });
		const bold = toneOf("\u001b[1mbold\u001b[22m");
		assert.equal(bold.text, "bold");
		assert.equal(bold.tone, undefined, "粗体不是颜色，不得造出 tone");
	});

	it("认不出的序列：剥净、保文本、不造 tone", () => {
		const { text, tone } = toneOf(`${CSI_ERASE}text${OSC_LINK}${CHARSET}`);
		assert.equal(text, "textdocs");
		assert.equal(tone, undefined);
	});

	it("桥自己的哨兵主题也能量化（同一份 parseStyledText）", () => {
		const t = themeMod.createBridgeTheme();
		assert.equal(toneOf(t.fg("danger", "boom")).tone, "danger");
	});

	it("组件通道与纯文本通道共用同一张表（text 节点 style 与 status tone 一致）", () => {
		const node = themeMod.sanitizeNodeText({ kind: "text", id: "t", text: MCP_ANSI });
		assert.deepEqual([...node.style], ["accent"]);
		assert.equal(toneOf(MCP_ANSI).tone, "accent");
	});
});

// ── 8. 宿主渲染：tone → 语义 class + 状态栏退役守卫 ─────────────

describe("host: tone 渲染与状态栏退役契约", () => {
	const loadRenderer = createTsSandbox();
	const toneMod = loadRenderer("src/renderer/src/components/bridge/bridgeTone.ts");
	const bridgeSlotSource = readFileSync("src/renderer/src/components/bridge/BridgeSlot.tsx", "utf8");
	const composerAreaSource = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	const rendererSources = [
		["BridgeSlot.tsx", bridgeSlotSource],
		["ComposerArea.tsx", composerAreaSource],
		["ComposerStatsLine.tsx", readFileSync("src/renderer/src/components/session/ComposerStatsLine.tsx", "utf8")],
		["renderBridgeNode.tsx", readFileSync("src/renderer/src/components/bridge/renderBridgeNode.tsx", "utf8")],
		["renderBridgeControls.tsx", readFileSync("src/renderer/src/components/bridge/renderBridgeControls.tsx", "utf8")],
	];

	it("tone → 语义色 class（accent 走 text-primary，暗色自适应）", () => {
		assert.equal(toneMod.bridgeToneClass("accent"), "text-primary");
		assert.equal(toneMod.bridgeToneClass("danger"), "text-destructive");
		assert.equal(toneMod.bridgeToneClass("muted"), "text-muted-foreground");
		assert.match(toneMod.bridgeToneClass("success"), /^text-emerald-600 dark:text-emerald-400$/);
		assert.match(toneMod.bridgeToneClass("warning"), /^text-amber-600 dark:text-amber-400$/);
		assert.equal(toneMod.bridgeToneClass("default"), "", "default 不覆盖颜色");
		assert.equal(toneMod.bridgeToneClass(undefined), "");
		assert.equal(toneMod.bridgeToneClass("不是 tone"), "", "认不出的值不得产出 class");
	});

	it("★ 最后一道兜底确实接在渲染前（两个读取 hook 都过 sanitizeBridgeNode）", () => {
		assert.match(bridgeSlotSource, /import \{ sanitizeBridgeNode \} from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/bridgeText"/);
		const hookBodies = bridgeSlotSource.match(/function useSessionBridgeTargets[\s\S]*?\n\}/)?.[0] ?? "";
		const uiHook = bridgeSlotSource.match(/function useSessionBridgeUi[\s\S]*?\n\}/)?.[0] ?? "";
		assert.match(hookBodies, /sanitizeBridgeNode\(targets\)/, "落点树必须在渲染前过兜底");
		assert.match(uiHook, /sanitizeBridgeNode\(scoped\)/, "桥 UI 文案必须在渲染前过兜底");
		// tone 是独立字段：兜底只剥字符串，不会吃掉颜色 —— 仍在渲染的流式行必须吃 tone
		assert.match(bridgeSlotSource, /bridgeToneClass\(working\.tone\)/, "保色链路不能随状态栏一起退役");
	});

	/**
	 * 守卫：桥状态栏是**产品决定退役**的（2026-09，方案 ②：输入框下方只留 PiDeck
	 * 自己的统计行）。这条测试防「将来有人无意把它加回来」——加回时它会红，
	 * 提醒先去确认产品意图；恢复步骤写在 `BridgeSlot.tsx` 的退役说明里。
	 */
	it("★ 桥状态栏与输入框下方 widget 都不再有渲染挂载点", () => {
		// 先剥注释再扫：退役说明里写着「恢复步骤」的代码样例（含组件名与 data 锚点），
		// 那是文档不是挂载点 —— 守卫只认**真代码**里的挂载。
		const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/.*$/gm, "");
		for (const [name, source] of rendererSources) {
			const code = stripComments(source);
			assert.doesNotMatch(code, /<BridgeStatusBar/, `${name} 不得再挂载桥状态栏`);
			assert.doesNotMatch(code, /data-bridge-status[=\s]/, `${name} 不得再有状态栏条目锚点`);
			assert.doesNotMatch(code, /bridgeStatusBar\s*[=:{]/, `${name} 不得再透传状态栏 prop`);
		}
		// 输入框下方必须保持 PiDeck 原生区域：ComposerArea 只能挂 aboveEditor，
		// 不得重新引入 belowEditor prop、挂载或传递。
		assert.doesNotMatch(composerAreaSource, /bridgeWidgetsBelow|placement=["']belowEditor["']|belowEditor/, "输入框下方不得挂 GUI 扩展桥");
		assert.doesNotMatch(bridgeSlotSource, /placement:\s*["']aboveEditor["']\s*\|\s*["']belowEditor["']/, "BridgeWidgetSlot 不得接受 belowEditor");

		// 数据侧必须保留：桥仍收 state.status，渲染层仍存 bridgeStatus / bridgeStatusTone，
		// 这样「接回来」是零成本的（或做成设置开关）。
		const atomsSource = stripComments(readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8"));
		assert.match(atomsSource, /bridgeStatus\?:[\s\S]{0,60}?Record<string, string>/, "桥状态数据仍要收在 state 里（只是不渲染）");
		assert.match(atomsSource, /bridgeStatusTone\?:[\s\S]{0,60}?Record<string, BridgeTone>/, "tone 也要保留（恢复渲染时直接可用）");
	});
});
