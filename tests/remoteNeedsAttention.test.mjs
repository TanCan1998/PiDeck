import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createManualTimers, createPinnedClient, createPinnedHostFixture, flushMicrotasks } from "./helpers/sshPinnedHostFixture.mjs";

const { createSshConnectionManager } = loadTsCommonJs("src/main/remote/SshConnectionManager.ts");
const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");

/** The verified bootstrap every production call site has to pass on. */
const HELPER_SESSION = { nodePath: "/usr/bin/node", deployRoot: "/home/dev/.pideck/remote-host", bundleSha256: "a".repeat(64) };

/*
 * F4 independent verification of the needs-attention semantics (task-15, G2).
 *
 * The reducer is a pure state machine, so it is attacked exhaustively here instead of by sampling a few
 * paths: every event is applied to a host that is already in needs-attention and the invariant has to hold
 * for all of them at once. Three things a producer's own happy-path test cannot prove about itself:
 *
 * 1. Terminality: no event except an explicit user retry may leave needs-attention, and a rejected event
 *    must come back with the *same state object* (so nothing downstream re-renders or is silently cleared).
 * 2. A healthy host is never locked: the only exit actually starts a fresh attempt with a new generation,
 *    so a single failed probe is recoverable; and a shutdown latch keeps blocking that exit afterwards.
 * 3. Nothing that enters needs-attention may carry foreign text: a hostile code collapses to a stable one.
 *
 * The G2 change under test is the new entry from a state with no attempt in flight (disconnected/offline):
 * root drift can happen while nothing is connecting, and the reducer used to reject that transition.
 */

const { createConnectionMachine, isConnectionMachineShutdown, reduceConnectionEvent } = loadTsCommonJs("src/main/remote/RemoteHostConnectionState.ts");

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

const deps = () => ({ now: () => 1000, random: () => 0 });
const step = (state, event) => reduceConnectionEvent(state, event, deps());

/** Event builders, each taking the generation it must echo. */
const events = {
	begin: () => ({ type: "begin-attempt" }),
	phase: (generation) => ({ type: "phase-entered", generation, phase: "openssh" }),
	connected: (generation) => ({ type: "connected", generation }),
	degraded: (generation, code = "SSH_CONNECTION_DEGRADED") => ({ type: "degraded", generation, code }),
	lost: (generation, code = "SSH_CONNECTION_LOST") => ({ type: "disconnected", generation, code }),
	due: (generation) => ({ type: "reconnect-due", generation }),
	offline: (code) => ({ type: "offline", ...(code === undefined ? {} : { code }) }),
	fatal: (generation, code = "SSH_AUTH_DENIED") => ({ type: "needs-attention", generation, code }),
	retry: () => ({ type: "user-retry" }),
	shutdown: () => ({ type: "shutdown" }),
};

/** Named events that carry no generation, so the fencing check cannot drop them. */
const INTENT_EVENTS = ["begin", "offline", "retry", "shutdown"];
const FENCED_EVENTS = ["phase", "connected", "degraded", "lost", "due", "fatal"];
const ALL_EVENT_NAMES = [...FENCED_EVENTS, ...INTENT_EVENTS];

function buildEvent(name, generation, code) {
	if (name === "fatal") return events.fatal(generation, code);
	return events[name](...(name === "degraded" || name === "lost" ? [generation] : name === "offline" ? [code] : [generation]));
}

/** Reach an attempt in flight: the first generation, waiting in a staged phase. */
function reachAttempt(code) {
	const started = step(createConnectionMachine(HOST), events.begin());
	assert.equal(started.state.state, "connecting");
	if (code === "openssh") return step(started.state, events.phase(started.state.generation)).state;
	return started.state;
}

function reachReady() {
	const progressed = reachAttempt("openssh");
	const result = step(progressed, events.connected(progressed.generation));
	assert.equal(result.state.state, "ready");
	return result.state;
}

function reachDegraded() {
	const ready = reachReady();
	return step(ready, events.degraded(ready.generation)).state;
}

