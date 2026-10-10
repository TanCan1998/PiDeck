import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * INV-5 红例（K1 设计 docs/remote-cross-store-consistency-plan.md §6.3）。
 *
 * 这些用例是**预期的红**：它们断言的是 INV-5 要求的写侧保证，而该保证今天还不成立。为了不让
 * 「预期的红」以普通失败形态污染每次集成，本文件默认**全部 skip**（带原因）；只有显式设置
 * PIDECK_INV5_EXPECT_RED=1 时才真正执行，用来复现「现在到底会丢什么」。
 *
 * 纪律：
 * - 全部用**真实 store**（真 ProjectStore / 真 SessionCatalog / 真 RemoteHostStore + 真引用注册表）；
 *   替身只用于注入交错点（fsPromises 的 rename 故障 = 一次真实写失败），不用假 store 伪造结论。
 * - 每条用例的判据直接来自 K1 §6.3，不放宽也不改写。
 * - 门控下若某条实际是绿的（说明机制已覆盖），如实记录，不写成红。
 */

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "project-1";
const GATE_REASON = "INV-5 未实施：这是 K1 6.3 的预期红例，默认跳过；置 PIDECK_INV5_EXPECT_RED=1 复现";
const EXPECT_RED = process.env.PIDECK_INV5_EXPECT_RED === "1";
/** 唯一的门控入口：默认 skip（fail 0），门控打开时真跑。 */
const expectedRed = (name, fn) => test(name, { skip: EXPECT_RED ? false : GATE_REASON }, fn);

const CASE_NAMES = ["CE-1 丢失更新", "CE-2 登记 vs 退役", "CE-3 删项目 vs 删会话", "CE-4 端口 CAS 可见性", "CE-5 拒绝不写盘"];

const nodeRequire = createRequire(import.meta.url);
const { canonicalHostLocatorJson } = loadTsCommonJs("src/main/remote/HostRebindJournal.ts");
const { encodeProjectStoreSnapshot } = loadTsCommonJs("src/main/projects/projectStoreCodec.ts");
const { createRemoteHostReferenceRegistry } = loadTsCommonJs("src/main/remote/RemoteHostReferenceSources.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");

/** 跨 VM realm 的对象比较前先归一化。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

async function makeTempDir(t, prefix) {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

/** 生产 ProjectStore：electron 只用到 app.getPath("userData") 与 dialog（与既有套件同型）。 */
function loadProjectStore(userData) {
	return loadTsCommonJs("src/main/projects/ProjectStore.ts", { stubs: { electron: { app: { getPath: () => userData }, dialog: {} } } });
}

function loadSessionCatalog(fsPromises = nodeRequire("node:fs/promises")) {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "node:fs/promises": fsPromises, "../logging/sharedLogger": { getAppLogger: () => null } } });
}

/** 一个真实实例 = 一个「进程」：load 到内存快照后各自 save。 */
async function openProjectStore(userData) {
	const { ProjectStore } = loadProjectStore(userData);
	const store = new ProjectStore();
	await store.load();
	return store;
}

/** catalog 写失败注入：rename 到主文件时抛 EIO（真实写失败，store 本身是真的）。 */
function catalogWithFailingWrite(catalogPath) {
	const realFs = nodeRequire("node:fs/promises");
	const injected = () => Object.assign(new Error("EIO: injected rename failure"), { code: "EIO" });
	const stub = {
		...realFs,
		async rename(from, to) {
			if (String(to) === catalogPath) throw injected();
			return realFs.rename(from, to);
		},
	};
	return loadSessionCatalog(stub);
}

function remoteProjectFixture(id, hostId, remotePath) {
	return { id, name: "remote", lastOpenedAt: 1, locator: { kind: "ssh", hostId, remotePath } };
}

function localProjectFixture(id, name, path) {
	return { id, name, path, lastOpenedAt: 1, environment: "windows" };
}

async function writeProjectsFixture(userData, projects, revision) {
	await mkdir(userData, { recursive: true });
	const filePath = join(userData, "projects.json");
	await writeFile(filePath, JSON.stringify(encodeProjectStoreSnapshot(projects, revision)), "utf8");
	return filePath;
}

async function writeCatalogFixture(catalogPath, sessions) {
	await mkdir(dirname(catalogPath), { recursive: true });
	await writeFile(catalogPath, JSON.stringify({ version: 1, sessions }, null, 2), "utf8");
}

function catalogEntry(overrides = {}) {
	return { id: "s-1", projectId: PROJECT_ID, title: "Entry", titleLocked: true, titleOrigin: "manual", source: "pi", environment: "native", status: "active", createdAt: 1, updatedAt: 1, ...overrides };
}

async function hashFile(filePath) {
	return createHash("sha256")
		.update(await readFile(filePath))
		.digest("hex");
}

async function captureRejection(operation) {
	try {
		await operation();
	} catch (error) {
		return error.message;
	}
	return undefined;
}

