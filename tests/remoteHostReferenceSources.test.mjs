import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteHostReferenceRegistry } = loadTsCommonJs("src/main/remote/RemoteHostReferenceSources.ts");
const HOST_ID = "01234567-89ab-4def-8123-456789abcdef";

async function catalogPath(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-host-references-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "session-catalog.json");
}

/** 两个持久化引用源都在同一个临时 userData 下：sessions 与 projects。 */
async function registryPaths(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-host-references-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return { catalogPath: join(directory, "session-catalog.json"), projectsPath: join(directory, "projects.json") };
}

function registryFor(paths) {
	return createRemoteHostReferenceRegistry(paths.catalogPath, paths.projectsPath);
}

function session(id, locator) {
	return { id, projectId: "project-1", title: "Session", environment: "native", status: "active", locator };
}

/** v2 projects envelope；locator 直接给出，便于构造本地/远端/畸形记录。 */
function projectsSnapshot(projects) {
	return { schemaVersion: 2, revision: 1, projects };
}

function remoteProject(id, hostId, remotePath = "/srv/app") {
	return { id, name: id, lastOpenedAt: 1, locator: { kind: "ssh", hostId, remotePath } };
}

test("the registry refuses a relative or control-character path for either source", () => {
	assert.throws(() => createRemoteHostReferenceRegistry("session-catalog.json", "/tmp/projects.json"), /REMOTE_HOST_REFERENCE_SCAN_INVALID/);
	assert.throws(() => createRemoteHostReferenceRegistry("/tmp/catalog\n.json", "/tmp/projects.json"), /REMOTE_HOST_REFERENCE_SCAN_INVALID/);
	assert.throws(() => createRemoteHostReferenceRegistry("/tmp/catalog.json", "projects.json"), /REMOTE_HOST_REFERENCE_SCAN_INVALID/);
	assert.throws(() => createRemoteHostReferenceRegistry("/tmp/catalog.json", "/tmp/projects.json\u007f"), /REMOTE_HOST_REFERENCE_SCAN_INVALID/);
});

test("all sources are registered and absent stores have no persisted references", async (t) => {
	const registry = registryFor(await registryPaths(t));
	assert.deepEqual(Array.from(registry.registeredSources()), ["projects", "sessions", "host-profiles", "runtime"]);
	const scan = await registry.scan();
	assert.equal(scan.complete, true);
	assert.deepEqual(Array.from(scan.unavailable), []);
	assert.deepEqual(Array.from(scan.referencedHostIds), []);
});

test("the persisted SSH locator contributes a host reference without rewriting the catalog", async (t) => {
	const paths = await registryPaths(t);
	const filePath = paths.catalogPath;
	const raw = JSON.stringify({ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID, remotePath: "/work" }), session("local-1", { kind: "local", environment: "native", filePath: "/work/local" })] });
	await writeFile(filePath, raw);
	const registry = registryFor(paths);
	const scan = await registry.scan();
	assert.equal(scan.complete, true);
	assert.deepEqual(Array.from(scan.referencedHostIds), [HOST_ID]);
	assert.deepEqual(
		Array.from(scan.hits, (hit) => `${hit.source}:${hit.recordId}`),
		["sessions:remote-1"],
	);
	assert.equal(await readFile(filePath, "utf8"), raw);
});

test("a broken primary is incomplete even if a backup claims no references", async (t) => {
	const paths = await registryPaths(t);
	const filePath = paths.catalogPath;
	await writeFile(filePath, "{bad json");
	await writeFile(`${filePath}.bak`, JSON.stringify({ version: 1, sessions: [] }));
	const registry = registryFor(paths);
	const scan = await registry.scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["sessions"]);
	await assert.rejects(registry.asStoreReferences().referencedHostIds(), /REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE/);
});

test("a missing primary with an existing backup never reports an empty complete scan", async (t) => {
	const paths = await registryPaths(t);
	const filePath = paths.catalogPath;
	await writeFile(`${filePath}.bak`, JSON.stringify({ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID })] }));
	const scan = await registryFor(paths).scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["sessions"]);
});

