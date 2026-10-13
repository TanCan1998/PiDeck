import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import { isRemoteProject } from "../../../shared/projectLocation";
import type { RemoteProjectTrustEntry } from "../../../shared/types/remoteTrust";
import { projectByIdAtomFamily } from "./project-atoms";
import { sessionRecordsAtom, sessionRuntimeByIdAtom } from "./session-atoms";
import { sessionRemoteTrustUnhandledAtomFamily } from "./session-selectors";

/**
 * 远端项目 trust 的渲染层状态（P4.4b）。
 *
 * 权威性（父批明确要求）：界面显示的状态**来自 PiDeck 自己的决策存储**（主进程的
 * `remoteProjectTrust` 段），不来自任何 pi 事件——目标版本（pi 0.85.1）根本没有 `project_trust`
 * 事件，而 PiDeck 本机 pi 版本又不同，靠事件判断「远端 pi 实际信任了什么」既不可得也不可信。
 * 这里回答的是一个可验证的问题：**下一次 spawn 我们会传什么 flag**。
 *
 * 清单是全局共享状态（设置页清单与会话提示条读同一份）：一次拉取、一处写入，两处同时更新。
 */
export type RemoteProjectTrustListState = {
	/** idle=还没拉过（提示条按「未决策」渲染，与本批之前的行为一致）；ready=已拿到清单。 */
	status: "idle" | "loading" | "ready" | "error";
	entries: RemoteProjectTrustEntry[];
	/** status="error" 时的稳定码。 */
	code?: string;
};

export const remoteProjectTrustStateAtom = atom<RemoteProjectTrustListState>({ status: "idle", entries: [] });

/** 一条远端会话对应的 trust 判定对象：`(hostId, 规范项目根)`。 */
export type RemoteProjectTrustTarget = { readonly hostId: string; readonly remoteRoot: string };

/**
 * 会话 → `(hostId, 规范项目根)`。
 *
 * 取**项目**的 ssh locator（`Project.locator.remotePath` 就是登记时确认过的 canonical 项目根）。
 * **不能**用会话自己 locator 的 `remotePath`：远端会话 locator 里那个字段是 **pi 上报的会话文件路径**，
 * 不是项目根（见 `registerRemoteSession` 的入参），拿它当 trust 判定对象会永远命中不到决策。
 * projectId 先取活动 runtime（会话被移动到别的工作区时以它为准），再回落到 catalog 记录。
 */
export const sessionRemoteTrustTargetAtomFamily = atomFamily((sessionId: string) =>
	atom<RemoteProjectTrustTarget | undefined>((get) => {
		const projectId = get(sessionRuntimeByIdAtom)[sessionId]?.projectId ?? get(sessionRecordsAtom)[sessionId]?.projectId;
		if (!projectId) return undefined;
		// 项目的 ssh 判据用 shared 的唯一出处（`isRemoteProject`），不在渲染层另写一套类型收窄。
		const project = get(projectByIdAtomFamily(projectId));
		if (project === undefined || !isRemoteProject(project)) return undefined;
		const remoteRoot = project.locator.remotePath;
		if (typeof remoteRoot !== "string" || remoteRoot.length === 0) return undefined;
		return { hostId: project.locator.hostId, remoteRoot };
	}),
);

/**
 * 会话提示条的四态（P4.2 的静态标记 + P4.4b 的决策状态合成）。
 *
 * - 静态标记 `remoteTrustUnhandled` 仍然是**是否渲染**的判据（远端会话才有这条提示；本机/WSL/DSH/
 *   生图会话、旧 main 的旧载荷一律不渲染）——父批明确要求保留它，不能改成「只有事件才显示」。
 * - 展示状态来自决策表：未决策 / 已信任 / 已拒绝 / 已作废（endpoint 变更）。
 * - 拿不到 `(hostId, 项目根)`（会话还没登记成远端项目、项目不在清单里）时为 `undecided` 且不带 target：
 *   提示照常如实告知，但决策按钮不可用（没有判定对象就不能写决策）。
 */
export type SessionRemoteTrustState =
	| { readonly kind: "undecided"; readonly target?: RemoteProjectTrustTarget }
	| { readonly kind: "approved"; readonly entry: RemoteProjectTrustEntry }
	| { readonly kind: "denied"; readonly entry: RemoteProjectTrustEntry }
	| { readonly kind: "stale"; readonly entry: RemoteProjectTrustEntry };

export const sessionRemoteTrustStateAtomFamily = atomFamily((sessionId: string) =>
	atom<SessionRemoteTrustState | undefined>((get) => {
		if (!get(sessionRemoteTrustUnhandledAtomFamily(sessionId))) return undefined;
		const target = get(sessionRemoteTrustTargetAtomFamily(sessionId));
		const entry = target === undefined ? undefined : get(remoteProjectTrustStateAtom).entries.find((candidate) => candidate.hostId === target.hostId && candidate.canonicalRoot === target.remoteRoot);
		if (entry === undefined) return { kind: "undecided", ...(target === undefined ? {} : { target }) };
		if (entry.status === "stale") return { kind: "stale", entry };
		return entry.decision === "approve" ? { kind: "approved", entry } : { kind: "denied", entry };
	}),
);

/** 设置页清单：按主机 label + 项目根排序（同一主机连续、同主机内按路径），列表稳定不跳动。 */
export const remoteProjectTrustEntriesSortedAtom = atom<RemoteProjectTrustEntry[]>((get) => {
	const entries = [...get(remoteProjectTrustStateAtom).entries];
	entries.sort((left, right) => (left.hostLabel === right.hostLabel ? left.canonicalRoot.localeCompare(right.canonicalRoot) : left.hostLabel.localeCompare(right.hostLabel)));
	return entries;
});
