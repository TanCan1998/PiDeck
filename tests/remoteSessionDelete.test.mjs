import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端会话数据永久删除（Phase 5）。
 *
 * 上半部分是**可执行证据**：固定 Node 脚本在真实临时目录上跑（POSIX），证明 canonical containment
 * 与「只 unlink 一个普通文件」不是注释承诺；下半部分是真实 SessionCatalog + 真实 registerSessionIpc +
 * 按语义执行的假 SSH exec：请求/一次性确认/回执丢失/拒绝矩阵/墓碑清理都从 IPC 边界断言。
 */

const POSIX = process.platform !== "win32";
const HOST = "11111111-1111-4111-8111-111111111111";
const HOME = "/home/dev";
const SESSION_ROOT = HOME + "/.pi/agent/sessions";
const REMOTE_ID = "ws/target.jsonl";
const ORIGINAL_PATH = SESSION_ROOT + "/" + REMOTE_ID;
const ARCHIVE_DIR = SESSION_ROOT + "/ws/.pideck-archive";
const ARCHIVED_PATH = ARCHIVE_DIR + "/target.jsonl";
const NODE_PATH = "/opt/pideck/node/bin/node";
const LOCAL_PROJECT = { id: "project-local", name: "Local" };
const REMOTE_PROJECT = { id: "project-remote", name: "Remote" };

const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const deleteModule = loadTsCommonJs("src/main/remote/RemoteSessionDelete.ts");
const { createRemoteSessionArchive } = loadTsCommonJs("src/main/remote/RemoteSessionArchive.ts");
const { createRemoteArchivedSessionDelete } = loadTsCommonJs("src/main/sessions/RemoteArchivedSessionDelete.ts");
const { REMOTE_SESSION_DELETE_CODES } = loadTsCommonJs("src/shared/sessionDeleteCodes.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

/** 只切单引号字面量；生产命令里的路径/Node/marker 已在构造期拒掉单引号。 */
function tokenize(command) {
	const tokens = [];
	let index = 0;
	while (index < command.length) {
		if (command[index] === " ") {
			index += 1;
			continue;
		}
		if (command[index] !== "'") throw new Error("UNQUOTED_TOKEN: " + command.slice(index, index + 40));
		const end = command.indexOf("'", index + 1);
		if (end < 0) throw new Error("UNTERMINATED_QUOTE");
		tokens.push(command.slice(index + 1, end));
		index = end + 1;
	}
	return tokens;
}

function fakeRemoteFiles(initialFiles) {
	const files = new Map(initialFiles);
	const dirs = new Set();
	for (const path of files.keys()) {
		const segments = path.split("/");
		for (let index = 1; index < segments.length; index += 1) dirs.add(segments.slice(0, index).join("/"));
	}
	dirs.add(ARCHIVE_DIR);
	const commands = [];
	const options = { dropReceipt: false, failCode: undefined, exitCode: 0 };
	const transport = {
		async runRemoteCommand({ remoteCommand }) {
			commands.push(remoteCommand);
			if (remoteCommand.startsWith("mkdir -p -- ")) {
				const match = /^mkdir -p -- '([^']+)'$/.exec(remoteCommand);
				if (!match) throw new Error("UNEXPECTED_MKDIR: " + remoteCommand);
				dirs.add(match[1]);
				return { exitCode: 0, stdout: "" };
			}
			if (remoteCommand.startsWith("[ ! -e ")) {
				const match = /^\[ ! -e '([^']+)' \] && mv -- '([^']+)' '([^']+)'$/.exec(remoteCommand);
				if (!match) throw new Error("UNEXPECTED_MOVE: " + remoteCommand);
				const [, target, source] = match;
				if (files.has(target) || dirs.has(target) || !files.has(source)) return { exitCode: 1, stdout: "" };
				files.set(target, files.get(source));
				files.delete(source);
				return { exitCode: 0, stdout: "" };
			}
			const tokens = tokenize(remoteCommand);
			assert.equal(tokens[0], NODE_PATH);
			assert.equal(tokens[1], "-e");
			assert.equal(tokens[3], "delete");
			const marker = tokens[4];
			const target = tokens[5];
			if (options.exitCode !== 0) return { exitCode: options.exitCode, stdout: "" };
			if (!files.has(target)) return { exitCode: 0, stdout: marker + JSON.stringify({ ok: false, code: "fileMissing" }) };
			if (options.failCode !== undefined) return { exitCode: 0, stdout: marker + JSON.stringify({ ok: false, code: options.failCode }) };
			files.delete(target);
			if (options.dropReceipt) return { exitCode: 0, stdout: "" };
			return { exitCode: 0, stdout: marker + JSON.stringify({ ok: true }) };
		},
	};
	return {
		files,
		dirs,
		commands,
		transport,
		options,
		deleteCommands: () => commands.filter((command) => command.includes("'delete'")),
		has: (path) => files.has(path),
	};
}

