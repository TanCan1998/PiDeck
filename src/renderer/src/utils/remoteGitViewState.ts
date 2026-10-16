import type { GitCommitResult, GitIndexMutationResult, GitReadSnapshot, GitReadSnapshotResult, GitResourceGroupType, GitWorkspaceFileDiff } from "../../../shared/types/git";
import type { ProjectFileTarget } from "../../../shared/types/project";

export type RemoteGitViewState = {
	projectKey: string;
	loading: boolean;
	snapshot?: GitReadSnapshot;
	errorCode?: string;
	mutating?: boolean;
	/** Which action is in flight; the panel says “writing the index” or “committing” accordingly. */
	mutatingKind?: "index" | "commit";
	/** Counts confirmed commits, so the panel can clear its message box exactly once per success. */
	confirmedCommits?: number;
	diffLoading: boolean;
	diff?: GitWorkspaceFileDiff;
	diffGroup?: GitResourceGroupType;
	diffErrorCode?: string;
};
export type RemoteGitViewApi = {
	cancelRemoteReads(projectId: string): Promise<void>;
	commitRemote(projectId: string, message: string, token: string): Promise<GitCommitResult>;
	mutateRemoteIndex(projectId: string, operation: "stage" | "unstage", group: GitResourceGroupType, target: ProjectFileTarget, token: string): Promise<GitIndexMutationResult>;
	remoteSnapshot(projectId: string): Promise<GitReadSnapshotResult>;
	workspaceFileDiff(projectId: string, group: GitResourceGroupType, target: ProjectFileTarget): Promise<GitWorkspaceFileDiff | null>;
};

function errorCode(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	// Electron invoke prefixes errors with the channel; only the bounded code becomes visible text.
	return /\b(?:GIT_[A-Z_]+|SSH_[A-Z_]+|REMOTE_FEATURE_DISABLED|UNSUPPORTED_CAPABILITY|RESULT_TOO_LARGE|REQUEST_TIMEOUT|REQUEST_CANCELLED|REMOTE_CONNECTION_LOST|PERMISSION_DENIED|PATH_[A-Z_]+|NOT_A_FILE|TOO_MANY_REQUESTS)\b/.exec(raw)?.[0] ?? "GIT_COMMAND_FAILED";
}
/** Single-owner controller: explicit, one-shot index actions and one commit per confirmed snapshot; no polling or replay. */
export function createRemoteGitViewController(projectId: string, projectKey: string, api: RemoteGitViewApi, publish: (state: RemoteGitViewState) => void) {
	let active = true;
	let epoch = 0;
	let diffEpoch = 0;
	let state: RemoteGitViewState = { projectKey, loading: false, diffLoading: false };
	function update(next: RemoteGitViewState) {
		// The confirmed-commit counter is sticky: a later read (or a connection loss) must not resurrect the
		// message box the user already cleared.
		const sticky = state.confirmedCommits;
		state = sticky === undefined || next.confirmedCommits !== undefined ? next : { ...next, confirmedCommits: sticky };
		if (active) publish(state);
	}
	const controller = {
		async refresh(): Promise<void> {
			if (!active || state.loading || state.diffLoading || state.mutating) return;
			const generation = ++epoch;
			diffEpoch += 1;
			// Clear previous facts during refresh; a failed read must not display a stale clean repository.
			const uncertainWrite = state.errorCode === "GIT_WRITE_RESULT_UNCONFIRMED";
			const failureCode = (code: string) => (uncertainWrite ? "GIT_WRITE_RESULT_UNCONFIRMED" : code);
			// A failed refresh cannot resolve an uncertain write; only fresh repository facts can.
			update({ projectKey, loading: true, diffLoading: false, ...(uncertainWrite ? { errorCode: "GIT_WRITE_RESULT_UNCONFIRMED" } : {}) });
			try {
				const result = await api.remoteSnapshot(projectId);
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
			update({ ...state, mutating: true, mutatingKind: "index", errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.mutateRemoteIndex(projectId, operation, group, target, token);
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
			update({ ...state, mutating: true, mutatingKind: "commit", errorCode: undefined, diff: undefined, diffErrorCode: undefined });
			try {
				const result = await api.commitRemote(projectId, message, token);
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
			update({ ...state, diff: undefined, diffGroup: group, diffErrorCode: undefined, diffLoading: true });
			try {
				const diff = await api.workspaceFileDiff(projectId, group, target);
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
			update({ ...state, diff: undefined, diffGroup: undefined, diffLoading: false, diffErrorCode: undefined });
		},
		/** Connection transitions invalidate facts without automatically reconnecting or refreshing. */
		invalidateConnection() {
			if (!active) return;
			epoch += 1;
			diffEpoch += 1;
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
		},
	};
	return controller;
}
