import type { GitReadSnapshot, GitReadSnapshotResult, GitResourceGroupType, GitWorkspaceFileDiff } from "../../../shared/types/git";
import type { ProjectFileTarget } from "../../../shared/types/project";

export type RemoteGitViewState = {
	projectKey: string;
	loading: boolean;
	snapshot?: GitReadSnapshot;
	errorCode?: string;
	diffLoading: boolean;
	diff?: GitWorkspaceFileDiff;
	diffGroup?: GitResourceGroupType;
	diffErrorCode?: string;
};
export type RemoteGitViewApi = {
	cancelRemoteReads(projectId: string): Promise<void>;
	remoteSnapshot(projectId: string): Promise<GitReadSnapshotResult>;
	workspaceFileDiff(projectId: string, group: GitResourceGroupType, target: ProjectFileTarget): Promise<GitWorkspaceFileDiff | null>;
};

function errorCode(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	// Electron invoke prefixes errors with the channel; only the bounded code becomes visible text.
	return /\b(?:GIT_[A-Z_]+|SSH_[A-Z_]+|REMOTE_FEATURE_DISABLED|UNSUPPORTED_CAPABILITY|RESULT_TOO_LARGE|REQUEST_TIMEOUT|REQUEST_CANCELLED|REMOTE_CONNECTION_LOST|PERMISSION_DENIED|PATH_[A-Z_]+|NOT_A_FILE|TOO_MANY_REQUESTS)\b/.exec(raw)?.[0] ?? "GIT_COMMAND_FAILED";
}
/** Single-owner read controller: one refresh/diff in flight, no polling/write API, and identity-scoped late results. */
export function createRemoteGitViewController(projectId: string, projectKey: string, api: RemoteGitViewApi, publish: (state: RemoteGitViewState) => void) {
	let active = true;
	let epoch = 0;
	let diffEpoch = 0;
	let state: RemoteGitViewState = { projectKey, loading: false, diffLoading: false };
	function update(next: RemoteGitViewState) {
		state = next;
		if (active) publish(state);
	}
	return {
		async refresh() {
			if (!active || state.loading || state.diffLoading) return;
			const generation = ++epoch;
			diffEpoch += 1;
			// Clear previous facts during refresh; a failed read must not display a stale clean repository.
			update({ projectKey, loading: true, diffLoading: false });
			try {
				const result = await api.remoteSnapshot(projectId);
				if (!active || generation !== epoch) return;
				if (result.ok) update({ projectKey, loading: false, diffLoading: false, snapshot: result.snapshot });
				else update({ projectKey, loading: false, diffLoading: false, errorCode: result.code });
			} catch (error) {
				if (active && generation === epoch) update({ projectKey, loading: false, diffLoading: false, errorCode: errorCode(error) });
			}
		},
		async openDiff(group: GitResourceGroupType, target: ProjectFileTarget) {
			if (!active || state.loading || state.diffLoading || !state.snapshot || target.projectId !== projectId) return;
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
			if (!active || state.diffLoading) return;
			diffEpoch += 1;
			update({ ...state, diff: undefined, diffGroup: undefined, diffLoading: false, diffErrorCode: undefined });
		},
		/** Connection transitions invalidate facts without automatically reconnecting or refreshing. */
		invalidateConnection() {
			if (!active) return;
			epoch += 1;
			diffEpoch += 1;
			void api.cancelRemoteReads(projectId).catch(() => undefined);
			update({ projectKey, loading: false, diffLoading: false, errorCode: "REMOTE_CONNECTION_LOST" });
		},
		/** Component/project identity changes invalidate results; they never connect/replay automatically. */
		dispose() {
			active = false;
			if (state.loading || state.diffLoading) void api.cancelRemoteReads(projectId).catch(() => undefined);
			epoch += 1;
			diffEpoch += 1;
		},
	};
}
