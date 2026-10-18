/**
 * GUI 扩展桥 —— 宿主侧的**文本净化兜底**（2026-09 ANSI 泄漏修复）。
 *
 * ## 为什么宿主侧还要再做一次
 *
 * 桥侧已经在出帧口统一净化（`resources/extensions/pi-deck-gui-bridge-theme.ts`
 * 的 `sanitizeBridgeUpdate` + `pi-deck-gui-bridge-runtime.ts` 的净化通路），
 * 但那条净化跑在**第三方扩展进程里**：
 *
 * - 用户可能装的是旧版桥（内置扩展有热更新覆盖层，版本可以落后）；
 * - `PIDECK_BRIDGE_URL` 指向的是本机 HTTP 端点，帧内容始终是**外部输入**；
 * - 桥将来新增的通道/节点类型，宿主不能假设它一定净化过。
 *
 * 所以宿主要有一处「无论桥侧是否漏、第三方怎么推，ESC 都漏不到界面」的兜底。
 * 位置选在**桥帧进入应用状态之后、渲染之前**（渲染层 atom 收口 +
 * 主进程边界各一次），只做一件事：**递归净化字符串字段**。
 *
 * ## 与桥侧的分工
 *
 * | 侧 | 允许做的事 | 实现 |
 * |---|---|---|
 * | 桥侧 | 把能承载样式的 ANSI **译成声明式 `style`**（保留颜色）+ 其余剥净 | `theme.sanitizeBridgeUpdate` |
 * | 宿主侧 | 只兜底：**一律剥掉**（宿主没有「把 ANSI 译成样式」的职责，样式位已由帧里的 `style` 承载） | 本模块 |
 *
 * 纯函数、无 Node/Electron/React 依赖，可被 main / renderer 共用并单测。
 */

import { stripAnsi } from "./fileChanges.ts";
import type { BridgeUpdate } from "./types/bridge.ts";

/**
 * `shared/fileChanges.ts` 的 `stripAnsi` 只认 CSI（`ESC[ … 字母`）。
 * 桥帧里还可能出现这些形态（pi-tui 清行、OSC 超链接、字符集切换…），
 * 只靠 `stripAnsi` 会残留 —— 这里补齐，规则与桥侧 `ANSI_NON_SGR_RE` 同构。
 */
const EXTRA_ESCAPE_RE = /\u001b(?:\[[0-9;?<=>!]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[()*+][0-9A-Za-z]|[P^_X][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/g;

/**
 * 剥掉文本里的全部 ANSI 转义。
 *
 * 最后一趟裸 ESC 清除是硬兜底：界面上的 ESC 永远是渲染事故，不存在合法残留。
 */
export function stripBridgeAnsi(text: string): string {
	return stripAnsi(text)
		.replace(EXTRA_ESCAPE_RE, "")
		.replace(/\u001b/g, "");
}

/**
 * 递归净化任意桥帧 / 节点树：**所有字符串字段**一律剥掉 ANSI。
 *
 * 表驱动地覆盖全部节点种类由 `tests/guiBridgeAnsiLeak.test.mjs` 兜底
 * （从共享契约枚举 kind 与字符串字段，新增 kind/字段而没被覆盖时测试变红）。
 *
 * 不做深度/数量上限：桥侧 `isValidGuiNode` 已经卡过 32 层 / 2000 节点，
 * 这里用 `WeakSet` 防环即可（第三方帧没走校验时也不会爆栈）。
 */
export function sanitizeBridgeNode<T>(node: T): T {
	return walkBridgeText(node, new WeakSet<object>()) as T;
}

/**
 * 净化一帧更新（`BridgeUpdate` 的全部类型：ui-update / status / working /
 * title / thinking-label / resync / overlay / overlay-update）。
 *
 * 只做类型标注，实现与 `sanitizeBridgeNode` **同一份** —— 不重复规则，
 * 也不给「未知帧类型」开口子（未知类型照样深扫，见 `default` 走的是同一个 walker）。
 */
export function sanitizeBridgeUpdate(update: BridgeUpdate): BridgeUpdate {
	return sanitizeBridgeNode(update);
}

/** 递归走字符串字段的最小实现（结构与数值字段原样保留）。 */
function walkBridgeText(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return stripBridgeAnsi(value);
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => walkBridgeText(item, seen));
	if (seen.has(value)) return value;
	seen.add(value);
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = walkBridgeText(item, seen);
	seen.delete(value);
	return out;
}