function reachReconnecting() {
	const ready = reachReady();
	const result = step(ready, events.lost(ready.generation));
	assert.equal(result.state.state, "reconnecting");
	return result.state;
}

function reachFatal(from) {
	const source = from();
	const result = step(source, events.fatal(source.generation));
	assert.equal(result.state.state, "needs-attention", "the fixture must reach needs-attention");
	return result.state;
}

/** Every way a host can be sitting in the terminal state, so the invariant is checked for each of them. */
function terminalStates() {
	return {
		"from an attempt in flight": reachFatal(() => reachAttempt()),
		"from ready": reachFatal(reachReady),
		"from degraded": reachFatal(reachDegraded),
		"from reconnecting": reachFatal(reachReconnecting),
	};
}

test("needs-attention is terminal: no event but an explicit retry may move it, and rejections preserve identity", () => {
	for (const [label, terminal] of Object.entries(terminalStates())) {
		assert.equal(terminal.state, "needs-attention", label);
		for (const name of ALL_EVENT_NAMES) {
			const event = buildEvent(name, terminal.generation, "SSH_AUTH_DENIED");
			const result = step(terminal, event);
			if (name === "retry") {
				assert.notEqual(result.state.state, "needs-attention", label + " + user-retry must be able to leave");
				assert.equal(result.state.state, "connecting");
				assert.ok(
					result.effects.some((effect) => effect.kind === "start-attempt"),
					label + " + user-retry must start an attempt",
				);
				continue;
			}
			if (name === "shutdown") {
				// Shutdown is the one other legal outcome: the state stays, the machine latches.
				assert.equal(result.state.state, "needs-attention", label + " + shutdown must not launder the terminal state");
				assert.equal(isConnectionMachineShutdown(result.state), true);
				continue;
			}
			assert.equal(result.state.state, "needs-attention", label + " + " + name + " moved the terminal state");
			assert.equal(result.state, terminal, label + " + " + name + " must return the same state object");
			assert.equal(result.effects.length, 0, label + " + " + name + " must not emit an effect");
		}
	}
});

test("G2: an externally verified fatal condition enters needs-attention with no attempt in flight", () => {
	// Root drift can be observed while the host is idle or already offline. Until G2 the reducer rejected
	// that transition, so a drifted host stayed silently disconnected instead of asking the user to look.
	for (const [label, source] of [
		["disconnected", createConnectionMachine(HOST)],
		["offline", step(reachReady(), events.offline()).state],
	]) {
		assert.notEqual(source.state, "needs-attention", label + " fixture");
		const result = step(source, events.fatal(source.generation, "SSH_PROJECT_ROOT_CHANGED"));
		assert.equal(result.state.state, "needs-attention", label + " must be able to enter needs-attention, got " + JSON.stringify(result.state));
		assert.equal(result.state.lastCode, "SSH_PROJECT_ROOT_CHANGED", label + " must carry the drift code");
	}
});

test("G2: entering needs-attention from an idle host does not make it escapable or clearable", () => {
	for (const [label, source] of [
		["disconnected", createConnectionMachine(HOST)],
		["offline", step(reachReady(), events.offline()).state],
	]) {
		const entered = step(source, events.fatal(source.generation, "SSH_PROJECT_ROOT_CHANGED")).state;
		assert.equal(entered.state, "needs-attention", label);
		for (const name of ALL_EVENT_NAMES.filter((candidate) => candidate !== "retry" && candidate !== "shutdown")) {
			const result = step(entered, buildEvent(name, entered.generation, "SSH_PROJECT_ROOT_CHANGED"));
			assert.equal(result.state.state, "needs-attention", label + " + " + name + " cleared needs-attention");
			assert.equal(result.state, entered, label + " + " + name + " must be rejected with the same object");
		}
		// The one exit still works, and it is a real attempt rather than a no-op.
		const retried = step(entered, events.retry());
		assert.equal(retried.state.state, "connecting", label + " + user-retry");
		assert.equal(retried.state.generation, entered.generation + 1);
		assert.ok(
			retried.effects.some((effect) => effect.kind === "start-attempt"),
			label,
		);
	}
});

