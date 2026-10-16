/** Test-only budgets fixed before the real run; smoke is never relabeled as an hour. */
export type SoakProcess = { pid: number; startTicks: string; fdCount: number; rssKiB: number };
export type SoakHelper = SoakProcess & { rootIndex: number; entryHash?: string };
export type SoakLocal = { main: SoakProcess; renderer: SoakProcess; ssh: SoakProcess[]; descendantCount: number; mainHeapBytes: number; rendererHeapBytes: number; mainFdKinds: Record<string, number> };
export type SoakSample = { elapsedMs: number; local: SoakLocal; helpers: SoakHelper[]; label?: string };

/**
 * A long run is judged twice: against the start (loose, absorbs the one-time warmup step) and against the
 * settled state after this much soak time (tight, the only comparison that can expose a continuing leak).
 */
export const SOAK_SETTLED_MS = 300_000;

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

/**
 * Steady-state budgets, calibrated on the 2026-10-15 hour run before this gate existed: over its last 55 minutes
 * main FD moved 251→253, main RSS 547→550MiB, renderer RSS 290→305MiB, main JS heap ±1MiB, descendants constant,
 * SSH FD constant 7 and helper FD constant 21. Each budget is several times that observed noise and roughly a
 * twentieth of what a one-FD-or-1MiB-per-cycle leak would reach in an hour, so a continuing leak cannot hide.
 *
 * Measured against the settled sample only: the one-time warmup step is real but is not a leak, and lumping it in
 * is what made the earlier start-to-end comparison unreadable. Helper rotation by project scope stays legal.
 */
export function soakSteadyViolations(settled: SoakSample, current: SoakSample): string[] {
	const failures: string[] = [],
		processKeys: Array<"main" | "renderer"> = ["main", "renderer"];
	for (const key of processKeys) {
		const original = settled.local[key],
			value = current.local[key];
		if (original.pid !== value.pid || original.startTicks !== value.startTicks) failures.push(key + ".identity");
		if (value.fdCount > original.fdCount + 4) failures.push(key + ".fd");
		if (value.rssKiB > original.rssKiB + (key === "main" ? 32 : 48) * 1024) failures.push(key + ".rss");
	}
	if (current.local.mainHeapBytes > settled.local.mainHeapBytes + 24 * 1024 * 1024) failures.push("main.heap");
	if (current.local.rendererHeapBytes > settled.local.rendererHeapBytes + 48 * 1024 * 1024) failures.push("renderer.heap");
	if (current.local.descendantCount > settled.local.descendantCount + 1) failures.push("descendants");
	if (current.local.ssh.length !== 1) failures.push("ssh.count");
	for (const ssh of current.local.ssh) if (ssh.fdCount > 16) failures.push("ssh.fd");
	if (current.helpers.length !== 1) failures.push("helper.count");
	for (const helper of current.helpers) if (helper.fdCount > 32) failures.push("helper.fd");
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
