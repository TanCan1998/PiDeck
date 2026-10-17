import { useReducer } from "react";
import type { RemoteArchivedSessionDeleteAnswerResult, RemoteArchivedSessionDeleteRequestResult } from "../../../shared/types";
import { REMOTE_SESSION_DELETE_CODES } from "../../../shared/sessionDeleteCodes";
import { initialRemoteArchivedDeleteState, reduceRemoteArchivedDelete } from "../utils/remoteArchivedDeleteState";

/**
 * 「永久删除远端归档会话」的 React 宿主：状态机在 utils/remoteArchivedDeleteState（纯函数、可单测），
 * 这里只做 IPC 往返与回调编排。main 的一次性确认分两步：request 拿 requestId → answer(approve) 才删。
 */
export type RemoteArchivedDeletePorts = {
	request: (sessionId: string) => Promise<RemoteArchivedSessionDeleteRequestResult>;
	answer: (requestId: string, choice: "approve" | "deny") => Promise<RemoteArchivedSessionDeleteAnswerResult>;
	/** 删除确定成功：刷新归档列表（组件决定刷新范围）。 */
	onDeleted?: () => void | Promise<void>;
	/** 确定失败（没删）：也可以刷新列表（索引不变），让 UI 与磁盘一致。 */
	onDefiniteFailure?: () => void | Promise<void>;
};

export function useRemoteArchivedSessionDelete(ports: RemoteArchivedDeletePorts) {
	const [state, dispatch] = useReducer(reduceRemoteArchivedDelete, initialRemoteArchivedDeleteState);

	async function request(sessionId: string): Promise<void> {
		if (state.phase !== "idle") return;
		dispatch({ type: "request", sessionId });
		let result: RemoteArchivedSessionDeleteRequestResult;
		try {
			result = await ports.request(sessionId);
		} catch {
			// IPC 层异常（通道缺失/主进程崩）按「确认已失效」失败处理：没发任何远端命令，可重试。
			dispatch({ type: "requestFailed", sessionId, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired });
			return;
		}
		if (!result.ok) {
			dispatch({ type: "requestFailed", sessionId, code: result.code });
			await ports.onDefiniteFailure?.();
			return;
		}
		dispatch({ type: "requested", sessionId, requestId: result.requestId, expiresAt: result.expiresAt });
	}

	async function confirm(): Promise<void> {
		if (state.phase !== "confirming") return;
		const { requestId } = state;
		dispatch({ type: "confirm" });
		let result: RemoteArchivedSessionDeleteAnswerResult;
		try {
			result = await ports.answer(requestId, "approve");
		} catch {
			// 调用本身抛错 = 没拿到可信回执；命令可能已在远端执行 ⇒ 必须按「结果未确认」呈现。
			dispatch({ type: "deleteUnconfirmed", code: REMOTE_SESSION_DELETE_CODES.resultUnconfirmed });
			return;
		}
		if (result.ok) {
			dispatch({ type: "deleted" });
			await ports.onDeleted?.();
			return;
		}
		if (result.code === REMOTE_SESSION_DELETE_CODES.resultUnconfirmed) {
			// 关键：不刷新列表、不重试、不停留出「已删除」的错觉；由用户显式核对。
			dispatch({ type: "deleteUnconfirmed", code: result.code });
			return;
		}
		dispatch({ type: "deleteFailed", code: result.code });
		await ports.onDefiniteFailure?.();
	}

	/** 取消确认：同时把 main 的待确认请求 deny 掉（失败忽略，60s 自然过期）。 */
	function cancel(): void {
		const snapshot = state;
		dispatch({ type: "cancel" });
		if (snapshot.phase === "confirming") void ports.answer(snapshot.requestId, "deny").catch(() => undefined);
	}

	function acknowledge(): void {
		dispatch({ type: "acknowledge" });
	}

	return { state, request, confirm, cancel, acknowledge };
}
