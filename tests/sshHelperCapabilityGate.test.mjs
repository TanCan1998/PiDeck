import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createManualTimers, createPinnedClient, createPinnedHostFixture } from "./helpers/sshPinnedHostFixture.mjs";

/*
 * Capability gate for the helper handshake (task-32, P4.0 pre-work).
 *
 * hello has always reported a capability list, and until now nothing consumed it: a deployed helper that
 * cannot serve an operation this client needs was discovered when the call failed (METHOD_NOT_FOUND) or,
 * worse, when a feature silently answered nothing. These tests pin the gate the client now applies at the
 * handshake boundary:
 *
 *   - a helper that lacks a capability every ready host is expected to serve must never be reported ready:
 *     the attempt fails closed, the terminal state carries SSH_HELPER_CAPABILITY_MISSING, the diagnostics
 *     name the missing operation, and nothing is retried (a capability cannot appear by reconnecting);
 *   - a complete list, and a list carrying capabilities this client has never heard of, stay ready
 *     (additive/forward compatible: an older client must not reject a newer helper);
 *   - a capability list that is not an array keeps its existing handshake-invalid behaviour.
 *
 * The three read-only workspace operations are the required set because every ready host is used through
 * them (session scanning and workspace reads). fs.searchNames and future runtime/artifact operations are
 * optional here: a host that lacks them is still usable, and the feature that needs one has to gate itself.
 */

const { createSshConnectionManager } = loadTsCommonJs("src/main/remote/SshConnectionManager.ts");

const HELPER_SESSION = { nodePath: "/usr/bin/node", deployRoot: "/home/dev/.pideck/remote-host", bundleSha256: "a".repeat(64) };
const REQUIRED = ["fs.stat", "fs.list", "fs.read"];
/** The terminal code of the gate; it is also the code that makes the failure fatal instead of retried. */
const CODE_CAPABILITY_MISSING = "SSH_HELPER_CAPABILITY_MISSING";
/** One diagnostic code per required operation, so the history names what is actually absent. */
const CODE_PER_OPERATION = {
	"fs.stat": "SSH_HELPER_CAPABILITY_MISSING_FS_STAT",
	"fs.list": "SSH_HELPER_CAPABILITY_MISSING_FS_LIST",
	"fs.read": "SSH_HELPER_CAPABILITY_MISSING_FS_READ",
};

/** A legal hello result; only the capability list is varied by these tests. */
function helloResult(overrides = {}) {
	return { protocolVersion: 1, platform: "linux", arch: "x64", home: "/home/dev", root: null, capabilities: ["echo", ...REQUIRED], helperVersion: "1.6.0", nodeVersion: "v24.11.0", pid: 321, ...overrides };
}

/**
 * Fake launcher whose first hello is answered with the given capabilities. The shape mirrors the harness
 * the manager suite uses: handles expose the launcher contract and settle nothing on their own, so a test
 * controls when the session ends.
 */
function createFakeLauncher(capabilities) {
	const requests = [];
	const handles = [];
	return {
		requests,
		handles,
		launcher: {
			async start(request) {
				requests.push(request);
				const emitter = new EventEmitter();
				const exits = [];
				let answered = false;
				const handle = {
					pid: 4321,
					writes: [],
					onExit(listener) {
						exits.push(listener);
						return () => {
							const index = exits.indexOf(listener);
							if (index >= 0) exits.splice(index, 1);
						};
					},
					onStdoutLine(listener) {
						emitter.on("stdout", listener);
						return () => emitter.off("stdout", listener);
					},
					onStderrLine() {
						return () => undefined;
					},
					write(line) {
						handle.writes.push(line);
						const frame = JSON.parse(line);
						if (frame.method !== "hello" || answered) return;
						answered = true;
						const result = capabilities === undefined ? helloResult() : helloResult({ capabilities });
						queueMicrotask(() => emitter.emit("stdout", JSON.stringify({ v: 1, hostId: frame.hostId, generation: frame.generation, id: frame.id, ok: true, result })));
					},
					async stop() {
						for (const listener of [...exits]) listener({ kind: "stopped", code: null, signal: null });
					},
					exit(exit) {
						for (const listener of [...exits]) listener(exit);
					},
				};
				handles.push(handle);
				return handle;
			},
		},
	};
}

