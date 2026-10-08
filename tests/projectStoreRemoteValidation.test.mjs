import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const sharedLocation = loadTsCommonJs("src/shared/projectLocation.ts");
const { decodeProjectStoreSnapshot } = loadTsCommonJs("src/main/projects/projectStoreCodec.ts");
const { HOST_ID } = loadTsCommonJs("src/main/remote/RemoteHostStoreCodec.ts");
const { readCanonicalBrowseRoot } = loadTsCommonJs("src/main/remote/RemoteBrowseRoot.ts");
const { createRemoteHostReferenceRegistry } = loadTsCommonJs("src/main/remote/RemoteHostReferenceSources.ts");

/** 与 RemoteHostStore 的 randomUUID() 同域的真实主机 id。 */
const HOST_A = "11111111-1111-4111-8111-111111111111";
const HOST_B = "22222222-2222-4222-8222-222222222222";

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function createStore(userData) {
	const { ProjectStore } = loadTsCommonJs("src/main/projects/ProjectStore.ts", {
		stubs: { electron: { app: { getPath: () => userData }, dialog: {} } },
	});
	return new ProjectStore();
}

async function withUserData(run) {
	const userData = await mkdtemp(join(tmpdir(), "pideck-remote-validation-"));
	try {
		await run(userData, join(userData, "projects.json"));
	} finally {
		await rm(userData, { recursive: true, force: true });
	}
}

function projectsSnapshot(projects) {
	return { schemaVersion: 2, revision: 1, projects };
}

function remoteProject(id, hostId, remotePath) {
	return { id, name: id, lastOpenedAt: 1, locator: { kind: "ssh", hostId, remotePath } };
}

function registryFor(userData) {
	return createRemoteHostReferenceRegistry(join(userData, "session-catalog.json"), join(userData, "projects.json"));
}

function codecAccepts(snapshot) {
	try {
		decodeProjectStoreSnapshot(snapshot);
		return true;
	} catch {
		return false;
	}
}

/**
 * 写入侧必须拒绝的候选：全部是 codec 加载时会拒绝的值。
 *
 * 这些值在修复前都能通过 addRemote（只查非空），于是 projects.json 写成了加载时会被整份判成
 * needs-repair 的形状 —— 一次登记就毁掉整个项目库。
 */
const INVALID_TARGETS = [
	{ label: "non-UUID hostId", hostId: "host-a", canonicalRemotePath: "/srv/app" },
	{ label: "empty hostId", hostId: "", canonicalRemotePath: "/srv/app" },
	{ label: "padded hostId", hostId: `${HOST_A} `, canonicalRemotePath: "/srv/app" },
	{ label: "uppercase hostId", hostId: "01234567-89AB-4DEF-8123-456789ABCDEF", canonicalRemotePath: "/srv/app" },
	{ label: "relative remotePath", hostId: HOST_A, canonicalRemotePath: "relative/path" },
	{ label: "root remotePath", hostId: HOST_A, canonicalRemotePath: "/" },
	{ label: "trailing slash", hostId: HOST_A, canonicalRemotePath: "/srv/app/" },
	{ label: "parent segment", hostId: HOST_A, canonicalRemotePath: "/srv/../etc" },
	{ label: "dot segment", hostId: HOST_A, canonicalRemotePath: "/srv/./app" },
	{ label: "empty segment", hostId: HOST_A, canonicalRemotePath: "/srv//app" },
	{ label: "control byte", hostId: HOST_A, canonicalRemotePath: "/srv/app\u0000x" },
	{ label: "over-long remotePath", hostId: HOST_A, canonicalRemotePath: `/${"a".repeat(4096)}` },
];

