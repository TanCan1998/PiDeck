import type {
	GitCommitResult,
	GitIndexMutationResult,
	GitReadSnapshot,
	GitReadSnapshotResult,
	GitResourceGroupType,
	GitWorkspaceFileDiff,
	RemoteGitBranchMutationResult,
	RemoteGitCommitDetail,
	RemoteGitCompare,
	RemoteGitCompareResult,
	RemoteGitDiscardResult,
	RemoteGitFetchOutcome,
	RemoteGitInitResult,
	RemoteGitPullOutcome,
	RemoteGitPushOutcome,
	RemoteGitSyncFactsView,
	RemoteGitCommitDetailResult,
	RemoteGitLogPage,
	RemoteGitLogResult,
	RemoteGitRecoveryEntryView,
	RemoteGitRefFileDiff,
	RemoteGitRefFileDiffResult,
	RemoteGitRefs,
	RemoteGitRefsResult,
} from "../../../shared/types/git";
import type { ProjectFileTarget } from "../../../shared/types/project";

export type RemoteGitViewState = {
	projectKey: string;
	loading: boolean;
	snapshot?: GitReadSnapshot;
	errorCode?: string;
	mutating?: boolean;
	/** Which action is in flight; the panel says “writing the index”, “committing”, or which branch action runs. */
	mutatingKind?: "index" | "commit" | "branch" | "switch" | "discard" | "restore" | "drop" | "fetch" | "push" | "pull" | "init";
	/** Explicit repository creation is its own single-flight state: it starts from “not a repository”, not from facts. */
	initializing?: boolean;
	/** The branch the newly created repository reported; the panel shows it on the init outcome line. */
	initNotice?: { branch: string | null };
	/** Where the last discarded content went; null means the discarded change was a deletion (nothing to keep). */
	discardRecovery?: { ref: string | null; path: string };
	/* Recovery store (G4b): a manually loaded listing plus the outcome of the last restore or drop. */
	recovery?: { entries: RemoteGitRecoveryEntryView[]; truncated: boolean };
	recoveryLoading?: boolean;
	recoveryErrorCode?: string;
	recoveryNotice?: { kind: "restored" | "dropped"; path: string };
	/* Sync (G5a): facts of the remote chain, loaded manually-by-effect, plus the outcome of the last verb. */
	sync?: RemoteGitSyncFactsView;
	syncLoading?: boolean;
	syncErrorCode?: string;
	syncNotice?: { kind: "fetch" | "push" | "pull"; outcome: string };
	/** Counts confirmed commits, so the panel can clear its message box exactly once per success. */
	confirmedCommits?: number;
	diffLoading: boolean;
	/** A workspace diff or one file's two sides between two revisions; one surface, one flight at a time. */
	diff?: GitWorkspaceFileDiff | RemoteGitRefFileDiff;
	diffKind?: "workspace" | "revision";
	diffGroup?: GitResourceGroupType;
	diffErrorCode?: string;
	/* Read-only history (G3a): manual loads only; facts die with the snapshot facts so the panel never mixes generations. */
	history?: RemoteGitLogPage;
	historyLoading?: boolean;
	historyMoreLoading?: boolean;
	historyErrorCode?: string;
	detailOid?: string;
	detail?: RemoteGitCommitDetail;
	detailLoading?: boolean;
	detailErrorCode?: string;
	refs?: RemoteGitRefs;
	refsLoading?: boolean;
	refsErrorCode?: string;
	/* G5b compare: last click wins; the file list carries the resolved OIDs used for the per-file read. */
	compare?: RemoteGitCompare;
	compareLoading?: boolean;
	compareErrorCode?: string;
};
export type RemoteGitViewApi = {
	cancelRemoteReads(projectId: string): Promise<void>;
	commitRemote(projectId: string, message: string, token: string, repo?: string): Promise<GitCommitResult>;
	mutateRemoteIndex(projectId: string, operation: "stage" | "unstage", group: GitResourceGroupType, target: ProjectFileTarget, token: string, repo?: string): Promise<GitIndexMutationResult>;
	/* Every read and every write names its repository scope ("" is the project root). */
	remoteSnapshot(projectId: string, repo?: string): Promise<GitReadSnapshotResult>;
	workspaceFileDiff(projectId: string, group: GitResourceGroupType, target: ProjectFileTarget, repoPath?: ProjectFileTarget): Promise<GitWorkspaceFileDiff | null>;
	remoteLog(projectId: string, options?: { maxCount?: number; skip?: number }, repo?: string): Promise<RemoteGitLogResult>;
	remoteCommitDetail(projectId: string, oid: string, repo?: string): Promise<RemoteGitCommitDetailResult>;
	remoteRefs(projectId: string, repo?: string): Promise<RemoteGitRefsResult>;
	remoteRefFileDiff(projectId: string, base: string | null, head: string, target: ProjectFileTarget, repo?: string): Promise<RemoteGitRefFileDiffResult>;
	remoteCompare(projectId: string, base: string, head: string, repo?: string): Promise<RemoteGitCompareResult>;
	initRemote(projectId: string): Promise<RemoteGitInitResult>;
	createRemoteBranch(projectId: string, name: string, token: string, repo?: string): Promise<RemoteGitBranchMutationResult>;
	switchRemoteBranch(projectId: string, name: string, token: string, repo?: string): Promise<RemoteGitBranchMutationResult>;
	discardRemote(projectId: string, group: "workingTree" | "untracked", target: ProjectFileTarget, token: string, repo?: string): Promise<RemoteGitDiscardResult>;
	recoveryList(projectId: string, repo?: string): Promise<{ ok: true; entries: RemoteGitRecoveryEntryView[]; truncated: boolean } | { ok: false; code: string }>;
	recoveryRestore(projectId: string, ref: string, oid: string, path: string, token: string, repo?: string): Promise<{ ok: true; path: string; bytes: number } | { ok: false; code: string }>;
	recoveryDrop(projectId: string, ref: string, oid: string, token: string, repo?: string): Promise<{ ok: true } | { ok: false; code: string }>;
	syncFacts(projectId: string, repo?: string): Promise<{ ok: true; facts: RemoteGitSyncFactsView } | { ok: false; code: string }>;
	fetchRemote(projectId: string, remote: string, token: string, repo?: string): Promise<{ ok: true; outcome: RemoteGitFetchOutcome } | { ok: false; code: string }>;
	pushRemote(projectId: string, remote: string, branch: string, token: string, repo?: string): Promise<{ ok: true; outcome: RemoteGitPushOutcome } | { ok: false; code: string }>;
	pullRemote(projectId: string, remote: string, branch: string, token: string, repo?: string): Promise<{ ok: true; outcome: RemoteGitPullOutcome } | { ok: false; code: string }>;
};
/**
 * The same name rules main enforces, kept in step with `validateRemoteGitBranchName` on purpose: the panel refuses
 * locally so an unusable name never leaves the window, while the main process stays the authority. A pseudo-ref such
 * as HEAD is a name Git would refuse - the panel must not offer it and pretend the click could work.
 */
