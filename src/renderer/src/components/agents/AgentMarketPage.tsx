import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { AgentProfile } from "../../../../shared/types/agentProfile";
import { agentMarketEditingAgentIdAtom, agentMarketPageOpenAtom, closeAgentMarketPageAtom } from "../../atoms/agent-atoms";
import { t } from "../../i18n";
import { AgentMarketWorkspace } from "./market/AgentMarketWorkspace";

interface AgentMarketPageProps {
	/**
	 * 「使用」= 在该智能体指定的后端新建会话并绑定它（角色设定经隐藏通道注入，时间线只显示用户输入）。
	 * 成功返回 true：本页收起并露出新会话；失败返回 false：页面留在市场，原因由宿主的 toast 承担。
	 */
	onUseAgent: (agent: AgentProfile) => Promise<boolean>;
}

/**
 * 智能体市场页面宿主：非模态覆盖工作区会话列（与会话树的滚动/草稿/终端内存态共存），
 * 侧栏、右侧抽屉、底部停靠栏保持可交互——这是用户反馈「不要弹窗，直接做页面」的落地方式。
 *
 * 与 modal 的差异：没有 Dialog 遮罩/焦点陷阱；打开状态由 atom 驱动（侧栏 dock 按钮进入），
 * Esc 关闭。页面是否显示只看 agentMarketPageOpenAtom，关闭时整棵市场子树卸载，
 * 工作区的路由/搜索状态随之复位（与弹框关闭语义一致，无需额外清理）。
 */
export function AgentMarketPage({ onUseAgent }: AgentMarketPageProps) {
	const open = useAtomValue(agentMarketPageOpenAtom);
	const editingAgentId = useAtomValue(agentMarketEditingAgentIdAtom);
	const close = useSetAtom(closeAgentMarketPageAtom);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			// 下拉/模型选择器/确认框等 Radix 弹层自己消费 Escape（它们已 preventDefault），
			// 页面不能把「关掉下拉」抢成「关掉整个市场」。
			if (event.key !== "Escape" || event.defaultPrevented) return;
			close();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [close, open]);

	if (!open) return null;

	return (
		// inset-0 只覆盖会话列：与 HostPluginPageOverlay 同一层级约定，市场打开时会话树不卸载。
		<div className="absolute inset-0 z-30 flex flex-col bg-background" role="region" aria-label={t("agentMarket.title")}>
			<AgentMarketWorkspace initialEditingAgentId={editingAgentId} onUseAgent={onUseAgent} onClose={close} />
		</div>
	);
}
