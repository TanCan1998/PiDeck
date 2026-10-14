import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function setup() {
	const handlers = new Map(),
		calls = [],
		cleanups = [];
	const ipcChannels = loadTsCommonJs("src/shared/ipc.ts").ipcChannels;
	const { registerTerminalIpc } = loadTsCommonJs("src/main/ipc/terminalIpc.ts", { stubs: { electron: { ipcMain: { handle: (key, fn) => handlers.set(key, fn) } } } });
	const sender = { id: 7, isDestroyed: () => false, once: (name, fn) => cleanups.push(fn) };
	const remoteProject = { id: "remote", name: "Remote", lastOpenedAt: 0, locator: { kind: "ssh", hostId: "host", remotePath: "/remote" } };
	registerTerminalIpc({
		appLogger: { info: () => {} },
		projectStore: { get: (id) => (id === "remote" ? remoteProject : { id, name: id, path: "/local", lastOpenedAt: 0 }) },
		projectIdForSession: () => "remote",
		sessionRuntimeCoordinator: { validateTarget: () => ({ ok: true }) },
		toSessionCommandIpcError: (error) => new Error(error.code),
		terminalManager: {
			input: (id, data) => calls.push(["localInput", id, data]),
			list: () => {
				throw new Error("LOCAL_TERMINAL_CALLED");
			},
			ensure: () => {
				throw new Error("LOCAL_TERMINAL_CALLED");
			},
			create: () => {
				throw new Error("LOCAL_TERMINAL_CALLED");
			},
			listShells: () => [],
		},
		remoteTerminalManager: {
			has: (id) => id === "ssh-tab",
			releaseSender: (id) => calls.push(["release", id]),
			list: (id, project) => {
				calls.push(["list", id, project]);
				return [];
			},
			ensure: (id, project) => {
				calls.push(["ensure", id, project]);
				return [];
			},
			create: (id, project, shell) => {
				calls.push(["create", id, project, shell]);
				return { id: "ssh-tab" };
			},
			input: (...args) => calls.push(["input", ...args]),
			resize: (...args) => calls.push(["resize", ...args]),
			ack: (...args) => calls.push(["ack", ...args]),
			close: (...args) => calls.push(["close", ...args]),
		},
	});
	return { handlers, calls, cleanups, event: { sender }, ipcChannels };
}

test("remote input budgets do not change the native terminal paste contract", () => {
	const { handlers, calls, event, ipcChannels } = setup();
	const data = "x".repeat(20_000);
	handlers.get(ipcChannels.terminalInput)(event, "local-tab", data);
	assert.deepEqual(calls, [["localInput", "local-tab", data]]);
});

test("SSH terminal IPC routes only main-owned project identities and releases destroyed windows", async () => {
	const { handlers, calls, cleanups, event, ipcChannels: c } = setup();
	const target = { kind: "project", projectId: "remote" };
	await handlers.get(c.terminalList)(event, target);
	await handlers.get(c.terminalEnsure)(event, target);
	await handlers.get(c.terminalCreate)(event, target);
	assert.deepEqual(calls.slice(0, 3), [
		["list", 7, "remote"],
		["ensure", 7, "remote"],
		["create", 7, "remote", undefined],
	]);
	handlers.get(c.terminalInput)(event, "ssh-tab", "pwd\r");
	handlers.get(c.terminalResize)(event, "ssh-tab", 90, 30);
	handlers.get(c.terminalAcknowledge)(event, "ssh-tab", 1);
	assert.deepEqual(calls.slice(3), [
		["input", 7, "ssh-tab", "pwd\r"],
		["resize", 7, "ssh-tab", 90, 30],
		["ack", 7, "ssh-tab", 1],
	]);
	assert.equal(cleanups.length, 1);
	cleanups[0]();
	assert.deepEqual(calls.at(-1), ["release", 7]);
	assert.throws(() => handlers.get(c.terminalEnsure)(event, { ...target, cwd: "/attacker" }), /INVALID_TERMINAL_TARGET/);
	assert.throws(() => handlers.get(c.terminalAcknowledge)(event, "ssh-tab", -1), /INVALID_TERMINAL_SEQUENCE/);
	assert.throws(() => handlers.get(c.terminalInput)(event, "ssh-tab", "x".repeat(16 * 1024 + 1)), /INVALID_TERMINAL_INPUT/);
	assert.throws(() => handlers.get(c.terminalEnsure)(event, { kind: "agent", sessionId: "s", agentId: "a", runtimeGeneration: 1 }), /REMOTE_TERMINAL_PROJECT_TARGET_REQUIRED/);
});
