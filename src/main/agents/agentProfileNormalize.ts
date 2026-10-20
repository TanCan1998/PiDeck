/**
 * 智能体配置的纯归一化层（无 IO、无状态）：读盘前向兼容、IPC/存储入参收敛、
 * 设置与默认智能体的悬空清理都收在这里，AgentProfileStore 只负责串行写与快照。
 *
 * 两条归一化语义刻意分开：
 * - 读盘（normalizePersistedState）：坏值尽量修复（钳长度、补默认、丢坏模型、去重 id），绝不抛错；
 * - 入参（normalizeCreateInput / applyAgentProfilePatch）：必填项缺失才抛错（IPC 边界已先拒绝）。
 */

import { AGENT_PROFILE_CATEGORIES, AGENT_PROFILE_DESCRIPTION_MAX_CHARS, AGENT_PROFILE_ICON_MAX_CHARS, AGENT_PROFILE_NAME_MAX_CHARS, AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS, type AgentMarketSettings, type AgentModelRef, type AgentProfile, type AgentProfileCategory, type CreateAgentProfileInput } from "../../shared/types";
import { BUILTIN_AGENT_SEEDS, createBuiltinAgentProfile } from "./builtinAgents";

export const SCHEMA_VERSION = 1;

/** 市场设置缺省值：划词工具默认开启（核心入口），默认智能体留空 = 渲染层回退内置翻译官。 */
export const DEFAULT_AGENT_MARKET_SETTINGS: AgentMarketSettings = { selectionToolEnabled: true, selectionToolAgentId: null };

/** 模型/供应商标识的形态上限：真实目录键可能是中文、冒号或 URL，只卡长度与控制字符，不复制 pi 命名文法。 */
export const AGENT_MODEL_FIELD_MAX_CHARS = 200;

const MAX_AGENT_ID_CHARS = 200;
const MODEL_FIELD_CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/u;

/** 落盘结构；version 用于未来迁移，revision 与市场快照的 revision 同源。 */
export type PersistedAgentProfileState = {
	version: number;
	revision: number;
	settings: AgentMarketSettings;
	agents: AgentProfile[];
};

/**
 * 主进程侧更新入参：比渲染层契约多一个 model: null 语义。
 * null（以及成对的空串 {@provider:"",modelId:""}）表示清空首选模型 = 跟随会话；键缺失才表示保留原值。
 */
export type AgentProfilePatch = Omit<Partial<CreateAgentProfileInput>, "model"> & { model?: AgentModelRef | null };

/** 新建时由归一化层决定的内容字段（id / 时间戳 / 使用统计由存储层补）。 */
export type NormalizedAgentProfileContent = {
	name: string;
	description: string;
	icon: string;
	systemPrompt: string;
	category: AgentProfileCategory;
	model?: AgentModelRef;
};

export function createEmptyState(): PersistedAgentProfileState {
	return { version: SCHEMA_VERSION, revision: 0, settings: { ...DEFAULT_AGENT_MARKET_SETTINGS }, agents: [] };
}

/**
 * 读盘归一化。
 * changed 用「规范化结果的键序无关序列化」对比原文件判断：字段被钳长度、补默认、丢弃坏值
 * 或去掉未知键都算变化，需要写回磁盘；否则每次启动都会把同一份脏数据重复修一遍。
 */
export function normalizePersistedState(value: unknown, now: number): { state: PersistedAgentProfileState; changed: boolean } {
	const record = isRecord(value) ? value : {};
	const rawAgents = Array.isArray(record.agents) ? record.agents : [];
	const seen = new Set<string>();
	const agents: AgentProfile[] = [];
	for (const entry of rawAgents) {
		const agent = normalizePersistedAgent(entry, now);
		// 重复 id 只保留第一条：按 id 查找/更新的语义要求 id 唯一，手工改坏的文件最容易撞这里。
		if (!agent || seen.has(agent.id)) continue;
		seen.add(agent.id);
		agents.push(agent);
	}
	const state: PersistedAgentProfileState = {
		version: SCHEMA_VERSION,
		revision: finiteInteger(record.revision, 0),
		// 设置里的默认智能体是否悬空要等种子补齐后由 resolveSelectionAgent 判定，这里只收敛形状。
		settings: normalizeSettingsShape(record.settings),
		agents,
	};
	return { state, changed: canonicalJson(value) !== canonicalJson(state) };
}

