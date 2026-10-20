import { Copy, Loader2, Play, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AGENT_INVOKE_TEXT_MAX_CHARS, AGENT_TRANSLATE_TARGETS, type AgentInvokeAction, type AgentTranslateTarget } from "../../../../shared/types/agentProfile";
import { SELECTION_TOOL_TEXT_MAX_CHARS, type SelectionToolShowPayload } from "../../../../shared/types/selectionTool";
import { desktopApi } from "../../desktopApi";
import { t, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { applySelectionWindowAppearance } from "../../selection-tool/appearance";
import { subscribeSelectionCapture } from "../../selection-tool/captureBridge";
import { writeClipboard } from "../../utils/clipboard";
import { showNotice } from "../../utils/notice";
import { AGENT_TRANSLATE_TARGET_LABEL_KEYS } from "../../utils/selectionToolPolicy";
import { AgentInvokeAgentPicker } from "../selectionTool/AgentInvokeAgentPicker";
import { Button } from "../ui-shadcn/button";
import { Textarea } from "../ui-shadcn/textarea";
import { useSelectionWindowAgents } from "./useSelectionWindowAgents";
import { useSelectionWindowInvoke } from "./useSelectionWindowInvoke";

/** 每次主进程推送捕获都生成递增 id：同一段文本再次触发快捷键也要重新翻译。 */
type CaptureEntry = { id: number; payload: SelectionToolShowPayload };

const INVOKE_ACTIONS: readonly AgentInvokeAction[] = ["translate", "chat"];
const ACTION_LABEL_KEYS: Record<AgentInvokeAction, TranslationKey> = { translate: "selectionTool.translate", chat: "selectionTool.ask" };

/** 紧凑 chip：状态用 aria-pressed 暴露，选中态用主题色文字+浅底（--color-accent 是面不是字）。 */
function SelectionChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
	return (
		<button type="button" aria-pressed={active} onClick={onClick} className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-micro font-medium transition-colors", active ? "border-primary/40 bg-primary/10 text-primary" : "border-border-subtle text-muted-foreground hover:bg-accent-soft hover:text-foreground")}>
			{label}
		</button>
	);
}

/** 捕获失败/平台不支持的提示文案（reason 来自主进程，不在这里重新判断平台）。 */
function captureHint(reason: SelectionToolShowPayload["reason"]): string {
	if (reason === "unsupported") return t("selectionTool.unsupported");
	if (reason === "capture-failed") return t("selectionTool.captureFailed");
	return "";
}

/**
 * 系统级划词浮窗的根视图（独立 BrowserWindow，无 App 装配、无 Jotai Provider）。
 *
 * 交互（对齐浏览器划词插件）：
 * - 主进程每次推送捕获载荷：清空上一次结果、动作回到「翻译」、非空文本自动翻译一次；
 * - 头部拖拽区可拖动窗口；Escape 收起；Ctrl/Cmd+Enter 重新执行；
 * - 没有捕获文本（取词失败或用户手动打开）时显示输入框，允许粘贴文本后翻译；
 * - 结果可复制或「发送到 PiDeck」（插入主窗口当前会话输入框，成功后收起浮窗）。
 */
