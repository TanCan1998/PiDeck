import type { GitIndexMutationResult, GitReadSnapshot, GitReadSnapshotResult, GitResourceGroupType, GitWorkspaceFileDiff } from "../../../shared/types/git";
import type { ProjectFileTarget } from "../../../shared/types/project";

export type RemoteGitViewState = {
	projectKey: string;
	loading: boolean;
	snapshot?: GitReadSnapshot;
	errorCode?: string;
	mutating?: boolean;
	diffLoading: boolean;
	diff?: GitWorkspaceFileDiff;
	diffGroup?: GitResourceGroupType;
	diffErrorCode?: string;
};
export type RemoteGitViewApi = {
	cancelRemoteReads(projectId: string): Promise<void>;
	mutateRemoteIndex(projectId: string, operation: "stage" | "unstage", group: GitResourceGroupType, target: ProjectFileTarget, token: string): Promise<GitIndexMutationResult>;
	remoteSnapshot(projectId: string): Promise<GitReadSnapshotResult>;
	workspaceFileDiff(projectId: string, group: GitResourceGroupType, target: ProjectFileTarget): Promise<GitWorkspaceFileDiff | null>;
};

function errorCode(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	// Electron invoke prefixes errors with the channel; only the bounded code becomes visible text.
	return /\b(?:GIT_[A-Z_]+|SSH_[A-Z_]+|REMOTE_FEATURE_DISABLED|UNSUPPORTED_CAPABILITY|RESULT_TOO_LARGE|REQUEST_TIMEOUT|REQUEST_CANCELLED|REMOTE_CONNECTION_LOST|PERMISSION_DENIED|PATH_[A-Z_]+|NOT_A_FILE|TOO_MANY_REQUESTS)\b/.exec(raw)?.[0] ?? "GIT_COMMAND_FAILED";
}
/** Single-owner controller: explicit, one-shot index actions; no commit, polling or automatic write replay. */
export function createRemoteGitViewController(projectId: string, projectKey: string, api: RemoteGitViewApi, publish: (state: RemoteGitViewState) => void) {
	let active = true;
	let epoch = 0;
	let diffEpoch = 0;
	let state: RemoteGitViewState = { projectKey, loading: false, diffLoading: false };
	function update(next: RemoteGitViewState) {
		state = next;
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
			update({ ...state, mutating: true, errorCode: undefined, diff: undefined, diffErrorCode: undefined });
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