test("unknown versions, locators and malformed siblings fail closed", async (t) => {
	const paths = await registryPaths(t);
	const filePath = paths.catalogPath;
	for (const snapshot of [
		{ version: 2, sessions: [] },
		{ version: 1, sessions: [session("remote-1", { kind: "future", hostId: HOST_ID })] },
		{ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: "not-a-host-id" })] },
		// hostId 是 host store 的 profile 主键：大写/截断/非字符串域外取值与非法字段一律判死。
		{ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID.toUpperCase() })] },
		{ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID, remotePath: 7 })] },
		{ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID, remotePath: "x".repeat(4097) })] },
		// 本地 locator 携带 hostId：一条不在 ssh 分支里的主机引用，不能当成本地会话跳过。
		{ version: 1, sessions: [session("local-host", { kind: "local", environment: "native", filePath: "/work/local", hostId: HOST_ID })] },
		{ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID }), {}] },
	]) {
		await writeFile(filePath, JSON.stringify(snapshot));
		const scan = await registryFor(paths).scan();
		assert.equal(scan.complete, false, `${JSON.stringify(snapshot)} must not certify an empty set`);
		assert.deepEqual(Array.from(scan.unavailable), ["sessions"]);
	}
});

// G3 早期只写 hostId（remotePath/remoteSessionId 一直是可选字段）：收窄 hostId 值域不得把这类
// 历史记录判成"没有引用"。
test("an ssh session locator with only a hostId still contributes a reference", async (t) => {
	const paths = await registryPaths(t);
	await writeFile(paths.catalogPath, JSON.stringify({ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID })] }));
	const scan = await registryFor(paths).scan();
	assert.equal(scan.complete, true);
	assert.deepEqual(Array.from(scan.referencedHostIds), [HOST_ID]);
	assert.deepEqual(
		Array.from(scan.hits, (hit) => `${hit.source}:${hit.recordId}`),
		["sessions:remote-1"],
	);
});

test("an oversized catalog is incomplete without reading it into memory", async (t) => {
	const paths = await registryPaths(t);
	const filePath = paths.catalogPath;
	await writeFile(filePath, "");
	await truncate(filePath, 16 * 1024 * 1024 + 1);
	const scan = await registryFor(paths).scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["sessions"]);
});

test("a catalog symlink is never followed", { skip: process.platform === "win32" }, async (t) => {
	const paths = await registryPaths(t);
	const filePath = paths.catalogPath;
	const targetDir = await mkdtemp(join(tmpdir(), "pideck-host-target-"));
	t.after(() => rm(targetDir, { recursive: true, force: true }));
	const targetPath = join(targetDir, "target.json");
	await writeFile(targetPath, JSON.stringify({ version: 1, sessions: [] }));
	await symlink(targetPath, filePath);
	const scan = await registryFor(paths).scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["sessions"]);
});

test("an ssh project contributes a host reference without rewriting projects.json", async (t) => {
	const paths = await registryPaths(t);
	const raw = JSON.stringify(projectsSnapshot([remoteProject("remote-1", HOST_ID), { id: "local-1", name: "local", lastOpenedAt: 1, locator: { kind: "local", environment: "native", localPath: "/srv/local" } }]));
	await writeFile(paths.projectsPath, raw);
	const scan = await registryFor(paths).scan();
	assert.equal(scan.complete, true);
	assert.deepEqual(Array.from(scan.referencedHostIds), [HOST_ID]);
	assert.deepEqual(
		Array.from(scan.hits, (hit) => `${hit.source}:${hit.recordId}`),
		["projects:remote-1"],
	);
	assert.equal(await readFile(paths.projectsPath, "utf8"), raw, "扫描是纯读，不改写项目库");
});

test("projects and sessions contribute a conservative union with per-source hits", async (t) => {
	const paths = await registryPaths(t);
	const second = "fedcba98-7654-4321-8fed-cba987654321";
	await writeFile(paths.catalogPath, JSON.stringify({ version: 1, sessions: [session("remote-1", { kind: "ssh", hostId: HOST_ID, remotePath: "/work" })] }));
	await writeFile(paths.projectsPath, JSON.stringify(projectsSnapshot([remoteProject("p-1", second)])));
	const scan = await registryFor(paths).scan();
	assert.equal(scan.complete, true);
	assert.deepEqual(Array.from(scan.referencedHostIds).sort(), [HOST_ID, second].sort());
	assert.deepEqual(
		Array.from(scan.hits, (hit) => `${hit.source}:${hit.recordId}`),
		["projects:p-1", "sessions:remote-1"],
	);
});