test("a hostile code collapses to a stable one and never travels", () => {
	const hostile = ["", "   ", "boom: /home/user/secret/project", "SSH_lower_case", "x".repeat(200), 42, null, undefined, "DROP TABLE sessions;--"];
	for (const code of hostile) {
		const ready = reachReady();
		// The event shape promises a string; JS callers (and remote text) can still hand it anything.
		const result = reduceConnectionEvent(ready, { type: "needs-attention", generation: ready.generation, code }, deps());
		assert.equal(result.state.state, "needs-attention", JSON.stringify(code));
		assert.match(result.state.lastCode, STABLE_CODE, JSON.stringify(code) + " produced " + JSON.stringify(result.state.lastCode));
		assert.ok(!String(result.state.lastCode).includes("/"), JSON.stringify(code) + " leaked a path into lastCode");
		assert.ok(!String(result.state.lastCode).toLowerCase().includes("drop table"), JSON.stringify(code) + " leaked payload text into lastCode");
	}
});

test("generation fencing still protects the new needs-attention entry", () => {
	const attempt = reachAttempt();
	const stale = events.fatal(attempt.generation - 1, "SSH_PROJECT_ROOT_CHANGED");
	assert.equal(step(attempt, stale).state, attempt, "a stale generation must be dropped");
	const future = events.fatal(attempt.generation + 1, "SSH_PROJECT_ROOT_CHANGED");
	assert.equal(step(attempt, future).state, attempt, "a future generation must be dropped");
	const current = step(attempt, events.fatal(attempt.generation, "SSH_PROJECT_ROOT_CHANGED"));
	assert.equal(current.state.state, "needs-attention");
	// The idle entry is fenced too: an event naming another generation must not move an idle host.
	const idle = createConnectionMachine(HOST);
	assert.equal(step(idle, events.fatal(idle.generation + 1, "SSH_PROJECT_ROOT_CHANGED")).state, idle);
	assert.equal(step(idle, events.fatal(idle.generation - 1, "SSH_PROJECT_ROOT_CHANGED")).state, idle);
});

test("shutdown latch wins over the exit from needs-attention", () => {
	for (const [label, terminal] of Object.entries(terminalStates())) {
		const shut = step(terminal, events.shutdown());
		assert.equal(shut.state.state, "needs-attention", label);
		assert.equal(isConnectionMachineShutdown(shut.state), true, label);
		assert.ok(
			shut.effects.some((effect) => effect.kind === "shutdown"),
			label,
		);
		assert.ok(
			shut.effects.some((effect) => effect.kind === "cancel-reconnect"),
			label,
		);
		// After the latch nothing revives the machine: not a retry, not a connected report, not an attempt.
		for (const name of ALL_EVENT_NAMES) {
			const result = step(shut.state, buildEvent(name, shut.state.generation, "SSH_PROJECT_ROOT_CHANGED"));
			assert.equal(result.state, shut.state, label + " + " + name + " after the latch must be ignored");
			assert.equal(result.effects.length, 0, label + " + " + name + " after the latch must not emit");
		}
	}
});

test("offline events cannot launder needs-attention away, with or without a code", () => {
	for (const [label, terminal] of Object.entries(terminalStates())) {
		for (const code of [undefined, "SSH_CONNECTION_OFFLINE", "boom /secret"]) {
			const result = step(terminal, events.offline(code));
			assert.equal(result.state, terminal, label + " + offline(" + String(code) + ") must be rejected");
		}
	}
});