function normalizePersistedAgent(value: unknown, now: number): AgentProfile | undefined {
	// id 是唯一身份：缺失/非字符串的条目无法被查找、编辑或调用，只能丢弃。
	if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return undefined;
	const id = clampText(value.id.trim(), MAX_AGENT_ID_CHARS);
	const createdAt = finiteInteger(value.createdAt, now);
	const updatedAt = Math.max(createdAt, finiteInteger(value.updatedAt, createdAt));
	const model = normalizeModelRef(value.model);
	// 名字缺失时用 id 兜底：比「未命名」可定位，也不会把主进程文案写进用户数据。
	const name = clampText(trimmedText(value.name), AGENT_PROFILE_NAME_MAX_CHARS) || id;
	return {
		id,
		name,
		description: clampText(trimmedText(value.description), AGENT_PROFILE_DESCRIPTION_MAX_CHARS),
		icon: clampText(trimmedText(value.icon), AGENT_PROFILE_ICON_MAX_CHARS),
		systemPrompt: clampText(trimmedText(value.systemPrompt), AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS),
		...(model ? { model } : {}),
		category: isAgentProfileCategory(value.category) ? value.category : "general",
		...(value.builtin === true ? { builtin: true } : {}),
		createdAt,
		updatedAt,
		usageCount: finiteInteger(value.usageCount, 0),
		...(finiteOptional(value.lastUsedAt) === undefined ? {} : { lastUsedAt: finiteOptional(value.lastUsedAt) }),
	};
}

/** 只按 id 补种缺失的内置智能体：用户改过内置内容就保留现状（升级应用不覆盖用户的编辑）。 */
export function seedMissingBuiltins(agents: readonly AgentProfile[]): AgentProfile[] {
	const existing = new Set(agents.map((agent) => agent.id));
	const missing = BUILTIN_AGENT_SEEDS.filter((seed) => !existing.has(seed.id)).map((seed) => createBuiltinAgentProfile(seed));
	return missing.length > 0 ? [...missing, ...agents] : [...agents];
}

/** 默认智能体必须仍然存在：指向已删除 id 时回退「未设置」（渲染层再回退内置翻译官）。 */
export function resolveSelectionAgent(settings: AgentMarketSettings, agents: readonly AgentProfile[]): AgentMarketSettings {
	const selected = settings.selectionToolAgentId;
	if (selected === null) return settings;
	return agents.some((agent) => agent.id === selected) ? settings : { ...settings, selectionToolAgentId: null };
}

export function normalizeSettings(value: unknown, agents: readonly AgentProfile[]): AgentMarketSettings {
	return resolveSelectionAgent(normalizeSettingsShape(value), agents);
}

function normalizeSettingsShape(value: unknown): AgentMarketSettings {
	const record = isRecord(value) ? value : {};
	const enabled = typeof record.selectionToolEnabled === "boolean" ? record.selectionToolEnabled : DEFAULT_AGENT_MARKET_SETTINGS.selectionToolEnabled;
	const selected = typeof record.selectionToolAgentId === "string" ? clampText(record.selectionToolAgentId.trim(), MAX_AGENT_ID_CHARS) : "";
	return { selectionToolEnabled: enabled, selectionToolAgentId: selected || null };
}

export function normalizeCreateInput(input: CreateAgentProfileInput): NormalizedAgentProfileContent {
	const model = normalizeModelRef(input.model);
	return {
		name: normalizeRequiredText(input.name, "Agent name", AGENT_PROFILE_NAME_MAX_CHARS),
		description: normalizeOptionalText(input.description, AGENT_PROFILE_DESCRIPTION_MAX_CHARS),
		icon: normalizeOptionalText(input.icon, AGENT_PROFILE_ICON_MAX_CHARS),
		systemPrompt: normalizeRequiredText(input.systemPrompt, "Agent system prompt", AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS),
		category: isAgentProfileCategory(input.category) ? input.category : "general",
		...(model ? { model } : {}),
	};
}

