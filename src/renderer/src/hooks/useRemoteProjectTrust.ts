import { useAtom } from "jotai";
import { useCallback, useEffect } from "react";
import type { RemoteProjectTrustDecision } from "../../../shared/types/remoteTrust";
import { remoteProjectTrustStateAtom, type RemoteProjectTrustListState, type RemoteProjectTrustTarget } from "../atoms/remote-trust-atoms";
import { desktopApi } from "../desktopApi";

/**
 * 远端项目 trust 的渲染层命令（P4.4b）。
 *
 * 一个域一个 hook：设置页清单与会话提示条都只通过它读写，状态落在共享 atom 上——提示条点了「信任」，
 * 设置页清单同步变（反之亦然），不需要两处各自缓存一份。
 *
 * 渲染层不推导任何 trust 材料：`(hostId, 项目根)` 由 atom 从项目 locator 取出，endpoint 身份与
 * trust key 只在主进程（`remoteTrust:*` 通道按这两个字符串寻址）。
 */

/** `invoke` 本身失败（IPC 未接线 / 主进程异常）时的占位码：不能把一次 rejected 调用说成业务结论。 */
export const REMOTE_TRUST_REQUEST_FAILED = "REMOTE_PROJECT_TRUST_REQUEST_FAILED";

export type RemoteProjectTrustActionResult = { ok: true } | { ok: false; code: string };

export type RemoteProjectTrustHandle = {
	state: RemoteProjectTrustListState;
	/** 重新拉取清单（挂载时自动拉一次；决策/撤销后自动刷新）。 */
	refresh: () => Promise<void>;
	/** 记录决策：approve=信任该项目根的 `.pi` 资源；deny=明确不信任。下一次 spawn 生效。 */
	decide: (target: RemoteProjectTrustTarget, decision: RemoteProjectTrustDecision) => Promise<RemoteProjectTrustActionResult>;
	/** 撤销该 (hostId, 项目根) 的决策（含已作废的条目）。 */
	revoke: (target: RemoteProjectTrustTarget) => Promise<RemoteProjectTrustActionResult>;
};

export function useRemoteProjectTrust(): RemoteProjectTrustHandle {
	const [state, setState] = useAtom(remoteProjectTrustStateAtom);

	const refresh = useCallback(async () => {
		setState((current) => ({ ...current, status: "loading" }));
		try {
			const result = await desktopApi.remoteTrust.list();
			setState(result.ok ? { status: "ready", entries: result.entries } : { status: "error", entries: [], code: result.code });
		} catch {
			setState({ status: "error", entries: [], code: REMOTE_TRUST_REQUEST_FAILED });
		}
	}, [setState]);

	// 挂载即拉一次：清单是四态展示的唯一来源，没拉到之前提示条按「未决策」如实渲染（不假装已信任）。
	useEffect(() => {
		void refresh();
	}, [refresh]);

	const decide = useCallback(
		async (target: RemoteProjectTrustTarget, decision: RemoteProjectTrustDecision): Promise<RemoteProjectTrustActionResult> => {
			try {
				const result = await desktopApi.remoteTrust.set({ hostId: target.hostId, remoteRoot: target.remoteRoot, decision });
				if (!result.ok) return { ok: false, code: result.code };
			} catch {
				return { ok: false, code: REMOTE_TRUST_REQUEST_FAILED };
			}
			await refresh();
			return { ok: true };
		},
		[refresh],
	);

	const revoke = useCallback(
		async (target: RemoteProjectTrustTarget): Promise<RemoteProjectTrustActionResult> => {
			try {
				const result = await desktopApi.remoteTrust.clear(target.hostId, target.remoteRoot);
				if (!result.ok) return { ok: false, code: result.code };
			} catch {
				return { ok: false, code: REMOTE_TRUST_REQUEST_FAILED };
			}
			await refresh();
			return { ok: true };
		},
		[refresh],
	);

	return { state, refresh, decide, revoke };
}
