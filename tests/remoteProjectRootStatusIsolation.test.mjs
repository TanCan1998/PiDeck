import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createManualTimers, createPinnedClient, createPinnedHostFixture, flushMicrotasks } from "./helpers/sshPinnedHostFixture.mjs";

/*
 * F4 independent verification of the project-level root status (task-20, H3).
 *
 * The design under test is (i): a drifted root is a property of *one project's persisted path*, not of the
 * host, so a moved directory must not make its healthy neighbours on the same host look broken. That claim
 * is only worth anything if it is asserted directly, so the central test here builds two projects on one
 * host, drifts one of them, and then reads both statuses back through the IPC channel while counting every
 * helper request the queries caused.
 *
 * The status channel is driven at its real boundary: the production registerRemoteProjectIpc over a stubbed
 * ipcMain, with the production connection service over the production manager (only the launcher, the
 * bootstrap and the root probe are substituted), so the recorded failure is the one the service actually
 * recorded and not a fake agreeing with itself.
 */

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
	stubs: { electron: { ipcMain: { handle: undefined } } },
});
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const ROOT_A = "/srv/app";
const ROOT_B = "/srv/other";
const STATUS_CHANNEL = "remote:project-root-status";
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };

const plain = (value) => JSON.parse(JSON.stringify(value));

