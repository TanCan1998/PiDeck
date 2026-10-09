import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * I2（sessions 域 hostId 判据收敛）的复现与契约套件。
 *
 * 收敛前的不对称：SessionCatalog.isSessionLocator 接受任意非空 hostId（≤256），而主机引用扫描
 * scanPersistedSessions 单独要求 UUID 形状 —— 同一条记录「catalog 当合法会话加载、扫描判 incomplete」，
 * 或者（本地 locator 携带 hostId 时）被读成「没有引用」。本套件锁定：两侧对同一条记录必须同判。
 *
 * 观测点说明（SessionCatalog 与 ProjectStore 的失败语义不同）：load() 不抛异常；任一记录非法会让
 * **整份快照被拒**（entries 清空、needsRepair=true），而 assertLoaded() 只检查 loaded，所以
 * catalog.get()/listEntries() 不会抛 —— 「被拒」的可观测形态是「这条记录不在任何可用条目里」，
 * 且同一份快照里的合法记录也一起消失。needs-repair 只在写入路径（assertWritable）可见。
 */
function loadCatalog() {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
	});
}

const sharedLocation = loadTsCommonJs("src/shared/projectLocation.ts");
const { HOST_ID } = loadTsCommonJs("src/main/remote/RemoteHostStoreCodec.ts");
const { createRemoteHostReferenceRegistry } = loadTsCommonJs("src/main/remote/RemoteHostReferenceSources.ts");

/** 与 RemoteHostStore 的 randomUUID() 同域的真实主机 id。 */
const HOST_A = "11111111-1111-4111-8111-111111111111";
const HOST_B = "01234567-89ab-4def-8123-456789abcdef";
const VALID_HOST_IDS = [HOST_A, HOST_B];
/** 域外取值：非 UUID、类路径串、空白、大小写、截断、控制字节、超长。 */
const INVALID_HOST_IDS = ["host-a", "ws/a.jsonl", ` ${HOST_A}`, HOST_B.toUpperCase(), HOST_B.slice(0, -1), `${HOST_A}\u0000`, "x".repeat(257)];

