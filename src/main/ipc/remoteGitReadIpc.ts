import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type {
	GitCommitResult,
	GitIndexMutationResult,
	GitReadSnapshotResult,
	GitResourceGroups,
	GitWorkspaceFileDiff,
	RemoteGitBranchMutationResult,
	RemoteGitCommitDetailResult,
	RemoteGitCompareResult,
	RemoteGitDiscardResult,
	RemoteGitLogResult,
	RemoteGitRecoveryDropResult,
	RemoteGitRecoveryListResult,
	RemoteGitRecoveryRestoreResult,
	RemoteGitRefFileDiffResult,
	RemoteGitRefsResult,
	RemoteGitReposResult,
	RemoteGitFetchOutcomeResult,
	RemoteGitInitResult,
	RemoteGitPullOutcomeResult,
	RemoteGitPushOutcomeResult,
	RemoteGitSyncFactsResult,
} from "../../shared/types/git";
import type { ProjectFileTarget } from "../../shared/types/project";
import { createRemoteGitService, remoteGitFailureCode, validateRemoteGitPath, validateRemoteGitRepoPath, type RemoteGitLocator } from "../git/RemoteGitService";
import { createRemoteGitMutationTokens } from "../git/RemoteGitMutationTokens";
import { REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES } from "../remote/RemoteHelperContract";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Reject path authority and additional fields rather than adapting SSH into local path parsing. */
function fileTarget(projectId: string, value: unknown): ProjectFileTarget {
	if (!record(value) || Object.keys(value).some((key) => key !== "projectId" && key !== "relativePath") || value.projectId !== projectId) throw new Error("GIT_RESULT_INVALID");
	return { projectId, relativePath: validateRemoteGitPath(value.relativePath) };
}
/** Local Git IPC still sends a ProjectFileTarget-shaped repo; the remote channels send the relative POSIX path. */
function compatRepo(projectId: string, value: unknown): string {
	if (value === undefined || value === null || value === "") return "";
	if (record(value)) {
		if (Object.keys(value).some((key) => key !== "projectId" && key !== "relativePath") || value.projectId !== projectId) throw new Error("GIT_RESULT_INVALID");
		return validateRemoteGitRepoPath(value.relativePath);
	}
	return validateRemoteGitRepoPath(value);
}