test("the retry exit mints a new generation, counts the retry, and cannot storm at zero delay", () => {
	const ready = reachReady();
	const terminal = step(ready, events.fatal(ready.generation, "SSH_AUTH_DENIED")).state;
	const first = step(terminal, events.retry());
	assert.equal(first.state.generation, terminal.generation + 1);
	assert.equal(first.state.attempts, 1, "a retry counts against the backoff rung");
	// Failing again and retrying again stays an attempt, never a silently dropped event.
	const again = step(first.state, events.fatal(first.state.generation, "SSH_AUTH_DENIED")).state;
	assert.equal(again.state, "needs-attention");
	const second = step(again, events.retry());
	assert.equal(second.state.state, "connecting");
	// Entering needs-attention resets the retry counter by design: the terminal state replaces the ladder,
	// and only a user retry can leave it, so a failed attempt returns here instead of scheduling a wait.
	assert.equal(second.state.attempts, 1, "the fresh retry starts a new ladder rung, not a storm");
	assert.equal(first.effects.filter((effect) => effect.kind === "schedule-reconnect").length, 0, "a retry must attempt immediately, never arm a wait");
});

test("a healthy host is not locked by one failure and the retry path is reachable from every entry", () => {
	// The falsification target: "one failed probe locks a healthy host and even user-retry cannot come back".
	for (const [label, terminal] of Object.entries(terminalStates())) {
		const retried = step(terminal, events.retry());
		assert.equal(retried.state.state, "connecting", label + " must recover on retry");
		assert.equal(retried.state.latched, false, label + " must not be latched by entering needs-attention");
		// And the recovered attempt can actually reach ready again.
		const connected = step(step(retried.state, events.phase(retried.state.generation)).state, events.connected(retried.state.generation));
		assert.equal(connected.state.state, "ready", label + " must be able to reach ready after a retry");
	}
});

/*
 * Manager half: the external report and the retained handshake home are exercised against the real
 * SshConnectionManager (fake launcher + pinned fixture), because these are the two things the service and
 * the session scanner consume. A report must not launch a process, must not be able to smuggle text into
 * diagnostics, and must still leave the user-retry exit open; the home must only ever be a usable path.
 */

function createFakeLauncher(options = {}) {
	const requests = [];
	return {
		requests,
		launcher: {
			async start(request) {
				requests.push(request);
				// The helper reports the root it was actually confined to, and the attempt compares that against the
				// root the session asked for. Echoing the launched `--root` token keeps the fake honest for a rooted
				// session instead of hard-coding the host-only `null`.
				const command = (request.invocation?.args ?? []).join(" ");
				const requestedRoot = /--root '([^']*)'/.exec(command);
				const askedRoot = requestedRoot === null ? null : requestedRoot[1];
				// A real helper reports the canonical path it resolved at startup, so the remote side of a drift is
				// modelled here: the requested root token still looks the same while the path now resolves elsewhere.
				const canonical = typeof options.canonicalRoot === "function" && askedRoot !== null ? options.canonicalRoot(askedRoot) : askedRoot;
				const reportedRoot = Object.hasOwn(options, "root") ? options.root : canonical;
				const emitter = new EventEmitter();
				const exitListeners = new Set();
				let answered = false;
				return {
					pid: 4321,
					write(line) {
						const frame = JSON.parse(line);
						if (options.answerHello === false || frame.method !== "hello" || answered) return;
						answered = true;
						const result = {
							protocolVersion: 1,
							platform: "linux",
							arch: "x64",
							home: Object.hasOwn(options, "home") ? options.home : "/home/dev",
							root: reportedRoot,
							capabilities: ["echo", "fs.stat", "fs.list", "fs.read"],
							helperVersion: "1.6.0",
							nodeVersion: "v22.14.0",
							pid: 321,
						};
						queueMicrotask(() => emitter.emit("stdout", JSON.stringify({ v: 1, hostId: frame.hostId, generation: frame.generation, id: frame.id, ok: true, result })));
					},
					onExit(listener) {
						exitListeners.add(listener);
						return () => exitListeners.delete(listener);
					},
					onStdoutLine(listener) {
						emitter.on("stdout", listener);
						return () => emitter.off("stdout", listener);
					},
					onStderrLine() {
						return () => undefined;
					},
					async stop() {
						for (const listener of [...exitListeners]) listener({ kind: "stopped", code: null, signal: null });
					},
				};
			},
		},
	};
}