/** One settled attempt against a fresh pinned host. */
async function attempt(t, capabilities) {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const fake = createFakeLauncher(capabilities);
	const manual = createManualTimers();
	const manager = createSshConnectionManager({ helperSession: HELPER_SESSION, userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0 });
	t.after(() => manager.dispose());
	return { manager, profile, fake, manual, state: await manager.connect(profile.id) };
}

function diagnosticCodes(manager, hostId) {
	return Array.from(manager.listDiagnostics(hostId)).map((entry) => entry.code);
}

test("a helper that lacks a required capability is never reported ready, names the operation, and is not retried", async (t) => {
	// A helper that answers hello without one required operation: every ready host is read through the batch,
	// so this build cannot serve the session/workspace readers a ready state promises.
	for (const missing of REQUIRED) {
		const capabilities = ["echo", ...REQUIRED.filter((capability) => capability !== missing)];
		const session = await attempt(t, capabilities);
		assert.notEqual(session.state.state, "ready", "a helper missing " + missing + " must not be reported ready");
		assert.equal(session.state.state, "needs-attention", "a missing capability cannot be fixed by reconnecting: " + missing);
		assert.equal(session.state.lastCode, CODE_CAPABILITY_MISSING, "the terminal state carries the stable code: " + missing);
		const codes = diagnosticCodes(session.manager, session.profile.id);
		assert.ok(codes.includes(CODE_CAPABILITY_MISSING), "the terminal refusal is diagnosed: " + missing);
		assert.ok(codes.includes(CODE_PER_OPERATION[missing]), "the diagnostic names the operation that is absent: " + missing);
		// needs-attention is terminal and a capability cannot appear by reconnecting: no backoff is armed.
		assert.deepEqual(session.manual.live(), [], "no retry may be scheduled for " + missing);
		// A host that is not ready must not serve requests either.
		await assert.rejects(session.manager.request(session.profile.id, "fs.read", { path: ".", offset: 0, bytes: 1 }), /SSH_CONNECTION_NOT_READY|SSH_HOST_NOT_READY/);
	}
});

test("every absent operation is diagnosed, not only the first one", async (t) => {
	const session = await attempt(t, ["echo"]);
	assert.equal(session.state.state, "needs-attention");
	const codes = diagnosticCodes(session.manager, session.profile.id);
	for (const missing of REQUIRED) assert.ok(codes.includes(CODE_PER_OPERATION[missing]), "the diagnostic names " + missing);
});

test("a complete capability list is ready, including capabilities this client never heard of", async (t) => {
	// Additive rule: a newer helper advertising operations this client does not know must not be refused.
	const session = await attempt(t, ["echo", ...REQUIRED, "fs.searchNames", "runtime.probePi", "artifact.create"]);
	assert.equal(session.state.state, "ready");
	assert.equal(session.fake.requests.length, 1);
	const codes = diagnosticCodes(session.manager, session.profile.id);
	assert.equal(codes.includes(CODE_CAPABILITY_MISSING), false, "an unknown capability is not a missing one");
});

test("a capability list that is not an array keeps failing the handshake", async (t) => {
	const session = await attempt(t, "fs.read");
	assert.notEqual(session.state.state, "ready");
	const codes = diagnosticCodes(session.manager, session.profile.id);
	assert.ok(codes.length > 0, "the refusal is recorded");
	assert.equal(codes.includes(CODE_CAPABILITY_MISSING), false, "a malformed handshake is not reported as a missing capability");
});
