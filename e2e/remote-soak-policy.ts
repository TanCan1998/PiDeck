/** Test-only budgets fixed before the real run; smoke is never relabeled as an hour. */
export type SoakProcess = { pid: number; startTicks: string; fdCount: number; rssKiB: number };
export type SoakHelper = SoakProcess & { rootIndex: number; entryHash?: string };
export type SoakLocal = { main: SoakProcess; renderer: SoakProcess; ssh: SoakProcess[]; descendantCount: number; mainHeapBytes: number; rendererHeapBytes: number };
export type SoakSample = { elapsedMs: number; local: SoakLocal; helpers: SoakHelper[] };

export function readRemoteGitSoakMode(env: Record<string, string | undefined>): { name: "hour" | "smoke"; durationMs: number } | undefined {
	const value = env.PIDECK_E2E_REMOTE_GIT_SOAK;
	if (value === undefined) return undefined;
	if (value === "hour") return { name: value, durationMs: 3_600_000 };
	if (value === "smoke") return { name: value, durationMs: 180_000 };
	throw new Error("REMOTE_SOAK_MODE_INVALID");
}

/** Bounds are deliberately modest but not a proof of leak freedom or an acceptable per-hour leak rate. */
export function soakGrowthViolations(baseline: SoakSample, current: SoakSample): string[] {
	const failures: string[] = [];
	const processKeys: Array<"main" | "renderer"> = ["main", "renderer"];
	for (const key of processKeys) {
		const original = baseline.local[key],
			value = current.local[key];
		if (original.pid !== value.pid || original.startTicks !== value.startTicks) failures.push(key + ".identity");
		if (value.fdCount > original.fdCount + 16) failures.push(key + ".fd");
		if (value.rssKiB > original.rssKiB + (key === "main" ? 64 : 128) * 1024) failures.push(key + ".rss");
	}
	if (current.local.mainHeapBytes > baseline.local.mainHeapBytes + 32 * 1024 * 1024) failures.push("main.heap");
	if (current.local.rendererHeapBytes > baseline.local.rendererHeapBytes + 64 * 1024 * 1024) failures.push("renderer.heap");
	if (current.local.descendantCount > baseline.local.descendantCount + 2) failures.push("descendants");
	if (current.local.ssh.length !== 1) failures.push("ssh.count");
	if (current.helpers.length !== 1) failures.push("helper.count");
	const originalHelper = baseline.helpers[0];
	for (const helper of current.helpers) {
		if (helper.fdCount > originalHelper.fdCount + 4) failures.push("helper.fd");
		if (helper.rssKiB > originalHelper.rssKiB + 32 * 1024) failures.push("helper.rss");
	}
	for (const ssh of current.local.ssh) if (ssh.fdCount > (baseline.local.ssh[0]?.fdCount ?? 0) + 4) failures.push("ssh.fd");
	return failures;
}

/** PID plus Linux start ticks fences reuse; replacing a helper resets its observed lifetime. */
export function longestHelperLifetimeMs(samples: readonly SoakSample[]): number {
	const firstSeen = new Map<string, number>();
	let longest = 0;
	for (const sample of samples)
		for (const helper of sample.helpers) {
			const key = `${helper.pid}:${helper.startTicks}`;
			const start = firstSeen.get(key) ?? sample.elapsedMs;
			firstSeen.set(key, start);
			longest = Math.max(longest, sample.elapsedMs - start);
		}
	return longest;
}
