/**
 * 「永久删除远端归档会话」的两步确认与执行编排（Phase 5）。
 *
 * 为什么需要这一层而不是在 IPC handler 里直接删：这是全应用第一处**不可恢复**的远端数据删除，
 * 按 docs/remote-development-plan.md §11 的高风险确认纪律，main 必须自己持有一次性确认状态，
 * 不能相信 renderer 自报 confirmed。于是：
 * 1. renderer 只发本机 catalog 会话 id（远端路径永不过 IPC）；
 * 2. main 从**持久化归档索引**解析出唯一目标，校验运行态后签发 PendingConfirmationBroker 请求
 *    （sender 绑定、60s 过期、stateDigest=索引快照、消费一次即失效）；
 * 3. renderer 用 requestId + approve 回答；main 重新读取索引并比对摘要（索引变了 ⇒ 确认失效），
 *    执行有界远端删除；成功后才清理索引/墓碑；回执不可信 ⇒ RESULT_UNCONFIRMED 且索引保留。
 *
 * 幂等/单飞：同一会话同时只允许一个删除在飞（in-flight 集合）；成功后索引被摘除，重放同一
 * requestId 或再次请求都只能得到 CONFIRMATION_REQUIRED / ENTRY_NOT_FOUND——不存在第二次删除。
 */

import { createHash } from "node:crypto";
import { REMOTE_SESSION_DELETE_CODE_SET, REMOTE_SESSION_DELETE_CODES } from "../../shared/sessionDeleteCodes";
import type { RemoteArchivedSessionDeleteAnswerResult, RemoteArchivedSessionDeleteRequestResult } from "../../shared/types";
import type { ArchivedRemoteSessionEntry, DismissedRemoteSessionEntry, SessionCatalog } from "./SessionCatalog";
import { PendingConfirmationBroker } from "../security/PendingConfirmationBroker";

const ACTION = "session:delete-archived-remote";

type DeletePayload = {
	sessionId: string;
	hostId: string;
	archivedPath: string;
	remoteSessionId?: string;
};

/** 删除目标的最小 catalog 端口（单测用真实 SessionCatalog、生产也同一实现，不复制持久化逻辑）。 */
export type RemoteArchivedSessionDeleteCatalogPort = Pick<SessionCatalog, "get" | "getArchivedRemoteSession" | "forgetArchivedRemoteSession" | "forgetDismissedRemoteSession">;

export type RemoteArchivedSessionDeletePorts = {
	catalog: RemoteArchivedSessionDeleteCatalogPort;
	/** 运行实例判定（与归档同一口径：getTarget || isActivating）。 */
	isRuntimeBound: (sessionId: string) => boolean;
	/** 远端删除端口；未装配时请求返回 REMOTE_SESSION_DELETE_UNAVAILABLE（fail closed）。 */
	deleteRemote?: (input: { hostId: string; archivedPath: string }) => Promise<void>;
	now?: () => number;
	ttlMs?: number;
};

export type RemoteArchivedSessionDelete = {
	request(input: { senderId: number; sessionId: string }): Promise<RemoteArchivedSessionDeleteRequestResult>;
	answer(input: { senderId: number; requestId: string; choice: "approve" | "deny" }): Promise<RemoteArchivedSessionDeleteAnswerResult>;
	cancelSender(senderId: number): void;
	dispose(): void;
};

function stableCode(value: string): string {
	return REMOTE_SESSION_DELETE_CODE_SET.has(value) ? value : REMOTE_SESSION_DELETE_CODES.commandFailed;
}

function digestOf(entry: ArchivedRemoteSessionEntry): string {
	// 摘要只覆盖决定「删哪个文件」的字段：主机 + 归档后路径 + 归档前路径。标题/updatedAt 变化不影响目标。
	return createHash("sha256")
		.update(JSON.stringify(["pideck-remote-session-delete-v1", entry.hostId, entry.archivedRemotePath, entry.originalRemotePath]), "utf8")
		.digest("hex");
}

