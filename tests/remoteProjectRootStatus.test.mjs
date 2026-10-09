import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * H3：项目级 root 复核状态（设计 (i)）。
 *
 * 本文件只断言三件事，且都是契约本身：
 * 1) 漂移后**该项目**的 status 是 needs-attention 并带稳定码；
 * 2) 同主机另一个健康项目**仍是 ok 且读取照常成功**——这是 (i) 相对「接到主机级 needs-attention」的
 *    核心价值，也是本套件存在的主要理由；
 * 3) 状态查询只读既往复核结果：零 helper 请求、零 bootstrap、零会话建立、零复核、零副作用。
 *
 * 真实 IPC + 真实 service + 真实 RemoteWorkspaceReader 跑到可控假 manager 上，只有 SSH 传输层是假的。
 */

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const ROOT_A = "/srv/app-a";
const ROOT_B = "/srv/app-b";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const PROJECT_LOCAL = "project-local";
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };

/** 跨 realm 断言：VM 里造出来的对象原型不同，deepStrictEqual 会误判。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 每个 root 的假远端内容；只实现本文件用到的 fs.stat / fs.list / fs.read。 */
const CONTENT = new Map([
	[ROOT_A + "/data.txt", "A-DATA"],
	[ROOT_B + "/data.txt", "B-DATA"],
	[ROOT_B + "/only-b.txt", "ONLY-B"],
]);

const LOCATORS = {
	[PROJECT_A]: { kind: "ssh", hostId: HOST_ID, remotePath: ROOT_A },
	[PROJECT_B]: { kind: "ssh", hostId: HOST_ID, remotePath: ROOT_B },
	[PROJECT_LOCAL]: { kind: "local", environment: "native" },
};

function profile(id) {
	const at = "2026-01-01T00:00:00.000Z";
	return { id, label: "host", sshHost: "10.81.2.15", user: "deploy", port: 22, connectTimeoutMs: 10000, createdAt: at, updatedAt: at };
}

/** 结构合法的 host store 快照；service 的 readiness 按 revision 判定，被拒的快照会让断言失去意义。 */
async function writeStore(userDataDir) {
	await writeFile(join(userDataDir, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision: 7, profiles: [profile(HOST_ID)], retiredHostIds: [] }));
}

function fakeRemote() {
	const textFor = (root, path) => CONTENT.get(root + "/" + path);
	return {
		stat(root, path) {
			const text = textFor(root, path);
			if (text === undefined) throw new Error("PATH_NOT_FOUND");
			return { kind: "file", bytes: Buffer.byteLength(text, "utf8"), mtimeMs: 1 };
		},
		list(root) {
			const prefix = root + "/";
			return [...CONTENT.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ name: key.slice(prefix.length), kind: "file", bytes: 0 }));
		},
		read(root, path, offset, bytes) {
			const text = textFor(root, path);
			if (text === undefined) throw new Error("PATH_NOT_FOUND");
			const buffer = Buffer.from(text, "utf8");
			const slice = buffer.subarray(offset, offset + bytes);
			return { chunk: slice.toString("base64"), bytes: slice.length, eof: offset + slice.length >= buffer.length };
		},
	};
}

/**
 * 可控假远端 + 假 manager。control.canonical 是「远端路径现在 canonical 指向哪」：默认回显请求值
 * （复核通过），设成别的值即制造漂移。所有计数都在 calls 里，供「查询无副作用」类断言使用。
 */
function fakePorts(control) {
	const calls = { bootstrap: [], createManager: [], connects: [], requests: [], verifyCalls: [], reportCalls: [] };
	const remote = fakeRemote();
	const ports = {
		calls,
		bootstrap: async () => {
			calls.bootstrap.push(1);
			return { bundleSha256: "a".repeat(64), deployRoot: "/home/remote/.pideck/remote-host" };
		},
		resolveNode: async () => ({ nodePath: "/usr/bin/node", version: "v24.11.0", probed: 1 }),
		createSentinel: () => "sentinel-00000000",
		createNonce: () => "nonce-" + String(calls.bootstrap.length + 1).padStart(12, "0"),
		// 漂移是按 root 的：只有 control.drifted 里的路径会复核失败，这样「同主机另一项目仍健康」才是真的。
		verifyRoot: async ({ hostId, userPath }) => {
			calls.verifyCalls.push({ hostId, userPath });
			return { canonicalPath: control.drifted.has(userPath) ? userPath + "-moved" : userPath };
		},
		createManager: (input) => {
			const root = input.helperSession.root;
			calls.createManager.push({ root });
			const manager = {
				state: "disconnected",
				lastCode: "SSH_HOST_NOT_READY",
				machine(hostId) {
					return { hostId, generation: 1, state: manager.state, attempts: 0, lastCode: manager.lastCode, latched: false };
				},
				getState(hostId) {
					return manager.machine(hostId);
				},
				getHome() {
					return "/home/dev";
				},
				async connect(hostId) {
					calls.connects.push({ hostId, root });
					manager.state = "ready";
					manager.lastCode = "SSH_CONNECTION_READY";
					return manager.machine(hostId);
				},
				async retry(hostId) {
					return manager.connect(hostId);
				},
				async disconnect() {
					manager.state = "disconnected";
				},
				listDiagnostics: () => [],
				async dispose() {},
				// (i)：漂移不得驱动主机状态。方法存在只为让「零调用」成为一条可断言的事实。
				reportNeedsAttention(hostId, code) {
					calls.reportCalls.push({ hostId, code });
				},
				async request(hostId, method, params, options) {
					if (manager.state !== "ready") throw new Error("SSH_CONNECTION_NOT_READY");
					options?.onRequestId?.("req-1");
					calls.requests.push({ root, method, path: params?.path });
					if (method === "fs.stat") return remote.stat(root, params.path);
					if (method === "fs.list") return { entries: remote.list(root) };
					if (method === "fs.read") return remote.read(root, params.path, params.offset, params.bytes);
					throw new Error("PROTOCOL_INVALID");
				},
			};
			return manager;
		},
	};
	return ports;
}