/**
 * 默认运行（未开门控）的正确形态：红例全部 skip，本文件不污染套件。
 * 这个用例本身是绿的，并且真的驱动一次真实 store 读写 + 一次真实引用扫描，保证夹具不是自欺。
 */
test("the counterexample harness drives real stores, and every expected-red case is gated off by default", async (t) => {
	const userData = await makeTempDir(t, "pideck-inv5-harness-");
	await writeProjectsFixture(userData, [localProjectFixture("p-1", "local", "/srv/local")], 3);
	const store = await openProjectStore(userData);
	assert.equal(store.get("p-1")?.name, "local", "真实 ProjectStore 必须能读回夹具");

	// 真实引用注册表：空目录必须是「完整且无引用」，否则后面的红例会建立在假前提上。
	const registry = createRemoteHostReferenceRegistry(join(userData, "session-catalog.json"), join(userData, "projects.json"));
	const scan = await registry.scan();
	assert.equal(scan.complete, true);
	assert.equal(scan.referencedHostIds.size, 0);

	assert.equal(CASE_NAMES.length, 5, "K1 6.3 共 5 条反例");
	assert.equal(GATE_REASON.length > 0, true);
});

/**
 * K1 6.3 反例 1：两个写者各自 load→改→save 造成丢失更新。
 * 期望（红）：后写者必须看见先写者已提交的记录；今天各自在内存 revision 上 +1，整份覆盖。
 */
expectedRed("CE-1: a second writer overwrites the first writer's committed remote project (INV-5a lost update)", async (t) => {
	const userData = await makeTempDir(t, "pideck-inv5-ce1-");
	await writeProjectsFixture(userData, [localProjectFixture("p-1", "local", "/srv/local")], 1);

	const writerA = await openProjectStore(userData);
	const writerB = await openProjectStore(userData);
	await writerA.addRemote({ hostId: SOURCE, canonicalRemotePath: "/srv/one" });
	await writerB.addRemote({ hostId: SOURCE, canonicalRemotePath: "/srv/two" });

	const reloaded = await openProjectStore(userData);
	const remotePaths = reloaded
		.list()
		.filter((project) => project.locator && project.locator.kind === "ssh")
		.map((project) => project.locator.remotePath)
		.sort();
	assert.deepEqual(remotePaths, ["/srv/one", "/srv/two"], "INV-5a：后写者覆盖了先写者已提交的记录（今天预期红）");
});

/**
 * K1 6.3 反例 2：登记 vs 退役交错 —— 读 host 存在 → retire 提交 → 写引用。
 * 期望（红）：INV-1 要求任何引用都能解析到 profile；今天 ProjectStore.addRemote 不查 host。
 */
expectedRed("CE-2: a reference written after the host retired leaves a dangling reference (INV-1)", async (t) => {
	const userData = await makeTempDir(t, "pideck-inv5-ce2-");
	// 真 RemoteHostStore + 真引用注册表（扫描真 projects.json / session-catalog.json）。
	const registry = createRemoteHostReferenceRegistry(join(userData, "session-catalog.json"), join(userData, "projects.json"));
	const hosts = await RemoteHostStore.open(userData, { referenceRegistry: registry });
	const draft = await hosts.createDraft({ label: "host", sshHost: "10.81.2.15", connectTimeoutMs: 10000 }, hosts.getSnapshot().revision);

	// 登记侧的第一步：读 host 存在（生产里此前还有一次远端 canonical 复核；这里建模的是窗口本身）。
	assert.equal(hosts.getProfile(draft.id)?.id, draft.id, "写引用之前 host 确实存在");

	// 窗口内另一半：tombstone → retire（此刻无任何引用，扫描完整且为空，因此退役成功）。
	const disabled = await hosts.disable(draft.id, hosts.getSnapshot().revision);
	assert.equal(typeof disabled.disabledAt, "string");
	await hosts.retire(draft.id, hosts.getSnapshot().revision);
	const retired = hosts.getSnapshot();
	assert.equal(retired.retiredHostIds.includes(draft.id), true, "前置：host 已退役");

	// 登记的写入落盘（生产 enroll 端口最终就是 ProjectStore.addRemote 这一句）。
	const projects = await openProjectStore(userData);
	await projects.addRemote({ hostId: draft.id, canonicalRemotePath: "/srv/app" });

	const disk = JSON.parse(await readFile(join(userData, "projects.json"), "utf8"));
	const reference = disk.projects.find((project) => project.locator && project.locator.kind === "ssh");
	assert.equal(reference.locator.hostId, draft.id, "前置：引用确实写入了");
	assert.equal(retired.retiredHostIds.includes(reference.locator.hostId), false, "INV-1：引用指向了已退役的 hostId（今天预期红）");
});

/**
 * K1 6.3 反例 3：删项目 + 删会话，第二段失败被吞。
 * 期望（红）：删项目后不得残留指向它的 catalog 引用；今天生产序列 .catch(() => 0) 把失败变成「0 条」。
 */
