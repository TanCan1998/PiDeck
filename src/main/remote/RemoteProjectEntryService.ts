import { randomBytes } from "node:crypto";
import type { RemoteEntryKind, RemoteEntryRevision, RemoteEntryStat, RemoteTrashEntry, RemoteTrashEntryState } from "../../shared/types/remoteFiles";
import { createRemoteFileMutationTokens } from "./RemoteFileMutationTokens";
import {
	assertRemoteProjectEntryCreatable,
	assertRemoteProjectEntryMove,
	assertRemoteProjectEntryMutablePath,
	buildRemoteProjectEntryCommand,
	buildRemoteProjectTrashCommand,
	isRemoteProjectTrashPath,
	readRemoteEntryRevision,
	REMOTE_PROJECT_TRASH_ID,
	REMOTE_PROJECT_TRASH_LIST_MAX_OUTPUT,
	REMOTE_PROJECT_TRASH_MAX_ENTRIES,
	validateRemoteProjectEntryName,
	validateRemoteProjectEntryPath,
	validateRemoteProjectParentPath,
	validateRemoteProjectTrashId,
	type RemoteProjectEntryCommand,
	type RemoteProjectTrashCommand,
} from "./RemoteProjectEntryCommands";

/** 项目 locator 的值快照；renderer 只给 projectId，主机/根永远由 main 解析。 */
export type RemoteProjectEntryTarget = { hostId: string; remotePath: string };
export type RemoteProjectEntrySession = { nodePath: string; hostRevision: number; runCommand: (command: string) => Promise<{ exitCode: number; stdout: string }> };

/**
 * 新稳定码的唯一注册点（docs/remote-file-management-plan.md §9.2）。
 *
 * 收录本批全部新增码（含 4 个 create-project 码，它们由 remoteProjectIpc 发出）与复用码；
 * 脚本返回的码只有在此闭集内才允许透传，闭集外一律折叠（见 run 的 sentUnknown 规则）。
 */
export const REMOTE_FILE_ENTRY_CODES: ReadonlySet<string> = new Set([
	"REMOTE_FILE_TARGET_EXISTS",
	"REMOTE_FILE_NAME_INVALID",
	"REMOTE_FILE_PARENT_NOT_FOUND",
	"REMOTE_FILE_PARENT_NOT_DIRECTORY",
	"REMOTE_FILE_ENTRY_UNSUPPORTED",
	"REMOTE_FILE_PROTECTED_PATH",
	"REMOTE_FILE_MOVE_INTO_SELF",
	"REMOTE_FILE_RENAME_UNSUPPORTED",
	"REMOTE_FILE_TRASH_UNAVAILABLE",
	"REMOTE_FILE_TRASH_ENTRY_NOT_FOUND",
	"REMOTE_FILE_TRASH_ENTRY_INVALID",
	"REMOTE_FILE_ENTRY_LIMIT",
	"REMOTE_FILE_RESULT_UNCONFIRMED",
	"REMOTE_FILE_BUSY",
	"REMOTE_PROJECT_TARGET_EXISTS",
	"REMOTE_PROJECT_PARENT_NOT_FOUND",
	"REMOTE_PROJECT_CREATE_FAILED",
	"REMOTE_PROJECT_CREATE_UNCONFIRMED",
	"REMOTE_FILE_PATH_INVALID",
	"REMOTE_FILE_CHANGED",
	"REMOTE_FILE_NOT_FOUND",
	"REMOTE_FILE_TOO_LARGE",
	"REMOTE_FILE_TRANSFER_INVALID",
	"REMOTE_FILE_PERMISSION_DENIED",
	"REMOTE_FILE_PLATFORM_UNSUPPORTED",
	"REMOTE_FILE_INPUT_INVALID",
	"REMOTE_FILE_COMMAND_FAILED",
	"REMOTE_FILE_VERSION_INVALID",
	"REMOTE_PROJECT_NOT_FOUND",
	"REMOTE_CONNECTION_SERVICE_UNAVAILABLE",
	"SSH_HOST_NOT_READY",
	"SSH_HOST_DISCONNECTED",
	"REQUEST_CANCELLED",
]);

