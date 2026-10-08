import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteHostListItem, RemoteProjectEnrollRequest } from "../../../shared/types/remoteHost";
import { desktopApi } from "../desktopApi";

/**
 * IPC 抛错（而不是返回稳定码）时的占位码。界面按「请重试」呈现，
 * 不能把一次 rejected invoke 说成「目录不存在」这类业务结论。
 */
export const REMOTE_ENROLL_REQUEST_FAILED = "REMOTE_ENROLL_REQUEST_FAILED";
/** 主机存储 needs-repair：读取可能不可靠，先修再登记，不假装主机可用。 */
export const REMOTE_HOST_STORE_NEEDS_REPAIR = "REMOTE_HOST_STORE_NEEDS_REPAIR";
/** 确认等待期间目录被取消/过期：主进程不给 canonical 值，必须让用户重新解析。 */
export const REMOTE_ENROLL_CONFIRM_EXPIRED = "REMOTE_PROJECT_ENROLL_CONFIRMATION_EXPIRED";

/**
 * 登记弹框的状态机。
 *
 * loading          正在读主机清单
 * unavailable      功能未启用 / 存储需修复 / 清单读取失败（带 errorCode）
 * no-host          没有「已验证且未禁用」的主机 → 引导去设备设置
 * path             选主机 + 输入绝对路径（第一版仍是路径输入，没有登记前目录树）
 * awaiting-confirm 已提交，等 main 推送确认（invoke 先返回时不会停在假的 busy 上）
 * confirm          展示 canonical 路径等用户确认
 * enrolled         已写库并回显 projectId，宿主负责刷新清单 + 选中
 */
export type RemoteEnrollStage = "loading" | "unavailable" | "no-host" | "path" | "awaiting-confirm" | "confirm" | "enrolled";

export type RemoteProjectEnrollState = {
	stage: RemoteEnrollStage;
	/** 只列已验证且未禁用的主机：未验证没有信任锚，连接必然失败。 */
	hosts: RemoteHostListItem[];
	hostId: string | undefined;
	path: string;
	busy: boolean;
	errorCode: string | null;
	request: RemoteProjectEnrollRequest | null;
	projectId: string | null;
};

function initialState(): RemoteProjectEnrollState {
	return { stage: "loading", hosts: [], hostId: undefined, path: "", busy: false, errorCode: null, request: null, projectId: null };
}

export type RemoteProjectEnrollOptions = {
	/** 弹框是否打开；每次从关到开都重新拉主机清单。 */
	open: boolean;
	/** 关闭弹框（宿主写 Jotai 开关）。 */
	onClose: () => void;
	/** 无可用主机时用户选择去设备设置。 */
	onOpenDeviceSettings: () => void;
	/** 登记成功：宿主刷新项目列表并选中 projectId（本域不创建任何本地会话）。 */
	onEnrolled: (projectId: string) => void;
};

/**
 * 远端项目登记域：主机清单、路径输入、canonical 确认、回答与成功回执。
 *
 * 视图只转发事件；状态与命令都在这里，保证 App.tsx 不出现该域的业务分支。
 * 确认推送按「在途提交 + requestId」双重关联：main 先 send 确认再返回 pending，
 * 所以收到推送时只能先按 hostId 认领当前提交，回答时再用 requestId 复核。
 */
