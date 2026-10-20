import { useAtomValue, useSetAtom } from "jotai";
import { Bot } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { agentInvokePanelAtom, agentMarketSettingsAtom, agentProfilesAtom, closeAgentInvokePanelAtom, openAgentInvokePanelAtom } from "../../atoms/agent-atoms";
import { useSelectionTool } from "../../hooks/useSelectionTool";
import { t } from "../../i18n";
import { clampFloatingPosition, type SelectionAnchorRect } from "../../utils/selectionToolPolicy";
import { resolveDefaultSelectionAgent } from "../agents/agentMarketFilters";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import { AgentInvokePanel } from "./AgentInvokePanel";

export type SelectionToolHostProps = {
	/**
	 * 「发送到会话」：由 App 装配层实现（新建草稿会话 + agentMessage 隐藏通道注入角色设定）。
	 * 返回 false 表示宿主已 toast 过具体失败原因；面板只在 Promise reject 时补通用错误。
	 */
	onSendToSession: (input: { agentId: string; text: string }) => Promise<boolean>;
};

/** 测量前的估算尺寸：只影响首帧定位，useLayoutEffect 在绘制前换成真实尺寸。 */
const BUTTON_SIZE_FALLBACK = { width: 96, height: 30 };

/**
 * 划词工具唯一挂载点（App 根级渲染，全局一份）。
 *
 * 职责边界：
 * - 浮出按钮：选区出现后挂在选区附近（fixed + 视口夹紧），鼠标按下必须 preventDefault，
 *   否则浏览器默认的「按下清选区」会让快照失效；点击打开共享调用面板。
 * - 调用面板：同一份 atom 状态同时服务划词入口与市场「使用」入口（source 只影响定位与文案），
 *   绝不复制第二套面板。关闭时收起选区快照并把焦点还给页面。
 *
 * 所有浮层都 portal 到 body：会话区有独立滚动容器/裁剪，挂在 App 树里会被裁掉；
 * z 用 --z-popover（与 Radix 弹层同层：面板内下拉/Tooltip 后挂载，自然叠在面板之上）。
 */
export function SelectionToolHost({ onSendToSession }: SelectionToolHostProps) {
	const selection = useSelectionTool();
	const panelState = useAtomValue(agentInvokePanelAtom);
	const openInvokePanel = useSetAtom(openAgentInvokePanelAtom);
	const closeInvokePanel = useSetAtom(closeAgentInvokePanelAtom);
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const defaultAgent = useMemo(() => resolveDefaultSelectionAgent(agents, settings), [agents, settings]);

	const dismissSelection = selection.dismiss;
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const [buttonSize, setButtonSize] = useState(BUTTON_SIZE_FALLBACK);
	/** 打开面板那一刻的选区锚点：面板存续期间选区可能被输入框聚焦/流式渲染清掉，定位不能跟着丢。 */
	const panelAnchorRef = useRef<SelectionAnchorRect | null>(null);
	/** 打开前的焦点元素：关闭面板后把焦点还给页面（浮出按钮不抢焦点，mousedown 已 preventDefault）。 */
	const restoreFocusRef = useRef<HTMLElement | null>(null);

	// 按钮真实尺寸参与水平夹紧；每次渲染重测（浮层刚挂载时 ref 才可用），相等则不 setState。
	useLayoutEffect(() => {
		const element = buttonRef.current;
		if (!element) return;
		const width = element.offsetWidth;
		const height = element.offsetHeight;
		if (width > 0 && (width !== buttonSize.width || height !== buttonSize.height)) setButtonSize({ width, height });
	});

	const buttonPosition = useMemo(() => {
		if (!selection.anchorRect) return null;
		return clampFloatingPosition({
			anchor: selection.anchorRect,
			viewport: { width: window.innerWidth, height: window.innerHeight },
			size: buttonSize,
			gap: 6,
			margin: 8,
		});
	}, [buttonSize, selection.anchorRect]);

	const openPanelFromSelection = useCallback(() => {
		if (!selection.anchorRect) return;
		panelAnchorRef.current = selection.anchorRect;
		restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		openInvokePanel({ agentId: defaultAgent?.id ?? null, text: selection.text, source: "selection", action: "translate", targetLanguage: "auto" });
	}, [defaultAgent?.id, openInvokePanel, selection.anchorRect, selection.text]);

	const handlePanelClose = useCallback(() => {
		closeInvokePanel();
		dismissSelection();
		const target = restoreFocusRef.current;
		restoreFocusRef.current = null;
		if (target && target.isConnected) target.focus({ preventScroll: true });
		else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	}, [closeInvokePanel, dismissSelection]);

	const toolbarTitle = defaultAgent ? t("selectionTool.toolbarTitle", { name: defaultAgent.name }) : t("selectionTool.toolbarGeneric");

	// 没有选区、面板也关着：不往 body 里挂任何节点（全局监听仍由 useSelectionTool 持有）。
	if (!selection.active && !panelState.open) return null;

	return createPortal(
		<>
			{selection.active && !panelState.open && buttonPosition ? (
				<div data-selection-tool-ui="" className="fixed z-(--z-popover)" style={{ left: buttonPosition.left, top: buttonPosition.top }}>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								ref={buttonRef}
								type="button"
								onMouseDown={(event) => event.preventDefault()}
								onClick={openPanelFromSelection}
								aria-label={toolbarTitle}
								className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-xs font-medium text-popover-foreground shadow-lg transition-colors hover:bg-accent-soft"
							>
								{defaultAgent?.icon ? (
									<span className="text-sm leading-none" aria-hidden="true">
										{defaultAgent.icon}
									</span>
								) : (
									<Bot size={13} className="text-muted-foreground" aria-hidden="true" />
								)}
								<span>{t("selectionTool.toolbarLabel")}</span>
							</button>
						</TooltipTrigger>
						<TooltipContent side="top" sideOffset={6}>
							{toolbarTitle}
						</TooltipContent>
					</Tooltip>
				</div>
			) : null}
			{panelState.open ? <AgentInvokePanel anchorRect={panelState.source === "selection" ? panelAnchorRef.current : null} onClose={handlePanelClose} onSendToSession={onSendToSession} /> : null}
		</>,
		document.body,
	);
}