test("addRemote rejects every ssh target the project codec would refuse", async () => {
	for (const target of INVALID_TARGETS) {
		await withUserData(async (userData, filePath) => {
			const store = createStore(userData);
			await store.load();
			await assert.rejects(store.addRemote({ hostId: target.hostId, canonicalRemotePath: target.canonicalRemotePath }), /REMOTE_PROJECT_TARGET_INVALID/, target.label);
			// 拒绝必须发生在写盘之前：不能留下一条"写进去但读不出来"的远端记录。
			assert.equal(codecAccepts(JSON.parse(await readFile(filePath, "utf8"))), true, `${target.label}: store must stay loadable`);
			assert.equal(store.list().filter((project) => project.locator?.kind === "ssh").length, 0, target.label);
		});
	}
});

test("an ssh target the write side accepts always decodes on the next load", async () => {
	await withUserData(async (userData, filePath) => {
		const store = createStore(userData);
		await store.load();
		const project = await store.addRemote({ hostId: HOST_B, canonicalRemotePath: "/srv/app" });
		assert.deepEqual(plain(project.locator), { kind: "ssh", hostId: HOST_B, remotePath: "/srv/app" });

		// 写入通过就必须能读回：这是"写入可通过、加载被拒 ⇒ 整份 store 进 needs-repair"的复现点。
		const reopened = createStore(userData);
		await reopened.load();
		assert.deepEqual(plain(reopened.get(project.id)?.locator), { kind: "ssh", hostId: HOST_B, remotePath: "/srv/app" });
		assert.equal(codecAccepts(JSON.parse(await readFile(filePath, "utf8"))), true);
	});
});

test("a v2 project record without a locator is incomplete, never 'no references'", async () => {
	await withUserData(async (userData, filePath) => {
		await writeFile(filePath, JSON.stringify(projectsSnapshot([{ id: "p-1", name: "p", lastOpenedAt: 1 }])), "utf8");
		const registry = registryFor(userData);
		const scan = await registry.scan();
		assert.equal(scan.complete, false, "缺 locator 的 v2 记录必须让 projects 源不完整");
		assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
		await assert.rejects(registry.asStoreReferences().referencedHostIds(), /REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE/);
	});
});

test("a v2 ssh record with an invalid remotePath is incomplete, not a host reference", async () => {
	for (const remotePath of ["relative/path", "/", "/srv/app/", "/srv/../etc", "/srv/app\u0000x", `/${"a".repeat(4096)}`]) {
		await withUserData(async (userData, filePath) => {
			const snapshot = projectsSnapshot([remoteProject("p-1", HOST_A, remotePath)]);
			assert.equal(codecAccepts(snapshot), false, `codec must refuse ${JSON.stringify(remotePath)}`);
			await writeFile(filePath, JSON.stringify(snapshot), "utf8");
			const scan = await registryFor(userData).scan();
			assert.equal(scan.complete, false, `scan must not certify ${JSON.stringify(remotePath)} as no-reference`);
			assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
		});
	}
});

test("a local locator that carries a hostId is incomplete, not a project without references", async () => {
	await withUserData(async (userData, filePath) => {
		const snapshot = projectsSnapshot([{ id: "p-1", name: "p", lastOpenedAt: 1, locator: { kind: "local", environment: "native", localPath: "/tmp/p", hostId: HOST_A } }]);
		// codec 与扫描必须同判：否则同一记录 codec 放行、扫描抛错（或反过来漏掉引用）。
		assert.equal(codecAccepts(snapshot), false);
		await writeFile(filePath, JSON.stringify(snapshot), "utf8");
		const scan = await registryFor(userData).scan();
		assert.equal(scan.complete, false);
		assert.deepEqual(Array.from(scan.unavailable), ["projects"]);
	});
});

// ---------------------------------------------------------------------------
// 单一判据的契约：shared 纯校验 = host store 的 id 域 = canonical browse root 的路径域
// ---------------------------------------------------------------------------