export function createRemoteArchivedSessionDelete(ports: RemoteArchivedSessionDeletePorts): RemoteArchivedSessionDelete {
	const offers = new Map<string, { senderId: number; sessionId: string }>();
	const broker = new PendingConfirmationBroker<DeletePayload>({
		ttlMs: ports.ttlMs ?? 60_000,
		now: ports.now,
		onRemoved: (requestId) => offers.delete(requestId),
	});
	const inFlight = new Set<string>();

	return {
		async request(input) {
			if (!Number.isSafeInteger(input?.senderId) || input.senderId < 1) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
			if (ports.deleteRemote === undefined) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.unavailable };
			const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
			const entry = sessionId.length > 0 ? ports.catalog.getArchivedRemoteSession(sessionId) : undefined;
			if (entry === undefined) {
				// 仍在活记录里 ⇒ 这是「活会话」，不是删归档；两者必须是不同的拒绝理由。
				return { ok: false, code: ports.catalog.get(sessionId) === undefined ? REMOTE_SESSION_DELETE_CODES.entryNotFound : REMOTE_SESSION_DELETE_CODES.notArchived };
			}
			if (ports.isRuntimeBound(sessionId) || inFlight.has(sessionId)) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.busy };
			const payload: DeletePayload = {
				sessionId,
				hostId: entry.hostId,
				archivedPath: entry.archivedRemotePath,
				...(entry.remoteSessionId !== undefined ? { remoteSessionId: entry.remoteSessionId } : {}),
			};
			const { requestId, expiresAt } = broker.begin({ senderId: input.senderId, action: ACTION, subjectId: sessionId, stateDigest: digestOf(entry), payload });
			offers.set(requestId, { senderId: input.senderId, sessionId });
			return { ok: true, status: "pending", requestId, expiresAt };
		},

		async answer(input) {
			if (!Number.isSafeInteger(input?.senderId) || input.senderId < 1) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
			if (typeof input.requestId !== "string" || input.requestId.length === 0 || input.requestId.length > 128) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
			if (input.choice !== "approve" && input.choice !== "deny") return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
			if (ports.deleteRemote === undefined) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.unavailable };
			const offer = offers.get(input.requestId);
			// 过期/已消费/别的窗口：一律「重新确认」，不区分（不给重放者试探空间）。
			if (offer === undefined || offer.senderId !== input.senderId) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
			const entry = ports.catalog.getArchivedRemoteSession(offer.sessionId);
			if (entry === undefined) {
				broker.cancel(input.requestId);
				return { ok: false, code: REMOTE_SESSION_DELETE_CODES.entryNotFound };
			}
			let payload: DeletePayload | null;
			try {
				// 重新读索引后再交给 broker 比对 stateDigest：确认期间索引被改过 ⇒ CONFIRMATION_CHANGED。
				payload = broker.answer({ requestId: input.requestId, senderId: input.senderId, action: ACTION, subjectId: offer.sessionId, stateDigest: digestOf(entry), choice: input.choice });
			} catch {
				return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
			}
			if (payload === null) return { ok: true, deleted: false };
			// 确认窗口内 runtime 起来了：不再继续（先停 Agent）；索引保留，用户可重新走一遍。
			if (ports.isRuntimeBound(payload.sessionId)) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.busy };
			if (inFlight.has(payload.sessionId)) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.busy };
			inFlight.add(payload.sessionId);
			try {
				try {
					await ports.deleteRemote({ hostId: payload.hostId, archivedPath: payload.archivedPath });
				} catch (error) {
					// 跨 realm/包装层的错误只认 message 里的稳定码；其余折叠成 COMMAND_FAILED（确定失败）。
					const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
					return { ok: false, code: stableCode(typeof message === "string" ? message : "") };
				}
				// 只有远端删除**确定成功**之后才动本机；顺序固定：先摘归档索引，再清同身份墓碑。
				// 清理期间仍持有 in-flight 锁：并发的第二个确认只能得到 BUSY，不会对同一会话重复执行。
				await ports.catalog.forgetArchivedRemoteSession(payload.sessionId);
				if (payload.remoteSessionId !== undefined) await ports.catalog.forgetDismissedRemoteSession({ hostId: payload.hostId, remoteSessionId: payload.remoteSessionId } satisfies DismissedRemoteSessionEntry);
				return { ok: true, deleted: true };
			} finally {
				inFlight.delete(payload.sessionId);
			}
		},

		cancelSender(senderId) {
			broker.cancelSender(senderId);
		},

		dispose() {
			broker.dispose();
			offers.clear();
		},
	};
}
