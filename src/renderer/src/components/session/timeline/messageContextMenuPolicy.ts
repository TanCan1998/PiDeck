/**
 * 时间线右键菜单的纯策略层（不依赖 DOM / React / Atom，node:test 可直接加载）。
 * DOM 胶水在 hooks/useMessageContextMenu，视图在 components/session/timeline/MessageContextMenu。
 *
 * 这里只回答三个问题：
 * 1. 这次右键有哪些可复制内容（选区快照 / 命中消息原文 / live 流式正文回退）；
 * 2. 内容为空时菜单项由视图直接隐藏（不渲染 disabled 项，避免「点了没反应」）；
 * 3. 复制前的文本清理口径与「全选 / 忽略区域」选择器契约。
 */

import { replaceExpandedRefBlocksWithLabels } from "../composer/quoteChip";

/** live 流式正文根节点标记（AnswerOutput 的 LiveAnswerBody；settle 后由带 data-message-id 的副本接管）。 */
export const LIVE_ANSWER_SELECTOR = "[data-live-answer]";

/**
 * 「全选」目标：从右键位置向上找第一个正文宿主（closest 天然取最近匹配）。
 * - .markdown-body：MarkdownStream / AssistantText 正文根（settled 回答、中间回复）；
 * - .user-turn-bubble：用户气泡正文（不含图片与 hover 动作条）；
 * - [data-message-id]：工具卡 / 诊断卡 / 扩展卡等其余消息块的兜底锚点。
 */
export const MESSAGE_BODY_SELECTOR = "[data-live-answer], .markdown-body, .user-turn-bubble, [data-message-id]";

/**
 * 输入 / 编辑控件保留原生右键语义（文本编辑菜单），不弹消息菜单：
 * 消息内联编辑用的是 textarea / 编辑器宿主的 contenteditable。
 */
export const CONTEXT_MENU_IGNORE_SELECTOR = "input, textarea, [contenteditable]:not([contenteditable='false'])";

/** ANSI 转义序列（工具输出 / 终端粘贴内容里常见）：复制前剥掉，与多选复制的清理口径一致。 */
const ANSI_ESCAPE_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export type MessageContextMenuInput = {
	/** pointerdown（右键按下）时锁存的选区文本：浏览器可能在 contextmenu 之前把选区收掉。 */
	selectionSnapshot: string;
	/** 打开菜单那一刻仍存在的实时选区文本（快照为空时的兜底）。 */
	liveSelection: string;
	/** 右键位置是否落在 live 流式正文内（[data-live-answer]）。 */
	inLiveAnswer: boolean;
	/** live 正文的 DOM 文本快照（textContent）。 */
	liveText: string;
	/** 最近 [data-message-id] 在 activeMessages 里命中的消息原文；未命中为 null。 */
	messageText: string | null;
};

export type MessageContextMenuPlan = {
	/** 「复制」来源：选区快照（右键按下前用户划选的那段文本）。 */
	selectionText: string;
	/** 「复制为文本 / 复制为 Markdown」来源：命中消息的原文（markdown 源码）；空串 = 隐藏这两项。 */
	messageText: string;
	/** live 流式正文的 DOM 文本回退；只有右键落在 live 正文内才非空。 */
	liveText: string;
};

/**
 * 派生一次右键的可用复制来源。
 *
 * 关键边界（live 流式正文）：live 正文没有 data-message-id，最近的锚点是 turn row 的
 * run id——它是本轮首条成员的 id，可能是工具 / 思考的合成 id（不在 activeMessages 里），
 * 也可能是别的消息。照它复制会复制错对象，所以 live 场景只认屏幕上的正文（DOM 文本）；
 * DOM 里已经没有原始 markdown，因此也不提供「复制为 Markdown」。
 */
export function planMessageContextMenu(input: MessageContextMenuInput): MessageContextMenuPlan {
	// 选区优先用 pointerdown 快照：在选区外按右键时 Chromium 会把选区塌陷成光标，
	// contextmenu 时再读实时选区只能拿到空串。
	const selectionText = (input.selectionSnapshot || input.liveSelection).trim();
	if (input.inLiveAnswer) {
		return { selectionText, messageText: "", liveText: input.liveText.trim() };
	}
	const rawMessage = input.messageText ?? "";
	const messageText = rawMessage.trim() ? rawMessage : "";
	return { selectionText, messageText, liveText: "" };
}

/** 菜单是否有可执行项：全空时右键不打开空菜单（落在空白 / 无正文区域）。 */
export function hasMessageContextMenuCopy(plan: MessageContextMenuPlan): boolean {
	return Boolean(plan.selectionText || plan.messageText || plan.liveText);
}

/**
 * 单条消息复制前的展示清理（与多选复制 / 气泡同一口径）：
 * - 自包含引用块折叠成标签：quoted_context 等是模型上下文协议，原样复制会漏 XML；
 * - 剥 ANSI 转义、去 <thinking> 与 <skill> 块：这些不是用户看到的正文。
 * 这里刻意不调 stripMarkdown：「复制为 Markdown」要保留正文 markdown 语法，
 * 「复制为文本」由调用方在清理结果上再过一遍 stripMarkdown。
 */
export function cleanMessageCopyText(text: string): string {
	let next = replaceExpandedRefBlocksWithLabels(text);
	next = next.replace(ANSI_ESCAPE_RE, "");
	next = next.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
	next = next.replace(/<skill\s+name="[^"]*"[^>]*>[\s\S]*?<\/skill>/gi, "");
	return next.trim();
}
