/**
 * GUI 扩展桥 —— 语义色档 → Tailwind class（宿主侧**唯一**一份映射）。
 *
 * 桥侧把扩展的 ANSI 配色量化成**语义 tone**（`BridgeTone`：default / muted /
 * accent / success / warning / danger）后随帧下发；宿主只负责把 tone 投影成
 * PiDeck 既有的语义 token，不写死色值、不新增手写 CSS class
 * （AGENTS.md「新样式一律走 Tailwind utility + 语义 token」，暗色由 token 自适应）。
 *
 * 为什么单独一个模块：`renderBridgeNode.tsx`（节点样式）与 `BridgeSlot.tsx`
 * （状态栏 / 流式行）都要用同一张表 —— 表只有一份，两边不会漂移；
 * 又因为本模块不 import React，可以被 node 单测直接加载。
 */

/** tone → 文字色 class。`default` 刻意留空：让它继承父级颜色。 */
const TONE_TEXT_CLASS: Record<string, string> = {
	default: "",
	muted: "text-muted-foreground",
	accent: "text-primary",
	success: "text-emerald-600 dark:text-emerald-400",
	warning: "text-amber-600 dark:text-amber-400",
	danger: "text-destructive",
};

/** 取某个 tone 的文字色 class；未知/缺省一律返回空串（调用方自行决定兜底色）。 */
export function bridgeToneClass(tone: string | undefined | null): string {
	if (!tone) return "";
	return TONE_TEXT_CLASS[tone] ?? "";
}
