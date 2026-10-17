import { useEffect, useRef, useState } from "react";
import { REMOTE_GIT_REFS_POLL_INTERVAL_MS, startRemoteGitRefsPolling } from "../utils/remoteGitRefsPolling";

/** True while the document is visible; a hidden window must not poll. */
export function useDocumentPageVisible(): boolean {
	const [visible, setVisible] = useState(() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));
	useEffect(() => {
		if (typeof document === "undefined") return;
		const onChange = () => setVisible(document.visibilityState === "visible");
		document.addEventListener("visibilitychange", onChange);
		return () => document.removeEventListener("visibilitychange", onChange);
	}, []);
	return visible;
}

export type RemoteGitRefsPollingInput = {
	/** The refs section is expanded by the user. */
	active: boolean;
	/** Facts for the current generation already exist: the first load stays a manual action. */
	refsLoaded: boolean;
	/** The host was not observed leaving ready (optimistic until the first host event). */
	hostReady: boolean;
	/** Controller quiet read; it owns single-flight and generation fencing. */
	poll: () => Promise<void> | void;
	/** Retire an in-flight poll when the interval stops (collapse/hide/project switch/unmount). */
	stop: () => void;
};

/**
 * Bounded refs polling: one interval, re-created only when a gate changes. Collapsing the section, hiding the
 * window, switching project (the panel is keyed by project identity), losing the host or unmounting all clear
 * it. Nothing here touches sync facts: the poll reads refs only.
 */
export function useRemoteGitRefsPolling(input: RemoteGitRefsPollingInput): void {
	const pageVisible = useDocumentPageVisible();
	const pollRef = useRef(input.poll);
	pollRef.current = input.poll;
	const stopRef = useRef(input.stop);
	stopRef.current = input.stop;
	const { active, refsLoaded, hostReady } = input;
	useEffect(() => {
		if (!active || !pageVisible || !hostReady || !refsLoaded) {
			// Retire a poll that was in flight when a gate closed; its answer must not publish later.
			stopRef.current();
			return;
		}
		const stopPolling = startRemoteGitRefsPolling({
			intervalMs: REMOTE_GIT_REFS_POLL_INTERVAL_MS,
			isEnabled: () => true,
			poll: () => pollRef.current(),
			timer: {
				set: (callback, intervalMs) => window.setInterval(callback, intervalMs),
				clear: (handle) => window.clearInterval(handle),
			},
		});
		return () => {
			stopPolling();
			stopRef.current();
		};
	}, [active, pageVisible, hostReady, refsLoaded]);
}
