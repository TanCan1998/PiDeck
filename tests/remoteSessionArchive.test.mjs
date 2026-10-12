import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端会话「归档 / 取消归档 / 列出归档」（P4.5b）。
 *
 * 不连真机：远端短命令是**假 SSH exec**——它按真实 `mkdir -p` / `mv` 语义在一份内存文件表上执行，
 * 于是「先建目录再 move」「不覆盖已有归档」「失败时文件确实没动」这些最容易写错的东西被真正测到，
 * 而不是靠 mock 返回现成结果把 bug 掩盖过去。测试同时断言**命令行形状**（只允许单引号字面量、
 * 路径不合法时一个命令都不发），这是「路径判据同源 + 先判后发」那条要求的可执行证据。
 *
 * 覆盖：归档两步顺序 + 索引 + 移出 catalog；列表反映索引（含重启后仍生效）；取消归档移回原位 + 恢复记录；
 * 运行中拒绝且**零远端命令**；路径非法拒绝（相对身份无根 / 含单引号）；远端命令失败 ⇒ 稳定码 + 不谎报成功
 * （记录与索引保持可辨识的状态）；本机归档/取消归档行为不变的回归守卫。
 */

const HOST = "11111111-1111-4111-8111-111111111111";
const HOME = "/home/dev";
const SESSION_ROOT = HOME + "/.pi/agent/sessions";
const REMOTE_ID = "ws/target.jsonl";
const ORIGINAL_PATH = SESSION_ROOT + "/" + REMOTE_ID;
const ARCHIVE_DIR = SESSION_ROOT + "/ws/.pideck-archive";
const ARCHIVED_PATH = ARCHIVE_DIR + "/target.jsonl";
const LOCAL_PROJECT = { id: "project-local", name: "Local" };
const REMOTE_PROJECT = { id: "project-remote", name: "Remote" };

// 命令形状（唯一解析点）：与生产实现的模板字面量逐字对应，形状变了这里先红。
const MKDIR_SHAPE = /^mkdir -p -- '([^'\\]+)'$/;
const MOVE_SHAPE = /^\[ ! -e '([^'\\]+)' \] && mv -- '([^'\\]+)' '([^'\\]+)'$/;
/** 稳定码不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { createRemoteSessionArchive, remoteSessionArchiveTarget, buildRemoteSessionArchiveMoveCommand, buildRemoteSessionArchiveDirCommand, REMOTE_SESSION_ARCHIVE_CODES } = loadTsCommonJs("src/main/remote/RemoteSessionArchive.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

/**
 * 假远端文件系统：一张「路径 → 字节」表 + 目录集合。
 *
 * 命令只有三条语义（mkdir / 存在性检查 / mv），全部按真实 shell 行为实现：
 * `[ ! -e X ] && mv` 在 X 已存在时以非 0 退出（生产用同一条命令保证**不覆盖**已有归档）。
 */
function fakeRemoteFiles(initialFiles) {
	const files = new Map(initialFiles);
	const dirs = new Set();
	// 初始文件的所有祖先目录都当成已存在（真实 FS 里它们当然存在）。
	for (const path of files.keys()) {
		const segments = path.split("/");
		for (let index = 1; index < segments.length; index += 1) dirs.add(segments.slice(0, index).join("/"));
	}
	const commands = [];
	/** 每次命令执行的返回（测试可以改它来模拟远端失败）。 */
	const transport = {
		async runRemoteCommand({ remoteCommand }) {
			commands.push(remoteCommand);
			const mkdir = MKDIR_SHAPE.exec(remoteCommand);
			if (mkdir) {
				dirs.add(mkdir[1]);
				return { exitCode: 0, stdout: "" };
			}
			const move = MOVE_SHAPE.exec(remoteCommand);
			if (!move) throw new Error(`UNEXPECTED_REMOTE_COMMAND: ${remoteCommand}`);
			const [, target, source] = move;
			if (files.has(target) || dirs.has(target)) return { exitCode: 1, stdout: "" };
			if (!files.has(source)) return { exitCode: 1, stdout: "" };
			if (!dirs.has(target.slice(0, target.lastIndexOf("/")))) return { exitCode: 1, stdout: "" };
			files.set(target, files.get(source));
			files.delete(source);
			return { exitCode: 0, stdout: "" };
		},
	};
	return {
		files,
		dirs,
		commands,
		transport,
		resolveSessionRoot: async () => ({ ok: true, root: SESSION_ROOT }),
		has: (path) => files.has(path),
		pathOf: (name) => [...files.keys()].find((path) => path.endsWith(`/${name}`)),
	};
}

