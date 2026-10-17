import { REMOTE_SESSION_DELETE_CODES } from "../../../shared/sessionDeleteCodes";

/**
 * 「永久删除远端归档会话」的 UI 状态机（纯函数，便于 node --test 直接覆盖）。
 *
 * 关键语义（与 main 的一次性确认协议对齐）：
 * - idle → requesting → confirming（main 已签发 requestId）→ deleting → idle/failed/unconfirmed；
 * - 只有 confirming 能 confirm；requesting/deleting 期间的重复动作一律忽略（防双击/并发）；
 * - **unconfirmed 不会自动回 idle**：回执丢失时远端可能已删，UI 必须把「请刷新核对」留在屏幕上，
 *   直到用户显式 acknowledge；也绝不因为列表刷新把它冲掉（刷新由组件在 deleted 时显式触发）；
 * - failed 也只能 acknowledge 后重试（同一行不会因为重新渲染自动重发命令）。
 */
export type RemoteArchivedDeleteState =
	| { phase: "idle" }
	| { phase: "requesting"; sessionId: string }
	| { phase: "confirming"; sessionId: string; requestId: string; expiresAt: number }
	| { phase: "deleting"; sessionId: string; requestId: string }
	| { phase: "unconfirmed"; sessionId: string; code: string }
	| { phase: "failed"; sessionId: string; code: string };

export type RemoteArchivedDeleteAction =
	| { type: "request"; sessionId: string }
	| { type: "requested"; sessionId: string; requestId: string; expiresAt: number }
	| { type: "requestFailed"; sessionId: string; code: string }
	| { type: "cancel" }
	| { type: "confirm" }
	| { type: "deleted" }
	| { type: "deleteFailed"; code: string }
	| { type: "deleteUnconfirmed"; code: string }
	| { type: "acknowledge" };

export const initialRemoteArchivedDeleteState: RemoteArchivedDeleteState = { phase: "idle" };

/** 状态机转移：非法/迟到的动作原样返回（React 的 reducer 语义：不产生新状态就不重渲染）。 */
export function reduceRemoteArchivedDelete(state: RemoteArchivedDeleteState, action: RemoteArchivedDeleteAction): RemoteArchivedDeleteState {
	switch (action.type) {
		case "request":
			if (state.phase !== "idle") return state;
			return { phase: "requesting", sessionId: action.sessionId };
		case "requested":
			if (state.phase !== "requesting" || state.sessionId !== action.sessionId) return state;
			return { phase: "confirming", sessionId: action.sessionId, requestId: action.requestId, expiresAt: action.expiresAt };
		case "requestFailed":
			if (state.phase !== "requesting" || state.sessionId !== action.sessionId) return state;
			return { phase: "failed", sessionId: action.sessionId, code: action.code };
		case "cancel":
			// deleting 不可取消：命令已经在途，取消只会在 UI 层制造「以为没删」的假象。
			if (state.phase === "requesting" || state.phase === "confirming") return initialRemoteArchivedDeleteState;
			return state;
		case "confirm":
			if (state.phase !== "confirming") return state;
			return { phase: "deleting", sessionId: state.sessionId, requestId: state.requestId };
		case "deleted":
			if (state.phase !== "deleting") return state;
			return initialRemoteArchivedDeleteState;
		case "deleteFailed":
			if (state.phase !== "deleting") return state;
			return { phase: "failed", sessionId: state.sessionId, code: action.code };
		case "deleteUnconfirmed":
			if (state.phase !== "deleting") return state;
			return { phase: "unconfirmed", sessionId: state.sessionId, code: action.code };
		case "acknowledge":
			if (state.phase === "failed" || state.phase === "unconfirmed") return initialRemoteArchivedDeleteState;
			return state;
		default:
			return state;
	}
}

/** 当前有在途请求/删除（按钮禁用与重复点击保护的唯一判据）。 */
export function remoteArchivedDeleteBusy(state: RemoteArchivedDeleteState): boolean {
	return state.phase === "requesting" || state.phase === "deleting";
}

/**
 * 某一行应展示的阶段：只有状态机记住了具体 sessionId 时才算「这一行」；
 * idle 不属于任何行（所有行都显示删除入口）。
 */
export function remoteArchivedDeleteRowPhase(state: RemoteArchivedDeleteState, sessionId: string): RemoteArchivedDeleteState["phase"] | "other" {
	if (state.phase === "idle") return "idle";
	return state.sessionId === sessionId ? state.phase : "other";
}

/** 已知失败码对应的 i18n key（typed union：t() 只接受真实存在的 key）。 */
export type RemoteArchivedDeleteErrorKey = "sessionManager.remoteArchivedDeleteBusyRuntime" | "sessionManager.remoteArchivedDeleteUnavailable" | "sessionManager.remoteArchivedDeleteMissing" | "sessionManager.remoteArchivedDeleteExpired" | "sessionManager.remoteArchivedDeleteUnconfirmed";

/** 闭集码 → i18n key；undefined 表示未知码，调用方用「失败（{code}）」兜底文案。 */
export function remoteArchivedDeleteErrorKey(code: string): RemoteArchivedDeleteErrorKey | undefined {
	switch (code) {
		case REMOTE_SESSION_DELETE_CODES.busy:
			return "sessionManager.remoteArchivedDeleteBusyRuntime";
		case REMOTE_SESSION_DELETE_CODES.unavailable:
			return "sessionManager.remoteArchivedDeleteUnavailable";
		case REMOTE_SESSION_DELETE_CODES.entryNotFound:
		case REMOTE_SESSION_DELETE_CODES.notArchived:
			return "sessionManager.remoteArchivedDeleteMissing";
		case REMOTE_SESSION_DELETE_CODES.confirmationRequired:
			return "sessionManager.remoteArchivedDeleteExpired";
		case REMOTE_SESSION_DELETE_CODES.resultUnconfirmed:
			return "sessionManager.remoteArchivedDeleteUnconfirmed";
		default:
			return undefined;
	}
}
