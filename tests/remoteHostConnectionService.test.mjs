import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const OTHER_HOST_ID = "0e0f18ba-6f0e-4bd8-9f6c-1c8f6f2a7d31";
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };

// The production modules are loaded into a `vm` realm, so their plain objects carry that realm's
// prototypes. `deepStrictEqual` compares prototypes across realms, so assertions run on JSON views.
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * A structurally valid profile: the store fails closed to revision 0 / needs-repair on a malformed
 * snapshot (`REMOTE_HOST_SNAPSHOT_INVALID`), which would silently make the revision checks vacuous.
 * No `verifiedEndpoint`, so the profile is a never-verified draft and needs no pin on disk.
 */
function profile(entry) {
	const hostId = typeof entry === "string" ? entry : entry.id;
	const at = "2026-01-01T00:00:00.000Z";
	return { id: hostId, label: `host ${hostId.slice(0, 8)}`, sshHost: "10.81.2.15", user: "deploy", port: 22, connectTimeoutMs: 10_000, createdAt: at, updatedAt: at };
}

/** A store file at a known revision, so the service can tie a bootstrap to the profile it came from. */
async function writeStore(userDataDir, revision, entries = []) {
	await writeFile(join(userDataDir, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision, profiles: entries.map(profile), retiredHostIds: [] }));
	// Fail loudly instead of testing against a snapshot the store rejected: revision 0 with
	// REMOTE_HOST_SNAPSHOT_INVALID would make every revision assertion below pass for the wrong reason.
	const state = (await RemoteHostStore.open(userDataDir)).getSnapshot();
	assert.deepEqual({ revision: state.revision, status: state.status, profiles: state.profiles.length }, { revision, status: "ready", profiles: entries.length }, `fixture store at revision ${revision} was rejected: ${state.reasons.join(",")}`);
}

async function withUserData(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-remote-connection-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Ports that record calls and never start a process; each test overrides only what it observes. */
function fakePorts(overrides = {}) {
	const calls = { bootstrap: [], createManager: [], nonce: 0, resolveNode: [], sentinel: 0 };
	const managers = [];
	const ports = {
		calls,
		managers,
		bootstrap: async (input) => {
			calls.bootstrap.push(input);
			return { bundleSha256: "a".repeat(64), deployRoot: "/home/remote/.pideck/remote-host", active: `/home/remote/.pideck/remote-host/bundles/${"a".repeat(64)}` };
		},
		// 默认发现路径：模拟「登录 shell 找到的 nvm node」，与实际主机上的形态一致。
		resolveNode: async (input) => {
			calls.resolveNode.push(input);
			return { nodePath: "/home/remote/.nvm/versions/node/v24.11.0/bin/node", version: "v24.11.0", probed: 1 };
		},
		createSentinel: () => {
			calls.sentinel += 1;
			return `sentinel${String(calls.sentinel).padStart(8, "0")}`;
		},
		createNonce: () => {
			calls.nonce += 1;
			return `nonce-${String(calls.nonce).padStart(12, "0")}`;
		},
		createManager: (input) => {
			calls.createManager.push(input);
			const manager = {
				connected: [],
				disposed: 0,
				disconnects: [],
				state: "disconnected",
				lastCode: "SSH_CONNECTION_READY",
				/** 握手 home：真实 manager 只在成功握手后才有值，替身让测试直接摆布它。 */
				home: undefined,
				/** 外部致命条件的上报记录；needs-attention 就是这样从服务层进来的。 */
				reportCalls: [],
				tries: [],
				// 真实 manager 用 getState 暴露机器状态（含 latch）；服务层的就绪判定与 latch 替换依赖它。
				latched: false,
				getState(hostId) {
					return { hostId, generation: 1, state: manager.state, attempts: 0, lastCode: manager.lastCode, latched: manager.latched };
				},
				getHome() {
					return manager.home;
				},
				reportNeedsAttention(hostId, code) {
					manager.reportCalls.push({ hostId, code });
					manager.state = "needs-attention";
					manager.lastCode = code;
				},
				async retry(hostId) {
					manager.tries.push(hostId);
					manager.state = "ready";
					manager.lastCode = "SSH_CONNECTION_READY";
					return manager.getState(hostId);
				},
				async connect(hostId) {
					manager.connected.push(hostId);
					// needs-attention 是 reducer 的终态：begin-attempt（= 真实 connect）在那里会被丢弃。替身同样
					// 拒绝，服务层若忘了改走 retry 就会在这里露出马脚。
					if (manager.state === "needs-attention") return manager.getState(hostId);
					manager.state = "ready";
					return manager.state;
				},
				async disconnect(hostId, reason) {
					manager.disconnects.push({ hostId, reason });
					manager.state = "disconnected";
				},
				listDiagnostics(hostId) {
					return hostId === undefined ? [{ code: "SSH_CONNECTION_PREFLIGHT" }] : [{ code: `SSH_${hostId.slice(0, 2)}` }];
				},
				async dispose() {
					manager.disposed += 1;
				},
				...overrides.manager,
			};
			managers.push(manager);
			return manager;
		},
		...overrides,
	};
	return ports;
}

test("an unknown host id is refused without reading the store or starting a bootstrap", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 7, []);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		assert.deepEqual(plain(await service.connect("not-a-host-id")), { ok: false, hostId: "not-a-host-id", code: "REMOTE_CONNECTION_HOST_ID_INVALID" });
		assert.equal(ports.calls.bootstrap.length, 0);
		assert.equal(ports.calls.createManager.length, 0);
	});
});

