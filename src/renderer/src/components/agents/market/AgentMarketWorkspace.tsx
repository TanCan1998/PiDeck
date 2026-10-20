import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowLeft, X } from "lucide-react";
import { agentMarketSettingsAtom, agentProfilesAtom, openAgentInvokePanelAtom } from "../../../atoms/agent-atoms";
import type { AgentProfile } from "../../../../../shared/types/agentProfile";
import { t } from "../../../i18n";
import { Badge } from "../../ui-shadcn/badge";
import { Button } from "../../ui-shadcn/button";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { EMPTY_AGENT_MARKET_FILTER, filterAgents, resolveDefaultSelectionAgent, sortAgentsForMarket, type AgentMarketCategoryFilter } from "../agentMarketFilters";
import { AgentMarketCategoryChips } from "./AgentMarketCategoryChips";
import { AgentMarketDetail } from "./AgentMarketDetail";
import { AgentMarketEditor } from "./AgentMarketEditor";
import { AgentMarketGrid } from "./AgentMarketGrid";
import { AgentMarketHeader } from "./AgentMarketHeader";
import { AgentMarketSettingsView } from "./AgentMarketSettingsView";
import { useAgentMarketActions } from "./useAgentMarketActions";

/** 市场内部路由：列表（含详情侧栏）/ 编辑器 / 划词设置。关闭弹框不在这里处理，归宿主 Dialog。 */
type AgentMarketRoute = { kind: "market" } | { kind: "editor"; agentId: string | null } | { kind: "settings" };

interface AgentMarketWorkspaceProps {
	/** 打开弹框时就指定编辑目标的智能体 id（市场内入口传入）；仅作初始路由，消费后由宿主清空。 */
	initialEditingAgentId: string | null;
	onClose: () => void;
}

/**
 * 智能体市场工作区：列表（搜索 + 分类 + 卡片网格 + 详情侧栏）、编辑器、划词设置三个视图。
 *
 * 路由状态留在这里而不是 atom：它只在弹框存活期间有意义，弹框关闭即卸载，
 * 不需要跨窗口/跨会话持久化。智能体数据与设置仍走 atoms（Lead 的 useAgentProfileSync 同步）。
 */
