/**
 * 远端 Session 的 IPC 域：发现（scan）、登记（register）、按需标题（title）。
 *
 * 只做三件事：校验渲染层来的 hostId，解析出 scanner，把结果按稳定码回传。校验在边界：
 * - 远端路径、正文、凭据都不过这个边界；scan 只回 RemoteSessionEntry，title 只回 title/titleOrigin。
 * - 每个 handler 第一行是开关与入参校验；任何异常都折叠成稳定码，绝不把裸异常跨 IPC 抛出去。
 * - title 是**只读**通道：不写 catalog（写盘仍只属于 register）。
 *
 * 通道名由装配注入（channels），本文件不 import shared/ipc.ts（仓库既有先例：contentStoreIpc 的
 * ChannelGroup）。scan/register 缺失是接线错误，构造期抛出；**title 允许暂缺**：装配尚未注入时
 * 不注册该 handler（fail closed），等 H5 注入 ipcChannels.remoteSessionTitle 后自动生效——
 * 这样在装配落地前 main 侧仍能独立通过 typecheck，而不会出现「注册到 undefined 通道」。
 */

import { ipcMain } from "electron";
import { createRemoteSessionScanner, REMOTE_SESSION_CODES, type RemoteSessionCatalogPort, type RemoteSessionProjectResolver, type RemoteSessionRegisterResult, type RemoteSessionScannerPort, type RemoteSessionScanResult, type RemoteSessionTitleResult } from "../sessions/RemoteSessionScanner";

/** 与 remoteHostIpc 同域：hostId 是 UUID 形态的稳定端点身份。 */
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 一个码就是一个码，绝不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** 装配没给通道名（或给了空串）：这是接线错误，构造期就要炸。 */
const CHANNELS_INVALID = "REMOTE_SESSION_CHANNELS_INVALID";

/** 通道组：scan/register 是 H1 之前的既有通道，title 是 H1 的按需标题通道（装配未注入时不注册）。 */
export type RemoteSessionIpcChannels = { scan: string; register: string; title?: string };