function createSender(id = 1) {
	const listeners = new Map();
	return {
		id,
		isDestroyed: () => false,
		send: () => undefined,
		once(event, listener) {
			listeners.set(event, listener);
		},
		emit(event) {
			const listener = listeners.get(event);
			if (listener) listener();
		},
	};
}

/**
 * 真实 SessionCatalog + 真实 sessionIpc（远端归档/删除端口都是生产模块）+ 假 SSH exec。
 * 本机文件面全部换成留痕替身：远端 id 一旦落进本机路径分支就会立刻失败。
 */
async function setup(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-delete-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalogPath = join(directory, "session-catalog.json");
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const remote = fakeRemoteFiles(new Map([[ORIGINAL_PATH, "remote-bytes"]]));
	const localCalls = [];
	const boundRuntimes = new Set();
	const localArchivedPath = join(directory, "archived-local.jsonl");
	const handlers = new Map();
	const electronStub = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, app: { getPath: () => directory } };
	const localFileOperation = (name) => (arg) => {
		localCalls.push(name + ":" + String(arg));
		throw new Error("LOCAL_FILE_OPERATION_FOR_REMOTE:" + name);
	};
	const sessionScanner = {
		archive: localFileOperation("archive"),
		unarchive: async (archivedPath) => {
			localCalls.push("unarchive:" + archivedPath);
			return join(directory, "restored-local.jsonl");
		},
		listArchived: async () => [],
		deleteArchived: async (archivedPath) => {
			localCalls.push("delete-archived:" + archivedPath);
		},
	};
	const archive = createRemoteSessionArchive({ transport: remote.transport, resolveSessionRoot: async () => ({ ok: true, root: SESSION_ROOT }) });
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", { stubs: { electron: electronStub } });
	registerSessionIpc({
		projectStore: { get: (id) => [LOCAL_PROJECT, REMOTE_PROJECT].find((project) => project.id === id) },
		sessionCatalog: catalog,
		sessionScanner,
		settingsStore: { get: () => ({}) },
		sessionRuntimeCoordinator: {
			getTarget: (sessionId) => (boundRuntimes.has(sessionId) ? { sessionId, agentId: sessionId + ":agent", runtimeGeneration: 1 } : undefined),
			isActivating: () => false,
		},
		agentManager: { list: () => [], stop: async () => undefined },
		mainCopy: (key) => key,
		appLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
		getMainWindow: () => undefined,
		archiveRemoteSession: (input) => archive.moveIntoArchive(input),
		unarchiveRemoteSession: async (input) => {
			await archive.moveBack(input);
		},
		deleteArchivedRemoteSession: (input) => deleteModule.createRemoteSessionDelete({ transport: remote.transport, resolveNodePath: async () => NODE_PATH }).deleteArchived(input),
	});
	const createRemote = async () => {
		const registration = await catalog.ensureRemoteSession({ projectId: REMOTE_PROJECT.id, hostId: HOST, remoteSessionId: REMOTE_ID, remotePath: REMOTE_ID, title: "远端会话", updatedAt: 1_700_000_000_000 });
		return registration.record.id;
	};
	const createLocal = async () => {
		const draft = await catalog.createDraft({ projectId: LOCAL_PROJECT.id, title: "本机会话", environment: "native" });
		await catalog.update(draft.id, { filePath: join(directory, "local.jsonl") });
		return draft.id;
	};
	const sender = createSender(1);
	return {
		catalog,
		remote,
		handlers,
		createRemote,
		createLocal,
		sender,
		bindRuntime: (sessionId) => boundRuntimes.add(sessionId),
		archive: (sessionId, s = sender) => handlers.get(ipcChannels.sessionsCatalogArchive)({ sender: s }, sessionId),
		request: (sessionId, s = sender) => handlers.get(ipcChannels.sessionsCatalogDeleteArchivedRemote)({ sender: s }, sessionId),
		answer: (requestId, choice = "approve", s = sender) => handlers.get(ipcChannels.sessionsCatalogAnswerDeleteArchivedRemote)({ sender: s }, requestId, choice),
		deliverArchivedDelete: (sessionId) => handlers.get(ipcChannels.sessionsCatalogDeleteArchived)({}, sessionId),
		listArchived: () => handlers.get(ipcChannels.sessionsCatalogListArchived)({}),
		localCalls,
		localArchivedPath,
	};
}

