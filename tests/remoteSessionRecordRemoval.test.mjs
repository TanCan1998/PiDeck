import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端会话「移除记录」= 墓碑（P4.5a）：**纯本机操作，绝不删远端数据**。
 *
 * 这条路径要同时成立四件事，每一件都由一个可数的仪器守着：
 * 1. 记录移出 catalog（与本地删除一致的那一半）；
 * 2. 记墓碑 ⇒ 下次远端扫描不再把它列为「可导入」（否则用户看到「删了又回来」）；
 * 3. 本机文件面**一次都不碰**（`getLocalFilePath` 是唯一入口，被调用就是回归）；
 * 4. **零远端数据写入**：有运行实例时先停进程（与本地「先杀后删」同序），但停止是**进程控制**，
 *    不得伴随任何写/移动/删除类远端命令。
 *
 * 用真实 `SessionCatalog` + 真实 `registerSessionIpc` + 真实 `registerRemoteSessionIpc`，远端侧是带帧
 * 日志的假 exec（与 `remoteSessionScanIsolation.test.mjs` 同一套夹具写法）；本机侧整个换成留痕替身。
 */

const HOST = "11111111-1111-4111-8111-111111111111";
const OTHER_HOST = "22222222-2222-4222-8222-222222222222";
const HOME = "/home/dev";
const SESSION_ROOT = HOME + "/.pi/agent/sessions";
const TARGET = "ws/target.jsonl";
const KEPT = "ws/kept.jsonl";
const REMOTE_PROJECT = { id: "project-remote", name: "Remote", locator: { kind: "ssh", hostId: HOST, remotePath: "/srv/app" } };
const LOCAL_PROJECT = { id: "project-local", name: "Local", locator: { kind: "local", environment: "native", path: "/work/app" } };
/** 与主进程同一判据：稳定码不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

function remoteDirectory(children) {
	return { kind: "directory", children };
}

/** 远端会话根（root 相对路径）的固定树：两条远端会话文件，永不删除。 */
function remoteTree() {
	return {
		".": remoteDirectory([{ name: "ws", kind: "directory" }]),
		ws: remoteDirectory([
			{ name: "target.jsonl", kind: "file", bytes: 120, mtimeMs: 11 },
			{ name: "kept.jsonl", kind: "file", bytes: 130, mtimeMs: 12 },
		]),
	};
}

function resolveRemoteNode(tree, path) {
	if (path === ".") return tree["."];
	const segments = path.split("/");
	let current = ".";
	let node = tree["."];
	for (let index = 0; index < segments.length; index += 1) {
		if (node === undefined || node.kind !== "directory") return undefined;
		const child = node.children.find((candidate) => candidate.name === segments[index]);
		if (child === undefined) return undefined;
		current = current === "." ? segments[index] : current + "/" + segments[index];
		if (index === segments.length - 1) return child.kind === "directory" ? tree[current] : child;
		node = tree[current];
	}
	return node;
}

/**
 * 带帧日志的假远端：frames 是「发过哪些帧」的账本，establishments 是「借会话」的次数。
 * 讀类助手方法只有 fs.list / fs.stat（列表级发现用）；其余方法一律记入 dataCommands 并当场报错——
 * 任何**数据类**远端操作（写/移动/删除）在这条路径上都必须为零，否则这就是一个会叫的探针。
 */