/** 只加载项目域 IPC，返回它的通道表；每次调用都是独立 VM 与独立替身。 */
function loadProjectIpc(input) {
	const handlers = new Map();
	const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteBrowseRoot": { resolveRemoteBrowseRoot: async () => ({ canonicalPath: ROOT_A }) },
		},
	});
	registerRemoteProjectIpc({ userDataDir: "/tmp/ignored", ...input });
	return handlers;
}

async function harness(run, options = {}) {
	const userDataDir = await mkdtemp(join(tmpdir(), "pideck-project-root-status-"));
	try {
		await writeStore(userDataDir);
		const control = { drifted: new Set(options.drifted ?? []) };
		const ports = fakePorts(control);
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		const handlers = loadProjectIpc({
			enabled: true,
			userDataDir,
			service: () => service,
			projects: {
				enroll: async () => ({ projectId: PROJECT_A }),
				locator: (projectId) => LOCATORS[projectId],
			},
		});
		const api = {
			control,
			ports,
			service,
			status: (projectId) => handlers.get(ipcChannels.remoteProjectRootStatus)({}, projectId),
			read: (projectId, path) => handlers.get(ipcChannels.remoteProjectRead)({}, projectId, path),
		};
		try {
			return await run(api);
		} finally {
			await service.dispose();
		}
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
}

test("a drifted project is needs-attention with its code while a healthy project on the same host stays ok", async () => {
	await harness(async (api) => {
		// A 的远端路径一开始就漂移；B 在同主机上完全健康。
		api.control.drifted.add(ROOT_A);
		const readA = await api.read(PROJECT_A, "data.txt");
		assert.equal(readA.ok, false, JSON.stringify(readA));
		assert.equal(readA.code, "SSH_PROJECT_ROOT_CHANGED");

		const statusA = await api.status(PROJECT_A);
		assert.deepEqual(plain(statusA), { ok: true, status: "needs-attention", code: "SSH_PROJECT_ROOT_CHANGED" });

		// 同主机另一个健康项目：读取照常成功，状态仍是 ok。这是 (i) 相对主机级 needs-attention 的核心差异。
		const readB = await api.read(PROJECT_B, "only-b.txt");
		assert.equal(readB.ok, true, JSON.stringify(readB));
		assert.equal(Buffer.from(readB.contentBase64, "base64").toString("utf8"), "ONLY-B");
		assert.deepEqual(plain(await api.status(PROJECT_B)), { ok: true, status: "ok" });
		assert.deepEqual(plain(await api.status(PROJECT_A)), { ok: true, status: "needs-attention", code: "SSH_PROJECT_ROOT_CHANGED" }, "B 的建立不得清掉 A 的记录");

		// 漂移没有驱动主机状态机：同主机 B 的会话建立成功，而 A 的记录只是 A 的。
		assert.deepEqual(plain(api.ports.calls.reportCalls), [], "漂移不得把主机推入 needs-attention");
		assert.equal(api.ports.calls.connects.length, 1, "只有 B 建立了会话");

		// 查询本身零副作用：不发 helper 请求、不 bootstrap、不建会话、不再复核。
		const requestsBefore = api.ports.calls.requests.length;
		const managersBefore = api.ports.calls.createManager.length;
		const bootstrapsBefore = api.ports.calls.bootstrap.length;
		const verifiesBefore = api.ports.calls.verifyCalls.length;
		assert.deepEqual(plain(await api.status(PROJECT_A)), { ok: true, status: "needs-attention", code: "SSH_PROJECT_ROOT_CHANGED" });
		assert.deepEqual(plain(await api.status(PROJECT_B)), { ok: true, status: "ok" });
		assert.equal(api.ports.calls.requests.length, requestsBefore, "状态查询不得发 helper 请求");
		assert.equal(api.ports.calls.createManager.length, managersBefore, "状态查询不得建立会话");
		assert.equal(api.ports.calls.bootstrap.length, bootstrapsBefore, "状态查询不得 bootstrap");
		assert.equal(api.ports.calls.verifyCalls.length, verifiesBefore, "状态查询不得触发复核");
	});
});

test("a status query reads past results only: no probe, no connect, no bootstrap, no session", async () => {
	await harness(async (api) => {
		// 从未读过这两个项目：只知道「没有记录到问题」，而不是去问主机。
		assert.deepEqual(plain(await api.status(PROJECT_A)), { ok: true, status: "ok" });
		assert.deepEqual(plain(await api.status(PROJECT_B)), { ok: true, status: "ok" });
		assert.equal(api.ports.calls.verifyCalls.length, 0);
		assert.equal(api.ports.calls.createManager.length, 0);
		assert.equal(api.ports.calls.bootstrap.length, 0);
		assert.equal(api.ports.calls.connects.length, 0);
		assert.equal(api.ports.calls.requests.length, 0);
	});
});

test("a successful re-check of the same boundary clears the record back to ok", async () => {
	await harness(async (api) => {
		api.control.drifted.add(ROOT_A);
		assert.equal((await api.read(PROJECT_A, "data.txt")).code, "SSH_PROJECT_ROOT_CHANGED");
		assert.deepEqual(plain(await api.status(PROJECT_A)), { ok: true, status: "needs-attention", code: "SSH_PROJECT_ROOT_CHANGED" });

		// 用户把远端路径恢复；下一次建立会话重新复核成功 → 该键回到 ok，且读取重新可用。
		api.control.drifted.delete(ROOT_A);
		const served = await api.read(PROJECT_A, "data.txt");
		assert.equal(served.ok, true, JSON.stringify(served));
		assert.deepEqual(plain(await api.status(PROJECT_A)), { ok: true, status: "ok" });
	});
});

test("a record forces the next read to re-verify even on a ready session, so a fixed path clears on its own", async () => {
	await harness(async (api) => {
		api.control.drifted.add(ROOT_A);
		assert.equal((await api.read(PROJECT_A, "data.txt")).code, "SSH_PROJECT_ROOT_CHANGED");
		assert.deepEqual(plain(await api.status(PROJECT_A)), { ok: true, status: "needs-attention", code: "SSH_PROJECT_ROOT_CHANGED" });

		// 用户把远端路径恢复后按「连接」。connect 不是边界复核，也不该为它新增复核义务；但记录仍在，
		// 所以下一次读取必须重新复核——否则「已建立会话就复用、不复核」会让这条警告永久残留。
		api.control.drifted.delete(ROOT_A);
		assert.equal((await api.service.connect(HOST_ID)).ok, true);
		assert.deepEqual(plain(await api.status(PROJECT_A)), { ok: true, status: "needs-attention", code: "SSH_PROJECT_ROOT_CHANGED" }, "connect 本身不清除记录");

		const served = await api.read(PROJECT_A, "data.txt");
		assert.equal(served.ok, true, JSON.stringify(served));
		assert.deepEqual(plain(await api.status(PROJECT_A)), { ok: true, status: "ok" }, "读取触发的那次复核成功后记录被清除");
	});
});

test("unknown, non-ssh and malformed project ids each answer a stable code", async () => {
	await harness(async (api) => {
		assert.deepEqual(plain(await api.status("no-such-project")), { ok: false, code: "REMOTE_PROJECT_NOT_FOUND" });
		assert.deepEqual(plain(await api.status(PROJECT_LOCAL)), { ok: false, code: "UNSUPPORTED_PROJECT_LOCATION" });
		assert.deepEqual(plain(await api.status("")), { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" });
		assert.deepEqual(plain(await api.status("   ")), { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" });
		assert.deepEqual(plain(await api.status(7)), { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" });
		assert.deepEqual(plain(await api.status("x".repeat(257))), { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" });
		// 入参非法时一个主机都不该被问到。
		assert.equal(api.ports.calls.verifyCalls.length, 0);
		assert.equal(api.ports.calls.createManager.length, 0);
	});
});

test("disabled, unwired and unavailable service each answer their own stable code", async () => {
	const projects = { enroll: async () => ({ projectId: PROJECT_A }), locator: (projectId) => LOCATORS[projectId] };
	const channel = ipcChannels.remoteProjectRootStatus;
	const disabled = loadProjectIpc({ enabled: false, service: () => undefined, projects });
	assert.deepEqual(plain(await disabled.get(channel)({}, PROJECT_A)), { ok: false, code: "REMOTE_FEATURE_DISABLED" });
	const unwired = loadProjectIpc({ enabled: true, service: () => undefined });
	assert.deepEqual(plain(await unwired.get(channel)({}, PROJECT_A)), { ok: false, code: "REMOTE_PROJECT_ENROLL_UNAVAILABLE" });
	const unavailable = loadProjectIpc({ enabled: true, service: () => undefined, projects });
	assert.deepEqual(plain(await unavailable.get(channel)({}, PROJECT_A)), { ok: false, code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" });
});