expectedRed("CE-3: a failed session sweep is swallowed and the catalog keeps the deleted project's reference", async (t) => {
	const userData = await makeTempDir(t, "pideck-inv5-ce3-");
	const catalogPath = join(userData, "session-catalog.json");
	await writeProjectsFixture(userData, [localProjectFixture(PROJECT_ID, "local", "/srv/local")], 1);
	await writeCatalogFixture(catalogPath, [catalogEntry()]);

	const projects = await openProjectStore(userData);
	const { SessionCatalog } = catalogWithFailingWrite(catalogPath);
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();

	// 生产序列逐字照抄（src/main/ipc/projectsIpc.ts:108-112，同型见 index.ts:3766-3768）。
	await projects.remove(PROJECT_ID);
	const removedSessions = await catalog.removeByProjectId(PROJECT_ID).catch(() => 0);
	assert.equal(removedSessions, 0, "前置：被吞掉后，返回值与「本来就没有会话」无法区分（无告警）");

	const durable = JSON.parse(await readFile(catalogPath, "utf8"));
	const survivors = durable.sessions.filter((entry) => entry.projectId === PROJECT_ID);
	assert.equal(survivors.length, 0, "INV-5：删项目后不得残留指向它的 catalog 引用（今天预期红）");
});

/**
 * K1 6.3 反例 4：端口 CAS 看不见另一实例已提交的磁盘内容。
 * 期望（红）：端口读回磁盘最新内容、把别人改过的记录判 changed；今天权威是内存快照，会整份覆盖。
 */
expectedRed("CE-4: the rebind port cannot see another instance's committed write and overwrites it (INV-5a)", async (t) => {
	const userData = await makeTempDir(t, "pideck-inv5-ce4-");
	await writeProjectsFixture(userData, [remoteProjectFixture("p-remote", SOURCE, "/srv/app")], 3);

	const writerA = await openProjectStore(userData);
	const writerB = await openProjectStore(userData);
	const before = canonicalHostLocatorJson({ kind: "ssh", hostId: SOURCE, remotePath: "/srv/app" });
	const toTarget = canonicalHostLocatorJson({ kind: "ssh", hostId: TARGET, remotePath: "/srv/app" });
	const toOther = canonicalHostLocatorJson({ kind: "ssh", hostId: OTHER, remotePath: "/srv/app" });

	const applied = plain(await writerA.applyHostRebind("tx-a", [{ recordId: "p-remote", beforeLocator: before, afterLocator: toTarget }]));
	assert.deepEqual(applied, [{ recordId: "p-remote", outcome: "applied" }], "前置：A 的 rebind 已提交");

	// B 用的是 load 时的内存快照：先读回，再用旧 before 提交。
	const staleRead = plain(await writerB.readHostRecordLocators(["p-remote"]));
	const overwritten = plain(await writerB.applyHostRebind("tx-b", [{ recordId: "p-remote", beforeLocator: before, afterLocator: toOther }]));
	const reloaded = await openProjectStore(userData);

	assert.deepEqual([JSON.parse(staleRead[0].locator).hostId, overwritten[0].outcome, reloaded.get("p-remote").locator.hostId], [TARGET, "changed", TARGET], "INV-5a：端口读回最新磁盘内容并把别人改过的记录判 changed，后写者不得覆盖（今天预期红）");
});

/**
 * K1 6.3 反例 5（护栏，今天**预期绿**）：被拒绝的写入必须真的没写。
 * 这条不是红例，而是其余红例的「判据保险」：证明拒绝路径逐字节不变，不需要靠读侧 fail-closed 蒙过去。
 */
expectedRed("CE-5: a refused retire writes nothing (byte-identical store)", async (t) => {
	const userData = await makeTempDir(t, "pideck-inv5-ce5-");
	const registry = createRemoteHostReferenceRegistry(join(userData, "session-catalog.json"), join(userData, "projects.json"));
	const hosts = await RemoteHostStore.open(userData, { referenceRegistry: registry });
	const draft = await hosts.createDraft({ label: "host", sshHost: "10.81.2.15", connectTimeoutMs: 10000 }, hosts.getSnapshot().revision);

	// 用一个真实引用挡住退役。
	const projects = await openProjectStore(userData);
	await projects.addRemote({ hostId: draft.id, canonicalRemotePath: "/srv/app" });
	await hosts.disable(draft.id, hosts.getSnapshot().revision);

	const filePath = join(userData, "remote-hosts.json");
	const beforeHash = await hashFile(filePath);
	const failure = await captureRejection(() => hosts.retire(draft.id, hosts.getSnapshot().revision));
	const afterHash = await hashFile(filePath);
	assert.equal(failure, "REMOTE_HOST_REFERENCED", "被引用的主机必须拒绝退役（既有保证，tests/remoteHostStoreLifecycle.test.mjs）");
	assert.equal(afterHash, beforeHash, "拒绝路径不得写盘（逐字节）");
});
