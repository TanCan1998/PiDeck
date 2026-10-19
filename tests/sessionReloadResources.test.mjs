import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(path, "utf8");

/**
 * `/reload` 的宿主链路契约：
 * - 扩展只提供 reload 命令，宿主直接发 RPC prompt，避免 sendPrompt 的乐观用户消息；
 * - 发送前确认命令来自 pi-deck-runtime，避免把 `/reload` 当普通问题交给模型；
 * - IPC 三处（通道常量、main handler、preload）同步，否则运行时 undefined。
 */
test("AgentManager.reloadResources validates the extension command and uses raw RPC prompt", () => {
	const source = read("src/main/pi/AgentManager.ts");
	assert.match(source, /async\s+reloadResources\s*\(\s*agentId\s*:\s*string\s*\)/);
	assert.match(source, /pi-deck-runtime\.ts/);
	assert.match(source, /type:\s*"get_state"/);
	assert.match(source, /hasPendingUIRequests\s*\(\s*agentId\s*\)/);
	assert.match(source, /type:\s*"prompt"\s*,\s*message:\s*`\/\$\{reloadCommand\.name\}`/);
	assert.match(source, /readPromptDisposition\s*\(\s*response\.data\s*\)/);
	// 不能复用 sendPrompt：它会在 RPC 前 addMessage 写一条用户气泡。
	const body = source.slice(source.indexOf("async reloadResources"), source.indexOf("async reloadResources") + 3000);
	assert.doesNotMatch(body, /this\.sendPrompt\s*\(/);
});

test("reloadResources IPC is wired through shared channel, main handler, and preload", () => {
	const channel = read("src/shared/ipc.ts");
	const main = read("src/main/ipc/sessionIpc.ts");
	const preload = read("src/preload/index.ts");
	const coordinator = read("src/main/sessions/SessionRuntimeCoordinator.ts");
	assert.match(channel, /sessionsRuntimeReloadResources:\s*"sessions:runtime-reload-resources"/);
	assert.match(main, /ipcChannels\.sessionsRuntimeReloadResources[\s\S]*?sessionRuntimeCoordinator\.reloadResources\s*\(\s*target\s*\)/);
	assert.match(preload, /reloadResources:\s*\(target:\s*SessionRuntimeTarget\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.sessionsRuntimeReloadResources/);
	assert.match(coordinator, /reloadResources\s*\(\s*target:\s*SessionRuntimeTarget\s*\)/);
});

test("composer send path is gated while a hot reload is in flight", () => {
	const send = read("src/renderer/src/hooks/useSessionSend.ts");
	const atoms = read("src/renderer/src/atoms/session-commands-atoms.ts");
	assert.match(atoms, /sessionReloadingByIdAtom\s*=\s*atom<Record<string,\s*boolean>>/);
	assert.match(send, /store\.get\(sessionReloadingByIdAtom\)\[sourceSessionId\]/);
	assert.match(send, /sessionCommand\.reloadResourcesBusy/);
});

test("DSH reload entry reuses the existing shared-host restart IPC", () => {
	const commands = read("src/renderer/src/utils/sessionCommands.ts");
	const hook = read("src/renderer/src/hooks/session/useSessionRunControl.ts");
	assert.match(commands, /resolveSessionReloadMode/);
	assert.match(commands, /dshHost/);
	assert.match(hook, /restartDshHost/);
	assert.match(hook, /api\.sessions\.restartDshHost\s*\(\s*\)/);
});

test("runtime adapter is always injected and listed in the extension manifest", () => {
	const builtIns = read("src/main/extensions/builtInExtensions.ts");
	const manifest = JSON.parse(read("resources/extensions/extensions-manifest.json"));
	assert.match(builtIns, /INTERNAL_BUILT_IN_EXTENSIONS\s*=\s*\[[^\]]*"pi-deck-runtime\.ts"/);
	const entry = manifest.files.find((file) => file.name === "pi-deck-runtime.ts");
	assert.ok(entry, "extensions-manifest.json 必须包含 pi-deck-runtime.ts");
	assert.equal(entry.bytes > 0, true);
});