test("a malformed or corrupt projects store is incomplete, never an empty reference set", async (t) => {
	const paths = await registryPaths(t);
	for (const snapshot of [
		{ schemaVersion: 1, revision: 1, projects: [] },
		{ schemaVersion: 2, revision: 1, projects: [remoteProject("p-1", "not-a-host-id")] },
		// v2 信封要求每条记录都带 locator（本地记录也有）；缺字段是畸形记录，不是"没有引用"。
		{ schemaVersion: 2, revision: 1, projects: [{ id: "p-1", name: "p", lastOpenedAt: 1 }] },
		// hostId 合法但 remotePath 不是 canonical 远端目录：codec 会拒绝整份 store，扫描必须同样判死。
		{ schemaVersion: 2, revision: 1, projects: [remoteProject("p-1", HOST_ID, "relative/path")] },
		// 本地 locator 携带 hostId：一条不在 ssh 分支里的主机引用，不能当成本地项目跳过。
		{ schemaVersion: 2, revision: 1, projects: [{ id: "p-1", name: "p", lastOpenedAt: 1, locator: { kind: "local", environment: "native", localPath: "/tmp/p", hostId: HOST_ID } }] },
		{ schemaVersion: 2, revision: 1, projects: [{ id: "p-1", name: "p", lastOpenedAt: 1, locator: { kind: "future", hostId: HOST_ID } }] },
		{ schemaVersion: 2, revision: 1, projects: [{}] },
	]) {
		await writeFile(paths.projectsPath, JSON.stringify(snapshot));
		const scan = await registryFor(paths).scan();
		assert.equal(scan.complete, false, `${JSON.stringify(snapshot)} must not certify an empty set`);
		assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
	}
	await writeFile(paths.projectsPath, "{truncated");
	const scan = await registryFor(paths).scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
	await assert.rejects(registryFor(paths).asStoreReferences().referencedHostIds(), /REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE/);
});

// 旧 v1 数组仍是 ProjectStore 的可用读取路径（load 会把它迁移成 v2），所以扫描不能把
// 整源判死 —— 否则一个还没被应用改写的文件会让 retire 永久不可用。v1 记录以 path 表达位置，
// 没有 locator，因此结构上不可能命名任何主机。
test("a legacy v1 project array stays scan-complete and contributes no host reference", async (t) => {
	const paths = await registryPaths(t);
	const raw = JSON.stringify([{ id: "legacy-1", name: "legacy", path: "C:\\work\\legacy", lastOpenedAt: 1, environment: "windows" }]);
	await writeFile(paths.projectsPath, raw);
	const scan = await registryFor(paths).scan();
	assert.equal(scan.complete, true);
	assert.deepEqual(Array.from(scan.referencedHostIds), []);
	assert.equal(await readFile(paths.projectsPath, "utf8"), raw, "扫描是纯读");
});

test("a legacy v1 entry without a usable local path is incomplete", async (t) => {
	const paths = await registryPaths(t);
	for (const entry of [{}, { id: "legacy-1", name: "legacy", lastOpenedAt: 1 }, { id: "legacy-1", path: "   " }]) {
		await writeFile(paths.projectsPath, JSON.stringify([entry]));
		const scan = await registryFor(paths).scan();
		assert.equal(scan.complete, false, `${JSON.stringify(entry)} must not certify an empty set`);
		assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
	}
});

test("a projects backup without its primary is incomplete", async (t) => {
	const paths = await registryPaths(t);
	await writeFile(`${paths.projectsPath}.bak`, JSON.stringify(projectsSnapshot([remoteProject("p-1", HOST_ID)])));
	const scan = await registryFor(paths).scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
});

test("a projects symlink is never followed", { skip: process.platform === "win32" }, async (t) => {
	const paths = await registryPaths(t);
	const targetDir = await mkdtemp(join(tmpdir(), "pideck-host-projects-target-"));
	t.after(() => rm(targetDir, { recursive: true, force: true }));
	const targetPath = join(targetDir, "target.json");
	await writeFile(targetPath, JSON.stringify(projectsSnapshot([])));
	await symlink(targetPath, paths.projectsPath);
	const scan = await registryFor(paths).scan();
	assert.equal(scan.complete, false);
	assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
});
