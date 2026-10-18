import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { PiInstallation, PiInstallExecResult, PiRuntimeNodeStatus } from "../../../shared/types";
import type { PiDesktopApi } from "../../../preload";

/**
 * pi 环境引导（Node → npm → pi 三步）的域状态与命令。
 *
 * 职责边界：只管理「引导流程」自身的状态机（检测/安装中/结果），不持有
 * EnvironmentDialog 的开关（那是 App 装配层的事）；按项目 hook 约定，
 * 副作用收敛在 hook 内，组件只做呈现与事件转发。
 *
 * 为什么 npm 不需要单独「安装」：便携 Node 发行包自带 npm，所以 npm 这一步
 * 只是「检测确认」，检测通过即可进入 pi 安装步骤。
 */
export function usePiEnvironmentGuide(api: PiDesktopApi) {
	// Node 状态（便携副本 + 系统 node 合并视图）
	const [nodeStatus, setNodeStatus] = useState<PiRuntimeNodeStatus | null>(null);
	const [nodeChecking, setNodeChecking] = useState(false);
	const [nodeInstalling, setNodeInstalling] = useState(false);
	const [nodeInstallResult, setNodeInstallResult] = useState<{ ok: boolean; message: string } | null>(null);

	// npm 检测状态（三步中的第 2 步）
	const [npmVersion, setNpmVersion] = useState<string | null>(null);
	const [npmChecking, setNpmChecking] = useState(false);
	const [npmError, setNpmError] = useState<string | null>(null);

	// pi 安装状态（三步中的第 3 步）
	const [piUseMirror, setPiUseMirror] = useState(true);
	const [piInstalling, setPiInstalling] = useState(false);
	const [piInstallResult, setPiInstallResult] = useState<PiInstallExecResult | null>(null);
	const [piInstallDone, setPiInstallDone] = useState(false);
	/**
	 * 引导安装被主进程拦下时的现场：本机已经装了 pi，因此没有安装新副本。
	 * 非空时面板不再展示安装按钮（用户没有东西可装）。
	 */
	const [piAlreadyInstalled, setPiAlreadyInstalled] = useState<PiInstallation[]>([]);

	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	/** 检测引导环境：便携 node 副本 + 系统 node。打开弹窗与装完刷新共用。 */
	const checkNode = useCallback(async () => {
		setNodeChecking(true);
		try {
			const next = await api.pi.runtimeNodeCheck();
			if (!mountedRef.current) return;
			setNodeStatus(next);
			// 便携副本已就绪时直接带出 node 版本展示；系统 node 存在也算通过该步骤。
			if (next.installed && next.version) {
				setNodeInstallResult({ ok: true, message: t("environment.guideNodePortableFound", { version: next.version }) });
			}
		} catch (error) {
			if (mountedRef.current) {
				setNodeStatus({
					installed: false,
					systemNodeAvailable: false,
					installSupported: true,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (mountedRef.current) setNodeChecking(false);
		}
	}, [api]);

	/** 一键安装便携 Node（主进程内完成镜像回退 + sha256 校验）。 */
	const installNode = useCallback(async () => {
		setNodeInstalling(true);
		setNodeInstallResult(null);
		try {
			const result = await api.pi.runtimeNodeInstall();
			if (!mountedRef.current) return;
			if (result.ok && result.version) {
				setNodeInstallResult({ ok: true, message: t("environment.guideNodeDone") + `（${result.version}）` });
				// 装完立即重检，让后续步骤看到最新的便携 node/npm 状态。
				const next = await api.pi.runtimeNodeCheck();
				if (mountedRef.current) setNodeStatus(next);
			} else {
				setNodeInstallResult({ ok: false, message: result.error ?? t("environment.guideNodeFailed") });
			}
		} catch (error) {
			if (mountedRef.current) {
				setNodeInstallResult({
					ok: false,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (mountedRef.current) setNodeInstalling(false);
		}
	}, [api]);

	/** 检测 npm 可用性（优先便携包内的 npm；主进程自动解析）。 */
	const checkNpmForGuide = useCallback(async () => {
		setNpmChecking(true);
		setNpmError(null);
		try {
			const result = await api.pi.checkNpm();
			if (!mountedRef.current) return;
			if (result.available && result.version) {
				setNpmVersion(result.version);
			} else {
				setNpmVersion(null);
				setNpmError(result.error ?? t("environment.guideNpmMissing"));
			}
		} catch (error) {
			if (mountedRef.current) {
				setNpmVersion(null);
				setNpmError(error instanceof Error ? error.message : String(error));
			}
		} finally {
			if (mountedRef.current) setNpmChecking(false);
		}
	}, [api]);

	/** 一键安装 pi（收紧通道：只传镜像布尔意图，命令由主进程拼接）。 */
	const installPiForGuide = useCallback(async () => {
		setPiInstalling(true);
		setPiInstallResult(null);
		// 每次开始安装都先清掉「已存在」提示：否则上一轮的提示会盖住本轮的真实结果。
		setPiAlreadyInstalled([]);
		try {
			const result = await api.pi.runtimePiInstall(piUseMirror);
			if (!mountedRef.current) return;
			// 主进程的硬约束：本机已有 pi 就直接不装（不只是 UI 不展示引导），
			// 把现场（已有哪几份）带回来给用户看，避免他以为「没装成功」而反复点。
			if (result.alreadyInstalled && result.alreadyInstalled.length > 0) {
				setPiAlreadyInstalled(result.alreadyInstalled);
				return;
			}
			setPiInstallResult(result);
			if (result.success && result.exitCode === 0) {
				setPiInstallDone(true);
			}
		} catch (error) {
			if (mountedRef.current) {
				setPiInstallResult({
					success: false,
					exitCode: null,
					stdout: "",
					stderr: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			if (mountedRef.current) setPiInstalling(false);
		}
	}, [api, piUseMirror]);

	/** 关闭弹窗时重置一次性状态（检测结果保留会让下次打开看到过期数据）。 */
	const resetGuide = useCallback(() => {
		setNodeStatus(null);
		setNodeChecking(false);
		setNodeInstalling(false);
		setNodeInstallResult(null);
		setNpmVersion(null);
		setNpmChecking(false);
		setNpmError(null);
		setPiInstalling(false);
		setPiInstallResult(null);
		setPiInstallDone(false);
		setPiAlreadyInstalled([]);
	}, []);

	return {
		// state
		nodeStatus,
		nodeChecking,
		nodeInstalling,
		nodeInstallResult,
		npmVersion,
		npmChecking,
		npmError,
		piUseMirror,
		piInstalling,
		piInstallResult,
		piInstallDone,
		piAlreadyInstalled,
		// setters
		setPiUseMirror,
		// commands
		checkNode,
		installNode,
		checkNpmForGuide,
		installPiForGuide,
		resetGuide,
	};
}

export type PiEnvironmentGuide = ReturnType<typeof usePiEnvironmentGuide>;