test("the shared host id domain is the host store's own profile id domain", () => {
	const corpus = [HOST_A, HOST_B, "host-a", "", `${HOST_A} `, "01234567-89AB-4DEF-8123-456789ABCDEF", "01234567-89ab-4def-8123-456789abcde", `${HOST_A}\u0000`];
	for (const value of corpus) {
		assert.equal(sharedLocation.PROJECT_HOST_ID_PATTERN.test(value), HOST_ID.test(value), `hostId ${JSON.stringify(value)}`);
	}
	// 权威生成方 RemoteHostStore 只发 randomUUID()：两侧都必须放行它，否则合法远端项目会被拒。
	for (let index = 0; index < 64; index += 1) {
		const generated = randomUUID();
		assert.equal(sharedLocation.PROJECT_HOST_ID_PATTERN.test(generated), true);
		assert.equal(HOST_ID.test(generated), true);
	}
});

test("the shared remote path domain is the canonical browse root domain", () => {
	// 只比较"已经确认过的 canonical 值"这一域：readCanonicalBrowseRoot 额外接受远端命令输出末尾的一个
	// 换行并把它剥掉，所以换行结尾的线上值不属于本地既存域（shared 对控制字节一律拒绝）。
	const corpus = ["/srv/app", "/a", "/srv/app/repo", "/srv/with space", "/srv/项目", "/srv\\win", "/", "", "relative", "/srv/app/", "/srv/../etc", "/srv/./app", "/srv//app", "/srv/app\u0000", `/${"a".repeat(4095)}`, `/${"a".repeat(4096)}`];
	for (const value of corpus) {
		let browseAccepted = true;
		try {
			readCanonicalBrowseRoot(value);
		} catch {
			browseAccepted = false;
		}
		assert.equal(sharedLocation.readCanonicalRemoteProjectPath(value) !== undefined, browseAccepted, `remotePath ${JSON.stringify(value)}`);
	}
});

/** 合法目标：写入、codec、扫描三处都必须接受，且 remotePath 原样保留。 */
const VALID_TARGETS = [
	{ label: "canonical posix", hostId: HOST_A, canonicalRemotePath: "/srv/app" },
	{ label: "single segment", hostId: HOST_B, canonicalRemotePath: "/a" },
	{ label: "space and non-ascii", hostId: HOST_A, canonicalRemotePath: "/srv/with space/项目" },
	{ label: "max length", hostId: HOST_A, canonicalRemotePath: `/${"a".repeat(4095)}` },
];

test("write, codec and reference scan accept exactly the same ssh locator domain", async () => {
	const candidates = [...VALID_TARGETS.map((target) => ({ ...target, accept: true })), ...INVALID_TARGETS.map((target) => ({ ...target, accept: false }))];
	for (const candidate of candidates) {
		await withUserData(async (userData, filePath) => {
			const locator = { kind: "ssh", hostId: candidate.hostId, remotePath: candidate.canonicalRemotePath };
			assert.equal(sharedLocation.readSshProjectLocator(locator) !== undefined, candidate.accept, `shared: ${candidate.label}`);
			assert.equal(codecAccepts(projectsSnapshot([{ id: "p-1", name: "p", lastOpenedAt: 1, locator }])), candidate.accept, `codec: ${candidate.label}`);

			const store = createStore(userData);
			await store.load();
			let writeAccepted = true;
			try {
				await store.addRemote({ hostId: candidate.hostId, canonicalRemotePath: candidate.canonicalRemotePath });
			} catch {
				writeAccepted = false;
			}
			assert.equal(writeAccepted, candidate.accept, `write: ${candidate.label}`);

			// 扫描判定用受控快照，与 addRemote 是否落盘无关。
			await writeFile(filePath, JSON.stringify(projectsSnapshot([{ id: "p-1", name: "p", lastOpenedAt: 1, locator }])), "utf8");
			const scan = await registryFor(userData).scan();
			assert.equal(scan.complete, candidate.accept, `scan: ${candidate.label}`);
			assert.deepEqual(Array.from(scan.referencedHostIds), candidate.accept ? [candidate.hostId] : []);
		});
	}
});
