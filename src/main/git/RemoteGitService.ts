import { GitStatus, type GitReadSnapshot, type GitResource, type GitResourceGroups, type GitResourceGroupType, type GitWorkspaceFileDiff } from "../../shared/types/git";
import type { ProjectFileTarget } from "../../shared/types/project";
import { parsePorcelainStatus } from "./gitStatusParser";
import { REMOTE_GIT_MAX_RESOURCES, REMOTE_GIT_READ_TIMEOUT_MS, REMOTE_GIT_STATUS_MAX_BYTES, REMOTE_GIT_TEXT_MAX_BYTES, REMOTE_HELPER_PROTOCOL_VERSION } from "../remote/RemoteHelperContract";

export type RemoteGitLocator = { hostId: string; remotePath: string };
export type RemoteGitSession = {
	readonly hostRevision?: number;
	request(method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (id: string) => void }): Promise<unknown>;
	cancel(id: string, options?: { timeoutMs?: number }): Promise<unknown>;
};
export type RemoteGitWriteExpectation = { revision: string; hostRevision: number; target: RemoteGitLocator };
export type RemoteGitReadSnapshot = GitReadSnapshot & { writeExpectation?: RemoteGitWriteExpectation };

const ERRORS = new Set([
	"PATH_OUTSIDE_ROOT",
	"PATH_NOT_FOUND",
	"NOT_A_FILE",
	"PERMISSION_DENIED",
	"IO_ERROR",
	"RESULT_TOO_LARGE",
	"REQUEST_TIMEOUT",
	"REQUEST_CANCELLED",
	"REMOTE_CONNECTION_LOST",
	"GIT_NOT_FOUND",
	"GIT_VERSION_UNSUPPORTED",
	"GIT_NOT_REPOSITORY",
	"GIT_UNSUPPORTED_REPOSITORY",
	"GIT_PLATFORM_UNSUPPORTED",
	"GIT_CONFIG_UNSUPPORTED",
	"GIT_COMMAND_FAILED",
	"GIT_RESULT_INVALID",
	"GIT_RESOURCE_CHANGED",
	"GIT_NOT_TEXT",
	"GIT_INDEX_LOCKED",
	"GIT_WRITE_UNSUPPORTED",
	"GIT_WRITE_RESULT_UNCONFIRMED",
	"GIT_WRITE_SNAPSHOT_EXPIRED",
	"REMOTE_FEATURE_DISABLED",
	"TOO_MANY_REQUESTS",
	"GIT_TRUST_REQUIRED",
	"GIT_TARGET_CHANGED",
	"UNSUPPORTED_CAPABILITY",
	"SSH_HOST_NOT_READY",
	"SSH_HOST_DISCONNECTED",
	"REMOTE_CONNECTION_SERVICE_DISPOSED",
]);
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Restrict protocol diagnostics to the closed vocabulary; arbitrary remote stderr never crosses IPC. */
export function remoteGitFailureCode(error: unknown): string {
	const message = record(error) && typeof error.message === "string" ? error.message : "";
	return ERRORS.has(message) ? message : "GIT_COMMAND_FAILED";
}
/** A filename stays a literal project-relative POSIX value, including spaces and pathspec punctuation. */
export function validateRemoteGitPath(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		Buffer.byteLength(value, "utf8") > 4096 ||
		/[\x00-\x1f\x7f]/.test(value) ||
		value.startsWith("-") ||
		value.startsWith("/") ||
		value.includes("\\") ||
		/^[A-Za-z]:/.test(value) ||
		/%2e|%2f|%5c/i.test(value) ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("PATH_OUTSIDE_ROOT");
	return value;
}
/** Validate the complete machine format before feeding the existing SCM parser, which tolerates local legacy data. */
export function readRemoteGitStatus(value: unknown, projectId: string): RemoteGitReadSnapshot {
	if (!record(value) || typeof value.status !== "string" || value.status.length > 4 * Math.ceil(REMOTE_GIT_STATUS_MAX_BYTES / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.status)) throw new Error("GIT_RESULT_INVALID");
	const bytes = Buffer.from(value.status, "base64");
	if (bytes.length > REMOTE_GIT_STATUS_MAX_BYTES || bytes.toString("base64") !== value.status) throw new Error("GIT_RESULT_INVALID");
	if (value.head !== null && (typeof value.head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head))) throw new Error("GIT_RESULT_INVALID");
	if (value.branch !== null && (typeof value.branch !== "string" || !value.branch || Buffer.byteLength(value.branch) > 4096 || /[\x00-\x1f\x7f]/.test(value.branch))) throw new Error("GIT_RESULT_INVALID");
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error("GIT_RESULT_INVALID");
	}
	if (raw && !raw.endsWith("\0")) throw new Error("GIT_RESULT_INVALID");
	const fields = raw ? raw.slice(0, -1).split("\0") : [];
	let count = 0;
	const intentPaths: string[] = [];
	for (let i = 0; i < fields.length; i += 1) {
		const line = fields[i];
		if (!line || line.length < 4 || line[2] !== " " || !/^[ MADRCUT?!]{2}$/.test(line.slice(0, 2))) throw new Error("GIT_RESULT_INVALID");
		validateRemoteGitPath(line.slice(3));
		if (line.startsWith(" A ")) intentPaths.push(line.slice(3));
		if (/[RC]/.test(line.slice(0, 2))) validateRemoteGitPath(fields[++i]);
		if (++count > REMOTE_GIT_MAX_RESOURCES) throw new Error("RESULT_TOO_LARGE");
	}
	const groups: GitResourceGroups = { merge: [], index: [], workingTree: [], untracked: [] };
	for (const parsed of parsePorcelainStatus(raw)) {
		const target: ProjectFileTarget = { projectId, relativePath: parsed.path };
		const resource: GitResource = { ...parsed, target, displayPath: parsed.path, ...(parsed.oldPath ? { oldTarget: { projectId, relativePath: parsed.oldPath } } : {}) };
		if (resource.status === GitStatus.UNTRACKED) groups.untracked.push(resource);
		else if ([GitStatus.INDEX_MODIFIED, GitStatus.INDEX_ADDED, GitStatus.INDEX_DELETED, GitStatus.INDEX_RENAMED, GitStatus.INDEX_COPIED, GitStatus.INDEX_TYPE_CHANGED].includes(resource.status)) groups.index.push(resource);
		else if ([GitStatus.ADDED_BY_US, GitStatus.ADDED_BY_THEM, GitStatus.DELETED_BY_US, GitStatus.DELETED_BY_THEM, GitStatus.BOTH_ADDED, GitStatus.BOTH_DELETED, GitStatus.BOTH_MODIFIED].includes(resource.status)) groups.merge.push(resource);
		else groups.workingTree.push(resource);
	}
	// The local legacy parser omits Y=A (intent-to-add); remote reads must not lose that resource.
	for (const path of intentPaths) {
		groups.workingTree.push({ path, displayPath: path, target: { projectId, relativePath: path }, status: GitStatus.INTENT_TO_ADD, letter: "A" });
	}
	return { groups, head: value.head, branch: value.branch };
}