/** Owns Git read request lifetimes; existing status/diff IPC can delegate before any local repository lookup. */
export function registerRemoteGitReadIpc(input: { enabled: boolean; locator(projectId: string): RemoteGitLocator | undefined; trusted(target: RemoteGitLocator): Promise<boolean>; service(): RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined> }) {
	const reads = new Map<AbortController, { senderId: number; projectId: string }>();
	const tokens = createRemoteGitMutationTokens();
	const senders = new Map<number, { sender: IpcMainInvokeEvent["sender"]; destroy: () => void }>();
	function watchSender(sender: IpcMainInvokeEvent["sender"]) {
		if (senders.has(sender.id)) return;
		const destroy = () => {
			tokens.revoke(sender.id);
			senders.delete(sender.id);
		};
		senders.set(sender.id, { sender, destroy });
		sender.once("destroyed", destroy);
	}
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
	async function read<T>(event: IpcMainInvokeEvent, projectId: unknown, repo: unknown, task: (projectId: string, signal: AbortSignal) => Promise<T>, mutating = false): Promise<T> {
		if (!input.enabled) throw new Error("REMOTE_FEATURE_DISABLED");
		if (disposed) throw new Error("REQUEST_CANCELLED");
		const sender = event.sender;
		if (!Number.isSafeInteger(sender.id) || sender.id < 1 || sender.isDestroyed() || typeof projectId !== "string" || !projectId.trim() || projectId !== projectId.trim() || projectId.length > 256 || /[\x00-\x1f\x7f]/.test(projectId)) throw new Error("GIT_RESULT_INVALID");
		// The scope is validated (and refused) before anything is queued for SSH.
		validateRemoteGitRepoPath(repo);
		if (reads.size >= 32 || [...reads.values()].filter((read) => read.senderId === sender.id).length >= 4) throw new Error("TOO_MANY_REQUESTS");
		const controller = new AbortController();
		const cancel = () => controller.abort();
		reads.set(controller, { senderId: sender.id, projectId });
		sender.once("destroyed", cancel);
		try {
			const value = await task(projectId, controller.signal);
			if (controller.signal.aborted || sender.isDestroyed()) throw new Error(mutating ? "GIT_WRITE_RESULT_UNCONFIRMED" : "REQUEST_CANCELLED");
			return value;
		} finally {
			sender.removeListener("destroyed", cancel);
			reads.delete(controller);
		}
	}
	// Cancellation authority is scoped to this sender and main-owned project reads, never a helper id.
	ipcMain.handle(ipcChannels.gitRemoteCancelReads, (event, projectId: unknown) => {
		if (typeof projectId !== "string" || !projectId || projectId.length > 256) throw new Error("GIT_RESULT_INVALID");
		tokens.revoke(event.sender.id, projectId);
		for (const [controller, read] of reads) if (read.senderId === event.sender.id && read.projectId === projectId) controller.abort();
	});
	ipcMain.handle(ipcChannels.gitRemoteSnapshot, async (event, projectId: unknown, repo: unknown): Promise<GitReadSnapshotResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			tokens.revoke(event.sender.id, typeof projectId === "string" ? projectId : "");
			const { writeExpectation, commitExpectation, branchExpectation, switchExpectation, discardExpectation, restoreExpectation, dropExpectation, fetchExpectation, pushExpectation, pullExpectation, ...snapshot } = await read(event, projectId, repoPath, (id, signal) => git.status(id, repoPath, signal));
			// Every confirmed scope mints grants bound to itself (G5e): a nested snapshot's tokens carry its repoPath, so
			// the token layer refuses them against another repository.
			if (typeof projectId === "string") {
				if (writeExpectation) snapshot.mutationToken = tokens.issue(event.sender.id, projectId, writeExpectation);
				if (commitExpectation) snapshot.commitToken = tokens.issue(event.sender.id, projectId, commitExpectation);
				if (branchExpectation) snapshot.branchToken = tokens.issue(event.sender.id, projectId, branchExpectation);
				if (switchExpectation) snapshot.switchToken = tokens.issue(event.sender.id, projectId, switchExpectation);
				if (discardExpectation) snapshot.discardToken = tokens.issue(event.sender.id, projectId, discardExpectation);
				if (restoreExpectation) snapshot.restoreToken = tokens.issue(event.sender.id, projectId, restoreExpectation);
				if (dropExpectation) snapshot.dropToken = tokens.issue(event.sender.id, projectId, dropExpectation);
				if (fetchExpectation) snapshot.fetchToken = tokens.issue(event.sender.id, projectId, fetchExpectation);
				if (pushExpectation) snapshot.pushToken = tokens.issue(event.sender.id, projectId, pushExpectation);
				if (pullExpectation) snapshot.pullToken = tokens.issue(event.sender.id, projectId, pullExpectation);
				if (
					snapshot.mutationToken !== undefined ||
					snapshot.commitToken !== undefined ||
					snapshot.branchToken !== undefined ||
					snapshot.switchToken !== undefined ||
					snapshot.discardToken !== undefined ||
					snapshot.restoreToken !== undefined ||
					snapshot.dropToken !== undefined ||
					snapshot.fetchToken !== undefined ||
					snapshot.pushToken !== undefined ||
					snapshot.pullToken !== undefined
				)
					watchSender(event.sender);
			}
			return { ok: true, snapshot };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	/** G5d: one read-only, bounded discovery of the repositories under the project root; no token, no write. */
	ipcMain.handle(ipcChannels.gitRemoteRepos, async (event, projectId: unknown): Promise<RemoteGitReposResult> => {
		try {
			const listing = await read(event, projectId, "", (id, signal) => git.listRepositories(id, signal));
			return { ok: true, repos: listing.repos, truncated: listing.truncated };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteMutateIndex, async (event, projectId: unknown, operation: unknown, group: unknown, value: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<GitIndexMutationResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			if (operation !== "stage" && operation !== "unstage") throw new Error("GIT_RESULT_INVALID");
			if (group !== "index" && group !== "workingTree" && group !== "untracked") throw new Error("GIT_RESULT_INVALID");
			if (operation === "unstage" ? group !== "index" : group === "index") throw new Error("GIT_RESULT_INVALID");
			await read(
				event,
				projectId,
				repoPath,
				(id, signal) => {
					const file = fileTarget(id, value);
					const expected = tokens.take(event.sender.id, id, "index", repoPath, token);
					return git.mutate(id, operation, group, file, expected, repoPath, signal);
				},
				true,
			);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteCommit, async (event, projectId: unknown, message: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<GitCommitResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			// The message is user input, so it is bounded here before any SSH session is queued for it.
			if (typeof message !== "string" || message.length === 0 || message.trim().length === 0 || message.includes("\0") || Buffer.byteLength(message, "utf8") > REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES) throw new Error("GIT_COMMIT_MESSAGE_EMPTY");
			await read(event, projectId, repoPath, (id, signal) => git.commit(id, message, tokens.take(event.sender.id, id, "commit", repoPath, token), repoPath, signal), true);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteCreateBranch, async (event, projectId: unknown, name: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitBranchMutationResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			await read(event, projectId, repoPath, (id, signal) => git.createBranch(id, name, tokens.take(event.sender.id, id, "branch", repoPath, token), repoPath, signal), true);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteSwitchBranch, async (event, projectId: unknown, name: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitBranchMutationResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			await read(event, projectId, repoPath, (id, signal) => git.switchBranch(id, name, tokens.take(event.sender.id, id, "switch", repoPath, token), repoPath, signal), true);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteDiscard, async (event, projectId: unknown, group: unknown, value: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitDiscardResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			const result = await read(event, projectId, repoPath, (id, signal) => git.discard(id, group, fileTarget(id, value), tokens.take(event.sender.id, id, "discard", repoPath, token), repoPath, signal), true);
			return { ok: true, recoveryRef: result.recoveryRef };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteRecoveryList, async (event, projectId: unknown, repo: unknown): Promise<RemoteGitRecoveryListResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			const listing = await read(event, projectId, repoPath, (id, signal) => git.recoveryList(id, repoPath, signal));
			return { ok: true, entries: listing.entries, truncated: listing.truncated };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteRecoveryRestore, async (event, projectId: unknown, ref: unknown, oid: unknown, path: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitRecoveryRestoreResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			const restored = await read(event, projectId, repoPath, (id, signal) => git.recoveryRestore(id, ref, oid, path, tokens.take(event.sender.id, id, "restore", repoPath, token), repoPath, signal), true);
			return { ok: true, path: restored.path, bytes: restored.bytes };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteRecoveryDrop, async (event, projectId: unknown, ref: unknown, oid: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitRecoveryDropResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			await read(event, projectId, repoPath, (id, signal) => git.recoveryDrop(id, ref, oid, tokens.take(event.sender.id, id, "drop", repoPath, token), repoPath, signal), true);
			return { ok: true };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	/* G5a sync: facts are a read, the three verbs are network writes with their own grants. */
	ipcMain.handle(ipcChannels.gitRemoteSyncFacts, async (event, projectId: unknown, repo: unknown): Promise<RemoteGitSyncFactsResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			return { ok: true, facts: await read(event, projectId, repoPath, (id, signal) => git.syncFacts(id, repoPath, signal)) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteFetch, async (event, projectId: unknown, remote: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitFetchOutcomeResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			return { ok: true, outcome: await read(event, projectId, repoPath, (id, signal) => git.fetch(id, remote, tokens.take(event.sender.id, id, "fetch", repoPath, token), repoPath, signal), true) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemotePush, async (event, projectId: unknown, remote: unknown, branch: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitPushOutcomeResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			return { ok: true, outcome: await read(event, projectId, repoPath, (id, signal) => git.push(id, remote, branch, tokens.take(event.sender.id, id, "push", repoPath, token), repoPath, signal), true) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemotePull, async (event, projectId: unknown, remote: unknown, branch: unknown, token: unknown, repo: unknown, ...extra: unknown[]): Promise<RemoteGitPullOutcomeResult> => {
		try {
			// The trailing scope is validated before any host work; undefined/'' keeps the project-root repository.
			const repoPath = validateRemoteGitRepoPath(repo);
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			return { ok: true, outcome: await read(event, projectId, repoPath, (id, signal) => git.pull(id, remote, branch, tokens.take(event.sender.id, id, "pull", repoPath, token), repoPath, signal), true) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	/* Read-only history (G3a): same sender/project/pressure boundaries as status; never a token. */
	ipcMain.handle(ipcChannels.gitRemoteLog, async (event, projectId: unknown, options: unknown, repo: unknown): Promise<RemoteGitLogResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			const page = await read(event, projectId, repoPath, (id, signal) => git.log(id, options, repoPath, signal));
			return { ok: true, page };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteCommitDetail, async (event, projectId: unknown, oid: unknown, repo: unknown): Promise<RemoteGitCommitDetailResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			const detail = await read(event, projectId, repoPath, (id, signal) => git.commitDetail(id, oid, repoPath, signal));
			return { ok: true, detail };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteRefs, async (event, projectId: unknown, repo: unknown): Promise<RemoteGitRefsResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			const refs = await read(event, projectId, repoPath, (id, signal) => git.refs(id, repoPath, signal));
			return { ok: true, refs };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	/* G5b refs compare: same read boundary as history, no token; both refs are full local ref names. */
	ipcMain.handle(ipcChannels.gitRemoteCompare, async (event, projectId: unknown, base: unknown, head: unknown, repo: unknown): Promise<RemoteGitCompareResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			return { ok: true, compare: await read(event, projectId, repoPath, (id, signal) => git.compare(id, base, head, repoPath, signal)) };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	/*
	 * G5c explicit init: the one write channel with no token, because there is no confirmed repository state a
	 * renderer could bind a grant to - the absence of .git is the precondition. It still runs through the same
	 * read() boundary (enabled / sender / project identity / trust / pressure) and is marked as a write, so a
	 * reply lost after dispatch becomes GIT_WRITE_RESULT_UNCONFIRMED instead of being replayed.
	 */
	ipcMain.handle(ipcChannels.gitRemoteInit, async (event, projectId: unknown, ...extra: unknown[]): Promise<RemoteGitInitResult> => {
		try {
			// Init is root-only: a supplied repository scope is refused before any SSH session is opened.
			if (extra.length) throw new Error("GIT_RESULT_INVALID");
			const created = await read(event, projectId, undefined, (id, signal) => git.init(id, signal), true);
			return { ok: true, branch: created.branch };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	ipcMain.handle(ipcChannels.gitRemoteRefFileDiff, async (event, projectId: unknown, base: unknown, head: unknown, value: unknown, repo: unknown): Promise<RemoteGitRefFileDiffResult> => {
		try {
			const repoPath = validateRemoteGitRepoPath(repo);
			const diff = await read(event, projectId, repoPath, (id, signal) => git.refFileDiff(id, base, head, fileTarget(id, value), repoPath, signal));
			return { ok: true, diff };
		} catch (error) {
			return { ok: false, code: remoteGitFailureCode(error) };
		}
	});
	return {
		async status(event: IpcMainInvokeEvent, projectId: unknown, repo?: unknown): Promise<GitResourceGroups> {
			const repoPath = compatRepo(typeof projectId === "string" ? projectId : "", repo);
			return read(event, projectId, repoPath, async (id, signal) => (await git.status(id, repoPath, signal)).groups);
		},
		async workspaceDiff(event: IpcMainInvokeEvent, projectId: unknown, group: unknown, value: unknown, repo?: unknown): Promise<GitWorkspaceFileDiff> {
			const repoPath = compatRepo(typeof projectId === "string" ? projectId : "", repo);
			return read(event, projectId, repoPath, async (id, signal) => {
				if (group !== "merge" && group !== "index" && group !== "workingTree" && group !== "untracked") throw new Error("GIT_RESULT_INVALID");
				return git.workspaceDiff(id, group, fileTarget(id, value), repoPath, signal);
			});
		},
		/** Pair with quit cleanup; sender destruction separately cancels only that window's pending reads. */
		dispose() {
			disposed = true;
			tokens.clear();
			for (const { sender, destroy } of senders.values()) sender.removeListener("destroyed", destroy);
			senders.clear();
			for (const controller of reads.keys()) controller.abort();
		},
	};
}
export type RemoteGitReadIpc = ReturnType<typeof registerRemoteGitReadIpc>;
