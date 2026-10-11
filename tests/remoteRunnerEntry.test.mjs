import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * Integration proof for the frozen remote runner (plan §4.1 "Agent 通路" and §7.2). The supervisor is a real
 * child process started from REMOTE_RUNNER_INLINE_SOURCE, its "pi" is a real process that starts a child of
 * its own, and every claim the contract makes is observed from the outside: the ready frame and the lease it
 * must follow, the lease's own content, the two-way byte handoff, and the reclamation of the whole process
 * group after a signal, a stdin EOF or the child's own exit.
 *
 * Two things about this suite are deliberate:
 *
 * - The frozen body is started from a *file* under the name the deploy bundle uploads it as, never through
 *   `node -e <source>`. That is how it is deployed, and unlike `-e` it costs no command line at all, which is
 *   what keeps a body of this size startable on every platform.
 * - The fixture "pi" is a real `.cjs` file rather than `node -e ...`, because the init frame requires argv[0]
 *   and argv[1] to be absolute POSIX paths (the interpreter and the pi entry): a `-e` fixture has no entry
 *   path to name, so it cannot express the one frame the runner accepts.
 *
 * The process-group half of the contract is POSIX only. On win32 the runner refuses to start anything — that
 * branch has its own test — so the cases that need a real group are skipped there instead of being weakened
 * into something that no longer proves reclamation.
 */