export function validRemoteGitBranchName(name: unknown): name is string {
	if (typeof name !== "string" || name.length === 0 || new TextEncoder().encode(name).length > 1024 || /[\x00-\x1f\x7f\\]/.test(name)) return false;
	if (name === "@" || name.startsWith("-") || name.includes("@{") || name.startsWith("refs/")) return false;
	if (/^(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_HEAD)$/.test(name)) return false;
	return !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(name);
}

/**
 * A compare names full local refs (refs/heads/* or refs/tags/*), exactly the strings `remoteRefs` returns.
 * These rules mirror main's `validateRemoteGitRefFullName` and the frozen helper's readRef; the panel refuses
 * locally so an unusable pair never leaves the window. Git's own check-ref-format is not enough: it accepts
 * an option-like component, a lone `@` and braces (measured), all of which this protocol refuses.
 */
const REMOTE_GIT_REF_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\{}]/;
export function validRemoteGitRefFullName(value: unknown): value is string {
	if (typeof value !== "string" || new TextEncoder().encode(value).length > 1024 || REMOTE_GIT_REF_FORBIDDEN.test(value) || value.includes("..") || value.includes("@{") || value.includes("//")) return false;
	const prefix = value.startsWith("refs/heads/") ? "refs/heads/" : value.startsWith("refs/tags/") ? "refs/tags/" : null;
	if (prefix === null) return false;
	const name = value.slice(prefix.length);
	if (!name) return false;
	return !name.split("/").some((part) => !part || part === "." || part === ".." || part === "@" || part.startsWith(".") || part.startsWith("-") || part.endsWith(".") || part.endsWith(".lock"));
}