async function rejectionCode(run) {
	try {
		await run();
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

test("fixed delete script stays within its own budget and only takes one quoted archive path", () => {
	const squash = deleteModule.REMOTE_SESSION_DELETE_SCRIPT.replace(/\s+/g, " ").trim();
	assert.ok(squash.length <= deleteModule.REMOTE_SESSION_DELETE_SCRIPT_MAX_CHARS, "script squash budget: " + squash.length);
	for (const build of [
		() => deleteModule.buildRemoteSessionDeleteCommand({ nodePath: "relative/node", archivedPath: ARCHIVED_PATH, nonce: "a".repeat(32) }),
		() => deleteModule.buildRemoteSessionDeleteCommand({ nodePath: "/usr/bin/node", archivedPath: ARCHIVED_PATH.replace(".jsonl", ".txt"), nonce: "a".repeat(32) }),
		() => deleteModule.buildRemoteSessionDeleteCommand({ nodePath: "/usr/bin/node", archivedPath: "/home/dev/.pi/agent/sessions/ws/target.jsonl", nonce: "a".repeat(32) }),
		() => deleteModule.buildRemoteSessionDeleteCommand({ nodePath: "/usr/bin/node", archivedPath: ARCHIVED_PATH, nonce: "forged" }),
		() => deleteModule.buildRemoteSessionDeleteCommand({ nodePath: "/usr/bin/node", archivedPath: ARCHIVED_PATH.replace("target", "it's"), nonce: "a".repeat(32) }),
	])
		assert.throws(build, /REMOTE_SESSION_DELETE_(NODE_PATH_INVALID|PATH_INVALID|OPTIONS_INVALID)/);
	const { command, marker } = deleteModule.buildRemoteSessionDeleteCommand({ nodePath: NODE_PATH, archivedPath: ARCHIVED_PATH, nonce: "b".repeat(32) });
	assert.ok(command.length <= 8192, "command length: " + command.length);
	assert.ok(command.startsWith("'" + NODE_PATH + "' '-e' '"));
	assert.ok(command.endsWith("'delete' '" + marker + "' '" + ARCHIVED_PATH + "'"));
});

test("receipt parser distinguishes definite failure from unconfirmed result", () => {
	const marker = "PIDECK_MARKER_0123456789abcdef";
	const parse = (stdout) => deleteModule.parseRemoteSessionDeleteResult(stdout, marker);
	assert.equal(parse(marker + '{"ok":true}').kind, "ok");
	assert.equal(parse(marker + '{"ok":false,"code":"fileMissing"}').kind, "error");
	assert.equal(parse(marker + '{"ok":false,"code":"fileMissing"}').code, "fileMissing");
	assert.equal(parse(marker + '{"ok":false,"code":"pathInvalid"}').code, "pathInvalid");
	// 登录横幅等标记之前的噪声是允许的（marker 的意义就是跳过它）；只有标记之后的输出必须是一个 JSON。
	assert.equal(parse("banner noise " + marker + '{"ok":true}').kind, "ok");
	for (const stdout of ["", marker, marker + "{}", marker + '{"ok":false}', marker + '{"ok":false,"code":"FILE_MISSING"}', marker + '{"ok":true,"extra":1}', marker + '{"ok":true}' + marker + '{"ok":true}', marker + '"partial"']) assert.equal(parse(stdout).kind, "untrusted", JSON.stringify(stdout));
});

test("the fixed script really unlinks one validated archive file and refuses symlinks (POSIX)", { skip: !POSIX }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-delete-script-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const archiveDir = join(root, ".pideck-archive");
	await mkdir(archiveDir, { recursive: true });
	const target = join(archiveDir, "target.jsonl");
	const run = (path) => spawnSync(process.execPath, ["-e", deleteModule.REMOTE_SESSION_DELETE_SCRIPT, "delete", "MARKER_abc123", path], { encoding: "utf8" });
	await writeFile(target, "bytes");
	const ok = run(target);
	assert.equal(ok.status, 0);
	assert.equal(ok.stdout, 'MARKER_abc123{"ok":true}');
	await assert.rejects(() => lstat(target));
	const missing = run(target);
	assert.equal(missing.stdout, 'MARKER_abc123{"ok":false,"code":"fileMissing"}');
	// 叶子是符号链接：只做 lstat，绝不跟随；链接与它指向的文件都必须原样保留。
	await writeFile(join(root, "outside.jsonl"), "outside");
	await symlink(join(root, "outside.jsonl"), target);
	assert.equal(run(target).stdout, 'MARKER_abc123{"ok":false,"code":"pathInvalid"}');
	assert.equal((await lstat(join(root, "outside.jsonl"))).isFile(), true);
	await rm(target, { force: true });
	await rm(join(root, "outside.jsonl"), { force: true });
	// 父目录被符号链接替换：realpath(dir) !== dir ⇒ 拒绝（canonical containment）。
	const redirected = join(root, "redirected");
	await mkdir(redirected);
	await writeFile(join(redirected, "target.jsonl"), "bytes");
	await rm(archiveDir, { recursive: true, force: true });
	await symlink(redirected, archiveDir);
	assert.equal(run(join(archiveDir, "target.jsonl")).stdout, 'MARKER_abc123{"ok":false,"code":"pathInvalid"}');
	assert.equal((await lstat(join(redirected, "target.jsonl"))).isFile(), true);
});

test("archive → request → approve deletes only the archived file, clears the index and the tombstone", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	// 先有人把这条远端会话「移除记录」过：墓碑存在时删除成功必须一并清掉（否则以后同路径会话会被幽灵挡住）。
	await h.catalog.rememberDismissedRemoteSession({ hostId: HOST, remoteSessionId: REMOTE_ID });
	await h.archive(sessionId);
	assert.equal(h.remote.has(ARCHIVED_PATH), true);
	const commandsAfterArchive = h.remote.commands.length;

	const requested = await h.request(sessionId);
	assert.equal(requested.ok, true);
	assert.equal(requested.status, "pending");
	assert.equal(typeof requested.requestId, "string");
	// 请求阶段不执行任何远端删除：只有归档那两条命令。
	assert.equal(h.remote.commands.length, commandsAfterArchive);
	assert.equal(h.catalog.getArchivedRemoteSession(sessionId).archivedRemotePath, ARCHIVED_PATH);

	const answered = await h.answer(requested.requestId, "approve");
	assert.deepEqual({ ...answered }, { ok: true, deleted: true });
	assert.equal(h.remote.has(ARCHIVED_PATH), false, "远端归档文件必须真的消失");
	assert.equal(h.remote.deleteCommands().length, 1);
	assert.equal(h.catalog.getArchivedRemoteSession(sessionId), undefined);
	assert.equal(h.catalog.isRemoteSessionDismissed(HOST, REMOTE_ID), false);
	const rows = await h.listArchived();
	assert.equal(
		rows.some((row) => row.archivedRemoteSessionId === sessionId),
		false,
	);
	assert.deepEqual(h.localCalls, []);
});

