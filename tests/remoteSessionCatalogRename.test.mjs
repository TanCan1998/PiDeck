import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端 catalog 记录的「纯记录操作」档：改名（改标题）不需要任何本地文件读写。
 *
 * 这些用例用**真实** SessionCatalog + **真实** `registerSessionIpc` 注册出来的 handler 驱动，把
 * 本机文件面整个换成「一调用就记录并抛错」的替身：ssh locator 记录必须一路走通且**一次都不碰**
 * 本地文件（`getLocalFilePath` 是本机文件路径的唯一入口，它被调用就是回归）。
 * 同一份替身同时守本机行为不变：本机会话改名仍然要重写会话文件里的 name 行。
 */

const HOST = "11111111-1111-4111-8111-111111111111";
const REMOTE_PROJECT = { id: "project-remote", name: "Remote", locator: { kind: "ssh", hostId: HOST, remotePath: "/srv/app" } };
const LOCAL_PROJECT = { id: "project-local", name: "Local", locator: { kind: "local", environment: "native", path: "/work/app" } };
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
/** P4.5b：远端归档的稳定码取值域（与生产同一份常量，避免断言里的字面量漂移）。 */
const { REMOTE_SESSION_ARCHIVE_CODES } = loadTsCommonJs("src/main/remote/RemoteSessionArchive.ts");

/** 本机文件面替身：调用即留痕（`localCalls` 非空就是「远端路径落进了本机文件操作」）。 */
async function setup(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-rename-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalogPath = join(directory, "session-catalog.json");
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const localCalls = [];
	const localPathLookups = [];
	const localPath = join(directory, "local-session.jsonl");
	const handlers = new Map();
	const localFileOperation = (name) => () => {
		localCalls.push(name);
		throw new Error("LOCAL_FILE_OPERATION_FOR_REMOTE:" + name);
	};
	// 唯一允许「被调用」的本机入口是会话文件改写（本机改名必须走它，远端改名不许走）。它留痕但成功。
	const sessionScanner = {
		rename: async (filePath, title) => {
			localCalls.push(`rename:${filePath}`);
			return { filePath, title };
		},
		delete: localFileOperation("delete"),
		archive: localFileOperation("archive"),
		listArchived: localFileOperation("list-archived"),
		deleteArchived: localFileOperation("delete-archived"),
	};
	const originalGetLocalFilePath = catalog.getLocalFilePath.bind(catalog);
	catalog.getLocalFilePath = (sessionId) => {
		localPathLookups.push(sessionId);
		return originalGetLocalFilePath(sessionId);
	};
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, app: { getPath: () => directory } },
		},
	});
	registerSessionIpc({
		projectStore: { get: (id) => [REMOTE_PROJECT, LOCAL_PROJECT].find((project) => project.id === id) },
		sessionCatalog: catalog,
		sessionScanner,
		settingsStore: { get: () => ({}) },
		sessionRuntimeCoordinator: {
			// 没有运行实例：改名只能靠 catalog 记录（远端有 runtime 时走 RPC 分支，不在本文件范围）。
			getTarget: () => undefined,
			isActivating: () => false,
			releaseRuntimeForDelete: localFileOperation("release-runtime"),
		},
		mainCopy: (key) => key,
		appLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
		getMainWindow: () => undefined,
	});
	const update = (sessionId, patch) => handlers.get(ipcChannels.sessionsCatalogUpdate)({}, sessionId, patch);
	/** 登记一条 ssh locator 记录：与远端扫描登记同一条生产入口（remoteSessionId + remotePath）。 */
	const registerRemote = (remoteSessionId) =>
		catalog.ensureRemoteSession({
			projectId: REMOTE_PROJECT.id,
			hostId: HOST,
			remoteSessionId,
			remotePath: remoteSessionId,
			title: remoteSessionId
				.split("/")
				.pop()
				.replace(/\.jsonl$/, ""),
			updatedAt: 1700000000000,
		});
	/** 本机会话记录：草稿 + 本地 locator（写入 filePath 是本地会话唯一的合法来源）。 */
	const createLocal = async () => {
		const draft = await catalog.createDraft({ projectId: LOCAL_PROJECT.id, title: "本地会话", environment: "native" });
		await catalog.update(draft.id, { filePath: localPath });
		return draft.id;
	};
	return { catalog, catalogPath, handlers, update, registerRemote, createLocal, localCalls, localPathLookups, localPath };
}

