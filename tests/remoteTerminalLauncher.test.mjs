import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SshTerminalSessionLauncher } = loadTsCommonJs("src/main/terminal/SshTerminalSessionLauncher.ts");
const { buildRemoteTerminalInitFrame, REMOTE_TERMINAL_READY_MARKER, REMOTE_TERMINAL_START_MARKER, REMOTE_TERMINAL_ERROR_MARKER, REMOTE_TERMINAL_FRAME_RS, REMOTE_TERMINAL_FRAME_US, REMOTE_TERMINAL_FRAME_TERMINATOR } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { buildRemoteTerminalRunnerCommand } = loadTsCommonJs("src/main/remote/RemoteTerminalCommand.ts");
const PROJECT_ID = "project-a";
const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ROUTE = "c".repeat(64);
const BUNDLE = "a".repeat(64);
const TICKET = "b".repeat(32);
const DEPLOY_ROOT = "/home/dev/.pideck/remote-host";
const NODE = "/usr/local/bin/node";
const RUNNER = DEPLOY_ROOT + "/bundles/" + BUNDLE + "/terminal-runner.mjs";
const wireReady = REMOTE_TERMINAL_FRAME_RS + REMOTE_TERMINAL_READY_MARKER + REMOTE_TERMINAL_FRAME_US + REMOTE_TERMINAL_FRAME_TERMINATOR;
const wireStart = (shell) => REMOTE_TERMINAL_FRAME_RS + REMOTE_TERMINAL_START_MARKER + Buffer.from(shell, "utf8").toString("base64url") + REMOTE_TERMINAL_FRAME_US + REMOTE_TERMINAL_FRAME_TERMINATOR;
const wireError = (code) => REMOTE_TERMINAL_FRAME_RS + REMOTE_TERMINAL_ERROR_MARKER + code + REMOTE_TERMINAL_FRAME_US + REMOTE_TERMINAL_FRAME_TERMINATOR;
// Windows ConPTY strips RS/US but keeps CRLF; it also injects its own escape sequences around child output.
const conptyReady = REMOTE_TERMINAL_READY_MARKER + REMOTE_TERMINAL_FRAME_TERMINATOR;
const conptyStart = (shell) => REMOTE_TERMINAL_START_MARKER + Buffer.from(shell, "utf8").toString("base64url") + REMOTE_TERMINAL_FRAME_TERMINATOR;

function fakePty() {
	const data = [],
		exits = [],
		writes = [],
		killed = [];
	const pty = {
		write: (value) => writes.push(value),
		resize: () => undefined,
		pause: () => undefined,
		resume: () => undefined,
		kill: () => killed.push("kill"),
		onData: (callback) => {
			data.push(callback);
			return { dispose: () => undefined };
		},
		onExit: (callback) => {
			exits.push(callback);
			return { dispose: () => undefined };
		},
	};
	const emitData = (value) => data.forEach((callback) => callback(value));
	const emitExit = (code) => exits.forEach((callback) => callback({ exitCode: code }));
	return { pty, writes, killed, emitData, emitExit };
}

function fixture(overrides = {}) {
	const calls = [];
	const fake = fakePty();
	const session = {
		hostId: HOST_ID,
		hostRouteDigest: ROUTE,
		nodePath: NODE,
		deployRoot: DEPLOY_ROOT,
		bundleSha256: BUNDLE,
		request: async (method, params) => {
			calls.push({ method, params });
			if (overrides.request) return overrides.request(method, params);
			return { ticketRef: TICKET };
		},
		withTerminalInvocation: async (command, launch) => {
			calls.push({ command });
			const invocation = { executable: "/usr/bin/ssh", args: ["-tt", "-e", "none", "--", "host", command], env: { PATH: "/usr/bin" } };
			return launch(invocation, async () => undefined);
		},
		...overrides.session,
	};
	const callbacks = { data: [], exits: [] };
	const launcher = new SshTerminalSessionLauncher({ spawn: () => fake.pty, handshakeTimeoutMs: overrides.handshakeTimeoutMs ?? 2000 });
	const start = (extra = {}) => launcher.start({ session, projectId: PROJECT_ID, hostId: HOST_ID, signal: new AbortController().signal, callbacks: { data: (value) => callbacks.data.push(value), exit: (code) => callbacks.exits.push(code) }, ...extra });
	return { session, calls, fake, callbacks, start, launcher };
}
function tick() {
	return new Promise((resolve) => setImmediate(resolve));
}