function errorCode(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	// Electron invoke prefixes errors with the channel; only the bounded code becomes visible text.
	return /\b(?:GIT_[A-Z_]+|SSH_[A-Z_]+|REMOTE_FEATURE_DISABLED|UNSUPPORTED_CAPABILITY|RESULT_TOO_LARGE|REQUEST_TIMEOUT|REQUEST_CANCELLED|REMOTE_CONNECTION_LOST|PERMISSION_DENIED|PATH_[A-Z_]+|NOT_A_FILE|TOO_MANY_REQUESTS)\b/.exec(raw)?.[0] ?? "GIT_COMMAND_FAILED";
}
/**
 * Single-owner controller: explicit, one-shot index actions and one commit per confirmed snapshot; no polling or replay.
 * `repoPath` is the repository scope of this controller instance ("" is the project root): every read AND every write
 * carries it, so a nested scope writes only that repository; init remains the one root-only action.
 */
export function createRemoteGitViewController(projectId: string, projectKey: string, api: RemoteGitViewApi, publish: (state: RemoteGitViewState) => void, repoPath = "") {
	let active = true;
	let epoch = 0;
	let diffEpoch = 0;
	let historyEpoch = 0;
	let detailEpoch = 0;
	let refsEpoch = 0;
	// The recovery listing has its own epoch: a reload triggered by a finished action must never invalidate the
	// outcome of the action the user performs next.
	let recoveryEpoch = 0;
	// The sync facts belong to one generation of repository state, so they are invalidated like the other reads.
	let syncEpoch = 0;
	// G5b: the compare answer and the refs poll each have a generation. A slow earlier compare must not replace
	// the pair of refs the user clicked last, and a manual refs load invalidates an in-flight poll (only one
	// visible refs answer may publish).
	let compareEpoch = 0;
	let refsPollEpoch = 0;
	let refsPollInFlight = false;
	let state: RemoteGitViewState = { projectKey, loading: false, diffLoading: false };
	function update(next: RemoteGitViewState) {
		// The confirmed-commit counter is sticky: a later read (or a connection loss) must not resurrect the
		// message box the user already cleared.
		const sticky = state.confirmedCommits;
		// Both stickiness rules exist for the same reason: a later read must not erase something the user still needs.
		const carried = sticky === undefined || next.confirmedCommits !== undefined ? next : { ...next, confirmedCommits: sticky };
		const withDiscard = next.discardRecovery === undefined && state.discardRecovery !== undefined ? { ...carried, discardRecovery: state.discardRecovery } : carried;
		const withNotice = next.recoveryNotice === undefined && state.recoveryNotice !== undefined ? { ...withDiscard, recoveryNotice: state.recoveryNotice } : withDiscard;
		const withSyncNotice = next.syncNotice === undefined && state.syncNotice !== undefined ? { ...withNotice, syncNotice: state.syncNotice } : withNotice;
		state = next.initNotice === undefined && state.initNotice !== undefined ? { ...withSyncNotice, initNotice: state.initNotice } : withSyncNotice;
		if (active) publish(state);
	}
	const controller = {
		async refresh(): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating) return;
			const generation = ++epoch;
			diffEpoch += 1;
			// History, detail and refs facts die with the snapshot facts; in-flight section loads are stale too.
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			// Clear previous facts during refresh; a failed read must not display a stale clean repository.
			const uncertainWrite = state.errorCode === "GIT_WRITE_RESULT_UNCONFIRMED";
			const failureCode = (code: string) => (uncertainWrite ? "GIT_WRITE_RESULT_UNCONFIRMED" : code);
			// A failed refresh cannot resolve an uncertain write; only fresh repository facts can.
			update({ projectKey, loading: true, diffLoading: false, ...(uncertainWrite ? { errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" } : {}) });
			try {
				const result = await api.remoteSnapshot(projectId, repoPath);
				if (!active || generation !== epoch) return;
				if (result.ok) update({ projectKey, loading: false, diffLoading: false, snapshot: result.snapshot });
				else update({ projectKey, loading: false, diffLoading: false, errorCode: failureCode(result.code) });
			} catch (error) {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: failureCode(errorCode(error)) });
			}
		},
		async mutate(operation: "stage" | "unstage", group: GitResourceGroupType, target: ProjectFileTarget): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !state.snapshot?.mutationToken || target.projectId !== projectId || (operation === "unstage" ? group !== "index" : group !== "workingTree" && group !== "untracked")) return;
			if (!state.snapshot.groups[group].some((resource) => resource.target.projectId === projectId && resource.target.relativePath === target.relativePath)) return;
			const token = state.snapshot.mutationToken;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "index", errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.mutateRemoteIndex(projectId, operation, group, target, token, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false });
				await controller.refresh();
			} catch {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		async commit(message: string): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !state.snapshot?.commitToken) return;
			// The panel keeps the text; main re-validates it, so an empty/oversized message never reaches the helper.
			if (typeof message !== "string" || message.trim().length === 0 || message.includes("\0")) return;
			const token = state.snapshot.commitToken;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "commit", errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.commitRemote(projectId, message, token, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					// A refusal and an unknown result both drop the facts: only a fresh read may show a clean repository.
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false, confirmedCommits: (state.confirmedCommits ?? 0) + 1 });
				await controller.refresh();
			} catch {
				// The commit may have happened; never retry it, and say so until the user refreshes.
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		async openDiff(group: GitResourceGroupType, target: ProjectFileTarget) {
			if (!active || state.loading || state.diffLoading || state.mutating || !state.snapshot || target.projectId !== projectId) return;
			const generation = epoch;
			const request = ++diffEpoch;
			update({ ...state, diff: undefined, diffKind: "workspace", diffGroup: group, diffErrorCode: undefined, diffLoading: true });
			try {
				const diff = await api.workspaceFileDiff(projectId, group, target, repoPath === "" ? undefined : { projectId, relativePath: repoPath });
				if (!active || generation !== epoch || request !== diffEpoch) return;
				if (!diff || diff.target.projectId !== projectId || diff.target.relativePath !== target.relativePath) update({ ...state, diffLoading: false, diffErrorCode: "GIT_RESOURCE_CHANGED" });
				else update({ ...state, diffLoading: false, diff });
			} catch (error) {
				if (active && generation === epoch && request === diffEpoch) update({ ...state, diffLoading: false, diffErrorCode: errorCode(error) });
			}
		},
		closeDiff() {
			if (!active || state.diffLoading || state.mutating) return;
			diffEpoch += 1;
			update({ ...state, diff: undefined, diffKind: undefined, diffGroup: undefined, diffLoading: false, diffErrorCode: undefined });
		},
		/* Read-only history (G3a): every load is a user action; nothing here polls, connects or writes. */
		async loadHistory(): Promise<void> {
			if (!active || state.loading || state.mutating || state.historyLoading || state.historyMoreLoading) return;
			const generation = ++historyEpoch;
			update({ ...state, history: undefined, historyErrorCode: undefined, historyLoading: true, detail: undefined, detailOid: undefined, detailErrorCode: undefined });
			try {
				const result = await api.remoteLog(projectId, { maxCount: 50 }, repoPath);
				if (!active || generation !== historyEpoch) return;
				if (result.ok) update({ ...state, historyLoading: false, history: result.page });
				else update({ ...state, historyLoading: false, historyErrorCode: result.code });
			} catch (error) {
				if (active && generation === historyEpoch) update({ ...state, historyLoading: false, historyErrorCode: errorCode(error) });
			}
		},
		async loadMoreHistory(): Promise<void> {
			if (!active || state.loading || state.mutating || state.historyLoading || state.historyMoreLoading || !state.history?.hasMore) return;
			const generation = ++historyEpoch;
			const skip = state.history.commits.length;
			update({ ...state, historyMoreLoading: true, historyErrorCode: undefined });
			try {
				const result = await api.remoteLog(projectId, { maxCount: 50, skip }, repoPath);
				if (!active || generation !== historyEpoch) return;
				if (result.ok) update({ ...state, historyMoreLoading: false, history: { commits: [...state.history.commits, ...result.page.commits], hasMore: result.page.hasMore } });
				// A failed page keeps the rows already on screen; only a fresh full load replaces them.
				else update({ ...state, historyMoreLoading: false, historyErrorCode: result.code });
			} catch (error) {
				if (active && generation === historyEpoch) update({ ...state, historyMoreLoading: false, historyErrorCode: errorCode(error) });
			}
		},
		async openCommitDetail(oid: string): Promise<void> {
			// A new click always supersedes the flight in progress; the detail epoch decides which answer may publish.
			if (!active || state.loading || state.mutating) return;
			if (typeof oid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return;
			const generation = ++detailEpoch;
			update({ ...state, detailOid: oid, detail: undefined, detailErrorCode: undefined, detailLoading: true });
			try {
				const result = await api.remoteCommitDetail(projectId, oid, repoPath);
				if (!active || generation !== detailEpoch) return;
				if (result.ok && result.detail.oid === oid) update({ ...state, detailLoading: false, detail: result.detail });
				else update({ ...state, detailLoading: false, detailErrorCode: result.ok ? "GIT_RESOURCE_CHANGED" : result.code });
			} catch (error) {
				if (active && generation === detailEpoch) update({ ...state, detailLoading: false, detailErrorCode: errorCode(error) });
			}
		},
		async loadRefs(): Promise<void> {
			if (!active || state.loading || state.mutating || state.refsLoading) return;
			// A manual load owns the next visible answer; an in-flight poll's answer is retired below.
			refsPollEpoch += 1;
			const generation = ++refsEpoch;
			update({ ...state, refs: undefined, refsErrorCode: undefined, refsLoading: true });
			try {
				const result = await api.remoteRefs(projectId, repoPath);
				if (!active || generation !== refsEpoch) return;
				if (result.ok) update({ ...state, refsLoading: false, refs: result.refs });
				else update({ ...state, refsLoading: false, refsErrorCode: result.code });
			} catch (error) {
				if (active && generation === refsEpoch) update({ ...state, refsLoading: false, refsErrorCode: errorCode(error) });
			}
		},
		/**
		 * Two full local refs, compared by tree. Every click opens a new generation, so the last click wins:
		 * a slower earlier answer is dropped instead of overwriting the pair the user is looking at.
		 */
		async runCompare(base: string, head: string): Promise<void> {
			if (!active || state.loading || state.mutating) return;
			// The panel only offers refs from the loaded list; main and the helper re-check the same rules.
			if (!validRemoteGitRefFullName(base) || !validRemoteGitRefFullName(head)) return;
			const generation = ++compareEpoch;
			update({ ...state, compare: undefined, compareErrorCode: undefined, compareLoading: true });
			try {
				const result = await api.remoteCompare(projectId, base, head, repoPath);
				if (!active || generation !== compareEpoch) return;
				if (result.ok && result.compare.base.ref === base && result.compare.head.ref === head) update({ ...state, compareLoading: false, compare: result.compare });
				else update({ ...state, compareLoading: false, compareErrorCode: result.ok ? "GIT_RESOURCE_CHANGED" : result.code });
			} catch (error) {
				if (active && generation === compareEpoch) update({ ...state, compareLoading: false, compareErrorCode: errorCode(error) });
			}
		},
		/**
		 * A quiet refs read for the bounded poll: it never clears the rows on screen (a tick must not flash an
		 * empty section) and a failed tick keeps the last good list plus its stable code. It is a read only:
		 * no fetch, no write, no sync facts.
		 */
		async pollRefs(): Promise<void> {
			// Single-flight: one poll at a time, never alongside a manual load, and only once facts exist.
			if (!active || state.loading || state.mutating || state.refsLoading || refsPollInFlight || state.refs === undefined) return;
			refsPollInFlight = true;
			const generation = ++refsPollEpoch;
			const refsGeneration = refsEpoch;
			try {
				const result = await api.remoteRefs(projectId, repoPath);
				if (!active || generation !== refsPollEpoch || refsGeneration !== refsEpoch) return;
				if (result.ok) update({ ...state, refs: result.refs, refsErrorCode: undefined });
				else update({ ...state, refsErrorCode: result.code });
			} catch (error) {
				if (active && generation === refsPollEpoch && refsGeneration === refsEpoch) update({ ...state, refsErrorCode: errorCode(error) });
			} finally {
				refsPollInFlight = false;
			}
		},
		/** Collapsing, hiding, switching project or unmounting must retire a poll that is still in flight. */
		stopRefsPolling() {
			refsPollEpoch += 1;
		},
		/** One file's two sides between two revisions, on the same surface as a workspace diff. */
		async openHistoryFileDiff(base: string | null, head: string, target: ProjectFileTarget) {
			if (!active || state.loading || state.diffLoading || state.mutating || target.projectId !== projectId) return;
			if (typeof head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) || (base !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base))) return;
			const generation = epoch;
			const request = ++diffEpoch;
			update({ ...state, diff: undefined, diffKind: "revision", diffGroup: undefined, diffErrorCode: undefined, diffLoading: true });
			try {
				const result = await api.remoteRefFileDiff(projectId, base, head, target, repoPath);
				if (!active || generation !== epoch || request !== diffEpoch) return;
				const diff = result.ok ? result.diff : undefined;
				if (!diff || diff.target.projectId !== projectId || diff.target.relativePath !== target.relativePath || diff.head !== head || diff.base !== base) update({ ...state, diffLoading: false, diffErrorCode: result.ok ? "GIT_RESOURCE_CHANGED" : result.code });
				else update({ ...state, diffLoading: false, diff });
			} catch (error) {
				if (active && generation === epoch && request === diffEpoch) update({ ...state, diffLoading: false, diffErrorCode: errorCode(error) });
			}
		},
		/**
		 * The recoverable destructive action: main authorizes it with its own grant, the helper snapshots the bytes
		 * first, and the panel only ever learns where they went. An unknown outcome keeps the warning and is never
		 * replayed, because the file has already been touched by the time the reply could be lost.
		 */
		async discard(group: "workingTree" | "untracked", target: ProjectFileTarget): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !state.snapshot?.discardToken) return;
			if (target.projectId !== projectId || (group !== "workingTree" && group !== "untracked")) return;
			if (!state.snapshot.groups[group].some((resource) => resource.target.projectId === projectId && resource.target.relativePath === target.relativePath)) return;
			const token = state.snapshot.discardToken;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "discard", discardRecovery: undefined, errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.discardRemote(projectId, group, target, token, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false, discardRecovery: { ref: result.recoveryRef, path: target.relativePath } });
				await controller.refresh();
			} catch {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		/* G5a sync: facts are read on demand; every verb is a network side effect with its own grant and never replayed. */
		async loadSync(): Promise<void> {
			// Reading the remote chain does not depend on a repository read being finished, and it has its own
			// single-flight guard; blocking it on `loading` would drop the load that follows the first read.
			if (!active || state.syncLoading) return;
			const generation = ++syncEpoch;
			update({ ...state, sync: undefined, syncErrorCode: undefined, syncLoading: true });
			try {
				const result = await api.syncFacts(projectId, repoPath);
				if (!active || generation !== syncEpoch) return;
				if (result.ok) update({ ...state, syncLoading: false, sync: result.facts });
				else update({ ...state, syncLoading: false, syncErrorCode: result.code });
			} catch (error) {
				if (active && generation === syncEpoch) update({ ...state, syncLoading: false, syncErrorCode: errorCode(error) });
			}
		},
		/** One network verb: it may change the remote or the worktree, so an unknown result is never replayed. */
		async sync(kind: "fetch" | "push" | "pull", remote: string, branch: string): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !state.sync) return;
			const token = kind === "fetch" ? state.snapshot?.fetchToken : kind === "push" ? state.snapshot?.pushToken : state.snapshot?.pullToken;
			if (token === undefined || state.sync.remotes.indexOf(remote) < 0) return;
			if (kind !== "fetch" && state.sync.branch !== branch) return;
			const generation = ++epoch;
			syncEpoch += 1;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: kind, syncNotice: undefined, errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				// Each verb answers its own shape, so the outcome is read where the type is known instead of cast.
				let outcome: string | undefined;
				let failure: string | undefined;
				if (kind === "fetch") {
					const result = await api.fetchRemote(projectId, remote, token, repoPath);
					if (result.ok) outcome = result.outcome.upToDate ? "up-to-date" : `updated:${result.outcome.updated.length}`;
					else failure = result.code;
				} else if (kind === "push") {
					const result = await api.pushRemote(projectId, remote, branch, token, repoPath);
					if (result.ok) outcome = result.outcome.outcome;
					else failure = result.code;
				} else {
					const result = await api.pullRemote(projectId, remote, branch, token, repoPath);
					if (result.ok) outcome = result.outcome.mode;
					else failure = result.code;
				}
				if (!active || generation !== epoch) return;
				if (outcome === undefined) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: failure });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false, syncNotice: { kind, outcome } });
				await controller.refresh();
				await controller.loadSync();
			} catch {
				// The remote may have moved: say so instead of pretending nothing happened, and never retry.
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		fetch(remote: string): Promise<void> {
			return controller.sync("fetch", remote, state.sync?.branch ?? "");
		},
		push(remote: string, branch: string): Promise<void> {
			return controller.sync("push", remote, branch);
		},
		pull(remote: string, branch: string): Promise<void> {
			return controller.sync("pull", remote, branch);
		},
		/* G4b recovery store: the listing is a manual read, restore and drop are one-shot writes with their own grants. */
		async loadRecovery(): Promise<void> {
			if (!active || state.loading || state.mutating || state.recoveryLoading) return;
			const generation = ++recoveryEpoch;
			update({ ...state, recovery: undefined, recoveryErrorCode: undefined, recoveryLoading: true });
			try {
				const result = await api.recoveryList(projectId, repoPath);
				if (!active || generation !== recoveryEpoch) return;
				if (result.ok) update({ ...state, recoveryLoading: false, recovery: { entries: result.entries, truncated: result.truncated } });
				else update({ ...state, recoveryLoading: false, recoveryErrorCode: result.code });
			} catch (error) {
				if (active && generation === recoveryEpoch) update({ ...state, recoveryLoading: false, recoveryErrorCode: errorCode(error) });
			}
		},
		/** Puts the snapshot's bytes back; main and the helper decide whether the target may be written at all. */
		async restoreRecovery(entry: RemoteGitRecoveryEntryView): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !state.snapshot?.restoreToken) return;
			if (!entry || typeof entry.ref !== "string" || !/^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/.test(entry.ref) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.oid)) return;
			const token = state.snapshot.restoreToken;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "restore", recoveryNotice: undefined, errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.recoveryRestore(projectId, entry.ref, entry.oid, entry.path, token, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false, recoveryNotice: { kind: "restored", path: entry.path } });
				await controller.refresh();
				await controller.loadRecovery();
			} catch {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		/** The only action that makes a snapshot disappear; the helper deletes it with a compare-and-swap. */
		async dropRecovery(entry: RemoteGitRecoveryEntryView): Promise<void> {
			if (!active || state.loading || state.mutating || !state.snapshot?.dropToken) return;
			if (!entry || typeof entry.ref !== "string" || !/^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/.test(entry.ref) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.oid)) return;
			const token = state.snapshot.dropToken;
			const generation = ++epoch;
			update({ ...state, mutating: true, mutatingKind: "drop", recoveryNotice: undefined, errorCode: undefined });
			try {
				const result = await api.recoveryDrop(projectId, entry.ref, entry.oid, token, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false, recoveryNotice: { kind: "dropped", path: entry.path } });
				// A dropped snapshot does not change the worktree, but the panel still re-reads the repository: the
				// success update above carries no facts, and the outcome the user needs lives inside that subtree.
				await controller.refresh();
				await controller.loadRecovery();
			} catch {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		/* G3b branch write face: one explicit action per click, an unknown outcome is never replayed, and only a
		confirmed answer re-reads the repository. The name is refused here as well as in main, never adapted. */
		async createBranch(name: string): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !validRemoteGitBranchName(name) || !state.snapshot?.branchToken) return;
			const token = state.snapshot.branchToken;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "branch", errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.createRemoteBranch(projectId, name, token, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false });
				await controller.refresh();
			} catch {
				// A ref write with a lost reply may well have happened: say unknown instead of retrying it.
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		async switchBranch(name: string): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating || !validRemoteGitBranchName(name) || !state.snapshot?.switchToken) return;
			if (state.snapshot.branch === name) return;
			const token = state.snapshot.switchToken;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, mutating: true, mutatingKind: "switch", errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.switchRemoteBranch(projectId, name, token, repoPath);
				if (!active || generation !== epoch) return;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
					return;
				}
				update({ projectKey, loading: false, diffLoading: false });
				await controller.refresh();
			} catch {
				// The checkout may have happened; never replay it, and keep saying the result is unknown.
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
			}
		},
		/**
		 * Explicit repository creation at the project root. It is a write with no token (there is no confirmed
		 * repository state to bind one to), so it gets everything else a write gets: single-flight, a generation
		 * fence that retires a slow answer after a project switch, connection loss or refresh, and a refreshed
		 * snapshot as its only success report. A refusal drops the stale facts; an unknown result - the reply was
		 * lost after the helper may have created .git - keeps the uncertainty warning and is never replayed or
		 * auto-refreshed: only a successful explicit refresh can clear it.
		 */
		async initRepository(): Promise<boolean> {
			if (!active || state.loading || state.diffLoading || state.mutating || state.initializing) return false;
			// Init creates .git at the project root only: a nested scope never offers it.
			if (repoPath !== "") return false;
			// Only a confirmed non-repository offers this action; anything else is a main/helper decision, not a guess.
			if (state.errorCode !== "GIT_NOT_REPOSITORY") return false;
			const generation = ++epoch;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			update({ ...state, initializing: true, mutating: true, mutatingKind: "init", initNotice: undefined, errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.initRemote(projectId);
				if (!active || generation !== epoch) return false;
				if (!result.ok) {
					update({ projectKey, loading: false, diffLoading: false, initializing: false, errorCode: result.code });
					return false;
				}
				update({ projectKey, loading: false, diffLoading: false, initializing: false, initNotice: { branch: result.branch } });
				await controller.refresh();
				return true;
			} catch {
				// The helper may have created .git before the reply was lost: say so and never retry or auto-refresh.
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, initializing: false, errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" });
				return false;
			}
		},
		/** Connection transitions invalidate facts without automatically reconnecting or refreshing. */
		invalidateConnection() {
			if (!active) return;
			epoch += 1;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
			void api.cancelRemoteReads(projectId).catch(() => undefined);
			// Reconnect may emit several failure states; retain uncertainty until a successful explicit refresh.
			const uncertainWrite = state.mutating || state.errorCode === "GIT_WRITE_RESULT_UNCONFIRMED";
			update({ projectKey, loading: false, diffLoading: false, errorCode: uncertainWrite ? "GIT_WRITE_RESULT_UNCONFIRMED" : "REMOTE_CONNECTION_LOST" });
		},
		/** Component/project identity changes invalidate results; they never connect/replay automatically. */
		dispose() {
			active = false;
			void api.cancelRemoteReads(projectId).catch(() => undefined);
			epoch += 1;
			diffEpoch += 1;
			historyEpoch += 1;
			detailEpoch += 1;
			refsEpoch += 1;
			compareEpoch += 1;
			recoveryEpoch += 1;
		},
	};
	return controller;
}