export type RemoteSessionIpcInput = {
	/** 实验开关：关掉时渲染层连「有这台主机」都学不到，通道本身也不做任何事。 */
	enabled: boolean;
	/** 懒构建连接服务：解析失败（SSH 客户端不可用等）也是可上报的稳定码，不是崩溃。 */
	service?: () => RemoteSessionScannerPort | undefined | Promise<RemoteSessionScannerPort | undefined>;
	/** 懒取 SessionCatalog（旧装配可以不提供）。 */
	catalog?: () => RemoteSessionCatalogPort | undefined;
	/** 远端会话归属哪个本地项目：本批不解析正文，归属只能由装配给出。 */
	projectIdForHost?: RemoteSessionProjectResolver;
	/** 通道名，由装配从 ipcChannels 传进来。 */
	channels: RemoteSessionIpcChannels;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只让本身已经是稳定码的 message 通过；其余折叠成 fallback，路径/命令行/errno 永不外传。 */
function codeOf(error: unknown, fallback: string): string {
	if (isRecord(error)) {
		const message = error.message;
		if (typeof message === "string" && STABLE_CODE.test(message)) return message;
	}
	return fallback;
}

/** 每个 handler 的第一行职责：开关 + 入参校验。 */
function readHostId(value: unknown): string | undefined {
	return typeof value === "string" && HOST_ID.test(value) ? value : undefined;
}

/**
 * 注册远端 Session 的通道。
 *
 * 与 remoteHostIpc 的 resolveService 同构：把「服务构建失败」也变成一个稳定码，而不是让 rejection
 * 逃到渲染层变成 "Error invoking remote method"。
 */
export function registerRemoteSessionIpc(input: RemoteSessionIpcInput): void {
	const scanChannel = input?.channels?.scan;
	const registerChannel = input?.channels?.register;
	const titleChannel = input?.channels?.title;
	if (typeof scanChannel !== "string" || scanChannel.length === 0 || typeof registerChannel !== "string" || registerChannel.length === 0) throw new Error(CHANNELS_INVALID);

	/**
	 * 墓碑查询：这条远端会话是否已被用户「移除记录」。
	 *
	 * 与 DSH 的 `dshListForeignSessions` 同一形状：**在 IPC 边界过滤「可导入」列表**，用 catalog 的
	 * dismissed 集合排掉用户已经移除记录的那几条（否则刷新一下「移掉的又回来了」）。差别只是身份是
	 * (hostId, remoteSessionId) 对而不是单个 dshSessionId。
	 *
	 * 取不到 catalog（旧装配 / 取 catalog 抛错）时按「没有墓碑」处理：列表原样返回。宁可多列一条
	 * （用户可再移除一次），也不因为一个可恢复的装配问题把整张列表变成空的。
	 */
	const isRemoteSessionDismissed = (hostId: string, remoteSessionId: string): boolean => {
		try {
			return input.catalog?.()?.isRemoteSessionDismissed?.(hostId, remoteSessionId) ?? false;
		} catch {
			return false;
		}
	};

	const resolveScanner = async (): Promise<{ scanner: ReturnType<typeof createRemoteSessionScanner> } | { code: string }> => {
		try {
			const port = await input.service?.();
			if (port === undefined) return { code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" };
			return { scanner: createRemoteSessionScanner({ port, catalog: input.catalog?.(), projectIdForHost: input.projectIdForHost }) };
		} catch (error) {
			return { code: codeOf(error, "REMOTE_CONNECTION_SERVICE_UNAVAILABLE") };
		}
	};

	ipcMain.handle(scanChannel, async (_event, hostIdValue: unknown): Promise<RemoteSessionScanResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const hostId = readHostId(hostIdValue);
		if (hostId === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
		const resolved = await resolveScanner();
		if ("code" in resolved) return { ok: false, code: resolved.code };
		try {
			const result = await resolved.scanner.scan(hostId);
			if (!result.ok) return result;
			// 墓碑只在**这次列举**生效：已「移除记录」的会话不再出现在「可导入」列表里。
			// 远端一个字节都不改（也不会额外发任何帧：扫到的条目本身就是列表的全部输入）。
			return { ok: true, entries: result.entries.filter((entry) => !isRemoteSessionDismissed(hostId, entry.remoteSessionId)) };
		} catch (error) {
			// scanner 自己已 fail-closed；这一层是最后一道「绝不把裸异常跨 IPC 抛出去」。
			return { ok: false, code: codeOf(error, REMOTE_SESSION_CODES.scanFailed) };
		}
	});

	ipcMain.handle(registerChannel, async (_event, hostIdValue: unknown, remoteSessionIdValue: unknown): Promise<RemoteSessionRegisterResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const hostId = readHostId(hostIdValue);
		if (hostId === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
		// remoteSessionId 的形状校验属于 scanner（它同时要当 helper 路径用）；这里只挡非字符串。
		if (typeof remoteSessionIdValue !== "string") return { ok: false, code: REMOTE_SESSION_CODES.idInvalid };
		const resolved = await resolveScanner();
		if ("code" in resolved) return { ok: false, code: resolved.code };
		try {
			return await resolved.scanner.register({ hostId, remoteSessionId: remoteSessionIdValue });
		} catch (error) {
			return { ok: false, code: codeOf(error, REMOTE_SESSION_CODES.registerFailed) };
		}
	});

	// title 是按需标题（H1）：只读、不写 catalog；装配没注入通道名时**不注册**（fail closed，
	// 不能拿 scan/register 顶上，也不能注册到 undefined）。
	if (typeof titleChannel === "string" && titleChannel.length > 0) {
		ipcMain.handle(titleChannel, async (_event, hostIdValue: unknown, remoteSessionIdValue: unknown): Promise<RemoteSessionTitleResult> => {
			if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
			const hostId = readHostId(hostIdValue);
			if (hostId === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
			if (typeof remoteSessionIdValue !== "string") return { ok: false, code: REMOTE_SESSION_CODES.idInvalid };
			const resolved = await resolveScanner();
			if ("code" in resolved) return { ok: false, code: resolved.code };
			try {
				return await resolved.scanner.title({ hostId, remoteSessionId: remoteSessionIdValue });
			} catch (error) {
				return { ok: false, code: codeOf(error, REMOTE_SESSION_CODES.titleFailed) };
			}
		});
	}
}
