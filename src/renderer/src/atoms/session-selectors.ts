import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { SessionRecord, SessionSummary } from "../../../shared/types";
import { sessionDisplayName } from "../utils/sessionDisplayName";
import { sessionHistoryMutationOverlayByIdAtom, sessionIdsByProjectAtom, sessionRecordsAtom, sessionRuntimeByIdAtom, sessionRuntimeUiByIdAtom } from "./session-atoms";

export function sessionRecordToSummary(session: SessionRecord): SessionSummary | undefined {
	// DSH 会话没有 pi 会话文件（会话由 DSH host 持久化在 $DSH_HOME，catalog 只存映射记录），
	// 生图会话无 pi 文件（历史独立存 ImageSessionStore）；两者无 filePath 也必须进侧栏列表。
	// 空 filePath 在显示管线走 unkeyedSessions 分支
	// （getSummaryKey 对空串归一化为 undefined），不会与其他会话折叠成一行；
	// 右键菜单按 hasFilePath 隐藏「复制路径/打开文件」类文件操作。
	// SSH 会话同样没有本机文件；用稳定 session id 展示，不可把 remotePath 塞进 filePath 来绕过过滤。
	if (!session.filePath && session.locator?.kind !== "ssh" && session.backend !== "dsh" && session.backend !== "imagegen") return undefined;
	return {
		id: session.id,
		filePath: session.filePath ?? "",
		// 会话归属项目 id：会话管理弹窗 worktree 家族聚合后按它打工作区标签。
		projectId: session.projectId,
		projectPath: session.projectPath,
		name: sessionDisplayName(session.title, session.forked),
		parentSessionPath: session.parentSessionPath,
		forked: session.forked,
		preview: session.preview,
		updatedAt: session.updatedAt,
		messageCount: session.messageCount,
		source: session.source,
		backend: session.backend,
		dshSessionId: session.dshSessionId,
		wsl: session.environment === "wsl" || session.wsl || undefined,
		codexSessionId: session.codexSessionId,
		codexThreadSource: session.codexThreadSource,
		codexParentThreadId: session.codexParentThreadId,
		codexAgentRole: session.codexAgentRole,
		codexAgentNickname: session.codexAgentNickname,
	};
}

export const sessionRecordByIdAtomFamily = atomFamily((sessionId: string) => atom((get) => get(sessionRecordsAtom)[sessionId]));

export const sessionRecordsByProjectIdAtomFamily = atomFamily((projectId: string) =>
	atom((get) => {
		const records = get(sessionRecordsAtom);
		return (get(sessionIdsByProjectAtom)[projectId] ?? []).map((sessionId) => records[sessionId]).filter((session): session is SessionRecord => Boolean(session));
	}),
);

export const sessionSummariesByProjectIdAtomFamily = atomFamily((projectId: string) =>
	atom((get) =>
		get(sessionRecordsByProjectIdAtomFamily(projectId))
			.map(sessionRecordToSummary)
			.filter((session): session is SessionSummary => Boolean(session))
			.sort((left, right) => right.updatedAt - left.updatedAt),
	),
);

export const sessionRuntimeBySessionIdAtomFamily = atomFamily((sessionId: string) => atom((get) => get(sessionRuntimeByIdAtom)[sessionId]));

// A moved runtime can leave an older Session projection behind; the newest binding wins.
export const sessionIdByRuntimeAgentIdAtomFamily = atomFamily((agentId: string) =>
	atom(
		(get) =>
			Object.entries(get(sessionRuntimeByIdAtom)).reduce<{
				sessionId?: string;
				updatedAt: number;
			}>((selected, [sessionId, runtime]) => (runtime.agentId === agentId && runtime.updatedAt >= selected.updatedAt ? { sessionId, updatedAt: runtime.updatedAt } : selected), { updatedAt: -1 }).sessionId,
	),
);

export const sessionRuntimeUiBySessionIdAtomFamily = atomFamily((sessionId: string) => atom((get) => get(sessionRuntimeUiByIdAtom)[sessionId]));

/**
 * 这条会话是否跑在「远端项目资源未加载」的状态（Phase 4 P4.2 收口第 1 项）。
 *
 * 标记来自主进程：远端会话（`runtimePlan.kind === "remote-ssh"` 那条路）的 tab 带
 * `remoteTrustUnhandled: true`，经 agents:state 事件透传到 SessionRuntimeViewState。
 * 本机/WSL/DSH/生图会话、以及旧 main 或旧 payload 缺字段的情况一律为 false——
 * 消费端据此不渲染提示、也不报错（契约上该字段可选）。
 */
export const sessionRemoteTrustUnhandledAtomFamily = atomFamily((sessionId: string) => atom((get) => get(sessionRuntimeByIdAtom)[sessionId]?.remoteTrustUnhandled === true));

export const sessionHistoryMutationOverlayBySessionIdAtomFamily = atomFamily((sessionId: string) => atom((get) => get(sessionHistoryMutationOverlayByIdAtom)[sessionId]));
