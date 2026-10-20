import { atom } from "jotai";
import type { AgentMarketSettings, AgentProfile, AgentProfileSnapshot } from "../../../shared/types";

/** 主进程智能体市场快照（agents + settings + revision）。null = 尚未取到初始快照。 */
export const agentProfileSnapshotAtom = atom<AgentProfileSnapshot | null>(null);

/** 按展示顺序排序的智能体列表：内置在前（翻译默认第一个），其余按创建时间倒序。 */
export const agentProfilesAtom = atom<AgentProfile[]>((get) => {
	const snapshot = get(agentProfileSnapshotAtom);
	if (!snapshot) return [];
	return [...snapshot.agents].sort((left, right) => {
		if (Boolean(left.builtin) !== Boolean(right.builtin)) return left.builtin ? -1 : 1;
		return right.createdAt - left.createdAt || left.name.localeCompare(right.name);
	});
});

/** 市场全局设置（划词工具开关 + 默认智能体）；快照未到时的保守默认（与主进程缺省一致）。 */
export const agentMarketSettingsAtom = atom<AgentMarketSettings>((get) => {
	const snapshot = get(agentProfileSnapshotAtom);
	return snapshot?.settings ?? { selectionToolEnabled: true, systemSelectionEnabled: false, selectionToolAgentId: null, sessionAgentBindings: {} };
});

/** 市场页面打开时直接进入编辑页的智能体 id（null = 列表）。 */
export const agentMarketEditingAgentIdAtom = atom<string | null>(null);

/** 智能体市场页面（非模态页面式覆盖会话区）是否打开：从侧栏入口进入，关闭按钮/Esc 还原会话。 */
export const agentMarketPageOpenAtom = atom<boolean>(false);

/** 打开智能体市场页面；editingAgentId 非空时直接进入该智能体的编辑页。 */
export const openAgentMarketPageAtom = atom(null, (_get, set, editingAgentId?: string | null) => {
	set(agentMarketEditingAgentIdAtom, editingAgentId ?? null);
	set(agentMarketPageOpenAtom, true);
});

export const closeAgentMarketPageAtom = atom(null, (_get, set) => {
	set(agentMarketPageOpenAtom, false);
	set(agentMarketEditingAgentIdAtom, null);
});

/**
 * 应用内划词的「原地工具栏」请求：会话时间线自带的「引用并提问」浮层里点「翻译」时写入，
 * 由全局 SelectionToolHost 消费（同一时间只有一个工具栏，避免两套浮层叠在一起）。
 */
export type SelectionInlineRequest = { text: string; rect: { top: number; left: number; width: number; height: number } };

export const selectionInlineRequestAtom = atom<SelectionInlineRequest | null>(null);

export const openSelectionInlineAtom = atom(null, (_get, set, request: SelectionInlineRequest) => {
	set(selectionInlineRequestAtom, request);
});

export const clearSelectionInlineAtom = atom(null, (_get, set) => {
	set(selectionInlineRequestAtom, null);
});

/**
 * 会话时间线的「引用并提问」浮层当前是否可见。
 * 可见时全局划词浮钮不再重复出现（两个浮层叠在选区上就是用户报的「划词菜单冲突」）；
 * 翻译入口改由该浮层里的第二个按钮提供。
 */
export const quoteToolbarVisibleAtom = atom<boolean>(false);