test("invalid service options are refused before any port is built", () => {
	assert.throws(() => createRemoteHostConnectionService({ userDataDir: "", client: CLIENT, nodePath: "/usr/bin/node" }), /REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID/);
	assert.throws(() => createRemoteHostConnectionService({ userDataDir: "/tmp/ignored", client: {}, nodePath: "/usr/bin/node" }), /REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID/);
});

test("one connect bootstraps once, hands the verified session to the manager and reuses it", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 7, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		const first = plain(await service.connect(HOST_ID));
		assert.deepEqual(first, { ok: true, hostId: HOST_ID, state: "ready" });
		assert.equal(ports.calls.bootstrap.length, 1);
		assert.equal(ports.calls.createManager.length, 1);
		// The manager must receive the verified helper location, never a guess: deployRoot and the bundle
		// address come from the bootstrap result, and the root is forwarded verbatim at wiring time.
		assert.deepEqual(plain(ports.calls.createManager[0].helperSession), { nodePath: "/usr/bin/node", deployRoot: "/home/remote/.pideck/remote-host", bundleSha256: "a".repeat(64) });
		assert.deepEqual(plain(ports.managers[0].connected), [HOST_ID]);

		// A second connect under the same revision must reuse both the held bootstrap and the manager:
		// re-uploading the bundle on every connect would re-mint a nonce and invalidate the pin evidence.
		assert.deepEqual(plain(await service.connect(HOST_ID)), { ok: true, hostId: HOST_ID, state: "ready" });
		assert.equal(ports.calls.bootstrap.length, 1);
		assert.equal(ports.calls.createManager.length, 1);
		assert.deepEqual(plain(ports.managers[0].connected), [HOST_ID, HOST_ID]);
		await service.dispose();
	});
});

test("a workspace root is forwarded verbatim, and omitting it keeps the host-only session legal", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", root: "/srv/app", ports });
		await service.connect(HOST_ID);
		assert.equal(ports.calls.createManager[0].helperSession.root, "/srv/app");
		await service.dispose();
	});
});

test("each attempt mints its own nonce and the nonce never repeats inside one host", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 1, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		await service.connect(HOST_ID);
		// Bump the revision: the held bootstrap belongs to revision 1 and must not survive it.
		await writeStore(userDataDir, 2, [{ id: HOST_ID }]);
		await service.connect(HOST_ID);
		assert.equal(ports.calls.bootstrap.length, 2);
		const nonces = ports.calls.bootstrap.map((call) => call.nonce);
		assert.equal(new Set(nonces).size, 2);
		// The generation names the attempt, so a late frame from attempt 1 can never be adopted by attempt 2.
		// It is bumped at the top of every connect, so the first attempt is already generation 1 — a fresh
		// entry starts at 0 but no attempt ever runs under it.
		assert.deepEqual(
			ports.calls.bootstrap.map((call) => call.generation),
			[1, 2],
		);
		assert.deepEqual(plain(nonces.map((nonce) => call_nonce(nonce))), [true, true]);
		await service.dispose();
	});
});