/** 生产装配的形态：sessionIpc 的两个远端端口由 `createRemoteSessionArchive` 提供（与 main/index.ts 同一组合）。 */
function remoteArchivePorts(remote) {
	const archive = createRemoteSessionArchive({ transport: remote.transport, resolveSessionRoot: remote.resolveSessionRoot });
	return {
		archiveRemoteSession: (input) => archive.moveIntoArchive(input),
		unarchiveRemoteSession: async (input) => {
			await archive.moveBack(input);
		},
	};
}

/**
 * 真实 `SessionCatalog` + 真实 `registerSessionIpc` + 带命令账本的假远端。
 * 本机文件面（sessionScanner / getLocalFilePath）整体换成留痕替身：远端路径碰它们就是回归。
 */
async function setup(t, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-archive-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalogPath = join(directory, "session-catalog.json");
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const remote = fakeRemoteFiles(new Map([[ORIGINAL_PATH, "remote-bytes"]]));
	const localCalls = [];
	const localPathLookups = [];
	const boundRuntimes = new Set();
	const localArchivedPath = join(directory, "archived-local.jsonl");
	const handlers = new Map();
	const electronStub = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, app: { getPath: () => directory } };
	const localFileOperation = (name) => (arg) => {
		localCalls.push(`${name}:${String(arg)}`);
		throw new Error(`LOCAL_FILE_OPERATION_FOR_REMOTE:${name}`);
	};
	const sessionScanner = {
		archive: localFileOperation("archive"),
		unarchive: async (archivedPath) => {
			localCalls.push(`unarchive:${archivedPath}`);
			return join(directory, "restored-local.jsonl");
		},
		listArchived: async () => [{ summary: { id: "local-archived", filePath: localArchivedPath, name: "本机归档", preview: "", updatedAt: 1, messageCount: 0 }, originalPath: join(directory, "local.jsonl") }],
		deleteArchived: localFileOperation("delete-archived"),
	};
	const originalGetLocalFilePath = catalog.getLocalFilePath.bind(catalog);
	catalog.getLocalFilePath = (sessionId) => {
		localPathLookups.push(sessionId);
		return originalGetLocalFilePath(sessionId);
	};
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", { stubs: { electron: electronStub } });
	registerSessionIpc({
		projectStore: { get: (id) => [LOCAL_PROJECT, REMOTE_PROJECT].find((project) => project.id === id) },
		sessionCatalog: catalog,
		sessionScanner,
		settingsStore: { get: () => ({}) },
		sessionRuntimeCoordinator: {
			getTarget: (sessionId) => (boundRuntimes.has(sessionId) ? { sessionId, agentId: `${sessionId}:agent`, runtimeGeneration: 1 } : undefined),
			isActivating: () => false,
		},
		agentManager: { list: () => [], stop: async () => undefined },
		mainCopy: (key) => key,
		appLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
		getMainWindow: () => undefined,
		...remoteArchivePorts(remote),
		...(options.withoutRemoteArchive ? { archiveRemoteSession: undefined, unarchiveRemoteSession: undefined } : {}),
	});
	/** 一条已登记的远端会话（与扫描登记同形：remoteSessionId + remotePath 都是相对会话根路径）。 */
	const createRemote = async () => {
		const registration = await catalog.ensureRemoteSession({ projectId: REMOTE_PROJECT.id, hostId: HOST, remoteSessionId: REMOTE_ID, remotePath: REMOTE_ID, title: "远端会话", updatedAt: 1_700_000_000_000 });
		return registration.record.id;
	};
	/** 一条本机会话（本地 locator 由 update 写 filePath 建立）。 */
	const createLocal = async () => {
		const draft = await catalog.createDraft({ projectId: LOCAL_PROJECT.id, title: "本机会话", environment: "native" });
		await catalog.update(draft.id, { filePath: join(directory, "local.jsonl") });
		return draft.id;
	};
	return {
		catalog,
		catalogPath,
		remote,
		handlers,
		createRemote,
		createLocal,
		bindRuntime: (sessionId) => boundRuntimes.add(sessionId),
		archive: (sessionId) => handlers.get(ipcChannels.sessionsCatalogArchive)({}, sessionId),
		unarchive: (archivedPath) => handlers.get(ipcChannels.sessionsCatalogUnarchive)({}, archivedPath),
		unarchiveRemote: (sessionId) => handlers.get(ipcChannels.sessionsCatalogUnarchiveRemote)({}, sessionId),
		listArchived: () => handlers.get(ipcChannels.sessionsCatalogListArchived)({}),
		localCalls,
		localPathLookups,
		localArchivedPath,
	};
}

