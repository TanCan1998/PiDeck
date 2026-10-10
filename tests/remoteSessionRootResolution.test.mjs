import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * J2：远端会话根解析（pi 自定义 sessionDir）。
 *
 * 复现：pi 的 user-level `settings.json`（`<home>/.pi/agent/settings.json`）里的 `sessionDir` 决定会话目录；
 * 只硬编 `<home>/.pi/agent/sessions` 会让配了自定义目录的机器**看不到会话**（当前行为：默认根列表失败/为空）。
 *
 * pi 证据（本机全局 @earendil-works/pi-coding-agent@1.0.4）：dist/config.js 的 getAgentDir/getSettingsPath/getSessionsDir；
 * dist/core/settings-manager.js:499 的 getSessionDir；dist/core/session-manager.js:290 的 getDefaultSessionDirPath；
 * docs/settings.md:64（相对路径按会话 cwd 解析、env/CLI 覆盖）；CHANGELOG:5217（自定义目录直接用、无 cwd 编码）。
 */

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const HOME = "/home/dev";
const AGENT_DIR = HOME + "/.pi/agent";
const DEFAULT_ROOT = AGENT_DIR + "/sessions";
const SETTINGS = AGENT_DIR + "/settings.json";
const INVALID = "REMOTE_SESSION_SESSION_DIR_INVALID";

const { createRemoteSessionScanner, REMOTE_SESSION_CODES, REMOTE_SESSION_ROOT_SUFFIX } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");
const { REMOTE_WORKSPACE_MAX_HEAD_BYTES } = loadTsCommonJs("src/main/remote/RemoteWorkspaceReader.ts");
const { readScanResponse } = loadTsCommonJs("src/renderer/src/components/session/remoteSessionListState.ts");
const SCANNER_SOURCE = readFileSync("src/main/sessions/RemoteSessionScanner.ts", "utf8");
const SECTIONS_SOURCE = readFileSync("src/renderer/src/components/sidebar/RemoteSessionsSection.tsx", "utf8");

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function fileEntry(name, bytes) {
	return { name, kind: "file", bytes };
}

function dirEntry(name) {
	return { name, kind: "directory" };
}

/**
 * 远端替身：以**绝对路径**建模远端文件系统（目录表 + 文件内容），把 withProjectSession 的 root 记下来，
 * 相对路径按当前 root 解析——这样「扫描到底用了哪个根」是被观测的事实而不是推断。
 */
