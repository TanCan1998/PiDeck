import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const SCANNER_PATH = "src/main/sessions/RemoteSessionScanner.ts";
const SCANNER_SOURCE = readFileSync(SCANNER_PATH, "utf8");

const scannerModule = loadTsCommonJs(SCANNER_PATH);
const { createRemoteSessionScanner, REMOTE_SESSION_CODES, REMOTE_SESSION_ENTRY_OVERHEAD_BYTES, REMOTE_SESSION_LIMITS, REMOTE_SESSION_ROOT_SUFFIX, REMOTE_SESSION_SCANNER_OPTIONS_INVALID } = scannerModule;

/** 跨 VM realm 的比较前先归一化：deepStrictEqual 会比较原型，两个 realm 的字面量原型不同。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function dirEntry(name) {
	return { name, kind: "directory" };
}

function fileEntry(name, bytes = 10) {
	return { name, kind: "file", bytes };
}

/**
 * 远端替身：只认识 fs.list / fs.stat（扫描不需要 fs.read）。
 * listings[path] 是目录项数组，或 (params) => 数组（也可抛错）；files[path] 是 { bytes, mtimeMs, kind }。
 * 所有返回值都是**精确字段集**——多一个字段 reader 就会按协议违例拒绝，这正是要被测到的边界。
 */
function fakeRemote(options = {}) {
	const listings = options.listings ?? {};
	const files = options.files ?? {};
	const calls = { home: [], sessions: [], list: [], stat: [], read: [], probe: [] };
	let inFlight = 0;
	let maxInFlight = 0;
	const port = {
		async remoteHome(hostId) {
			calls.home.push(hostId);
			if (typeof options.home === "function") return options.home(hostId);
			// "home" in options 才表示要覆盖默认值：{ home: undefined } 就是「解析不出 home」。
			return Object.hasOwn(options, "home") ? options.home : "/home/dev";
		},
		async withProjectSession(hostId, root, task) {
			// J2：根解析会先用 root=<home>/.pi/agent 探测 settings.json。这份替身没有这个文件，所以探测
			// 固定「读不到」⇒ 退回默认根；探测帧单独记，既有「会话阶段」帧断言保持原意。
			const probing = root === "/home/dev/.pi/agent";
			(probing ? calls.probe : calls.sessions).push(probing ? root : { hostId, root });
			if (options.withProjectSession) return options.withProjectSession(hostId, root, task);
			const session = {
				async request(method, params) {
					if (probing) {
						calls.probe.push(method + ":" + params.path);
						throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
					}
					if (method === "fs.list") {
						calls.list.push(params.path);
						inFlight += 1;
						maxInFlight = Math.max(maxInFlight, inFlight);
						try {
							if (options.listDelayMs) await new Promise((resolve) => setTimeout(resolve, options.listDelayMs));
							const configured = listings[params.path];
							if (configured === undefined) throw new Error("PATH_NOT_FOUND");
							return { entries: typeof configured === "function" ? configured(params) : configured };
						} finally {
							inFlight -= 1;
						}
					}
					if (method === "fs.stat") {
						calls.stat.push(params.path);
						const file = files[params.path];
						if (file === undefined) throw new Error("PATH_NOT_FOUND");
						return { kind: file.kind ?? "file", bytes: file.bytes ?? 0, mtimeMs: file.mtimeMs ?? 0 };
					}
					if (method === "fs.read") {
						calls.read.push(params);
						const size = files[params.path]?.bytes ?? 0;
						const chunk = Buffer.alloc(Math.max(0, Math.min(params.bytes, size - params.offset)));
						return { chunk: chunk.toString("base64"), bytes: chunk.length, eof: params.offset + chunk.length >= size };
					}
					throw new Error("PROTOCOL_INVALID");
				},
				async cancel() {
					return { cancelled: false };
				},
			};
			return { ok: true, value: await task(session) };
		},
	};
	return { port, calls, maxInFlight: () => maxInFlight };
}

