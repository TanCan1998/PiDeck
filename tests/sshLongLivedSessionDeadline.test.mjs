import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createManualTimers, createPinnedClient, createPinnedHostFixture, settle } from "./helpers/sshPinnedHostFixture.mjs";

/*
 * Lifetime of a remote ssh process, after the D2 decision (docs/remote-phase4-plan.md §3.6, task-33).
 *
 * The launcher now states the policy per request:
 *
 *   lifetime: "command" (the default, i.e. absent) - a one-shot: the launcher owns a wall-clock deadline
 *      (timeoutMs, default 30 s, clamped to SSH_LAUNCHER_MAX_TIMEOUT_MS = 120 s) and force-kills at it;
 *   lifetime: "session" - a control or agent session: NO deadline timer is armed at all, timeoutMs must be
 *      omitted, and the process ends only through its paired stop path, a spawn failure, an output/line
 *      budget violation, or ssh exiting on its own (ssh keepalive detects a black-hole peer).
 *
 * The suite is red-first: the session cases assert there is no deadline to fire, which is exactly what the
 * 120 s ceiling used to be. The opt-in real case then proves a genuine session process survives past 120 s.
 */

const MODULE_PATH = "src/main/remote/SshProcessLauncher.ts";
const LAUNCHER = loadTsCommonJs(MODULE_PATH);
const { buildVerifiedSshArgv } = loadTsCommonJs("src/main/remote/SshCommandBuilder.ts");
const { createSshConnectionManager } = loadTsCommonJs("src/main/remote/SshConnectionManager.ts");
const SESSION_DEADLINE = LAUNCHER.SSH_LAUNCHER_MAX_TIMEOUT_MS;
const COMMAND_DEFAULT = LAUNCHER.SSH_LAUNCHER_DEFAULT_TIMEOUT_MS;
const SSH_PATH = process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh";
const HOST_ID = "host-a";
const CAPABILITIES = ["echo", "fs.stat", "fs.list", "fs.read"];
const HELPER_SESSION = { nodePath: "/usr/bin/node", deployRoot: "/home/dev/.pideck/remote-host", bundleSha256: "a".repeat(64) };

const exitShape = (exit) => JSON.parse(JSON.stringify(exit));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Minimal deterministic scheduler: the launcher only ever calls setTimeout(handler, delay). */
function createTimerSpy() {
	let nextId = 1;
	const pending = new Map();
	return {
		delays: () => [...pending.values()].map((timer) => timer.delay),
		count: () => pending.size,
		setTimeout(handler, delay) {
			const id = nextId;
			nextId += 1;
			pending.set(id, { handler, delay });
			return id;
		},
		clearTimeout(id) {
			pending.delete(id);
		},
		fireDelay(delay) {
			const entry = [...pending.entries()].find(([, timer]) => timer.delay === delay);
			assert.ok(entry, "expected a pending timer with delay " + delay + ", saw " + JSON.stringify([...pending.values()].map((timer) => timer.delay)));
			pending.delete(entry[0]);
			entry[1].handler();
			return delay;
		},
	};
}

function fakeChild(options = {}) {
	const child = new EventEmitter();
	child.pid = 4242;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	const emit = child.emit.bind(child);
	child.emit = (event, ...args) => {
		const emitted = emit(event, ...args);
		if (event === "exit" && options.manualClose !== true) emit("close", ...args);
		return emitted;
	};
	child.kills = [];
	child.kill = (signal) => {
		child.kills.push(signal === undefined ? null : signal);
		return true;
	};
	if (options.stdin === true) {
		const stdin = new EventEmitter();
		stdin.writes = [];
		stdin.onAnswer = undefined;
		stdin.write = (chunk) => {
			stdin.writes.push(chunk);
			stdin.onAnswer?.(String(chunk));
			return true;
		};
		stdin.end = () => undefined;
		child.stdin = stdin;
	}
	return child;
}

/** A launcher module whose timers are the spy's, so any armed deadline is visible instead of waited for. */
function spiedLauncher(child) {
	const timers = createTimerSpy();
	const module = loadTsCommonJs(MODULE_PATH, { globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } });
	const launcher = module.createSshProcessLauncher({
		spawn: () => {
			queueMicrotask(() => child.emit("spawn"));
			return child;
		},
	});
	return { launcher, timers, module };
}