/** 稳定码断言：rejection 的 message 是码（远端 IPC 一系的既有约定）。跨 realm 错误取 message 字段。 */
async function rejectionCode(run) {
	try {
		await run();
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

test("archiving a remote session moves the remote file into .pideck-archive (mkdir before move) and drops the local record", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();

	assert.equal(await h.archive(sessionId), true);

	// 两步顺序：先确保归档目录存在，再 move（同目录 ⇒ 同一文件系统 ⇒ rename 原子）。
	assert.equal(h.remote.commands.length, 2);
	assert.equal(h.remote.commands[0], `mkdir -p -- '${ARCHIVE_DIR}'`);
	assert.equal(h.remote.commands[1], `[ ! -e '${ARCHIVED_PATH}' ] && mv -- '${ORIGINAL_PATH}' '${ARCHIVED_PATH}'`);
	// 命令里只允许单引号字面量（路径里的引号在校验期已被拒绝）。
	for (const command of h.remote.commands) {
		assert.equal(/["`$]/.test(command), false, `命令行不得出现双引号/反引号/命令替换: ${command}`);
	}
	// 假远端按真实 mv 语义执行：文件确实移动了（内容不变、原路径不再存在）。
	assert.equal(h.remote.has(ARCHIVED_PATH), true);
	assert.equal(h.remote.has(ORIGINAL_PATH), false);
	assert.equal(h.remote.files.get(ARCHIVED_PATH), "remote-bytes");
	// 本机记录移出 catalog（与本地归档一致的那一半）。
	assert.equal(h.catalog.get(sessionId), undefined);
	// 本地留存：归档索引记下「哪条会话去哪儿了」（恢复的唯二依据）。
	const entry = h.catalog.getArchivedRemoteSession(sessionId);
	assert.equal(entry.hostId, HOST);
	assert.equal(entry.projectId, REMOTE_PROJECT.id);
	assert.equal(entry.originalRemotePath, ORIGINAL_PATH);
	assert.equal(entry.archivedRemotePath, ARCHIVED_PATH);
	assert.equal(entry.remoteSessionId, REMOTE_ID);
	// 归档不是「移除记录」：不得写墓碑（墓碑会让这条会话永远不再列为可导入）。
	assert.equal(h.catalog.isRemoteSessionDismissed(HOST, REMOTE_ID), false);
	// 本机文件面：归档远端会话不得解析本机路径，也不得做任何本机文件操作。
	assert.deepEqual(h.localPathLookups, []);
	assert.deepEqual(h.localCalls, []);
});

test("the archive index is persisted and shows up in the archived list (remote entries carry an id, not a local path)", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	await h.archive(sessionId);

	const rows = await h.listArchived();
	// 本机归档行原样保留（回归守卫），远端行追加在其后。
	assert.equal(rows.length, 2);
	assert.equal(rows[0].summary.id, "local-archived");
	const remoteRow = rows.find((row) => row.archivedRemoteSessionId === sessionId);
	assert.notEqual(remoteRow, undefined, "远端归档条目必须出现在归档列表里");
	assert.equal(remoteRow.summary.name, "远端会话");
	assert.equal(remoteRow.archivedRemoteSessionId, sessionId);
	// 远端条目**没有**本机归档路径：恢复身份是 id（本机字段里不出现远端路径）。
	assert.equal(remoteRow.originalPath, undefined);
	assert.equal(remoteRow.summary.filePath, "");

	// 重启（重新读 catalog 文件）：索引必须还在，否则「归档了的远端会话既看不到也恢复不了」。
	const reloaded = new SessionCatalog(h.catalogPath);
	await reloaded.load();
	assert.equal(reloaded.getArchivedRemoteSession(sessionId)?.archivedRemotePath, ARCHIVED_PATH);
});

test("unarchiving a remote session moves the file back and restores the local record", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	await h.archive(sessionId);
	const commandsAfterArchive = h.remote.commands.length;

	assert.equal(await h.unarchiveRemote(sessionId), true);

	// 恢复只发一条 move（归档目录已经存在；目标不存在 ⇒ 不覆盖同名活会话）。
	assert.equal(h.remote.commands.length, commandsAfterArchive + 1);
	assert.equal(h.remote.commands[commandsAfterArchive], `[ ! -e '${ORIGINAL_PATH}' ] && mv -- '${ARCHIVED_PATH}' '${ORIGINAL_PATH}'`);
	assert.equal(h.remote.has(ORIGINAL_PATH), true);
	assert.equal(h.remote.has(ARCHIVED_PATH), false);
	assert.equal(h.remote.files.get(ORIGINAL_PATH), "remote-bytes");
	// 本机侧：索引摘掉 + 记录按归档时的身份登记回来（仍是 ssh locator，不写本机路径）。
	// 记录会得到**新的** catalog id（旧记录在归档时已移出；本地恢复也是靠后续扫描重建记录），
	// 所以按远端稳定身份找回它，而不是假设 id 不变。
	assert.equal(h.catalog.getArchivedRemoteSession(sessionId), undefined);
	const restored = h.catalog.listEntries().map((entry) => h.catalog.get(entry.id));
	const record = restored.find((candidate) => candidate.locator?.kind === "ssh" && candidate.locator.remoteSessionId === REMOTE_ID);
	assert.notEqual(record, undefined, "取消归档要恢复本机记录");
	assert.equal(record.locator.hostId, HOST);
	assert.equal(record.title, "远端会话");
	assert.equal(record.updatedAt, 1_700_000_000_000, "恢复不把旧会话抬成「刚更新」");
	assert.deepEqual(h.localPathLookups, []);
	assert.deepEqual(h.localCalls, []);

	// 幂等边界：索引已摘 ⇒ 再恢复一次给稳定码（而不是谎报成功）。
	assert.equal(await rejectionCode(() => h.unarchiveRemote(sessionId)), REMOTE_SESSION_ARCHIVE_CODES.entryNotFound);
	assert.match(REMOTE_SESSION_ARCHIVE_CODES.entryNotFound, STABLE_CODE);
});

test("a running remote session is refused with zero remote commands (fail-closed, stop the Agent first)", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	h.bindRuntime(sessionId);

	// 拒绝文案是**可执行**的那一句（mainCopy 键在测试里原样回显），不是裸码。
	const message = await rejectionCode(() => h.archive(sessionId));
	assert.equal(message, "session.remoteArchiveStopFirst");

	// 先判后发：一个远端命令、一次会话借用都没有。
	assert.deepEqual(h.remote.commands, []);
	// 本机状态原样不动：记录还在、索引里没有它、文件还在原位。
	assert.notEqual(h.catalog.get(sessionId), undefined);
	assert.equal(h.catalog.getArchivedRemoteSession(sessionId), undefined);
	assert.equal(h.remote.has(ORIGINAL_PATH), true);
});