/** Main-owned operation boundary: live project values, live trust and bound helper requests; never a local cwd. */
export function createRemoteGitService(ports: { locator(projectId: string): RemoteGitLocator | undefined; trusted(target: RemoteGitLocator): Promise<boolean>; withProject<T>(target: RemoteGitLocator, work: (session: RemoteGitSession) => Promise<T>, signal?: AbortSignal): Promise<T> }) {
	function target(projectId: string): RemoteGitLocator {
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) throw new Error("GIT_RESULT_INVALID");
		const locator = ports.locator(projectId);
		if (!locator) throw new Error("GIT_TARGET_CHANGED");
		return { hostId: locator.hostId, remotePath: locator.remotePath };
	}
	function assertCurrent(projectId: string, expected: RemoteGitLocator) {
		const current = ports.locator(projectId);
		if (!current || current.hostId !== expected.hostId || current.remotePath !== expected.remotePath) throw new Error("GIT_TARGET_CHANGED");
	}
	async function run<T>(projectId: string, method: "git.status" | "git.workspaceDiff" | "git.stage" | "git.unstage", params: unknown, signal: AbortSignal | undefined, parse: (value: unknown, session: RemoteGitSession, capabilities: unknown[]) => T, expected?: RemoteGitWriteExpectation): Promise<T> {
		const locator = target(projectId);
		let dispatchedWrite = false;
		try {
			if (expected && (expected.target.hostId !== locator.hostId || expected.target.remotePath !== locator.remotePath)) throw new Error("GIT_TARGET_CHANGED");
			if (signal?.aborted) throw new Error("REQUEST_CANCELLED");
			if (!(await ports.trusted(locator))) throw new Error("GIT_TRUST_REQUIRED");
			assertCurrent(projectId, locator);
			return await ports.withProject(
				locator,
				async (session) => {
					assertCurrent(projectId, locator);
					let activeId: string | undefined;
					const cancel = () => {
						if (activeId) void session.cancel(activeId, { timeoutMs: 3000 }).catch(() => undefined);
					};
					signal?.addEventListener("abort", cancel);
					async function request(name: string, input?: unknown) {
						if (signal?.aborted) throw new Error("REQUEST_CANCELLED");
						assertCurrent(projectId, locator);
						try {
							if (name === "git.stage" || name === "git.unstage") dispatchedWrite = true;
							const result = await session.request(name, input, {
								timeoutMs: REMOTE_GIT_READ_TIMEOUT_MS,
								onRequestId: (id) => {
									activeId = id;
									if (signal?.aborted) cancel();
								},
							});
							if (signal?.aborted) throw new Error("REQUEST_CANCELLED");
							assertCurrent(projectId, locator);
							return result;
						} finally {
							activeId = undefined;
						}
					}
					try {
						const hello = await request("hello");
						if (!record(hello) || hello.protocolVersion !== REMOTE_HELPER_PROTOCOL_VERSION || hello.root !== locator.remotePath || !Array.isArray(hello.capabilities) || !hello.capabilities.includes(method)) throw new Error("UNSUPPORTED_CAPABILITY");
						// Trust is mutable while the host lock is queued; check it at the actual operation boundary.
						if (!(await ports.trusted(locator))) throw new Error("GIT_TRUST_REQUIRED");
						if (expected && session.hostRevision !== expected.hostRevision) throw new Error("GIT_TARGET_CHANGED");
						return parse(await request(method, params), session, hello.capabilities);
					} finally {
						signal?.removeEventListener("abort", cancel);
					}
				},
				signal,
			);
		} catch (error) {
			const code = remoteGitFailureCode(error);
			if (dispatchedWrite && ["GIT_RESULT_INVALID", "REQUEST_TIMEOUT", "REQUEST_CANCELLED", "REMOTE_CONNECTION_LOST", "GIT_TARGET_CHANGED", "GIT_COMMAND_FAILED"].includes(code)) throw new Error("GIT_WRITE_RESULT_UNCONFIRMED");
			throw new Error(code);
		}
	}
	return {
		status(projectId: string, signal?: AbortSignal): Promise<RemoteGitReadSnapshot> {
			return run(projectId, "git.status", {}, signal, (value, session, capabilities) => {
				const snapshot = readRemoteGitStatus(value, projectId);
				if (record(value) && value.revision !== undefined) {
					if (typeof value.revision !== "string" || !/^[0-9a-f]{64}$/.test(value.revision)) throw new Error("GIT_RESULT_INVALID");
					if (capabilities.includes("git.stage") && capabilities.includes("git.unstage") && typeof session.hostRevision === "number" && Number.isSafeInteger(session.hostRevision) && session.hostRevision >= 0)
						snapshot.writeExpectation = { revision: value.revision, hostRevision: session.hostRevision, target: target(projectId) };
				}
				return snapshot;
			});
		},
		/** The expectation is issued by main; renderer data never becomes a host/revision authority. */
		mutate(projectId: string, operation: "stage" | "unstage", group: GitResourceGroupType, file: ProjectFileTarget, expected: RemoteGitWriteExpectation, signal?: AbortSignal): Promise<void> {
			if (file.projectId !== projectId || (operation === "unstage" ? group !== "index" : !["workingTree", "untracked"].includes(group))) throw new Error("GIT_RESULT_INVALID");
			return run(
				projectId,
				operation === "stage" ? "git.stage" : "git.unstage",
				{ path: validateRemoteGitPath(file.relativePath), group, expectedRevision: expected.revision },
				signal,
				(value) => {
					if (!record(value) || value.applied !== true || Object.keys(value).length !== 1) throw new Error("GIT_RESULT_INVALID");
				},
				expected,
			);
		},
		workspaceDiff(projectId: string, group: GitResourceGroupType, file: ProjectFileTarget, signal?: AbortSignal): Promise<GitWorkspaceFileDiff> {
			if (file.projectId !== projectId || !["merge", "index", "workingTree", "untracked"].includes(group)) throw new Error("GIT_RESULT_INVALID");
			const path = validateRemoteGitPath(file.relativePath);
			return run(projectId, "git.workspaceDiff", { group, path }, signal, (value) => {
				if (!record(value) || typeof value.originalContent !== "string" || typeof value.modifiedContent !== "string") throw new Error("GIT_RESULT_INVALID");
				for (const text of [value.originalContent, value.modifiedContent]) if (text.includes("\0") || Buffer.byteLength(text, "utf8") > REMOTE_GIT_TEXT_MAX_BYTES || Buffer.from(text, "utf8").toString("utf8") !== text) throw new Error("GIT_RESULT_INVALID");
				return { path, target: { projectId, relativePath: path }, displayPath: path, originalContent: value.originalContent, modifiedContent: value.modifiedContent };
			});
		},
	};
}
export type RemoteGitService = ReturnType<typeof createRemoteGitService>;