function invocation() {
	return { executable: SSH_PATH, destination: "work", args: ["-T", "work", "true"], env: { PATH: "/usr/bin" }, openSshVersion: "OpenSSH_9.5p1" };
}

function request(overrides = {}) {
	return { hostId: HOST_ID, generation: 7, invocation: invocation(), stdin: true, ...overrides };
}

function helloResult() {
	return { protocolVersion: 1, platform: "linux", arch: "x64", home: "/home/dev", root: null, capabilities: CAPABILITIES, helperVersion: "1.6.0", nodeVersion: "v24.11.0", pid: 4242 };
}

test("a session arms no deadline at all, survives, and is still bounded by its paired stop path", async () => {
	const child = fakeChild({ stdin: true });
	const { launcher, timers } = spiedLauncher(child);
	const handle = await launcher.start(request({ lifetime: "session" }));
	const exits = [];
	handle.onExit((exit) => exits.push(exit));
	const lines = [];
	handle.onStdoutLine((line) => lines.push(line));

	assert.deepEqual(timers.delays(), [], "a session must not arm any deadline");
	child.stdout.emit("data", Buffer.from('{"v":1,"id":"req-1","ok":true}\n'));
	await tick();
	assert.deepEqual(lines.length, 1, "the session is live and its stream is consumed");
	assert.deepEqual(child.kills, [], "nothing killed a healthy session");

	const stopping = handle.stop("shutdown");
	assert.deepEqual(child.kills, [null], "the stop path signals first");
	assert.equal(timers.count() > 0, true, "the escalation backstop is armed");
	timers.fireDelay(2000);
	assert.deepEqual(child.kills, [null, "SIGKILL"], "an unconfirmed stop escalates to SIGKILL");
	// The child never reports its exit: the second rung settles anyway instead of suspending shutdown.
	timers.fireDelay(2000);
	await stopping;
	assert.deepEqual(child.kills, [null, "SIGKILL"], "an unconfirmed stop still converges");
	assert.deepEqual(exits.map(exitShape), [{ kind: "stopped", code: null, signal: null }]);
	assert.equal(timers.count(), 0);
});

test("a session keeps the output and line budgets: a contract violation still ends it", async () => {
	const child = fakeChild({ stdin: true });
	const { launcher, timers } = spiedLauncher(child);
	const handle = await launcher.start(request({ lifetime: "session", maxLineBytes: 32 }));
	const exits = [];
	handle.onExit((exit) => exits.push(exit));
	handle.onStdoutLine(() => undefined);
	child.stdout.emit("data", Buffer.from("x".repeat(64)));
	assert.deepEqual(child.kills, ["SIGKILL"], "an oversized frame is still fatal for a session");
	assert.deepEqual(exits.map(exitShape), [{ kind: "failed", code: null, signal: null, errorCode: "SSH_LAUNCHER_LINE_TOO_LARGE" }]);
	assert.deepEqual(timers.delays(), [], "the refusal came from the line budget, not from a deadline");
});

test("a session refuses a wall-clock timeout instead of quietly ignoring it", async () => {
	const child = fakeChild({ stdin: true });
	const { launcher } = spiedLauncher(child);
	await assert.rejects(launcher.start(request({ lifetime: "session", timeoutMs: SESSION_DEADLINE })), /SSH_LAUNCHER_REQUEST_INVALID/);
	assert.deepEqual(child.kills, [], "nothing was spawned or killed for the refused request");
});

test("the command tier is unchanged: default, explicit and clamped deadlines still kill", async () => {
	const cases = [
		[{}, COMMAND_DEFAULT],
		[{ lifetime: "command", timeoutMs: 500 }, 500],
		[{ timeoutMs: 10 * 60 * 1000 }, SESSION_DEADLINE],
	];
	for (const [overrides, expected] of cases) {
		const child = fakeChild({ stdin: true });
		const { launcher, timers } = spiedLauncher(child);
		const handle = await launcher.start(request(overrides));
		const exits = [];
		handle.onExit((exit) => exits.push(exit));
		assert.deepEqual(timers.delays(), [expected], JSON.stringify(overrides));
		timers.fireDelay(expected);
		assert.deepEqual(child.kills, ["SIGKILL"], JSON.stringify(overrides));
		assert.deepEqual(exits.map(exitShape), [{ kind: "timeout", code: null, signal: null }], JSON.stringify(overrides));
	}
});

