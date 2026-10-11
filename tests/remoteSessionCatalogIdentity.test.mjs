import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端会话在 catalog 里的身份（Phase 4 P4.2 收口第 1 件）：
 * `RemoteRuntimePort.registerRemoteSession` 把 pi 上报的**远端会话文件**折成 ssh locator
 * （hostId + 相对会话根的 remoteSessionId + remotePath）并登记进 catalog。
 *
 * 这组用例锁四件事：
 * 1. 相对路径推导**只做「去掉根前缀」**：默认布局（`<root>/--<encoded-cwd>--/<file>.jsonl`）与
 *    user-level `sessionDir` 的平铺布局各一例，且根前缀按 `root + "/"` 比 ——
 *    `/srv/sessions-extra/x.jsonl` 不属于 `/srv/sessions`；
 * 2. 拒绝矩阵（非绝对 / `..` / 控制字节 / 根外 / 反斜杠）一律 `REMOTE_SESSION_LOCATOR_UNRESOLVED`，
 *    且**零** catalog 调用：猜一个 id 写进 catalog 比失败更难查（下次扫描会另立一条记录）；
 * 3. 会话根解析**复用 scanner 的导出入口**而不是自己拼：解析失败原样透传它的稳定码
 *    （`REMOTE_SESSION_HOME_UNAVAILABLE` / `REMOTE_SESSION_SESSION_DIR_INVALID`）。
 *    这里刻意不 stub `resolveSessionRoot`（端口内部构造 scanner，没有注入点）：真 scanner 的这两个码
 *    就是被转述的契约本身，比替身更硬；
 * 4. 写入只走 `SessionCatalog.ensureRemoteSession` 这一条正门：幂等（同一 remotePath 两次 ⇒
 *    第二次 `created:false`）、每次调用才解析服务与 catalog、拿不到就 `REMOTE_RUNTIME_UNAVAILABLE`。
 */

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const HOME = "/home/dev";
const AGENT_DIR = HOME + "/.pi/agent";
const DEFAULT_ROOT = AGENT_DIR + "/sessions";
const SETTINGS = AGENT_DIR + "/settings.json";
/** 自定义会话根的机器：`sessionDir` 必须在 remote home 之内（scanner 的扫描边界只承诺 home 内）。 */
const CUSTOM_HOME = "/srv";
const CUSTOM_ROOT = CUSTOM_HOME + "/sessions";
const CUSTOM_AGENT_DIR = CUSTOM_HOME + "/.pi/agent";

const { createRemoteRuntimePort, REMOTE_RUNTIME_CODES } = loadTsCommonJs("src/main/pi/remoteRuntimePort.ts");
const { createRemoteSessionScanner, REMOTE_SESSION_CODES } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");

/** 跨 VM realm 的比较前先归一化（deepStrictEqual 会比较原型）。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 生产 SessionCatalog（只桩掉日志，其余用真实现：幂等/稳定 id/两遍匹配都是被测行为）。 */
function loadCatalogModule() {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
	});
}

const catalogModule = loadCatalogModule();

async function makeCatalog(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-session-identity-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalog = new catalogModule.SessionCatalog(join(directory, "session-catalog.json"));
	await catalog.load();
	return catalog;
}

/**
 * 远端替身：只建模**配置探测**用到的东西（`fs.stat` + `fs.read`），并把 withProjectSession 的 root
 * 记下来 —— 这样「会话根解析到底用了哪个根、跑了几次」是被观测的事实而不是推断。
 */
