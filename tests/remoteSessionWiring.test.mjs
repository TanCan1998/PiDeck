import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 远端 Session 通道的三处同步守卫（G5 集成）。
 *
 * 为什么需要：G3 的 IPC 模块刻意**不内联通道字面量**（通道名由装配注入，与 contentStoreIpc 的
 * ChannelGroup 同一先例），所以「shared 常量 / preload 桥接 / 装配注入」三处一旦有一处漏掉或拼错，
 * typecheck 也照样过，只会在运行时变成一个没有 handler 的通道。这条测试把三处钉在一起。
 */

const shared = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
const main = readFileSync("src/main/index.ts", "utf8");
const scanner = readFileSync("src/main/sessions/RemoteSessionScanner.ts", "utf8");
const sharedTypes = readFileSync("src/shared/types/remoteHost.ts", "utf8");

test("the remote session channels are declared with the frozen names", () => {
	assert.match(shared, /remoteSessionScan:\s*"remote:remote-session-scan"/);
	assert.match(shared, /remoteSessionRegister:\s*"remote:remote-session-register"/);
});

test("preload bridges both channels and the preview facade stubs them", () => {
	assert.match(preload, /remoteSessions:\s*\{/);
	assert.match(preload, /scan:\s*\(hostId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteSessionScan/);
	assert.match(preload, /register:\s*\(hostId: string, remoteSessionId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteSessionRegister/);
	// 预览/降级面必须同样暴露这两个方法，否则渲染层在非 Electron 预览下会取到 undefined。
	assert.match(previewApi, /remoteSessions:\s*\{[\s\S]{0,200}?scan: async/);
	assert.match(previewApi, /remoteSessions:\s*\{[\s\S]{0,200}?register: async/);
});

test("the assembly registers the session domain with the injected channel names", () => {
	assert.match(main, /registerRemoteSessionIpc\(\{/);
	// 注入式通道：装配必须把 shared 常量传进去，否则通道名会与 preload 不一致。
	assert.match(main, /channels:\s*\{\s*scan:\s*ipcChannels\.remoteSessionScan,\s*register:\s*ipcChannels\.remoteSessionRegister\s*\}/);
	// 归属解析必须由装配提供（scanner 无法自行推断）；缺失会让登记一律 fail closed。
	assert.match(main, /projectIdForHost:/);
});

test("the session result types live in shared and are re-exported, never redefined", () => {
	for (const name of ["RemoteSessionEntry", "RemoteSessionScanResult", "RemoteSessionRegisterResult"]) {
		assert.match(sharedTypes, new RegExp("export type " + name + " ="), name + " must be a shared contract");
	}
	// 同一结构不得在 main 侧再定义一份：只允许 import + 转出。
	assert.doesNotMatch(scanner, /export type RemoteSessionEntry = \{/, "the scanner must not redefine the shared entry");
	assert.match(scanner, /export type \{ RemoteSessionEntry, RemoteSessionRegisterResult, RemoteSessionScanResult \} from "\.\.\/\.\.\/shared\/types\/remoteHost"/);
});
