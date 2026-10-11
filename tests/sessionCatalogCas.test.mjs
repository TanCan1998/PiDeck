import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * INV-5a 写侧无丢失更新（K1 §6.2 `sessionCatalogCas`）：catalog 的写事务、revision 兼容与 fail-closed。
 *
 * 三条要点：
 * 1. **旧文件（v1，没有 revision 字段）照样能读**；写回时补上单调 revision，但 **schema `version` 仍是 1** ——
 *    多版本并行是产品既有行为，把 version 提到 2 会让旧版完全读不出 catalog（把「可检测」变成「不可用」）。
 * 2. **revision 从磁盘继续递增**，不是从内存记忆里重来：这是「提交建立在最新磁盘内容之上」的可观测形态。
 * 3. 两个实例并发登记不得互相覆盖；损坏/非法 revision 的快照保持 fail-closed，绝不写回。
 */

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";

function loadCatalogModule() {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
	});
}

async function makeCatalog(t, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-catalog-cas-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalogPath = join(directory, "session-catalog.json");
	if (options.file !== undefined) await writeFile(catalogPath, typeof options.file === "string" ? options.file : JSON.stringify(options.file), "utf8");
	const { SessionCatalog } = loadCatalogModule();
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	return { catalog, catalogPath };
}

function registration(remoteSessionId) {
	return { projectId: "p-1", hostId: HOST, remoteSessionId, remotePath: remoteSessionId, title: remoteSessionId, updatedAt: 1000 };
}

async function readSnapshot(catalogPath) {
	return JSON.parse(await readFile(catalogPath, "utf8"));
}

test("v1 文件（没有 revision 字段）可读；写回补上单调 revision，且不提升 schema version", async (t) => {
	const { catalog, catalogPath } = await makeCatalog(t, { file: { version: 1, sessions: [] } });
	await catalog.ensureRemoteSession(registration("ws/a.jsonl"));
	const first = await readSnapshot(catalogPath);
	assert.equal(first.version, 1, "旧版必须还能读这份 catalog（version 不提升）");
	assert.equal(first.revision, 1, "旧文件按 revision 0 起算");
	assert.equal(first.sessions.length, 1);

	await catalog.ensureRemoteSession(registration("ws/b.jsonl"));
	assert.equal((await readSnapshot(catalogPath)).revision, 2);
});

test("revision 从磁盘继续递增，而不是从内存记忆重来", async (t) => {
	const { catalog, catalogPath } = await makeCatalog(t, { file: { version: 1, revision: 7, sessions: [] } });
	await catalog.ensureRemoteSession(registration("ws/a.jsonl"));
	assert.equal((await readSnapshot(catalogPath)).revision, 8);
});

test("两个实例（模拟两进程）各自登记：后写者不得丢掉先写者已提交的会话", async (t) => {
	const { catalogPath } = await makeCatalog(t, { file: { version: 1, sessions: [] } });
	const { SessionCatalog } = loadCatalogModule();
	const writerA = new SessionCatalog(catalogPath);
	const writerB = new SessionCatalog(catalogPath);
	await writerA.load();
	await writerB.load();

	await writerA.ensureRemoteSession(registration("ws/one.jsonl"));
	// writerB 的快照是 A 提交之前读的：提交必须重读磁盘并在最新内容上重放。
	await writerB.ensureRemoteSession(registration("ws/two.jsonl"));

	const snapshot = await readSnapshot(catalogPath);
	const ids = snapshot.sessions.map((entry) => entry.locator.remoteSessionId).sort();
	assert.deepEqual(ids, ["ws/one.jsonl", "ws/two.jsonl"]);
	assert.equal(snapshot.revision, 2);
});

test("不可读的快照保持 fail-closed：不写回、不把磁盘内容当成空 catalog", async (t) => {
	const broken = "{ this is not json";
	const { catalog, catalogPath } = await makeCatalog(t, { file: broken });
	await assert.rejects(() => catalog.ensureRemoteSession(registration("ws/a.jsonl")), /SESSION_CATALOG_NEEDS_REPAIR/);
	assert.equal(await readFile(catalogPath, "utf8"), broken, "拒绝路径不得改写文件（逐字节）");
});

test("revision 字段值域非法同样 fail-closed（不把损坏的版本号当成 0）", async (t) => {
	const broken = JSON.stringify({ version: 1, revision: "7", sessions: [] });
	const { catalog, catalogPath } = await makeCatalog(t, { file: broken });
	await assert.rejects(() => catalog.ensureRemoteSession(registration("ws/a.jsonl")), /SESSION_CATALOG_NEEDS_REPAIR/);
	assert.equal(await readFile(catalogPath, "utf8"), broken, "拒绝路径不得改写文件（逐字节）");
});