const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_VALUES: ReadonlySet<string> = new Set(["intact", "payload-missing", "payload-changed", "invalid"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(code: string): never {
	throw new Error(code);
}
/** 脚本/会话错误里只放行闭集稳定码；其它一律折叠，绝不把命令/stderr 透给渲染层。 */
function stableCode(error: unknown, fallback: string): string {
	return error instanceof Error && REMOTE_FILE_ENTRY_CODES.has(error.message) ? error.message : fallback;
}

function entryRelativePath(parent: string, name: string): string {
	return parent === "" ? name : parent + "/" + name;
}

/**
 * 主进程持有的远端文件管理服务：locator、entry 令牌、sender 单飞与错误码折叠都在这里；
 * 所有远端 I/O 经 ports.withProject（每主机 FIFO 锁 + pinned SSH + 已验证 Node）。
 */
export function createRemoteProjectEntryService(ports: { locator: (projectId: string) => RemoteProjectEntryTarget | undefined; withProject: <T>(target: RemoteProjectEntryTarget, work: (session: RemoteProjectEntrySession) => Promise<T>) => Promise<T>; now?: () => number }) {
	const now = ports.now ?? Date.now;
	const tokens = createRemoteFileMutationTokens({ now });
	const inFlight = new Set<number>();

	function target(sender: number, projectId: string): RemoteProjectEntryTarget {
		if (!Number.isSafeInteger(sender) || sender < 1) fail("REMOTE_FILE_INPUT_INVALID");
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) fail("REMOTE_FILE_INPUT_INVALID");
		const locator = ports.locator(projectId);
		if (locator === undefined) fail("REMOTE_PROJECT_NOT_FOUND");
		// ProjectStore 可能原地重绑 locator：令牌与命令必须使用值快照。
		return { hostId: locator.hostId, remotePath: locator.remotePath };
	}

	/**
	 * 一个 sender 同时只允许一个写操作（创建/改名/删除/还原/清理）；其余立即 BUSY。
	 * 读操作（stat/list）不进入该集合，避免目录刷新把令牌/确认流程卡住。
	 */
	async function write<T>(sender: number, work: () => Promise<T>): Promise<T> {
		if (!Number.isSafeInteger(sender) || sender < 1) fail("REMOTE_FILE_INPUT_INVALID");
		if (inFlight.has(sender)) fail("REMOTE_FILE_BUSY");
		inFlight.add(sender);
		try {
			return await work();
		} finally {
			inFlight.delete(sender);
		}
	}

	/**
	 * 执行一条固定命令并解析 marker + 单个 JSON。
	 *
	 * sentUnknown 是「命令已经发出、但回执无法确认」时该报的码：写操作用 RESULT_UNCONFIRMED
	 * （可能已执行，不自动重试），纯读用 COMMAND_FAILED。构造/发送前的稳定码（SSH_HOST_NOT_READY、
	 * INPUT_INVALID 等）原样抛出：那些路径没有任何远端副作用。
	 */
	async function run(session: RemoteProjectEntrySession, locator: RemoteProjectEntryTarget, kind: "entry" | "trash", command: RemoteProjectEntryCommand | RemoteProjectTrashCommand, sentUnknown: string): Promise<Record<string, unknown>> {
		let invocation: { command: string; marker: string };
		try {
			invocation =
				kind === "entry"
					? buildRemoteProjectEntryCommand({ nodePath: session.nodePath, root: locator.remotePath, nonce: randomBytes(16).toString("hex"), command: command as RemoteProjectEntryCommand })
					: buildRemoteProjectTrashCommand({ nodePath: session.nodePath, root: locator.remotePath, nonce: randomBytes(16).toString("hex"), command: command as RemoteProjectTrashCommand });
		} catch (error) {
			throw new Error(stableCode(error, "REMOTE_FILE_INPUT_INVALID"));
		}
		let stdout: string;
		try {
			const result = await session.runCommand(invocation.command);
			if (result.exitCode !== 0) throw new Error("REMOTE_FILE_COMMAND_FAILED");
			stdout = result.stdout;
		} catch (error) {
			// 稳定码（未发送/明确拒绝）透传；其余（传输异常/回执丢失）按不可确认处理。
			throw new Error(stableCode(error, sentUnknown));
		}
		const start = stdout.indexOf(invocation.marker);
		if (start < 0) throw new Error(sentUnknown);
		let value: unknown;
		try {
			value = JSON.parse(stdout.slice(start + invocation.marker.length));
		} catch {
			throw new Error(sentUnknown);
		}
		if (!isRecord(value) || typeof value.ok !== "boolean") throw new Error(sentUnknown);
		if (!value.ok) throw new Error(typeof value.code === "string" && REMOTE_FILE_ENTRY_CODES.has(value.code) ? value.code : "REMOTE_FILE_COMMAND_FAILED");
		return value;
	}

	function readRevision(value: unknown): RemoteEntryRevision {
		try {
			return readRemoteEntryRevision(value);
		} catch {
			throw new Error("REMOTE_FILE_TRANSFER_INVALID");
		}
	}

	function readStat(value: unknown): { stat: RemoteEntryStat; revision: RemoteEntryRevision } {
		if (!isRecord(value) || !isRecord(value.stat)) fail("REMOTE_FILE_COMMAND_FAILED");
		const stat = value.stat;
		const kind = stat.kind;
		if (kind !== "file" && kind !== "directory") fail("REMOTE_FILE_COMMAND_FAILED");
		const mtimeMs = stat.mtimeMs;
		if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) fail("REMOTE_FILE_COMMAND_FAILED");
		const bytes = stat.bytes;
		if (kind === "file" ? !Number.isSafeInteger(bytes) || (bytes as number) < 0 : bytes !== undefined) fail("REMOTE_FILE_COMMAND_FAILED");
		return { stat: { kind: kind as RemoteEntryKind, ...(typeof bytes === "number" ? { bytes } : {}), mtimeMs }, revision: readRevision(value.revision) };
	}

	/** 主进程对回收站 manifest 的严格重验（列表由脚本回传原始对象，这里不信任任何字段）。 */
	function readTrashManifest(raw: unknown): { value: Record<string, unknown>; revision: RemoteEntryRevision } | undefined {
		if (!isRecord(raw)) return undefined;
		const keys = Object.keys(raw);
		const expected = ["schemaVersion", "id", "originalPath", "name", "kind", "bytes", "deletedAt", "expiresAt", "revision"];
		if (keys.some((key) => !expected.includes(key))) return undefined;
		if (raw.schemaVersion !== 1) return undefined;
		if (typeof raw.id !== "string" || !REMOTE_PROJECT_TRASH_ID.test(raw.id)) return undefined;
		let originalPath: string;
		try {
			originalPath = validateRemoteProjectEntryPath(raw.originalPath);
			assertRemoteProjectEntryMutablePath(originalPath);
		} catch {
			return undefined;
		}
		if (raw.kind !== "file" && raw.kind !== "directory") return undefined;
		if (typeof raw.name !== "string" || raw.name !== originalPath.split("/").at(-1)) return undefined;
		if (typeof raw.deletedAt !== "string" || raw.deletedAt.length > 64 || Number.isNaN(Date.parse(raw.deletedAt))) return undefined;
		if (typeof raw.expiresAt !== "string" || raw.expiresAt.length > 64 || Number.isNaN(Date.parse(raw.expiresAt))) return undefined;
		let revision: RemoteEntryRevision;
		try {
			revision = readRemoteEntryRevision(raw.revision);
		} catch {
			return undefined;
		}
		if (raw.kind === "file" ? !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0 : raw.bytes !== undefined) return undefined;
		return { value: raw, revision };
	}

	function readTrashEntry(id: string, state: RemoteTrashEntryState, raw: unknown): RemoteTrashEntry {
		if (state === "invalid" || raw === undefined) return { id, originalPath: "", kind: "file", deletedAt: "", expiresAt: "", state };
		const manifest = readTrashManifest(raw);
		if (manifest === undefined) return { id, originalPath: "", kind: "file", deletedAt: "", expiresAt: "", state: "invalid" };
		const value = manifest.value;
		const kind = value.kind as RemoteEntryKind;
		return {
			id,
			originalPath: value.originalPath as string,
			kind,
			...(kind === "file" ? { bytes: value.bytes as number } : {}),
			deletedAt: value.deletedAt as string,
			expiresAt: value.expiresAt as string,
			state,
		};
	}

	function readTrashList(value: Record<string, unknown>): { entries: RemoteTrashEntry[]; truncated: boolean } {
		if (!Array.isArray(value.entries) || value.entries.length > REMOTE_PROJECT_TRASH_MAX_ENTRIES) fail("REMOTE_FILE_COMMAND_FAILED");
		if (typeof value.truncated !== "boolean") fail("REMOTE_FILE_COMMAND_FAILED");
		const entries: RemoteTrashEntry[] = [];
		const seen = new Set<string>();
		for (const raw of value.entries) {
			if (!isRecord(raw) || typeof raw.id !== "string" || !REMOTE_PROJECT_TRASH_ID.test(raw.id) || seen.has(raw.id)) fail("REMOTE_FILE_COMMAND_FAILED");
			if (typeof raw.state !== "string" || !STATE_VALUES.has(raw.state)) fail("REMOTE_FILE_COMMAND_FAILED");
			seen.add(raw.id);
			entries.push(readTrashEntry(raw.id, raw.state as RemoteTrashEntryState, raw.raw));
		}
		entries.sort((left, right) => (left.deletedAt === right.deletedAt ? 0 : left.deletedAt < right.deletedAt ? 1 : -1));
		return { entries, truncated: value.truncated };
	}

	function readRelativeResult(value: Record<string, unknown>): string {
		try {
			return validateRemoteProjectEntryPath(value.relativePath);
		} catch {
			throw new Error("REMOTE_FILE_RESULT_UNCONFIRMED");
		}
	}

	function createTrashId(): { id: string; deletedAt: string; expiresAt: string } {
		const at = new Date(now());
		const stamp = at
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}Z$/, "Z");
		const id = stamp + "-" + randomBytes(4).toString("hex");
		if (!REMOTE_PROJECT_TRASH_ID.test(id)) fail("REMOTE_FILE_COMMAND_FAILED");
		return { id, deletedAt: at.toISOString(), expiresAt: new Date(at.getTime() + TRASH_TTL_MS).toISOString() };
	}

	/** 写操作在锁内先做一次同义 stat 复核（§5.3）：令牌签发后到执行前的改动必须变成 CHANGED，零副作用。 */
	async function recheckRevision(session: RemoteProjectEntrySession, locator: RemoteProjectEntryTarget, relative: string, expected: RemoteEntryRevision): Promise<void> {
		let observed: { stat: RemoteEntryStat; revision: RemoteEntryRevision };
		try {
			observed = readStat(await run(session, locator, "entry", { operation: "stat", relative }, "REMOTE_FILE_COMMAND_FAILED"));
		} catch (error) {
			if (error instanceof Error && (error.message === "REMOTE_FILE_NOT_FOUND" || error.message === "REMOTE_FILE_CHANGED")) fail("REMOTE_FILE_CHANGED");
			throw error;
		}
		if (JSON.stringify(observed.revision) !== JSON.stringify(expected)) fail("REMOTE_FILE_CHANGED");
	}

	return {
		async stat(sender: number, projectId: string, relative: string): Promise<{ stat: RemoteEntryStat; version: string }> {
			const locator = target(sender, projectId);
			validateRemoteProjectEntryPath(relative);
			if (isRemoteProjectTrashPath(relative)) fail("REMOTE_FILE_PROTECTED_PATH");
			return ports.withProject(locator, async (session) => {
				const result = readStat(await run(session, locator, "entry", { operation: "stat", relative }, "REMOTE_FILE_COMMAND_FAILED"));
				return { stat: result.stat, version: tokens.issue({ sender, projectId, relative, hostId: locator.hostId, remotePath: locator.remotePath, hostRevision: session.hostRevision, revision: result.revision, kind: result.stat.kind }) };
			});
		},

		async createFile(sender: number, projectId: string, parentRelativePath: string, name: string): Promise<{ relativePath: string; kind: RemoteEntryKind }> {
			const locator = target(sender, projectId);
			const parent = validateRemoteProjectParentPath(parentRelativePath);
			validateRemoteProjectEntryName(name);
			assertRemoteProjectEntryCreatable(parent, name);
			return write(sender, () =>
				ports.withProject(locator, async (session) => {
					const result = await run(session, locator, "entry", { operation: "create-file", parent, name }, "REMOTE_FILE_RESULT_UNCONFIRMED");
					if (result.kind !== "file") fail("REMOTE_FILE_RESULT_UNCONFIRMED");
					const relativePath = readRelativeResult(result);
					if (relativePath !== entryRelativePath(parent, name)) fail("REMOTE_FILE_RESULT_UNCONFIRMED");
					return { relativePath, kind: "file" as const };
				}),
			);
		},

		async createDirectory(sender: number, projectId: string, parentRelativePath: string, name: string): Promise<{ relativePath: string; kind: RemoteEntryKind }> {
			const locator = target(sender, projectId);
			const parent = validateRemoteProjectParentPath(parentRelativePath);
			validateRemoteProjectEntryName(name);
			assertRemoteProjectEntryCreatable(parent, name);
			return write(sender, () =>
				ports.withProject(locator, async (session) => {
					const result = await run(session, locator, "entry", { operation: "create-dir", parent, name }, "REMOTE_FILE_RESULT_UNCONFIRMED");
					if (result.kind !== "directory") fail("REMOTE_FILE_RESULT_UNCONFIRMED");
					const relativePath = readRelativeResult(result);
					if (relativePath !== entryRelativePath(parent, name)) fail("REMOTE_FILE_RESULT_UNCONFIRMED");
					return { relativePath, kind: "directory" as const };
				}),
			);
		},

		async rename(sender: number, projectId: string, sourceRelativePath: string, targetRelativePath: string, token: string): Promise<{ relativePath: string }> {
			const locator = target(sender, projectId);
			const source = validateRemoteProjectEntryPath(sourceRelativePath);
			const targetPath = validateRemoteProjectEntryPath(targetRelativePath);
			assertRemoteProjectEntryMutablePath(source);
			assertRemoteProjectEntryMutablePath(targetPath);
			return write(sender, async () => {
				const entry = tokens.take(token, { sender, projectId, relative: source, hostId: locator.hostId, remotePath: locator.remotePath });
				assertRemoteProjectEntryMove(source, targetPath, entry.kind);
				return ports.withProject(locator, async (session) => {
					if (session.hostRevision !== entry.hostRevision) fail("REMOTE_FILE_VERSION_INVALID");
					await recheckRevision(session, locator, source, entry.revision);
					const result = await run(session, locator, "entry", { operation: "rename", source, target: targetPath, revision: entry.revision }, "REMOTE_FILE_RESULT_UNCONFIRMED");
					const relativePath = readRelativeResult(result);
					if (relativePath !== targetPath) fail("REMOTE_FILE_RESULT_UNCONFIRMED");
					return { relativePath };
				});
			});
		},

		async deleteEntry(sender: number, projectId: string, relative: string, token: string): Promise<{ trashId: string }> {
			const locator = target(sender, projectId);
			const path = validateRemoteProjectEntryPath(relative);
			assertRemoteProjectEntryMutablePath(path);
			return write(sender, async () => {
				const entry = tokens.take(token, { sender, projectId, relative: path, hostId: locator.hostId, remotePath: locator.remotePath });
				return ports.withProject(locator, async (session) => {
					if (session.hostRevision !== entry.hostRevision) fail("REMOTE_FILE_VERSION_INVALID");
					await recheckRevision(session, locator, path, entry.revision);
					const trash = createTrashId();
					const result = await run(session, locator, "trash", { operation: "delete", relative: path, revision: entry.revision, trashId: trash.id, deletedAt: trash.deletedAt, expiresAt: trash.expiresAt }, "REMOTE_FILE_RESULT_UNCONFIRMED");
					if (result.trashId !== trash.id) fail("REMOTE_FILE_RESULT_UNCONFIRMED");
					return { trashId: trash.id };
				});
			});
		},

		async listTrash(sender: number, projectId: string): Promise<{ entries: RemoteTrashEntry[]; truncated: boolean }> {
			const locator = target(sender, projectId);
			return ports.withProject(locator, async (session) => {
				const value = await run(session, locator, "trash", { operation: "list" }, "REMOTE_FILE_COMMAND_FAILED");
				const parsed = readTrashList(value);
				if (JSON.stringify(value).length > REMOTE_PROJECT_TRASH_LIST_MAX_OUTPUT) fail("REMOTE_FILE_COMMAND_FAILED");
				return parsed;
			});
		},

		async restoreTrash(sender: number, projectId: string, trashId: string): Promise<{ relativePath: string }> {
			const locator = target(sender, projectId);
			const id = validateRemoteProjectTrashId(trashId);
			return write(sender, () =>
				ports.withProject(locator, async (session) => {
					const result = await run(session, locator, "trash", { operation: "restore", trashId: id }, "REMOTE_FILE_RESULT_UNCONFIRMED");
					return { relativePath: readRelativeResult(result) };
				}),
			);
		},

		async pruneTrash(sender: number, projectId: string, trashIds: string[]): Promise<{ removed: string[]; kept: Array<{ id: string; code: string }> }> {
			const locator = target(sender, projectId);
			if (!Array.isArray(trashIds) || trashIds.length === 0 || trashIds.length > 32) fail("REMOTE_FILE_INPUT_INVALID");
			const ids = [...new Set(trashIds.map(validateRemoteProjectTrashId))];
			if (ids.length !== trashIds.length) fail("REMOTE_FILE_INPUT_INVALID");
			return write(sender, () =>
				ports.withProject(locator, async (session) => {
					const result = await run(session, locator, "trash", { operation: "prune", trashIds: ids }, "REMOTE_FILE_RESULT_UNCONFIRMED");
					if (!Array.isArray(result.removed) || !Array.isArray(result.kept)) fail("REMOTE_FILE_RESULT_UNCONFIRMED");
					const removed = result.removed.map((item) => (typeof item === "string" && ids.includes(item) ? item : fail("REMOTE_FILE_RESULT_UNCONFIRMED")));
					const kept = result.kept.map((item) => {
						if (!isRecord(item) || typeof item.id !== "string" || !ids.includes(item.id) || typeof item.code !== "string" || !REMOTE_FILE_ENTRY_CODES.has(item.code)) fail("REMOTE_FILE_RESULT_UNCONFIRMED");
						return { id: item.id, code: item.code };
					});
					if (removed.length + kept.length !== ids.length) fail("REMOTE_FILE_RESULT_UNCONFIRMED");
					return { removed, kept };
				}),
			);
		},

		/** 窗口销毁：只撤销该 sender 的令牌；在途写继续完成（成功/失败都已有确定语义）。 */
		releaseSender(sender: number): void {
			tokens.releaseSender(sender);
		},
		/** 供诊断/测试：当前令牌表大小（不暴露内容）。 */
		tokenCount(): number {
			return tokens.size();
		},
	};
}
export type RemoteProjectEntryService = ReturnType<typeof createRemoteProjectEntryService>;
