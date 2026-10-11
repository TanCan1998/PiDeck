import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * `remotePiRuntimeFacts`（P4.2 的启动准备事实）：解释器、pi 入口、runner 路径。
 *
 * 这组用例锁三件事：
 * 1. runner 路径**只能**由 held bootstrap 的 `{deployRoot, bundleSha256}` 推出（内容寻址），不是又一处拼接；
 * 2. pi 探测按 held bootstrap 缓存：同一会话内第二次取 facts 不得再花两次远端往返；
 * 3. 失败一律稳定码：入参错、会话建不起来、探测自己的 `REMOTE_PI_*` 码原样透传（调用方据此给升级指引）。
 */

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const BUNDLE_SHA = "c".repeat(64);
const DEPLOY_ROOT = "/home/remote/.pideck/remote-host";
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };

const plain = (value) => JSON.parse(JSON.stringify(value));

function profile(hostId) {
	const at = "2026-01-01T00:00:00.000Z";
	return { id: hostId, label: "host", sshHost: "10.81.2.15", user: "deploy", port: 22, connectTimeoutMs: 10_000, createdAt: at, updatedAt: at };
}

async function writeStore(userDataDir, revision, entries = [HOST_ID]) {
	await writeFile(join(userDataDir, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision, profiles: entries.map(profile), retiredHostIds: [] }));
	const state = (await RemoteHostStore.open(userDataDir)).getSnapshot();
	assert.deepEqual({ revision: state.revision, status: state.status }, { revision, status: "ready" }, "fixture store must be accepted, or the revision checks below would pass vacuously");
}

function fakeManager() {
	const manager = {
		state: "ready",
		getState(hostId) {
			return { hostId, generation: 1, state: manager.state, attempts: 0, lastCode: "SSH_CONNECTION_READY", latched: false };
		},
		getHome: () => "/home/remote",
		async connect(hostId) {
			manager.connected.push(hostId);
			return manager.getState(hostId);
		},
		async disconnect() {},
		async dispose() {},
		async retry(hostId) {
			return manager.getState(hostId);
		},
		listDiagnostics: () => [],
		connected: [],
	};
	return manager;
}

function fakePorts(overrides = {}) {
	const calls = { bootstrap: [], resolvePi: [], createManager: [] };
	const ports = {
		calls,
		bootstrap: async (input) => {
			calls.bootstrap.push(input);
			return { bundleSha256: BUNDLE_SHA, deployRoot: DEPLOY_ROOT, active: `./bundles/${BUNDLE_SHA}` };
		},
		resolveNode: async () => ({ nodePath: "/home/remote/.nvm/versions/node/v24.11.0/bin/node", version: "v24.11.0", probed: 1 }),
		resolvePi: async (input) => {
			calls.resolvePi.push(input);
			return { piPath: "/home/remote/.nvm/versions/node/v24.11.0/bin/pi", version: "0.85.1", versionParsed: { major: 0, minor: 85, patch: 1 }, probed: 1 };
		},
		createSentinel: () => "sentinel00000001",
		createNonce: () => "nonce-000000000001",
		createManager: (input) => {
			calls.createManager.push(input);
			return fakeManager();
		},
		verifyRoot: async () => ({ ok: true, canonicalPath: "/srv/app" }),
		...overrides,
	};
	return ports;
}

