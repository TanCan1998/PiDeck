/**
 * 远端项目域的 IPC 注册（G1：按域从 remoteHostIpc.ts 拆出，纯搬迁）。
 *
 * 这里只放「连上一台主机之后，按 projectId 只读地看什么」：项目登记 + 确认回答 + 列表 + 读取 + 搜索
 * + 项目级 root 复核状态（第四批设计 (i)）。
 * hosts 域（连得上吗、诊断、修复）留在 remoteHostIpc.ts。拆分的动因是体量红线，域边界本来就在：
 * 两个域共用同一套窄依赖（enabled / service / userDataDir 与懒构建的连接服务），但 handler、校验
 * 与错误码各自独立。
 *
 * 两个域刻意互不 import：`HOST_ID`、`senderIdOf`、`codeOf` 在本文件按 hosts 域的同一判据重新声明
 * （仓库里 `HOST_ID` 本来就是每个远端模块各自持有的闭集判据）；若让项目域 import hosts 域，拆分
 * 只是把耦合换了个文件名。
 */

import { createHash } from "node:crypto";
import { ipcMain, type WebContents } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteProjectEnrollAnswerResult, RemoteProjectEnrollMode, RemoteProjectEnrollRequest, RemoteProjectEnrollResult, RemoteProjectListResult, RemoteProjectReadResult, RemoteProjectRootStatusResult, RemoteProjectSearchResult } from "../../shared/types/remoteHost";
import { registerRemoteProjectCreateFlow } from "./remoteProjectCreateIpc";
import type { RemoteHostConnectionService, RemoteProjectSession } from "../remote/RemoteHostConnectionService";
import { REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH } from "../remote/RemoteHelperContract";
import { REMOTE_PROJECT_TRASH_DIR } from "../remote/RemoteProjectEntryCommands";
import { resolveRemoteBrowseRoot } from "../remote/RemoteBrowseRoot";
import { createRemoteSearchReader, REMOTE_SEARCH_READER_CODES } from "../remote/RemoteSearchReader";
import { createRemoteWorkspaceReader, type RemoteWorkspacePort } from "../remote/RemoteWorkspaceReader";
import { PendingConfirmationBroker } from "../security/PendingConfirmationBroker";

/** host id 的闭集判据，与 hosts 域逐字相同；两个域各自持有，避免项目域 import hosts 域。 */
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The broker keys on a positive integer sender; `webContents.id` is exactly that. */
function senderIdOf(sender: WebContents): number | undefined {
	const id = sender?.id;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Map a thrown store/pin error to a stable code. Only messages that are already a bare code survive;
 * anything else collapses to the fallback so no path or command line can reach the renderer.
 */
function codeOf(error: unknown, fallback: string): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : fallback;
}

/**
 * 远端项目 IPC：登记、确认回答、按 projectId 的列表/读取/搜索。
 *
 * `enabled` 关掉时每个通道都返回稳定码（渲染层连「有这条路」都不该知道）；`service` 可选，因此
 * 只读目录在没有任何连接服务时也返回稳定码而不是崩溃；`projects` 是装配层注入的持久化端口
 * （enroll / locator），未提供时项目相关通道返回稳定码。
 */
