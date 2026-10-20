import { atom } from "jotai";
import type { AgentInvokeAction, AgentMarketSettings, AgentProfile, AgentProfileSnapshot, AgentTranslateTarget } from "../../../shared/types";

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
	return snapshot?.settings ?? { selectionToolEnabled: true, selectionToolAgentId: null };
});

/** 智能体市场弹框是否打开。 */
export const agentMarketModalOpenAtom = atom<boolean>(false);

/** 打开智能体市场弹框；editingAgentId 非空时直接进入该智能体的编辑页（市场内入口用）。 */
export const agentMarketEditingAgentIdAtom = atom<string | null>(null);

export const openAgentMarketModalAtom = atom(null, (_get, set, editingAgentId?: string | null) => {
	set(agentMarketEditingAgentIdAtom, editingAgentId ?? null);
	set(agentMarketModalOpenAtom, true);
});

/**
 * 划词工具 / 市场「使用」共用的调用面板状态。
 * open=false 时不渲染面板；source 只用于标题文案与关闭后的清理策略（selection = 保留选中文本到关闭）。
 */
export type AgentInvokePanelState = {
	open: boolean;
	agentId: string | null;
	text: string;
	action: AgentInvokeAction;
	targetLanguage: AgentTranslateTarget;
	source: "selection" | "market";
};

const EMPTY_INVOKE_PANEL: AgentInvokePanelState = { open: false, agentId: null, text: "", action: "translate", targetLanguage: "auto", source: "market" };

export const agentInvokePanelAtom = atom<AgentInvokePanelState>(EMPTY_INVOKE_PANEL);

/** 打开调用面板：市场卡片传 agentId + source=market；划词浮钮传选中文本 + source=selection。 */
export const openAgentInvokePanelAtom = atom(null, (_get, set, patch: Partial<AgentInvokePanelState>) => {
	set(agentInvokePanelAtom, { ...EMPTY_INVOKE_PANEL, ...patch, open: true });
});

export const closeAgentInvokePanelAtom = atom(null, (_get, set) => {
	set(agentInvokePanelAtom, EMPTY_INVOKE_PANEL);
});