test("remote rename updates the catalog title without any local file access", async (t) => {
	const h = await setup(t);
	const { record } = await h.registerRemote("--srv-app--/renamed-target.jsonl");

	const updated = await h.update(record.id, { title: "远端会话：改名后" });

	assert.equal(updated.title, "远端会话：改名后");
	// 「不碰文件」的判据是这两条：本机文件路径解析一次没做，本机文件改写一次没做。
	assert.deepEqual(h.localPathLookups, []);
	assert.deepEqual(h.localCalls, []);
});

test("remote rename persists the manual title and keeps the ssh locator intact", async (t) => {
	const h = await setup(t);
	const { record } = await h.registerRemote("--srv-app--/renamed-persist.jsonl");

	await h.update(record.id, { title: "远端会话：持久化" });

	// 重新加载磁盘上的 catalog：标题是记录里的真值，且 locator 仍是 ssh（没有退化成 filePath）。
	const reloaded = new SessionCatalog(h.catalogPath);
	await reloaded.load();
	const entry = reloaded.get(record.id);
	assert.equal(entry.title, "远端会话：持久化");
	assert.equal(entry.locator.kind, "ssh");
	assert.equal(entry.locator.remotePath, "--srv-app--/renamed-persist.jsonl");
	assert.equal(entry.filePath, undefined);
	// 重名登记不得把用户改成的手动标题覆盖回文件名 stem（manual 是终态）。
	const again = await reloaded.ensureRemoteSession({
		projectId: REMOTE_PROJECT.id,
		hostId: HOST,
		remoteSessionId: "--srv-app--/renamed-persist.jsonl",
		remotePath: "--srv-app--/renamed-persist.jsonl",
		title: "renamed-persist",
		updatedAt: 1700000001000,
	});
	assert.equal(again.record.title, "远端会话：持久化");
});

test("local session rename still rewrites the session file name line", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createLocal();

	const updated = await h.update(sessionId, { title: "本地会话：改名后" });

	assert.equal(updated.title, "本地会话：改名后");
	// 本机行为不变：仍然解析本机文件路径并按路径改写 name 行。
	assert.deepEqual(h.localPathLookups, [sessionId]);
	assert.deepEqual(h.localCalls, [`rename:${h.localPath}`]);
});

test("remote record archive stays fail-closed when no remote archive port is wired: no file move, record kept", async (t) => {
	const h = await setup(t);
	const { record } = await h.registerRemote("--srv-app--/archive-guard.jsonl");

	// 归档＝把会话文件移进 .pideck-archive/（远端写入）。P4.5b 已实现远端归档（见
	// tests/remoteSessionArchive.test.mjs），**但装配没提供远端端口时**（实验开关关掉/旧装配）
	// 仍必须 fail-closed：稳定码，且不能因为改名开了口子就顺手把远端记录从 catalog 摘掉、
	// 也不能落回本机路径分支（那是本档当初要守的边界，现在换成“稳定码拒绝”这一条）。
	await assert.rejects(
		() => h.handlers.get(ipcChannels.sessionsCatalogArchive)({}, record.id),
		(error) => error.message === REMOTE_SESSION_ARCHIVE_CODES.unavailable,
	);
	assert.deepEqual(h.localCalls, []);
	assert.deepEqual(h.localPathLookups, []);
	assert.equal(h.catalog.get(record.id)?.id, record.id);
});