export function useRemoteProjectEnroll(options: RemoteProjectEnrollOptions) {
	const [state, setState] = useState<RemoteProjectEnrollState>(initialState);
	// 命令身份保持稳定、异步回调不读过期闭包：状态与选项都放 ref。
	const stateRef = useRef(state);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const openRef = useRef(options.open);
	openRef.current = options.open;
	/** 在途提交（等确认推送）：main 推送里只有 hostId/路径，没有「这次提交」的标识。 */
	const pendingSubmitRef = useRef<{ hostId: string } | null>(null);
	/** 当前已接受的确认 requestId：回答只认它，避免回答别的窗口或过期请求。 */
	const activeRequestIdRef = useRef<string | null>(null);
	/** 请求代次：关闭弹框/重新打开让在途结果过期，迟到的推送不再改变状态。 */
	const generationRef = useRef(0);

	/** 同步写 stateRef 再 setState：命令内可立刻读到最新值，避免手动渲染循环里的陈旧闭包。 */
	const commit = useCallback((next: RemoteProjectEnrollState) => {
		stateRef.current = next;
		setState(next);
	}, []);

	const patch = useCallback(
		(updater: (previous: RemoteProjectEnrollState) => RemoteProjectEnrollState) => {
			commit(updater(stateRef.current));
		},
		[commit],
	);

	const resetPending = useCallback(() => {
		pendingSubmitRef.current = null;
		activeRequestIdRef.current = null;
	}, []);

	const loadHosts = useCallback(async () => {
		const generation = ++generationRef.current;
		resetPending();
		commit(initialState());
		let result: Awaited<ReturnType<typeof desktopApi.remoteHosts.list>>;
		try {
			result = await desktopApi.remoteHosts.list();
		} catch {
			if (generation === generationRef.current) commit({ ...initialState(), stage: "unavailable", errorCode: REMOTE_ENROLL_REQUEST_FAILED });
			return;
		}
		if (generation !== generationRef.current) return;
		if (!result.ok) {
			// REMOTE_FEATURE_DISABLED 是正式包的正常状态（开发态门禁），不是异常。
			commit({ ...initialState(), stage: "unavailable", errorCode: result.code });
			return;
		}
		if (result.status === "needs-repair") {
			commit({ ...initialState(), stage: "unavailable", errorCode: REMOTE_HOST_STORE_NEEDS_REPAIR });
			return;
		}
		const hosts = result.hosts.filter((host) => host.verified && !host.disabled);
		commit({ ...initialState(), stage: hosts.length > 0 ? "path" : "no-host", hosts, hostId: hosts[0]?.id });
	}, [commit, resetPending]);

	useEffect(() => {
		if (!optionsRef.current.open) {
			// 关闭即作废：在途提交与待回答的确认都不能在下次打开时复现。
			generationRef.current += 1;
			resetPending();
			commit(initialState());
			return;
		}
		void loadHosts();
	}, [options.open, loadHosts, resetPending, commit]);

	/**
	 * 登记确认推送：全应用唯一挂载点订阅，返回的 unsubscribe 在卸载时执行。
	 * 不接受「没有在途提交」的推送：那是别的窗口或上一次已过期请求。
	 */
	useEffect(() => {
		const unsubscribe = desktopApi.remoteHosts.onProjectEnrollConfirm((request) => {
			if (!openRef.current) return;
			const pending = pendingSubmitRef.current;
			if (pending === null || pending.hostId !== request.hostId) return;
			if (activeRequestIdRef.current !== null && activeRequestIdRef.current !== request.requestId) return;
			if (request.expiresAt <= Date.now()) {
				pendingSubmitRef.current = null;
				patch((previous) => ({ ...previous, stage: "path", busy: false, errorCode: REMOTE_ENROLL_CONFIRM_EXPIRED, request: null }));
				return;
			}
			// 认领这次确认：回答阶段只认这个 requestId。
			activeRequestIdRef.current = request.requestId;
			pendingSubmitRef.current = null;
			patch((previous) => ({ ...previous, stage: "confirm", busy: false, errorCode: null, request }));
		});
		return unsubscribe;
	}, [patch]);

	const selectHost = useCallback(
		(hostId: string) => {
			patch((previous) => ({ ...previous, hostId, errorCode: null }));
		},
		[patch],
	);

	const setPath = useCallback(
		(path: string) => {
			patch((previous) => ({ ...previous, path, errorCode: null }));
		},
		[patch],
	);

	/** 提交路径：main 会 canonical 化并推送确认，本函数只把状态推进到等待/确认。 */
	const submit = useCallback(async () => {
		const current = stateRef.current;
		const hostId = current.hostId;
		const path = current.path.trim();
		if (hostId === undefined || path === "" || current.busy) return;
		const generation = generationRef.current;
		pendingSubmitRef.current = { hostId };
		activeRequestIdRef.current = null;
		patch((previous) => ({ ...previous, busy: true, errorCode: null, request: null }));
		let result: Awaited<ReturnType<typeof desktopApi.remoteHosts.enrollProject>>;
		try {
			result = await desktopApi.remoteHosts.enrollProject(hostId, path);
		} catch {
			if (generation !== generationRef.current) return;
			pendingSubmitRef.current = null;
			patch((previous) => ({ ...previous, busy: false, errorCode: REMOTE_ENROLL_REQUEST_FAILED }));
			return;
		}
		if (generation !== generationRef.current) return;
		if (!result.ok) {
			pendingSubmitRef.current = null;
			patch((previous) => ({ ...previous, busy: false, errorCode: result.code }));
			return;
		}
		// 确认推送通常先于 invoke 返回：推送已经认领/过期时（pendingSubmit 被清空）不要再动阶段，
		// 否则会把「确认中」推回等待态、或把「确认已过期」重新说成还在等待。
		patch((previous) => (pendingSubmitRef.current === null ? { ...previous, busy: false } : { ...previous, busy: false, stage: "awaiting-confirm" }));
	}, [patch]);

	/** 回答确认：只回答当前 requestId，并把「批准/拒绝/失败」推进到各自状态。 */
	const answer = useCallback(
		async (choice: "approve" | "deny") => {
			const request = stateRef.current.request;
			if (request === null || request.requestId !== activeRequestIdRef.current) return;
			const generation = generationRef.current;
			patch((previous) => ({ ...previous, busy: true, errorCode: null }));
			let result: Awaited<ReturnType<typeof desktopApi.remoteHosts.answerProjectEnroll>>;
			try {
				result = await desktopApi.remoteHosts.answerProjectEnroll(request.requestId, choice);
			} catch {
				if (generation !== generationRef.current) return;
				// 回答失败保留确认态与 requestId：用户可以原样重试，不必重新解析路径。
				patch((previous) => ({ ...previous, busy: false, errorCode: REMOTE_ENROLL_REQUEST_FAILED }));
				return;
			}
			if (generation !== generationRef.current) return;
			if (!result.ok) {
				patch((previous) => ({ ...previous, busy: false, errorCode: result.code }));
				return;
			}
			activeRequestIdRef.current = null;
			if (!result.enrolled || result.projectId === undefined) {
				// 拒绝是正常结果：回到路径态，不提示错误。
				patch((previous) => ({ ...previous, stage: "path", busy: false, request: null }));
				return;
			}
			const projectId = result.projectId;
			patch((previous) => ({ ...previous, stage: "enrolled", busy: false, request: null, projectId }));
			try {
				optionsRef.current.onEnrolled(projectId);
			} catch {
				// 宿主的刷新/选中失败不影响「已登记」这个事实，也不能让它变成未处理拒绝。
			}
		},
		[patch],
	);

	const close = useCallback(() => {
		optionsRef.current.onClose();
	}, []);

	const goToDeviceSettings = useCallback(() => {
		optionsRef.current.onOpenDeviceSettings();
	}, []);

	return { state, selectHost, setPath, submit, answer, close, goToDeviceSettings };
}
