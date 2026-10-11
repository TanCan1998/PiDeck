import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 登记 vs 退役交错的端到端回归（K1 §6.2 `crossStoreEnrollRetireRace`，反例 2 修复后的形态）。
 *
 * 不变量（INV-1）：**任何存在的引用都必须能解析到一个 profile**。两个顺序都要成立：
 * - 先退役后登记：登记被拒（稳定码 + 磁盘不变），退役不被悄悄撤销；
 * - 先登记后退役：退役被拒（引用扫描是磁盘权威且完整），引用继续可解析；
 * - 解除引用后再退役：成功，且最终「引用集合为空」是**证明出来的**（扫描 complete），不是判不出来。
 *
 * 这里不注入任何人为交错：两个顺序本身就是生产里可达的两种交错。
 */

const { createRemoteHostReferenceRegistry } = loadTsCommonJs("src/main/remote/RemoteHostReferenceSources.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { createRemoteReferenceWriteGuard, REMOTE_HOST_REFERENCE_HOST_UNRESOLVED } = loadTsCommonJs("src/main/remote/RemoteReferenceWriteGuard.ts");

function loadProjectStore(userData) {
	return loadTsCommonJs("src/main/projects/ProjectStore.ts", { stubs: { electron: { app: { getPath: () => userData }, dialog: {} } } });
}

async function makeHarness(t) {
	const userData = await mkdtemp(join(tmpdir(), "pideck-enroll-retire-"));
	t.after(() => rm(userData, { recursive: true, force: true }));
	const projectsPath = join(userData, "projects.json");
	const registry = createRemoteHostReferenceRegistry(join(userData, "session-catalog.json"), projectsPath);
	const hosts = await RemoteHostStore.open(userData, { referenceRegistry: registry });
	const draft = await hosts.createDraft({ label: "host", sshHost: "10.81.2.15", connectTimeoutMs: 10000 }, hosts.getSnapshot().revision);
	const guard = createRemoteReferenceWriteGuard({ userDataDir: userData });
	const { ProjectStore } = loadProjectStore(userData);
	const projects = new ProjectStore(undefined, { referenceGuard: guard });
	await projects.load();
	return { userData, hosts, draft, projects, projectsPath, registry };
}

/** INV-1 的可执行判据：磁盘上不存在指向 retiredHostIds 的引用。 */
async function danglingReferences(harness) {
	const retired = new Set(harness.hosts.getSnapshot().retiredHostIds);
	const disk = JSON.parse(await readFile(harness.projectsPath, "utf8"));
	return disk.projects.filter((project) => project.locator?.kind === "ssh" && retired.has(project.locator.hostId)).map((project) => project.id);
}

async function captureRejection(operation) {
	try {
		await operation();
	} catch (error) {
		return error.message;
	}
	return undefined;
}

test("先退役后登记：写引用被拒（稳定码），磁盘不变，退役不被撤销（INV-1 守住）", async (t) => {
	const harness = await makeHarness(t);
	// 登记侧第一步：读 host 存在（生产里此后还有一次远端 canonical 复核）。
	assert.equal(harness.hosts.getProfile(harness.draft.id)?.id, harness.draft.id);

	// 窗口内另一半：disable → retire（此刻确实没有任何引用，扫描完整且为空，所以退役是合法的）。
	await harness.hosts.disable(harness.draft.id, harness.hosts.getSnapshot().revision);
	await harness.hosts.retire(harness.draft.id, harness.hosts.getSnapshot().revision);
	assert.equal(harness.hosts.getSnapshot().retiredHostIds.includes(harness.draft.id), true, "前置：host 已退役");

	const before = await readFile(harness.projectsPath, "utf8");
	const rejection = await captureRejection(() => harness.projects.addRemote({ hostId: harness.draft.id, canonicalRemotePath: "/srv/app" }));
	assert.equal(rejection, REMOTE_HOST_REFERENCE_HOST_UNRESOLVED, "引用写入必须被拒，且给出可行动的稳定码");
	assert.equal(await readFile(harness.projectsPath, "utf8"), before, "被拒的写入不得改 projects.json（逐字节）");
	assert.deepEqual(await danglingReferences(harness), [], "不得存在指向已退役 id 的引用");
	assert.equal(harness.hosts.getProfile(harness.draft.id), undefined, "退役事实不得被写入侧悄悄撤销（profile 已删除）");
});

test("先登记后退役：退役被拒；解除引用后退役成功，且「无引用」是扫描证明出来的", async (t) => {
	const harness = await makeHarness(t);
	await harness.projects.addRemote({ hostId: harness.draft.id, canonicalRemotePath: "/srv/app" });
	await harness.hosts.disable(harness.draft.id, harness.hosts.getSnapshot().revision);

	const rejection = await captureRejection(() => harness.hosts.retire(harness.draft.id, harness.hosts.getSnapshot().revision));
	assert.equal(rejection, "REMOTE_HOST_REFERENCED", "被引用的主机不得退役（既有保证，INV-2）");
	assert.notEqual(harness.hosts.getProfile(harness.draft.id), undefined, "引用仍能解析到 profile");
	assert.deepEqual(await danglingReferences(harness), []);

	// 解除引用（先清引用、再删被引用者，见 projectRemoval）后退役成功。
	const remoteProject = harness.projects.list().find((project) => project.locator?.kind === "ssh");
	assert.ok(remoteProject, "前置：远端项目已登记");
	await harness.projects.remove(remoteProject.id);
	await harness.hosts.retire(harness.draft.id, harness.hosts.getSnapshot().revision);
	assert.equal(harness.hosts.getSnapshot().retiredHostIds.includes(harness.draft.id), true);

	const scan = await harness.registry.scan();
	assert.equal(scan.complete, true, "「没有引用」必须是完整扫描的结论");
	assert.equal(scan.referencedHostIds.size, 0);
	assert.deepEqual(await danglingReferences(harness), []);
});