test("deny and replay: no remote command on deny; a consumed confirmation cannot delete twice", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	await h.archive(sessionId);
	const deleteCommands = h.remote.deleteCommands().length;
	const requested = await h.request(sessionId);
	const denied = await h.answer(requested.requestId, "deny");
	assert.deepEqual({ ...denied }, { ok: true, deleted: false });
	assert.equal(h.remote.deleteCommands().length, deleteCommands);
	assert.notEqual(h.catalog.getArchivedRemoteSession(sessionId), undefined);

	const second = await h.request(sessionId);
	assert.equal((await h.answer(second.requestId, "approve")).deleted, true);
	const replay = await h.answer(second.requestId, "approve");
	assert.equal(replay.ok, false);
	assert.equal(replay.code, REMOTE_SESSION_DELETE_CODES.confirmationRequired);
	assert.equal(h.remote.deleteCommands().length, deleteCommands + 1, "重放绝不能再发一次删除命令");
});

test("running session, missing/stale index and local records are refused with zero remote commands", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	await h.archive(sessionId);
	h.bindRuntime(sessionId);
	const busy = await h.request(sessionId);
	assert.equal(busy.ok, false);
	assert.equal(busy.code, REMOTE_SESSION_DELETE_CODES.busy);
	assert.equal(h.remote.deleteCommands().length, 0);

	const localId = await h.createLocal();
	const notArchived = await h.request(localId);
	assert.equal(notArchived.code, REMOTE_SESSION_DELETE_CODES.notArchived);
	const missing = await h.request("no-such-session");
	assert.equal(missing.code, REMOTE_SESSION_DELETE_CODES.entryNotFound);
	assert.equal(h.remote.deleteCommands().length, 0);
	// 本机归档删除通道行为不变：仍走 sessionScanner，不碰远端。
	assert.equal(await h.deliverArchivedDelete(h.localArchivedPath), true);
	assert.deepEqual(h.localCalls, ["delete-archived:" + h.localArchivedPath]);
	assert.equal(h.remote.deleteCommands().length, 0);
});