test("扫描上限与稳定码是冻结值，且模块不把远端路径交给本地 fs", () => {
	assert.deepEqual(plain(REMOTE_SESSION_LIMITS), { maxWorkspaceDirs: 512, maxFiles: 2000, maxTotalBytes: 1024 * 1024, concurrency: 4 });
	assert.equal(REMOTE_SESSION_ENTRY_OVERHEAD_BYTES, 32);
	assert.equal(REMOTE_SESSION_ROOT_SUFFIX, ".pi/agent/sessions");
	// 逐键断言而不是整对象 deepEqual：新增一个稳定码（例如 H1 的 titleFailed）不该让整组转红，
	// 但已冻结的值改了必须红——这才是「冻结值」要锁的东西。
	const frozenCodes = {
		hostIdInvalid: "REMOTE_SESSION_HOST_ID_INVALID",
		homeUnavailable: "REMOTE_SESSION_HOME_UNAVAILABLE",
		idInvalid: "REMOTE_SESSION_ID_INVALID",
		dirLimitExceeded: "REMOTE_SESSION_DIR_LIMIT_EXCEEDED",
		fileLimitExceeded: "REMOTE_SESSION_FILE_LIMIT_EXCEEDED",
		budgetExceeded: "REMOTE_SESSION_BUDGET_EXCEEDED",
		projectUnresolved: "REMOTE_SESSION_PROJECT_UNRESOLVED",
		catalogUnavailable: "REMOTE_SESSION_CATALOG_UNAVAILABLE",
		registerFailed: "REMOTE_SESSION_REGISTER_FAILED",
		scanFailed: "REMOTE_SESSION_SCAN_FAILED",
		titleFailed: "REMOTE_SESSION_TITLE_FAILED",
	};
	for (const [key, value] of Object.entries(frozenCodes)) assert.equal(plain(REMOTE_SESSION_CODES)[key], value, key);
	// 边界（冻结设计第 8 条）：远端路径绝不进本地 fs，这一层不许出现 node:fs / node:path / electron。
	assert.doesNotMatch(SCANNER_SOURCE, /from "node:fs/);
	assert.doesNotMatch(SCANNER_SOURCE, /from "node:path/);
	assert.doesNotMatch(SCANNER_SOURCE, /from "electron"/);
});

test("扫描：两层布局、跳过归档/回收/产物目录、只收 .jsonl、name 用文件名 stem", async () => {
	const { port, calls } = fakeRemote({
		listings: {
			".": [dirEntry("-srv-app-"), dirEntry(".pideck-archive"), dirEntry(".trash"), dirEntry("subagent-artifacts"), fileEntry("root-level.jsonl", 7), fileEntry("notes.txt", 3)],
			"-srv-app-": [fileEntry("2026-02-03T10-00-00_abc.jsonl", 100), fileEntry("other.txt", 5), dirEntry("nested")],
		},
		files: {
			"root-level.jsonl": { bytes: 7, mtimeMs: 111 },
			"-srv-app-/2026-02-03T10-00-00_abc.jsonl": { bytes: 100, mtimeMs: 222 },
		},
	});
	const scanner = createRemoteSessionScanner({ port });
	const result = await scanner.scan(HOST);
	assert.equal(result.ok, true);
	assert.deepEqual(plain(result.entries), [
		{ remoteSessionId: "-srv-app-/2026-02-03T10-00-00_abc.jsonl", remotePath: "-srv-app-/2026-02-03T10-00-00_abc.jsonl", name: "2026-02-03T10-00-00_abc", size: 100, mtimeMs: 222 },
		{ remoteSessionId: "root-level.jsonl", remotePath: "root-level.jsonl", name: "root-level", size: 7, mtimeMs: 111 },
	]);
	// 会话根 = <remote home>/.pi/agent/sessions，root 参数就是它（本批不改 withProjectSession）。
	assert.deepEqual(plain(calls.sessions), [{ hostId: HOST, root: "/home/dev/.pi/agent/sessions" }]);
	assert.deepEqual(calls.list.slice().sort(), ["-srv-app-", "."].sort());
	assert.deepEqual(calls.stat.slice().sort(), ["-srv-app-/2026-02-03T10-00-00_abc.jsonl", "root-level.jsonl"].sort());
	// 列表级元数据不读任何正文。
	assert.deepEqual(calls.read, []);
});

test("扫描：空会话根返回空列表（不是错误）", async () => {
	const { port } = fakeRemote({ listings: { ".": [] } });
	const result = await createRemoteSessionScanner({ port }).scan(HOST);
	assert.deepEqual(plain(result), { ok: true, entries: [] });
});

test("扫描：home 解析不出来就 fail closed，且不与远端建立会话", async () => {
	for (const home of [undefined, "", "~", "relative/home", 42]) {
		const { port, calls } = fakeRemote({ home });
		const result = await createRemoteSessionScanner({ port }).scan(HOST);
		assert.deepEqual(plain(result), { ok: false, code: "REMOTE_SESSION_HOME_UNAVAILABLE" }, "home=" + String(home));
		assert.deepEqual(calls.sessions, []);
	}
});

test("扫描：withProjectSession 的建立失败原样转述它自己的稳定码", async () => {
	const { port, calls } = fakeRemote({ withProjectSession: async () => ({ ok: false, code: "SSH_HOST_NOT_READY" }) });
	const result = await createRemoteSessionScanner({ port }).scan(HOST);
	assert.deepEqual(plain(result), { ok: false, code: "SSH_HOST_NOT_READY" });
	assert.deepEqual(calls.home, [HOST]);
});

test("扫描：列目录失败整次失败（不返回看起来完整的半截列表）", async () => {
	const { port } = fakeRemote({ listings: { "-srv-app-": [fileEntry("a.jsonl")] } });
	const result = await createRemoteSessionScanner({ port }).scan(HOST);
	assert.deepEqual(plain(result), { ok: false, code: "PATH_NOT_FOUND" });
});

test("扫描：畸形目录项由 reader 判协议违例", async () => {
	const malformedName = fakeRemote({ listings: { ".": [dirEntry("..")] } });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: malformedName.port }).scan(HOST)), { ok: false, code: "PROTOCOL_INVALID" });
	const missingBytes = fakeRemote({ listings: { ".": [{ name: "a.jsonl", kind: "file" }] } });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: missingBytes.port }).scan(HOST)), { ok: false, code: "PROTOCOL_INVALID" });
	const extraField = fakeRemote({ listings: { ".": [{ name: "a.jsonl", kind: "file", bytes: 1, mtimeMs: 1 }] } });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: extraField.port }).scan(HOST)), { ok: false, code: "PROTOCOL_INVALID" });
});

