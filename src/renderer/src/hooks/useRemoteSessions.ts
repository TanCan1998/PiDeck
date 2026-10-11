import { useAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { idleScanStateFor, remoteSessionImportByHostAtom, remoteSessionScanByHostAtom, type RemoteSessionImportFeedback } from "../atoms/remote-sessions-atoms";
import { createRemoteSessionListController, readRegisterResponse, readScanResponse, type RemoteSessionEntryView, type RemoteSessionListState, type RemoteSessionScanOutcome } from "../components/session/remoteSessionListState";

/**
 * 远端会话列表与登记（渲染层 H2）。
 *
 * 状态机在 `remoteSessionListState`（纯函数，可离开 React 单测）；这里只做三件事：
 * 把主进程能力收窄成窄 port、按代次落地结果、在切主机/卸载时作废在途结果。
 *
 * port 的取值是**结构探测**而不是类型断言（与第二批搜索面板同一做法）：preload 未暴露
 * `remoteSessions` 时宁可报「未接线」稳定码，也不假装成功、也不崩溃；接线落地后同一调用点自然生效。
 *
 * 扫描结果按主机缓存在 Jotai atom 里：侧栏项目行会随折叠反复挂载卸载，重挂载不该丢掉已扫到的列表，
 * 也不该自动重扫（用户点刷新才重扫）。
 */

/** 未接线的稳定码：只在 preload 尚未暴露 remoteSessions 时出现。 */
export const REMOTE_SESSION_UNWIRED_CODE = "REMOTE_SESSION_UNWIRED";

export type RemoteSessionPort = {
	scan: (hostId: string) => Promise<unknown>;
	register: (hostId: string, remoteSessionId: string) => Promise<unknown>;
};

function unwiredResult(): { ok: false; code: string } {
	return { ok: false, code: REMOTE_SESSION_UNWIRED_CODE };
}

const UNWIRED_PORT: RemoteSessionPort = { scan: async () => unwiredResult(), register: async () => unwiredResult() };

/**
 * 逐层结构收窄 `desktopApi.remoteSessions.scan/register`。
 * 用 `Reflect.get` 是为了在 api 是「未装载 preload」的抛错 Proxy 时不带断言地安全失败；任何一层不是
 * 预期函数就是「未接线」。
 */
export function createRemoteSessionPort(hostApi: unknown): RemoteSessionPort {
	try {
		if (typeof hostApi !== "object" || hostApi === null) return UNWIRED_PORT;
		const sessions: unknown = Reflect.get(hostApi, "remoteSessions");
		if (typeof sessions !== "object" || sessions === null) return UNWIRED_PORT;
		const scan: unknown = Reflect.get(sessions, "scan");
		const register: unknown = Reflect.get(sessions, "register");
		if (typeof scan !== "function" || typeof register !== "function") return UNWIRED_PORT;
		return {
			scan: (hostId) => Promise.resolve(scan.call(sessions, hostId)),
			register: (hostId, remoteSessionId) => Promise.resolve(register.call(sessions, hostId, remoteSessionId)),
		};
	} catch {
		return UNWIRED_PORT;
	}
}

export type RemoteSessionImportResult = { sessionId: string; created: boolean; remoteSessionId: string };

export type RemoteSessionsHandle = {
	state: RemoteSessionListState;
	/** 最近一次登记反馈（按主机记）：created=false 也必须能被用户看见。 */
	feedback: RemoteSessionImportFeedback | null;
	/** 正在登记的远端会话身份；null 表示没有登记在途。 */
	importingRemoteSessionId: string | null;
	/** 重新扫描当前主机（作废旧代次结果）。 */
	scan: () => Promise<void>;
	/** 登记一条远端会话；成功后通知宿主刷新并选中。 */
	importSession: (entry: RemoteSessionEntryView) => Promise<void>;
};

export function useRemoteSessions(
	hostApi: unknown,
	options: {
		hostId: string;
		/** 登记成功后的宿主动作：刷新本地会话列表并选中新会话（本 hook 不创建/不打开任何会话）。 */
		onImported: (result: RemoteSessionImportResult) => void | Promise<void>;
	},
): RemoteSessionsHandle {
	const [snapshots, setSnapshots] = useAtom(remoteSessionScanByHostAtom);
	const [feedbackByHost, setFeedbackByHost] = useAtom(remoteSessionImportByHostAtom);
	const [controller] = useState(() => createRemoteSessionListController());
	const [importingRemoteSessionId, setImportingRemoteSessionId] = useState<string | null>(null);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const snapshotsRef = useRef(snapshots);
	snapshotsRef.current = snapshots;
	const portRef = useRef<RemoteSessionPort>(createRemoteSessionPort(hostApi));
	portRef.current = createRemoteSessionPort(hostApi);
	const hostIdRef = useRef<string | null>(null);

	// 切主机：作废在途扫描，并恢复该主机自己的缓存快照（没有就回 idle）。
	useEffect(() => {
		if (hostIdRef.current === options.hostId) return;
		const previousHostId = hostIdRef.current;
		hostIdRef.current = options.hostId;
		controller.restore(snapshotsRef.current[options.hostId]);
		// 离开的主机若停在 scanning（在途请求已随切主机作废），atom 里的快照必须一并归一到 idle：
		// 否则切回来会看到一个永远转圈、却没有任何在途请求的列表。
		if (previousHostId !== null && snapshotsRef.current[previousHostId]?.phase === "scanning") {
			setSnapshots((previous) => ({ ...previous, [previousHostId]: idleScanStateFor(previousHostId) }));
		}
	}, [options.hostId, controller, setSnapshots]);

	// 卸载：只作废在途结果，不再 setState（快照留在 atom 里）。
	useEffect(
		() => () => {
			controller.reset();
		},
		[controller],
	);

	const scan = useCallback(async () => {
		const hostId = optionsRef.current.hostId;
		const generation = controller.start(hostId);
		setSnapshots((previous) => ({ ...previous, [hostId]: controller.getState() }));
		let outcome: RemoteSessionScanOutcome;
		try {
			outcome = readScanResponse(await portRef.current.scan(hostId));
		} catch {
			// IPC reject：连失败形状都没有，只能报「请求失败」，不编造远端码。
			outcome = { kind: "rejected" };
		}
		// 代次已作废（切主机、重扫）时整体丢弃：迟到的结果绝不能覆盖新状态。
		if (!controller.settle(generation, outcome)) return;
		setSnapshots((previous) => ({ ...previous, [hostId]: controller.getState() }));
	}, [controller, setSnapshots]);

	const importSession = useCallback(
		async (entry: RemoteSessionEntryView) => {
			const hostId = optionsRef.current.hostId;
			setImportingRemoteSessionId(entry.remoteSessionId);
			setFeedbackByHost((previous) => ({ ...previous, [hostId]: undefined }));
			try {
				let raw: unknown;
				try {
					raw = await portRef.current.register(hostId, entry.remoteSessionId);
				} catch {
					raw = undefined;
				}
				const outcome = readRegisterResponse(raw, entry.remoteSessionId);
				if (outcome.kind !== "ok") {
					setFeedbackByHost((previous) => ({ ...previous, [hostId]: { remoteSessionId: entry.remoteSessionId, kind: "failed", code: outcome.kind === "failed" ? outcome.code : null } }));
					return;
				}
				// 登记写盘与清单刷新是两个阶段。刷新尚未完成时，不能提前宣称「已选中」。
				try {
					await optionsRef.current.onImported({ sessionId: outcome.sessionId, created: outcome.created, remoteSessionId: outcome.remoteSessionId });
					setFeedbackByHost((previous) => ({ ...previous, [hostId]: { remoteSessionId: entry.remoteSessionId, kind: "imported", sessionId: outcome.sessionId, created: outcome.created } }));
				} catch {
					// 记录已保存，不把刷新失败误报为登记失败，也不透传异常中的本机路径。
					setFeedbackByHost((previous) => ({ ...previous, [hostId]: { remoteSessionId: entry.remoteSessionId, kind: "refresh-failed", sessionId: outcome.sessionId, created: outcome.created } }));
				}
			} finally {
				setImportingRemoteSessionId(null);
			}
		},
		[setFeedbackByHost],
	);

	return { state: snapshots[options.hostId] ?? idleScanStateFor(options.hostId), feedback: feedbackByHost[options.hostId] ?? null, importingRemoteSessionId, scan, importSession };
}
