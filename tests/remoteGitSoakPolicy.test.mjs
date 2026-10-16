import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { readRemoteGitSoakMode, soakGrowthViolations, soakSteadyViolations, SOAK_SETTLED_MS, longestHelperLifetimeMs } = loadTsCommonJs("e2e/remote-soak-policy.ts");
const processFact = (pid) => ({ pid, startTicks: "100", fdCount: 20, rssKiB: 40_000 });
/** One ssh client and one project-scoped helper, with the FD counts the 2026-10-15 hour run actually showed. */
const sample = (elapsedMs = 0) => ({ elapsedMs, local: { main: processFact(1), renderer: processFact(2), ssh: [{ ...processFact(3), fdCount: 7 }], descendantCount: 8, mainHeapBytes: 10_000_000, rendererHeapBytes: 20_000_000 }, helpers: [{ ...processFact(4), fdCount: 21, rootIndex: 0 }] });

test("real SSH soak requires explicit hour/smoke mode; no knob can report a short run as an hour", () => {
	assert.equal(readRemoteGitSoakMode({}), undefined);
	assert.deepEqual(JSON.parse(JSON.stringify(readRemoteGitSoakMode({ PIDECK_E2E_REMOTE_GIT_SOAK: "hour" }))), { name: "hour", durationMs: 3_600_000 });
	assert.deepEqual(JSON.parse(JSON.stringify(readRemoteGitSoakMode({ PIDECK_E2E_REMOTE_GIT_SOAK: "smoke" }))), { name: "smoke", durationMs: 180_000 });
	assert.throws(() => readRemoteGitSoakMode({ PIDECK_E2E_REMOTE_GIT_SOAK: "1" }), /REMOTE_SOAK_MODE_INVALID/);
});

test("resource policy catches memory, FD, listener-independent process growth and renderer replacement", () => {
	const baseline = sample(),
		current = sample(60_000);
	assert.deepEqual(Array.from(soakGrowthViolations(baseline, current)), []);
	current.local.main.fdCount += 17;
	current.local.renderer.rssKiB += 128 * 1024 + 1;
	current.local.mainHeapBytes += 32 * 1024 * 1024 + 1;
	current.local.rendererHeapBytes += 64 * 1024 * 1024 + 1;
	current.local.descendantCount += 3;
	current.local.ssh.push(processFact(5));
	current.helpers[0].fdCount += 5;
	current.local.renderer.startTicks = "101";
	const failures = Array.from(soakGrowthViolations(baseline, current));
	for (const label of ["main.fd", "renderer.rss", "main.heap", "renderer.heap", "descendants", "ssh.count", "helper.fd", "renderer.identity"]) assert.ok(failures.includes(label), label);
});

test("several short helpers cannot be added up as one connection surviving 120 seconds", () => {
	const first = sample(0),
		second = sample(90_000),
		third = sample(180_000),
		fourth = sample(270_000);
	third.helpers[0].pid = 8;
	fourth.helpers[0].pid = 8;
	assert.equal(longestHelperLifetimeMs([first, second, third, fourth]), 90_000);
	fourth.elapsedMs = 340_000;
	assert.equal(longestHelperLifetimeMs([first, second, third, fourth]), 160_000);
	fourth.helpers[0].startTicks = "200";
	assert.equal(longestHelperLifetimeMs([first, second, third, fourth]), 90_000);
});

/** The 2026-10-15 hour shape: a one-time step in the first ~2.5 minutes, then a flat 55-minute plateau. */
function warmThenFlat() {
	const start = sample(0),
		settled = sample(SOAK_SETTLED_MS),
		late = sample(3_600_000);
	for (const entry of [settled, late]) {
		entry.local.main.fdCount = 251;
		entry.local.main.rssKiB = 550 * 1024;
	}
	start.local.main.fdCount = 240;
	start.local.main.rssKiB = 496 * 1024;
	return { start, settled, late };
}

test("a settled baseline separates the one-time warmup step from a continuing leak", () => {
	const { start, settled, late } = warmThenFlat();
	assert.deepEqual(Array.from(soakGrowthViolations(start, late)), [], "the measured warmup step stays inside the absolute budget");
	assert.deepEqual(Array.from(soakSteadyViolations(settled, late)), [], "a flat plateau is not a leak");
	// +6 FDs by the settled mark and +6 more during the plateau stays inside the absolute budget from the start,
	// which is exactly the slow leak a start-to-end comparison cannot see.
	const slow = sample(3_600_000);
	slow.local.main.fdCount = 252;
	slow.local.renderer.rssKiB = settled.local.renderer.rssKiB + 50 * 1024;
	settled.local.main.fdCount = 246;
	assert.deepEqual(Array.from(soakGrowthViolations(start, slow)), [], "the absolute budget alone would pass this");
	const found = Array.from(soakSteadyViolations(settled, slow));
	assert.ok(found.includes("main.fd"), "a slow FD leak must fail the steady gate");
	assert.ok(found.includes("renderer.rss"), "a slow renderer RSS leak must fail the steady gate");
});

test("the steady gate covers every measured dimension and still allows project-scoped helper rotation", () => {
	const { settled, late } = warmThenFlat();
	assert.deepEqual(Array.from(soakSteadyViolations(settled, late)), []);
	const rotated = sample(3_600_000);
	rotated.helpers[0] = { ...rotated.helpers[0], pid: 9 };
	assert.deepEqual(Array.from(soakSteadyViolations(settled, rotated)), [], "a new helper restarts its own budget");
	rotated.local.main.rssKiB = settled.local.main.rssKiB + 32 * 1024 + 1;
	rotated.local.renderer.fdCount = settled.local.renderer.fdCount + 5;
	rotated.local.mainHeapBytes = settled.local.mainHeapBytes + 24 * 1024 * 1024 + 1;
	rotated.local.rendererHeapBytes = settled.local.rendererHeapBytes + 48 * 1024 * 1024 + 1;
	rotated.local.descendantCount = settled.local.descendantCount + 2;
	rotated.local.ssh = [];
	rotated.helpers = [];
	const failures = Array.from(soakSteadyViolations(settled, rotated));
	for (const label of ["main.rss", "renderer.fd", "main.heap", "renderer.heap", "descendants", "ssh.count", "helper.count"]) assert.ok(failures.includes(label), label);
});