function fakeRemote(options = {}) {
	const home = Object.hasOwn(options, "home") ? options.home : HOME;
	const dirs = options.dirs ?? {};
	const contents = options.contents ?? {};
	const roots = [];
	let currentRoot = null;
	const session = {
		async request(method, params) {
			const absolute = params.path === "." ? currentRoot : currentRoot + "/" + params.path;
			if (method === "fs.stat") {
				const content = contents[absolute];
				if (content !== undefined) return { kind: "file", bytes: content.length, mtimeMs: 7 };
				if (dirs[absolute] !== undefined) return { kind: "directory", bytes: 0, mtimeMs: 1 };
				throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
			}
			if (method === "fs.read") {
				const content = contents[absolute];
				if (content === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
				const slice = content.subarray(params.offset, params.offset + params.bytes);
				return { chunk: Buffer.from(slice).toString("base64"), bytes: slice.length, eof: params.offset + slice.length >= content.length };
			}
			throw Object.assign(new Error("METHOD_NOT_FOUND"), { code: "METHOD_NOT_FOUND" });
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const port = {
		remoteHome: async () => home,
		async withProjectSession(_hostId, root, task) {
			roots.push(root);
			if (dirs[root] === undefined) return { ok: false, code: "PATH_NOT_FOUND" };
			currentRoot = root;
			return { ok: true, value: await task(session) };
		},
	};
	return { port, roots };
}

/** 未配置 `sessionDir` 的机器：配置探测读不到文件 ⇒ 默认根（与 pi 的缺省布局逐字一致）。 */
function defaultLayoutRemote() {
	return fakeRemote({ dirs: { [AGENT_DIR]: [] } });
}

/** 配了 user-level `sessionDir` 的机器：会话根就是它（pi 的平铺布局，没有 cwd 编码）。 */
function customRootRemote(sessionDir = CUSTOM_ROOT) {
	const settings = JSON.stringify({ sessionDir });
	return fakeRemote({ home: CUSTOM_HOME, dirs: { [CUSTOM_AGENT_DIR]: [{ name: "settings.json", kind: "file", bytes: settings.length }] }, contents: { [CUSTOM_AGENT_DIR + "/settings.json"]: Buffer.from(settings, "utf8") } });
}

/** 端口 + 「catalog 调用记录」+「服务/catalog 解析次数」（解析次数用来钉「每次调用才解析」）。 */
function createHarness({ service, catalog }) {
	const counters = { service: 0, catalog: 0 };
	const calls = [];
	const catalogPort =
		catalog === undefined
			? undefined
			: {
					async ensureRemoteSession(input) {
						calls.push(input);
						return catalog.ensureRemoteSession(input);
					},
				};
	const port = createRemoteRuntimePort({
		resolveService: () => {
			counters.service += 1;
			return service;
		},
		resolveCatalog: () => {
			counters.catalog += 1;
			return catalogPort;
		},
		settings: () => ({}),
	});
	return { port, calls, counters };
}

test("默认布局：remoteSessionId 是「工作区目录 + 文件名」（不按 / 切名字、不编造 cwd 编码）", async (t) => {
	const catalog = await makeCatalog(t);
	const remote = defaultLayoutRemote();
	const harness = createHarness({ service: remote.port, catalog });
	const remotePath = DEFAULT_ROOT + "/-srv-remote-app/dev-work.jsonl";

	const registration = await harness.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath });

	assert.equal(registration.created, true);
	// 会话根来自 scanner 的判定：探测一次 `<home>/.pi/agent`，工作只发生在解析出的根上。
	assert.deepEqual(remote.roots, [AGENT_DIR]);
	assert.equal(harness.counters.service, 1);
	assert.equal(harness.counters.catalog, 1);
	const entry = catalog.listEntries()[0];
	assert.deepEqual(plain(entry.locator), {
		kind: "ssh",
		hostId: HOST,
		remoteSessionId: "-srv-remote-app/dev-work.jsonl",
		remotePath,
	});
	// 远端路径绝不落到本机字段（登记只写 locator）。
	assert.equal(entry.filePath, undefined);
	assert.equal(entry.originKey, undefined);
	assert.equal(entry.piSessionId, undefined);
	// 标题缺省 = 文件名 stem（与 scanner 的登记路径同一取值），不是整条相对路径。
	assert.equal(entry.title, "dev-work");
	assert.equal(entry.titleOrigin, "fallback");
	assert.equal(entry.updatedAt > 0, true, "未知 mtime 时 updatedAt 取登记时刻，不是 0/负数");
});

test("自定义 sessionDir（平铺布局）：remoteSessionId 就是文件名", async (t) => {
	const catalog = await makeCatalog(t);
	const remote = customRootRemote();
	const harness = createHarness({ service: remote.port, catalog });
	const remotePath = CUSTOM_ROOT + "/dev-work.jsonl";

	const registration = await harness.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath });

	assert.equal(registration.created, true);
	// 只有配置探测那一次 root；登记本身不再建立第二次会话（身份已由 pi 上报，不需要远端复核）。
	assert.deepEqual(remote.roots, [CUSTOM_AGENT_DIR]);
	assert.deepEqual(plain(catalog.listEntries()[0].locator), { kind: "ssh", hostId: HOST, remoteSessionId: "dev-work.jsonl", remotePath });
});

