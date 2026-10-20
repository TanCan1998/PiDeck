import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveEnhanceTargetModel } from "../../../shared/enhanceModelPreference";
import { AGENT_INVOKE_TEXT_MAX_CHARS, type AgentInvokeAction, type AgentProfile, type AgentTranslateTarget } from "../../../shared/types/agentProfile";
import type { EnhanceErrorKind } from "../../../shared/types/enhance";
import { enhanceModelAtom } from "../atoms/composer-atoms";
import { currentSessionAtom } from "../atoms/session-atoms";
import { desktopApi } from "../desktopApi";
import { getI18nLocale, t } from "../i18n";
import { readWelcomeModelPreference } from "../utils/chatSessionBootstrap";
import { showNotice } from "../utils/notice";
import { AGENT_TRANSLATE_TARGET_LABEL_KEYS, buildTranslateInstruction } from "../utils/selectionToolPolicy";

/** 一次调用面板的运行阶段：starting = 已受理还没首个 delta；streaming = 正文在增长。 */
export type AgentInvokePhase = "idle" | "starting" | "streaming" | "done" | "error";

export type AgentInvokeViewState = {
	phase: AgentInvokePhase;
	/** 流式累积正文；done 后用主进程终态全文替换。 */
	text: string;
	/** 错误分类（phase="error" 时非空，供调用方决定标题/重试提示）。 */
	errorKind: EnhanceErrorKind | null;
	/** error 阶段的用户可读文案（已按 errorKind 映射 i18n）；其余阶段空串。 */
	errorText: string;
};

const IDLE_STATE: AgentInvokeViewState = { phase: "idle", text: "", errorKind: null, errorText: "" };

export type AgentInvokeRequest = {
	text: string;
	action: AgentInvokeAction;
	targetLanguage: AgentTranslateTarget;
};

/** 错误分类 → 用户可读文案（key 必须静态，动态模板串过不了类型检查；与 usePromptEnhance 同一套词典）。 */
function invokeErrorText(kind: EnhanceErrorKind): string {
	switch (kind) {
		case "model-not-found":
			return t("enhance.error.modelNotFound");
		case "model-error":
			return t("enhance.error.modelError");
		case "timeout":
			return t("enhance.error.timeout");
		case "wsl":
			return t("enhance.error.wsl");
		case "no-pi-entry":
			return t("enhance.error.noPiEntry");
		case "helper-missing":
			return t("enhance.error.helperMissing");
		case "sdk-unavailable":
		case "spawn-failed":
		case "protocol":
		case "busy":
		case "invalid-request":
		case "no-provider":
			return t("enhance.error.unavailable");
		case "aborted":
			return t("enhance.stopped");
	}
}

/**
 * 智能体一次性调用的渲染域状态机（划词翻译 / 市场「使用」共用）。
 *
 * 链路：run() 解析目标模型 → agent-profiles:invoke → 按 runId 过滤的流式事件
 * （started/delta/done/aborted/error）→ 面板展示。语义与 usePromptEnhance 对齐：
 * - starting/streaming 都是显式阶段，任何时刻可 cancel（stop 按钮 / 换智能体自动作废）；
 * - aborted 一律静默回 idle（用户主动停或被新 run 取代，都不该报错打扰）；
 * - 卸载/作用域变化必须取消进行中的 run，并与事件订阅成对清理（生命周期配对）。
 *
 * 模型解析优先级（产品要求，与提示词增强同一套回退函数）：
 * 智能体自身模型 > 当前会话记录模型 > 设置固定增强模型 > 引导页点选偏好。
 */
