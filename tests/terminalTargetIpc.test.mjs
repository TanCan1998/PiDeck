import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** ssh 项目的稳定夹具：远端终端只对 project 目标开放（REMOTE_TERMINAL_PROJECT_TARGET_REQUIRED）。 */
const SSH_HOST_ID = "3f1d2c9a-4b5e-4c7d-8a9b-0c1d2e3f4a5b";
function setup(projects = { p1: { id: "p1", name: "Project", path: "C:/trusted/project", lastOpenedAt: 0 }, ssh1: { id: "ssh1", name: "Remote", locator: { kind: "ssh", hostId: SSH_HOST_ID, remotePath: "/srv/remote" }, lastOpenedAt: 0 } }) {
	const handlers = new Map();
	const calls = [];
	const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
	const ipcChannels = loadTsCommonJs("src/shared/ipc.ts").ipcChannels;
	const { registerTerminalIpc } = loadTsCommonJs("src/main/ipc/terminalIpc.ts", { stubs: { electron: { ipcMain } } });
	registerTerminalIpc({
		appLogger: { info: () => {} },
		projectStore: { get: (projectId) => projects[projectId] },
		sessionRuntimeCoordinator: {
			validateTarget: (target) => (target.runtimeGeneration === 4 ? { ok: true, value: target } : { ok: false, error: { code: "SESSION_RUNTIME_STALE" } }),
		},
		terminalManager: {
			list: (target) => {
				calls.push({ method: "list", target: plain(target) });
				return [];
			},
			ensure: (target) => {
				calls.push({ method: "ensure", target: plain(target) });
				return [];
			},
			create: (target, shell) => {
				calls.push({ method: "create", target: plain(target), shell });
				return { id: "tab-1", ownerKey: "project:p1" };
			},
			input: (tabId, data) => calls.push({ method: "input", tabId, data }),
			resize: (tabId, cols, rows) => calls.push({ method: "resize", tabId, cols, rows }),
			close: (tabId) => calls.push({ method: "close", tabId }),
			listShells: () => [],
		},
		// 远端终端管理器：只认 remote-tab（其余 id 走本机 manager，保持本机路径可断言）。
		remoteTerminalManager: {
			has: (tabId) => tabId === "remote-tab",
			input: (senderId, tabId, data) => {
				calls.push({ method: "remoteInput", senderId, tabId, data });
			},
			resize: (senderId, tabId, cols, rows) => {
				calls.push({ method: "remoteResize", senderId, tabId, cols, rows });
			},
			close: (senderId, tabId) => {
				calls.push({ method: "remoteClose", senderId, tabId });
			},
			list: () => [],
			ensure: () => [],
		},
		toSessionCommandIpcError: (error) => new Error(error.code),
	});
	return { calls, handlers, ipcChannels };
}

test("project terminal IPC accepts only project identity and delegates no renderer cwd", async () => {
	const { calls, handlers, ipcChannels } = setup();
	await handlers.get(ipcChannels.terminalList)({}, { kind: "project", projectId: "p1" });
	assert.deepEqual(calls, [{ method: "list", target: { kind: "project", projectId: "p1" } }]);

	await assert.rejects(handlers.get(ipcChannels.terminalCreate)({}, { kind: "project", projectId: "p1", cwd: "C:/attacker" }), /INVALID_TERMINAL_TARGET/);
	assert.equal(calls.length, 1);
});

test("project terminal IPC rejects missing and non-terminal projects", async () => {
	const { handlers, ipcChannels } = setup({
		chat: { id: "chat", name: "Chat", path: "C:/chat", kind: "chat", lastOpenedAt: 0 },
	});
	const list = handlers.get(ipcChannels.terminalList);
	assert.throws(() => list({}, { kind: "project", projectId: "missing" }), /PROJECT_NOT_FOUND/);
	assert.throws(() => list({}, { kind: "project", projectId: "chat" }), /TERMINAL_PROJECT_UNSUPPORTED/);
});

test("agent terminal IPC validates runtime binding and shell selection", async () => {
	const { calls, handlers, ipcChannels } = setup();
	const create = handlers.get(ipcChannels.terminalCreate);
	const target = { kind: "agent", sessionId: "s1", agentId: "a1", runtimeGeneration: 4 };
	await create({}, target, "bash");
	assert.deepEqual(calls[0], { method: "create", target, shell: "bash" });

	await assert.rejects(create({}, { ...target, runtimeGeneration: 3 }, "bash"), /SESSION_RUNTIME_STALE/);
	await assert.rejects(create({}, target, "ssh"), /INVALID_TERMINAL_SHELL/);
	assert.equal(calls.length, 1);
});

test("terminal I/O IPC silently ignores malformed payloads and never calls the manager", () => {
	const { calls, handlers, ipcChannels } = setup();
	const input = handlers.get(ipcChannels.terminalInput);
	const resize = handlers.get(ipcChannels.terminalResize);
	const close = handlers.get(ipcChannels.terminalClose);

	// dev 契约：无效载荷属于渲染层 bug，IPC 边界静默忽略（返回 undefined）——不抛错，也不触达 manager。
	// 注意与「输入被丢弃」区分：这是类型校验，不是远端预算（预算超限仍显式拒绝，见下一条）。
	assert.equal(input({}, 123, "ls\\r"), undefined, "非字符串 tabId 必须静默忽略");
	assert.equal(input({}, "tab-1", null), undefined, "非字符串 data 必须静默忽略");
	assert.equal(resize({}, "tab-1", Number.NaN, 24), undefined, "NaN 列数必须静默忽略");
	assert.equal(resize({}, "tab-1", 80, Number.POSITIVE_INFINITY), undefined, "Infinity 行数必须静默忽略");
	assert.equal(resize({}, 42, 80, 24), undefined, "非字符串 tabId 必须静默忽略");
	// 空串仍是 string：dev 契约只挡类型（manager 侧查不到该 tab 自然 no-op），不属于静默忽略的非法载荷。
	assert.equal(close({}, null), undefined, "null tabId 必须静默忽略");
	assert.equal(close({}, 0), undefined, "数字 tabId 必须静默忽略");
	assert.deepEqual(calls, [], "无效载荷不得触达 terminal manager");
});

test("remote terminal input keeps the 16 KiB budget even though malformed payloads are ignored", () => {
	const { calls, handlers, ipcChannels } = setup();
	const input = handlers.get(ipcChannels.terminalInput);
	const sender = { id: 7, isDestroyed: () => false, once: () => {} };

	// 远端传输预算是真实边界：静默丢弃会让渲染层误以为粘贴成功，必须显式拒绝且不下发。
	assert.throws(() => input({ sender }, "remote-tab", "x".repeat(16 * 1024 + 1)), /INVALID_TERMINAL_INPUT/);
	assert.deepEqual(calls, []);

	input({ sender }, "remote-tab", "y".repeat(16 * 1024));
	assert.deepEqual(calls, [{ method: "remoteInput", senderId: 7, tabId: "remote-tab", data: "y".repeat(16 * 1024) }], "恰好到预算上限的输入必须下发");
});

test("shared terminal owner keys contain stable IDs, not cwd values", () => {
	const { terminalOwnerKeyFor } = loadTsCommonJs("src/shared/types/terminal.ts");
	assert.equal(terminalOwnerKeyFor({ kind: "project", projectId: "p1" }), "project:p1");
	assert.equal(terminalOwnerKeyFor({ kind: "agent", sessionId: "s1", agentId: "a1", runtimeGeneration: 4 }), "agent:a1");
});