test("扫描：list 条目越过契约上限是 RESULT_TOO_LARGE", async () => {
	const many = Array.from({ length: 4097 }, (_, index) => fileEntry("f" + index + ".jsonl", 1));
	const { port } = fakeRemote({ listings: { ".": many } });
	assert.deepEqual(plain(await createRemoteSessionScanner({ port }).scan(HOST)), { ok: false, code: "RESULT_TOO_LARGE" });
});

test("扫描：工作区目录上限在列目录之前判断", async () => {
	const { port, calls } = fakeRemote({ listings: { ".": [dirEntry("a"), dirEntry("b"), dirEntry("c")] } });
	const scanner = createRemoteSessionScanner({ port, limits: { maxWorkspaceDirs: 2 } });
	assert.deepEqual(plain(await scanner.scan(HOST)), { ok: false, code: "REMOTE_SESSION_DIR_LIMIT_EXCEEDED" });
	// 只有根列表被列过：越界就不必再为这 3 个目录发帧。
	assert.deepEqual(calls.list, ["."]);
	assert.deepEqual(calls.stat, []);
});

test("扫描：会话文件上限在 stat 之前判断", async () => {
	const { port, calls } = fakeRemote({ listings: { ".": [fileEntry("a.jsonl", 1), fileEntry("b.jsonl", 1), fileEntry("c.jsonl", 1)] } });
	const scanner = createRemoteSessionScanner({ port, limits: { maxFiles: 2 } });
	assert.deepEqual(plain(await scanner.scan(HOST)), { ok: false, code: "REMOTE_SESSION_FILE_LIMIT_EXCEEDED" });
	assert.deepEqual(calls.stat, []);
});

test("扫描：元数据字节预算越界即拒绝，不进入 stat 阶段", async () => {
	const longName = "x".repeat(40) + ".jsonl";
	const { port, calls } = fakeRemote({ listings: { ".": [dirEntry("ws"), fileEntry("root.jsonl", 1)], ws: [fileEntry(longName, 1), fileEntry(longName + ".2.jsonl", 1)] } });
	// 根列表 2 项 ≈ 2*(32+少量) 字节；预算 100 会在 ws 列表折叠时耗尽。
	const scanner = createRemoteSessionScanner({ port, limits: { maxTotalBytes: 100 } });
	assert.deepEqual(plain(await scanner.scan(HOST)), { ok: false, code: "REMOTE_SESSION_BUDGET_EXCEEDED" });
	assert.deepEqual(calls.stat, []);
});