async function withTempDir(run) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-session-locator-"));
	try {
		await run({ directory, catalogPath: join(directory, "sessions.json"), projectsPath: join(directory, "projects.json") });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function sshSession(id, hostId, overrides = {}) {
	return {
		id,
		projectId: "project-1",
		title: "Remote session",
		source: "pi",
		environment: "native",
		backend: "pi",
		locator: { kind: "ssh", hostId, remotePath: "ws/a.jsonl", remoteSessionId: "ws/a.jsonl" },
		status: "active",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function catalogFile(sessions) {
	return JSON.stringify({ version: 1, sessions });
}

/** catalog 侧的可观测结论：holds = 这条记录仍在可用条目里（整份快照被拒时 ids 为空）。 */
async function catalogVerdict(catalogPath, sessionId) {
	const { SessionCatalog } = loadCatalog();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	// Array.from 在测试 realm 里构造宿主数组：VM realm 的 Array 原型不同，deepStrictEqual 会假失败。
	const ids = Array.from(catalog.listEntries(), (entry) => entry.id);
	return { holds: ids.includes(sessionId), ids };
}

async function scanVerdict(catalogPath, projectsPath) {
	const scan = await createRemoteHostReferenceRegistry(catalogPath, projectsPath).scan();
	return { complete: scan.complete, hostIds: Array.from(scan.referencedHostIds).sort(), unavailable: Array.from(scan.unavailable) };
}

test("catalog load and the host reference scan agree on the ssh hostId domain", async () => {
	for (const hostId of [...VALID_HOST_IDS, ...INVALID_HOST_IDS]) {
		await withTempDir(async ({ catalogPath, projectsPath }) => {
			await writeFile(catalogPath, catalogFile([sshSession("s-1", hostId)]), "utf8");
			const verdict = await catalogVerdict(catalogPath, "s-1");
			const scan = await scanVerdict(catalogPath, projectsPath);
			assert.equal(verdict.holds, scan.complete, `hostId ${JSON.stringify(hostId)}: catalog holds=${verdict.holds}, scan.complete=${scan.complete}`);
			assert.deepEqual(scan.hostIds, verdict.holds ? [hostId] : [], `hostId ${JSON.stringify(hostId)}`);
			if (!VALID_HOST_IDS.includes(hostId)) assert.deepEqual(scan.unavailable, ["sessions"], `hostId ${JSON.stringify(hostId)}`);
		});
	}
});

test("an ssh session locator outside the host store id domain is refused with the whole snapshot", async () => {
	for (const hostId of INVALID_HOST_IDS) {
		await withTempDir(async ({ catalogPath }) => {
			await writeFile(catalogPath, catalogFile([sshSession("s-1", hostId)]), "utf8");
			const verdict = await catalogVerdict(catalogPath, "s-1");
			assert.equal(verdict.holds, false, `hostId ${JSON.stringify(hostId)} must be refused`);
			assert.deepEqual(verdict.ids, [], `hostId ${JSON.stringify(hostId)}: 整份快照被拒`);
		});
	}
	for (const hostId of VALID_HOST_IDS) {
		await withTempDir(async ({ catalogPath }) => {
			await writeFile(catalogPath, catalogFile([sshSession("s-1", hostId)]), "utf8");
			const verdict = await catalogVerdict(catalogPath, "s-1");
			assert.deepEqual(verdict.ids, ["s-1"], `hostId ${JSON.stringify(hostId)} must stay loadable`);
		});
	}
});

test("one malformed ssh record refuses the whole catalog, not just itself", async () => {
	await withTempDir(async ({ catalogPath, projectsPath }) => {
		const localSession = {
			id: "s-local",
			projectId: "project-1",
			title: "Local session",
			source: "pi",
			environment: "native",
			status: "active",
			locator: { kind: "local", environment: "native", filePath: "C:/sessions/a.jsonl" },
			filePath: "C:/sessions/a.jsonl",
			createdAt: 1,
			updatedAt: 1,
		};
		await writeFile(catalogPath, catalogFile([localSession, sshSession("s-bad", "host-a")]), "utf8");
		const verdict = await catalogVerdict(catalogPath, "s-local");
		assert.deepEqual(verdict.ids, [], "同一快照里的合法本地会话也一起被拒（与 projects needs-repair 同语义）");
		const scan = await scanVerdict(catalogPath, projectsPath);
		assert.equal(scan.complete, false);
		assert.deepEqual(scan.unavailable, ["sessions"]);
	});
});

test("ensureRemoteSession refuses a hostId outside the host store id domain before writing", async () => {
	await withTempDir(async ({ catalogPath }) => {
		const { SessionCatalog } = loadCatalog();
		const catalog = new SessionCatalog(catalogPath);
		await catalog.load();
		for (const hostId of INVALID_HOST_IDS) {
			await assert.rejects(catalog.ensureRemoteSession({ projectId: "project-1", hostId, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl", title: "a", updatedAt: 1 }), /REMOTE_SESSION_IDENTITY_INVALID/, `hostId ${JSON.stringify(hostId)}`);
		}
		const created = await catalog.ensureRemoteSession({ projectId: "project-1", hostId: HOST_A, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl", title: "a", updatedAt: 1 });
		assert.deepEqual(JSON.parse(JSON.stringify(created.record.locator)), { kind: "ssh", hostId: HOST_A, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl" });
	});
});

test("legacy sessions without a locator and canonical ssh sessions keep loading and scanning", async () => {
	await withTempDir(async ({ catalogPath, projectsPath }) => {
		const sessions = [
			// 没有 locator 的合法记录：DSH 会话的 catalog 只是 id 映射，没有文件位置。
			{ id: "s-nolocator", projectId: "project-1", title: "DSH session", source: "pi", environment: "native", backend: "dsh", dshSessionId: "dsh-1", status: "active", createdAt: 1, updatedAt: 1 },
			{ id: "s-local", projectId: "project-1", title: "Local session", source: "pi", environment: "native", status: "active", locator: { kind: "local", environment: "native", filePath: "C:/sessions/a.jsonl" }, filePath: "C:/sessions/a.jsonl", createdAt: 1, updatedAt: 1 },
			// 历史记录可以只带 hostId（remotePath/remoteSessionId 一直是可选字段）。
			sshSession("s-host-only", HOST_A, { locator: { kind: "ssh", hostId: HOST_A } }),
			sshSession("s-alias", HOST_B, { locator: { kind: "ssh", hostId: HOST_B, remotePath: "ws/b.jsonl", remoteSessionId: "ws/b.jsonl", remotePathAliases: ["legacy/absolute/b.jsonl"] } }),
		];
		await writeFile(catalogPath, catalogFile(sessions), "utf8");
		const verdict = await catalogVerdict(catalogPath, "s-alias");
		assert.deepEqual(verdict.ids.sort(), ["s-alias", "s-host-only", "s-local", "s-nolocator"]);
		const scan = await scanVerdict(catalogPath, projectsPath);
		assert.equal(scan.complete, true);
		assert.deepEqual(scan.hostIds, [HOST_A, HOST_B].sort());
	});
});

test("a local session locator that carries a hostId is refused, not read as no reference", async () => {
	await withTempDir(async ({ catalogPath, projectsPath }) => {
		const session = {
			id: "s-local-host",
			projectId: "project-1",
			title: "Local",
			source: "pi",
			environment: "native",
			status: "active",
			locator: { kind: "local", environment: "native", filePath: "C:/sessions/a.jsonl", hostId: HOST_A },
			filePath: "C:/sessions/a.jsonl",
			createdAt: 1,
			updatedAt: 1,
		};
		await writeFile(catalogPath, catalogFile([session]), "utf8");
		const verdict = await catalogVerdict(catalogPath, "s-local-host");
		assert.deepEqual(verdict.ids, []);
		const scan = await scanVerdict(catalogPath, projectsPath);
		assert.equal(scan.complete, false);
		assert.deepEqual(scan.unavailable, ["sessions"]);
	});
});

test("the shared ssh session judgement uses the host store profile id domain", () => {
	for (const hostId of [...VALID_HOST_IDS, ...INVALID_HOST_IDS]) {
		assert.equal(sharedLocation.readSshSessionLocator({ kind: "ssh", hostId }) !== undefined, HOST_ID.test(hostId), `hostId ${JSON.stringify(hostId)}`);
	}
	// 会话专用字段保持既有值域（可选、有界）：收窄 hostId 不会把只带 hostId 的历史记录拒掉。
	assert.ok(sharedLocation.readSshSessionLocator({ kind: "ssh", hostId: HOST_A }));
	assert.ok(sharedLocation.readSshSessionLocator({ kind: "ssh", hostId: HOST_A, remotePath: "x".repeat(4096), remoteSessionId: "y".repeat(256), remotePathAliases: Array.from({ length: 32 }, () => "z") }));
	assert.equal(sharedLocation.readSshSessionLocator({ kind: "ssh", hostId: HOST_A, remotePath: "x".repeat(4097) }), undefined);
	assert.equal(sharedLocation.readSshSessionLocator({ kind: "ssh", hostId: HOST_A, remoteSessionId: "y".repeat(257) }), undefined);
	assert.equal(sharedLocation.readSshSessionLocator({ kind: "ssh", hostId: HOST_A, remotePath: 7 }), undefined);
	assert.equal(sharedLocation.readSshSessionLocator({ kind: "ssh", hostId: HOST_A, remotePathAliases: Array.from({ length: 33 }, () => "z") }), undefined);
});

test("isSessionLocator delegates the ssh branch to the shared judgement", () => {
	const { isSessionLocator } = loadCatalog();
	for (const hostId of [...VALID_HOST_IDS, ...INVALID_HOST_IDS]) {
		assert.equal(isSessionLocator({ kind: "ssh", hostId }), sharedLocation.readSshSessionLocator({ kind: "ssh", hostId }) !== undefined, `hostId ${JSON.stringify(hostId)}`);
	}
	assert.equal(isSessionLocator({ kind: "local", environment: "native" }), true);
	assert.equal(isSessionLocator({ kind: "local", environment: "native", hostId: HOST_A }), false);
	assert.equal(isSessionLocator({ kind: "local", environment: "native", filePath: "x".repeat(4097) }), false);
});