function fakeRemote(options = {}) {
	const home = Object.hasOwn(options, "home") ? options.home : HOME;
	const dirs = options.dirs ?? {};
	const contents = options.contents ?? {};
	const roots = [];
	const frames = [];
	let currentRoot = null;
	const absOf = (relative) => (relative === "." ? currentRoot : currentRoot + "/" + relative);
	const session = {
		async request(method, params) {
			frames.push({ method, params: plain(params ?? {}) });
			const absolute = absOf(params.path);
			if (method === "fs.list") {
				const entries = dirs[absolute];
				if (entries === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
				return { entries };
			}
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
		async withProjectSession(hostId, root, task) {
			roots.push(root);
			if (options.establishFails !== undefined) return { ok: false, code: options.establishFails };
			if (dirs[root] === undefined) return { ok: false, code: "PATH_NOT_FOUND" };
			currentRoot = root;
			return { ok: true, value: await task(session) };
		},
	};
	return { port, roots, frames };
}

/** 默认布局（含自定义会话目录）的通用 fixture：agentDir 里有 settings + 自定义目录里有会话。 */
function configuredFixture(value, customDir = HOME + "/my-sessions") {
	const settings = value === undefined ? undefined : JSON.stringify({ sessionDir: value });
	return {
		dirs: {
			[AGENT_DIR]: settings === undefined ? [] : [fileEntry("settings.json", settings.length)],
			[customDir]: [fileEntry("s.jsonl", 5)],
		},
		contents: {
			...(settings === undefined ? {} : { [SETTINGS]: Buffer.from(settings, "utf8") }),
			[customDir + "/s.jsonl"]: Buffer.alloc(5),
		},
	};
}

test("自定义 sessionDir（绝对路径）生效：扫描用配置的会话根，remoteSessionId 仍相对该根", async () => {
	const options = configuredFixture("/home/dev/my-sessions");
	const remote = fakeRemote(options);
	const result = await createRemoteSessionScanner({ port: remote.port }).scan(HOST);
	assert.deepEqual(plain(result), { ok: true, entries: [{ remoteSessionId: "s.jsonl", remotePath: "s.jsonl", name: "s", size: 5, mtimeMs: 7 }] });
	// 先探测配置（root=agentDir），再按解析出的会话根建立扫描会话。
	assert.deepEqual(remote.roots, [AGENT_DIR, "/home/dev/my-sessions"]);
});

test("sessionDir 支持 ~ 展开（pi CHANGELOG:2344 的语义）", async () => {
	const remote = fakeRemote(configuredFixture("~/my-sessions"));
	const result = await createRemoteSessionScanner({ port: remote.port }).scan(HOST);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(remote.roots, [AGENT_DIR, HOME + "/my-sessions"]);
});

test("未配置 sessionDir：行为与今天一致（默认根），配置探测失败不放大成扫描失败", async () => {
	const remote = fakeRemote({
		dirs: { [AGENT_DIR]: [], [DEFAULT_ROOT]: [fileEntry("d.jsonl", 3)] },
		contents: { [DEFAULT_ROOT + "/d.jsonl"]: Buffer.alloc(3) },
	});
	const result = await createRemoteSessionScanner({ port: remote.port }).scan(HOST);
	assert.deepEqual(plain(result.entries.map((entry) => entry.remoteSessionId)), ["d.jsonl"]);
	assert.deepEqual(remote.roots, [AGENT_DIR, DEFAULT_ROOT]);
});

test("空串/null 的 sessionDir 按未配置处理（与 pi 的 falsy 语义一致）", async () => {
	for (const value of ["", null]) {
		const remote = fakeRemote({
			dirs: { [AGENT_DIR]: [fileEntry("settings.json", 1)], [DEFAULT_ROOT]: [fileEntry("d.jsonl", 3)] },
			contents: { [SETTINGS]: Buffer.from(JSON.stringify({ sessionDir: value }), "utf8"), [DEFAULT_ROOT + "/d.jsonl"]: Buffer.alloc(3) },
		});
		const result = await createRemoteSessionScanner({ port: remote.port }).scan(HOST);
		assert.equal(result.ok, true, JSON.stringify(value) + " → " + JSON.stringify(result));
		assert.deepEqual(remote.roots, [AGENT_DIR, DEFAULT_ROOT]);
	}
});

test("畸形或不可用的 sessionDir 一律拒绝（稳定码），不静默扫默认根", async () => {
	const invalid = [42, {}, [], true, "relative/dir", "./x", ".", "..", "~/../outside", "/srv/outside", "/home/dev/../outside", "/home/dev/a\u0000b", "   ", "/home/dev/./my-sessions/../../outside"];
	for (const value of invalid) {
		const remote = fakeRemote(configuredFixture(value));
		const result = await createRemoteSessionScanner({ port: remote.port }).scan(HOST);
		assert.deepEqual(plain(result), { ok: false, code: INVALID }, JSON.stringify(value) + " answered " + JSON.stringify(result));
	}
	// 合法但含多余段的路径要规范化后照常使用。
	const normalized = fakeRemote(configuredFixture("/home/dev/a/../my-sessions"));
	const result = await createRemoteSessionScanner({ port: normalized.port }).scan(HOST);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(normalized.roots, [AGENT_DIR, "/home/dev/my-sessions"]);
});

test("配置读不到/畸形/是目录/超上限截断：退回默认根而不是报错", async () => {
	const baseline = { dirs: { [AGENT_DIR]: [], [DEFAULT_ROOT]: [fileEntry("d.jsonl", 3)] }, contents: { [DEFAULT_ROOT + "/d.jsonl"]: Buffer.alloc(3) } };
	const cases = [
		baseline,
		{ dirs: { [AGENT_DIR]: [fileEntry("settings.json", 9)], [DEFAULT_ROOT]: [fileEntry("d.jsonl", 3)] }, contents: { [SETTINGS]: Buffer.from("not json at all", "utf8"), [DEFAULT_ROOT + "/d.jsonl"]: Buffer.alloc(3) } },
		{ dirs: { [AGENT_DIR]: [fileEntry("settings.json", 1)], [DEFAULT_ROOT]: [fileEntry("d.jsonl", 3)] }, contents: { [SETTINGS]: Buffer.from("[1,2,3]", "utf8"), [DEFAULT_ROOT + "/d.jsonl"]: Buffer.alloc(3) } },
		// settings.json 是**目录**：readHead 报 NOT_A_FILE ⇒ 按未配置处理。
		{ dirs: { [AGENT_DIR]: [dirEntry("settings.json")], [SETTINGS]: [], [DEFAULT_ROOT]: [fileEntry("d.jsonl", 3)] }, contents: { [DEFAULT_ROOT + "/d.jsonl"]: Buffer.alloc(3) } },
		{ dirs: { [AGENT_DIR]: [fileEntry("settings.json", 3)], [DEFAULT_ROOT]: [fileEntry("d.jsonl", 3)] }, contents: { [SETTINGS]: Buffer.concat([Buffer.from('{"sessionDir":"/home/dev/', "utf8"), Buffer.alloc(REMOTE_WORKSPACE_MAX_HEAD_BYTES, 120)]), [DEFAULT_ROOT + "/d.jsonl"]: Buffer.alloc(3) } },
	];
	for (const [index, fixture] of cases.entries()) {
		const remote = fakeRemote(fixture);
		const result = await createRemoteSessionScanner({ port: remote.port }).scan(HOST);
		assert.equal(result.ok, true, "case " + index + " → " + JSON.stringify(result));
		assert.deepEqual(plain(result.entries.map((entry) => entry.remoteSessionId)), ["d.jsonl"], "case " + index);
		assert.equal(remote.roots[remote.roots.length - 1], DEFAULT_ROOT, "case " + index);
	}
});

test("配置探测是有界的：settings.json 只 stat 一次、只读 ≤64 KiB", async () => {
	const settings = JSON.stringify({ sessionDir: "/home/dev/my-sessions" });
	const remote = fakeRemote(configuredFixture("/home/dev/my-sessions"));
	const result = await createRemoteSessionScanner({ port: remote.port }).scan(HOST);
	assert.equal(result.ok, true);
	const reads = remote.frames.filter((frame) => frame.method === "fs.read");
	assert.equal(reads.length, 1, "只读配置文件一次（会话目录是列表，不读正文）");
	assert.equal(reads[0].params.path, "settings.json");
	assert.ok(reads[0].params.bytes <= REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(reads[0].params.bytes, settings.length);
	// 只数**配置文件**的 stat：会话文件本身还有一次 stat，那是扫描的正常开销。
	assert.equal(remote.frames.filter((frame) => frame.method === "fs.stat" && frame.params.path === "settings.json").length, 1, "配置文件只 stat 一次");
});

test("title 与 register 共用同一个根解析：自定义目录里的会话可解析、可登记", async () => {
	const named = JSON.stringify({ type: "session_info", name: "Custom Named" });
	const fixture = configuredFixture("/home/dev/my-sessions");
	fixture.dirs["/home/dev/my-sessions"] = [fileEntry("s.jsonl", named.length)];
	fixture.contents["/home/dev/my-sessions/s.jsonl"] = Buffer.from(named, "utf8");
	const remote = fakeRemote(fixture);
	const scanner = createRemoteSessionScanner({ port: remote.port });
	assert.deepEqual(plain(await scanner.title({ hostId: HOST, remoteSessionId: "s.jsonl" })), { ok: true, title: "Custom Named", titleOrigin: "authoritative" });
	assert.deepEqual(remote.roots.slice(-2), [AGENT_DIR, "/home/dev/my-sessions"]);

	const ensured = [];
	const catalog = {
		async ensureRemoteSession(input) {
			ensured.push(input);
			return { record: { id: "stable-1" }, created: true };
		},
	};
	const registered = await createRemoteSessionScanner({ port: remote.port, catalog, projectIdForHost: () => "p-1" }).register({ hostId: HOST, remoteSessionId: "s.jsonl" });
	assert.equal(registered.ok, true, JSON.stringify(registered));
	assert.equal(ensured.length, 1);
	assert.equal(ensured[0].remoteSessionId, "s.jsonl", "id 仍相对会话根，不含目录前缀");
});

test("稳定码真的到达界面：IPC scan 返回 {ok:false,code}，渲染层收窄成失败态（不是空列表）", async () => {
	const handlers = new Map();
	const { registerRemoteSessionIpc } = loadTsCommonJs("src/main/ipc/remoteSessionIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } } } });
	const remote = fakeRemote(configuredFixture("relative/dir"));
	registerRemoteSessionIpc({ enabled: true, service: () => remote.port, channels: { scan: "t:scan", register: "t:register", title: "t:title" } });
	const result = await handlers.get("t:scan")({}, HOST);
	assert.deepEqual(plain(result), { ok: false, code: INVALID });
	// 渲染层：失败态必须带着这个码（H2 的三态之一），而不是被当成「空列表」。
	assert.deepEqual(plain(readScanResponse(plain(result))), { kind: "failed", code: INVALID });
	// 侧栏的错误文案把码原样呈现（未知码走 scanFailed 模板）。
	assert.match(SECTIONS_SOURCE, /sidebar\.remoteSessions\.scanFailed[\s\S]{0,40}code/, "the sidebar must surface the stable code");
});

test("远端根解析仍在旧有的安全边界内：不新增 helper op、不碰本地 fs", () => {
	assert.match(SCANNER_SOURCE, /withProjectSession/);
	assert.doesNotMatch(SCANNER_SOURCE, /from "node:fs/);
	assert.doesNotMatch(SCANNER_SOURCE, /from "electron"/);
	// 只用现有 fs.* 原语名（readHead/readWindow/list/stat），不得出现新的 helper 方法名。
	assert.doesNotMatch(SCANNER_SOURCE, /fs\.(search|walk|glob|tail)\b/);
	assert.equal(REMOTE_SESSION_CODES.sessionDirInvalid, INVALID);
	assert.equal(REMOTE_SESSION_ROOT_SUFFIX, ".pi/agent/sessions");
});
