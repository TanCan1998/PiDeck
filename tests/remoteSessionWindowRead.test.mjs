import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * I1：有界窗口读取原语 + 标题两段式（尾窗口）。
 *
 * 这份文件同时是**复现测试**：pi 的权威会话名用 `/name` 追加在文件尾，落在 64 KiB 头窗口之外。
 * 下面「只有文件尾带 session_info」的用例在当前实现下会得到弱兜底（首题文本）或 stem 兜底——先红后绿。
 */

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const readerModule = loadTsCommonJs("src/main/remote/RemoteWorkspaceReader.ts");
const { createRemoteWorkspaceReader, REMOTE_WORKSPACE_MAX_HEAD_BYTES } = readerModule;
const { createRemoteSessionScanner } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/**
 * 远端替身：内容是一段真实字节缓冲，fs.read 按 offset/bytes 切片。
 * frames 是仪器：每次 fs.read 请求的 offset/bytes 都记下来，用来断言「有界 + 不整文件读」。
 */
function fakeRemote(content, options = {}) {
	const frames = [];
	const size = content.length;
	let readCalls = 0;
	const session = {
		async request(method, params) {
			frames.push({ method, params: plain(params ?? {}) });
			if (method === "fs.stat") {
				if (options.statError) throw Object.assign(new Error(options.statError), { code: options.statError });
				return { kind: options.kind ?? "file", bytes: size, mtimeMs: 7 };
			}
			if (method === "fs.read") {
				readCalls += 1;
				// failReadCall 是 1-based 的第几次读：用来只让「尾读」失败，而不影响头读。
				if (options.failReadCall !== undefined && readCalls >= options.failReadCall) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
				const slice = content.subarray(params.offset, params.offset + params.bytes);
				return { chunk: Buffer.from(slice).toString("base64"), bytes: slice.length, eof: params.offset + slice.length >= size };
			}
			throw new Error("unexpected method " + method);
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const roots = [];
	const probeRoots = [];
	// 配置探测阶段（root=<home>/.pi/agent）的替身：没有 settings.json ⇒ 任何请求都「读不到」。
	const probeSession = {
		async request() {
			throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const port = {
		remoteHome: async () => "/home/dev",
		async withProjectSession(hostId, root, task) {
			// J2 的配置探测不产生 frames/roots 记录：既有断言锁的是「会话阶段」的帧预算。
			if (root === "/home/dev/.pi/agent") {
				probeRoots.push(root);
				return { ok: true, value: await task(probeSession) };
			}
			roots.push(root);
			if (options.sessionFailure) return { ok: false, code: options.sessionFailure };
			return { ok: true, value: await task(session) };
		},
	};
	return { port, frames, roots, session, probeRoots };
}

/** 把替身的 session.request 适配成 reader 的 port（hostId 在第一位）。 */
function readerFor(remote) {
	return createRemoteWorkspaceReader({ port: { request: (hostId, method, params) => remote.session.request(method, params) } });
}

function scannerFor(remote) {
	return createRemoteSessionScanner({ port: remote.port });
}

function readsOf(remote) {
	return remote.frames.filter((frame) => frame.method === "fs.read");
}

function statsOf(remote) {
	return remote.frames.filter((frame) => frame.method === "fs.stat");
}

/** 一段真实的 JSONL 字节流：头部有首条 user 消息（弱兜底），pad 掉头部 64 KiB，最后追加权威 session_info。 */
function tailNamedSession(name) {
	return tailNamedSessionOfSize(name, 200 * 1024);
}

/** 同上，但可指定目标体积：用来构造 64 KiB < size < 128 KiB 的「两窗本会重叠」区间。 */
function tailNamedSessionOfSize(name, targetBytes) {
	const lines = [JSON.stringify({ type: "message", message: { role: "user", content: "first ask" } })];
	let bytes = lines[0].length + 1;
	// 默认目标 > 两个窗口之和（128 KiB）：头窗口与尾窗口天然互不重叠。
	while (bytes < targetBytes) {
		const filler = JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(1000) } });
		lines.push(filler);
		bytes += filler.length + 1;
	}
	lines.push(JSON.stringify({ type: "session_info", name }));
	return Buffer.from(lines.join("\n") + "\n", "utf8");
}

test("只有文件尾带权威名（/name 追加）：必须靠有界尾窗口解析出 authoritative，而不是弱兜底或 stem", async () => {
	const content = tailNamedSession("Tail Named");
	assert.ok(content.length > REMOTE_WORKSPACE_MAX_HEAD_BYTES * 2, "两个窗口必须互不重叠，才能证明尾读真的发生了");
	const remote = fakeRemote(content);
	const result = await scannerFor(remote).title({ hostId: HOST, remoteSessionId: "ws/tail-named.jsonl" });
	assert.deepEqual(plain(result), { ok: true, title: "Tail Named", titleOrigin: "authoritative" });
});

test("头尾窗口零重叠：64 KiB < size < 128 KiB 时尾窗只读头窗没覆盖的那部分", async () => {
	const content = tailNamedSessionOfSize("Mid Tail Named", 96 * 1024);
	assert.ok(content.length > REMOTE_WORKSPACE_MAX_HEAD_BYTES, "fixture 必须大于头窗");
	assert.ok(content.length < 2 * REMOTE_WORKSPACE_MAX_HEAD_BYTES, "fixture 必须落在「尾窗贴尾就会与头窗重叠」的区间");
	const remote = fakeRemote(content);
	const result = await scannerFor(remote).title({ hostId: HOST, remoteSessionId: "ws/mid.jsonl" });
	assert.deepEqual(plain(result), { ok: true, title: "Mid Tail Named", titleOrigin: "authoritative" });
	const reads = readsOf(remote);
	assert.equal(reads.length, 2, "头读 + 尾读");
	const head = reads[0];
	const tail = reads[1];
	assert.equal(head.params.offset, 0);
	assert.equal(head.params.bytes, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(tail.params.offset, head.params.offset + head.params.bytes, "尾窗从头窗结束处开始（零重叠）");
	assert.equal(tail.params.offset + tail.params.bytes, content.length, "尾窗必须读到文件尾（权威名在那里）");
	assert.ok(tail.params.bytes <= REMOTE_WORKSPACE_MAX_HEAD_BYTES, "每段 ≤64 KiB");
	assert.ok(head.params.offset + head.params.bytes <= tail.params.offset, "两个区间不重叠");
	assert.equal(head.params.bytes + tail.params.bytes, content.length, "两窗合起来恰好覆盖整个文件且不重复");
	assert.equal(statsOf(remote).length, 1, "仍然只有 1 次 sizing stat");
});

test("尾窗口读取：头部已经有权威名时不再读尾（帧数可证）", async () => {
	const content = Buffer.from('{"type":"session_info","name":"Head Named"}\n{"type":"message","message":{"role":"user","content":"ask"}}\n', "utf8");
	const remote = fakeRemote(content);
	assert.deepEqual(plain(await scannerFor(remote).title({ hostId: HOST, remoteSessionId: "ws/head-named.jsonl" })), { ok: true, title: "Head Named", titleOrigin: "authoritative" });
	assert.equal(statsOf(remote).length, 1, "只有头读的 sizing stat");
	assert.equal(readsOf(remote).length, 1, "头内已有权威名：没有第二次读");
	assert.equal(readsOf(remote)[0].params.offset, 0);
});

test("档位：权威名 / 弱兜底（首条 user 文本）/ stem 兜底三分", async () => {
	const authoritative = fakeRemote(Buffer.from('{"type":"session_info","name":"Real Name"}\n', "utf8"));
	assert.deepEqual(plain(await scannerFor(authoritative).title({ hostId: HOST, remoteSessionId: "ws/a.jsonl" })), { ok: true, title: "Real Name", titleOrigin: "authoritative" });

	const weak = fakeRemote(Buffer.from('{"type":"message","message":{"role":"user","content":"Fix the failing test"}}\n', "utf8"));
	assert.deepEqual(plain(await scannerFor(weak).title({ hostId: HOST, remoteSessionId: "ws/b.jsonl" })), { ok: true, title: "Fix the failing test", titleOrigin: "inferred" });

	const nothing = fakeRemote(Buffer.from('{"type":"session","id":"s-1"}\n', "utf8"));
	assert.deepEqual(plain(await scannerFor(nothing).title({ hostId: HOST, remoteSessionId: "ws/c.jsonl" })), { ok: true, title: "c", titleOrigin: "fallback" });
});

test("两段式仍只有 1 次 sizing stat：头读 + 尾读各自字节有界，请求总量远小于文件", async () => {
	const content = tailNamedSession("Tail Named");
	const remote = fakeRemote(content);
	const result = await scannerFor(remote).title({ hostId: HOST, remoteSessionId: "ws/tail-named.jsonl" });
	assert.equal(result.titleOrigin, "authoritative");
	assert.equal(result.tailDegraded, undefined, "尾读成功时不得出现降级标记");
	assert.equal(statsOf(remote).length, 1, "尾读复用头读的 size，不再 stat 第二次");
	const reads = readsOf(remote);
	assert.equal(reads.length, 2, "一次头读 + 一次尾读");
	assert.equal(reads[0].params.offset, 0);
	assert.equal(reads[0].params.bytes, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(reads[1].params.bytes <= REMOTE_WORKSPACE_MAX_HEAD_BYTES, true);
	assert.equal(reads[1].params.offset, content.length - reads[1].params.bytes, "尾窗口必须贴住文件尾");
	assert.equal(reads[0].params.offset + reads[0].params.bytes <= reads[1].params.offset, true, "两个窗口互不重叠");
	const requested = reads.reduce((sum, frame) => sum + frame.params.bytes, 0);
	assert.equal(requested, 2 * REMOTE_WORKSPACE_MAX_HEAD_BYTES, "请求总量恒为两个窗口上限（各自有界）");
	assert.ok(requested < content.length, "绝不整文件读");
});

test("尾读失败：降级为头部结果，但必须如实上报（tailDegraded，不再静默）", async () => {
	const content = tailNamedSession("Tail Named");
	const remote = fakeRemote(content, { failReadCall: 2 });
	const result = await scannerFor(remote).title({ hostId: HOST, remoteSessionId: "ws/tail-named.jsonl" });
	// 标题与档位仍是头部那份（诚实降级，不编造），但结果里必须带上「尾读失败」这个事实。
	assert.deepEqual(plain(result), { ok: true, title: "first ask", titleOrigin: "inferred", tailDegraded: true });
});

test("头内已有权威名（零尾读）不得带降级标记", async () => {
	const content = Buffer.from('{"type":"session_info","name":"Head Only"}\n', "utf8");
	const remote = fakeRemote(content);
	const result = await scannerFor(remote).title({ hostId: HOST, remoteSessionId: "ws/head-only.jsonl" });
	assert.deepEqual(plain(result), { ok: true, title: "Head Only", titleOrigin: "authoritative" });
	assert.equal(readsOf(remote).length, 1, "零尾读");
});

test("readWindow：有界窗口 + 不整文件读（计数替身）", async () => {
	const { REMOTE_WORKSPACE_MAX_WINDOW_BYTES } = readerModule;
	assert.equal(REMOTE_WORKSPACE_MAX_WINDOW_BYTES, 64 * 1024);
	const content = Buffer.alloc(10 * 1024 * 1024, 0x41);
	const remote = fakeRemote(content);
	const reader = readerFor(remote);
	const window = await reader.readWindow(HOST, "big.jsonl", { offset: 5 * 1024 * 1024, maxBytes: REMOTE_WORKSPACE_MAX_WINDOW_BYTES });
	assert.equal(window.bytes, REMOTE_WORKSPACE_MAX_WINDOW_BYTES);
	assert.equal(window.offset, 5 * 1024 * 1024);
	assert.equal(window.size, content.length);
	assert.equal(window.truncated, true);
	assert.equal(statsOf(remote).length, 1, "窗口原语自己的一次 sizing stat");
	const reads = readsOf(remote);
	assert.equal(reads.length, 1);
	assert.equal(reads[0].params.offset, 5 * 1024 * 1024);
	assert.equal(reads[0].params.bytes, REMOTE_WORKSPACE_MAX_WINDOW_BYTES);
});

test("readWindow：调用方给出 size 时不再 stat（标题路径的 1 stat 契约）", async () => {
	const { REMOTE_WORKSPACE_MAX_WINDOW_BYTES } = readerModule;
	const content = Buffer.alloc(300 * 1024, 0x42);
	const remote = fakeRemote(content);
	const reader = readerFor(remote);
	const window = await reader.readWindow(HOST, "log.jsonl", { offset: content.length - 1024, maxBytes: 1024, size: content.length });
	assert.equal(window.bytes, 1024);
	assert.equal(window.size, content.length);
	assert.equal(statsOf(remote).length, 0, "已知 size 就不该再发 sizing stat");
	assert.equal(readsOf(remote).length, 1);

	// offset 超过文件尾 = 空窗口（没有可读内容），不是错误，也不发读帧。
	const past = fakeRemote(content);
	const pastReader = readerFor(past);
	const empty = await pastReader.readWindow(HOST, "log.jsonl", { offset: content.length + 10, maxBytes: 1024, size: content.length });
	assert.deepEqual(plain({ bytes: empty.bytes, offset: empty.offset, truncated: empty.truncated }), { bytes: 0, offset: content.length, truncated: false });
	assert.deepEqual(readsOf(past), []);
});

test("readWindow：非法 offset/maxBytes 在发帧前拒绝，非普通文件拒读", async () => {
	const { REMOTE_WORKSPACE_MAX_WINDOW_BYTES } = readerModule;
	const mk = (content, options) => readerFor(fakeRemote(content, options));
	const content = Buffer.alloc(4096, 0x43);
	for (const spec of [
		{ offset: -1, maxBytes: 16 },
		{ offset: 1.5, maxBytes: 16 },
		{ offset: 0, maxBytes: 0 },
		{ offset: 0, maxBytes: 1.5 },
		{ offset: 0, maxBytes: REMOTE_WORKSPACE_MAX_WINDOW_BYTES + 1 },
		{ offset: 0, maxBytes: 16, size: -1 },
		{ offset: 0, maxBytes: 16, size: 1.5 },
	]) {
		const expected = spec.maxBytes > REMOTE_WORKSPACE_MAX_WINDOW_BYTES ? "RESULT_TOO_LARGE" : "PROTOCOL_INVALID";
		const reader = mk(content);
		await assert.rejects(
			() => reader.readWindow(HOST, "a.jsonl", spec),
			(error) => error.code === expected,
		);
	}
	const directory = fakeRemote(Buffer.alloc(0), { kind: "directory" });
	const dirReader = readerFor(directory);
	await assert.rejects(
		() => dirReader.readWindow(HOST, "dir", { offset: 0, maxBytes: 64 }),
		(error) => error.code === "NOT_A_FILE",
	);
	assert.deepEqual(readsOf(directory), [], "非普通文件一个字节都不读");
});
