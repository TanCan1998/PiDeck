import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteProject } from "../../../shared/types/project";
import { desktopApi } from "../desktopApi";
import { createRemoteGitViewController, type RemoteGitViewState } from "../utils/remoteGitViewState";

/** The read-only panel owns this state; neither currentSession atoms nor native Git polling are subscribed. */
export function useRemoteGitView(project: RemoteProject) {
	const projectKey = JSON.stringify([project.id, project.locator.hostId, project.locator.remotePath]);
	const [state, setState] = useState<RemoteGitViewState>({ projectKey, loading: true, diffLoading: false });
	const controller = useRef<ReturnType<typeof createRemoteGitViewController> | null>(null);
	useEffect(() => {
		const reads = createRemoteGitViewController(project.id, projectKey, desktopApi.git, setState);
		controller.current = reads;
		const unsubscribe = desktopApi.remoteHosts.onStateChange((change) => {
			if (change.hostId === project.locator.hostId && ["disconnected", "offline", "degraded", "needs-attention", "reconnecting"].includes(change.state)) reads.invalidateConnection();
		});
		void reads.refresh();
		return () => {
			unsubscribe();
			reads.dispose();
			if (controller.current === reads) controller.current = null;
		};
	}, [project.id, project.locator.hostId, projectKey]);
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
	const openHistoryFileDiff = useCallback((base: string | null, head: string, target: Parameters<NonNullable<typeof controller.current>["openHistoryFileDiff"]>[2]) => {
		void controller.current?.openHistoryFileDiff(base, head, target);
	}, []);
	return {
		state: state.projectKey === projectKey ? state : { projectKey, loading: true, diffLoading: false },
		refresh: () => {
			void controller.current?.refresh();
		},
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
	};
}