/** The same fake launcher the earlier batches used: it answers the handshake and echoes the launched root. */
function createFakeLauncher(options = {}) {
	const requests = [];
	return {
		requests,
		launcher: {
			async start(request) {
				requests.push(request);
				const command = (request.invocation?.args ?? []).join(" ");
				const requestedRoot = /--root '([^']*)'/.exec(command);
				const askedRoot = requestedRoot === null ? null : requestedRoot[1];
				const canonical = typeof options.canonicalRoot === "function" && askedRoot !== null ? options.canonicalRoot(askedRoot) : askedRoot;
				const emitter = new EventEmitter();
				const exitListeners = new Set();
				let answered = false;
				return {
					pid: 4321,
					write(line) {
						const frame = JSON.parse(line);
						if (frame.method !== "hello" || answered) return;
						answered = true;
						const result = {
							protocolVersion: 1,
							platform: "linux",
							arch: "x64",
							home: "/home/dev",
							root: canonical,
							capabilities: ["echo", "fs.stat", "fs.list", "fs.read", "fs.searchNames"],
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

/**
 * Two remote projects on one host over the production service. Only the launcher, the bootstrap port and the
 * root probe are substituted; the manager, the reducer and the service are the shipped ones.
 */
async function projectHarness(t) {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const control = { canonicalByRoot: new Map(), probeFailsFor: new Set(), verifyCalls: [], bootstraps: 0, rootMap: new Map() };
	const fake = createFakeLauncher({ canonicalRoot: (requested) => control.rootMap.get(requested) ?? requested });
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
			if (control.probeFailsFor.has(userPath)) throw new Error("REMOTE_BROWSE_ROOT_UNRESOLVED");
			const override = control.canonicalByRoot.get(userPath);
			return { canonicalPath: override === undefined ? userPath : override };
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
	return { directory, profile, fake, control, states, service, read };
}

/** Register the project IPC domain over a stubbed ipcMain and hand back the captured handlers. */
function registerProjectIpc(service, hostId, locators) {
	const handlers = new Map();
	const electron = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
	const module = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", { stubs: { electron } });
	module.registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/ignored",
		service: () => service,
		projects: {
			enroll: async () => ({ projectId: "unused" }),
			locator: (projectId) => locators[projectId],
		},
	});
	void hostId;
	return handlers;
}

async function rootStatus(handlers, projectId) {
	const handler = handlers.get(STATUS_CHANNEL);
	assert.ok(handler !== undefined, "remoteProjectIpc must register the frozen channel " + STATUS_CHANNEL + " (registered: " + [...handlers.keys()].join(",") + ")");
	return handler({}, projectId);
}

test("a drifted project is needs-attention while its healthy neighbour on the same host stays ok", async (t) => {
	const { profile, fake, control, service, read } = await projectHarness(t);
	const handlers = registerProjectIpc(service, profile.id, {
		"project-a": { kind: "ssh", hostId: profile.id, remotePath: ROOT_A },
		"project-b": { kind: "ssh", hostId: profile.id, remotePath: ROOT_B },
	});
	// When the shared contract carries the constant it must be exactly the frozen literal; the handler lookup
	// below is what proves the registration used it.
	if (ipcChannels.remoteProjectRootStatus !== undefined) assert.equal(ipcChannels.remoteProjectRootStatus, STATUS_CHANNEL);

	// Both projects start healthy on the same host.
	assert.equal((await read(ROOT_A)).ok, true);
	assert.equal((await read(ROOT_B)).ok, true);
	assert.deepEqual(plain(await rootStatus(handlers, "project-a")), { ok: true, status: "ok" });
	assert.deepEqual(plain(await rootStatus(handlers, "project-b")), { ok: true, status: "ok" });

	// Project A's persisted path is re-pointed somewhere else. Switching back to A is where the service
	// re-probes it; the probe now canonicalizes to a different path.
	control.canonicalByRoot.set(ROOT_A, ROOT_A + "-moved");
	const refused = await read(ROOT_A);
	assert.equal(refused.ok, false, JSON.stringify(refused));
	assert.equal(refused.code, "SSH_PROJECT_ROOT_CHANGED");

	// The healthy neighbour keeps serving on the same host...
	const healthy = await read(ROOT_B);
	assert.equal(healthy.ok, true, "a healthy project must not be blocked by its neighbour's drift: " + JSON.stringify(healthy));

	// ...and the statuses say exactly that.
	const statusA = await rootStatus(handlers, "project-a");
	assert.equal(statusA.ok, true, JSON.stringify(statusA));
	assert.equal(statusA.status, "needs-attention", "the drifted project must be flagged: " + JSON.stringify(statusA));
	assert.match(statusA.code, STABLE_CODE, "the recorded reason must be a stable code");
	const statusB = await rootStatus(handlers, "project-b");
	assert.equal(statusB.ok, true, JSON.stringify(statusB));
	assert.equal(statusB.status, "ok", "design (i): the neighbour's status must stay ok, got " + JSON.stringify(statusB));
	assert.equal(statusB.code, undefined, "a healthy project has no reason code");

	// Repeated queries are stable and must not accumulate state.
	assert.deepEqual(plain(await rootStatus(handlers, "project-a")), plain(statusA));
	assert.deepEqual(plain(await rootStatus(handlers, "project-b")), plain(statusB));
	void fake;
});

test("the status query is read-only: no session work, no helper request, no state change", async (t) => {
	const { profile, fake, control, states, service, read } = await projectHarness(t);
	const handlers = registerProjectIpc(service, profile.id, {
		"project-a": { kind: "ssh", hostId: profile.id, remotePath: ROOT_A },
	});
	assert.equal((await read(ROOT_A)).ok, true);
	// A ready session is not re-probed, so the host is moved onto project B first: the next read of A has to
	// re-establish and therefore runs the root probe that records the failure.
	assert.equal((await read(ROOT_B)).ok, true);
	control.canonicalByRoot.set(ROOT_A, ROOT_A + "-moved");
	assert.equal((await read(ROOT_A)).ok, false);

	const requestsBefore = fake.requests.length;
	const bootstrapsBefore = control.bootstraps;
	const verifiesBefore = control.verifyCalls.length;
	const statesBefore = states.length;
	const probesBefore = control.verifyCalls.map((call) => call.userPath).length;

	for (let index = 0; index < 5; index += 1) {
		const status = await rootStatus(handlers, "project-a");
		assert.equal(status.ok, true);
		assert.equal(status.status, "needs-attention");
	}
	assert.equal(fake.requests.length, requestsBefore, "a status query must not launch a process");
	assert.equal(control.bootstraps, bootstrapsBefore, "a status query must not bootstrap a helper");
	assert.equal(control.verifyCalls.length, verifiesBefore, "a status query must not probe the remote");
	assert.equal(control.verifyCalls.map((call) => call.userPath).length, probesBefore);
	assert.equal(states.length, statesBefore, "a status query must not change any connection state");
});

test("a successful re-check clears the recorded failure back to ok", async (t) => {
	const { profile, control, service, read } = await projectHarness(t);
	const handlers = registerProjectIpc(service, profile.id, {
		"project-a": { kind: "ssh", hostId: profile.id, remotePath: ROOT_A },
	});
	assert.equal((await read(ROOT_A)).ok, true);
	assert.equal((await read(ROOT_B)).ok, true);
	control.canonicalByRoot.set(ROOT_A, ROOT_A + "-moved");
	assert.equal((await read(ROOT_A)).ok, false);
	assert.equal((await rootStatus(handlers, "project-a")).status, "needs-attention");

	// The directory is put back: the next establishment must succeed and clear the recorded reason.
	control.canonicalByRoot.delete(ROOT_A);
	assert.equal((await read(ROOT_A)).ok, true, "the restored root must be readable again");
	const cleared = await rootStatus(handlers, "project-a");
	assert.equal(cleared.status, "ok", "a successful re-check must clear the recorded failure: " + JSON.stringify(cleared));
	assert.equal(cleared.code, undefined);
});

test("an unresolvable root records its own stable code", async (t) => {
	const { profile, control, service, read } = await projectHarness(t);
	const handlers = registerProjectIpc(service, profile.id, {
		"project-a": { kind: "ssh", hostId: profile.id, remotePath: ROOT_A },
	});
	assert.equal((await read(ROOT_A)).ok, true);
	assert.equal((await read(ROOT_B)).ok, true);
	control.probeFailsFor.add(ROOT_A);
	const refused = await read(ROOT_A);
	assert.equal(refused.ok, false);
	const status = await rootStatus(handlers, "project-a");
	assert.equal(status.status, "needs-attention");
	assert.equal(status.code, "SSH_PROJECT_ROOT_UNRESOLVED", "the probe's own code must be what is recorded");
});

test("unknown, non-ssh and invalid project ids are refused with stable codes", async (t) => {
	const { profile, service } = await projectHarness(t);
	const handlers = registerProjectIpc(service, profile.id, {
		"project-a": { kind: "ssh", hostId: profile.id, remotePath: ROOT_A },
		"project-local": { kind: "local", environment: "native", localPath: "/tmp/local-project" },
	});
	for (const projectId of ["project-missing", "project-local", "", 7, undefined, null]) {
		const status = await rootStatus(handlers, projectId);
		assert.equal(status.ok, false, JSON.stringify(projectId) + " must be refused: " + JSON.stringify(status));
		assert.match(status.code, STABLE_CODE, JSON.stringify(projectId) + " answered " + status.code);
	}
});

test("the whole domain is inert when the feature gate is off", async (t) => {
	const { profile, control, fake, service } = await projectHarness(t);
	const handlers = new Map();
	const electron = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
	loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", { stubs: { electron } }).registerRemoteProjectIpc({
		enabled: false,
		userDataDir: "/tmp/ignored",
		service: () => service,
		projects: { enroll: async () => ({ projectId: "x" }), locator: () => ({ kind: "ssh", hostId: profile.id, remotePath: ROOT_A }) },
	});
	const status = await rootStatus(handlers, "project-a");
	assert.equal(status.ok, false);
	assert.equal(status.code, "REMOTE_FEATURE_DISABLED");
	assert.equal(fake.requests.length, 0);
	assert.equal(control.bootstraps, 0);
});

/*
 * Rendering-branch guard for the project-level status tag. The state machine and the IPC channel are
 * asserted above; what this pins is that the tag cannot silently disappear, cannot turn into noise for a
 * healthy project, and cannot lose one of its two dictionaries.
 */

test("the needs-attention tag renders only for a needs-attention status and is mounted by the project tree", () => {
	const tag = readFileSync("src/renderer/src/components/sidebar/RemoteProjectStatusTag.tsx", "utf8");
	// ok / unavailable / unknown all render nothing: the tag exists only to surface something actionable.
	assert.match(tag, /if\s*\(status\?\.status !== "needs-attention"\)\s*return null;/, "the tag must render nothing unless the status needs attention");
	assert.ok(tag.includes('t("sidebar.remoteProject.needsAttention")'), "the tag must use its own copy key");
	// A missing code still shows the tag, with the generic hint; a code becomes the troubleshooting hint.
	assert.match(tag, /status\.code === null[\s\S]{0,200}?needsAttentionHint"/);
	assert.match(tag, /needsAttentionHintCode", \{ code: status\.code \}/);

	const tree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
	assert.ok(tree.includes('import { RemoteProjectStatusTag } from "./RemoteProjectStatusTag"'), "the tree must import the tag");
	assert.match(tree, /isRemoteProject\(project\)\s*\?\s*<RemoteProjectStatusTag projectId=\{project\.id\}\s*\/>\s*:\s*null/, "the tag must be mounted for remote projects only");
	// One batched, host-scoped query for the whole list instead of a query per row.
	assert.ok(tree.includes("useRemoteProjectRootStatuses("), "the tree must use the batched status hook");

	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const key of ["sidebar.remoteProject.needsAttention", "sidebar.remoteProject.needsAttentionHint", "sidebar.remoteProject.needsAttentionHintCode"]) {
		assert.ok(zh.includes('"' + key + '":'), "zh-CN is missing " + key);
		assert.ok(en.includes('"' + key + '":'), "en-US is missing " + key);
	}
});