function createManager(options) {
	return createSshConnectionManager({ helperSession: HELPER_SESSION, ...options });
}

async function connectAndSettle(manager, hostId) {
	const pending = manager.connect(hostId);
	await flushMicrotasks();
	await pending;
	await flushMicrotasks();
	return manager.getState(hostId);
}

test("an external fatal report moves an idle host to needs-attention without launching anything", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const fake = createFakeLauncher();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
	t.after(() => manager.dispose());

	assert.equal(manager.getState(profile.id).state, "disconnected", "fixture starts idle");
	manager.reportNeedsAttention(profile.id, "SSH_PROJECT_ROOT_CHANGED");
	const reported = manager.getState(profile.id);
	assert.equal(reported.state, "needs-attention");
	assert.equal(reported.lastCode, "SSH_PROJECT_ROOT_CHANGED");
	assert.equal(fake.requests.length, 0, "an external report must not launch a process");

	// A hostile code must be folded, and the text must not reach diagnostics either.
	manager.reportNeedsAttention(profile.id, "boom /home/dev/secret: EACCES");
	const folded = manager.getState(profile.id);
	assert.equal(folded.state, "needs-attention");
	assert.match(folded.lastCode, STABLE_CODE, "the report code must stay in the stable vocabulary");
	assert.ok(!folded.lastCode.includes("/"), "a path must never travel in lastCode");
	const diagnostics = JSON.stringify(Array.from(manager.listDiagnostics(profile.id)));
	assert.ok(!diagnostics.includes("EACCES"), "free text leaked into diagnostics");
	assert.ok(!diagnostics.includes("/home/dev/secret"), "a path leaked into diagnostics");

	// The report is actionable, not a lock. `connect()` is the begin-an-attempt entry and is deliberately
	// rejected from a terminal state; the user-retry entry is `retry()`, and it has to launch an attempt.
	assert.equal((await manager.connect(profile.id)).state, "needs-attention", "begin-attempt must not silently clear a terminal state");
	assert.equal(fake.requests.length, 0, "a rejected connect must not launch anything");
	const pending = manager.retry(profile.id);
	await flushMicrotasks();
	const recovered = await pending;
	await flushMicrotasks();
	assert.equal(fake.requests.length, 1, "the user retry must launch a fresh attempt");
	assert.equal(recovered.state, "ready", "with the cause fixed the host must come back");
});

test("the shutdown latch outranks an external report and the retry exit", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const fake = createFakeLauncher();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
	manager.reportNeedsAttention(profile.id, "SSH_PROJECT_ROOT_CHANGED");
	assert.equal(manager.getState(profile.id).state, "needs-attention");
	// An explicit shutdown (the app-exit path) latches the machine while keeping the terminal state, so a
	// probe that resolves late - `reportNeedsAttention` is exactly that shape - must be ignored, not land.
	await manager.disconnect(profile.id, "shutdown");
	const latched = manager.getState(profile.id);
	assert.equal(latched.latched, true, "a shutdown must latch the machine");
	assert.equal(latched.state, "needs-attention", "shutdown must not launder the terminal state");
	manager.reportNeedsAttention(profile.id, "SSH_AUTH_DENIED");
	assert.equal(manager.getState(profile.id), latched, "a report after the latch must not move the machine");
	assert.equal((await manager.retry(profile.id)).state, "needs-attention", "a retry after the latch must not revive the machine");
	assert.equal(fake.requests.length, 0, "nothing may launch after the latch");
});

test("an unknown host id is answered like any other host, without throwing", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const fake = createFakeLauncher();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
	t.after(() => manager.dispose());
	assert.doesNotThrow(() => manager.reportNeedsAttention("not-a-host-id", "SSH_AUTH_DENIED"));
	assert.equal(manager.getState("not-a-host-id").state, "needs-attention");
});

