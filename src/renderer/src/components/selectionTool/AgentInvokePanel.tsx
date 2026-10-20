import { useAtomValue, useSetAtom } from "jotai";
import { Copy, Loader2, Play, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { AGENT_INVOKE_TEXT_MAX_CHARS, AGENT_TRANSLATE_TARGETS, type AgentInvokeAction, type AgentTranslateTarget } from "../../../../shared/types/agentProfile";
import { agentInvokePanelAtom, agentMarketSettingsAtom, agentProfilesAtom, type AgentInvokePanelState } from "../../atoms/agent-atoms";
import { useAgentInvoke } from "../../hooks/useAgentInvoke";
import { t, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { writeClipboard } from "../../utils/clipboard";
import { showNotice } from "../../utils/notice";
import { AGENT_TRANSLATE_TARGET_LABEL_KEYS, clampFloatingPosition, SELECTION_TOOL_UI_SELECTOR, type FloatingViewport, type SelectionAnchorRect } from "../../utils/selectionToolPolicy";
import { resolveDefaultSelectionAgent } from "../agents/agentMarketFilters";
import { Button } from "../ui-shadcn/button";
import { Textarea } from "../ui-shadcn/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import { AgentInvokeAgentPicker } from "./AgentInvokeAgentPicker";

export type AgentInvokePanelProps = {
	/** 选区锚点（fixed 视口坐标）；null = 市场入口，面板居中偏上。 */
	anchorRect: SelectionAnchorRect | null;
	/** 关闭面板：由宿主同时收起选区快照并把焦点还给页面。 */
	onClose: () => void;
	onSendToSession: (input: { agentId: string; text: string }) => Promise<boolean>;
};

const PANEL_WIDTH = 448;
const PANEL_MAX_HEIGHT_RATIO = 0.7;
/** 测量前的估算高度：只影响首帧定位；useLayoutEffect 在绘制前就换成真实高度。 */
const PANEL_FALLBACK_HEIGHT = 420;
const PANEL_GAP = 8;
const PANEL_MARGIN = 12;
/** 市场入口的居中偏上位置（避开窗口拖拽条/通知区）。 */
const PANEL_TOP_RATIO = 0.1;

const INVOKE_ACTIONS: readonly AgentInvokeAction[] = ["translate", "chat"];
const INVOKE_ACTION_LABEL_KEYS: Record<AgentInvokeAction, TranslationKey> = {
	translate: "agentInvoke.actionTranslate",
	chat: "agentInvoke.actionChat",
};

/**
 * 面板定位（纯计算）：选区入口贴选区下方（放不下翻到上方），市场入口居中偏上；
 * 宽高都夹紧在视口内，保证小窗口/贴边选区下不溢出。
 */
function resolvePanelPosition(input: { anchorRect: SelectionAnchorRect | null; measuredHeight: number; viewport: FloatingViewport }): { left: number; top: number; width: number; maxHeight: number } {
	const { anchorRect, measuredHeight, viewport } = input;
	const maxHeight = Math.max(240, Math.round(viewport.height * PANEL_MAX_HEIGHT_RATIO));
	const width = Math.max(280, Math.min(PANEL_WIDTH, viewport.width - PANEL_MARGIN * 2));
	const height = Math.min(measuredHeight > 0 ? measuredHeight : PANEL_FALLBACK_HEIGHT, maxHeight);
	if (anchorRect) {
		const position = clampFloatingPosition({ anchor: anchorRect, viewport, size: { width, height }, gap: PANEL_GAP, margin: PANEL_MARGIN, prefer: "below" });
		return { left: position.left, top: position.top, width, maxHeight };
	}
	const left = Math.max(PANEL_MARGIN, Math.round((viewport.width - width) / 2));
	const top = Math.max(PANEL_MARGIN, Math.round(viewport.height * PANEL_TOP_RATIO));
	return { left, top, width, maxHeight };
}

/** chips 通用外观：选中态用主题色文字+浅底（--color-accent 是面不是字，正文用 primary 系）。 */
function OptionChip({ active, label, onClick }: { active: boolean; label: ReactNode; onClick: () => void }) {
	return (
		<button type="button" aria-pressed={active} onClick={onClick} className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors", active ? "border-primary/40 bg-primary/10 text-primary" : "border-border-subtle text-muted-foreground hover:bg-accent-soft hover:text-foreground")}>
			{label}
		</button>
	);
}

/**
 * 智能体一次性调用面板（划词工具与市场「使用」共用的唯一浮层）。
 *
 * 形态：不是全屏 Dialog，而是带定位的浮层卡片——不打断正在阅读的页面；
 * 选区入口贴着选区，市场入口居中偏上。内容：智能体选择 / 动作 chips / 目标语言 chips /
 * 可编辑原文 / 流式结果 / 运行-停止-复制-发送到会话。
 *
 * 交互边界：
 * - 面板自身带 [data-selection-tool-ui]，全局划选监听不会把它当正文；
 * - 点击面板外或按 Escape 关闭（Radix 下拉/Tooltip 的 portal 层放行，避免选智能体时误关）；
 * - 打开即聚焦原文输入框；关闭后的焦点还原由宿主 SelectionToolHost 负责。
 */
export function AgentInvokePanel({ anchorRect, onClose, onSendToSession }: AgentInvokePanelProps) {
	const panelState = useAtomValue(agentInvokePanelAtom);
	const setPanelState = useSetAtom(agentInvokePanelAtom);
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const defaultAgent = useMemo(() => resolveDefaultSelectionAgent(agents, settings), [agents, settings]);
	const selectedAgent = useMemo(() => agents.find((agent) => agent.id === panelState.agentId) ?? defaultAgent, [agents, defaultAgent, panelState.agentId]);
	const invoke = useAgentInvoke({ agent: selectedAgent, scopeKey: selectedAgent?.id ?? "" });

	const [sending, setSending] = useState(false);
	const [measuredHeight, setMeasuredHeight] = useState(0);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	// 关闭入口经 ref 转发：全局 listener 只注册一次，避免依赖变化反复重挂。
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const updatePanel = useCallback(
		(patch: Partial<AgentInvokePanelState>) => {
			setPanelState((current) => ({ ...current, ...patch }));
		},
		[setPanelState],
	);

	const handleSelectAgent = useCallback(
		(agentId: string) => {
			updatePanel({ agentId });
		},
		[updatePanel],
	);
	const handleTextChange = useCallback(
		(event: ChangeEvent<HTMLTextAreaElement>) => {
			updatePanel({ text: event.target.value });
		},
		[updatePanel],
	);
	const handleActionChange = useCallback(
		(action: AgentInvokeAction) => {
			updatePanel({ action });
		},
		[updatePanel],
	);
	const handleTargetChange = useCallback(
		(targetLanguage: AgentTranslateTarget) => {
			updatePanel({ targetLanguage });
		},
		[updatePanel],
	);

	// 打开即聚焦原文（preventScroll：浮层自身 fixed，不该把背后的会话滚走）。
	useEffect(() => {
		textareaRef.current?.focus({ preventScroll: true });
	}, []);

	// 点击面板外 / Escape 关闭。捕获阶段注册：先于页面其它键盘快捷键收口。
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest(SELECTION_TOOL_UI_SELECTOR)) return;
			// Radix 下拉/Tooltip 内容 portal 到 body、不在面板子树内：放行，否则选智能体时面板会先关。
			if (target.closest("[data-radix-popper-content-wrapper]")) return;
			onCloseRef.current();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onCloseRef.current();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, []);

	// 内容变化（流式增长/换动作）后重测高度：定位依赖真实高度，面板不能越出视口下沿。
	useLayoutEffect(() => {
		const element = panelRef.current;
		if (!element) return;
		const next = element.offsetHeight;
		if (next > 0 && next !== measuredHeight) setMeasuredHeight(next);
	});

	const state = invoke.state;
	const running = state.phase === "starting" || state.phase === "streaming";
	const hasResult = state.text.trim().length > 0;
	const canRun = Boolean(selectedAgent) && panelState.text.trim().length > 0 && !running;
	const runLabel = state.phase === "done" || state.phase === "error" || hasResult ? t("agentInvoke.retry") : t("agentInvoke.run");
	const canSend = Boolean(selectedAgent) && (hasResult || panelState.text.trim().length > 0) && !sending;

	const handleRun = useCallback(() => {
		if (!canRun) return;
		invoke.run({ text: panelState.text, action: panelState.action, targetLanguage: panelState.targetLanguage });
	}, [canRun, invoke, panelState.action, panelState.targetLanguage, panelState.text]);

	const handleCopy = useCallback(() => {
		if (!hasResult) return;
		void writeClipboard(state.text).then((ok) => {
			if (ok) showNotice(t("common.copied"), 2400);
			else showNotice(t("copy.failed"), 3000, "error");
		});
	}, [hasResult, state.text]);

	const handleSendToSession = useCallback(() => {
		if (!canSend || !selectedAgent) return;
		// 有结果时把「原文 + 结果」一起交给会话：只发译文会让接入的智能体看不到源文，
		// 无法对照润色/继续翻译；没有结果时退回原样发送原文。
		const payload = hasResult ? t("agentInvoke.sessionPayload", { source: panelState.text.trim(), result: state.text.trim() }) : panelState.text.trim();
		if (!payload) return;
		setSending(true);
		void onSendToSession({ agentId: selectedAgent.id, text: payload })
			.then((ok) => {
				// false 表示宿主回调已经 toast 过具体失败原因，这里不重复弹通用错误。
				if (ok) showNotice(t("agentInvoke.sentToSession"), 3000);
			})
			.catch((error: unknown) => {
				showNotice(t("agentInvoke.sessionFailed", { error: error instanceof Error ? error.message : String(error) }), 5000, "error");
			})
			.finally(() => setSending(false));
	}, [canSend, hasResult, onSendToSession, panelState.text, selectedAgent, state.text]);

	const position = resolvePanelPosition({ anchorRect, measuredHeight, viewport: { width: window.innerWidth, height: window.innerHeight } });

	return (
		<div
			ref={panelRef}
			data-selection-tool-ui=""
			role="dialog"
			aria-label={t("agentInvoke.title")}
			className="fixed z-(--z-popover) flex max-h-[70vh] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
			style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
		>
			<div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
				<AgentInvokeAgentPicker agents={agents} selected={selectedAgent} onSelect={handleSelectAgent} />
				<span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">{t("agentInvoke.title")}</span>
				<button type="button" className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
					<X size={14} aria-hidden="true" />
				</button>
			</div>

			<div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pt-2">
				{INVOKE_ACTIONS.map((action) => (
					<OptionChip key={action} active={panelState.action === action} label={t(INVOKE_ACTION_LABEL_KEYS[action])} onClick={() => handleActionChange(action)} />
				))}
				<span className="min-w-0 flex-1" />
				<span className="shrink-0 text-micro text-muted-foreground">{t("agentInvoke.charCount", { count: panelState.text.length })}</span>
			</div>

			{panelState.action === "translate" ? (
				<div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pt-1.5">
					<span className="shrink-0 text-micro text-muted-foreground">{t("agentInvoke.targetLabel")}</span>
					{AGENT_TRANSLATE_TARGETS.map((target) => (
						<OptionChip key={target} active={panelState.targetLanguage === target} label={t(AGENT_TRANSLATE_TARGET_LABEL_KEYS[target])} onClick={() => handleTargetChange(target)} />
					))}
				</div>
			) : null}

			<div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
				<span className="shrink-0 text-micro font-medium text-muted-foreground">{t("agentInvoke.sourceTitle")}</span>
				<Textarea ref={textareaRef} value={panelState.text} onChange={handleTextChange} maxLength={AGENT_INVOKE_TEXT_MAX_CHARS} placeholder={t("agentInvoke.placeholder")} aria-label={t("agentInvoke.sourceTitle")} className="max-h-[180px] min-h-[88px] shrink-0 resize-none text-sm" />
				<div className="flex shrink-0 items-center justify-between text-micro text-muted-foreground">
					<span>{t("agentInvoke.resultTitle")}</span>
					{running ? (
						<span className="inline-flex items-center gap-1">
							<Loader2 size={11} className="animate-pideck-spin" aria-hidden="true" />
							{t("agentInvoke.running")}
						</span>
					) : null}
				</div>
				<div className="min-h-[96px] shrink-0 whitespace-pre-wrap rounded-md border border-border-subtle bg-muted/30 p-2 text-sm [overflow-wrap:anywhere]">
					{state.phase === "starting" ? (
						<span className="inline-flex items-center gap-1.5 text-muted-foreground">
							<Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" />
							{t("agentInvoke.starting")}
						</span>
					) : state.phase === "error" ? (
						<div className="flex flex-col gap-1 text-destructive">
							<span className="font-medium">{t("agentInvoke.errorTitle")}</span>
							<span>{state.errorText}</span>
						</div>
					) : state.text ? (
						<span>{state.text}</span>
					) : (
						<span className="text-muted-foreground">{t("agentInvoke.emptyResult")}</span>
					)}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-1.5 border-t border-border-subtle px-3 py-2">
				{running ? (
					<Button size="sm" variant="outline" onClick={invoke.cancel}>
						<Square size={12} aria-hidden="true" />
						{t("agentInvoke.stop")}
					</Button>
				) : (
					<Button size="sm" disabled={!canRun} onClick={handleRun}>
						<Play size={12} aria-hidden="true" />
						{runLabel}
					</Button>
				)}
				<span className="min-w-0 flex-1" />
				<Button size="icon-sm" variant="ghost" aria-label={t("common.copy")} title={t("common.copy")} disabled={!hasResult} onClick={handleCopy}>
					<Copy size={14} aria-hidden="true" />
				</Button>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button size="sm" variant="outline" disabled={!canSend} onClick={handleSendToSession}>
							{sending ? <Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
							{sending ? t("agentInvoke.sendingToSession") : t("agentInvoke.sendToSession")}
						</Button>
					</TooltipTrigger>
					<TooltipContent side="top" sideOffset={6}>
						{t("agentInvoke.sendToSessionHint")}
					</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}
