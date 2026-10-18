import { expect, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { appendFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { SOAK_PROBE_TIMEOUT_MS } from "./remote-soak-evidence";
import { REMOTE_HELPER_ENTRY_SHA256 } from "../src/main/remote/RemoteHelperEntry";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";
import { interruptSoakConnection, ownedSoakSsh, quoteSoakArgument, readSoakDescendants, readSoakProcess, sampleSoakLocal, sampleSoakRemote, soakGitOracle, soakIndexIdentity, soakProbe } from "./remote-soak-evidence";
import { longestHelperLifetimeMs, SOAK_SETTLED_MS, soakGrowthViolations, soakSteadyViolations, type SoakProcess, type SoakSample } from "./remote-soak-policy";

const STEP_MS = 40_000,
	CYCLE_INTERVAL_MS = 30_000,
	ROOT_DWELL_MS = 300_000;
/** Cycles that additionally sample each UI step, so a one-time step can be attributed instead of guessed. */
const DETAIL_CYCLES = 8;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One app, real UI/pinned SSH, run-owned repositories; no fake IPC replies, model calls or network settings. */
export async function verifyRemoteGitSoak(input: { window: Page; app: ElectronApplication; credentials: RemoteAcceptanceCredentials; roots: [string, string]; userDataRoot: string; mode: { name: "hour" | "smoke"; durationMs: number }; testInfo: TestInfo }): Promise<void> {
	const { window, app, credentials, roots, userDataRoot, mode, testInfo } = input;
	const panel = window.getByTestId("remote-git-panel"),
		profile = join(userDataRoot, "profile"),
		visited = new Set<string>();
	const samples: SoakSample[] = [],
		localPids = new Map<string, SoakProcess>();
	const journal = testInfo.outputPath("remote-git-soak-samples.jsonl"),
		reportPath = testInfo.outputPath("remote-git-soak-report.json");
	const report: Record<string, unknown> = { mode: mode.name, requestedMs: mode.durationMs, intervalMs: CYCLE_INTERVAL_MS, phase: "warmup", cycles: 0, samples: journal };
	/** Process deltas between two samples; the readable form of the resource curves kept in the journal. */
	const delta = (from: SoakSample, to: SoakSample) => ({
		mainFd: to.local.main.fdCount - from.local.main.fdCount,
		mainRssMiB: Math.round((to.local.main.rssKiB - from.local.main.rssKiB) / 1024),
		rendererFd: to.local.renderer.fdCount - from.local.renderer.fdCount,
		rendererRssMiB: Math.round((to.local.renderer.rssKiB - from.local.renderer.rssKiB) / 1024),
		mainHeapMiB: Number(((to.local.mainHeapBytes - from.local.mainHeapBytes) / 1048576).toFixed(1)),
		rendererHeapMiB: Number(((to.local.rendererHeapBytes - from.local.rendererHeapBytes) / 1048576).toFixed(1)),
		descendants: to.local.descendantCount - from.local.descendantCount,
	});
	let settled: SoakSample | undefined,
		started = 0;
	const row = (group: string) =>
		panel
			.getByTestId("remote-git-" + group)
			.locator(".git-resource-row")
			.filter({ has: window.locator(".git-resource-name", { hasText: /^tracked\.txt$/ }) });
	const waitIdle = async () => {
		await expect(panel.getByRole("status")).toHaveCount(0, { timeout: STEP_MS });
		await expect(panel.getByRole("alert")).toHaveCount(0);
	};
	const select = async (root: string) => {
		const project = remoteProjectRow(window, root.split("/").pop() ?? "");
		await project.locator(".conversation-title").first().click();
		if (!visited.has(root)) {
			await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
			await window.getByTestId("drawer-rail-git").click();
		}
		await expect(panel).toHaveAttribute("data-project-id", (await project.getAttribute("data-sidebar-removal-id")) ?? "", { timeout: STEP_MS });
		if (!visited.has(root)) {
			await expect(panel.getByRole("alert")).toContainText("尚未明确授权", { timeout: STEP_MS });
			report.phase = "authorize-root-" + roots.indexOf(root);
			await panel.getByRole("button", { name: "信任此项目及其 .pi 资源", exact: true }).click();
			await expect(panel.getByRole("alert")).toHaveCount(0, { timeout: STEP_MS });
			visited.add(root);
		}
		await expect(row("workingTree")).toBeVisible({ timeout: STEP_MS });
		await waitIdle();
	};
	const refresh = async () => {
		await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
		await expect(row("workingTree")).toBeVisible({ timeout: STEP_MS });
		await waitIdle();
	};
	const action = async (group: string, name: "暂存" | "取消暂存") => {
		await row(group).hover();
		await row(group).getByRole("button", { name, exact: true }).click();
	};
	const diff = async (label: string) => {
		await row("index")
			.getByRole("button", { name: /Git 差异/ })
			.click();
		await expect(panel.getByTestId("remote-git-diff")).toBeVisible({ timeout: STEP_MS });
		const text = () =>
			panel.getByTestId("remote-git-diff").evaluate((element) => {
				const read = (node: Node): string =>
					Array.from(node.childNodes)
						.map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? "") : read(child) + (child instanceof Element && child.shadowRoot ? read(child.shadowRoot) : "")))
						.join(" ");
				return read(element);
			});
		await expect.poll(text, { timeout: STEP_MS }).toContain(label + "_BASE");
		await expect.poll(text, { timeout: STEP_MS }).toContain(label + "_WORK");
		await panel.getByRole("button", { name: "返回远端变更列表", exact: true }).click();
	};
	const cycle = async (rootIndex: number, detail: boolean) => {
		// Sampled before the first UI action of the cycle: it separates what the previous cycle's oracle and idle
		// wait did from what this cycle's refresh does, which is how a one-time step gets attributed.
		if (detail) await sample(Math.round(performance.now() - started), "idle");
		await refresh();
		if (detail) await sample(Math.round(performance.now() - started), "refresh");
		await action("workingTree", "暂存");
		await expect(row("index")).toBeVisible({ timeout: STEP_MS });
		await waitIdle();
		if (detail) await sample(Math.round(performance.now() - started), "stage");
		await expect(row("workingTree")).toHaveCount(0);
		await diff(rootIndex === 0 ? "ONE" : "TWO");
		if (detail) await sample(Math.round(performance.now() - started), "diff");
		await action("index", "取消暂存");
		await expect(row("workingTree")).toBeVisible({ timeout: STEP_MS });
		await waitIdle();
		await expect(row("index")).toHaveCount(0);
		if (detail) await sample(Math.round(performance.now() - started), "unstage");
	};
	const rememberChildren = () => {
		const pid = app.process().pid;
		if (pid && app.process().exitCode === null) for (const fact of readSoakDescendants(pid)) localPids.set(`${fact.pid}:${fact.startTicks}`, fact);
	};
	const sample = async (elapsedMs: number, label?: string) => {
		const entry: SoakSample = { elapsedMs, ...(label === undefined ? {} : { label }), local: await sampleSoakLocal(app, window, profile, roots), helpers: await sampleSoakRemote(credentials, roots) };
		samples.push(entry);
		rememberChildren();
		appendFileSync(journal, JSON.stringify(entry) + "\n");
		writeFileSync(reportPath, JSON.stringify(report, null, 2));
		expect(entry.helpers).toHaveLength(1);
		expect(entry.helpers[0].entryHash).toBe(REMOTE_HELPER_ENTRY_SHA256);
		if (samples.length > 1) expect(soakGrowthViolations(samples[0], entry), "fixed-before-run absolute budgets").toEqual([]);
		// The settled window is the leak gate for a long run; a continuing leak fails at its first offending sample.
		if (mode.name === "hour" && settled !== undefined && entry !== settled) expect(soakSteadyViolations(settled, entry), "steady-state budgets after " + SOAK_SETTLED_MS + "ms").toEqual([]);
		if (mode.name === "hour" && settled === undefined && elapsedMs >= SOAK_SETTLED_MS) {
			settled = entry;
			report.settledAtMs = elapsedMs;
			report.warmupDelta = delta(samples[0], entry);
			console.log(`[remote-git-soak] settled warmupDelta=${JSON.stringify(report.warmupDelta)}`);
		}
		if (label !== undefined) {
			const kinds = Object.entries(entry.local.mainFdKinds)
				.slice(0, 4)
				.map(([kind, count]) => kind + ":" + count)
				.join(",");
			console.log(`[remote-git-soak] detail=${label} mainFd=${entry.local.main.fdCount} mainRssMiB=${Math.round(entry.local.main.rssKiB / 1024)} rendererRssMiB=${Math.round(entry.local.renderer.rssKiB / 1024)} descendants=${entry.local.descendantCount} fdKinds=${kinds}`);
		}
	};
	const connectionModal = async () => {
		await window.getByRole("button", { name: /^设置/ }).click();
		const modal = window.locator(".settings-modal");
		await modal.getByRole("tab", { name: "连接", exact: true }).click();
		return modal;
	};
	let activeRoot = 0;
	try {
		// Normalize only the run-owned fixture's selected path before taking the semantic baseline.
		for (const root of roots) await soakProbe("fixture-normalize", () => runRemoteCommand(credentials, "set -eu; cd " + quoteSoakArgument(root) + "; git reset -q HEAD -- tracked.txt", SOAK_PROBE_TIMEOUT_MS));
		const before = await Promise.all(roots.map((root) => soakGitOracle(credentials, root)));
		for (const index of [0, 1, 0]) {
			await select(roots[index]);
			await cycle(index, false);
		}
		const startedAt = performance.now();
		report.phase = "soak";
		started = startedAt;
		await sample(0);
		let cycles = 0;
		while (performance.now() - started < mode.durationMs) {
			const elapsed = performance.now() - started,
				rootIndex = Math.floor(elapsed / ROOT_DWELL_MS) % 2,
				detail = cycles < DETAIL_CYCLES;
			if (activeRoot !== rootIndex) {
				await select(roots[rootIndex]);
				activeRoot = rootIndex;
			}
			if (cycles % 5 === 4) {
				// Sampled either side of the toggle: otherwise the one-time step cannot be separated from the idle wait.
				if (detail) await sample(Math.round(performance.now() - started), "pre-drawer");
				await window.getByRole("button", { name: "关闭右侧边栏", exact: true }).click();
				await expect(panel).toHaveCount(0);
				await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
				// The header toggle intentionally opens Files; explicitly navigate back to Git.
				await window.getByTestId("drawer-rail-git").click();
				await expect(panel).toBeVisible({ timeout: STEP_MS });
				await expect(row("workingTree")).toBeVisible({ timeout: STEP_MS });
				if (detail) await sample(Math.round(performance.now() - started), "drawer");
			}
			await cycle(rootIndex, detail);
			expect(await soakGitOracle(credentials, roots[rootIndex])).toBe(before[rootIndex]);
			report.cycles = ++cycles;
			report.elapsedMs = Math.round(performance.now() - started);
			await sample(Math.round(performance.now() - started));
			console.log(`[remote-git-soak] mode=${mode.name} cycle=${cycles} elapsedMs=${report.elapsedMs} helperPid=${samples.at(-1)?.helpers[0].pid}`);
			await delay(Math.min(Math.max(0, cycles * CYCLE_INTERVAL_MS - (performance.now() - started)), Math.max(0, mode.durationMs - (performance.now() - started))));
		}
		report.elapsedMs = Math.round(performance.now() - started);
		await sample(Number(report.elapsedMs));
		expect(Number(report.elapsedMs)).toBeGreaterThanOrEqual(mode.durationMs);
		report.longestObservedHelperMs = longestHelperLifetimeMs(samples);
		expect(Number(report.longestObservedHelperMs), "one actual helper, not the sum of replacements, must survive beyond the old 120s ceiling").toBeGreaterThanOrEqual(150_000);
		if (mode.name === "hour") {
			const last = samples.at(-1);
			if (settled === undefined || last === undefined) throw new Error("SOAK_SETTLED_BASELINE_MISSING");
			report.steadyDelta = delta(settled, last);
			expect(soakSteadyViolations(settled, last), "steady-state budgets for the whole settled window").toEqual([]);
			console.log(`[remote-git-soak] steadyDelta=${JSON.stringify(report.steadyDelta)}`);
		}
		for (let index = 0; index < roots.length; index++) expect(await soakGitOracle(credentials, roots[index])).toBe(before[index]);

		report.phase = "abrupt-ssh-exit";
		const appPid = app.process().pid;
		if (!appPid) throw new Error("SOAK_MAIN_PID_MISSING");
		const ssh = ownedSoakSsh(appPid, profile, roots);
		expect(ssh).toHaveLength(1);
		// No attempt to force the write into a timing window: completed-before-loss and unknown are distinct outcomes.
		await row("workingTree").hover();
		await row("workingTree").getByRole("button", { name: "暂存", exact: true }).click();
		interruptSoakConnection(appPid, profile, roots, ssh[0]);
		await expect(panel.getByRole("alert")).toBeVisible({ timeout: STEP_MS });
		await expect(panel.getByRole("status")).toHaveCount(0, { timeout: STEP_MS });
		const interruptedAlert = await panel.getByRole("alert").innerText();
		report.interruptedWriteAlert = interruptedAlert;
		report.writeUnconfirmed = interruptedAlert.includes("未确认");
		await expect(panel.getByTestId("remote-git-workingTree")).toHaveCount(0);
		const modal = await connectionModal();
		// Remount-local connection labels can be stale; first establish the real connected UI, then stop it.
		if (await modal.getByRole("button", { name: "连接", exact: true }).count()) {
			await modal.getByRole("button", { name: "连接", exact: true }).first().click();
			await expect(modal.getByRole("button", { name: "断开", exact: true }).first()).toBeVisible({ timeout: STEP_MS });
		}
		await modal.getByRole("button", { name: "断开", exact: true }).first().click();
		await expect(modal.getByRole("button", { name: "连接", exact: true }).first()).toBeVisible({ timeout: STEP_MS });
		await expect.poll(() => sampleSoakRemote(credentials, roots), { timeout: 25_000 }).toEqual([]);
		// Freeze only after disconnect has settled the possibly-applied write; reconnect must not touch it.
		const diskAfterLoss = await soakIndexIdentity(credentials, roots[activeRoot]);
		report.indexAfterLoss = diskAfterLoss;
		await modal.getByRole("button", { name: "连接", exact: true }).first().click();
		await expect(modal.getByText("已连接").first()).toBeVisible({ timeout: STEP_MS });
		await modal.getByRole("button", { name: "关闭" }).first().click();
		await delay(2_000);
		await expect(panel.getByTestId("remote-git-index")).toHaveCount(0);
		if (report.writeUnconfirmed) await expect(panel.getByRole("alert")).toContainText("未确认");
		await expect(panel.getByTestId("remote-git-workingTree")).toHaveCount(0);
		expect(await soakIndexIdentity(credentials, roots[activeRoot])).toBe(diskAfterLoss);
		await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
		await waitIdle();
		const staged = await soakProbe("staged-blob", () => runRemoteCommand(credentials, "set -eu; cd " + quoteSoakArgument(roots[activeRoot]) + "; git --no-optional-locks show :tracked.txt", SOAK_PROBE_TIMEOUT_MS));
		const label = activeRoot === 0 ? "ONE" : "TWO";
		report.diskWriteApplied = staged === label + "_WORK\n";
		if (staged === label + "_WORK\n") {
			await expect(row("index")).toBeVisible({ timeout: STEP_MS });
			await action("index", "取消暂存");
		} else expect(staged).toBe(label + "_BASE\n");
		await expect(row("workingTree")).toBeVisible({ timeout: STEP_MS });
		await waitIdle();
		for (let index = 0; index < roots.length; index++) expect(await soakGitOracle(credentials, roots[index])).toBe(before[index]);
		report.phase = "passed-before-cleanup";
	} catch (error) {
		await window.screenshot({ path: testInfo.outputPath("soak-failure-before-exit.png") }).catch(() => undefined);
		for (const name of ["code", "signal", "killed", "stdout", "stderr"]) {
			const value: unknown = typeof error === "object" && error !== null ? Reflect.get(error, name) : undefined;
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) report["failure_" + name] = typeof value === "string" ? value.slice(0, 8192) : value;
		}
		report.failure = error instanceof Error ? error.message : String(error);
		report.lastPanelText = await panel.innerText().catch(() => "panel-unavailable");
		throw error;
	} finally {
		try {
			rememberChildren();
			await app.close();
			await expect.poll(() => sampleSoakRemote(credentials, roots), { timeout: 25_000 }).toEqual([]);
			await expect
				.poll(
					() =>
						[...localPids.values()]
							.filter((old) => {
								const live = readSoakProcess(old.pid);
								return live?.startTicks === old.startTicks;
							})
							.map((fact) => fact.pid),
					{ timeout: 25_000 },
				)
				.toEqual([]);
			report.exitCleanup = "no-live-owned-helpers-or-observed-local-descendants";
		} finally {
			report.sampleCount = samples.length;
			writeFileSync(reportPath, JSON.stringify(report, null, 2));
			await testInfo.attach("remote-git-soak-report", { path: reportPath, contentType: "application/json" });
			if (samples.length) await testInfo.attach("remote-git-soak-samples", { path: journal, contentType: "application/jsonl" });
		}
	}
}
