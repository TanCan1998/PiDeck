/**
 * Bounded refs polling (G5b): a renderer-only policy, not a new helper operation. Every tick re-reads the
 * existing `git.refs` read; there is no fetch, no event stream and no background worker. The poll only runs
 * while the refs area is expanded, the document is visible, the project's host is ready and refs facts for the
 * current generation already exist; when any gate closes the interval is cleared. Late answers are fenced by
 * the controller's own generation checks, so a stopped poll can never publish.
 */

/** Fixed cadence: 15s is frequent enough to notice a ref moved by an Agent, slow enough to stay bounded. */
export const REMOTE_GIT_REFS_POLL_INTERVAL_MS = 15_000;

/** Injectable timer boundary so the gating and single-flight rules are testable without fake DOM timers. */
export type RemoteGitRefsPollingTimer = {
	set(callback: () => void, intervalMs: number): number;
	clear(handle: number): void;
};

export type RemoteGitRefsPollingOptions = {
	intervalMs: number;
	/** Re-checked on every tick, so a gate that closes between effect runs cannot start a read. */
	isEnabled: () => boolean;
	/** The controller's quiet read; it owns the actual single-flight and generation fencing. */
	poll: () => Promise<void> | void;
	timer: RemoteGitRefsPollingTimer;
};

/**
 * Start one gated interval. Ticks are skipped while a previous poll is still unsettled (single flight) or while
 * a gate is closed, and the returned stop clears the interval so no later tick can start. A rejected poll is the
 * controller's to report; it must not become an unhandled rejection here.
 */
export function startRemoteGitRefsPolling(options: RemoteGitRefsPollingOptions): () => void {
	let stopped = false;
	let inFlight = false;
	const handle = options.timer.set(
		() => {
			if (stopped || inFlight || !options.isEnabled()) return;
			inFlight = true;
			Promise.resolve(options.poll())
				.catch(() => undefined)
				.finally(() => {
					inFlight = false;
				});
		},
		Math.max(1, Math.floor(options.intervalMs)),
	);
	return () => {
		stopped = true;
		options.timer.clear(handle);
	};
}
