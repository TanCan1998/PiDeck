import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteProject } from "../../../shared/types/project";
import { desktopApi } from "../desktopApi";
import { createRemoteGitViewController, type RemoteGitViewState } from "../utils/remoteGitViewState";

/**
 * The read-only panel owns this state; neither currentSession atoms nor native Git polling are subscribed. `repoPath`
 * is the selected repository scope ("" is the project root): it is part of the identity key, so switching scope
 * disposes the old controller and resets the view instead of mixing two repositories' facts in one panel.
 */
export function useRemoteGitView(project: RemoteProject, repoPath = "") {
	const projectKey = JSON.stringify([project.id, project.locator.hostId, project.locator.remotePath, repoPath]);
	const [state, setState] = useState<RemoteGitViewState>({ projectKey, loading: true, diffLoading: false });
	// Polling is bounded by the host's observed state, not by guessing from a failed read: the optimistic initial
	// value only covers the window before the first host event (the panel's own first read reports any failure).
	const [hostReady, setHostReady] = useState(true);
	const controller = useRef<ReturnType<typeof createRemoteGitViewController> | null>(null);
	useEffect(() => {
		const reads = createRemoteGitViewController(project.id, projectKey, desktopApi.git, setState, repoPath);
		controller.current = reads;
		// The sync facts belong to the project identity, not to a snapshot generation: they are read once after the
		// first repository read, and afterwards only when the user acts (refresh or a sync verb). No effect watches
		// the snapshot, so a refresh can never trigger a second, self-feeding load that moves the rows under the user.
		void reads.refresh().then(() => reads.loadSync());
		const unsubscribe = desktopApi.remoteHosts.onStateChange((change) => {
			if (change.hostId !== project.locator.hostId) return;
			// Only "ready" resumes polling; every other observed transition pauses it until the host is ready again.
			setHostReady(change.state === "ready");
			if (["disconnected", "offline", "degraded", "needs-attention", "reconnecting"].includes(change.state)) reads.invalidateConnection();
		});
		void reads.refresh();
		return () => {
			unsubscribe();
			reads.dispose();
			if (controller.current === reads) controller.current = null;
		};
	}, [project.id, project.locator.hostId, projectKey, repoPath]);
	const loadHistory = useCallback(() => {
		void controller.current?.loadHistory();
	}, []);
	const loadMoreHistory = useCallback(() => {
		void controller.current?.loadMoreHistory();
	}, []);
	const openCommitDetail = useCallback((oid: string) => {
		void controller.current?.openCommitDetail(oid);
	}, []);
	const loadRefs = useCallback(() => {
		void controller.current?.loadRefs();
	}, []);
	const loadRecovery = useCallback(() => {
		void controller.current?.loadRecovery();
	}, []);
	const restoreRecovery = useCallback((entry: Parameters<NonNullable<typeof controller.current>["restoreRecovery"]>[0]) => {
		void controller.current?.restoreRecovery(entry);
	}, []);
	const dropRecovery = useCallback((entry: Parameters<NonNullable<typeof controller.current>["dropRecovery"]>[0]) => {
		void controller.current?.dropRecovery(entry);
	}, []);
	const loadSync = useCallback(() => {
		void controller.current?.loadSync();
	}, []);
	const runCompare = useCallback((base: string, head: string) => {
		void controller.current?.runCompare(base, head);
	}, []);
	const pollRefs = useCallback((): Promise<void> => controller.current?.pollRefs() ?? Promise.resolve(), []);
	const stopRefsPolling = useCallback(() => {
		controller.current?.stopRefsPolling();
	}, []);
	const fetchRemote = useCallback((remote: string) => {
		void controller.current?.fetch(remote);
	}, []);
	const pushRemote = useCallback((remote: string, branch: string) => {
		void controller.current?.push(remote, branch);
	}, []);
	const pullRemote = useCallback((remote: string, branch: string) => {
		void controller.current?.pull(remote, branch);
	}, []);
	const discard = useCallback((group: "workingTree" | "untracked", target: Parameters<NonNullable<typeof controller.current>["discard"]>[1]) => {
		void controller.current?.discard(group, target);
	}, []);
	const createBranch = useCallback((name: string) => {
		void controller.current?.createBranch(name);
	}, []);
	const initRepository = useCallback((): Promise<boolean> => controller.current?.initRepository() ?? Promise.resolve(false), []);
	const switchBranch = useCallback((name: string) => {
		void controller.current?.switchBranch(name);
	}, []);
	const openHistoryFileDiff = useCallback((base: string | null, head: string, target: Parameters<NonNullable<typeof controller.current>["openHistoryFileDiff"]>[2]) => {
		void controller.current?.openHistoryFileDiff(base, head, target);
	}, []);
	return {
		state: state.projectKey === projectKey ? state : { projectKey, loading: true, diffLoading: false },
		// Returning the promise lets an explicit refresh gesture sequence the sync-facts read after the snapshot
		// read; the snapshot update replaces the whole state and would wipe facts read concurrently.
		refresh: (): Promise<void> => controller.current?.refresh() ?? Promise.resolve(),
		openDiff: (group: Parameters<NonNullable<typeof controller.current>["openDiff"]>[0], target: Parameters<NonNullable<typeof controller.current>["openDiff"]>[1]) => {
			void controller.current?.openDiff(group, target);
		},
		mutate: (operation: "stage" | "unstage", group: Parameters<NonNullable<typeof controller.current>["mutate"]>[1], target: Parameters<NonNullable<typeof controller.current>["mutate"]>[2]) => {
			void controller.current?.mutate(operation, group, target);
		},
		commit: (message: string) => {
			void controller.current?.commit(message);
		},
		closeDiff: () => controller.current?.closeDiff(),
		loadHistory,
		loadMoreHistory,
		openCommitDetail,
		loadRefs,
		openHistoryFileDiff,
		createBranch,
		initRepository,
		switchBranch,
		discard,
		loadRecovery,
		restoreRecovery,
		dropRecovery,
		loadSync,
		runCompare,
		pollRefs,
		stopRefsPolling,
		hostReady,
		fetchRemote,
		pushRemote,
		pullRemote,
	};
}
