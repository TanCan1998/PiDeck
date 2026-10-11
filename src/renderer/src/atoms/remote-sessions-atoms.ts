import { atom } from "jotai";
import { idleRemoteSessionListState, type RemoteSessionListState } from "../components/session/remoteSessionListState";
import type { RemoteSessionTitleEntry } from "../components/session/remoteSessionTitleState";
import type { RemoteProjectRootStatusView } from "../components/sidebar/remoteProjectStatusState";

/**
 * 远端（侧栏/项目面板）共享的 Jotai 状态。
 *
 * 为什么进 atom 而不是留在组件里：侧栏项目行会随折叠/切 Tab 反复挂载卸载，而「这台主机扫过什么、
 * 哪些标题已取到、哪些项目需要处理」属于同一个远端域的快照——重挂载不该丢掉，也不该二次扫描。
 * 状态机本身仍由 remoteSessionListState / remoteSessionTitleState 的纯函数持有，这里只存落地快照。
 */

/** 每台主机的远端会话扫描结果（含 idle/empty/entries/error 与稳定码）。 */
export const remoteSessionScanByHostAtom = atom<Record<string, RemoteSessionListState>>({});

/** 每台主机、每条远端会话的标题状态（惰性取到的缓存）。 */
export const remoteSessionTitleByHostAtom = atom<Record<string, Record<string, RemoteSessionTitleEntry>>>({});

/** 每台主机最近一次登记的反馈：created=true/false 都必须能被用户看见，不能只活在一次点击里。 */
export type RemoteSessionImportFeedback = { remoteSessionId: string; kind: "imported"; sessionId: string; created: boolean } | { remoteSessionId: string; kind: "refresh-failed"; sessionId: string; created: boolean } | { remoteSessionId: string; kind: "failed"; code: string | null };

export const remoteSessionImportByHostAtom = atom<Record<string, RemoteSessionImportFeedback | undefined>>({});

/** 每个远端项目的 root 复核状态（needs-attention 时侧栏提示）。 */
export const remoteProjectRootStatusAtom = atom<Record<string, RemoteProjectRootStatusView>>({});

/** 供组件兜底：拿到某台主机但还没扫过时的 idle 状态。 */
export function idleScanStateFor(hostId: string): RemoteSessionListState {
	return idleRemoteSessionListState(hostId);
}
