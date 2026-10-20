import { Bot, Plus, SearchX } from "lucide-react";
import type { AgentProfile } from "../../../../../shared/types/agentProfile";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { AgentMarketCard } from "./AgentMarketCard";

interface AgentMarketGridProps {
	/** 已过滤 + 已排序的智能体。 */
	agents: AgentProfile[];
	/** 未过滤的智能体总数：区分「空市场」与「搜索无结果」两种空态。 */
	totalCount: number;
	selectionDefaultId: string | null;
	selectedAgentId: string | null;
	/** 「使用」创建会话中的智能体 id：卡片按钮显示 loading 并忽略重复点击。 */
	usePendingId: string | null;
	onOpen: (agent: AgentProfile) => void;
	onUse: (agent: AgentProfile) => void;
	onEdit: (agent: AgentProfile) => void;
	onRequestDelete: (agent: AgentProfile) => void;
	onCreate: () => void;
}

/**
 * 响应式卡片网格 + 两种空态。
 * 列宽用 auto-fill/minmax：市场现在是随会话列伸缩的页面（不再被 Dialog 限宽 960），
 * 详情面板展开后网格自动减少列数，不需要为「详情是否展开」写第二套断点。
 */
export function AgentMarketGrid({ agents, totalCount, selectionDefaultId, selectedAgentId, usePendingId, onOpen, onUse, onEdit, onRequestDelete, onCreate }: AgentMarketGridProps) {
	if (agents.length === 0) {
		if (totalCount === 0) {
			return (
				<div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
					<span className="flex size-12 items-center justify-center rounded-2xl bg-bg-muted text-muted-foreground">
						<Bot className="size-6" aria-hidden="true" />
					</span>
					<p className="text-sm font-medium text-foreground">{t("agentMarket.empty")}</p>
					<p className="max-w-sm text-xs text-muted-foreground">{t("agentMarket.emptyDesc")}</p>
					<Button type="button" size="sm" className="mt-2 h-8 gap-1.5 text-xs" onClick={onCreate}>
						<Plus className="size-3.5" aria-hidden="true" />
						{t("agentMarket.create")}
					</Button>
				</div>
			);
		}
		return (
			<div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
				<SearchX className="size-6 text-muted-foreground" aria-hidden="true" />
				<p className="text-sm text-muted-foreground">{t("agentMarket.noResults")}</p>
			</div>
		);
	}

	return (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
			{agents.map((agent) => (
				<AgentMarketCard key={agent.id} agent={agent} selectionDefault={selectionDefaultId === agent.id} active={selectedAgentId === agent.id} usePending={usePendingId === agent.id} onOpen={onOpen} onUse={onUse} onEdit={onEdit} onRequestDelete={onRequestDelete} />
			))}
		</div>
	);
}
