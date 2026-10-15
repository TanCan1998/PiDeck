import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { readRemoteGitSoakMode, soakGrowthViolations, longestHelperLifetimeMs } = loadTsCommonJs("e2e/remote-soak-policy.ts");
const processFact = (pid) => ({ pid, startTicks: "100", fdCount: 20, rssKiB: 40_000 });
const sample = (elapsedMs = 0) => ({ elapsedMs, local: { main: processFact(1), renderer: processFact(2), ssh: [processFact(3)], descendantCount: 8, mainHeapBytes: 10_000_000, rendererHeapBytes: 20_000_000 }, helpers: [{ ...processFact(4), rootIndex: 0 }] });

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
