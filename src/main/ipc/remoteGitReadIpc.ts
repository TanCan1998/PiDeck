import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { GitReadSnapshotResult, GitResourceGroups, GitWorkspaceFileDiff } from "../../shared/types/git";
import type { ProjectFileTarget } from "../../shared/types/project";
import { createRemoteGitService, remoteGitFailureCode, validateRemoteGitPath, type RemoteGitLocator } from "../git/RemoteGitService";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Reject path authority and additional fields rather than adapting SSH into local path parsing. */
function fileTarget(projectId: string, value: unknown): ProjectFileTarget {
	if (!record(value) || Object.keys(value).some((key) => key !== "projectId" && key !== "relativePath") || value.projectId !== projectId) throw new Error("GIT_RESULT_INVALID");
	return { projectId, relativePath: validateRemoteGitPath(value.relativePath) };
}
function rootTarget(projectId: string, value: unknown) {
	if (value === undefined || value === null || value === "") return;
	if (!record(value) || Object.keys(value).some((key) => key !== "projectId" && key !== "relativePath") || value.projectId !== projectId || value.relativePath !== "") throw new Error("UNSUPPORTED_CAPABILITY");
}

/** Owns Git read request lifetimes; existing status/diff IPC can delegate before any local repository lookup. */
export function registerRemoteGitReadIpc(input: { enabled: boolean; locator(projectId: string): RemoteGitLocator | undefined; trusted(target: RemoteGitLocator): Promise<boolean>; service(): RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined> }) {
	const reads = new Map<AbortController, { senderId: number; projectId: string }>();
	let disposed = false;
	const git = createRemoteGitService({
		locator: input.locator,
		trusted: input.trusted,
		withProject: async (target, task, signal) => {
			const service = await input.service();
			if (!service) throw new Error("SSH_HOST_NOT_READY");
			const result = await service.withProjectSession(target.hostId, target.remotePath, task, { requireReady: true, signal });
			if (!result.ok) throw new Error(result.code);
			return result.value;
		},
	});
	async function read<T>(event: IpcMainInvokeEvent, projectId: unknown, repo: unknown, task: (projectId: string, signal: AbortSignal) => Promise<T>): Promise<T> {
		if (!input.enabled) throw new Error("REMOTE_FEATURE_DISABLED");
		if (disposed) throw new Error("REQUEST_CANCELLED");
		const sender = event.sender;
		if (!Number.isSafeInteger(sender.id) || sender.id < 1 || sender.isDestroyed() || typeof projectId !== "string" || !projectId.trim() || projectId !== projectId.trim() || projectId.length > 256 || /[\x00-\x1f\x7f]/.test(projectId)) throw new Error("GIT_RESULT_INVALID");
		rootTarget(projectId, repo);
		if (reads.size >= 32 || [...reads.values()].filter((read) => read.senderId === sender.id).length >= 4) throw new Error("TOO_MANY_REQUESTS");
		const controller = new AbortController();
		const cancel = () => controller.abort();
		reads.set(controller, { senderId: sender.id, projectId });
		sender.once("destroyed", cancel);
		try {
			const value = await task(projectId, controller.signal);
			if (controller.signal.aborted || sender.isDestroyed()) throw new Error("REQUEST_CANCELLED");
			return value;
		} finally {
			sender.removeListener("destroyed", cancel);
			reads.delete(controller);
		}
	}
	// Cancellation authority is scoped to this sender and main-owned project reads, never a helper id.
	ipcMain.handle(ipcChannels.gitRemoteCancelReads, (event, projectId: unknown) => {
		if (typeof projectId !== "string" || !projectId || projectId.length > 256) throw new Error("GIT_RESULT_INVALID");
		for (const [controller, read] of reads) if (read.senderId === event.sender.id && read.projectId === projectId) controller.abort();
	});
	ipcMain.handle(ipcChannels.gitRemoteSnapshot, async (event, projectId: unknown): Promise<GitReadSnapshotResult> => {
		try {
			return { ok: true, snapshot: await read(event, projectId, undefined, (id, signal) => git.status(id, signal)) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	return {
		status(event: IpcMainInvokeEvent, projectId: unknown, repo?: unknown): Promise<GitResourceGroups> {
			return read(event, projectId, repo, async (id, signal) => (await git.status(id, signal)).groups);
		},
		workspaceDiff(event: IpcMainInvokeEvent, projectId: unknown, group: unknown, value: unknown, repo?: unknown): Promise<GitWorkspaceFileDiff> {
			return read(event, projectId, repo, async (id, signal) => {
				if (group !== "merge" && group !== "index" && group !== "workingTree" && group !== "untracked") throw new Error("GIT_RESULT_INVALID");
				return git.workspaceDiff(id, group, fileTarget(id, value), signal);
			});
		},
		/** Pair with quit cleanup; sender destruction separately cancels only that window's pending reads. */
		dispose() {
			disposed = true;
			for (const controller of reads.keys()) controller.abort();
		},
	};
}
export type RemoteGitReadIpc = ReturnType<typeof registerRemoteGitReadIpc>;