test("the ssh command carries only the trusted node plus the active bundle runner", async () => {
	const f = fixture();
	const pending = f.start();
	await tick();
	const command = f.calls.find((call) => call.command).command;
	assert.equal(command, buildRemoteTerminalRunnerCommand({ runnerPath: RUNNER, nodePath: NODE }));
	assert.ok(command.includes(NODE) && command.includes(RUNNER));
	for (const forbidden of [PROJECT_ID, HOST_ID, TICKET, "/project", "bash", "/tmp"]) assert.equal(command.includes(forbidden), false, "the ssh command must not carry " + forbidden);
	const prepare = f.calls.find((call) => call.method === "terminal.prepare");
	assert.deepEqual(JSON.parse(JSON.stringify(prepare.params)), { kind: "project", projectId: PROJECT_ID, hostId: HOST_ID, routeDigest: ROUTE });
	f.fake.emitData(wireReady);
	f.fake.emitData(wireStart("/bin/bash") + "$ ");
	const resource = await pending;
	assert.equal(f.fake.writes.length, 1, "exactly one init frame is written");
	assert.equal(f.fake.writes[0], buildRemoteTerminalInitFrame(TICKET));
	assert.deepEqual(f.callbacks.data, ["$ "], "the remainder after START is delivered exactly once");
	assert.equal(resource.shell, "/bin/bash", "the selected login shell is recorded in the main-side result");
});

test("READY may be split across chunks; terminal output after START is forwarded and handshake bytes are stripped", async () => {
	const f = fixture();
	const pending = f.start();
	await tick();
	f.fake.emitData(wireReady.slice(0, 7));
	await tick();
	assert.equal(f.fake.writes.length, 0, "nothing is written before the complete READY frame");
	f.fake.emitData(wireReady.slice(7) + "ignored-echo");
	assert.equal(f.fake.writes.length, 1);
	f.fake.emitData(wireStart("/bin/zsh") + "prompt$ ");
	await pending;
	f.fake.emitData("live output");
	assert.deepEqual(f.callbacks.data, ["prompt$ ", "live output"]);
});

test("ConPTY loss simulation: RS/US stripped, CRLF kept, ConPTY noise around frames, split chunks", async () => {
	const f = fixture();
	const pending = f.start();
	await tick();
	// Windows node-pty strips RS/US and wraps the child output in its own control sequences.
	f.fake.emitData("\u001b[?25h\u001b]0;C:\\remote\u0007" + REMOTE_TERMINAL_READY_MARKER.slice(0, 11));
	await tick();
	assert.equal(f.fake.writes.length, 0, "a partial marker writes nothing");
	f.fake.emitData(REMOTE_TERMINAL_READY_MARKER.slice(11) + REMOTE_TERMINAL_FRAME_TERMINATOR + "\u001b[?25h");
	assert.equal(f.fake.writes.length, 1, "READY without RS/US is enough for the init frame");
	assert.equal(f.fake.writes[0], buildRemoteTerminalInitFrame(TICKET));
	f.fake.emitData("\u001b]0;title\u0007" + conptyStart("/bin/bash") + "prompt$ ");
	const resource = await pending;
	assert.deepEqual(f.callbacks.data, ["prompt$ "], "only post-START bytes are delivered, exactly once");
	assert.equal(resource.shell, "/bin/bash");
	// Linux PTY with ONLCR turns the runner's CRLF into CR CR LF: tolerated, with RS/US present.
	const linux = fixture();
	const linuxPending = linux.start();
	await tick();
	linux.fake.emitData(REMOTE_TERMINAL_FRAME_RS + REMOTE_TERMINAL_READY_MARKER + REMOTE_TERMINAL_FRAME_US + "\r\r\n");
	assert.equal(linux.fake.writes.length, 1);
	linux.fake.emitData(REMOTE_TERMINAL_FRAME_RS + REMOTE_TERMINAL_START_MARKER + Buffer.from("/bin/zsh", "utf8").toString("base64url") + REMOTE_TERMINAL_FRAME_US + "\r\r\n" + "linux$ ");
	await linuxPending;
	assert.deepEqual(linux.callbacks.data, ["linux$ "]);
});

