import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端文件名搜索 reader（F2）单测：窄 port 替身注入，不碰真实 SSH/子进程。
 *
 * 纪律与 RemoteWorkspaceReader 相同——helper 的回答是远端数据：字段集严格（缺字段/多字段/类型错都是
 * PROTOCOL_INVALID）、逐字段重建、上限本地复核、truncated 如实透传、失败只带稳定码（绝不转述远端
 * message/路径）。entry 的 path 会被调用方拆成路径段，所以它必须是合法的相对 POSIX 路径。
 */

const { createRemoteSearchReader, REMOTE_SEARCH_MAX_MATCHES, REMOTE_SEARCH_READER_CODES } = loadTsCommonJs("src/main/remote/RemoteSearchReader.ts");

// 生产模块在 vm 里加载，产出的对象原型与测试 realm 不同——deepStrictEqual 会因原型不等而失败。
// 这里把结果复制成测试 realm 的普通对象再做严格比较（不是放宽断言：结构与类型仍逐字段比对）。
const plain = (value) => JSON.parse(JSON.stringify(value));

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";

const fileEntry = (path, name, bytes = 12) => ({ path, name, kind: "file", bytes });
const folderEntry = (path, name) => ({ path, name, kind: "directory" });

/** 一次合法结果；scanned 默认等于匹配数（匹配项也属于被访问条目）。 */
function answerOf(entries, overrides = {}) {
	return { entries, scanned: entries.length, truncated: false, ...overrides };
}

function makeReader(result, calls) {
	return createRemoteSearchReader({
		port: {
			request: async (...args) => {
				calls?.push(args);
				return typeof result === "function" ? result(...args) : result;
			},
		},
	});
}

/** 只取拒绝码；调用方用 assert 断言它不会 resolve。 */
async function failureOf(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to reject");
}

test("a well-formed answer is rebuilt field by field and sent with the frozen op name", async () => {
	const calls = [];
	const reader = makeReader(answerOf([fileEntry("src/main.ts", "main.ts", 42), folderEntry("src", "src")]), calls);
	const result = await reader.search(HOST, ".", "main");
	assert.deepEqual(plain(result), {
		entries: [
			{ path: "src/main.ts", name: "main.ts", kind: "file", bytes: 42 },
			{ path: "src", name: "src", kind: "directory" },
		],
		scanned: 2,
		truncated: false,
	});
	assert.deepEqual(Object.keys(result), ["entries", "scanned", "truncated"]);
	const [hostId, method, params, options] = calls[0];
	assert.equal(hostId, HOST);
	assert.equal(method, "fs.searchNames");
	assert.deepEqual(plain(params), { path: ".", query: "main" });
	assert.equal(options, undefined);
});

test("truncated is passed through truthfully, including for a zero-match truncated scan", async () => {
	const withMatches = await makeReader(answerOf([fileEntry("a.ts", "a.ts")], { scanned: 20000, truncated: true })).search(HOST, ".", "a");
	assert.equal(withMatches.truncated, true);
	assert.equal(withMatches.entries.length, 1);

	// 截断与「没有匹配」是两回事：零匹配 + truncated 必须原样透传，绝不折叠成完整结果。
	const zeroMatches = await makeReader(answerOf([], { scanned: 20000, truncated: true })).search(HOST, ".", "zzz");
	assert.deepEqual(plain(zeroMatches), { entries: [], scanned: 20000, truncated: true });
});

test("an over-limit match list is refused as RESULT_TOO_LARGE, never silently truncated", async () => {
	assert.equal(REMOTE_SEARCH_MAX_MATCHES, 512);
	const entries = Array.from({ length: REMOTE_SEARCH_MAX_MATCHES + 1 }, (_value, index) => fileEntry("f" + index + ".ts", "f" + index + ".ts"));
	const error = await failureOf(makeReader(answerOf(entries)).search(HOST, ".", "f"));
	assert.equal(error.code, "RESULT_TOO_LARGE");
	assert.equal(error.message, "RESULT_TOO_LARGE");
});

test("result shape violations are PROTOCOL_INVALID", async () => {
	const cases = [
		["not a record", 42],
		["an array instead of an object", []],
		["a missing field", { entries: [], scanned: 0 }],
		["an unexpected extra field", { entries: [], scanned: 0, truncated: false, depth: 3 }],
		["entries that is not an array", { entries: {}, scanned: 0, truncated: false }],
		["truncated that is not a boolean", { entries: [], scanned: 0, truncated: "false" }],
		["a negative scanned", answerOf([], { scanned: -1 })],
		["a fractional scanned", answerOf([], { scanned: 1.5 })],
		["scanned past the contract ceiling", answerOf([], { scanned: 20001 })],
		["scanned below the match count", answerOf([fileEntry("a.ts", "a.ts")], { scanned: 0 })],
	];
	for (const [label, value] of cases) {
		const error = await failureOf(makeReader(value).search(HOST, ".", "a"));
		assert.equal(error.code, "PROTOCOL_INVALID", label);
	}
});

