import { useCallback } from "react";
import { useAtom } from "jotai";
import { agentMarketEditingAgentIdAtom, agentMarketModalOpenAtom } from "../../atoms/agent-atoms";
import { t } from "../../i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { AgentMarketWorkspace } from "./market/AgentMarketWorkspace";

/**
 * 智能体市场弹框宿主。
 *
 * chrome 与 AutomationModal 对齐（xl 尺寸 + 弹框内自带头部/关闭按钮，showCloseButton={false}）；
 * 打开时 agentMarketEditingAgentIdAtom 非空表示直接进入该智能体的编辑页（市场内入口用）。
 * DialogContent 关闭即卸载，工作区路由状态随之重置，因此关闭时只需清空编辑目标。
 */
export function AgentMarketModal() {
	const [open, setOpen] = useAtom(agentMarketModalOpenAtom);
	const [editingAgentId, setEditingAgentId] = useAtom(agentMarketEditingAgentIdAtom);

	const close = useCallback(() => {
		setOpen(false);
		setEditingAgentId(null);
	}, [setEditingAgentId, setOpen]);

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (nextOpen) {
				setOpen(true);
				return;
			}
			close();
		},
		[close, setOpen],
	);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent size="xl" stagger showCloseButton={false} className="flex h-[min(720px,calc(100vh-64px))] max-w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden bg-background p-0">
				<DialogHeader className="sr-only">
					<DialogTitle>{t("agentMarket.title")}</DialogTitle>
				</DialogHeader>
				<AgentMarketWorkspace initialEditingAgentId={editingAgentId} onClose={close} />
			</DialogContent>
		</Dialog>
	);
}
