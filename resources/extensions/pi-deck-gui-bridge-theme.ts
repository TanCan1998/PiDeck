/**
 * pi-deck-gui-bridge —— 主题与样式。
 *
 * 桥给扩展一份**自己的 theme 对象**，其 `fg`/`bg` 不产 ANSI，而是包上哨兵：
 *   `{§accent§}text{§/§}`
 * 翻译器识别哨兵 → `StyleToken` → PiDeck 映射成 CSS 变量（§6.5）。
 *
 * 为什么要这样：扩展写的是 `theme.fg("accent", text)`，与 TUI 完全同形；
 * 但输出既不是 ANSI 也不是具体色值，而是**语义档**，因此
 * 「扩展不能指定颜色值」这条铁律（§7.3）在 pi-tui 那条路上也自动成立。
 *
 * **兜底**：扩展可能自己拼 ANSI，或第三方组件内部拼 ANSI。
 * 这时做 SGR 解析 → 最近语义 token；解析不了就剥掉转纯文本。
 */

import type { StyleToken, Tone, UIBridgeUpdate, UINode } from "./pi-deck-gui-bridge-types";

/** 哨兵边界：用不可能出现在正常文本里的控制字符对，避免误伤用户内容。 */
const OPEN = "\u0001\u00a7"; // \x01§
const CLOSE = "\u00a7\u0001"; // §\x01
/**
 * 哨兵名允许的字符：字母/数字/`-`/`_`/`.`/`:`/`/`。
 *
 * 必须包含 `/` 与 `:` —— 闭合标记是 `/fg`、`/bold`，背景是 `bg:accent`。
 * （早期版本漏了这两个字符，导致闭合哨兵不被消费、残留在文本里。）
 */
const SENTINEL_NAME = "[a-zA-Z0-9_:/.-]+";
const OPEN_RE = new RegExp(`\\u0001\\u00a7(${SENTINEL_NAME})\\u00a7\\u0001`, "g");
const CLOSE_RE = /\u00a7\u0001/g;

/** pi-tui 主题的色档名 → 桥的语义 tone。 */
const TONE_ALIASES: Record<string, Tone> = {
	accent: "accent",
	primary: "accent",
	success: "success",
	ok: "success",
	warning: "warning",
	warn: "warning",
	error: "danger",
	danger: "danger",
	muted: "muted",
	dim: "muted",
	gray: "muted",
	grey: "muted",
	text: "default",
	foreground: "default",
	default: "default",
};

/** 归一化一个色档名到语义 tone（未知 → default）。 */
function toTone(name: string): Tone {
	return TONE_ALIASES[name.trim().toLowerCase()] ?? "default";
}

/**
 * 用哨兵包住文本。
 *
 * 同时产出「前景色」与「背景色」两类哨兵，翻译时分别映射到文字色与容器底色。
 */
function wrap(name: string, text: string): string {
	return `${OPEN}${name}${CLOSE}${text}${OPEN}/fg${CLOSE}`;
}

