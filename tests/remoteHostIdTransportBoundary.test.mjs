import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * K2-1：传输边界的 hostId 判据必须与持久化边界**同一个**。
 *
 * 之前 `RemoteSessionScanner.readHostId` 只要求「非空 ≤64 无控制字节」，于是非 UUID 的 hostId 能走到
 * `remoteHome` / `withProjectSession`（多打一次远端往返），直到写 catalog 才被 `readSshSessionLocator`
 * 以 `REMOTE_SESSION_IDENTITY_INVALID` 拒绝——同一个坏输入在两个边界得到两种结论，且失败点更靠后。
 * 收敛后：扫描/登记/标题三个入口都用 `PROJECT_HOST_ID_PATTERN` 判定，原稳定码 `REMOTE_SESSION_HOST_ID_INVALID` 不变。
 */

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const HOME = "/home/dev";
const DEFAULT_ROOT = HOME + "/.pi/agent/sessions";

const { createRemoteSessionScanner, REMOTE_SESSION_CODES } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");
const { PROJECT_HOST_ID_PATTERN } = loadTsCommonJs("src/shared/projectLocation.ts");
const SCANNER_SOURCE = readFileSync("src/main/sessions/RemoteSessionScanner.ts", "utf8");

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 最小远端：默认根下一个会话文件。所有帧都记下来，用来证明「拒绝发生在发帧之前」。 */
function fakeRemote() {
	const frames = [];
	const session = {
		async request(method, params) {
			frames.push({ method, params: plain(params ?? {}) });
			if (method === "fs.list") return { entries: params.path === "." ? [{ name: "s.jsonl", kind: "file", bytes: 4 }] : [] };
			if (method === "fs.stat") return { kind: "file", bytes: 4, mtimeMs: 7 };
			if (method === "fs.read")
				return {
					chunk: Buffer.from('{"type":"session"}', "utf8")
						.subarray(params.offset, params.offset + params.bytes)
						.toString("base64"),
					bytes: 19,
					eof: true,
				};
			throw Object.assign(new Error("METHOD_NOT_FOUND"), { code: "METHOD_NOT_FOUND" });
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const port = {
		remoteHome: async (hostId) => {
			frames.push({ method: "remoteHome", params: { hostId } });
			return HOME;
		},
		async withProjectSession(hostId, root, task) {
			frames.push({ method: "withProjectSession", params: { hostId, root } });
			return { ok: true, value: await task(session) };
		},
	};
	return { port, frames };
}

/** 非法 hostId 矩阵：与 shared 判据拒绝的取值域一致（含大写、错版本位、错变体位）。 */
const INVALID_HOST_IDS = ["host-a", "not-a-uuid", "", "a\u0000b", "x".repeat(65), HOST.toUpperCase(), "01234567-89ab-cdef-8123-456789abcdef", "b145de8c-6330-45be-1752-f20e8e270150", HOST.slice(0, -1), HOST + "0", undefined, 7];

test("传输边界与持久化边界是同一个 hostId 判据（shared PROJECT_HOST_ID_PATTERN）", () => {
	assert.equal(PROJECT_HOST_ID_PATTERN.test(HOST), true, "正样本必须是 shared 判据接受的形态");
	for (const hostId of INVALID_HOST_IDS) {
		if (typeof hostId !== "string") continue;
		assert.equal(PROJECT_HOST_ID_PATTERN.test(hostId), false, "shared 判据必须拒绝 " + JSON.stringify(hostId));
	}
	// 传输边界不得自带第二套正则：只认 shared 的判据（源码级锁定）。
	assert.match(SCANNER_SOURCE, /PROJECT_HOST_ID_PATTERN/);
	assert.doesNotMatch(SCANNER_SOURCE, /\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/, "no second UUID literal");
});

test("scan/register/title 对非 UUID hostId 一律在发帧前拒绝，稳定码不变", async () => {
	const catalogCalls = [];
	const catalog = {
		async ensureRemoteSession(input) {
			catalogCalls.push(input);
			return { record: { id: "s" }, created: true };
		},
	};
	for (const hostId of INVALID_HOST_IDS) {
		const remote = fakeRemote();
		const scanner = createRemoteSessionScanner({ port: remote.port, catalog, projectIdForHost: () => "p-1" });
		assert.deepEqual(plain(await scanner.scan(hostId)), { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid }, "scan " + String(hostId));
		assert.deepEqual(plain(await scanner.register({ hostId, remoteSessionId: "s.jsonl" })), { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid }, "register " + String(hostId));
		assert.deepEqual(plain(await scanner.title({ hostId, remoteSessionId: "s.jsonl" })), { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid }, "title " + String(hostId));
		assert.deepEqual(remote.frames, [], "非法 hostId 不得发任何帧（含 remoteHome）：" + String(hostId));
	}
	assert.deepEqual(catalogCalls, [], "非法 hostId 不得触碰 catalog");
});

test("正样本 UUID 照常通过传输边界（拒绝不是把入口关死）", async () => {
	const remote = fakeRemote();
	const scanner = createRemoteSessionScanner({ port: remote.port });
	const result = await scanner.scan(HOST);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(plain(result.entries.map((entry) => entry.remoteSessionId)), ["s.jsonl"]);
	// 默认根（这份替身没有 settings.json ⇒ 配置探测退回默认根）。
	assert.equal(remote.frames.filter((frame) => frame.method === "withProjectSession" && frame.params.root === DEFAULT_ROOT).length, 1);
});