async function withService(run, overrides = {}) {
	const userDataDir = await mkdtemp(join(tmpdir(), "pideck-pi-facts-"));
	try {
		await writeStore(userDataDir, 5);
		const ports = fakePorts(overrides);
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		try {
			return await run(service, ports);
		} finally {
			await service.dispose();
		}
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
}

test("facts：解释器来自 node 解析，runner 路径由 held bootstrap 的内容地址推出", async () => {
	await withService(async (service, ports) => {
		const facts = plain(await service.remotePiRuntimeFacts(HOST_ID));
		assert.equal(facts.nodePath, "/usr/bin/node");
		assert.equal(facts.piPath, "/home/remote/.nvm/versions/node/v24.11.0/bin/pi");
		assert.equal(facts.version, "0.85.1");
		assert.equal(facts.warning, undefined);
		assert.equal(facts.runnerPath, `${DEPLOY_ROOT}/bundles/${BUNDLE_SHA}/runner.mjs`, "runner 路径只能来自部署结果，不是又一处拼接");
		// pi 探测必须拿到**同一个**解释器：nvm 的 pi 是 shim，裸执行会落到系统 node 上。
		assert.equal(ports.calls.resolvePi.length, 1);
		assert.equal(ports.calls.resolvePi[0].nodePath, "/usr/bin/node");
		assert.equal(ports.calls.resolvePi[0].hostId, HOST_ID);
	});
});

test("facts 按 held bootstrap 缓存 pi 探测：第二次取不再花远端往返", async () => {
	await withService(async (service, ports) => {
		const first = plain(await service.remotePiRuntimeFacts(HOST_ID));
		const second = plain(await service.remotePiRuntimeFacts(HOST_ID));
		assert.deepEqual(second, first);
		assert.equal(ports.calls.resolvePi.length, 1, "the probe costs two remote round trips; a second session must not pay again");
		assert.equal(ports.calls.bootstrap.length, 1, "a held bootstrap must be reused, not re-uploaded");
	});
});

test("facts：高于核验窗口的 warning 原样透传（放行但不冒充已核验组合）", async () => {
	await withService(
		async (service) => {
			const facts = plain(await service.remotePiRuntimeFacts(HOST_ID));
			assert.equal(facts.warning, "REMOTE_PI_VERSION_UNVERIFIED");
			assert.equal(facts.version, "1.0.4");
		},
		{
			resolvePi: async () => ({ piPath: "/home/remote/.nvm/versions/node/v24.11.0/bin/pi", version: "1.0.4", versionParsed: { major: 1, minor: 0, patch: 4 }, probed: 1, warning: "REMOTE_PI_VERSION_UNVERIFIED" }),
		},
	);
});

test("facts：探测的稳定码原样透传（调用方据此给升级指引），入参错与会话不可用各有自己的码", async () => {
	await withService(
		async (service, ports) => {
			await assert.rejects(
				() => service.remotePiRuntimeFacts(HOST_ID),
				(error) => {
					assert.equal(error.message, "REMOTE_PI_TOO_OLD", "the probe's code must survive as the whole message");
					return true;
				},
			);
		},
		{
			resolvePi: async () => {
				throw new Error("REMOTE_PI_TOO_OLD");
			},
		},
	);

	await withService(async (service, ports) => {
		await assert.rejects(() => service.remotePiRuntimeFacts("not-a-host-id"), /SSH_HOST_ID_INVALID/);
		assert.equal(ports.calls.bootstrap.length, 0, "an invalid host id must not start a connection");
		assert.equal(ports.calls.resolvePi.length, 0);
	});
});

test("facts：会话建不起来时报 SSH_HOST_NOT_READY，而不是拿着半截事实去起会话", async () => {
	await withService(
		async (service) => {
			await assert.rejects(() => service.remotePiRuntimeFacts(HOST_ID), /SSH_HOST_NOT_READY/);
		},
		{
			bootstrap: async () => {
				throw new Error("BOOTSTRAP_UPLOAD_FAILED");
			},
		},
	);
});

test("createPiRuntimeLauncher：拿到的是远端启动器（本地 plan 当场被拒，且不新起 ssh）", async () => {
	await withService(async (service, ports) => {
		const launcher = service.createPiRuntimeLauncher();
		// 本地 plan 被拒 ⇒ 证明拿到的是远端实现，而不是缺省那个本地启动器（后者会把 plan 当本地跑）。
		await assert.rejects(() => launcher.launch({ kind: "local", command: "/usr/bin/pi", args: [], cwd: "/tmp", env: {}, shell: false }), /REMOTE_RUNTIME_LAUNCH_PLAN_INVALID/);
		assert.equal(ports.calls.bootstrap.length, 0, "拒绝必须发生在任何远端动作之前");
	});
});