export function AgentMarketWorkspace({ initialEditingAgentId, onClose }: AgentMarketWorkspaceProps) {
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const openInvokePanel = useSetAtom(openAgentInvokePanelAtom);
	const actions = useAgentMarketActions();

	const [route, setRoute] = useState<AgentMarketRoute>(() => (initialEditingAgentId ? { kind: "editor", agentId: initialEditingAgentId } : { kind: "market" }));
	const [filter, setFilter] = useState(EMPTY_AGENT_MARKET_FILTER);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<AgentProfile | null>(null);

	const defaultSelection = resolveDefaultSelectionAgent(agents, settings);
	const visibleAgents = useMemo(() => filterAgents(sortAgentsForMarket(agents), filter), [agents, filter]);
	const selectedAgent = selectedAgentId ? (agents.find((agent) => agent.id === selectedAgentId) ?? null) : null;
	const editingAgent = route.kind === "editor" && route.agentId ? (agents.find((agent) => agent.id === route.agentId) ?? null) : null;

	// 编辑目标被删除后路由悬空：退回列表，避免编辑器对着不存在的智能体继续编辑。
	useEffect(() => {
		if (route.kind !== "editor" || !route.agentId || editingAgent) return;
		setRoute({ kind: "market" });
	}, [editingAgent, route]);

	// 详情面板选中的智能体被删除后自动收起。
	useEffect(() => {
		if (!selectedAgentId) return;
		if (agents.some((agent) => agent.id === selectedAgentId)) return;
		setSelectedAgentId(null);
	}, [agents, selectedAgentId]);

	const backToMarket = useCallback(() => {
		setRoute({ kind: "market" });
	}, []);

	const handleQueryChange = useCallback((query: string) => {
		setFilter((current) => ({ ...current, query }));
	}, []);

	const handleCategoryChange = useCallback((category: AgentMarketCategoryFilter) => {
		setFilter((current) => ({ ...current, category }));
	}, []);

	const handleEdit = useCallback((agent: AgentProfile) => {
		setRoute({ kind: "editor", agentId: agent.id });
	}, []);

	const handleUse = useCallback(
		(agent: AgentProfile) => {
			openInvokePanel({ agentId: agent.id, action: agent.category === "translation" ? "translate" : "chat", source: "market" });
			// 调用面板是独立浮层：市场弹框必须先让位，否则遮罩/弹框会盖住面板。
			onClose();
		},
		[onClose, openInvokePanel],
	);

	const handleConfirmDelete = async () => {
		const target = pendingDelete;
		setPendingDelete(null);
		if (target) await actions.deleteAgent(target);
	};

	const routeTitle = route.kind === "editor" ? (editingAgent ? t("agentMarket.edit") : t("agentMarket.create")) : t("agentMarket.settingsTitle");

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{route.kind === "market" ? (
				<>
					<AgentMarketHeader query={filter.query} onQueryChange={handleQueryChange} onCreate={() => setRoute({ kind: "editor", agentId: null })} onOpenSettings={() => setRoute({ kind: "settings" })} onClose={onClose} />
					<AgentMarketCategoryChips value={filter.category} onChange={handleCategoryChange} />
					<div className="flex min-h-0 flex-1">
						<div className="min-w-0 flex-1 overflow-y-auto px-5 py-3">
							<AgentMarketGrid
								agents={visibleAgents}
								totalCount={agents.length}
								selectionDefaultId={defaultSelection?.id ?? null}
								selectedAgentId={selectedAgentId}
								onOpen={(agent) => setSelectedAgentId(agent.id)}
								onUse={handleUse}
								onEdit={handleEdit}
								onRequestDelete={setPendingDelete}
								onCreate={() => setRoute({ kind: "editor", agentId: null })}
							/>
						</div>
						{selectedAgent && <AgentMarketDetail agent={selectedAgent} selectionDefault={defaultSelection?.id === selectedAgent.id} onClose={() => setSelectedAgentId(null)} onUse={handleUse} onEdit={handleEdit} onRequestDelete={setPendingDelete} />}
					</div>
				</>
			) : (
				<>
					<AgentMarketRouteHeader title={routeTitle} builtin={route.kind === "editor" && Boolean(editingAgent?.builtin)} onBack={backToMarket} onClose={onClose} />
					{route.kind === "editor" ? <AgentMarketEditor key={route.agentId ?? "new"} agent={editingAgent} onSaved={backToMarket} onCancel={backToMarket} /> : <AgentMarketSettingsView onBack={backToMarket} />}
				</>
			)}

			{pendingDelete && <ConfirmDialog title={t("agentMarket.deleteConfirmTitle")} message={t("agentMarket.deleteConfirmBody", { name: pendingDelete.name })} confirmLabel={t("common.delete")} danger onCancel={() => setPendingDelete(null)} onConfirm={() => void handleConfirmDelete()} />}
		</div>
	);
}

/** 编辑器/设置视图的共用子头部：返回市场 + 标题（+ 内置徽标）+ 关闭弹框。 */
function AgentMarketRouteHeader(props: { title: string; builtin: boolean; onBack: () => void; onClose: () => void }) {
	return (
		<header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/40 px-5 py-3">
			<div className="flex min-w-0 items-center gap-2">
				<Button type="button" variant="ghost" size="icon-sm" className="size-8 shrink-0 text-muted-foreground" title={t("common.back")} aria-label={t("common.back")} onClick={props.onBack}>
					<ArrowLeft className="size-4" aria-hidden="true" />
				</Button>
				<h1 className="truncate text-base font-semibold text-foreground">{props.title}</h1>
				{props.builtin && (
					<Badge variant="neutral" size="sm">
						{t("agentMarket.builtinBadge")}
					</Badge>
				)}
			</div>
			<Button type="button" variant="ghost" size="icon-sm" className="size-8 shrink-0 text-muted-foreground" title={t("common.close")} aria-label={t("common.close")} onClick={props.onClose}>
				<X className="size-4" aria-hidden="true" />
			</Button>
		</header>
	);
}
