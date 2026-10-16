import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { materializeRemoteHelperArtifacts } from "./helpers/remoteHelperArtifacts.mjs";

/*
 * F4 independent verification of the root re-check (task-9, R2) and of the drift window.
 *
 * Two layers are attacked:
 *
 * 1. Service layer (fake ports, no process): the re-check must happen before the helper session is built or
 *    revived, must refuse a root that no longer canonicalizes to itself, must fail closed when the probe
 *    cannot answer, and must run inside the host operation lock. The assertions are the observable ones:
 *    the exact probe arguments, the order of the events, how many helper requests were made (zero on every
 *    refusal) and which root each session was built with.
 *
 * 2. Helper layer (the real frozen body as a child process): after a session is established, the root
 *    directory is re-pointed at a link out of the root, and then deleted. Both must be refused, and no data
 *    from the new target may come back. That is the R2 probe, and it is also where the honest limitation is
 *    recorded: a directory deleted and recreated as a real directory at the same path is indistinguishable
 *    to a canonical-path probe, so the helper serves the new tree. That is asserted as a limitation, not as
 *    a safety property.
 */

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const { createRemoteWorkspaceReader } = loadTsCommonJs("src/main/remote/RemoteWorkspaceReader.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { REMOTE_HELPER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const OTHER_HOST_ID = "0e0f18ba-6f0e-4bd8-9f6c-1c8f6f2a7d31";
const ROOT_A = "/srv/app";
const ROOT_B = "/srv/other";
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
/** The helper rejects a HOME that is not an absolute POSIX path; this one is honest on every platform. */
const HELPER_HOME = "/home/pideck-verify";
const GUARD_TIMEOUT_MS = 20000;
const REQUEST_TIMEOUT_MS = 30000;
const FILE_BYTES = 4;
const FILE_B64 = Buffer.from("DATA", "utf8").toString("base64");

/** Production modules live in another VM realm, so deep comparisons are normalised through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

async function waitUntil(predicate, label, timeoutMs = GUARD_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function profile(id) {
	const at = "2026-01-01T00:00:00.000Z";
	return { id, label: "host", sshHost: "10.81.2.15", user: "deploy", port: 22, connectTimeoutMs: 10000, createdAt: at, updatedAt: at };
}

async function writeStore(userDataDir, entries) {
	writeFileSync(join(userDataDir, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision: 7, profiles: entries.map(profile), retiredHostIds: [] }));
	const state = (await RemoteHostStore.open(userDataDir)).getSnapshot();
	assert.equal(state.status, "ready", "fixture store was rejected: " + state.reasons.join(","));
}

function answerFor(method, params) {
	if (method === "fs.stat") return { kind: "file", bytes: FILE_BYTES, mtimeMs: 1 };
	if (method === "fs.read") return { chunk: FILE_B64, bytes: FILE_BYTES, eof: true };
	if (method === "fs.list") return { entries: [{ name: "a.txt", kind: "file", bytes: FILE_BYTES }] };
	if (method === "fs.searchNames") return { entries: [{ path: "a.txt", name: "a.txt", kind: "file", bytes: FILE_BYTES }], scanned: 1, truncated: false };
	return undefined;
}

/**
 * A controllable fake remote: it records every event in one ordered log, answers only when a session is
 * ready (like the real manager), and resolves its own root through the current link map so a drifted root
 * string can be modelled honestly.
 */
function fakePorts(userDataDir) {
	const events = [];
	const verifyCalls = [];
	const managers = [];
	const requests = [];
	const control = { canonical: undefined, fails: false, gate: null, linkMap: new Map() };
	let bootstrapCalls = 0;
	const ports = {
		events,
		verifyCalls,
		managers,
		requests,
		control,
		bootstrapCalls: () => bootstrapCalls,
		bootstrap: async () => {
			bootstrapCalls += 1;
			events.push("bootstrap");
			return { bundleSha256: "a".repeat(64), deployRoot: "/home/remote/.pideck/remote-host" };
		},
		resolveNode: async () => ({ nodePath: "/usr/bin/node", version: "v24.11.0", probed: 1 }),
		createSentinel: () => "sentinel00000001",
		createNonce: () => "nonce-000000000001",
		// The real default is RemoteBrowseRoot.resolveRemoteBrowseRoot (a pinned readlink -f probe); this
		// substitute echoes the requested value unless a test moves it, so the approve path stays testable.
		verifyRoot: async ({ hostId, userPath }) => {
			events.push("verify:" + userPath);
			verifyCalls.push({ hostId, userPath });
			const gate = control.gate;
			if (gate !== null && gate.root === userPath) {
				control.gate = null;
				gate.reached();
				await gate.released;
			}
			if (control.fails) throw new Error("REMOTE_BROWSE_ROOT_UNRESOLVED");
			return { canonicalPath: control.canonical === undefined ? userPath : control.canonical, hostId };
		},
		createManager: (input) => {
			const root = input.helperSession.root;
			events.push("create-manager:" + String(root));
			const manager = {
				root,
				state: "disconnected",
				latched: false,
				lastCode: "SSH_CONNECTION_READY",
				retries: [],
				machine() {
					return { hostId: HOST_ID, generation: 1, state: manager.state, attempts: 0, lastCode: manager.lastCode, latched: manager.latched };
				},
				// 真实 manager 的外部致命条件入口：needs-attention 就是这样从服务层进来的。替身缺了它就会比生产
				// 实现更宽松，把「漂移是否真的进入终态」这件事测没。
				reportNeedsAttention(hostId, code) {
					events.push("needs-attention:" + code);
					manager.state = "needs-attention";
					manager.lastCode = code;
				},
				// reducer 里离开 needs-attention 的唯一合法出口是 user-retry，替身如实复刻。
				async retry() {
					manager.retries.push(root);
					manager.state = "ready";
					manager.lastCode = "SSH_CONNECTION_READY";
					return manager.machine();
				},
				getState() {
					return manager.machine();
				},
				async connect() {
					events.push("connect:" + String(root));
					if (manager.latched) return manager.machine();
					// 真实 reducer 只允许从 disconnected/offline 进入 connecting：needs-attention 是终态，
					// begin-attempt 会被丢弃。替身如实拒绝，否则「只有 user-retry 能离开终态」测不出来。
					if (manager.state === "needs-attention") return manager.machine();
					manager.state = "ready";
					return manager.machine();
				},
				async disconnect() {
					events.push("disconnect:" + String(root));
					manager.state = "disconnected";
					manager.latched = true;
				},
				async request(hostId, method, params) {
					// The real manager only serves a ready session; a reused manager must therefore be ready.
					if (manager.state !== "ready") throw new Error("SSH_CONNECTION_NOT_READY");
					// A raw root string can now resolve somewhere else: that is the drift this file models.
					const resolved = control.linkMap.get(root) ?? root;
					requests.push({ root, resolved, method, path: params?.path });
					return answerFor(method, params);
				},
				async cancel() {
					return { cancelled: true };
				},
				listDiagnostics: () => [],
				async dispose() {
					events.push("dispose:" + String(root));
					manager.state = "disposed";
				},
			};
			managers.push(manager);
			return manager;
		},
	};
	return ports;
}

async function harness(run, options = {}) {
	const userDataDir = await mkdtempSync(join(tmpdir(), "pideck-root-reverify-"));
	try {
		await writeStore(userDataDir, options.hosts ?? [HOST_ID, OTHER_HOST_ID]);
		const ports = fakePorts(userDataDir);
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		const api = {
			ports,
			service,
			/** One whole read-only operation through the service boundary, like the IPC handler does. */
			async stat(hostId, root, path) {
				const outcome = await service.withProjectSession(hostId, root, async (session) => session.request("fs.stat", { path }));
				return outcome;
			},
			/** The same, but with a real reader on top, so refused shapes surface as reader codes. */
			async list(hostId, root, path) {
				const outcome = await service.withProjectSession(hostId, root, async (session) => createRemoteWorkspaceReader({ port: { request: (requestHostId, method, params) => session.request(method, params) } }).list(requestHostId, path));
				return outcome;
			},
		};
		try {
			return await run(api, userDataDir);
		} finally {
			await service.dispose();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

/* Service-layer re-check. */

test("the canonical root is verified before any session exists, and the session is built on it", async () => {
	await harness(async (api) => {
		const outcome = await api.stat(HOST_ID, ROOT_A, "a.txt");
		assert.equal(outcome.ok, true, JSON.stringify(outcome));
		assert.deepEqual(plain(api.ports.verifyCalls), [{ hostId: HOST_ID, userPath: ROOT_A }], "the probe must receive the persisted root, not a renderer value");
		assert.equal(api.ports.managers.length, 1);
		assert.equal(api.ports.managers[0].root, ROOT_A, "the helper session must be confined to the verified root");
		// Order matters: a probe that ran after the session existed would leave a window where the session
		// is serving a boundary nobody proved.
		const verifyIndex = api.ports.events.indexOf("verify:" + ROOT_A);
		const createIndex = api.ports.events.indexOf("create-manager:" + ROOT_A);
		const connectIndex = api.ports.events.indexOf("connect:" + ROOT_A);
		assert.ok(verifyIndex >= 0 && createIndex > verifyIndex, "the probe must run before the manager is built: " + JSON.stringify(api.ports.events));
		assert.ok(connectIndex > verifyIndex, "the probe must run before the session connects: " + JSON.stringify(api.ports.events));
		assert.equal(api.ports.requests.length, 1, "the operation itself still runs");
	});
});

test("a root that no longer canonicalizes to itself is refused with zero helper requests", async () => {
	await harness(async (api) => {
		api.ports.control.canonical = ROOT_A + "-moved";
		const outcome = await api.stat(HOST_ID, ROOT_A, "a.txt");
		assert.equal(outcome.ok, false, JSON.stringify(outcome));
		assert.equal(outcome.code, "SSH_PROJECT_ROOT_CHANGED");
		assert.deepEqual(api.ports.requests, [], "a drifted boundary must not produce a single helper request");
		assert.equal(api.ports.managers.length, 0, "no session may be built for a boundary that drifted");
		assert.equal(api.ports.bootstrapCalls(), 0, "no bundle may be uploaded for a boundary that drifted");
	});
});

test("a root that cannot be verified fails closed with zero helper requests", async () => {
	await harness(async (api) => {
		api.ports.control.fails = true;
		const outcome = await api.stat(HOST_ID, ROOT_A, "a.txt");
		assert.equal(outcome.ok, false, JSON.stringify(outcome));
		assert.equal(outcome.code, "SSH_PROJECT_ROOT_UNRESOLVED");
		assert.deepEqual(api.ports.requests, []);
		assert.equal(api.ports.managers.length, 0);
	});
});

test("a ready session is reused without re-probing, and never serves a root nobody verified", async () => {
	await harness(async (api) => {
		assert.equal((await api.stat(HOST_ID, ROOT_A, "a.txt")).ok, true);
		const afterFirst = api.ports.verifyCalls.length;
		assert.equal((await api.stat(HOST_ID, ROOT_A, "a.txt")).ok, true);
		assert.equal(api.ports.verifyCalls.length, afterFirst, "a reuse must not pay for a probe on the hot path");
		assert.equal(api.ports.managers.length, 1, "the same session must be reused");
		// The invariant that closes the "only at establishment" question at this layer: every session that
		// ever exists was built on a root this host's probe approved.
		const approved = new Set(api.ports.verifyCalls.filter((call) => call.hostId === HOST_ID).map((call) => call.userPath));
		for (const manager of api.ports.managers) assert.ok(approved.has(manager.root), "a session was built on an unapproved root: " + manager.root);
	});
});

test("reconnecting re-verifies the root, and a drift found there is refused before any request", async () => {
	await harness(async (api) => {
		assert.equal((await api.stat(HOST_ID, ROOT_A, "a.txt")).ok, true);
		const manager = api.ports.managers[0];
		// A transport loss leaves the verified helper location but no live session: the service revives it.
		manager.state = "disconnected";
		api.ports.control.canonical = ROOT_A + "-moved";
		const requestsBefore = api.ports.requests.length;
		const outcome = await api.stat(HOST_ID, ROOT_A, "a.txt");
		assert.equal(outcome.ok, false, JSON.stringify(outcome));
		assert.equal(outcome.code, "SSH_PROJECT_ROOT_CHANGED");
		assert.equal(api.ports.verifyCalls.length, 2, "the reconnect must probe again");
		assert.equal(api.ports.requests.length, requestsBefore, "no helper request may be made after a failed re-check");
		assert.ok(!api.ports.events.includes("connect:" + ROOT_A + "#2"), "no reconnect may happen after a failed re-check");
		assert.equal(api.ports.events.filter((event) => event === "connect:" + ROOT_A).length, 1, "only the first establishment connected");
		// Design (i): the drift becomes a record for **this project's** confirmed root, and the host machine is
		// never moved - routing it into host needs-attention would let one moved directory block every other
		// project on the same host. The reachable host-level needs-attention for root drift is the helper
		// handshake (SSH_HELPER_ROOT_MISMATCH), covered by tests/remoteNeedsAttention.test.mjs.
		assert.deepEqual(plain(api.service.projectRootStatus(HOST_ID, ROOT_A)), { status: "needs-attention", code: "SSH_PROJECT_ROOT_CHANGED" });
		assert.equal(manager.state, "disconnected", "the drift must not move the host machine");
		assert.equal(
			api.ports.events.some((event) => event.startsWith("needs-attention:")),
			false,
			"no host-level report may be sent for a drift",
		);
	});
});

test("a drift found while reconnecting is recorded per project, keeps refusing reads, and clears once the root is re-proved", async () => {
	await harness(async (api) => {
		assert.equal((await api.stat(HOST_ID, ROOT_A, "a.txt")).ok, true);
		const manager = api.ports.managers[0];
		// The session is gone but its verified helper location still stands: the next read revives it, and
		// that revive is exactly where the boundary is re-proved.
		manager.state = "disconnected";
		api.ports.control.canonical = ROOT_A + "-moved";

		const drifted = await api.stat(HOST_ID, ROOT_A, "a.txt");
		assert.equal(drifted.ok, false, JSON.stringify(drifted));
		assert.equal(drifted.code, "SSH_PROJECT_ROOT_CHANGED");
		assert.deepEqual(plain(api.service.projectRootStatus(HOST_ID, ROOT_A)), { status: "needs-attention", code: "SSH_PROJECT_ROOT_CHANGED" });

		// Every later read of this project stays refused with the same code. The record is per project and the
		// host machine stays exactly where it was, so another project on this host keeps working - that half is
		// asserted end to end (including a successful read of the healthy project) in
		// tests/remoteProjectRootStatus.test.mjs.
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const refused = await api.stat(HOST_ID, ROOT_A, "a.txt");
			assert.equal(refused.ok, false, "a marked boundary must stay refused");
			assert.equal(refused.code, "SSH_PROJECT_ROOT_CHANGED");
			assert.deepEqual(plain(api.service.projectRootStatus(HOST_ID, ROOT_A)), { status: "needs-attention", code: "SSH_PROJECT_ROOT_CHANGED" });
		}
		assert.equal(manager.state, "disconnected", "drift never moves the host machine");
		assert.deepEqual(plain(manager.retries), [], "drift consumes no user-retry allowance");

		// The user re-points the boundary: the next establishment re-proves it, clears the record and serves.
		api.ports.control.canonical = undefined;
		const served = await api.stat(HOST_ID, ROOT_A, "a.txt");
		assert.equal(served.ok, true, "after the fix the read is served again");
		assert.deepEqual(plain(api.service.projectRootStatus(HOST_ID, ROOT_A)), { status: "ok" });
	});
});
test("reconnecting on a stable root revives the session and serves the read", async () => {
	await harness(async (api) => {
		assert.equal((await api.stat(HOST_ID, ROOT_A, "a.txt")).ok, true);
		api.ports.managers[0].state = "disconnected";
		const outcome = await api.stat(HOST_ID, ROOT_A, "a.txt");
		assert.equal(outcome.ok, true, JSON.stringify(outcome));
		assert.equal(api.ports.verifyCalls.length, 2, "a revive must re-prove the boundary");
		assert.equal(api.ports.managers.length, 1, "a revive reuses the manager instead of re-uploading");
		assert.equal(api.ports.requests.length, 2);
	});
});

test("switching projects re-verifies and never lets one project's request land on another root", async () => {
	await harness(async (api) => {
		assert.equal((await api.stat(HOST_ID, ROOT_A, "a.txt")).ok, true);
		assert.equal((await api.stat(HOST_ID, ROOT_B, "a.txt")).ok, true);
		assert.deepEqual(
			plain(api.ports.verifyCalls).map((call) => call.userPath),
			[ROOT_A, ROOT_B],
			"the switch must probe its own root",
		);
		assert.deepEqual(
			api.ports.managers.map((manager) => manager.root),
			[ROOT_A, ROOT_B],
			"the old session must be replaced, not re-pointed",
		);
		assert.deepEqual(
			api.ports.events.filter((event) => event.startsWith("dispose:")),
			["dispose:" + ROOT_A],
			"the session built on the old root must be discarded",
		);
		const byRoot = api.ports.requests.map((request) => request.root);
		assert.deepEqual(byRoot, [ROOT_A, ROOT_B], "each request must be served by the session built for its own root");
	});
});

test("the re-check runs inside the host operation lock, not before it", async () => {
	await harness(async (api) => {
		const released = Promise.withResolvers();
		let reached;
		const arrived = new Promise((resolve) => {
			reached = resolve;
		});
		api.ports.control.gate = { root: ROOT_A, reached, released: released.promise };
		const first = api.stat(HOST_ID, ROOT_A, "a.txt");
		await arrived;
		// The second project starts while the first one's probe is still in flight. If the probe ran outside
		// the lock, its verify event would appear before the first operation finished.
		const second = api.stat(HOST_ID, ROOT_B, "a.txt");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(
			plain(api.ports.verifyCalls).map((call) => call.userPath),
			[ROOT_A],
			"the second project's probe must queue behind the first operation: " + JSON.stringify(api.ports.events),
		);
		released.resolve();
		assert.equal((await first).ok, true);
		assert.equal((await second).ok, true);
		assert.deepEqual(
			plain(api.ports.verifyCalls).map((call) => call.userPath),
			[ROOT_A, ROOT_B],
		);
	});
});

test("a manager that reconnects internally on a drifted root string is caught by the helper handshake, not by the probe", async () => {
	await harness(async (api) => {
		// This is the falsification attempt for "the root is only re-checked when the session is established".
		// The service sees a ready session and reuses it (no probe), so the only guard left is the connection
		// layer's own handshake: every attempt compares the helper's reported canonical root against the root
		// string the session was built with and fails with SSH_HELPER_ROOT_MISMATCH. That check is covered
		// end-to-end in tests/sshConnectionManager.test.mjs, and it is why a re-pointed link cannot reach a
		// ready session even though this layer does not re-probe it.
		assert.equal((await api.stat(HOST_ID, ROOT_A, "a.txt")).ok, true);
		const probesAfterEstablish = api.ports.verifyCalls.length;
		api.ports.control.linkMap.set(ROOT_A, ROOT_A + "-moved");
		api.ports.control.canonical = ROOT_A + "-moved";
		const outcome = await api.stat(HOST_ID, ROOT_A, "a.txt");
		// The honest record of this layer's behaviour: the drift is not re-probed while the session is ready.
		assert.equal(api.ports.verifyCalls.length, probesAfterEstablish, "a ready-session reuse does not re-probe (documented policy)");
		assert.equal(outcome.ok, true, "this layer reuses the ready session; the handshake above is the guard that closes the window");
		// What keeps the reuse safe at this layer is that the session is the very one built on the approved
		// root: the service never rebuilds a session for an unapproved root.
		assert.equal(api.ports.managers.length, 1);
		assert.equal(api.ports.managers[0].root, ROOT_A);
	});
});

test("an explicit connect does not pre-approve a project root: the read still probes first", async () => {
	await harness(async (api) => {
		// connect() builds a ready session without naming any project boundary. The question this pins down is
		// whether that ready session is then treated as an approved boundary: it must not be, so the read has to
		// discard it, probe the root, and rebuild.
		const connected = await api.service.connect(HOST_ID);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		const probesBefore = api.ports.verifyCalls.length;
		const outcome = await api.stat(HOST_ID, ROOT_A, "a.txt");
		assert.equal(outcome.ok, true, JSON.stringify(outcome));
		assert.equal(api.ports.verifyCalls.length, probesBefore + 1, "a session built by connect() must not be reused as an approved project boundary");
		assert.equal(api.ports.managers[api.ports.managers.length - 1].root, ROOT_A);
	});
});

/* Helper-layer R2 probes: the root moves under a live session. */

const BASE = mkdtempSync(join(tmpdir(), "pideck-root-drift-"));
const ENTRY_DIR = join(BASE, "entry");
mkdirSync(ENTRY_DIR, { recursive: true });
const ENTRY_PATH = join(ENTRY_DIR, "helper.mjs");
// The entry must sit in the same directory as the siblings it imports.
materializeRemoteHelperArtifacts(ENTRY_DIR);
after(() => rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const OUTSIDE = join(BASE, "outside");
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(OUTSIDE, "leak.txt"), "OUTSIDE-SECRET");

const DRIFT_ROOT = join(BASE, "drift-root");
mkdirSync(DRIFT_ROOT, { recursive: true });
writeFileSync(join(DRIFT_ROOT, "inside.txt"), "INSIDE");

function startHelper(root) {
	const child = spawn(process.execPath, [ENTRY_PATH, "--root", root], { env: { ...process.env, HOME: HELPER_HOME }, stdio: ["pipe", "pipe", "pipe"] });
	const frames = [];
	let buffered = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdin.on("error", () => {});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		let index = buffered.indexOf("\n");
		while (index >= 0) {
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			try {
				frames.push(JSON.parse(line));
			} catch {
				frames.push({ malformed: line });
			}
			index = buffered.indexOf("\n");
		}
	});
	let sequence = 0;
	const request = (method, params) => {
		const id = "r" + String((sequence += 1));
		child.stdin.write(JSON.stringify({ v: 1, hostId: HOST_ID, generation: 1, id, method, ...(params === undefined ? {} : { params }) }) + "\n");
		return id;
	};
	return {
		frames,
		request,
		stderrText: () => stderr,
		waitFor: (id) => waitUntil(() => frames.find((frame) => frame.id === id), "frame " + id + " (stderr: " + stderr + ")", REQUEST_TIMEOUT_MS),
		kill: () => {
			try {
				child.stdin.destroy();
				child.kill();
			} catch {
				// already gone
			}
		},
	};
}

test("R2: a root re-pointed at a link out of the boundary is refused, with no target data", async () => {
	const helper = startHelper(DRIFT_ROOT);
	try {
		const hello = helper.request("hello");
		assert.equal((await helper.waitFor(hello)).ok, true, "the session must start before the drift");
		// The session is live; now the confirmed root itself becomes a link to a tree that must not be read.
		rmSync(DRIFT_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		symlinkSync(OUTSIDE, DRIFT_ROOT, process.platform === "win32" ? "junction" : "dir");
		const listId = helper.request("fs.list", { path: "." });
		const listed = await helper.waitFor(listId);
		assert.equal(listed.ok, false, "a re-pointed root must be refused, got " + JSON.stringify(listed));
		assert.equal(listed.error.code, "PATH_OUTSIDE_ROOT");
		assert.ok(!JSON.stringify(listed).includes("leak.txt"), "no entry from the new target may travel");
		const searchId = helper.request("fs.searchNames", { path: ".", query: "leak" });
		const searched = await helper.waitFor(searchId);
		assert.equal(searched.ok, false, "search must refuse the re-pointed root too, got " + JSON.stringify(searched));
		assert.ok(!JSON.stringify(searched).includes("OUTSIDE-SECRET"), "no content from the new target may travel");
		const readId = helper.request("fs.read", { path: "leak.txt", offset: 0, bytes: 64 });
		const read = await helper.waitFor(readId);
		assert.equal(read.ok, false, "a read through the re-pointed root must be refused");
		assert.ok(!JSON.stringify(read).includes("OUTSIDE-SECRET"), "the target's bytes must never be read");
	} finally {
		helper.kill();
	}
});

test("R2: a root that disappears under a live session is refused, not served from a stale handle", async () => {
	const root = join(BASE, "vanishing");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "inside.txt"), "INSIDE");
	const helper = startHelper(root);
	try {
		const hello = helper.request("hello");
		assert.equal((await helper.waitFor(hello)).ok, true);
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		const listId = helper.request("fs.list", { path: "." });
		const listed = await helper.waitFor(listId);
		assert.equal(listed.ok, false, "a vanished root must be refused, got " + JSON.stringify(listed));
		assert.equal(listed.error.code, "PATH_OUTSIDE_ROOT");
		const readId = helper.request("fs.read", { path: "inside.txt", offset: 0, bytes: 64 });
		const read = await helper.waitFor(readId);
		assert.equal(read.ok, false, "a vanished root must not be served from a stale handle, got " + JSON.stringify(read));
	} finally {
		helper.kill();
	}
});

test("known limitation: a root deleted and recreated as a real directory is indistinguishable to a canonical-path probe", async () => {
	// Recorded on purpose. The boundary check is a canonical-path check (readlink -f / realpath), so a
	// directory deleted and recreated at the same path, now holding a different tree, canonicalizes to
	// exactly the same string and cannot be told apart by any re-probe. This is not a bug in the re-check;
	// it is the limit of what a path-based boundary can prove. Detecting it needs an identity that is not a
	// path (an inode/dev pair captured at confirmation time), which the protocol does not carry today.
	const root = join(BASE, "recreated");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "old.txt"), "OLD");
	const helper = startHelper(root);
	try {
		const hello = helper.request("hello");
		assert.equal((await helper.waitFor(hello)).ok, true);
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "new.txt"), "NEW");
		const listId = helper.request("fs.list", { path: "." });
		const listed = await helper.waitFor(listId);
		assert.equal(listed.ok, true, "the path still exists, so the live session keeps serving it: " + JSON.stringify(listed));
		const names = listed.result.entries.map((entry) => entry.name);
		assert.deepEqual(names, ["new.txt"], "the session now serves the recreated directory");
		assert.ok(!names.includes("old.txt"), "the old tree is gone");
	} finally {
		helper.kill();
	}
});