test("an unconfigured remote archive port fails closed instead of falling back to the local path branch", async (t) => {
	const h = await setup(t, { withoutRemoteArchive: true });
	const sessionId = await h.createRemote();

	assert.equal(await rejectionCode(() => h.archive(sessionId)), REMOTE_SESSION_ARCHIVE_CODES.unavailable);
	// 稳定码 + 「不落回本机路径分支」：本机路径入口一次都没被调，本机文件操作一次都没有。
	assert.match(REMOTE_SESSION_ARCHIVE_CODES.unavailable, STABLE_CODE);
	assert.deepEqual(h.localPathLookups, []);
	assert.deepEqual(h.localCalls, []);
	assert.deepEqual(h.remote.commands, []);
	assert.notEqual(h.catalog.get(sessionId), undefined);
});

test("invalid remote paths are refused before any command is sent (relative identity without a root, single quotes)", async (t) => {
	// 相对身份 + 没有会话根解析端口 = fail-closed（绝不猜 <home>/.pi/agent/sessions）。
	const withoutRoot = createRemoteSessionArchive({ transport: { runRemoteCommand: async () => ({ exitCode: 0, stdout: "" }) } });
	assert.equal(await rejectionCode(() => withoutRoot.moveIntoArchive({ hostId: HOST, locator: { kind: "ssh", hostId: HOST, remoteSessionId: REMOTE_ID, remotePath: REMOTE_ID } })), REMOTE_SESSION_ARCHIVE_CODES.pathUnresolved);

	// 含单引号的路径：绝不进命令行（拒绝而不是实现一套转义）。
	const remote = fakeRemoteFiles(new Map());
	const archive = createRemoteSessionArchive({ transport: remote.transport, resolveSessionRoot: remote.resolveSessionRoot });
	assert.equal(await rejectionCode(() => archive.moveIntoArchive({ hostId: HOST, locator: { kind: "ssh", hostId: HOST, remoteSessionId: REMOTE_ID, remotePath: `${SESSION_ROOT}/ws/it's.jsonl` } })), REMOTE_SESSION_ARCHIVE_CODES.pathInvalid);
	assert.deepEqual(remote.commands, [], "路径非法时一个远端命令都不发");

	// 纯函数判据（本模块唯一的路径入口，与读取侧同源）。
	const codeOf = (run) => {
		try {
			run();
		} catch (error) {
			return typeof error?.message === "string" ? error.message : String(error);
		}
		throw new Error("EXPECTED_THROW");
	};
	assert.equal(
		codeOf(() => remoteSessionArchiveTarget("ws/target.jsonl")),
		REMOTE_SESSION_ARCHIVE_CODES.pathInvalid,
	);
	assert.equal(
		codeOf(() => buildRemoteSessionArchiveDirCommand(`${SESSION_ROOT}/ws/it's`)),
		REMOTE_SESSION_ARCHIVE_CODES.pathInvalid,
	);
	assert.equal(
		codeOf(() => buildRemoteSessionArchiveMoveCommand({ from: `${SESSION_ROOT}/a.jsonl`, to: `${SESSION_ROOT}/b'c.jsonl` })),
		REMOTE_SESSION_ARCHIVE_CODES.pathInvalid,
	);
	assert.equal(buildRemoteSessionArchiveMoveCommand({ from: `${SESSION_ROOT}/a.jsonl`, to: `${SESSION_ROOT}/b.jsonl` }), `[ ! -e '${SESSION_ROOT}/b.jsonl' ] && mv -- '${SESSION_ROOT}/a.jsonl' '${SESSION_ROOT}/b.jsonl'`);

	const h = await setup(t);
	const sessionId = await h.createRemote();
	assert.equal(h.remote.has(ORIGINAL_PATH), true);
	assert.equal(sessionId.length > 0, true);
});