test("扫描：目录列表并发不超过 4（且确实并行）", async () => {
	const names = ["d1", "d2", "d3", "d4", "d5", "d6"];
	const listings = { ".": names.map((name) => dirEntry(name)) };
	for (const name of names) listings[name] = [];
	const parallel = fakeRemote({ listings, listDelayMs: 5 });
	assert.equal(parallel.maxInFlight() <= 4, true);
	assert.deepEqual(plain(await createRemoteSessionScanner({ port: parallel.port }).scan(HOST)), { ok: true, entries: [] });
	assert.equal(parallel.maxInFlight() <= 4, true, "max in-flight must stay within the 4 cap");
	assert.equal(parallel.maxInFlight() >= 2, true, "directories must actually be listed in parallel");
	const serial = fakeRemote({ listings, listDelayMs: 0 });
	await createRemoteSessionScanner({ port: serial.port, limits: { concurrency: 1 } }).scan(HOST);
	assert.equal(serial.maxInFlight(), 1);
});

test("装配：非法 port / 越界 limits 一律在构造期拒绝", () => {
	const { port } = fakeRemote();
	const invalid = [
		{},
		{ port: { remoteHome: async () => "/home/dev" } },
		{ port, limits: { maxFiles: 2001 } },
		{ port, limits: { maxWorkspaceDirs: 513 } },
		{ port, limits: { maxTotalBytes: REMOTE_SESSION_LIMITS.maxTotalBytes + 1 } },
		{ port, limits: { concurrency: 5 } },
		{ port, limits: { maxFiles: 0 } },
		{ port, limits: { maxFiles: 1.5 } },
		{ port, limits: "big" },
	];
	for (const options of invalid) {
		assert.throws(
			() => createRemoteSessionScanner(options),
			(error) => error.message === REMOTE_SESSION_SCANNER_OPTIONS_INVALID,
			JSON.stringify(options),
		);
	}
});

test("扫描：非法 hostId 一个帧都不发", async () => {
	for (const hostId of ["", "a\u0000b", "x".repeat(65), undefined, 7]) {
		const { port, calls } = fakeRemote();
		const result = await createRemoteSessionScanner({ port }).scan(hostId);
		assert.deepEqual(plain(result), { ok: false, code: "REMOTE_SESSION_HOST_ID_INVALID" }, String(hostId));
		assert.deepEqual(calls.home, []);
	}
});

/** IPC 域：注入通道名 + electron 桩，每个用例单独装载一次（装配语义就是每次注册一份）。 */
function ipcFor(input) {
	const handlers = new Map();
	const { registerRemoteSessionIpc } = loadTsCommonJs("src/main/ipc/remoteSessionIpc.ts", {
		stubs: {
			electron: {
				ipcMain: {
					handle(channel, handler) {
						handlers.set(channel, handler);
					},
				},
			},
		},
	});
	registerRemoteSessionIpc(input);
	return handlers;
}

const CHANNELS = { scan: "remote:remote-session-scan", register: "remote:remote-session-register" };

test("IPC：两个通道按注入的名字注册，缺通道名是装配错误", () => {
	const handlers = ipcFor({ enabled: true, channels: CHANNELS });
	assert.equal(handlers.has(CHANNELS.scan), true);
	assert.equal(handlers.has(CHANNELS.register), true);
	assert.throws(
		() => ipcFor({ enabled: true, channels: { scan: "", register: CHANNELS.register } }),
		(error) => error.message === "REMOTE_SESSION_CHANNELS_INVALID",
	);
	assert.throws(
		() => ipcFor({ enabled: true }),
		(error) => error.message === "REMOTE_SESSION_CHANNELS_INVALID",
	);
});

test("IPC：实验开关关掉时连服务都不构建", async () => {
	let called = false;
	const handlers = ipcFor({
		enabled: false,
		service: () => {
			called = true;
			return undefined;
		},
		channels: CHANNELS,
	});
	assert.deepEqual(plain(await handlers.get(CHANNELS.scan)({}, HOST)), { ok: false, code: "REMOTE_FEATURE_DISABLED" });
	assert.deepEqual(plain(await handlers.get(CHANNELS.register)({}, HOST, "a.jsonl")), { ok: false, code: "REMOTE_FEATURE_DISABLED" });
	assert.equal(called, false);
});