/** The bootstrap contract requires 15–63 characters starting with an alphanumeric character. */
function call_nonce(nonce) {
	return typeof nonce === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{14,62}$/.test(nonce);
}

test("a rebind during the upload invalidates the result instead of publishing a retired deploy root", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 4, [{ id: HOST_ID }]);
		const ports = fakePorts({
			bootstrap: async () => {
				// The profile is re-verified while the entry is still uploading.
				await writeStore(userDataDir, 5, [{ id: HOST_ID }]);
				return { bundleSha256: "b".repeat(64), deployRoot: "/home/remote/.pideck/retired", active: "/home/remote/.pideck/retired/bundles/x" };
			},
		});
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		assert.deepEqual(plain(await service.connect(HOST_ID)), { ok: false, hostId: HOST_ID, code: "SSH_HOST_NOT_READY" });
		assert.equal(ports.calls.createManager.length, 0);
		await service.dispose();
	});
});

/**
 * 节点发现：服务自己解析远端 node，而不是要求调用方先知道。
 *
 * 远端 node 路径只能靠问主机得到，因此把它做成构造必填项等于要求调用方「先给出连接才能发现的
 * 答案」。这里锁定服务自己解析（经登录 shell），同时保留显式覆盖能力。
 */

test("the service discovers the remote node itself instead of requiring it up front", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [{ id: HOST_ID }]);
		const ports = fakePorts();
		// 关键：不传 nodePath。
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, ports });
		assert.deepEqual(plain(await service.connect(HOST_ID)), { ok: true, hostId: HOST_ID, state: "ready" });

		// 发现必须真的发生，且结果被送进 bootstrap 与 helper session（两者必须一致，否则
		// 探测的是一个 node、执行的却是另一个）。
		assert.equal(ports.calls.resolveNode.length, 1);
		assert.equal(ports.calls.bootstrap.length, 1);
		assert.equal(ports.calls.bootstrap[0].nodePath, "/home/remote/.nvm/versions/node/v24.11.0/bin/node");
		assert.equal(ports.calls.createManager[0].helperSession.nodePath, "/home/remote/.nvm/versions/node/v24.11.0/bin/node");
		// 每次发现都要带一个一次性哨兵，避免与上一次的输出混淆。
		assert.equal(ports.calls.resolveNode[0].sentinel, "sentinel00000001");
		assert.equal(ports.calls.resolveNode[0].hostId, HOST_ID);
		await service.dispose();
	});
});

test("an explicit nodePath overrides discovery entirely", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/opt/pinned/bin/node", ports });
		assert.deepEqual(plain(await service.connect(HOST_ID)), { ok: true, hostId: HOST_ID, state: "ready" });
		// 覆盖时不发探测请求：调用方已经给出了答案。
		assert.equal(ports.calls.resolveNode.length, 0);
		assert.equal(ports.calls.bootstrap[0].nodePath, "/opt/pinned/bin/node");
		assert.equal(ports.calls.createManager[0].helperSession.nodePath, "/opt/pinned/bin/node");
		await service.dispose();
	});
});

test("a second connect at the same revision reuses the verified session without re-discovering", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, ports });
		await service.connect(HOST_ID);
		await service.connect(HOST_ID);
		// 发现要 1 次远端往返，复用不能重复付出；bootstrap 同理。
		assert.equal(ports.calls.resolveNode.length, 1);
		assert.equal(ports.calls.bootstrap.length, 1);
		assert.equal(ports.calls.createManager.length, 1);
		await service.dispose();
	});
});

test("a discovery failure fails the connect as a stable code and never bootstraps", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [{ id: HOST_ID }]);
		const ports = fakePorts({
			resolveNode: async () => {
				// 真实解析器的形状：稳定码即完整消息，细节随错误携带。
				const error = new Error("REMOTE_NODE_VERSION_UNSUPPORTED");
				error.nodePath = "/usr/bin/node";
				error.observedVersion = "v12.22.9";
				throw error;
			},
		});
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, ports });
		const result = await service.connect(HOST_ID);
		assert.equal(result.ok, false);
		assert.equal(result.code, "REMOTE_NODE_VERSION_UNSUPPORTED");
		// 发现失败就不该启动 bootstrap：否则又一次把「零帧退出」当成入口的问题来诊断。
		assert.equal(ports.calls.bootstrap.length, 0);
		assert.equal(ports.calls.createManager.length, 0);
		await service.dispose();
	});
});