/** 更新补丁叠加：缺键保留原值；model 用 hasOwn 判定（null / 空串对 = 清空首选模型）。 */
export function applyAgentProfilePatch(current: AgentProfile, patch: AgentProfilePatch, now: number): AgentProfile {
	const next: AgentProfile = {
		...current,
		name: patch.name === undefined ? current.name : normalizeRequiredText(patch.name, "Agent name", AGENT_PROFILE_NAME_MAX_CHARS),
		description: patch.description === undefined ? current.description : normalizeOptionalText(patch.description, AGENT_PROFILE_DESCRIPTION_MAX_CHARS),
		icon: patch.icon === undefined ? current.icon : normalizeOptionalText(patch.icon, AGENT_PROFILE_ICON_MAX_CHARS),
		systemPrompt: patch.systemPrompt === undefined ? current.systemPrompt : normalizeRequiredText(patch.systemPrompt, "Agent system prompt", AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS),
		category: patch.category === undefined ? current.category : isAgentProfileCategory(patch.category) ? patch.category : "general",
		updatedAt: now,
	};
	if (Object.hasOwn(patch, "model")) {
		const model = normalizeModelRef(patch.model);
		if (model) next.model = model;
		else delete next.model;
	}
	return next;
}

/**
 * 副本命名：`名称 (2)`、`名称 (3)`……取第一个未被占用的序号。
 * 序号属于数据而非 UI 文案（任何语言下都可读，不需要 i18n 词典），既让副本可区分，
 * 又不会覆盖用户已有的同名智能体；连续复制时先剥掉旧序号再递增，避免 (2)(2)。
 */
export function uniqueCopyName(baseName: string, agents: readonly AgentProfile[]): string {
	const base = baseName.replace(/\s*\(\d+\)$/, "").trim() || baseName;
	const taken = new Set(agents.map((agent) => agent.name));
	for (let index = 2; index <= 9_999; index += 1) {
		const candidate = clampText(`${base} (${index})`, AGENT_PROFILE_NAME_MAX_CHARS);
		if (!taken.has(candidate)) return candidate;
	}
	return clampText(`${base} (${agents.length + 1})`, AGENT_PROFILE_NAME_MAX_CHARS);
}

/**
 * 模型引用归一化：半截引用（只填 provider 或只填 modelId）与非法字符一律丢弃，
 * 等价于「跟随会话模型」——绝不落盘一个查不到的 provider/modelId 组合。
 */
export function normalizeModelRef(value: unknown): AgentModelRef | undefined {
	if (!isRecord(value)) return undefined;
	if (!isAgentModelFieldValid(value.provider) || !isAgentModelFieldValid(value.modelId)) return undefined;
	return { provider: value.provider, modelId: value.modelId };
}

/** 模型/供应商标识的边界与读盘共用规则：trim 后非空、不超长、无控制字符。 */
export function isAgentModelFieldValid(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= AGENT_MODEL_FIELD_MAX_CHARS && !MODEL_FIELD_CONTROL_CHARACTERS.test(value);
}

/** 分类白名单判定：筛选器与编辑器下拉只认这五个值，未知值会让智能体在 UI 里「消失」。 */
export function isAgentProfileCategory(value: unknown): value is AgentProfileCategory {
	return AGENT_PROFILE_CATEGORIES.some((category) => category === value);
}

function normalizeRequiredText(value: unknown, label: string, maxLength: number): string {
	const text = trimmedText(value);
	// 必填字段空值抛错：IPC 边界已先拒绝，这里兜住直接调用 store 的内部路径。
	if (!text) throw new Error(`${label} is required`);
	return clampText(text, maxLength);
}

function normalizeOptionalText(value: unknown, maxLength: number): string {
	return clampText(trimmedText(value), maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function clampText(value: string, maxLength: number): string {
	return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function finiteInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function finiteOptional(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 键序无关的序列化：判断「用户文件与归一化结果是否一致」时，
 * 直接 JSON.stringify 会把键顺序差异误判成变化（每次启动白写一次盘）。
 */
function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalize(item));
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
		return sorted;
	}
	return value;
}