export function SelectionToolWindowView() {
	const { agents, defaultAgent, refresh: refreshAgents } = useSelectionWindowAgents();
	const { state: invokeState, run: runInvoke, cancel: cancelInvoke, reset: resetInvoke } = useSelectionWindowInvoke();
	const [capture, setCapture] = useState<CaptureEntry | null>(null);
	const [agentId, setAgentId] = useState<string | null>(null);
	const [action, setAction] = useState<AgentInvokeAction>("translate");
	const [targetLanguage, setTargetLanguage] = useState<AgentTranslateTarget>("auto");
	const [draft, setDraft] = useState("");
	const [inserting, setInserting] = useState(false);

	// 事件回调里不能用过期闭包：reset 放到 ref，捕获订阅整个生命周期只注册一次。
	const resetRef = useRef(resetInvoke);
	resetRef.current = resetInvoke;
	const refreshAgentsRef = useRef(refreshAgents);
	refreshAgentsRef.current = refreshAgents;
	const captureSeqRef = useRef(0);
	const autoRunCaptureRef = useRef(0);
	const targetLanguageRef = useRef(targetLanguage);
	targetLanguageRef.current = targetLanguage;

	const selectedAgent = useMemo(() => {
		const configured = agentId ? agents.find((agent) => agent.id === agentId) : null;
		return configured ?? defaultAgent;
	}, [agentId, agents, defaultAgent]);

	const capturedText = capture?.payload.text ?? "";
	const reasonHint = captureHint(capture?.payload.reason);
	const sourceText = capturedText.trim() ? capturedText : draft;

	// 捕获订阅：模块级 bridge 会缓存「React 挂载前就到达」的首个载荷，挂载时立即回放。
	useEffect(() => {
		const unsubscribe = subscribeSelectionCapture((payload) => {
			captureSeqRef.current += 1;
			setCapture({ id: captureSeqRef.current, payload });
			setDraft("");
			setAction("translate");
			resetRef.current();
			// 窗口常驻复用：每次弹出都重读智能体列表与主题，否则会拿着启动瞬间的旧配置。
			refreshAgentsRef.current();
			void applySelectionWindowAppearance();
		});
		return unsubscribe;
	}, []);

	// 非空捕获文本自动翻译一次。智能体快照可能晚于捕获到达：等 selectedAgent 就绪再跑，
	// autoRunCaptureRef 保证同一次捕获只自动跑一次（之后换智能体/动作不再偷跑）。
	useEffect(() => {
		if (!capture) return;
		if (!capture.payload.text.trim()) return;
		if (!selectedAgent) return;
		if (autoRunCaptureRef.current === capture.id) return;
		autoRunCaptureRef.current = capture.id;
		void runInvoke({ agent: selectedAgent, text: capture.payload.text, action: "translate", targetLanguage: targetLanguageRef.current });
	}, [capture, selectedAgent, runInvoke]);

	// 换智能体 = 另一次调用：清屏并作废进行中的 run，旧智能体的输出绝不串到新结果里。
	const agentScopeKey = selectedAgent?.id ?? "";
	const agentScopeRef = useRef(agentScopeKey);
	useEffect(() => {
		if (agentScopeRef.current === agentScopeKey) return;
		agentScopeRef.current = agentScopeKey;
		resetInvoke();
	}, [agentScopeKey, resetInvoke]);

	const running = invokeState.phase === "starting" || invokeState.phase === "streaming";
	const hasResult = invokeState.text.trim().length > 0;
	const canRun = Boolean(selectedAgent) && sourceText.trim().length > 0 && !running;
	const runLabel = hasResult || invokeState.phase === "error" ? t("agentInvoke.retry") : t("agentInvoke.run");
	const insertableText = (hasResult ? invokeState.text : sourceText).trim();

	const handleHide = useCallback(() => {
		void desktopApi.selectionTool.hide().catch(() => undefined);
	}, []);

	const handleRun = useCallback(() => {
		if (!selectedAgent || running) return;
		const text = sourceText.trim();
		if (!text) return;
		void runInvoke({ agent: selectedAgent, text, action, targetLanguage });
	}, [action, runInvoke, running, selectedAgent, sourceText, targetLanguage]);

	// 键盘：Escape 收起，Ctrl/Cmd+Enter 重新执行（与调用面板同一套键位习惯）。
	const handleRunRef = useRef(handleRun);
	handleRunRef.current = handleRun;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				handleHide();
				return;
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				handleRunRef.current();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [handleHide]);

	const handleDraftChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
		setDraft(event.target.value);
	}, []);

	const handleActionChange = useCallback(
		(next: AgentInvokeAction) => {
			if (next === action) return;
			setAction(next);
			// 动作变了，旧结果（另一种语义）继续展示会误导：清掉让用户重跑。
			resetInvoke();
		},
		[action, resetInvoke],
	);

	const handleTargetChange = useCallback(
		(next: AgentTranslateTarget) => {
			if (next === targetLanguage) return;
			setTargetLanguage(next);
			resetInvoke();
		},
		[resetInvoke, targetLanguage],
	);

	const handleCopy = useCallback(() => {
		if (!hasResult) return;
		void writeClipboard(invokeState.text).then((ok) => {
			showNotice(ok ? t("common.copied") : t("copy.failed"), 2400, ok ? undefined : "error");
		});
	}, [hasResult, invokeState.text]);

	const handleInsert = useCallback(() => {
		// 主进程按 SELECTION_TOOL_TEXT_MAX_CHARS 拒绝超长入参（不截断）：译文可能比原文长，
		// 这里先按同一上限截断，避免「模型给了结果却发不出去」。
		const text = insertableText.slice(0, SELECTION_TOOL_TEXT_MAX_CHARS);
		if (!text || inserting) return;
		setInserting(true);
		void desktopApi.selectionTool
			.insertToMain({ text })
			.then((ok) => {
				if (ok) {
					// 文本已进入主窗口输入框：浮窗继续挡着没有意义，直接收起。
					handleHide();
					return;
				}
				showNotice(t("selectionTool.insertEmpty"), 3000, "warning");
			})
			.catch(() => {
				showNotice(t("enhance.error.unavailable"), 4000, "error");
			})
			.finally(() => setInserting(false));
	}, [handleHide, insertableText, inserting]);

	return (
		<div role="dialog" aria-label={t("selectionTool.windowTitle")} className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
			<div className="flex h-8 shrink-0 items-center gap-1.5 px-2 [-webkit-app-region:drag]">
				<div className="flex min-w-0 flex-1 items-center [-webkit-app-region:no-drag]">
					<AgentInvokeAgentPicker agents={agents} selected={selectedAgent} onSelect={setAgentId} />
				</div>
				<div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
					{INVOKE_ACTIONS.map((next) => (
						<SelectionChip key={next} active={action === next} label={t(ACTION_LABEL_KEYS[next])} onClick={() => handleActionChange(next)} />
					))}
					<button type="button" className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label={t("selectionTool.hide")} title={t("selectionTool.hide")} onClick={handleHide}>
						<X size={13} aria-hidden="true" />
					</button>
				</div>
			</div>

			{action === "translate" ? (
				<div className="flex shrink-0 flex-wrap items-center gap-1 px-2 pt-0.5">
					<span className="shrink-0 text-micro text-muted-foreground">{t("selectionTool.targetLabel")}</span>
					{AGENT_TRANSLATE_TARGETS.map((target) => (
						<SelectionChip key={target} active={targetLanguage === target} label={t(AGENT_TRANSLATE_TARGET_LABEL_KEYS[target])} onClick={() => handleTargetChange(target)} />
					))}
				</div>
			) : null}

			{reasonHint ? <div className="mx-2 mt-1 shrink-0 rounded-md bg-warning/10 px-1.5 py-1 text-micro leading-snug text-warning">{reasonHint}</div> : null}

			<div className="flex shrink-0 flex-col px-2 pt-1.5">
				{capturedText.trim() ? (
					<div className="max-h-12 shrink-0 overflow-y-auto whitespace-pre-wrap rounded-md border border-border-subtle bg-muted/30 px-1.5 py-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{capturedText}</div>
				) : (
					<Textarea value={draft} onChange={handleDraftChange} maxLength={AGENT_INVOKE_TEXT_MAX_CHARS} rows={2} placeholder={t("selectionTool.windowEmpty")} aria-label={t("agentInvoke.sourceTitle")} className="max-h-12 min-h-10 shrink-0 resize-none text-xs" />
				)}
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-1 px-2 pt-1.5">
				<div className="flex shrink-0 items-center gap-1.5 text-micro text-muted-foreground">
					<span>{t("agentInvoke.resultTitle")}</span>
					{running ? (
						<span className="inline-flex items-center gap-1">
							<Loader2 size={10} className="animate-pideck-spin" aria-hidden="true" />
							{action === "translate" ? t("selectionTool.translating") : t("agentInvoke.running")}
						</span>
					) : null}
				</div>
				<div className="min-h-12 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-border-subtle bg-muted/20 px-1.5 py-1 text-sm [overflow-wrap:anywhere]">
					{invokeState.phase === "starting" ? (
						<span className="inline-flex items-center gap-1.5 text-muted-foreground">
							<Loader2 size={12} className="animate-pideck-spin" aria-hidden="true" />
							{t("agentInvoke.starting")}
						</span>
					) : invokeState.phase === "error" ? (
						<div className="flex flex-col gap-0.5 text-destructive">
							<span className="text-xs font-medium">{t("agentInvoke.errorTitle")}</span>
							<span className="text-xs">{invokeState.errorText}</span>
						</div>
					) : invokeState.text ? (
						<span>{invokeState.text}</span>
					) : (
						<span className="text-xs text-muted-foreground">{t("agentInvoke.emptyResult")}</span>
					)}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-1.5 px-2 py-1">
				{running ? (
					<Button size="sm" variant="outline" onClick={cancelInvoke}>
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
				<Button size="icon-sm" variant="ghost" aria-label={t("selectionTool.copy")} title={t("selectionTool.copy")} disabled={!hasResult} onClick={handleCopy}>
					<Copy size={13} aria-hidden="true" />
				</Button>
				<Button size="sm" variant="outline" disabled={!insertableText || inserting} onClick={handleInsert}>
					{inserting ? <Loader2 size={12} className="animate-pideck-spin" aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}
					{t("selectionTool.insertToMain")}
				</Button>
			</div>
		</div>
	);
}