test("an ERROR frame maps to its stable code and disposes the PTY exactly once", async () => {
	const f = fixture();
	const pending = f.start();
	await tick();
	f.fake.emitData(conptyReady);
	f.fake.emitData("\u001b]0;title\u0007" + wireError("TERMINAL_TICKET_EXPIRED"));
	await assert.rejects(pending, /TERMINAL_TICKET_EXPIRED/);
	assert.deepEqual(f.fake.killed, ["kill"]);
	f.fake.emitExit(1);
	assert.deepEqual(f.callbacks.exits, []);
});

test("a missing START times out, an early exit fails, and an oversized pre-start buffer fails closed", async () => {
	const timeout = fixture({ handshakeTimeoutMs: 50 });
	const pending = timeout.start();
	await tick();
	timeout.fake.emitData(wireReady);
	await assert.rejects(pending, /REMOTE_TERMINAL_START_TIMEOUT/);
	const early = fixture();
	const earlyPending = early.start();
	await tick();
	early.fake.emitExit(1);
	await assert.rejects(earlyPending, /REMOTE_TERMINAL_START_FAILED/);
	const oversized = fixture();
	const oversizedPending = oversized.start();
	await tick();
	oversized.fake.emitData("x".repeat(40 * 1024));
	await assert.rejects(oversizedPending, /REMOTE_TERMINAL_START_FAILED/);
});

test("a ticket refusal from the helper is passed through and no PTY is spawned", async () => {
	const f = fixture({
		request: async () => {
			throw new Error("TERMINAL_TICKET_UNAVAILABLE");
		},
	});
	await assert.rejects(f.start(), /TERMINAL_TICKET_UNAVAILABLE/);
	assert.equal(
		f.calls.some((call) => call.command),
		false,
	);
	assert.deepEqual(f.fake.killed, []);
});

test("a session whose live identity does not match the target is refused before any helper request", async () => {
	const f = fixture({ session: { hostId: "00000000-0000-4000-8000-000000000000" } });
	await assert.rejects(f.start(), /REMOTE_TERMINAL_TARGET_CHANGED/);
	assert.equal(f.calls.length, 0);
});

test("abort and a failing beforeSpawn release the PTY without publishing a terminal", async () => {
	const controller = new AbortController();
	const f = fixture();
	const pending = f.start({ signal: controller.signal });
	await tick();
	controller.abort();
	await assert.rejects(pending, /REMOTE_TERMINAL_CLOSED/);
	assert.deepEqual(f.fake.killed, ["kill"]);
	const blocked = fixture();
	let spawned = 0;
	const failing = blocked.start({
		beforeSpawn: () => {
			spawned += 1;
			throw new Error("REMOTE_TERMINAL_TARGET_CHANGED");
		},
	});
	await assert.rejects(failing, /REMOTE_TERMINAL_TARGET_CHANGED/);
	assert.equal(spawned, 1);
	assert.equal(blocked.fake.killed.length, 0, "nothing was spawned, so nothing is killed");
});

test("the runner command builder refuses anything that is not the active bundle runner path", () => {
	for (const runnerPath of [
		"relative/terminal-runner.mjs",
		"/home/dev/terminal-runner.mjs",
		"/home/dev/.pideck/remote-host/bundles/Z".repeat(1) + "a".repeat(64) + "/terminal-runner.mjs",
		"/home/dev/.pideck/remote-host/bundles/" + BUNDLE + "/runner.mjs",
		"/home/dev/.pideck/remote-host/bundles/" + BUNDLE + "/terminal-runner.mjs\u0000",
	]) {
		assert.throws(() => buildRemoteTerminalRunnerCommand({ runnerPath, nodePath: NODE }), /REMOTE_TERMINAL_OPTIONS_INVALID/);
	}
});