test("调用方给了标题/mtime 就原样落库；没给 mtime 不拿本机时间冒充", async (t) => {
	const catalog = await makeCatalog(t);
	const remote = customRootRemote();
	const harness = createHarness({ service: remote.port, catalog });
	const remotePath = CUSTOM_ROOT + "/named.jsonl";

	await harness.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath, title: "手工标题", updatedAt: 1234 });

	assert.equal(catalog.listEntries()[0].title, "手工标题");
	assert.equal(catalog.listEntries()[0].updatedAt, 1234);
});

test("根前缀误匹配被拒：/srv/sessions-extra/x.jsonl 不属于 /srv/sessions", async (t) => {
	const catalog = await makeCatalog(t);
	const remote = customRootRemote();
	const harness = createHarness({ service: remote.port, catalog });

	await assert.rejects(() => harness.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath: CUSTOM_ROOT + "-extra/x.jsonl" }), new RegExp(REMOTE_RUNTIME_CODES.locatorUnresolved));
	assert.deepEqual(harness.calls, [], "折不出可信身份时一次都不能写 catalog");
	assert.equal(catalog.listEntries().length, 0);
});

test("拒绝矩阵：非绝对 / .. / 控制字符 / 根外 / 根本身 / 反斜杠 一律 LOCATOR_UNRESOLVED 且零 catalog 调用", async (t) => {
	const catalog = await makeCatalog(t);
	const remote = customRootRemote();
	const harness = createHarness({ service: remote.port, catalog });
	const rejected = [
		"/relative/dev-work.jsonl", // 非绝对路径
		CUSTOM_ROOT + "/../elsewhere/dev-work.jsonl", // `..` 逃逸（不做「规范化后再比较」）
		CUSTOM_ROOT + "/dev\u0001work.jsonl", // 控制字节
		CUSTOM_ROOT + "/sub/dev-work.jsonl/", // 尾斜杠 ⇒ 空段
		"/tmp/elsewhere/dev-work.jsonl", // 根外
		CUSTOM_ROOT, // 根本身不是会话文件
		CUSTOM_ROOT + "/back\\slash.jsonl", // 反斜杠：remoteSessionId 的既有判据不接受
	];
	for (const remotePath of rejected) {
		await assert.rejects(() => harness.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath }), new RegExp(REMOTE_RUNTIME_CODES.locatorUnresolved), remotePath);
	}
	assert.deepEqual(harness.calls, [], "一个被拒的路径都不能触发 catalog 写入");
	assert.equal(catalog.listEntries().length, 0);
});