test("a bad nodePath override is refused as a wiring bug before any port is built", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const bad = { userDataDir, client: CLIENT, ports };
		for (const nodePath of ["", "relative/bin/node", 5, null]) {
			assert.throws(() => createRemoteHostConnectionService({ ...bad, nodePath }), /REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID/);
		}
		// 合法的覆盖不拦。
		assert.doesNotThrow(() => createRemoteHostConnectionService({ ...bad, nodePath: "/usr/local/bin/node" }));
		// 缺省（不传）也合法——这正是「服务自己发现」的模式。
		assert.doesNotThrow(() => createRemoteHostConnectionService(bad));
		assert.equal(ports.calls.bootstrap.length, 0, "construction must not touch any port");
	});
});

test("changing the workspace root discards the held session instead of reusing it", async () => {
	// 实跑回归（2026-09）：确认了浏览根，列目录仍回 PATH_OUTSIDE_ROOT —— 因为 root 是 helper 启动时的
	// `--root`，而当时那条会话是 host-only 启动的。修好「把 root 交给连接」之后还有第二半：
	// **换 root 必须丢弃已持有的会话**，否则同一 revision 下会复用旧会话，新 root 永远不生效。
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		// 第一次：host-only（合法状态，什么路径都服务不了）。
		await service.connect(HOST_ID);
		assert.equal(ports.calls.createManager[0].helperSession.root, undefined, "a host-only session carries no root");

		// 确认浏览根之后：必须重建会话，并且新的 helper 会话要带上这个 root。
		service.setWorkspaceRoot(HOST_ID, "/srv/app");
		await service.connect(HOST_ID);
		assert.equal(ports.calls.bootstrap.length, 2, "the session must be re-established, not reused");
		assert.equal(ports.calls.createManager[1].helperSession.root, "/srv/app", "the new session must be established with the confirmed root");

		// 再换成另一个 root：同样必须重建。
		service.setWorkspaceRoot(HOST_ID, "/srv/other");
		await service.connect(HOST_ID);
		assert.equal(ports.calls.bootstrap.length, 3);
		assert.equal(ports.calls.createManager[2].helperSession.root, "/srv/other");

		// 清空 root：回到 host-only，也不能复用带 root 的会话。
		service.setWorkspaceRoot(HOST_ID, undefined);
		await service.connect(HOST_ID);
		assert.equal(ports.calls.bootstrap.length, 4);
		assert.equal(ports.calls.createManager[3].helperSession.root, undefined);
		await service.dispose();
	});
});

/**
 * remoteHome 的三态契约：未知/未连接/畸形一律 undefined，只有「活着且握手成功」的会话才给出 home。
 * 它来自远端且会被拼进会话路径，所以服务层不信上游已过滤，出站前再校验一次形态。
 */
test("remoteHome answers undefined for an unknown host, a dead session and a malformed home", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 7, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		// 未知主机 / 尚未连接：只是元数据读取，既不建 manager 也不抛异常。
		assert.equal(await service.remoteHome(OTHER_HOST_ID), undefined);
		assert.equal(await service.remoteHome("not-a-host-id"), undefined);
		assert.equal(ports.calls.createManager.length, 0);

		assert.deepEqual(plain(await service.connect(HOST_ID)), { ok: true, hostId: HOST_ID, state: "ready" });
		assert.equal(await service.remoteHome(HOST_ID), undefined, "没有握手的会话没有 home");

		const manager = ports.managers[0];
		for (const malformed of ["relative/home", "", "/home\u0000x", `/${"a".repeat(4096)}`]) {
			manager.home = malformed;
			assert.equal(await service.remoteHome(HOST_ID), undefined, JSON.stringify(malformed));
		}
		manager.home = "/home/dev";
		assert.equal(await service.remoteHome(HOST_ID), "/home/dev");

		// 会话不再活着时，之前记录的 home 不得继续外传。
		manager.state = "offline";
		assert.equal(await service.remoteHome(HOST_ID), undefined);
	});
});

/**
 * 可达路径（生产序列）：重连时 helper 握手发现 root 不匹配（FATAL）→ 主机进入 needs-attention。
 * 此后每次读取都被拒并保留该码，直到用户按「连接」—— reducer 唯一合法出口是 user-retry，
 * 所以服务层必须走 manager.retry；走 begin-attempt 会被终态丢弃，按钮点了也出不来。
 */