const { REMOTE_RUNNER_ENTRY_FILE_NAME, REMOTE_RUNNER_ENTRY_SHA256, REMOTE_RUNNER_ENTRY_VERSION, REMOTE_RUNNER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteRunnerEntry.ts");
const {
	REMOTE_RUNNER_CODE_INPUT_INVALID,
	REMOTE_RUNNER_CODES,
	REMOTE_RUNNER_KILL_CONFIRM_MS,
	REMOTE_RUNNER_LEASE_DIRECTORY_SEGMENTS,
	REMOTE_RUNNER_LEASE_VERSION,
	REMOTE_RUNNER_MAX_ARG_LENGTH,
	REMOTE_RUNNER_MAX_ARGV_LENGTH,
	REMOTE_RUNNER_MAX_INIT_FRAME_BYTES,
	REMOTE_RUNNER_MAX_PATH_LENGTH,
	REMOTE_RUNNER_MAX_TERM_GRACE_MS,
	REMOTE_RUNNER_MIN_ARGV_LENGTH,
	REMOTE_RUNNER_MIN_TERM_GRACE_MS,
	REMOTE_RUNNER_NONCE_PATTERN,
	REMOTE_RUNNER_POLL_MS,
	REMOTE_RUNNER_PROTOCOL_VERSION,
	REMOTE_RUNNER_TERM_GRACE_ENV,
	REMOTE_RUNNER_TERM_GRACE_MS,
	buildRemoteRunnerCommand,
	buildRemoteRunnerInitFrame,
	decodeRemoteRunnerResultFrame,
	isRemoteRunnerAbsolutePath,
} = loadTsCommonJs("src/main/remote/RemoteRunnerContract.ts");
const { deployedRunnerPath, frozenHelperBundleManifest } = loadTsCommonJs("src/main/remote/RemoteBootstrapDeployment.ts");
const { REMOTE_HELPER_ENTRY_FILE_NAME, REMOTE_HELPER_ENTRY_SHA256, REMOTE_HELPER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");

/** Frozen digest, pinned here as well as in the module: editing the source means editing both. */
const FROZEN_SHA256 = "b63858473bfbf20df7a6fe18ffbc7a6ee45fbbeed45c045b0ec5c8edc616376a";
const TEST_TIMEOUT_MS = 40_000;
const GUARD_TIMEOUT_MS = 15_000;
const WINDOWS = process.platform === "win32";

/** Production objects live in another VM realm, so deep comparisons are normalised through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Every test drives real child processes, so each one carries a hard deadline of its own. */
const runnerTest = (name, fn, timeoutMs = TEST_TIMEOUT_MS) => test(name, { timeout: timeoutMs }, fn);
/** Cases that need a POSIX process group: skipped on win32 with the reason the runner itself gives. */
const posixTest = (name, fn, timeoutMs = TEST_TIMEOUT_MS) => test(name, { skip: WINDOWS ? "POSIX process groups: the frozen runner refuses to start on win32" : false, timeout: timeoutMs }, fn);

const RUNNER_DIRECTORY = mkdtempSync(join(tmpdir(), "pideck-runner-entry-"));
const RUNNER_PATH = join(RUNNER_DIRECTORY, REMOTE_RUNNER_ENTRY_FILE_NAME);
writeFileSync(RUNNER_PATH, REMOTE_RUNNER_INLINE_SOURCE, "utf8");
after(() => rmSync(RUNNER_DIRECTORY, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Bound one wait: a runner that stops answering has to fail the test, never stall the runner. */
async function waitUntil(predicate, label, timeoutMs = GUARD_TIMEOUT_MS) {
	const startedAt = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out: ${label}`);
		await delay(10);
	}
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}

const waitForGone = (pid, label = `process ${pid}`) => waitUntil(() => isAlive(pid) === false, `${label} to be reclaimed`);

/** The lease file of one run: the path `<HOME>/.pideck/remote-host/leases/<nonce>.json`. */
function leasePath(home, nonce) {
	return join(home, ...REMOTE_RUNNER_LEASE_DIRECTORY_SEGMENTS, `${nonce}.json`);
}

/**
 * The fixture "pi": a long-lived process that writes a sentinel first (the only proof that the runner did or
 * did not spawn anything), prints one fixed JSONL line, optionally starts a child of its own, optionally
 * ignores SIGTERM, and echoes whatever its stdin receives to its stdout — so a single write proves both
 * directions of the handoff. It records its own pid (and the child's) for the test to observe.
 */
function fakePiSource(options) {
	const childSource = options.ignoreTerm === true ? "process.on('SIGTERM', function () {}); setTimeout(function () {}, 600000);" : "setTimeout(function () {}, 600000);";
	return [
		'const cp = require("node:child_process");',
		'const fs = require("node:fs");',
		'fs.writeFileSync(process.argv[2], "spawned");',
		'process.stdout.write(\'{"v":1,"op":"pong"}\' + "\\n");',
		options.withGrandchild === true ? `const grandchild = cp.spawn(process.execPath, ["-e", "${childSource}"], { stdio: "ignore" });` : "",
		options.withGrandchild === true ? "fs.writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }));" : "fs.writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, grandchild: 0 }));",
		options.ignoreTerm === true ? 'process.on("SIGTERM", function () {});' : "",
		'process.stdin.on("data", function (chunk) { process.stdout.write(chunk); });',
		'process.stdin.on("end", function () { process.exit(0); });',
		options.exitAfterMs > 0 ? `setTimeout(function () { process.exit(${options.exitCode}); }, ${options.exitAfterMs});` : "",
		"setTimeout(function () {}, 600000);",
	]
		.filter((line) => line !== "")
		.join("\n");
}

function createFixture(t, options = {}) {
	const base = mkdtempSync(join(tmpdir(), "pideck-runner-fixture-"));
	const home = join(base, "home");
	const cwd = join(base, "project");
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(cwd);
	const sentinel = join(base, "pi-started");
	const facts = join(base, "pi-facts.json");
	const piPath = join(base, "fake-pi.cjs");
	writeFileSync(piPath, fakePiSource(options), "utf8");
	t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
	return { base, home, cwd, sentinel, facts, piPath, argv: [process.execPath, piPath, sentinel, facts] };
}

/**
 * One runner process. stdout is kept raw, because the handshake line and pi's own bytes are two halves of the
 * same stream and only the raw form can show that the second half arrived untouched.
 */
function startRunner(t, options = {}) {
	const home = options.home ?? mkdtempSync(join(tmpdir(), "pideck-runner-home-"));
	const env = { ...process.env, HOME: home };
	if (options.graceMs !== undefined) env[REMOTE_RUNNER_TERM_GRACE_ENV] = String(options.graceMs);
	const child = spawn(process.execPath, [RUNNER_PATH], { env, stdio: ["pipe", "pipe", "pipe"] });
	const session = { child, home, stdout: Buffer.alloc(0), stderr: "", exit: undefined };
	session.write = (value) => {
		try {
			child.stdin.write(value);
		} catch {
			// The transport is already gone; the assertions below read the exit, not the failed write.
		}
	};
	session.writeInit = (line) => session.write(`${line}\n`);
	session.endStdin = () => {
		try {
			child.stdin.end();
		} catch {
			// Same: the runner may already have exited.
		}
	};
	session.firstLine = () => {
		const index = session.stdout.indexOf(0x0a);
		return index < 0 ? null : session.stdout.subarray(0, index);
	};
	session.passthrough = () => {
		const index = session.stdout.indexOf(0x0a);
		return index < 0 ? "" : session.stdout.subarray(index + 1).toString("utf8");
	};
	session.lines = () =>
		session.stdout
			.toString("utf8")
			.split("\n")
			.filter((line) => line.length > 0);
	child.stdout.on("data", (chunk) => {
		session.stdout = Buffer.concat([session.stdout, chunk]);
	});
	child.stderr.on("data", (chunk) => {
		session.stderr += chunk.toString("utf8");
	});
	child.on("exit", (code, signal) => {
		session.exit = { code, signal };
	});
	child.stdin.on("error", () => {});
	t.after(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
		rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	});
	return session;
}

/** Wait for the one handshake frame and decode it through the contract main will use. */
async function waitForHandshake(session, label = "the handshake frame") {
	await waitUntil(() => session.firstLine() !== null, label);
	return decodeRemoteRunnerResultFrame(session.firstLine());
}

async function waitForExit(session, timeoutMs = GUARD_TIMEOUT_MS) {
	await waitUntil(() => session.exit !== undefined, "the runner exit", timeoutMs);
	return session.exit;
}

/** The fixture pi's own report; a half-written file is retried rather than parsed. */
async function readFacts(path) {
	const parse = () => {
		try {
			const value = JSON.parse(readFileSync(path, "utf8"));
			return typeof value.pid === "number" && value.pid > 1 ? value : null;
		} catch {
			return null;
		}
	};
	await waitUntil(() => parse() !== null, "the fixture pi to report its own identity");
	return parse();
}

function initFrame(fixture, nonce) {
	return buildRemoteRunnerInitFrame({ nonce, cwd: fixture.cwd, argv: fixture.argv });
}

runnerTest("the frozen runner source is one byte-frozen ASCII line", () => {
	// The runner is uploaded as a content-addressed artifact, so its bytes are the deployment identity: an
	// edit is only legitimate together with a deliberate update of both digests below.
	const digest = createHash("sha256").update(REMOTE_RUNNER_INLINE_SOURCE, "utf8").digest("hex");
	assert.equal(digest, FROZEN_SHA256, "the frozen runner source changed: update REMOTE_RUNNER_ENTRY_SHA256 and this digest in the same commit");
	assert.equal(digest, REMOTE_RUNNER_ENTRY_SHA256, "the exported digest must describe the exported source");
	assert.equal(Buffer.byteLength(REMOTE_RUNNER_INLINE_SOURCE, "utf8"), REMOTE_RUNNER_INLINE_SOURCE.length, "the source stays printable ASCII");
	assert.ok(!/[\r\n]/.test(REMOTE_RUNNER_INLINE_SOURCE), "the source is one line");
	assert.ok(!/[\u0000-\u001f\u007f]/.test(REMOTE_RUNNER_INLINE_SOURCE), "no control byte may reach stdin or an argv token");
	assert.ok(!REMOTE_RUNNER_INLINE_SOURCE.includes("console."), "stdout carries protocol frames and pi's bytes only");
	// The deployed artifact is an ES module, where require does not exist, so the body loads its builtins
	// through process.getBuiltinModule - and it must load exactly the three the supervisor needs.
	assert.ok(!REMOTE_RUNNER_INLINE_SOURCE.includes("require("), "the runner needs nothing but process and its stdio");
	assert.deepEqual(
		Array.from(REMOTE_RUNNER_INLINE_SOURCE.matchAll(/getBuiltinModule\("([^"]+)"\)/g)).map((match) => match[1]),
		["node:child_process", "node:fs", "node:path"],
		"the runner may load exactly the three builtins it needs",
	);
	assert.ok(REMOTE_RUNNER_INLINE_SOURCE.length > 1024 && REMOTE_RUNNER_INLINE_SOURCE.length < 64 * 1024, `unexpected source size ${REMOTE_RUNNER_INLINE_SOURCE.length}`);
});

runnerTest("the frozen body repeats the contract's literals and its command shapes", () => {
	assert.equal(REMOTE_RUNNER_ENTRY_FILE_NAME, "runner.mjs");
	assert.match(REMOTE_RUNNER_ENTRY_VERSION, /^\d+\.\d+\.\d+$/);
	assert.ok(REMOTE_RUNNER_INLINE_SOURCE.includes(`"${REMOTE_RUNNER_ENTRY_VERSION}"`), "the build identity must be a literal of the frozen body");
	assert.match(REMOTE_RUNNER_INLINE_SOURCE, new RegExp(`const\\s+V\\s*=\\s*${REMOTE_RUNNER_PROTOCOL_VERSION}\\b`), "the wire version must be a literal of the frozen body");
	for (const code of REMOTE_RUNNER_CODES) assert.ok(REMOTE_RUNNER_INLINE_SOURCE.includes(`"${code}"`), `${code} must be a literal of the frozen body`);
	assert.ok(REMOTE_RUNNER_INLINE_SOURCE.includes(REMOTE_RUNNER_NONCE_PATTERN), "the nonce shape must be the contract's literal");
	for (const segment of REMOTE_RUNNER_LEASE_DIRECTORY_SEGMENTS) assert.ok(REMOTE_RUNNER_INLINE_SOURCE.includes(`"${segment}"`), `${segment} must be a literal of the frozen body`);
	assert.ok(REMOTE_RUNNER_INLINE_SOURCE.includes(REMOTE_RUNNER_TERM_GRACE_ENV), "the harness override must be a literal of the frozen body");
	// The bounds are the body's own constants: a mismatch here is a frame the contract would accept and the
	// runner would refuse (or the other way round), which no caller could diagnose from the outside.
	for (const [name, value] of [
		["MAX_INIT", REMOTE_RUNNER_MAX_INIT_FRAME_BYTES],
		["MIN_ARGV", REMOTE_RUNNER_MIN_ARGV_LENGTH],
		["MAX_ARGV", REMOTE_RUNNER_MAX_ARGV_LENGTH],
		["MAX_PATH", REMOTE_RUNNER_MAX_PATH_LENGTH],
		["MAX_ARG", REMOTE_RUNNER_MAX_ARG_LENGTH],
		["DEFAULT_GRACE_MS", REMOTE_RUNNER_TERM_GRACE_MS],
		["MIN_GRACE_MS", REMOTE_RUNNER_MIN_TERM_GRACE_MS],
		["MAX_GRACE_MS", REMOTE_RUNNER_MAX_TERM_GRACE_MS],
		["KILL_CONFIRM_MS", REMOTE_RUNNER_KILL_CONFIRM_MS],
		["POLL_MS", REMOTE_RUNNER_POLL_MS],
		["LEASE_VERSION", REMOTE_RUNNER_LEASE_VERSION],
	]) {
		assert.match(REMOTE_RUNNER_INLINE_SOURCE, new RegExp(`${name}\\s*=\\s*${value}\\b`), `${name} must be the contract's value`);
	}
	// Two spawn facts the contract depends on: the fixed options, and that nothing else can start a process.
	assert.match(REMOTE_RUNNER_INLINE_SOURCE, /cp\.spawn\([\s\S]{0,120}?shell\s*:\s*false[\s\S]{0,60}?detached\s*:\s*true[\s\S]{0,60}?stdio\s*:\s*\[\s*"pipe"\s*,\s*"pipe"\s*,\s*"pipe"\s*\]/, "the spawn options are fixed by the contract");
	assert.equal((REMOTE_RUNNER_INLINE_SOURCE.match(/cp\.spawn\(/g) ?? []).length, 1, "exactly one spawn site");
	assert.ok(!/shell\s*:\s*true/.test(REMOTE_RUNNER_INLINE_SOURCE), "no shell may ever be involved");
	assert.ok(!REMOTE_RUNNER_INLINE_SOURCE.includes("child.kill("), "reclamation never names a bare pid");
	assert.ok(REMOTE_RUNNER_INLINE_SOURCE.includes("process.kill(-pgid"), "signals go to the process group");
});

runnerTest("the deploy bundle carries both frozen entries and the runner path resolves inside it", () => {
	const manifest = frozenHelperBundleManifest();
	assert.deepEqual(plain(manifest.files.map((file) => file.name)), [REMOTE_HELPER_ENTRY_FILE_NAME, REMOTE_RUNNER_ENTRY_FILE_NAME], "one immutable bundle carries the helper and the runner");
	const helper = manifest.files.find((file) => file.name === REMOTE_HELPER_ENTRY_FILE_NAME);
	const runner = manifest.files.find((file) => file.name === REMOTE_RUNNER_ENTRY_FILE_NAME);
	assert.equal(helper.sha256, REMOTE_HELPER_ENTRY_SHA256);
	assert.equal(helper.bytes, Buffer.byteLength(REMOTE_HELPER_INLINE_SOURCE, "utf8"));
	assert.equal(runner.sha256, REMOTE_RUNNER_ENTRY_SHA256);
	assert.equal(runner.bytes, Buffer.byteLength(REMOTE_RUNNER_INLINE_SOURCE, "utf8"));

	const deployRoot = "/home/dev/.pideck/remote-host";
	const sha = "b".repeat(64);
	const runnerPath = deployedRunnerPath({ bundleSha256: sha, deployRoot, active: `./bundles/${sha}` });
	assert.equal(runnerPath, `${deployRoot}/bundles/${sha}/${REMOTE_RUNNER_ENTRY_FILE_NAME}`);
	assert.equal(isRemoteRunnerAbsolutePath(runnerPath), true, "the resolved path is a remote POSIX path");
	// ...and the command that starts it is the fixed two-token template of this contract.
	assert.equal(buildRemoteRunnerCommand(runnerPath, "/usr/bin/node"), `'/usr/bin/node' '${runnerPath}'`);
	for (const bad of [
		{ bundleSha256: sha, deployRoot, active: `bundles/${sha}` },
		{ bundleSha256: sha, deployRoot, active: `./bundles/${"c".repeat(64)}` },
		{ bundleSha256: sha, deployRoot: `${deployRoot}/`, active: `./bundles/${sha}` },
		{ bundleSha256: sha, deployRoot: "/", active: `./bundles/${sha}` },
		{ bundleSha256: sha, deployRoot: "relative/root", active: `./bundles/${sha}` },
		{ bundleSha256: sha, deployRoot, active: "x" },
		null,
	]) {
		assert.equal(
			(() => {
				try {
					deployedRunnerPath(bad);
					return null;
				} catch (error) {
					return error.message;
				}
			})(),
			REMOTE_RUNNER_CODE_INPUT_INVALID,
			JSON.stringify(bad),
		);
	}
});

posixTest("ready follows the lease and pi's bytes flow both ways", async (t) => {
	const fixture = createFixture(t, { withGrandchild: true });
	const session = startRunner(t, { home: fixture.home });
	const nonce = "runner-handoff-0001";
	// One write carries the init frame and one line behind it: bytes that arrive in the same read as the frame
	// have to reach pi after the handoff instead of being dropped with the handshake buffer.
	const early = '{"v":1,"op":"early","n":1}\n';
	session.write(`${initFrame(fixture, nonce)}\n${early}`);
	const frame = await waitForHandshake(session);
	assert.equal(frame.op, "ready");
	assert.equal(frame.nonce, nonce, "the nonce of this run is echoed unchanged");
	assert.equal(frame.pgid, frame.pid, "the detached pi is the leader of its own group");
	assert.ok(Number.isSafeInteger(frame.pid) && frame.pid > 1, "ready names a real process");
	assert.match(frame.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

	// The ordering the contract fixes: the lease is durable before ready exists. Reading it right after the
	// frame is the proof - a runner that wrote it afterwards would fail here.
	const lease = JSON.parse(readFileSync(leasePath(fixture.home, nonce), "utf8"));
	assert.deepEqual(lease, { v: 1, nonce, pid: frame.pid, pgid: frame.pid, startedAt: frame.startedAt, command: process.execPath, args: fixture.argv.slice(1) });
	assert.equal(existsSync(`${leasePath(fixture.home, nonce)}.tmp`), false, "the atomic write leaves no temporary file behind");
	const facts = await readFacts(fixture.facts);
	assert.equal(facts.pid, frame.pid, "the pid in the lease and in ready is the pid pi reports of itself");
	assert.ok(facts.grandchild > 1, "the fixture pi started a child of its own");

	// pi's own bytes are forwarded byte for byte, right behind the handshake line.
	await waitUntil(() => session.passthrough().startsWith('{"v":1,"op":"pong"}\n'), "pi's first line on the runner's stdout");
	await waitUntil(() => session.passthrough().includes(early), "the line that arrived together with the init frame");
	// stdin is a raw pipe to pi: what the launcher writes comes back through pi, untouched and unframed.
	const prompt = '{"v":1,"op":"echo-me","n":7}\n';
	session.write(prompt);
	await waitUntil(() => session.passthrough().includes(prompt), "the line pi echoed after receiving it");
	assert.equal(session.stderr, "", "the happy path keeps stderr silent");

	// A clean EOF ends the run: the group is reclaimed and the lease goes with it.
	session.endStdin();
	const exit = await waitForExit(session);
	assert.equal(exit.code, 0, "a run ended by its transport exits cleanly");
	await waitForGone(facts.pid, "the fixture pi");
	await waitForGone(facts.grandchild, "the fixture pi's child");
	assert.equal(existsSync(leasePath(fixture.home, nonce)), false, "a reclaimed run removes its lease");
});

runnerTest("a malformed init frame is answered with exactly one error frame and starts nothing", async (t) => {
	const fixture = createFixture(t);
	const nonce = "runner-refuse-0001";
	const valid = { v: 1, op: "start", nonce, cwd: fixture.cwd, argv: fixture.argv };
	const cases = [
		["a version other than 1", { ...valid, v: 2 }],
		["an op other than start", { ...valid, op: "start2" }],
		["a nonce one character short", { ...valid, nonce: nonce.slice(0, 15) }],
		["a nonce with a separator", { ...valid, nonce: `${nonce.slice(0, 15)}/x` }],
		["a relative cwd", { ...valid, cwd: "project" }],
		["a cwd with a traversal segment", { ...valid, cwd: `${fixture.cwd}/../elsewhere` }],
		["a cwd with a trailing separator", { ...valid, cwd: `${fixture.cwd}/` }],
		["a cwd with a control byte", { ...valid, cwd: `${fixture.cwd}\u0001` }],
		["a one-element argv", { ...valid, argv: [process.execPath] }],
		["an argv one element past the ceiling", { ...valid, argv: [process.execPath, fixture.piPath, ...Array.from({ length: REMOTE_RUNNER_MAX_ARGV_LENGTH - 1 }, () => "--flag")] }],
		["a relative interpreter", { ...valid, argv: ["node", fixture.piPath] }],
		["a relative pi entry", { ...valid, argv: [process.execPath, "fake-pi.cjs"] }],
		["an argument past the argument ceiling", { ...valid, argv: [process.execPath, fixture.piPath, "x".repeat(REMOTE_RUNNER_MAX_ARG_LENGTH + 1)] }],
	];
	for (const [title, frame] of cases) {
		const session = startRunner(t, { home: fixture.home });
		session.writeInit(JSON.stringify(frame));
		const exit = await waitForExit(session);
		const lines = session.lines();
		assert.equal(lines.length, 1, `${title}: exactly one frame is written`);
		assert.equal(decodeRemoteRunnerResultFrame(lines[0]).code, REMOTE_RUNNER_CODE_INPUT_INVALID, title);
		assert.notEqual(exit.code, 0, `${title}: the refusal exits non-zero`);
		assert.equal(session.stderr, "", `${title}: a refusal carries no free text`);
		assert.equal(existsSync(fixture.sentinel), false, `${title}: nothing may have been spawned`);
	}

	// Two malformed frames in one write: the runner answers the first fault and never reads the rest, so the
	// handshake can never carry two error frames.
	const repeated = startRunner(t, { home: fixture.home });
	repeated.write(`${JSON.stringify({ ...valid, op: "nope" })}\n${JSON.stringify({ ...valid, op: "nope" })}\n`);
	assert.notEqual((await waitForExit(repeated)).code, 0);
	assert.equal(repeated.lines().length, 1, "a second fault is not a second frame");
	assert.equal(existsSync(fixture.sentinel), false, "no spawn on either fault");
});

runnerTest("an init frame at or past the cap fails closed", async (t) => {
	const fixture = createFixture(t);
	// Every single argument is inside its own bound: the frame cap is what refuses this line.
	const overCap = JSON.stringify({ v: 1, op: "start", nonce: "runner-overcap-0001", cwd: fixture.cwd, argv: [process.execPath, fixture.piPath, "a".repeat(4096), "b".repeat(4096), "c".repeat(4096)] });
	assert.ok(Buffer.byteLength(overCap, "utf8") + 1 > REMOTE_RUNNER_MAX_INIT_FRAME_BYTES, "the fixture really is over the cap");
	const session = startRunner(t, { home: fixture.home });
	session.writeInit(overCap);
	const exit = await waitForExit(session);
	assert.equal(session.lines().length, 1);
	assert.equal(decodeRemoteRunnerResultFrame(session.lines()[0]).code, REMOTE_RUNNER_CODE_INPUT_INVALID);
	assert.notEqual(exit.code, 0);
	assert.equal(existsSync(fixture.sentinel), false, "nothing may have been spawned");

	// An unterminated tail at the cap is refused while stdin stays open: a frame that can no longer fit must
	// not be buffered just because its terminator has not arrived.
	const unterminated = startRunner(t, { home: fixture.home });
	unterminated.write("x".repeat(REMOTE_RUNNER_MAX_INIT_FRAME_BYTES));
	assert.notEqual((await waitForExit(unterminated)).code, 0);
	assert.equal(unterminated.lines().length, 1);
	assert.equal(decodeRemoteRunnerResultFrame(unterminated.lines()[0]).code, REMOTE_RUNNER_CODE_INPUT_INVALID);
	assert.equal(existsSync(fixture.sentinel), false, "nothing may have been spawned");
});

runnerTest("an init frame that ends without its terminator fails closed", async (t) => {
	const fixture = createFixture(t);
	const session = startRunner(t, { home: fixture.home });
	// A well-formed frame - minus the newline that would have ended it. EOF is the only thing that can follow.
	session.write(initFrame(fixture, "runner-untermin-0001"));
	session.endStdin();
	const exit = await waitForExit(session);
	assert.equal(session.lines().length, 1);
	assert.equal(decodeRemoteRunnerResultFrame(session.lines()[0]).code, REMOTE_RUNNER_CODE_INPUT_INVALID);
	assert.notEqual(exit.code, 0);
	assert.equal(existsSync(fixture.sentinel), false, "nothing may have been spawned");
});

posixTest("SIGTERM reclaims the whole process group and removes the lease", async (t) => {
	const fixture = createFixture(t, { withGrandchild: true });
	const session = startRunner(t, { home: fixture.home });
	const nonce = "runner-sigterm-0001";
	session.writeInit(initFrame(fixture, nonce));
	const frame = await waitForHandshake(session);
	const facts = await readFacts(fixture.facts);
	assert.equal(facts.pid, frame.pid);
	// The signal the SSH client sends when its connection dies. The runner has to take the group down, not
	// just the leader: the fixture pi left a child of its own alive on purpose.
	session.child.kill("SIGTERM");
	const exit = await waitForExit(session);
	assert.equal(exit.code, 0, "a reclaimed run exits cleanly");
	await waitForGone(facts.pid, "the fixture pi");
	await waitForGone(facts.grandchild, "the fixture pi's child");
	assert.equal(existsSync(leasePath(fixture.home, nonce)), false, "the lease is removed after the group is gone");
	assert.equal(session.stderr, "");
});

posixTest("closing the runner's stdin reclaims the group like a signal", async (t) => {
	const fixture = createFixture(t, { withGrandchild: true });
	const session = startRunner(t, { home: fixture.home });
	const nonce = "runner-eof-000001";
	session.writeInit(initFrame(fixture, nonce));
	const frame = await waitForHandshake(session);
	const facts = await readFacts(fixture.facts);
	assert.equal(facts.pid, frame.pid);
	session.endStdin();
	const exit = await waitForExit(session);
	assert.equal(exit.code, 0);
	await waitForGone(facts.pid, "the fixture pi");
	await waitForGone(facts.grandchild, "the fixture pi's child");
	assert.equal(existsSync(leasePath(fixture.home, nonce)), false);
});

posixTest("a group that ignores SIGTERM is killed after the bounded grace", async (t) => {
	const graceMs = 250;
	const fixture = createFixture(t, { withGrandchild: true, ignoreTerm: true });
	const session = startRunner(t, { home: fixture.home, graceMs });
	const nonce = "runner-kill-00001";
	session.writeInit(initFrame(fixture, nonce));
	const frame = await waitForHandshake(session);
	const facts = await readFacts(fixture.facts);
	assert.equal(facts.pid, frame.pid);
	const startedAt = Date.now();
	session.child.kill("SIGTERM");
	const exit = await waitForExit(session, 20_000);
	const elapsed = Date.now() - startedAt;
	// Both processes ignore SIGTERM, so only the bounded SIGKILL can end them - and the wait is bounded, which
	// is what keeps a stuck group from holding an SSH channel open forever.
	assert.equal(exit.code, 0);
	await waitForGone(facts.pid, "the fixture pi");
	await waitForGone(facts.grandchild, "the fixture pi's child");
	assert.equal(existsSync(leasePath(fixture.home, nonce)), false);
	assert.ok(elapsed >= graceMs, `the grace has to be waited out (${elapsed} ms)`);
	assert.ok(elapsed < graceMs + REMOTE_RUNNER_KILL_CONFIRM_MS + 10_000, `reclamation stays inside its bounds (${elapsed} ms)`);
});

posixTest("a pi that exits on its own is transcribed and its survivors are reclaimed", async (t) => {
	const fixture = createFixture(t, { withGrandchild: true, exitAfterMs: 300, exitCode: 7 });
	const session = startRunner(t, { home: fixture.home });
	const nonce = "runner-exit-00001";
	session.writeInit(initFrame(fixture, nonce));
	await waitForHandshake(session);
	const facts = await readFacts(fixture.facts);
	const exit = await waitForExit(session);
	assert.equal(exit.code, 7, "the child's own exit code is what the runner exits with");
	// The child exited, but its child did not: the group is still the unit of reclamation.
	await waitForGone(facts.grandchild, "the fixture pi's child");
	await waitForGone(facts.pid, "the fixture pi");
	assert.equal(existsSync(leasePath(fixture.home, nonce)), false);
});

test("the runner refuses to start anything on win32", { skip: WINDOWS ? false : "POSIX-only branch: the runner supervises process groups" }, async (t) => {
	// The frame itself is fine - this is about the platform, not the input: a supervisor that cannot promise
	// to reap what it started must not start it, so the refusal comes before any spawn or lease work.
	const session = startRunner(t);
	session.writeInit(buildRemoteRunnerInitFrame({ nonce: "runner-win32-0001", cwd: "/home/dev/project", argv: ["/usr/bin/node", "/usr/bin/pi", "--mode", "rpc"] }));
	const frame = await waitForHandshake(session);
	assert.equal(frame.op, "error");
	assert.equal(frame.code, "RUNNER_INTERNAL");
	assert.notEqual((await waitForExit(session)).code, 0);
	assert.equal(session.stderr, "");
});