/** 桥的主题对象：与 pi-tui Theme 同形（`fg` / `bg` / `bold` / `dim` / …）。 */
export type BridgeTheme = {
	fg: (name: string, text: string) => string;
	bg: (name: string, text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	underline: (text: string) => string;
	strikethrough: (text: string) => string;
	dim: (text: string) => string;
	/** 兼容：某些扩展读 theme.colors / theme.name */
	colors?: Record<string, string>;
	name?: string;
};

/**
 * 创建桥主题。
 *
 * `fg` / `bg` 一律产哨兵；装饰类（bold 等）产对应的样式哨兵，
 * 由翻译层统一转成 `StyleToken[]`。
 */
export function createBridgeTheme(): BridgeTheme {
	const theme: BridgeTheme = {
		fg: (name, text) => wrap(toTone(name), text),
		bg: (name, text) => `${OPEN}bg:${toTone(name)}${CLOSE}${text}${OPEN}/bg${CLOSE}`,
		bold: (text) => `${OPEN}bold${CLOSE}${text}${OPEN}/bold${CLOSE}`,
		italic: (text) => `${OPEN}italic${CLOSE}${text}${OPEN}/italic${CLOSE}`,
		underline: (text) => `${OPEN}underline${CLOSE}${text}${OPEN}/underline${CLOSE}`,
		strikethrough: (text) => `${OPEN}strike${CLOSE}${text}${OPEN}/strike${CLOSE}`,
		dim: (text) => `${OPEN}muted${CLOSE}${text}${OPEN}/fg${CLOSE}`,
		colors: {},
		name: "pideck-gui-bridge",
	};
	return theme;
}

/** 一个文本片段 + 其生效样式。 */
export type StyledRun = { text: string; styles: StyleToken[] };

/** 哨兵名称 → StyleToken。 */
function sentinelToStyle(name: string): StyleToken | null {
	const lower = name.trim().toLowerCase();
	if (lower.startsWith("bg:")) return null; // 背景色不进 style token（容器底色另处理）
	switch (lower) {
		case "bold":
			return "bold";
		case "italic":
			return "italic";
		case "underline":
			return "underline";
		case "strike":
		case "strikethrough":
			return "strikethrough";
		case "code":
			return "code";
		case "/fg":
		case "/bold":
		case "/italic":
		case "/underline":
		case "/strike":
		case "/code":
		case "/bg":
			return null; // 闭合标记由解析器处理
		default:
			return toTone(lower);
	}
}

/**
 * 把带哨兵的字符串解析成若干 `StyledRun`。
 *
 * 解析器是**栈式**的：`{§bold§}a{§accent§}b{§/bold§}c` 里，`b` 同时带 bold + accent。
 * 遇到认不出的哨兵名按 tone 处理（`default` 兜底），**绝不抛错**。
 */
export function parseSentinelText(input: string): StyledRun[] {
	if (!input) return [];
	// 没有哨兵 → 快速路径（绝大多数纯文本走这里）
	if (!input.includes("\u0001\u00a7")) return [{ text: input, styles: [] }];

	const runs: StyledRun[] = [];
	const stack: StyleToken[] = [];
	let cursor = 0;
	OPEN_RE.lastIndex = 0;
	let match: RegExpExecArray | null = OPEN_RE.exec(input);
	while (match) {
		const raw = input.slice(cursor, match.index);
		if (raw) runs.push({ text: raw, styles: [...stack] });
		const name = match[1];
		if (name.startsWith("/")) {
			// 闭合：弹出最近一个同名（或任意）样式
			const target = sentinelToStyle(name.slice(1)) ?? null;
			if (target === null) {
				// 闭合 fg/bg 这类"组"标记：弹出最近的 tone
				const idx = findLastToneIndex(stack);
				if (idx >= 0) stack.splice(idx, 1);
			} else {
				const idx = stack.lastIndexOf(target);
				if (idx >= 0) stack.splice(idx, 1);
			}
		} else {
			const token = sentinelToStyle(name);
			if (token) stack.push(token);
		}
		cursor = match.index + match[0].length;
		match = OPEN_RE.exec(input);
	}
	const tail = input.slice(cursor);
	if (tail) runs.push({ text: tail, styles: [...stack] });
	return mergeRuns(runs);
}

function findLastToneIndex(stack: StyleToken[]): number {
	const tones = new Set(["default", "muted", "accent", "success", "warning", "danger"]);
	for (let i = stack.length - 1; i >= 0; i -= 1) {
		if (tones.has(stack[i])) return i;
	}
	return -1;
}

/** 合并相邻同样式片段，减少节点数。 */
function mergeRuns(runs: StyledRun[]): StyledRun[] {
	const out: StyledRun[] = [];
	for (const run of runs) {
		if (!run.text) continue;
		const prev = out[out.length - 1];
		if (prev && sameStyles(prev.styles, run.styles)) {
			prev.text += run.text;
		} else {
			out.push({ text: run.text, styles: [...run.styles] });
		}
	}
	return out;
}

function sameStyles(a: StyleToken[], b: StyleToken[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}

// ── ANSI 兜底（§6.5）────────────────────────────────────────────

/**
 * 单个 SGR 序列（`ESC [ 参数 m`）——**只有它**参与「解析成样式」。
 *
 * 参数允许空串（`ESC[m` = 复位）与纯数字分号串（含 `38;2;R;G;B` / `38;5;N`）。
 */
const SGR_RE = /\u001b\[[0-9;]*m/g;

/**
 * 除 SGR 之外的**全部** ANSI 转义形态 —— 只用于「剥掉」。
 *
 * 为什么必须单列一份：旧实现只认 `ESC[…m`，于是 pi-tui / 扩展产出的
 * 下面这些形态会**原样直出**到 GUI（用户看到一排乱码字符）：
 *
 * | 形态 | 例子 | 谁会产 |
 * |---|---|---|
 * | CSI（非 `m` 终止字节） | `ESC[2K`、`ESC[1A`、`ESC[?25l` | 清行 / 移光标 / 隐藏光标 |
 * | OSC | `ESC]8;;url BEL` | 终端超链接（pi 的工具输出里很常见） |
 * | 字符集指定 | `ESC(B` | 老式终端 charset 切换 |
 * | DCS / APC / PM / SOS | `ESC P … ESC \` | 终端扩展协议 |
 * | 两字符 ESC | `ESC7`、`ESC=`、`ESC>` | 保存/恢复光标等 |
 */
const ANSI_NON_SGR_RE = /\u001b(?:\[[0-9;?<=>!]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[()*+][0-9A-Za-z]|[P^_X][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/g;

/** 出现 ESC 或哨兵（`\u0001`）的文本才需要走样式解析，其余走快速路径。 */
const NEEDS_STYLE_RE = /[\u001b\u0001]/;

/**
 * 剥掉一段文本里的**所有** ANSI 转义（规则见 `ANSI_NON_SGR_RE`）。
 *
 * 最后一趟 `replace(/\u001b/g, "")` 是**硬兜底**：上面的形态将来若有遗漏
 * （畸形序列、新协议），至少保证产物里**一个 ESC 都不剩** ——
 * 界面上的 ESC 永远是渲染事故，不存在「合法残留」。
 */
export function stripAnsiEscapes(input: string): string {
	return input.replace(ANSI_NON_SGR_RE, "").replace(/\u001b/g, "");
}

/** SGR 基本前景色码 → 语义 tone（粗粒度映射，够用即可）。 */
function sgrToTone(code: number): Tone | null {
	if (code === 30 || code === 90) return "muted";
	if (code === 31 || code === 91) return "danger";
	if (code === 32 || code === 92) return "success";
	if (code === 33 || code === 93) return "warning";
	if (code === 34 || code === 94 || code === 36 || code === 96) return "accent";
	if (code === 35 || code === 95) return "accent";
	if (code === 37 || code === 97) return "default";
	return null;
}

/** ANSI 16 基本色的 RGB（用于 256 色 0–15 档的换算）。 */
const ANSI16_RGB: [number, number, number][] = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];

/** 256 色索引 → RGB（与终端一致：0–15 基本色、16–231 六面体、232–255 灰阶）。 */
function ansi256ToRgb(index: number): [number, number, number] | null {
	if (!Number.isFinite(index) || index < 0 || index > 255) return null;
	if (index < 16) return ANSI16_RGB[index];
	if (index < 232) {
		const cube = index - 16;
		const step = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
		return [step(Math.floor(cube / 36)), step(Math.floor((cube % 36) / 6)), step(cube % 6)];
	}
	const gray = 8 + (index - 232) * 10;
	return [gray, gray, gray];
}

/**
 * RGB → 语义 tone：扩展**不能**指定色值（§7.3），但也不能把颜色一律丢掉。
 *
 * 按色相归类（青/蓝/紫 → accent、绿 → success、黄/橙 → warning、红 → danger），
 * 低饱和按明度归 muted / default。事故现场那条 `#8abeb7`（138,190,183）
 * 落在青色档 → accent，正是 `pi-mcp-adapter` 写 `theme.fg("accent", …)` 的本意。
 */
function rgbToTone(r: number, g: number, b: number): Tone | null {
	if (![r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return null;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;
	if (delta < 24) return (max + min) / 2 > 110 ? "default" : "muted";
	let hue: number;
	if (max === r) hue = 60 * (((g - b) / delta) % 6);
	else if (max === g) hue = 60 * ((b - r) / delta + 2);
	else hue = 60 * ((r - g) / delta + 4);
	if (hue < 0) hue += 360;
	if (hue < 20 || hue >= 330) return "danger";
	if (hue < 70) return "warning";
	if (hue < 160) return "success";
	return "accent"; // 青 / 蓝 / 紫 / 品红 —— 都是强调色档
}

/** 把一个 SGR 序列的码流应用到样式栈上（含扩展色 `38;2;…` / `38;5;…`）。 */
function applySgrCodes(body: string, stack: StyleToken[]): void {
	const codes = body === "" ? [0] : body.split(";").map((part) => Number.parseInt(part, 10) || 0);
	const add = (token: StyleToken): void => {
		if (!stack.includes(token)) stack.push(token);
	};
	const dropTone = (): void => {
		const idx = findLastToneIndex(stack);
		if (idx >= 0) stack.splice(idx, 1);
	};
	for (let i = 0; i < codes.length; i += 1) {
		const code = codes[i];
		if (code === 0) {
			stack.length = 0;
		} else if (code === 1) {
			add("bold");
		} else if (code === 2) {
			add("dim");
		} else if (code === 3) {
			add("italic");
		} else if (code === 4) {
			add("underline");
		} else if (code === 9) {
			add("strikethrough");
		} else if (code === 22 || code === 23 || code === 24 || code === 29) {
			// 关闭粗体/斜体/下划线/删除线：近似处理为清掉对应样式
			const target: StyleToken = code === 22 ? "bold" : code === 23 ? "italic" : code === 24 ? "underline" : "strikethrough";
			const idx = stack.lastIndexOf(target);
			if (idx >= 0) stack.splice(idx, 1);
		} else if (code === 38 || code === 48) {
			// 扩展色：参数必须**整体消费**（`38;2;r;g;b` 里的 2 不是「dim」，5 也不是「blink」）
			const mode = codes[i + 1];
			let tone: Tone | null = null;
			if (mode === 2) {
				tone = rgbToTone(codes[i + 2], codes[i + 3], codes[i + 4]);
				i += 4;
			} else if (mode === 5) {
				const rgb = ansi256ToRgb(codes[i + 2]);
				tone = rgb ? rgbToTone(rgb[0], rgb[1], rgb[2]) : null;
				i += 2;
			} else {
				i += 1;
			}
			// 背景色不进 StyleToken（容器底色由 bg 哨兵单独承载），仅消费掉参数
			if (code === 38 && tone) {
				dropTone();
				add(tone);
			}
		} else if (code === 39 || code === 49) {
			dropTone();
		} else {
			const tone = sgrToTone(code);
			if (tone) {
				dropTone();
				add(tone);
			}
		}
	}
}

/**
 * 把真 ANSI 文本降级成 `StyledRun[]`。
 *
 * 识别 SGR 前景色/粗体/斜体/下划线；其余序列一律剥掉。
 * 这是**保命路径**：任何解析失败都退化成「纯文本」而不是抛错。
 */
export function parseAnsiText(input: string): StyledRun[] {
	if (!input) return [];
	if (!input.includes("\u001b")) return [{ text: input, styles: [] }];

	const runs: StyledRun[] = [];
	const stack: StyleToken[] = [];
	let cursor = 0;
	SGR_RE.lastIndex = 0;
	let match: RegExpExecArray | null = SGR_RE.exec(input);
	while (match) {
		const raw = input.slice(cursor, match.index);
		if (raw) runs.push({ text: raw, styles: [...stack] });
		applySgrCodes(match[0].slice(2, -1), stack); // 去掉 ESC[ 与 m
		cursor = match.index + match[0].length;
		match = SGR_RE.exec(input);
	}
	const tail = input.slice(cursor);
	if (tail) runs.push({ text: tail, styles: [...stack] });
	// SGR 是「分隔符」已被吃掉，但非 SGR 的转义还留在段落文本里 —— 统一剥净，
	// 否则它们会以「乱码字符」直出到 GUI（2026-09 事故的另一半）。
	return mergeRuns(runs.map((run) => ({ text: stripAnsiEscapes(run.text), styles: run.styles })));
}

/**
 * 统一入口：先解哨兵，再把残余 ANSI 也解掉。
 *
 * 顺序有意为之 —— 桥自己产的哨兵优先，扩展/第三方拼的 ANSI 兜底。
 */
export function parseStyledText(input: string): StyledRun[] {
	const runs = parseSentinelText(input);
	const out: StyledRun[] = [];
	for (const run of runs) {
		if (!run.text.includes("\u001b")) {
			out.push(run);
			continue;
		}
		for (const ansiRun of parseAnsiText(run.text)) {
			out.push({ text: ansiRun.text, styles: [...run.styles, ...ansiRun.styles] });
		}
	}
	return mergeRuns(out);
}

/** 剥掉全部样式（哨兵 + **所有** ANSI 转义），得到纯文本。 */
export function stripStyledText(input: string): string {
	let out = input.replace(OPEN_RE, "").replace(CLOSE_RE, "");
	out = stripAnsiEscapes(out);
	return out;
}

// ── 出帧收口：节点树 / 整帧的统一净化（2026-09 ANSI 泄漏修复）───

/**
 * 把一棵**任意形状**的节点树里的全部字符串字段净化掉。
 *
 * 这是桥侧「ANSI 不再泄漏」的**唯一实现**，被 `sanitizeBridgeUpdate` 在所有
 * 出帧口调用（见 `pi-deck-gui-bridge-runtime.ts` 的净化通路）。规则：
 *
 * - `kind: "text"` 节点：ANSI **译成声明式 `style`**（能保色就保色）——
 *   单段 → `style` 合并；多段且样式不同 → 拆成 `hstack` + 每段一个 `text` 子节点
 *   （与 `serialize.ts` 的 `textNodes` 同构，宿主本来就能渲染）；
 * - 其它一切字段（`label` / `title` / `lines` / `items[].description` / `tableColumns`
 *   / `entries[].value` / `slot.title` / 将来新增的字段…）：**承载不了样式就剥净**，
 *   绝不把原始码透出去；
 * - 结构、数值、布尔字段原样保留（净化 ≠ 重建），无 ESC 的文本走快速路径。
 *
 * 深度优先 + `WeakSet` 防环：即使调用方还没跑过 `isValidGuiNode` 也不会爆栈。
 */
export function sanitizeNodeText<T>(value: T): T {
	return walkNodeText(value, new WeakSet<object>()) as T;
}

function walkNodeText(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return stripAnsiEscapes(value);
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => walkNodeText(item, seen));
	if (seen.has(value)) return value;
	seen.add(value);
	const source = value as Record<string, unknown>;
	// text 节点有样式位可挂：ANSI → style（保留颜色），而不是一律剥掉
	if (source.kind === "text" && typeof source.text === "string" && NEEDS_STYLE_RE.test(source.text)) {
		const styled = styleFromAnsiTextNode(source, seen);
		seen.delete(value);
		return styled;
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(source)) out[key] = walkNodeText(item, seen);
	seen.delete(value);
	return out;
}

/**
 * 把带 ANSI/哨兵的 text 节点重写成「净文本 + 声明式样式」的等价节点。
 *
 * 除 `text`/`style` 外的字段（`slot` / `children` / 将来新增的）照常深扫 ——
 * 这条快路径只负责「把颜色译成 style」，**不豁免**其它字段的净化。
 */
function styleFromAnsiTextNode(node: Record<string, unknown>, seen: WeakSet<object>): Record<string, unknown> {
	const baseStyle = Array.isArray(node.style) ? (node.style as StyleToken[]) : [];
	const runs = parseStyledText(String(node.text ?? ""))
		.map((run) => ({ text: stripAnsiEscapes(run.text), styles: dedupeStyles([...baseStyle, ...run.styles]) }))
		.filter((run) => run.text.length > 0);

	const rest: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(node)) {
		if (key === "text" || key === "style") continue;
		rest[key] = walkNodeText(item, seen);
	}

	if (runs.length <= 1) {
		const only = runs[0];
		return { ...rest, text: only?.text ?? "", style: only && only.styles.length > 0 ? only.styles : undefined };
	}
	// 多段且样式不同：拆行内分段（与 serialize.ts 的 textNodes 同一形态）
	const id = String(node.id ?? "text");
	return {
		...rest,
		kind: "hstack",
		children: runs.map((run, index) => ({
			kind: "text",
			id: `${id}:${index}`,
			text: run.text,
			style: run.styles.length > 0 ? run.styles : undefined,
		})),
	};
}

function dedupeStyles(styles: StyleToken[]): StyleToken[] {
	const out: StyleToken[] = [];
	for (const style of styles) if (!out.includes(style)) out.push(style);
	return out;
}

/** 全部语义 tone（与共享契约 `BridgeTone` / 桥侧 `Tone` 逐值对齐）。 */
const TONE_VALUES: ReadonlySet<string> = new Set(["default", "muted", "accent", "success", "warning", "danger"]);

/** 一段纯文本 + 它的语义 tone（无颜色时 `tone` 缺省）。 */
export type ToneAndText = { text: string; tone?: Tone };

/**
 * 把「可能带样式码」的**纯文本**拆成「净文本 + 语义 tone」。
 *
 * 为什么是「拆成字段」而不是「把颜色留在字符串里」：宿主侧还有一道
 * `stripAnsi` 兜底（`src/shared/bridgeText.ts`），留在字符串里的颜色码会被它
 * 一起吃掉 —— 配色与兜底互相打架。拆成独立字段后，净文本可以随便被剥，
 * tone 是结构化数据、兜底不碰它（2026-09 用户要求：MCP 状态行要**青色**而不是无色）。
 *
 * 映射规则与组件通道**共用** `parseStyledText` → 同一份真彩色/256 色/基本色量化表
 * （见 `rgbToTone` / `ansi256ToRgb`），不另起一套。
 */
export function splitToneAndText(value: unknown): ToneAndText {
	const raw = value === undefined || value === null ? "" : String(value);
	if (!NEEDS_STYLE_RE.test(raw)) return { text: raw };
	const runs = parseStyledText(raw);
	const text = runs.map((run) => run.text).join("");
	// 取**第一个**语义色档：一条状态行大多只有一个色，多段渐变没法用一个 tone 表达
	const tone = runs.flatMap((run) => run.styles).find((style): style is Tone => TONE_VALUES.has(style));
	return tone ? { text, tone } : { text };
}

/**
 * 一帧更新出网前的**统一净化 + 配色量化**（§9.3 线格式的所有类型都在这里过一遍）。
 *
 * 为什么放在「帧」这一层而不是各通道：通道是**会长**的（`setStatus` / `setFooter`
 * / `setWidget` / `ctx.gui.*` / 将来新增的落点）。逐个通道补净化迟早漏一条 ——
 * 2026-09 的 MCP 状态行事故就是「补了四条、第五条没补」；
 * 收在帧的出网口后，**漏一条在结构上不可能**：任何 pusher 都只能经
 * `runtime.transport.push` 出网（见 `createSanitizingTransport`）。
 *
 * 两类字段的处理口径：
 * - **组件树**（`ui-update` / `overlay*`）：`sanitizeNodeText` 把 ANSI 译成 `style`（保色）；
 * - **纯文本**（`status` / `working` / `title` / `thinking-label`）：也保色 ——
 *   净文本 + 独立 `tone` 字段（`splitToneAndText`），`frames` 只是字形、只剥不译。
 *
 * 两类的收尾一致：**认不出的序列一律剥净**，产物里不留 ESC。
 */
export function sanitizeBridgeUpdate(update: UIBridgeUpdate): UIBridgeUpdate {
	if (!update || typeof update !== "object") return update;
	switch (update.type) {
		case "ui-update":
			return { ...update, node: update.node ? sanitizeNodeText(update.node as UINode) : update.node };
		case "overlay":
			return { ...update, node: update.node ? sanitizeNodeText(update.node as UINode) : update.node };
		case "overlay-update":
			return { ...update, node: sanitizeNodeText(update.node as UINode) };
		case "status": {
			if (update.text === undefined || update.text === null) return { ...update, text: undefined, tone: undefined };
			const { text, tone } = splitToneAndText(update.text);
			// `?? update.tone` 让本函数**幂等**：出帧口会过两遍（emitPlain 先进通路、
			// 通路本身再净化一次），第二遍时 ANSI 已经没了 —— 不把已有 tone 带过去，
			// 颜色会在第二遍被抹掉（真踩过：帧层单测红在 tone=undefined）。
			return { ...update, text, tone: tone ?? update.tone };
		}
		case "working": {
			const next = { ...update };
			if (update.message !== undefined && update.message !== null) {
				const { text, tone } = splitToneAndText(update.message);
				next.message = text;
				next.tone = tone ?? update.tone;
			}
			// 指示器帧：只是字形（`|` `/` `-`），没有颜色位，一律剥掉
			if (Array.isArray(update.frames)) next.frames = update.frames.map((frame) => stripStyledText(String(frame)));
			return next;
		}
		case "title": {
			const { text, tone } = splitToneAndText(update.title);
			return { ...update, title: text, tone: tone ?? update.tone };
		}
		case "thinking-label": {
			if (update.label === undefined || update.label === null) return { ...update, label: undefined, tone: undefined };
			const { text, tone } = splitToneAndText(update.label);
			return { ...update, label: text, tone: tone ?? update.tone };
		}
		default:
			// resync 不带文本
			return update;
	}
}

/** 从哨兵文本里读出「容器背景色」（`bg:` 哨兵），供 Box 适配器使用。 */
export function readBgTone(input: string): Tone | null {
	const match = input.match(/\u0001\u00a7bg:([a-zA-Z0-9_-]+)\u00a7\u0001/);
	return match ? toTone(match[1]) : null;
}