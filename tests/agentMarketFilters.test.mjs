import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const readSource = (path) => readFileSync(path, "utf8");

/**
 * 智能体市场列表纯策略回归（AGENTS.md「纯策略可单测」）：
 * 1) 搜索大小写不敏感 + 首尾空白容忍，只命中名称/简介；
 * 2) 分类筛选与搜索组合；
 * 3) 市场排序内置优先（内置翻译最前），其余创建时间倒序；
 * 4) 划词默认智能体在被删除/未配置时回退内置翻译，空市场返回 null。
 */

const { EMPTY_AGENT_MARKET_FILTER, filterAgents, matchesAgentCategory, matchesAgentQuery, resolveDefaultSelectionAgent, sortAgentsForMarket } = loadTsCommonJs("src/renderer/src/components/agents/agentMarketFilters.ts");

/** 完整 AgentProfile 工厂：字段齐全，避免测试只覆盖部分字段时漏掉新契约字段。 */
function makeAgent(overrides = {}) {
	return {
		id: "agent-1",
		name: "Tech translator",
		description: "Translates technical documentation",
		icon: "🌐",
		systemPrompt: "You translate technical docs.",
		category: "general",
		createdAt: 1_000,
		updatedAt: 1_000,
		usageCount: 0,
		...overrides,
	};
}

const translateBuiltin = makeAgent({ id: "builtin-translate", name: "翻译助手", description: "中英互译", category: "translation", builtin: true, createdAt: 1 });
const generalBuiltin = makeAgent({ id: "builtin-general", name: "通用助手", description: "通用问答", category: "general", builtin: true, createdAt: 2 });
const writingAgent = makeAgent({ id: "custom-writing", name: "Copy editor", description: "Polishes marketing copy", category: "writing", createdAt: 5_000 });
const codingAgent = makeAgent({ id: "custom-coding", name: "Code reviewer", description: "Reviews pull requests", category: "coding", createdAt: 9_000 });

test("搜索命中名称，忽略大小写与首尾空白", () => {
	assert.equal(matchesAgentQuery(makeAgent({ name: "Tech Translator" }), "  tech TRANSLATOR  "), true);
});

test("搜索命中简介（描述里的关键词也算命中）", () => {
	assert.equal(matchesAgentQuery(makeAgent(), "technical documentation"), true);
});

test("空查询（含纯空白）匹配所有智能体", () => {
	const agent = makeAgent();
	assert.equal(matchesAgentQuery(agent, ""), true);
	assert.equal(matchesAgentQuery(agent, "   "), true);
});

test("名称与简介都不包含关键词时不命中", () => {
	assert.equal(matchesAgentQuery(makeAgent(), "kubernetes"), false);
});

test("分类筛选：all 不过滤，指定分类只命中同类", () => {
	assert.equal(matchesAgentCategory(codingAgent, "all"), true);
	assert.equal(matchesAgentCategory(codingAgent, "coding"), true);
	assert.equal(matchesAgentCategory(codingAgent, "writing"), false);
});

test("过滤组合分类与搜索，且不改动入参数组", () => {
	const agents = [translateBuiltin, writingAgent, codingAgent];
	const filtered = filterAgents(agents, { query: "reviewer", category: "coding" });
	// 展开成宿主数组再比：vm 沙箱里的数组原型与宿主不同，deepStrictEqual 会因原型不相等而误判。
	assert.deepEqual([...filtered.map((agent) => agent.id)], ["custom-coding"]);
	assert.equal(filterAgents(agents, { query: "reviewer", category: "writing" }).length, 0, "分类不匹配时搜索命中也不能返回");
	assert.equal(agents.length, 3, "过滤必须返回新数组，不能改动快照");
	assert.equal(EMPTY_AGENT_MARKET_FILTER.query, "");
	assert.equal(EMPTY_AGENT_MARKET_FILTER.category, "all");
});

