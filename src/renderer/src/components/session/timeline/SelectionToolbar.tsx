import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Languages, Quote } from "lucide-react";
import { sessionDraftByIdAtom, setSessionDraftAtom, setSessionQuotesAtom } from "../../../atoms";
import { openSelectionInlineAtom, quoteToolbarVisibleAtom } from "../../../atoms/agent-atoms";
import { buildDraftWithAppendedQuote, buildQuoteToken, createQuoteId, extractQuoteTokens, pruneUnreferencedQuotes, type QuoteSnippet } from "../composer/quoteChip";
import { computeToolbarPosition } from "./selectionToolbarPolicy";
import type { TimelineSelectionQuote } from "../../../hooks/useTimelineSelection";
import { t } from "../../../i18n";

/**
 * 浮层尺寸估算（与 computeToolbarPosition 入参一致；真实宽度由 useTimelineSelection 的跟随循环
 * 逐帧读 offsetWidth 覆盖）。phase-2 增加「翻译」按钮后从 104 提到 200：
 * 中文两个动作约 150px、英文（Quote and ask / Translate）约 200px，取大值避免首帧贴边溢出。
 */
const TOOLBAR_WIDTH = 200;
const TOOLBAR_HEIGHT = 28;

/**
 * 时间线划选浮层：一个 pill 两个动作（phase-2 合并，解决「划词菜单与引用浮层冲突」）。
 * 1. 引用并提问：快照登记进 session 域 atom，草稿末尾追加 #q<id> token（composer 内渲染为 ❝ 引用 chip），
 *    清除浏览器选区并聚焦本栏 composer。
 * 2. 翻译：把 { 原文, 选区矩形 } 写进 selectionInlineRequestAtom，由全局 SelectionToolHost 打开
 *    原地工具栏（结果直接流式输出在工具栏上）；这里只负责清选区、收起引用浮层，绝不另开浮层。
 * 浮层可见期间把 quoteToolbarVisibleAtom 置 true，全局划词浮出按钮据此让位，避免两个浮层叠在选区上。
 */
export function SelectionToolbar(props: { quote: TimelineSelectionQuote | null; sessionId: string; onConsume: () => void; toolbarRef: RefObject<HTMLElement | null> }) {
	const drafts = useAtomValue(sessionDraftByIdAtom);
	const setDraft = useSetAtom(setSessionDraftAtom);
	const setQuotes = useSetAtom(setSessionQuotesAtom);
	const openInline = useSetAtom(openSelectionInlineAtom);
	const setQuoteToolbarVisible = useSetAtom(quoteToolbarVisibleAtom);
	const quote = props.quote;
	const toolbarRef = props.toolbarRef;

	const position = useMemo(() => {
		if (!quote) return null;
		return computeToolbarPosition(quote.rect, { width: window.innerWidth, height: window.innerHeight }, { width: TOOLBAR_WIDTH, height: TOOLBAR_HEIGHT });
	}, [quote]);

	// 可见性上报：本组件常驻挂载（quote 为 null 时只 return null），不能无条件置 true，
	// 否则全局浮出按钮会被永久压住；只在有引用时上报，引用失效/卸载时清掉。
	const quoteVisible = quote !== null;
	useEffect(() => {
		if (!quoteVisible) return;
		setQuoteToolbarVisible(true);
		return () => setQuoteToolbarVisible(false);
	}, [quoteVisible, setQuoteToolbarVisible]);

	// 容器从 button 换成 div（两个动作），父级 useTimelineSelection 的跟随循环仍按 ref 逐帧直写样式：
	// 用回调 ref 把 DOM 节点同步进父级 RefObject，不改动 hook 的公开类型。
	const assignContainer = useCallback(
		(node: HTMLDivElement | null) => {
			toolbarRef.current = node;
		},
		[toolbarRef],
	);

	if (!quote || !position) return null;

	const handleInsert = () => {
		const snippet: QuoteSnippet = {
			id: createQuoteId(),
			text: quote.text,
			messageId: quote.messageId,
			createdAt: Date.now(),
		};
		const nextDraft = buildDraftWithAppendedQuote(drafts[props.sessionId] ?? "", buildQuoteToken(snippet.id));
		const referencedIds = new Set(extractQuoteTokens(nextDraft).map((occurrence) => occurrence.id));
		setQuotes({
			sessionId: props.sessionId,
			value: (current) => ({
				...pruneUnreferencedQuotes(current, referencedIds),
				[snippet.id]: snippet,
			}),
		});
		setDraft({ sessionId: props.sessionId, value: nextDraft });
		// 清除浏览器选区，避免浮层残留/再次评估
		window.getSelection()?.removeAllRanges();
		props.onConsume();
		// 聚焦本栏输入框（SurfaceComponents「编辑重发」同款作用域选择器）
		document.querySelector<HTMLElement>(".composer-box .tiptap-composer-host [contenteditable], .composer-box textarea")?.focus();
	};

	const handleTranslate = () => {
		// 先登记请求再收起浮层：宿主消费请求时选区快照可能已被 removeAllRanges 清掉，
		// 所以文本与矩形都必须随请求带过去（不能依赖 window.getSelection() 现取）。
		openInline({ text: quote.text, rect: quote.rect });
		window.getSelection()?.removeAllRanges();
		props.onConsume();
	};

	return createPortal(
		<div
			ref={assignContainer}
			// 挂载点标记：useTimelineSelection 的 pointerdown 守卫用它识别「点击浮层自身」，
			// 避免先收起导致随后的 click 拿不到 quote。改名前先同步两处。
			data-quote-toolbar="true"
			// 紧凑工具条（Codex 同款形态）：悬浮卡片 + 毛玻璃，hover 微亮；两个动作共用一个 pill。
			className="fixed z-[80] inline-flex h-7 items-center gap-0.5 rounded-lg border border-border-subtle bg-bg-panel/90 p-0.5 text-caption font-medium text-text-primary shadow-[var(--shadow-popover)] backdrop-blur-md"
			style={{ top: position.top, left: position.left }}
			onClick={(event) => {
				// 兜底：点在容器留白/按钮间隙时仍执行「引用并提问」；按钮自身点击由按钮处理，不重复。
				if (event.target === event.currentTarget) handleInsert();
			}}
		>
			<button type="button" data-quote-action="quote" onClick={handleInsert} className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 transition-colors duration-fast hover:bg-bg-hover">
				<Quote size={13} className="shrink-0 text-text-secondary" aria-hidden="true" />
				<span className="whitespace-nowrap">{t("app.quoteAddToPrompt")}</span>
			</button>
			<span className="h-3.5 w-px shrink-0 bg-border-subtle" aria-hidden="true" />
			<button type="button" data-quote-action="translate" onClick={handleTranslate} className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 transition-colors duration-fast hover:bg-bg-hover">
				<Languages size={13} className="shrink-0 text-text-secondary" aria-hidden="true" />
				<span className="whitespace-nowrap">{t("selectionTool.translate")}</span>
			</button>
		</div>,
		document.body,
	);
}