export function registerRemoteProjectIpc(input: {
	enabled: boolean;
	userDataDir: string;
	service?: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>;
	/**
	 * 远端项目登记端口（Phase 3 第二段）。
	 *
	 * 只开一个狭窄入口：`enroll` 把已确认的 canonical root 写进项目库并返回 stable projectId；
	 * `locator` 按 projectId 取回 `{ hostId, remotePath }`。主进程持有校验后的 canonical 值，
	 * 远端路径不经由渲染层或本机 fs。未提供时（旧装配/正式包）登记与项目读取/搜索都返回稳定码。
	 */
	projects?: {
		enroll: (input: { hostId: string; canonicalRemotePath: string }) => Promise<{ projectId: string }>;
		locator: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined;
	};
}): void {
	/**
	 * Resolve the connection service, turning a discovery failure into a stable code.
	 *
	 * Building the service can fail on purpose: the SSH client is probed before it is trusted, and a
	 * missing or incapable client is a reportable condition rather than a crash. Letting that rejection
	 * escape produced an unhandled "Error invoking remote method" in the renderer, so every caller goes
	 * through here instead of awaiting the factory directly.
	 */
	const resolveService = async (): Promise<{ service: RemoteHostConnectionService } | { code: string }> => {
		try {
			const service = await input.service?.();
			return service === undefined ? { code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" } : { service };
		} catch (error) {
			return { code: codeOf(error, "REMOTE_CONNECTION_SERVICE_UNAVAILABLE") };
		}
	};

	/**
	 * 设置页那套临时「浏览已确认 root」的入口曾在这里：五条 `remote:workspace-*` 通道只凭内存里的
	 * confirmed root 就放行读取，从不重新对齐 live helper 会话。删除它是必要的，但从来不是充分的——
	 * 项目之间的并发串根修在 `RemoteHostConnectionService.withProjectSession`，边界现在在那里。
	 * 它用到的只读构件（RemoteWorkspaceReader、canonical root resolver、helper）全部保留，
	 * 各自的测试也照旧运行。
	 */

	/**
	 * Validate a path the renderer named. Relative to the confirmed root by construction: an absolute path,
	 * a traversal segment, a control byte or a backslash is refused here, so the helper only ever sees a
	 * value that stays inside the boundary regardless of what the UI sent.
	 *
	 * The empty string is this layer's spelling of "the root". The reader spells it `"."` instead (it
	 * refuses an empty path outright), so the two are translated by `readerPath` — the UI should not have to
	 * know which convention the transport chose.
	 */
	const readRelativePath = (value: unknown): string | undefined => {
		if (typeof value !== "string" || value.length > 4096) return undefined;
		if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
		if (value.startsWith("/")) return undefined;
		if (value === "") return "";
		const segments = value.split("/");
		if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
		return value;
	};

	/** This layer's empty string means the root; the reader's own spelling of that is `"."`. */
	const readerPath = (relative: string): string => (relative === "" ? "." : relative);

	/**
	 * Remote project enrollment (Phase 3 第二段).
	 *
	 * A separate decision from browsing a root: this writes a **persistent project** (`ProjectStore`). It
	 * therefore has its own broker action, its own pending table and its own confirmation push channel, so
	 * a project-enrollment prompt can never arrive in the workspace panel or vice versa. The renderer submits
	 * only `{ hostId, candidatePath }`; the canonical value is resolved here and stays here.
	 */
	const enrollBroker = new PendingConfirmationBroker<{ hostId: string; canonicalPath: string }>({
		onRemoved: (requestId) => {
			enrollOffers.delete(requestId);
		},
	});
	const enrollOffers = new Map<string, { subjectId: string; digest: string }>();
	const enrollAction = "remote:project-enroll";
	/**
	 * 「新建空远端项目」确认：与「使用已有目录」是两个不同的用户决定。独立 broker/pending/推送通道
	 * 都在 remoteProjectCreateIpc 中，两者可同时挂起互不串扰。
	 */
	const createProjectFlow = registerRemoteProjectCreateFlow({
		enabled: input.enabled,
		userDataDir: input.userDataDir,
		projects: input.projects,
		resolveService: async () => {
			const service = await resolveService();
			return "code" in service ? { code: service.code } : { client: service.service.client };
		},
	});
	const enrollDigest = (hostId: string, canonicalPath: string): string =>
		createHash("sha256")
			.update(JSON.stringify(["pideck-project-enroll-v1", hostId, canonicalPath]), "utf8")
			.digest("hex");

	ipcMain.handle(ipcChannels.remoteProjectEnroll, async (event, hostIdValue: unknown, pathValue: unknown, modeValue: unknown): Promise<RemoteProjectEnrollResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (input.projects === undefined) return { ok: false, code: "REMOTE_PROJECT_ENROLL_UNAVAILABLE" };
		if (typeof hostIdValue !== "string" || !HOST_ID.test(hostIdValue)) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		if (typeof pathValue !== "string") return { ok: false, code: "REMOTE_BROWSE_ROOT_INVALID" };
		if (modeValue !== undefined && modeValue !== "existing" && modeValue !== "create") return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		const mode: RemoteProjectEnrollMode = modeValue === "create" ? "create" : "existing";
		// 「新建空目录」不是登记：它会在项目根之外执行一次写命令，因此必须先探针、再走独立确认 broker。
		if (mode === "create") {
			const createService = await resolveService();
			if ("code" in createService) return { ok: false, code: createService.code };
			return createProjectFlow.begin(event.sender, createService.service, hostIdValue, pathValue);
		}
		const resolvedService = await resolveService();
		if ("code" in resolvedService) return { ok: false, code: resolvedService.code };
		try {
			// Same pinned probe the workspace panel uses: the canonical value shown here is the one that will be
			// confined to, and a symlink that the handshake would reject can never be confirmed in the first place.
			const resolved = await resolveRemoteBrowseRoot({ userDataDir: input.userDataDir, hostId: hostIdValue, client: resolvedService.service.client, userPath: pathValue });
			const digest = enrollDigest(hostIdValue, resolved.canonicalPath);
			const { requestId, expiresAt } = enrollBroker.begin({ senderId, action: enrollAction, subjectId: hostIdValue, stateDigest: digest, payload: { hostId: hostIdValue, canonicalPath: resolved.canonicalPath } });
			enrollOffers.set(requestId, { subjectId: hostIdValue, digest });
			if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.remoteProjectEnrollConfirm, { requestId, expiresAt, hostId: hostIdValue, label: pathValue, requestedPath: pathValue, canonicalPath: resolved.canonicalPath } satisfies RemoteProjectEnrollRequest);
			return { ok: true, status: "pending", hostId: hostIdValue, canonicalPath: resolved.canonicalPath };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_TARGET_INVALID") };
		}
	});

	ipcMain.handle(ipcChannels.remoteProjectAnswer, async (event, requestId: unknown, choice: unknown): Promise<RemoteProjectEnrollAnswerResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (input.projects === undefined) return { ok: false, code: "REMOTE_PROJECT_ENROLL_UNAVAILABLE" };
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		if (choice !== "approve" && choice !== "deny") return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		const offered = enrollOffers.get(requestId);
		if (offered === undefined) return { ok: false, code: "REMOTE_PROJECT_ENROLL_CONFIRMATION_REQUIRED" };
		try {
			const payload = enrollBroker.answer({ requestId, senderId, action: enrollAction, subjectId: offered.subjectId, stateDigest: offered.digest, choice });
			if (payload === null) return { ok: true, enrolled: false };
			// The confirmation window is real time, and the world moves inside it: the directory can be deleted,
			// or a symlink along it can be re-pointed at something else. Writing the value the user was *shown*
			// is therefore not enough on its own — that value has to still resolve to itself right now, or the
			// user would be confirming a boundary that no longer exists (or no longer means what it did).
			//
			// Re-probing also re-runs the pinned preflight, so a host that was disabled or retired while the
			// prompt was open fails here instead of being enrolled. Nothing is persisted unless this passes,
			// and the broker already consumed the request, so the user re-enrolls rather than getting a
			// half-written record.
			const resolvedService = await resolveService();
			if ("code" in resolvedService) return { ok: false, code: resolvedService.code };
			try {
				const rechecked = await resolveRemoteBrowseRoot({ userDataDir: input.userDataDir, hostId: payload.hostId, client: resolvedService.service.client, userPath: payload.canonicalPath });
				if (rechecked.canonicalPath !== payload.canonicalPath) return { ok: false, code: "REMOTE_PROJECT_ROOT_CHANGED" };
			} catch (error) {
				return { ok: false, code: codeOf(error, "REMOTE_PROJECT_ROOT_UNRESOLVED") };
			}
			// Write the durable record only now, with the main-held canonical value. The renderer cannot supply
			// the path, the id or an "already confirmed" flag.
			const { projectId } = await input.projects.enroll({ hostId: payload.hostId, canonicalRemotePath: payload.canonicalPath });
			return { ok: true, enrolled: true, projectId };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_TARGET_INVALID") };
		}
	});

	/**
	 * Resolve a project's ssh locator into the host/root pair a read needs.
	 *
	 * Deliberately performs no session work and returns no reader: switching the root, establishing the
	 * session and the whole listing/file read happen together inside `withProjectSession`. Handing back a
	 * reader here is exactly the shape that let a second project's root switch land in the middle of a
	 * multi-chunk read. Every failure is a stable code; a non-ssh project is refused rather than guessed at.
	 */
	const projectReadTarget = async (projectId: unknown): Promise<{ hostId: string; remotePath: string; service: RemoteHostConnectionService } | { code: string }> => {
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) return { code: "REMOTE_PROJECT_TARGET_INVALID" };
		if (input.projects === undefined) return { code: "REMOTE_PROJECT_ENROLL_UNAVAILABLE" };
		const locator = input.projects.locator(projectId);
		if (locator === undefined) return { code: "REMOTE_PROJECT_NOT_FOUND" };
		if (locator.kind !== "ssh") return { code: "UNSUPPORTED_PROJECT_LOCATION" };
		const resolvedService = await resolveService();
		if ("code" in resolvedService) return { code: resolvedService.code };
		return { hostId: locator.hostId, remotePath: locator.remotePath, service: resolvedService.service };
	};

	/**
	 * Bind the reader's transport to one already-pinned session.
	 *
	 * The host id is re-checked rather than ignored: the reader names a host in its diagnostics, and a port
	 * that silently served another host would make those diagnostics lie.
	 */
	const sessionPort = (session: RemoteProjectSession, hostId: string): RemoteWorkspacePort => ({
		request: (requestHostId, method, params, options) => (requestHostId === hostId ? session.request(method, params, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
		cancel: (requestHostId, requestId, options) => (requestHostId === hostId ? session.cancel(requestId, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
	});

	ipcMain.handle(ipcChannels.remoteProjectList, async (_event, projectIdValue: unknown, pathValue: unknown): Promise<RemoteProjectListResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const relative = readRelativePath(pathValue);
		if (relative === undefined) return { ok: false, code: "REMOTE_PROJECT_PATH_INVALID" };
		const target = await projectReadTarget(projectIdValue);
		if ("code" in target) return { ok: false, code: target.code };
		try {
			// The whole listing runs inside the host's operation boundary: a switch for another project queues
			// behind it instead of re-pointing the session halfway through.
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				return reader.list(target.hostId, readerPath(relative));
			});
			if (!outcome.ok) return { ok: false, code: outcome.code };
			return { ok: true, entries: outcome.value.entries.map((entry) => ({ name: entry.name, kind: entry.kind, ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }) })) };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_READ_FAILED") };
		}
	});

	ipcMain.handle(ipcChannels.remoteProjectRead, async (_event, projectIdValue: unknown, pathValue: unknown): Promise<RemoteProjectReadResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		// The read of the root itself is not a file; an empty path is a valid listing target but never a read.
		const relative = readRelativePath(pathValue);
		if (relative === undefined || relative === "") return { ok: false, code: "REMOTE_PROJECT_PATH_INVALID" };
		// 回收站不是用户可读的项目文件：读通道在这里拒绝（只读列表隐藏、回收站三通道单独授权）。
		if (relative === REMOTE_PROJECT_TRASH_DIR || relative.startsWith(REMOTE_PROJECT_TRASH_DIR + "/")) return { ok: false, code: "REMOTE_FILE_PROTECTED_PATH" };
		const target = await projectReadTarget(projectIdValue);
		if ("code" in target) return { ok: false, code: target.code };
		try {
			// The sizing stat, every chunk and the closing stat all happen under one host operation, so no
			// other project can switch the root between two chunks of this file.
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				return reader.readFile(target.hostId, relative);
			});
			if (!outcome.ok) return { ok: false, code: outcome.code };
			const file = outcome.value;
			return { ok: true, contentBase64: Buffer.from(file.content).toString("base64"), bytes: file.bytes, mtimeMs: file.mtimeMs };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_READ_FAILED") };
		}
	});

	/**
	 * 项目内**文件名**搜索（不含内容搜索）。
	 *
	 * 与 listProject/readProjectFile 同构：解析 locator → host/root，整次搜索都在 withProjectSession 的受控
	 * 边界内完成，因此一次搜索不会横跨两个 root。query 来自渲染层，在这里（IPC 边界）先按契约校验一次，
	 * reader 内部还会再校验一次；非法 query 一个帧都不发出去。
	 *
	 * `truncated` 必须如实透传：它表示遍历在某一项上限处收束，界面据此显示「结果已截断」，而不是把一屏
	 * 结果伪装成完整答案。
	 */
	ipcMain.handle(ipcChannels.remoteProjectSearch, async (_event, projectIdValue: unknown, pathValue: unknown, queryValue: unknown): Promise<RemoteProjectSearchResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const relative = readRelativePath(pathValue);
		if (relative === undefined) return { ok: false, code: "REMOTE_PROJECT_PATH_INVALID" };
		// 渲染层来的值一律不可信：长度与控制字节在这里就拒，绝不把非法 query 发到远端。
		if (typeof queryValue !== "string" || queryValue.length === 0 || queryValue.length > REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(queryValue)) return { ok: false, code: REMOTE_SEARCH_READER_CODES.queryInvalid };
		const target = await projectReadTarget(projectIdValue);
		if ("code" in target) return { ok: false, code: target.code };
		try {
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const reader = createRemoteSearchReader({ port: sessionPort(session, target.hostId) });
				return reader.search(target.hostId, readerPath(relative), queryValue);
			});
			if (!outcome.ok) return { ok: false, code: outcome.code };
			const result = outcome.value;
			// 只把界面要用的字段接过去；远端多余字段在 reader 里已被拒，这里再显式重建一次。
			return {
				ok: true,
				entries: result.entries.map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind, ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }) })),
				scanned: result.scanned,
				truncated: result.truncated,
			};
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_READ_FAILED") };
		}
	});

	/**
	 * 项目级 root 复核状态（第四批设计 (i)）。
	 *
	 * 只读既往复核结果：不连主机、不发任何 helper 请求、不建立会话，也不在这里重新复核（复核只在建立/恢复
	 * 会话时发生）。projectId → (hostId, remotePath) 由 main 从项目库解析，渲染层不传路径，因此同一个 host 上
	 * 某个项目漂移不会污染另一个健康项目的答案——这正是 (i) 相对「接到主机级 needs-attention」的价值。
	 * projectReadTarget 已经做完全部入参/归属校验（非法 id、未知项目、非 ssh 项目各自的稳定码），这里复用它，
	 * 但只取 locator 与 service，不碰会话。
	 */
	ipcMain.handle(ipcChannels.remoteProjectRootStatus, async (_event, projectIdValue: unknown): Promise<RemoteProjectRootStatusResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const target = await projectReadTarget(projectIdValue);
		if ("code" in target) return { ok: false, code: target.code };
		const status = target.service.projectRootStatus(target.hostId, target.remotePath);
		return status.status === "ok" ? { ok: true, status: "ok" } : { ok: true, status: "needs-attention", code: status.code };
	});
}