test("entry shape violations are PROTOCOL_INVALID", async () => {
	const cases = [
		["an entry that is not a record", [42]],
		["a missing name", [{ path: "a.ts", kind: "file", bytes: 1 }]],
		["a missing kind", [{ path: "a.ts", name: "a.ts", bytes: 1 }]],
		["an unexpected extra entry field", [{ path: "a.ts", name: "a.ts", kind: "file", bytes: 1, size: 1 }]],
		["bytes on a directory", [{ path: "src", name: "src", kind: "directory", bytes: 1 }]],
		["bytes missing on a file", [{ path: "a.ts", name: "a.ts", kind: "file" }]],
		["a negative size", [fileEntry("a.ts", "a.ts", -1)]],
		["a fractional size", [fileEntry("a.ts", "a.ts", 1.5)]],
		["a string size", [fileEntry("a.ts", "a.ts", "1")]],
		["an unknown kind", [{ path: "a.ts", name: "a.ts", kind: "symlink" }]],
		["an empty name", [{ path: "a.ts", name: "", kind: "file", bytes: 1 }]],
		["a dot name", [{ path: ".", name: ".", kind: "directory" }]],
		["a dotdot name", [{ path: "..", name: "..", kind: "directory" }]],
		["a name containing a separator", [{ path: "a/b", name: "a/b", kind: "directory" }]],
		["a name that contradicts the path", [{ path: "src/a.ts", name: "b.ts", kind: "file", bytes: 1 }]],
		["an absolute path", [folderEntry("/etc", "etc")]],
		["a traversal path", [folderEntry("src/../etc", "etc")]],
		["an empty path segment", [folderEntry("src//a.ts", "a.ts")]],
		["a trailing slash", [folderEntry("src/", "src")]],
		["a control byte in the path", [folderEntry("a\u0000b.ts", "b.ts")]],
		["a backslash in the path", [folderEntry("src\\a.ts", "a.ts")]],
		["a drive prefix", [folderEntry("C:/a.ts", "a.ts")]],
		["an over-long path", [folderEntry("a".repeat(4097), "a".repeat(4097))]],
	];
	for (const [label, entries] of cases) {
		const error = await failureOf(makeReader(answerOf(entries)).search(HOST, ".", "a"));
		assert.equal(error.code, "PROTOCOL_INVALID", label);
	}
});

test("query is re-validated at the boundary before any frame is sent", async () => {
	const calls = [];
	const reader = makeReader(answerOf([]), calls);
	for (const query of ["", "a".repeat(129), "\u0000abc", "ab\u007fcd", 42, undefined, null]) {
		const error = await failureOf(reader.search(HOST, ".", query));
		assert.equal(error.code, "QUERY_INVALID");
	}
	assert.equal(calls.length, 0, "an invalid query must never reach the helper");

	// 边界内的 query 原样送出（128 刚好合法、空格不算非法）。
	const calls2 = [];
	await makeReader(answerOf([]), calls2).search(HOST, ".", "a".repeat(128));
	assert.equal(calls2[0][2].query.length, 128);
	const calls3 = [];
	await makeReader(answerOf([]), calls3).search(HOST, ".", " ");
	assert.equal(calls3[0][2].query, " ");
});

test("host id and search path are validated at the protocol-shape boundary", async () => {
	const calls = [];
	const reader = makeReader(answerOf([]), calls);
	// 形状非法：空路径、控制字节、非字符串、超长 → 拒绝，且一个字节都不发。
	for (const path of ["", "\u0001", 5, null, "a".repeat(4097)]) {
		const error = await failureOf(reader.search(HOST, path, "a"));
		assert.equal(error.code, "PROTOCOL_INVALID");
	}
	for (const host of ["", "a".repeat(65), "bad\nhost", 42, null]) {
		const error = await failureOf(reader.search(host, ".", "a"));
		assert.equal(error.code, "PROTOCOL_INVALID");
	}
	assert.equal(calls.length, 0);

	// 形状合法但语义可疑的路径（绝对、..、反斜杠）**原样转发**：容器边界是 helper 自己的 root 规则，
	// 本地复刻一份只会得到第二份迟早漂移的意见（与 RemoteWorkspaceReader 同一取舍，见其特征说明）。
	// 渲染层到 IPC 边界那一层仍会按 readRelativePath 拒掉绝对/.. —— 责任在那里，不在这。
	const calls2 = [];
	await makeReader(answerOf([]), calls2).search(HOST, "src/../etc", "a");
	assert.equal(calls2[0][2].path, "src/../etc");

	const calls3 = [];
	await makeReader(answerOf([]), calls3).search(HOST, "src/components", "a");
	assert.equal(calls3[0][2].path, "src/components");
});