export function useAgentInvoke(input: { agent: AgentProfile | null; scopeKey: string }) {
	const currentSession = useAtomValue(currentSessionAtom);
	const enhanceModel = useAtomValue(enhanceModelAtom);
	const [state, setState] = useState<AgentInvokeViewState>(IDLE_STATE);
	const runIdRef = useRef("");
	const mountedRef = useRef(true);

	const reset = useCallback(() => {
		if (runIdRef.current) {
			runIdRef.current = "";
			void desktopApi.agentProfiles.cancelInvoke().catch(() => undefined);
		}
		setState(IDLE_STATE);
	}, []);

	/** 主动停止：保留已收到的部分结果（用户要的是「别再生成」，不是丢掉已有输出）。 */
	const cancel = useCallback(() => {
		if (!runIdRef.current) return;
		runIdRef.current = "";
		void desktopApi.agentProfiles.cancelInvoke().catch(() => undefined);
		setState((current) => ({ ...current, phase: "idle" }));
	}, []);

	const captureModel = useCallback(() => {
		const agent = input.agent;
		if (!agent) return null;
		// resolveEnhanceTargetModel 只做「逐级取第一个双字段有效的候选」，槽位名沿用其文档语义；
		// 这里把「设置固定增强模型」放进 welcome 槽，实现上面的产品优先级（不复制可用性校验）。
		return resolveEnhanceTargetModel({
			configured: agent.model,
			recordModel: currentSession?.model,
			welcomeModel: enhanceModel ?? undefined,
			fallback: readWelcomeModelPreference()?.model,
		});
	}, [currentSession?.model, enhanceModel, input.agent]);

	const run = useCallback(
		(request: AgentInvokeRequest) => {
			if (runIdRef.current) return; // 运行中再触发：UI 已是 stop 态，正常路径到不了；防连点双跑
			const agent = input.agent;
			if (!agent) {
				showNotice(t("agentInvoke.selectAgent"), 4000);
				return;
			}
			const text = request.text.trim().slice(0, AGENT_INVOKE_TEXT_MAX_CHARS);
			if (!text) return;
			const model = captureModel();
			if (!model) {
				// 发不出请求就绝不发：没有模型的静默等待比明确提示更糟。
				showNotice(t("agentInvoke.noModel"), 4000);
				return;
			}
			const locale = getI18nLocale().startsWith("zh") ? "zh" : "en";
			const instruction = buildTranslateInstruction({
				action: request.action,
				targetLanguage: request.targetLanguage,
				targetLabel: t(AGENT_TRANSLATE_TARGET_LABEL_KEYS[request.targetLanguage]),
				locale,
			});
			const candidateRunId = `pending-${Math.random().toString(36).slice(2)}`;
			// 先占位：IPC 受理返回前用户再点直接忽略，也挡住连点双跑。
			runIdRef.current = candidateRunId;
			setState({ phase: "starting", text: "", errorKind: null, errorText: "" });
			void desktopApi.agentProfiles
				.invoke({
					agentId: agent.id,
					text,
					action: request.action,
					...(request.action === "translate" ? { targetLanguage: request.targetLanguage } : {}),
					...(instruction ? { instruction } : {}),
					model,
				})
				.then((result) => {
					if (!mountedRef.current || runIdRef.current !== candidateRunId) {
						// 等待受理期间已取消/切智能体/卸载：受理成功后立刻作废这次 run，避免后台空跑。
						if (result.ok) void desktopApi.agentProfiles.cancelInvoke().catch(() => undefined);
						return;
					}
					if (!result.ok) {
						runIdRef.current = "";
						setState({ phase: "error", text: "", errorKind: result.errorKind, errorText: invokeErrorText(result.errorKind) });
						return;
					}
					runIdRef.current = result.runId;
				})
				.catch(() => {
					if (!mountedRef.current || runIdRef.current !== candidateRunId) return;
					runIdRef.current = "";
					setState({ phase: "error", text: "", errorKind: "spawn-failed", errorText: t("enhance.error.unavailable") });
				});
		},
		[captureModel, input.agent],
	);

	// 事件订阅：按当前 runId 过滤（同一渲染进程只有本 hook 实例会命中自己的 run）。
	useEffect(() => {
		const unsubscribe = desktopApi.agentProfiles.onInvokeEvent((event) => {
			if (!runIdRef.current || event.runId !== runIdRef.current) return;
			switch (event.phase) {
				case "started":
					// 保持 starting：面板在首个 delta 前显示「正在连接模型…」。
					break;
				case "delta":
					setState((current) => ({ phase: "streaming", text: current.text + event.text, errorKind: null, errorText: "" }));
					break;
				case "done":
					runIdRef.current = "";
					setState({ phase: "done", text: event.text, errorKind: null, errorText: "" });
					break;
				case "aborted":
					runIdRef.current = "";
					setState((current) => ({ ...current, phase: "idle", errorKind: null, errorText: "" }));
					break;
				case "error":
					runIdRef.current = "";
					setState({ phase: "error", text: "", errorKind: event.errorKind, errorText: invokeErrorText(event.errorKind) });
					break;
			}
		});
		return unsubscribe;
	}, []);

	// 卸载：作废进行中的 run 并标记已卸载（受理回调不再 setState）；StrictMode 二次挂载时重置标记。
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (runIdRef.current) {
				runIdRef.current = "";
				void desktopApi.agentProfiles.cancelInvoke().catch(() => undefined);
			}
		};
	}, []);

	// 换智能体 = 另一次调用：清空结果并作废进行中的 run，旧智能体的流式输出绝不串到新面板。
	const scopeKeyRef = useRef(input.scopeKey);
	useEffect(() => {
		if (scopeKeyRef.current === input.scopeKey) return;
		scopeKeyRef.current = input.scopeKey;
		reset();
	}, [input.scopeKey, reset]);

	return { state, run, cancel, reset };
}
