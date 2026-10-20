/**
 * 智能体市场列表的纯策略：搜索/分类过滤、市场排序、划词默认智能体回退。
 *
 * 刻意不依赖 React/Jotai/i18n，组件只把快照与用户输入喂进来，
 * 策略本身由 tests/agentMarketFilters.test.mjs 直接单测（AGENTS.md「纯策略可单测」）。
 */
import { BUILTIN_TRANSLATE_AGENT_ID, type AgentMarketSettings, type AgentProfile, type AgentProfileCategory } from "../../../../shared/types/agentProfile";

/** 分类筛选值：all = 不过滤（对应市场分类 chips 的「全部」）。 */
export type AgentMarketCategoryFilter = AgentProfileCategory | "all";

export type AgentMarketFilter = {
	query: string;
	category: AgentMarketCategoryFilter;
};

/** 空筛选：市场刚打开、用户还没输入时的默认值。 */
export const EMPTY_AGENT_MARKET_FILTER: AgentMarketFilter = { query: "", category: "all" };

/** 查询串归一化：去首尾空白 + 小写；空串表示「不过滤」。 */
export function normalizeAgentMarketQuery(query: string): string {
	return query.trim().toLowerCase();
}

/**
 * 搜索命中判定：名称或简介包含查询串即命中（大小写不敏感）。
 * 只在名称/简介里找，不匹配分类与角色设定——分类有自己的 chips，正文太长会变成噪声命中。
 */
export function matchesAgentQuery(agent: AgentProfile, query: string): boolean {
	const needle = normalizeAgentMarketQuery(query);
	if (!needle) return true;
	return agent.name.toLowerCase().includes(needle) || agent.description.toLowerCase().includes(needle);
}

export function matchesAgentCategory(agent: AgentProfile, category: AgentMarketCategoryFilter): boolean {
	return category === "all" || agent.category === category;
}

/** 过滤 = 分类 ∧ 搜索；返回新数组，不改动入参（atom 里的快照数组要原样保留）。 */
export function filterAgents(agents: readonly AgentProfile[], filter: AgentMarketFilter): AgentProfile[] {
	return agents.filter((agent) => matchesAgentCategory(agent, filter.category) && matchesAgentQuery(agent, filter.query));
}

/**
 * 市场排序权重：内置优先（其中内置翻译智能体排最前，它是划词工具的默认回退），
 * 其余按创建时间倒序，同名按名称稳定排序——保证刷新快照后卡片位置不跳。
 */
function compareAgentsForMarket(left: AgentProfile, right: AgentProfile): number {
	const leftBuiltin = left.builtin === true;
	const rightBuiltin = right.builtin === true;
	if (leftBuiltin !== rightBuiltin) return leftBuiltin ? -1 : 1;
	const leftTranslate = left.id === BUILTIN_TRANSLATE_AGENT_ID;
	const rightTranslate = right.id === BUILTIN_TRANSLATE_AGENT_ID;
	if (leftTranslate !== rightTranslate) return leftTranslate ? -1 : 1;
	return right.createdAt - left.createdAt || left.name.localeCompare(right.name);
}

export function sortAgentsForMarket(agents: readonly AgentProfile[]): AgentProfile[] {
	return [...agents].sort(compareAgentsForMarket);
}

/**
 * 划词工具的生效默认智能体：配置值命中即用；配置指向已删除的智能体（或未配置）时
 * 回退内置翻译智能体（契约见 AgentMarketSettings.selectionToolAgentId 注释），
 * 再退列表第一个；空列表返回 null，调用方据此隐藏划词入口。
 */
export function resolveDefaultSelectionAgent(agents: readonly AgentProfile[], settings: AgentMarketSettings): AgentProfile | null {
	const configuredId = settings.selectionToolAgentId;
	if (configuredId) {
		const configured = agents.find((agent) => agent.id === configuredId);
		if (configured) return configured;
	}
	const builtinTranslate = agents.find((agent) => agent.id === BUILTIN_TRANSLATE_AGENT_ID);
	if (builtinTranslate) return builtinTranslate;
	return agents[0] ?? null;
}