test("a failing remote command returns a stable code and never lies about success (no clobber, no index entry)", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	// 归档区里已经有一条**同名**归档：`[ ! -e ]` 让命令以非 0 退出，绝不允许静默覆盖它。
	h.remote.files.set(ARCHIVED_PATH, "existing-archive-bytes");
	h.remote.dirs.add(ARCHIVE_DIR);

	assert.equal(await rejectionCode(() => h.archive(sessionId)), REMOTE_SESSION_ARCHIVE_CODES.commandFailed);

	// 不覆盖：已有归档原样；源文件仍在原位（这次归档什么都没发生）。
	assert.equal(h.remote.files.get(ARCHIVED_PATH), "existing-archive-bytes");
	assert.equal(h.remote.has(ORIGINAL_PATH), true);
	// 不谎报成功：记录仍在 catalog，索引里没有它（可辨识的状态 = 本机状态原样不动）。
	assert.notEqual(h.catalog.get(sessionId), undefined);
	assert.equal(h.catalog.getArchivedRemoteSession(sessionId), undefined);
	// 不自动重试：只发了这两条命令（建目录 + move）。
	assert.deepEqual(h.remote.commands, [`mkdir -p -- '${ARCHIVE_DIR}'`, `[ ! -e '${ARCHIVED_PATH}' ] && mv -- '${ORIGINAL_PATH}' '${ARCHIVED_PATH}'`]);
});

test("local archive and unarchive keep their existing behaviour (regression guard)", async (t) => {
	const h = await setup(t);
	const localSessionId = await h.createLocal();

	// 本机归档：走本机 scanner（远端端口一次都不参与），随后移出 catalog。
	await assert.rejects(() => h.archive(localSessionId), /LOCAL_FILE_OPERATION_FOR_REMOTE:archive/);
	assert.deepEqual(h.remote.commands, [], "本机归档不得发出任何远端命令");
	assert.equal(h.catalog.getArchivedRemoteSession(localSessionId), undefined);
	assert.notEqual(h.catalog.get(localSessionId), undefined, "本机归档失败 ⇒ 记录不动");

	// 本机取消归档：仍按**本机归档路径**调用 scanner.unarchive（契约逐字不变）。
	assert.equal(await h.unarchive(h.localArchivedPath), true);
	assert.deepEqual(
		h.localCalls.filter((call) => call.startsWith("unarchive:")),
		[`unarchive:${h.localArchivedPath}`],
	);
	assert.deepEqual(h.remote.commands, [], "本机恢复不得发出任何远端命令");
});