test("the handshake home is retained per host and dropped when the session is released", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const fake = createFakeLauncher();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
	t.after(() => manager.dispose());

	assert.equal(manager.getHome(profile.id), undefined, "no handshake yet means no home");
	assert.equal(manager.getHome("00000000-0000-4000-8000-000000000000"), undefined, "an unknown host has no home");
	assert.equal((await connectAndSettle(manager, profile.id)).state, "ready");
	assert.equal(manager.getHome(profile.id), "/home/dev", "the successful handshake home must be readable");
	await manager.disconnect(profile.id, "shutdown");
	assert.equal(manager.getHome(profile.id), undefined, "a released session must not keep naming a home");
});

test("a malformed handshake home is never handed on", async (t) => {
	const cases = [
		["a relative path", "relative/home"],
		["an empty string", ""],
		["a control byte", "/home/de\u0000v"],
		["a number", 42],
		["a null", null],
		["an over-long path", "/home/" + "x".repeat(5000)],
	];
	for (const [label, home] of cases) {
		const { directory, profile } = await createPinnedHostFixture(t);
		const { client } = createPinnedClient(profile.id);
		const fake = createFakeLauncher({ home });
		const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
		try {
			await connectAndSettle(manager, profile.id);
			const value = manager.getHome(profile.id);
			assert.equal(value, undefined, label + " must not be handed on, got " + JSON.stringify(value));
		} finally {
			await manager.dispose();
		}
	}
});

/*
 * Service half: the two things G2 adds end to end. The manager is the production one (only the launcher,
 * the bootstrap and the root probe are substituted), so the state the service reports is the state the
 * reducer produced, not a fake agreeing with itself.
 */

async function serviceHarness(t, options = {}) {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const control = { canonical: undefined, fails: false, verifyCalls: [], bootstraps: 0, rootMap: new Map() };
	const fake = createFakeLauncher({
		...(Object.hasOwn(options, "home") ? { home: options.home } : {}),
		canonicalRoot: (requested) => control.rootMap.get(requested) ?? requested,
	});
	const ports = {
		bootstrap: async () => {
			control.bootstraps += 1;
			return { bundleSha256: "a".repeat(64), deployRoot: "/home/dev/.pideck/remote-host" };
		},
		resolveNode: async () => ({ nodePath: "/usr/bin/node", version: "v22.14.0", probed: 1 }),
		createSentinel: () => "sentinel00000001",
		createNonce: () => "nonce-000000000001",
		verifyRoot: async ({ hostId, userPath }) => {
			control.verifyCalls.push({ hostId, userPath });
			if (control.fails) throw new Error("REMOTE_BROWSE_ROOT_UNRESOLVED");
			return { canonicalPath: control.canonical === undefined ? userPath : control.canonical };
		},
	};
	const states = [];
	const service = createRemoteHostConnectionService({
		userDataDir: directory,
		client,
		launcher: fake.launcher,
		nodePath: "/usr/bin/node",
		ports,
		onStateChange: (entry) => states.push({ hostId: entry.hostId, state: entry.state.state, code: entry.state.lastCode }),
	});
	t.after(() => service.dispose());
	const read = (root) => service.withProjectSession(profile.id, root, async () => "ran");
	return { directory, profile, client, fake, control, service, states, read };
}

test("remoteHome answers only for a live, verified session and never throws", async (t) => {
	const { profile, service } = await serviceHarness(t);
	assert.equal(await service.remoteHome(profile.id), undefined, "no session yet means no home");
	assert.equal(await service.remoteHome("not-a-host-id"), undefined, "an unknown host must not throw or guess");
	assert.equal(await service.remoteHome(undefined), undefined, "a missing id must not throw");

	const connected = await service.connect(profile.id);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	assert.equal(connected.state.state, "ready");
	assert.equal(await service.remoteHome(profile.id), "/home/dev", "the handshake home must be readable once ready");

	await service.disconnect(profile.id, "abort");
	assert.equal(await service.remoteHome(profile.id), undefined, "a released session must not keep naming a home");
});