test("市场排序：内置优先、内置翻译最前、其余创建时间倒序", () => {
	const sorted = sortAgentsForMarket([writingAgent, generalBuiltin, codingAgent, translateBuiltin]);
	assert.deepEqual([...sorted.map((agent) => agent.id)], ["builtin-translate", "builtin-general", "custom-coding", "custom-writing"]);
});

test("同一创建时间按名称稳定排序（刷新快照后卡片不跳位）", () => {
	const alpha = makeAgent({ id: "alpha", name: "Alpha", createdAt: 7_000 });
	const beta = makeAgent({ id: "beta", name: "Beta", createdAt: 7_000 });
	assert.deepEqual([...sortAgentsForMarket([beta, alpha]).map((agent) => agent.id)], ["alpha", "beta"]);
});

test("划词默认智能体：配置值命中即用", () => {
	const settings = { selectionToolEnabled: true, selectionToolAgentId: "custom-coding" };
	assert.equal(resolveDefaultSelectionAgent([translateBuiltin, codingAgent], settings)?.id, "custom-coding");
});

test("划词默认智能体被删除后回退内置翻译智能体", () => {
	const settings = { selectionToolEnabled: true, selectionToolAgentId: "deleted-agent" };
	assert.equal(resolveDefaultSelectionAgent([writingAgent, translateBuiltin], settings)?.id, "builtin-translate");
});

test("未配置默认智能体时同样回退内置翻译；没有内置时退第一个；空市场返回 null", () => {
	const unset = { selectionToolEnabled: true, selectionToolAgentId: null };
	assert.equal(resolveDefaultSelectionAgent([writingAgent, translateBuiltin], unset)?.id, "builtin-translate");
	assert.equal(resolveDefaultSelectionAgent([codingAgent, writingAgent], unset)?.id, "custom-coding");
	assert.equal(resolveDefaultSelectionAgent([], unset), null);
});

/**
 * 市场 UI 装配契约（源码扫描，空白容忍）：这几条是跨模块约定，
 * 改了会让 lead 的 App 装配或 selection-tool 的调用面板静默失联，必须被测试钉住。
 */
test("「使用」按分类分派 translate/chat，并以 source=market 打开调用面板", () => {
	const workspace = readSource("src/renderer/src/components/agents/market/AgentMarketWorkspace.tsx");
	assert.match(workspace, /openInvokePanel\(\{\s*agentId:\s*agent\.id,\s*action:\s*agent\.category\s*===\s*"translation"\s*\?\s*"translate"\s*:\s*"chat",\s*source:\s*"market",?\s*\}\)/);
});

test("「设为划词默认」走 agentProfiles.updateSettings（不自己拼快照）", () => {
	const actions = readSource("src/renderer/src/components/agents/market/useAgentMarketActions.ts");
	assert.match(actions, /desktopApi\.agentProfiles\.updateSettings\(\{\s*selectionToolAgentId:\s*agent\.id\s*\}\)/);
});

test("内置智能体删除入口禁用且带原因提示，普通智能体走确认弹框", () => {
	const card = readSource("src/renderer/src/components/agents/market/AgentMarketCard.tsx");
	// builtinNoDelete 同时用于按钮 title 与 Tooltip 内容：禁用按钮不触发指针事件，必须靠外层 span 承载提示。
	assert.ok((card.match(/agentMarket\.builtinNoDelete/g) ?? []).length >= 2, "内置删除原因必须同时出现在 title 与 Tooltip 文案里");
	assert.match(card, /agent\.builtin\s*\?/, "删除按钮必须按 builtin 分支禁用");
	const workspace = readSource("src/renderer/src/components/agents/market/AgentMarketWorkspace.tsx");
	assert.match(workspace, /<ConfirmDialog/, "删除自定义智能体必须经 ConfirmDialog 二次确认");
});

test("市场空态区分「还没有自定义智能体」与「没有匹配的智能体」", () => {
	const grid = readSource("src/renderer/src/components/agents/market/AgentMarketGrid.tsx");
	assert.match(grid, /t\("agentMarket\.empty"\)/);
	assert.match(grid, /t\("agentMarket\.noResults"\)/);
});