test("the renderer can only send an id: object payloads are rejected before any remote command", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	await h.archive(sessionId);
	const code = await rejectionCode(() => h.request({ sessionId, hostId: HOST, archivedRemotePath: "/etc/passwd" }));
	assert.equal(code, "INVALID_SESSION_ID");
	assert.equal(h.remote.deleteCommands().length, 0);
});

test("sender ownership: another window cannot answer, and a destroyed window revokes its confirmation", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	await h.archive(sessionId);
	const requested = await h.request(sessionId);
	const other = createSender(2);
	const foreign = await h.answer(requested.requestId, "approve", other);
	assert.equal(foreign.ok, false);
	assert.equal(foreign.code, REMOTE_SESSION_DELETE_CODES.confirmationRequired);
	assert.equal(h.remote.deleteCommands().length, 0);

	h.sender.emit("destroyed");
	const afterDestroy = await h.answer(requested.requestId, "approve");
	assert.equal(afterDestroy.ok, false);
	assert.equal(afterDestroy.code, REMOTE_SESSION_DELETE_CODES.confirmationRequired);
	assert.equal(h.remote.deleteCommands().length, 0);
});

test("receipt loss is RESULT_UNCONFIRMED: the index is kept, the command is never retried", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	await h.archive(sessionId);
	h.remote.options.dropReceipt = true;
	const requested = await h.request(sessionId);
	const answered = await h.answer(requested.requestId, "approve");
	assert.equal(answered.ok, false);
	assert.equal(answered.code, REMOTE_SESSION_DELETE_CODES.resultUnconfirmed);
	// 远端可能已删（假 exec 确实删了），但本机索引必须保留：不自动刷新掉、不重试、不谎报成功。
	assert.equal(h.remote.has(ARCHIVED_PATH), false);
	assert.notEqual(h.catalog.getArchivedRemoteSession(sessionId), undefined);
	const deleteCommands = h.remote.deleteCommands().length;
	const replay = await h.answer(requested.requestId, "approve");
	assert.equal(replay.code, REMOTE_SESSION_DELETE_CODES.confirmationRequired);
	assert.equal(h.remote.deleteCommands().length, deleteCommands, "未确认结果不得自动重试");
});

test("definite script failures keep both the file and the index (no false success)", async (t) => {
	for (const scriptCode of ["commandFailed", "fileChanged"]) {
		const h = await setup(t);
		const sessionId = await h.createRemote();
		await h.archive(sessionId);
		h.remote.options.failCode = scriptCode;
		const requested = await h.request(sessionId);
		const answered = await h.answer(requested.requestId, "approve");
		assert.equal(answered.ok, false);
		assert.equal(answered.code, REMOTE_SESSION_DELETE_CODES[scriptCode]);
		assert.equal(h.remote.has(ARCHIVED_PATH), true, "确定失败必须保留远端文件");
		assert.notEqual(h.catalog.getArchivedRemoteSession(sessionId), undefined);
		assert.equal(h.remote.deleteCommands().length, 1);
	}
});

test("a tampered index path fails closed before any remote command", async (t) => {
	const h = await setup(t);
	const sessionId = await h.createRemote();
	await h.archive(sessionId);
	const original = h.catalog.getArchivedRemoteSession(sessionId);
	await h.catalog.rememberArchivedRemoteSession({ ...original, archivedRemotePath: SESSION_ROOT + "/ws/target.jsonl" });
	const requested = await h.request(sessionId);
	assert.equal(requested.ok, true);
	const answered = await h.answer(requested.requestId, "approve");
	assert.equal(answered.ok, false);
	assert.equal(answered.code, REMOTE_SESSION_DELETE_CODES.pathInvalid);
	assert.equal(h.remote.deleteCommands().length, 0);
	assert.notEqual(h.catalog.getArchivedRemoteSession(sessionId), undefined);
});