test("IPC：非法 hostId 在边界就被拒，不进服务", async () => {
	let called = false;
	const handlers = ipcFor({
		enabled: true,
		service: () => {
			called = true;
			return undefined;
		},
		channels: CHANNELS,
	});
	for (const bad of ["", "not-a-uuid", "../../etc/passwd", undefined, 42]) {
		assert.deepEqual(plain(await handlers.get(CHANNELS.scan)({}, bad)), { ok: false, code: "REMOTE_SESSION_HOST_ID_INVALID" });
		assert.deepEqual(plain(await handlers.get(CHANNELS.register)({}, bad, "a.jsonl")), { ok: false, code: "REMOTE_SESSION_HOST_ID_INVALID" });
	}
	assert.equal(called, false);
});

test("IPC：扫描返回列表级元数据（无正文、无远端路径以外的字段）", async () => {
	const { port } = fakeRemote({ listings: { ".": [fileEntry("s.jsonl", 12)] }, files: { "s.jsonl": { bytes: 12, mtimeMs: 5 } } });
	const handlers = ipcFor({ enabled: true, service: () => port, channels: CHANNELS });
	const result = await handlers.get(CHANNELS.scan)({}, HOST);
	assert.deepEqual(plain(result), { ok: true, entries: [{ remoteSessionId: "s.jsonl", remotePath: "s.jsonl", name: "s", size: 12, mtimeMs: 5 }] });
});

test("IPC：登记把远端 id 与装配给的项目归属交给 catalog，返回稳定 sessionId", async () => {
	const { port, calls } = fakeRemote({ listings: { ".": [fileEntry("2026-02-03T10-00-00_abc.jsonl", 30)] }, files: { "2026-02-03T10-00-00_abc.jsonl": { bytes: 30, mtimeMs: 999 } } });
	const ensured = [];
	const catalog = {
		async ensureRemoteSession(input) {
			ensured.push(input);
			return { record: { id: "stable-1" }, created: ensured.length === 1 };
		},
	};
	const handlers = ipcFor({ enabled: true, service: () => port, catalog: () => catalog, projectIdForHost: () => "project-1", channels: CHANNELS });
	const id = "2026-02-03T10-00-00_abc.jsonl";
	assert.deepEqual(plain(await handlers.get(CHANNELS.register)({}, HOST, id)), { ok: true, sessionId: "stable-1", created: true, remoteSessionId: id, remotePath: id });
	assert.deepEqual(plain(await handlers.get(CHANNELS.register)({}, HOST, id)), { ok: true, sessionId: "stable-1", created: false, remoteSessionId: id, remotePath: id });
	assert.deepEqual(plain(ensured[0]), { projectId: "project-1", hostId: HOST, remoteSessionId: id, remotePath: id, title: "2026-02-03T10-00-00_abc", updatedAt: 999 });
	// 两次登记各自都在远端确认了一次这条 id 现在是文件。
	assert.deepEqual(calls.stat, [id, id]);
});

test("IPC：非字符串 remoteSessionId 被边界拒绝", async () => {
	let called = false;
	const handlers = ipcFor({
		enabled: true,
		service: () => {
			called = true;
			return undefined;
		},
		channels: CHANNELS,
	});
	assert.deepEqual(plain(await handlers.get(CHANNELS.register)({}, HOST, 7)), { ok: false, code: "REMOTE_SESSION_ID_INVALID" });
	assert.equal(called, false);
});

test("IPC：服务构建失败与缺失都是稳定码", async () => {
	const missing = ipcFor({ enabled: true, service: () => undefined, channels: CHANNELS });
	assert.deepEqual(plain(await missing.get(CHANNELS.scan)({}, HOST)), { ok: false, code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" });
	const broken = ipcFor({
		enabled: true,
		service: () => {
			throw new Error("private ssh path");
		},
		channels: CHANNELS,
	});
	assert.deepEqual(plain(await broken.get(CHANNELS.scan)({}, HOST)), { ok: false, code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" });
	const service = ipcFor({ enabled: true, service: () => ({ remoteHome: async () => "/home/dev" }), channels: CHANNELS });
	assert.deepEqual(plain(await service.get(CHANNELS.scan)({}, HOST)), { ok: false, code: "REMOTE_SESSION_SCANNER_OPTIONS_INVALID" });
});