test("call options are validated and maxMatches is clamped to the local ceiling", async () => {
	const calls = [];
	const reader = makeReader(answerOf([]), calls);
	await reader.search(HOST, ".", "a", { maxMatches: 5000 });
	assert.equal(calls[0][2].maxMatches, REMOTE_SEARCH_MAX_MATCHES);
	assert.equal(calls[0][3], undefined);

	await reader.search(HOST, ".", "a", { maxMatches: 7, timeoutMs: 1500.9 });
	assert.equal(calls[1][2].maxMatches, 7);
	assert.deepEqual(plain(calls[1][3]), { timeoutMs: 1500 });

	await reader.search(HOST, ".", "a", { timeoutMs: -5 });
	assert.equal(calls[2][2].maxMatches, undefined);
	assert.equal(calls[2][3], undefined);

	const before = calls.length;
	for (const options of [{ maxMatches: 0 }, { maxMatches: 1.5 }, { maxMatches: "7" }, "nope", 3]) {
		const error = await failureOf(reader.search(HOST, ".", "a", options));
		assert.equal(error.code, "PROTOCOL_INVALID");
	}
	assert.equal(calls.length, before, "invalid options must not reach the helper");
});

test("a transport failure is relayed only when it already is a stable code", async () => {
	const coded = Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
	const relayed = await failureOf(makeReader(() => Promise.reject(coded)).search(HOST, ".", "a"));
	assert.equal(relayed.code, "PATH_NOT_FOUND");
	assert.equal(relayed.retryable, false);
	assert.equal(relayed.message, "PATH_NOT_FOUND");

	const timeout = await failureOf(makeReader(() => Promise.reject(new Error("REQUEST_TIMEOUT"))).search(HOST, ".", "a"));
	assert.equal(timeout.code, "REQUEST_TIMEOUT");
	assert.equal(timeout.retryable, true);

	const freeText = await failureOf(makeReader(() => Promise.reject(new Error("boom /home/user/secret"))).search(HOST, ".", "a"));
	assert.equal(freeText.code, REMOTE_SEARCH_READER_CODES.requestFailed);
	assert.equal(freeText.message, REMOTE_SEARCH_READER_CODES.requestFailed);

	const syncThrow = await failureOf(
		makeReader(() => {
			throw new Error("sync boom");
		}).search(HOST, ".", "a"),
	);
	assert.equal(syncThrow.code, REMOTE_SEARCH_READER_CODES.requestFailed);
});

test("the reader needs a usable port and reports refusals as stable codes", async () => {
	for (const options of [undefined, {}, { port: {} }, { port: { request: () => undefined }, onDiagnostic: 5 }]) {
		const error = await failureOf(Promise.resolve().then(() => createRemoteSearchReader(options)));
		assert.equal(error.message, REMOTE_SEARCH_READER_CODES.optionsInvalid);
	}

	const diagnostics = [];
	const reader = createRemoteSearchReader({
		port: { request: async () => ({ entries: [{ path: "/abs", name: "abs", kind: "file", bytes: 1 }], scanned: 1, truncated: false }) },
		onDiagnostic: (entry) => diagnostics.push(entry),
	});
	const error = await failureOf(reader.search(HOST, ".", "a"));
	assert.equal(error.code, "PROTOCOL_INVALID");
	assert.deepEqual(plain(diagnostics), [{ hostId: HOST, method: "fs.searchNames", code: "PROTOCOL_INVALID" }]);

	// 观测是旁路：坏观察者不能弄坏一次调用。
	const broken = createRemoteSearchReader({
		port: { request: async () => ({ entries: [], scanned: 0, truncated: false }) },
		onDiagnostic: () => {
			throw new Error("observer boom");
		},
	});
	assert.deepEqual(plain(await broken.search(HOST, ".", "a")), { entries: [], scanned: 0, truncated: false });
});

test("a valid call reports no diagnostic", async () => {
	const diagnostics = [];
	const reader = createRemoteSearchReader({ port: { request: async () => answerOf([]) }, onDiagnostic: (entry) => diagnostics.push(entry) });
	await reader.search(HOST, ".", "a");
	assert.deepEqual(plain(diagnostics), []);
});