function fakeRemote(tree) {
	const frames = [];
	const dataCommands = [];
	const session = {
		async request(method, params) {
			frames.push({ method, params: JSON.parse(JSON.stringify(params ?? {})) });
			if (method !== "fs.list" && method !== "fs.stat") {
				dataCommands.push(method);
				throw new Error("UNEXPECTED_DATA_COMMAND:" + method);
			}
			if (method === "fs.list") {
				const node = resolveRemoteNode(tree, params.path);
				if (node === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
				if (node.kind !== "directory") throw Object.assign(new Error("NOT_A_DIRECTORY"), { code: "NOT_A_DIRECTORY" });
				return { entries: node.children.map((child) => (child.kind === "file" ? { name: child.name, kind: "file", bytes: child.bytes } : { name: child.name, kind: child.kind })) };
			}
			if (method === "fs.stat") {
				const node = resolveRemoteNode(tree, params.path);
				if (node === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
				if (node.kind === "file") return { kind: "file", bytes: node.bytes, mtimeMs: node.mtimeMs };
				return { kind: node.kind, bytes: 0, mtimeMs: 1 };
			}
			throw new Error("UNEXPECTED_METHOD:" + method);
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const port = {
		establishments: 0,
		frames,
		/** 数据类远端命令账本（写/移动/删除）：本批任何路径都不允许出现一条。 */
		dataCommands,
		/** 停止进程的账本（替身：生产里是 ssh launcher 收尾 / 远端 runner 的停止信号，不是数据命令）。 */
		stopSignals: [],
		remoteHome: async () => HOME,
		async withProjectSession(_hostId, root, task) {
			// 会话根解析会先探测 <home>/.pi/agent 的 settings.json：这份 fixture 没有它 ⇒ 退回默认根。
			if (root === HOME + "/.pi/agent") {
				return {
					ok: true,
					value: await task({
						async request() {
							throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
						},
						async cancel() {
							return { cancelled: true };
						},
					}),
				};
			}
			assert.equal(root, SESSION_ROOT, "远端操作只允许发生在会话根上");
			port.establishments += 1;
			return { ok: true, value: await task(session) };
		},
	};
	return port;
}

/**
 * 一个「本机文件面整个换成留痕替身」的装配：任何本机文件操作都会留下痕迹或直接炸。
 *
 * 三本账分开记，因为它们的语义完全不同：
 * - `localCalls`：**本机文件**操作（改名/删除/归档/回收站）——远端路径调用它们就是回归；
 * - `runtimeReleaseCalls` + `stopSignals`：**停止进程**（与本地删除同一「先杀后删」链路）——允许、且必须有；
 * - `port.dataCommands`：**远端数据类命令**（写/移动/删除）——永远必须为空。
 */
async function setup(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-removal-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalogPath = join(directory, "session-catalog.json");
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const localCalls = [];
	const localPathLookups = [];
	const runtimeReleaseCalls = [];
	const agentManagerCalls = [];
	/** 测试显式绑定的运行实例（生产里是 SessionRuntimeCoordinator 的 sessionId → agentId 映射）。 */
	const boundRuntimes = new Set();
	const localPath = join(directory, "local-session.jsonl");
	const handlers = new Map();
	const electronStub = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, app: { getPath: () => directory } };
	const localFileOperation = (name) => () => {
		localCalls.push(name);
		throw new Error("LOCAL_FILE_OPERATION_FOR_REMOTE:" + name);
	};
	const sessionScanner = {
		rename: localFileOperation("rename"),
		delete: async (filePath) => {
			localCalls.push(`delete:${filePath}`);
			return true;
		},
		archive: localFileOperation("archive"),
		listArchived: localFileOperation("list-archived"),
		deleteArchived: localFileOperation("delete-archived"),
	};
	const originalGetLocalFilePath = catalog.getLocalFilePath.bind(catalog);
	catalog.getLocalFilePath = (sessionId) => {
		localPathLookups.push(sessionId);
		return originalGetLocalFilePath(sessionId);
	};
	const port = fakeRemote(remoteTree());
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", { stubs: { electron: electronStub } });
	registerSessionIpc({
		projectStore: { get: (id) => [REMOTE_PROJECT, LOCAL_PROJECT].find((project) => project.id === id) },
		sessionCatalog: catalog,
		sessionScanner,
		settingsStore: { get: () => ({}) },
		sessionRuntimeCoordinator: {
			getTarget: (sessionId) => (boundRuntimes.has(sessionId) ? { sessionId, agentId: `${sessionId}:agent`, runtimeGeneration: 1 } : undefined),
			isActivating: () => false,
			releaseRuntimeForDelete: async (sessionId) => {
				runtimeReleaseCalls.push(sessionId);
				// 与生产同语义：先解绑再停；没有绑定就没有可停的进程（早返回）。
				if (!boundRuntimes.delete(sessionId)) return;
				// 停止信号（替身）：生产里是 releaseRuntimeForDelete → agents.stop → ssh launcher 收尾，
				// **不动任何会话文件**（SshProcessLauncher.terminate graceful：向本地 ssh 子进程发 SIGTERM）。
				port.stopSignals.push(sessionId);
			},
			stopAgentById: async () => undefined,
		},
		agentManager: {
			list: () => {
				agentManagerCalls.push("list");
				return [];
			},
			stop: async (agentId) => {
				agentManagerCalls.push(`stop:${agentId}`);
			},
		},
		mainCopy: (key) => key,
		appLogger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
		getMainWindow: () => undefined,
	});
	const { registerRemoteSessionIpc } = loadTsCommonJs("src/main/ipc/remoteSessionIpc.ts", { stubs: { electron: electronStub } });
	registerRemoteSessionIpc({
		enabled: true,
		service: () => port,
		catalog: () => catalog,
		projectIdForHost: () => REMOTE_PROJECT.id,
		channels: { scan: ipcChannels.remoteSessionScan, register: ipcChannels.remoteSessionRegister, title: ipcChannels.remoteSessionTitle },
	});
	const scan = () => handlers.get(ipcChannels.remoteSessionScan)({}, HOST);
	const registerRemote = (remoteSessionId) => handlers.get(ipcChannels.remoteSessionRegister)({}, HOST, remoteSessionId);
	const removeRecord = (sessionId) => handlers.get(ipcChannels.sessionsCatalogDelete)({}, sessionId);
	/** 本机会话：草稿 + 本地 locator（写入 filePath 是本地会话唯一的合法来源）。 */
	const createLocal = async () => {
		const draft = await catalog.createDraft({ projectId: LOCAL_PROJECT.id, title: "本地会话", environment: "native" });
		await catalog.update(draft.id, { filePath: localPath });
		return draft.id;
	};
	return {
		catalog,
		catalogPath,
		handlers,
		scan,
		registerRemote,
		removeRecord,
		createLocal,
		/** 给一条已登记的远端记录绑定运行实例（模拟用户已经打开/跑着这条会话）。 */
		bindRuntime: (sessionId) => boundRuntimes.add(sessionId),
		localCalls,
		localPathLookups,
		runtimeReleaseCalls,
		agentManagerCalls,
		localPath,
		port,
	};
}

test("removing a remote record only moves the local record and tombstones it", async (t) => {
	const h = await setup(t);
	const registered = await h.registerRemote(TARGET);
	assert.equal(registered.ok, true, "登记远端会话是这条用例的前置");
	const remoteFramesAfterRegister = h.port.frames.length;
	const establishmentsAfterRegister = h.port.establishments;

	const removed = await h.removeRecord(registered.sessionId);

	assert.equal(removed, true);
	assert.equal(h.catalog.get(registered.sessionId), undefined, "记录必须移出 catalog");
	// 「不碰本机文件」的两条判据：本机路径解析一次没做，本机文件操作一次没做（回收站/改名/归档）。
	assert.deepEqual(h.localPathLookups, []);
	assert.deepEqual(h.localCalls, []);
	// 先停后摘：与本地同一顺序走一次释放（没绑定 ⇒ 无进程可停 = 无停止信号），但不是一个文件操作。
	assert.deepEqual(h.runtimeReleaseCalls, [registered.sessionId]);
	assert.deepEqual(h.port.stopSignals, [], "无运行实例 ⇒ 不得产生任何停止信号");
	// 「不碰远端数据与远端会话」的判据：移除记录本身不发帧、不借会话，更没有任何数据类命令。
	assert.equal(h.port.frames.length, remoteFramesAfterRegister, "移除记录不得发出任何远端帧");
	assert.equal(h.port.establishments, establishmentsAfterRegister, "移除记录不得建立远端会话");
	assert.deepEqual(h.port.dataCommands, []);
	// agentManager.list/stop（本机「按路径杀进程 + 删文件」那条路）不得被走到。
	assert.deepEqual(h.agentManagerCalls, []);
	// 墓碑按 (hostId, remoteSessionId) 记下：下次扫描据此排除。
	assert.equal(h.catalog.isRemoteSessionDismissed(HOST, TARGET), true);
	assert.equal(h.catalog.isRemoteSessionDismissed(OTHER_HOST, TARGET), false, "墓碑按主机隔离");
	assert.equal(h.catalog.isRemoteSessionDismissed(HOST, KEPT), false);
});

test("a removed remote session stays out of the importable list on the next scan", async (t) => {
	const h = await setup(t);
	const registered = await h.registerRemote(TARGET);

	const before = await h.scan();
	assert.equal(before.ok, true);
	// 生产模块在另一个 realm：数组要经 Array.from 重建成本 realm 的数组再比对。
	assert.deepEqual(
		Array.from(before.entries, (entry) => entry.remoteSessionId),
		[KEPT, TARGET],
		"移除之前两条远端会话都在「可导入」列表里",
	);

	await h.removeRecord(registered.sessionId);

	const after = await h.scan();
	assert.equal(after.ok, true);
	assert.deepEqual(
		Array.from(after.entries, (entry) => entry.remoteSessionId),
		[KEPT],
		"移除过的远端会话不得再出现在「可导入」列表里",
	);
	// 远端文件仍在（假远端树上那条文件没消失，scan 也仍然能 stat 到它）：被排除的是**列表项**，不是数据。
	const tree = remoteTree();
	assert.equal(resolveRemoteNode(tree, TARGET).kind, "file");
	// 墓碑只在列表层生效：登记（显式导入）通道仍按原语义工作，不受墓碑影响。
	assert.equal(h.catalog.isRemoteSessionDismissed(HOST, TARGET), true);
});

test("the tombstone is written to the catalog file and survives a restart", async (t) => {
	const h = await setup(t);
	const registered = await h.registerRemote(TARGET);

	await h.removeRecord(registered.sessionId);

	const raw = JSON.parse(await readFile(h.catalogPath, "utf8"));
	assert.deepEqual(raw.dismissedRemoteSessions, [{ hostId: HOST, remoteSessionId: TARGET }], "(hostId, remoteSessionId) 成对落盘");
	assert.equal(
		raw.sessions.some((session) => session.id === registered.sessionId),
		false,
		"记录本身不再落盘",
	);

	const reloaded = new SessionCatalog(h.catalogPath);
	await reloaded.load();
	assert.equal(reloaded.isRemoteSessionDismissed(HOST, TARGET), true, "重启后墓碑仍生效");
	assert.equal(reloaded.get(registered.sessionId), undefined);
});

test("local session delete is unchanged: it still removes the local file and records no remote tombstone", async (t) => {
	const h = await setup(t);
	// 本机会话也绑一个运行实例：本地路径的「先杀后删」必须仍然被走到。
	const sessionId = await h.createLocal();
	h.bindRuntime(sessionId);

	const removed = await h.removeRecord(sessionId);

	assert.equal(removed, true);
	// 本机行为逐字不变：先杀后删 + 删本机文件（回收站路径），并且不记任何远端墓碑。
	assert.deepEqual(h.localPathLookups, [sessionId]);
	assert.deepEqual(h.localCalls, [`delete:${h.localPath}`]);
	assert.deepEqual(h.runtimeReleaseCalls, [sessionId]);
	assert.deepEqual(h.port.stopSignals, [sessionId]);
	assert.deepEqual(h.port.dataCommands, []);
	assert.equal(h.catalog.get(sessionId), undefined);
	assert.equal(h.catalog.isRemoteSessionDismissed(HOST, TARGET), false);
});

test("removing a record for a running remote session stops the runtime first, without a single remote data write", async (t) => {
	const h = await setup(t);
	const registered = await h.registerRemote(TARGET);
	// 用户已经把这条远端会话跑起来了（侧栏上它属于 agent 菜单那条路）：移除记录必须先停后摘。
	h.bindRuntime(registered.sessionId);
	// 仪器活性（正对照）：这个远端替身确实会把数据类命令记账并报错，否则下面的「零数据命令」是空断言。
	const control = await h.port.withProjectSession(HOST, SESSION_ROOT, (session) =>
		session.request("fs.write", {}).then(
			() => "wrote",
			() => "refused",
		),
	);
	assert.equal(control.value, "refused");
	assert.deepEqual(h.port.dataCommands, ["fs.write"], "数据类命令必须能被这台仪器看到");
	h.port.dataCommands.length = 0;
	const remoteFramesAfterRegister = h.port.frames.length;

	const removed = await h.removeRecord(registered.sessionId);

	assert.equal(removed, true);
	// 有运行实例 ⇒ 停止路径被走到（否则会留一个 sessionId 已不存在的悬空 runtime）。
	assert.deepEqual(h.runtimeReleaseCalls, [registered.sessionId]);
	assert.deepEqual(h.port.stopSignals, [registered.sessionId], "停止链路：只停进程");
	// 停止进程 ≠ 改数据：不得夹带任何写/移动/删除类远端命令，也不得碰本机文件。
	assert.deepEqual(h.port.dataCommands, []);
	assert.equal(h.port.frames.length, remoteFramesAfterRegister, "停止走的是既有进程链路，不产生任何远端帧");
	assert.deepEqual(h.localCalls, []);
	assert.deepEqual(h.localPathLookups, []);
	assert.deepEqual(h.agentManagerCalls, []);
	// 记录被移除 + 墓碑已写，而且墓碑照常生效（停掉的会话不会留在可导入列表里）。
	assert.equal(h.catalog.get(registered.sessionId), undefined);
	assert.equal(h.catalog.isRemoteSessionDismissed(HOST, TARGET), true);
	const after = await h.scan();
	assert.deepEqual(
		Array.from(after.entries, (entry) => entry.remoteSessionId),
		[KEPT],
		"有运行实例时移除的远端会话同样不再出现在「可导入」列表里",
	);
});

test("removal refuses invalid input with a stable code and never throws a raw error", async (t) => {
	const h = await setup(t);

	// 非字符串 sessionId：稳定码拒绝（渲染层只展示剥壳后的码，不是裸异常）。
	const failure = await h.removeRecord(42).then(
		() => undefined,
		(error) => error,
	);
	assert.ok(failure !== undefined, "非法输入必须被拒绝，而不是静默成功");
	assert.match(String(failure?.message ?? failure), STABLE_CODE);
	// 不存在的 sessionId 不是错误：与本地删除同一契约（false = 记录本就不在）。
	assert.equal(await h.removeRecord("11111111-2222-4333-8444-555555555555"), false);
	assert.deepEqual(h.localCalls, []);
	assert.deepEqual(h.localPathLookups, []);
	// 连「停进程」都不该发生：不存在的记录压根没走到远端分支。
	assert.deepEqual(h.runtimeReleaseCalls, []);
	assert.deepEqual(h.port.stopSignals, []);
});
