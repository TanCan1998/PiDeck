import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * INV-5a 写侧无丢失更新（K1 §6.2 `projectStoreCas`）：锁内重读 + 令牌比对的提交语义。
 *
 * 分两层验证，因为它们是两种不同的保证：
 * 1. **store 级**：两个真实实例（模拟两个进程）各自 load→改→save，后写者不得把先写者的记录整份覆盖 ——
 *    这是用户真正会遇到的那种丢失更新；
 * 2. **原语级**（`storeFileCas`，两个 store 与 rebind 共用）：严格令牌模式下，磁盘已被别人推进时提交被拒、
 *    磁盘逐字节不变；带新令牌的合法重试成功；活 owner 占用返回 BUSY；可证陈旧的 owner 会被回收。
 *
 * 纪律：不许把「读侧 fail-closed」当写侧证据 —— 每条拒绝都同时断言磁盘逐字节不变。
 */

function loadProjectStoreModule(userData) {
	return loadTsCommonJs("src/main/projects/ProjectStore.ts", {
		stubs: { electron: { app: { getPath: () => userData }, dialog: {} } },
	});
}

function loadCasModule() {
	return loadTsCommonJs("src/main/persistence/storeFileCas.ts");
}

async function makeTempDir(t, prefix) {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function openProjectStore(userData) {
	const { ProjectStore } = loadProjectStoreModule(userData);
	const store = new ProjectStore();
	await store.load();
	return store;
}

async function hashFile(filePath) {
	return createHash("sha256")
		.update(await readFile(filePath))
		.digest("hex");
}

/** 最小但真实的 CAS 用例：一个只有 records + revision 的 JSON 文件，两个「进程」先后提交。 */
function makeCasHarness(directory) {
	const filePath = join(directory, "store.json");
	const readFresh = async () => {
		const parsed = JSON.parse(await readFile(filePath, "utf8"));
		return { state: parsed.records, revision: parsed.revision };
	};
	const write = async (records, revision) => writeFile(filePath, JSON.stringify({ revision, records }), "utf8");
	const append = (value) => (records) => ({ state: [...records, value], changed: true, value: `${value}:${records.length}` });
	return { directory, filePath, readFresh, write, append };
}

function commitOptions(harness, overrides) {
	return {
		rootDir: harness.directory,
		lockPath: `${harness.filePath}.lock`,
		unwritableCode: "TEST_LOCK_UNWRITABLE",
		busyCode: "TEST_BUSY",
		conflictCode: "TEST_REVISION_CONFLICT",
		readFresh: harness.readFresh,
		write: harness.write,
		...overrides,
	};
}

test("两个 store 实例（模拟两进程）各自提交：后写者不得丢掉先写者已提交的远端项目", async (t) => {
	const userData = await makeTempDir(t, "pideck-project-cas-");
	const writerA = await openProjectStore(userData);
	const writerB = await openProjectStore(userData);
	const hostId = "11111111-1111-4111-8111-111111111111";

	await writerA.addRemote({ hostId, canonicalRemotePath: "/srv/one" });
	// writerB 的内存快照来自 addRemote 之前：它的提交必须建立在磁盘最新内容之上（重读 + 重放），
	// 而不是把自己那份旧快照整份写回去。
	await writerB.addRemote({ hostId, canonicalRemotePath: "/srv/two" });

	const reloaded = await openProjectStore(userData);
	const paths = reloaded
		.list()
		.filter((project) => project.locator?.kind === "ssh")
		.map((project) => project.locator.remotePath)
		.sort();
	assert.deepEqual([...paths], ["/srv/one", "/srv/two"]);
});

test("严格令牌：磁盘被别人推进后，旧令牌的提交被拒且磁盘逐字节不变；带新令牌的合法重试成功", async (t) => {
	const directory = await makeTempDir(t, "pideck-cas-token-");
	const harness = makeCasHarness(directory);
	await writeFile(harness.filePath, JSON.stringify({ revision: 1, records: ["a"] }), "utf8");
	const { withStoreFileCas } = loadCasModule();

	const first = await withStoreFileCas(commitOptions(harness, { expectedRevision: 1, mutate: harness.append("b") }));
	assert.equal(first, "b:1");

	const before = await hashFile(harness.filePath);
	await assert.rejects(() => withStoreFileCas(commitOptions(harness, { expectedRevision: 1, mutate: harness.append("c") })), /TEST_REVISION_CONFLICT/, "拿旧令牌的提交必须被拒（不是静默覆盖）");
	assert.equal(await hashFile(harness.filePath), before, "被拒的提交不得写盘（逐字节）");

	// 合法重试：重读后的新令牌。
	const retried = await withStoreFileCas(commitOptions(harness, { expectedRevision: 2, mutate: harness.append("c") }));
	assert.equal(retried, "c:2");
	assert.deepEqual(JSON.parse(await readFile(harness.filePath, "utf8")), { revision: 3, records: ["a", "b", "c"] });
});

test("另一个活着的 owner 持有锁 ⇒ BUSY，什么都不写；可证陈旧的 owner 会被回收", async (t) => {
	const directory = await makeTempDir(t, "pideck-cas-busy-");
	const harness = makeCasHarness(directory);
	await writeFile(harness.filePath, JSON.stringify({ revision: 1, records: ["a"] }), "utf8");
	const { withStoreFileCas } = loadCasModule();

	await writeFile(`${harness.filePath}.lock`, JSON.stringify({ pid: process.pid, bootId: "current-boot", startedAt: new Date().toISOString() }), "utf8");
	const before = await hashFile(harness.filePath);
	await assert.rejects(() => withStoreFileCas(commitOptions(harness, { mutate: harness.append("b") })), /TEST_BUSY/);
	assert.equal(await hashFile(harness.filePath), before, "BUSY 路径不得写盘（逐字节）");

	// 同一台机器重启后（不同 bootId）留下的锁属于「可证陈旧的 owner」：可以回收并继续写。
	await writeFile(`${harness.filePath}.lock`, JSON.stringify({ pid: 999999, bootId: "previous-boot", startedAt: new Date(0).toISOString() }), "utf8");
	await withStoreFileCas(commitOptions(harness, { bootId: "current-boot", isProcessAlive: () => true, mutate: harness.append("b") }));
	assert.deepEqual(JSON.parse(await readFile(harness.filePath, "utf8")).records, ["a", "b"]);
});

test("无改动的事务（changed=false）一个字节都不写，也不推进 revision", async (t) => {
	const directory = await makeTempDir(t, "pideck-cas-noop-");
	const harness = makeCasHarness(directory);
	await writeFile(harness.filePath, JSON.stringify({ revision: 4, records: ["a"] }), "utf8");
	const { withStoreFileCas } = loadCasModule();

	const before = await hashFile(harness.filePath);
	const value = await withStoreFileCas(commitOptions(harness, { mutate: (records) => ({ state: records, changed: false, value: records.length }) }));
	assert.equal(value, 1);
	assert.equal(await hashFile(harness.filePath), before, "只读事务不得改写文件");
	assert.equal(JSON.parse(await readFile(harness.filePath, "utf8")).revision, 4);
});