test("the connection machine runs the control session without a deadline and still cleans it up", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const child = fakeChild({ stdin: true });
	let answeredHello = false;
	child.stdin.onAnswer = (line) => {
		const frame = JSON.parse(line);
		if (frame.method !== "hello" || answeredHello) return;
		answeredHello = true;
		const answer = { v: 1, hostId: frame.hostId, generation: frame.generation, id: frame.id, ok: true, result: helloResult() };
		queueMicrotask(() => child.stdout.emit("data", Buffer.from(JSON.stringify(answer) + "\n")));
	};
	const { launcher: real, timers } = spiedLauncher(child);
	const requests = [];
	const launcher = {
		start(next) {
			requests.push(next);
			return real.start(next);
		},
	};
	const manual = createManualTimers();
	const manager = createSshConnectionManager({ helperSession: HELPER_SESSION, userDataDir: directory, client, launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0 });
	t.after(() => manager.dispose());

	const connected = await manager.connect(profile.id);
	assert.equal(connected.state, "ready", "the control session reaches ready");
	assert.equal(requests[0].lifetime, "session", "the control session states the session lifetime");
	assert.equal(requests[0].timeoutMs, undefined, "and carries no wall-clock budget at all");
	assert.deepEqual(timers.delays(), [], "the launcher armed no deadline for it");

	const pending = manager.request(profile.id, "fs.read", { path: ".", offset: 0, bytes: 4 });
	const writesBefore = child.stdin.writes.length;
	const disposing = manager.dispose();
	const rejected = await pending.then(
		() => undefined,
		(error) => error,
	);
	assert.ok(rejected !== undefined, "shutdown settles the in-flight request");
	assert.match(String(rejected.code ?? rejected.message), /REMOTE_CONNECTION_LOST/);
	await settle();
	assert.deepEqual(child.kills, [null], "the session is stopped through its paired stop path");
	timers.fireDelay(2000);
	timers.fireDelay(2000);
	await disposing;
	assert.deepEqual(child.kills, [null, "SIGKILL"], "the stop path converges without a deadline");
	assert.equal(child.stdin.writes.length, writesBefore, "a lost session never re-sends the request it did not answer");
});

test("our own pinned argv carries the ssh keepalive, so a session cannot hang on a black-hole peer", () => {
	const hostId = "b145de8c-6330-45be-8752-f20e8e270150";
	const target = { hostId, sshHost: "work", hostName: "server.example.invalid", user: "alice", port: 2222, pinAlias: "pideck-" + hostId, pinFile: join(tmpdir(), "pideck-keepalive-known-hosts"), connectTimeoutMs: 15000 };
	for (const kind of ["ssh-batch", "ssh-terminal", "scp"]) {
		const args = buildVerifiedSshArgv(target, kind);
		assert.ok(args.includes("ServerAliveInterval=15"), kind + ": the keepalive interval is our own argument");
		assert.ok(args.includes("ServerAliveCountMax=3"), kind + ": the keepalive count is our own argument");
	}
});

test("REAL: a genuine session process outlives the old 120 s ceiling", { skip: process.env.PIDECK_SSH_DEADLINE_REALTIME === "1" ? false : "opt-in: set PIDECK_SSH_DEADLINE_REALTIME=1 to spend about 155 s proving a real session survives past 120 s", timeout: 220_000 }, async () => {
	const launcher = LAUNCHER.createSshProcessLauncher();
	const handle = await launcher.start({ hostId: HOST_ID, generation: 1, invocation: { executable: process.execPath, args: ["-e", "setTimeout(function () {}, 600000)"], env: { PATH: process.env.PATH ?? "" } }, lifetime: "session", stdin: false });
	let exited = null;
	handle.onExit((report) => {
		exited = report;
	});
	const startedAt = Date.now();
	await new Promise((resolve) => setTimeout(resolve, 150_000));
	const elapsed = Date.now() - startedAt;
	assert.equal(exited, null, "a real session must still be alive after 150 s (the old ceiling killed it at 120 s); measured " + elapsed + " ms");
	await handle.stop("abort");
	assert.ok(exited !== null, "the paired stop path still ends the session");
	assert.equal(exited.kind, "stopped", "and reports it as stopped, not as a timeout");
});