test("a host left in needs-attention by the handshake is refused until an explicit connect retries it", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 7, [{ id: HOST_ID }]);
		const ports = fakePorts();
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		service.setWorkspaceRoot(HOST_ID, "/srv/app");
		assert.equal((await service.connect(HOST_ID)).ok, true);
		const manager = ports.managers[0];
		// 这正是 tests/sshConnectionManager.test.mjs 里 SSH_HELPER_ROOT_MISMATCH 之后留下的机器状态。
		manager.state = "needs-attention";
		manager.lastCode = "SSH_HELPER_ROOT_MISMATCH";

		const refused = await service.withProjectSession(HOST_ID, "/srv/app", async () => "never");
		assert.equal(refused.ok, false, JSON.stringify(refused));
		assert.equal(refused.code, "SSH_HELPER_ROOT_MISMATCH", "终态自己的码必须原样返回");
		assert.equal(manager.state, "needs-attention", "普通读取不得清掉终态");

		const reconnected = await service.connect(HOST_ID);
		assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
		assert.deepEqual(plain(manager.tries), [HOST_ID], "显式连接必须走 user-retry");
		assert.deepEqual(plain(manager.connected), [HOST_ID], "不得再用被终态丢弃的 begin-attempt");
		assert.equal(manager.state, "ready");
	});
});

/**
 * root 复核失败不只是「这次读取被拒」：主机必须进入可呈现的 needs-attention，且只有 user-retry 能离开。
 *
 * 注意可达性：这里的 manager 状态是直接注入的（disconnected），对应 reducer 新放开的来源状态；
 * 生产接线里复核只在「manager 存在且非 transient」时才会跑，而那样一个 manager 目前只能由显式 abort
 * 释放得到（其读取会被 explicitlyDisconnected 提前拒绝）。真正可达的那条漂移路径是重连时的 helper
 * 握手（见下一个测试与 tests/sshConnectionManager.test.mjs）。本测试锁定的是服务层的接线契约本身。
 */
test("a refused root re-check moves the host into needs-attention, and an explicit connect is the retry that leaves it", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 7, [{ id: HOST_ID }]);
		// 复核结果可切换：先通过一次把会话建在已确认的 root 上，再让它漂移。
		const control = { canonical: undefined };
		const ports = fakePorts({
			verifyRoot: async ({ userPath }) => ({ canonicalPath: control.canonical ?? userPath }),
		});
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		// 先把已确认的 root 交给会话（setWorkspaceRoot + 显式连接），这样 manager 是建在这个 root 上的。
		service.setWorkspaceRoot(HOST_ID, "/srv/app");
		assert.equal((await service.connect(HOST_ID)).ok, true);
		const manager = ports.managers[0];
		// 会话掉了、但 helper 位置仍然有效：下一次读取会重建，重建前正是那次复核。
		manager.state = "disconnected";
		control.canonical = "/srv/app-moved";

		const drifted = await service.withProjectSession(HOST_ID, "/srv/app", async () => "never");
		assert.equal(drifted.ok, false);
		assert.equal(drifted.code, "SSH_PROJECT_ROOT_CHANGED");
		assert.deepEqual(plain(manager.reportCalls), [{ hostId: HOST_ID, code: "SSH_PROJECT_ROOT_CHANGED" }], "复核失败必须上报给活跃 manager");
		assert.equal(manager.state, "needs-attention");

		// 之后每一次读取仍被拒，普通读取不得把终态悄悄清掉。
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const refused = await service.withProjectSession(HOST_ID, "/srv/app", async () => "never");
			assert.equal(refused.ok, false);
			assert.equal(refused.code, "SSH_PROJECT_ROOT_CHANGED");
			assert.equal(manager.state, "needs-attention");
		}
		assert.equal(manager.reportCalls.length, 1, "终态下不再重复上报");

		// 用户自己按「连接」= reducer 唯一合法出口 user-retry：begin-attempt 在 needs-attention 会被丢弃，
		// 所以服务层必须走 manager.retry，否则按钮点了也出不来。
		const reconnected = await service.connect(HOST_ID);
		assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
		assert.deepEqual(plain(manager.tries), [HOST_ID]);
		assert.equal(manager.state, "ready");
	});
});