test("a malformed handshake home is re-validated and never handed on", async (t) => {
	for (const home of ["relative/home", "", "/home/de\u0000v", 42, null, "/home/" + "x".repeat(5000)]) {
		const { profile, service } = await serviceHarness(t, { home });
		await service.connect(profile.id);
		const value = await service.remoteHome(profile.id);
		assert.equal(value, undefined, JSON.stringify(home) + " must not be handed on, got " + JSON.stringify(value));
	}
});

test("a drifted root drives the host into needs-attention through the reconnect handshake, and only user retry can leave", async (t) => {
	const { profile, service, control, states, read } = await serviceHarness(t);
	const first = await read("/srv/app");
	assert.equal(first.ok, true, "the fixture must establish a session first: " + JSON.stringify(first));
	assert.deepEqual(
		control.verifyCalls.map((call) => call.userPath),
		["/srv/app"],
	);

	// The session is released, and by the time it is re-established the confirmed root resolves somewhere
	// else on the remote: the helper reports the new canonical path, which is what a re-pointed link looks
	// like from here. The handshake compares it against the root the session asked for.
	await service.disconnect(profile.id, "abort");
	assert.equal((await read("/srv/app")).code, "SSH_HOST_DISCONNECTED", "an explicit disconnect outranks a background read");
	control.rootMap.set("/srv/app", "/srv/app-moved");
	const reconnected = await service.connect(profile.id);
	assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
	assert.equal(reconnected.state.state, "needs-attention", "a root mismatch is fatal and must become actionable");
	assert.ok(
		states.some((entry) => entry.state === "needs-attention" && entry.code === "SSH_HELPER_ROOT_MISMATCH"),
		"the fatal handshake code must be the state's own reason: " + JSON.stringify(states),
	);
	assert.equal(await service.remoteHome(profile.id), undefined, "a terminal host has no live home");

	// A read must not clear the terminal state, and must report the terminal reason rather than a generic one.
	const refused = await read("/srv/app");
	assert.equal(refused.ok, false, JSON.stringify(refused));
	assert.equal(refused.code, "SSH_HELPER_ROOT_MISMATCH", "the terminal code must be reported back");

	// The falsification target: a user retry has to be able to leave the terminal state once the cause is gone.
	control.rootMap.clear();
	const recovered = await service.connect(profile.id);
	assert.equal(recovered.ok, true, "user retry must not be locked out: " + JSON.stringify(recovered));
	assert.equal(recovered.state.state, "ready", "with the cause fixed the host must come back: " + JSON.stringify(recovered));
	assert.equal(await service.remoteHome(profile.id), "/home/dev", "the recovered handshake home must be readable");
	assert.equal((await read("/srv/app")).ok, true, "the recovered host must serve reads again");
});

test("a drift observed with no session yet is refused without inventing one", async (t) => {
	const { profile, service, control, states, fake, read } = await serviceHarness(t);
	control.canonical = "/srv/app-moved";
	const refused = await read("/srv/app");
	assert.equal(refused.ok, false, JSON.stringify(refused));
	assert.equal(refused.code, "SSH_PROJECT_ROOT_CHANGED");
	assert.equal(control.bootstraps, 0, "a boundary that failed verification must not be bootstrapped");
	assert.equal(fake.requests.length, 0, "no process may be launched for a boundary that drifted");
	assert.deepEqual(states, [], "no machine exists yet, so no state may be invented for it");
	assert.equal(await service.remoteHome(profile.id), undefined);
});

test("an unresolvable root fails closed with no session and no invented state", async (t) => {
	const { profile, service, control, states, fake, read } = await serviceHarness(t);
	control.fails = true;
	const refused = await read("/srv/app");
	assert.equal(refused.ok, false, JSON.stringify(refused));
	assert.equal(refused.code, "SSH_PROJECT_ROOT_UNRESOLVED");
	assert.equal(control.bootstraps, 0, "an unresolvable boundary must not be bootstrapped");
	assert.equal(fake.requests.length, 0, "no process may be launched for a boundary that could not be verified");
	assert.deepEqual(states, [], "no machine exists yet, so a probe failure must not invent a state for it");
	assert.equal(await service.remoteHome(profile.id), undefined);
});