test("会话根解析失败：原样透传 scanner 的稳定码（不折叠、不写 catalog）", async (t) => {
	const catalog = await makeCatalog(t);
	const remotePath = DEFAULT_ROOT + "/-srv-remote-app/dev-work.jsonl";

	// home 解析不出来（远程 home 不是绝对 POSIX / 拿不到缓存状态）。
	const noHome = createHarness({ service: fakeRemote({ home: undefined }).port, catalog });
	assert.equal(REMOTE_SESSION_CODES.homeUnavailable, "REMOTE_SESSION_HOME_UNAVAILABLE");
	await assert.rejects(() => noHome.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath }), new RegExp(REMOTE_SESSION_CODES.homeUnavailable));
	assert.deepEqual(noHome.calls, []);

	// 配置里的 sessionDir 不可用（非字符串）：scanner 拒绝而不是退回默认根，端口同样原样转述。
	const badSessionDir = customRootRemote(5);
	const invalid = createHarness({ service: badSessionDir.port, catalog });
	assert.equal(REMOTE_SESSION_CODES.sessionDirInvalid, "REMOTE_SESSION_SESSION_DIR_INVALID");
	await assert.rejects(() => invalid.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath }), new RegExp(REMOTE_SESSION_CODES.sessionDirInvalid));
	assert.deepEqual(invalid.calls, []);

	assert.equal(catalog.listEntries().length, 0);
});

test("scanner 的导出入口与端口用的是同一个会话根判定（resolveSessionRoot 直接可调用）", async () => {
	const configured = customRootRemote();
	const scanner = createRemoteSessionScanner({ port: configured.port });
	assert.deepEqual(plain(await scanner.resolveSessionRoot(HOST)), { ok: true, root: CUSTOM_ROOT });
	assert.deepEqual(configured.roots, [CUSTOM_AGENT_DIR]);

	const missingHome = createRemoteSessionScanner({ port: fakeRemote({ home: undefined }).port });
	assert.deepEqual(plain(await missingHome.resolveSessionRoot(HOST)), { ok: false, code: REMOTE_SESSION_CODES.homeUnavailable });
});

test("登记幂等：同一 remotePath 两次 ⇒ 第二次 created:false、同一个 stable id、仍只有一条记录", async (t) => {
	const catalog = await makeCatalog(t);
	const remote = defaultLayoutRemote();
	const harness = createHarness({ service: remote.port, catalog });
	const remotePath = DEFAULT_ROOT + "/-srv-remote-app/dev-work.jsonl";

	const first = await harness.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath });
	const second = await harness.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath });

	assert.equal(first.created, true);
	assert.equal(second.created, false);
	assert.equal(second.record.id, first.record.id, "同一条远端会话在两次登记之间不得漂移 id");
	assert.equal(catalog.listEntries().length, 1);
	// 「每次调用才解析服务/catalog」（与 prepare 同款）：两次登记 = 两次解析。
	assert.equal(harness.counters.service, 2);
	assert.equal(harness.counters.catalog, 2);
});

test("服务或 catalog 拿不到：REMOTE_RUNTIME_UNAVAILABLE（拿不到服务就不去动 catalog）", async (t) => {
	const catalog = await makeCatalog(t);
	const remotePath = DEFAULT_ROOT + "/-srv-remote-app/dev-work.jsonl";

	const noService = createHarness({ service: undefined, catalog });
	await assert.rejects(() => noService.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath }), new RegExp(REMOTE_RUNTIME_CODES.unavailable));
	assert.equal(noService.counters.catalog, 0);

	const noCatalog = createHarness({ service: defaultLayoutRemote().port, catalog: undefined });
	await assert.rejects(() => noCatalog.port.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath }), new RegExp(REMOTE_RUNTIME_CODES.unavailable));

	// 解析抛出的稳定码原样转述（与 prepare 同一口径）。
	const failing = createRemoteRuntimePort({
		resolveService: () => Promise.reject(new Error("SSH_CLIENT_UNAVAILABLE")),
		resolveCatalog: () => catalog,
		settings: () => ({}),
	});
	await assert.rejects(() => failing.registerRemoteSession({ hostId: HOST, projectId: "p-1", remotePath }), /SSH_CLIENT_UNAVAILABLE/);
	assert.equal(catalog.listEntries().length, 0);
});
