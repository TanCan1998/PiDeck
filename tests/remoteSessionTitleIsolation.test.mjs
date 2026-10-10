import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * F4 independent verification of the on-demand remote session title (task-20, H1; tiers re-cut by I1/task-22).
 *
 * The claims that matter here are the ones a happy path cannot show:
 *
 * 1. Read-only: the title channel must not write the catalog (the registration channel owns that), so a
 *    counting catalog port has to stay at zero across every title call.
 * 2. Never fabricated: when neither window yields a title at all, the answer is the file stem with
 *    titleOrigin "fallback" - never a JSON fragment, never an empty string, never a made-up name. The three
 *    shapes are asserted separately (authoritative name field / first-message weak title / nothing), because
 *    the local pipeline legitimately treats a first user message as a title while an empty head yields nothing.
 * 3. Bounded: the port counts every fs.read frame, so a 10 MiB remote session may never cost more than one
 *    sizing stat and two window reads of at most 64 KiB each (head + tail, the frame shape I1 promises), and
 *    the requested total is always far below the file size.
 */

const { inferSessionTitleFromHeadText } = loadTsCommonJs("src/main/sessions/sessionNameLine.ts");
const { createRemoteSessionScanner } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");
const { createRemoteSessionListController, readScanResponse, readRegisterResponse, REMOTE_SESSION_LIMIT_CODES } = loadTsCommonJs("src/renderer/src/components/session/remoteSessionListState.ts");
const { createRemoteSessionTitleController, readTitleResponse } = loadTsCommonJs("src/renderer/src/components/session/remoteSessionTitleState.ts");

const TITLE_CHANNEL = "remote:remote-session-title";
const HOST_ID = "6f1d2c3b-4a59-4e8d-9f70-1a2b3c4d5e6f";
const HOME = "/home/dev";
const SESSION_ROOT = HOME + "/.pi/agent/sessions";
const MAX_HEAD = 65536;
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

const plain = (value) => JSON.parse(JSON.stringify(value));

/** A JSONL head as bytes, so a window boundary can cut a multi-byte character exactly like the remote would. */
function headBytes(text, paddingTo = 0) {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length >= paddingTo) return buffer;
	return Buffer.concat([buffer, Buffer.alloc(paddingTo - buffer.length, 120)]);
}

function titleHarness(options = {}) {
	const frames = [];
	const files = options.files ?? {};
	const catalogCalls = { ensureRemoteSession: 0, factory: 0 };
	const session = {
		async request(method, params) {
			frames.push({ method, params: plain(params ?? {}) });
			const file = files[params.path];
			if (file === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
			if (method === "fs.stat") return { kind: file.kind ?? "file", bytes: file.bytes.length, mtimeMs: file.mtimeMs ?? 7 };
			if (method === "fs.read") {
				const size = Math.max(0, Math.min(params.bytes, file.bytes.length - params.offset));
				return { chunk: file.bytes.subarray(params.offset, params.offset + size).toString("base64"), bytes: size, eof: params.offset + size >= file.bytes.length };
			}
			throw Object.assign(new Error("METHOD_NOT_FOUND"), { code: "METHOD_NOT_FOUND" });
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	// J2 的配置探测阶段（root=<home>/.pi/agent）：这份 fixture 没有 settings.json，所以任何请求都「读不到」。
	// 探测不产生 frames 记录，既有「会话阶段」的帧断言（1 stat + 头/尾窗口）保持原意。
	const probeRoots = [];
	const probeSession = {
		async request() {
			throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const port = {
		remoteHome: async () => (Object.hasOwn(options, "home") ? options.home : HOME),
		async withProjectSession(hostId, root, task) {
			if (options.establishFails !== undefined) return { ok: false, code: options.establishFails };
			if (root === HOME + "/.pi/agent") {
				probeRoots.push(root);
				return { ok: true, value: await task(probeSession) };
			}
			frames.push({ method: "withProjectSession", params: { hostId, root } });
			return { ok: true, value: await task(session) };
		},
	};
	const handlers = new Map();
	const electron = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
	const module = loadTsCommonJs("src/main/ipc/remoteSessionIpc.ts", { stubs: { electron } });
	const catalogPort = {
		async ensureRemoteSession(input) {
			catalogCalls.ensureRemoteSession += 1;
			return { record: { id: "should-never-happen" }, created: false, input };
		},
	};
	module.registerRemoteSessionIpc({
		enabled: options.enabled ?? true,
		service: () => port,
		catalog: () => {
			catalogCalls.factory += 1;
			return catalogPort;
		},
		projectIdForHost: () => "project-1",
		channels: options.channels ?? { scan: "test:scan", register: "test:register", title: TITLE_CHANNEL },
	});
	const reads = () => frames.filter((frame) => frame.method === "fs.read");
	const stats = () => frames.filter((frame) => frame.method === "fs.stat");
	// The scanner is the layer the IPC handler calls into, so the same harness drives either one. It is built
	// WITHOUT a catalog on purpose: the title path must not need one.
	const scanner = createRemoteSessionScanner({ port });
	return { handlers, frames, reads, stats, catalogCalls, session, scanner, port, probeRoots };
}

async function titleOf(harness, hostId, remoteSessionId) {
	const handler = harness.handlers.get(TITLE_CHANNEL);
	assert.ok(handler !== undefined, "the title channel must be registered when channels.title is provided; registered: " + [...harness.handlers.keys()].join(","));
	return handler({}, hostId, remoteSessionId);
}

const NAMED = "session-named.jsonl";
const LEGACY = "session-legacy.jsonl";
const WEAK = "session-weak.jsonl";
const EMPTY_HEAD = "session-empty.jsonl";
const MALFORMED = "session-malformed.jsonl";
const TIMESTAMP_NAME = "2026-02-03T10-00-00-000Z_abc.jsonl";

function standardFiles() {
	return {
		[NAMED]: { bytes: headBytes('{"type":"session","id":"s1"}\n{"type":"session_info","name":"Refactor the parser"}\n') },
		[LEGACY]: { bytes: headBytes('{"sessionName":"Old rename","ts":1750000000000}\n{"type":"session","id":"s2"}\n') },
		[WEAK]: { bytes: headBytes('{"type":"session","id":"s3"}\n{"type":"message","message":{"role":"user","content":"Fix the failing test"}}\n') },
		[EMPTY_HEAD]: { bytes: headBytes('{"type":"session","id":"s4"}\n{"type":"model_change","model":"x"}\n') },
		[MALFORMED]: { bytes: headBytes('not json at all\n{"type":"session"\n') },
		[TIMESTAMP_NAME]: { bytes: headBytes('{"type":"session","id":"s5"}\n{"type":"session_info","name":"2026-02-03T10-00-00-000Z_abc"}\n') },
	};
}

test("an authoritative name line yields an authoritative title", async () => {
	const harness = titleHarness({ files: standardFiles() });
	const result = await titleOf(harness, HOST_ID, NAMED);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.title, "Refactor the parser");
	assert.equal(result.titleOrigin, "authoritative");
	assert.equal(harness.catalogCalls.ensureRemoteSession, 0, "the title path must not write the catalog");
	// The scanner factory is invoked once when the handler resolves its scanner (that is ordinary wiring); what
	// must stay at zero is any *use* of the catalog port, asserted above and in the scanner-level test.
});

test("a legacy private name line is authoritative, and a first user message is the weaker inferred title", async () => {
	const harness = titleHarness({ files: standardFiles() });
	const legacy = await titleOf(harness, HOST_ID, LEGACY);
	assert.equal(legacy.ok, true, JSON.stringify(legacy));
	assert.equal(legacy.title, "Old rename");
	// 旧版私有 sessionName 行是**名字字段**（当年 PiDeck 写的会话名），不是内容猜测：与本地管线同判据，
	// fromSessionInfo=true ⇒ authoritative（本地 scannedTitleOrigin 也把同一判据落成 catalog 的 manual）。
	assert.equal(legacy.titleOrigin, "authoritative");

	// The local pipeline titles a session whose file has no session_info by its first user message; excluding
	// that here would only reuse half the pipeline. It is honestly the WEAKER tier (inferred), not fabricated
	// and not the authoritative name the session never had.
	const weak = await titleOf(harness, HOST_ID, WEAK);
	assert.equal(weak.ok, true, JSON.stringify(weak));
	assert.equal(weak.title, "Fix the failing test");
	assert.equal(weak.titleOrigin, "inferred");
	assert.equal(harness.catalogCalls.ensureRemoteSession, 0);
});

test("a head with nothing to name falls back to the file stem and never invents a title", async () => {
	const harness = titleHarness({ files: standardFiles() });
	for (const id of [EMPTY_HEAD, MALFORMED, TIMESTAMP_NAME]) {
		const result = await titleOf(harness, HOST_ID, id);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.titleOrigin, "fallback", id + " must fall back: " + JSON.stringify(result));
		assert.equal(result.title, id.replace(/\.jsonl$/, ""), id + " must answer its own file stem");
		assert.notEqual(result.title, "", id + " must never answer an empty title");
		assert.ok(!result.title.includes("{"), id + " must never leak raw JSON as a title");
		assert.ok(!/^untitled$/i.test(result.title), id + " must not invent a placeholder title");
	}
	assert.equal(harness.catalogCalls.ensureRemoteSession, 0);
});

test("the two window reads are bounded: one stat and at most two 64 KiB reads for a 10 MiB session", async () => {
	const big = "session-big.jsonl";
	const payload = Buffer.concat([Buffer.from('{"type":"session","id":"big"}\n', "utf8"), Buffer.alloc(10 * 1024 * 1024, 121)]);
	const harness = titleHarness({ files: { [big]: { bytes: payload, mtimeMs: 3 } } });
	const result = await titleOf(harness, HOST_ID, big);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.titleOrigin, "fallback", "the payload has no name line");
	assert.equal(result.title, big.replace(/\.jsonl$/, ""));
	// I1：头内没有权威名（这里一个名字都没有），所以会补一次有界尾读——pi 的 `/name` 追加在文件尾。
	assert.equal(harness.stats().length, 1, "exactly one sizing stat for both windows");
	assert.equal(harness.reads().length, 2, "one head read + one tail read, never more");
	assert.equal(harness.reads()[0].params.offset, 0, "the first read is the head");
	assert.equal(harness.reads()[0].params.bytes, MAX_HEAD, "the head read asks for the head ceiling, not the file size");
	assert.equal(harness.reads()[1].params.offset, payload.length - MAX_HEAD, "the tail read is anchored at the end of the file");
	assert.equal(harness.reads()[1].params.bytes, MAX_HEAD);
	for (const frame of harness.reads()) assert.ok(frame.params.bytes <= MAX_HEAD, "every window is bounded by the ceiling");
	const requested = harness.reads().reduce((total, frame) => total + frame.params.bytes, 0);
	assert.ok(requested <= 2 * MAX_HEAD, "requested " + requested + " bytes, which is more than two windows");
	assert.ok(requested < payload.length, "the request must not be the whole file");
});

test("a window that cuts a multi-byte character degrades to the stem instead of pretending to parse", async () => {
	const cut = "session-cut.jsonl";
	// The name line is the first line; the window ends in the middle of a multi-byte character inside a later
	// line, which decodes to U+FFFD and makes that line unparseable - the earlier name is still authoritative.
	const nameLine = Buffer.from('{"type":"session_info","name":"Cut title"}\n', "utf8");
	const broken = Buffer.from('{"type":"message","text":"', "utf8");
	const multibyte = Buffer.from("中".repeat(4), "utf8");
	const file = Buffer.concat([nameLine, broken, multibyte.subarray(0, 2)]);
	const harness = titleHarness({ files: { [cut]: { bytes: file } } });
	const result = await titleOf(harness, HOST_ID, cut);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.title, "Cut title", "a complete earlier line must still be used");
	assert.equal(result.titleOrigin, "authoritative");

	// Now only the broken tail exists: nothing parseable, so the answer is the stem, not a guess.
	const onlyBroken = Buffer.concat([Buffer.from('{"type":"session","id":"x"}\n{"type":"message","text":"', "utf8"), multibyte.subarray(0, 2)]);
	const second = titleHarness({ files: { [cut]: { bytes: onlyBroken } } });
	const degraded = await titleOf(second, HOST_ID, cut);
	assert.equal(degraded.titleOrigin, "fallback");
	assert.equal(degraded.title, "session-cut");
});

test("invalid identities and an unusable home are refused before any frame", async () => {
	const harness = titleHarness({ files: standardFiles() });
	const invalidHosts = ["", "not-a-uuid", 7, undefined, null];
	for (const hostId of invalidHosts) {
		const result = await titleOf(harness, hostId, NAMED);
		assert.equal(result.ok, false, JSON.stringify(hostId));
		assert.equal(result.code, "REMOTE_SESSION_HOST_ID_INVALID", JSON.stringify(hostId) + " answered " + result.code);
	}
	const invalidIds = ["", "/abs/a.jsonl", "ws/../a.jsonl", "ws\\a.jsonl", "ws/a\u0000.jsonl", "a.txt", ".jsonl", "ws/.jsonl", "a".repeat(257) + ".jsonl", 7, undefined];
	for (const remoteSessionId of invalidIds) {
		const result = await titleOf(harness, HOST_ID, remoteSessionId);
		assert.equal(result.ok, false, JSON.stringify(remoteSessionId));
		assert.equal(result.code, "REMOTE_SESSION_ID_INVALID", JSON.stringify(remoteSessionId) + " answered " + result.code);
	}
	assert.equal(harness.frames.length, 0, "an invalid identity must not put a frame on the wire: " + JSON.stringify(harness.frames));
	assert.equal(harness.catalogCalls.ensureRemoteSession, 0);

	for (const home of ["", "relative/home", "/home/de\u0000v", 42, undefined, "/home/" + "x".repeat(5000)]) {
		const bad = titleHarness({ files: standardFiles(), home });
		const result = await titleOf(bad, HOST_ID, NAMED);
		assert.equal(result.ok, false, JSON.stringify(home));
		assert.equal(result.code, "REMOTE_SESSION_HOME_UNAVAILABLE", JSON.stringify(home) + " answered " + result.code);
		assert.equal(bad.frames.length, 0, JSON.stringify(home) + " must not establish a session");
	}
});

test("establishment and read failures are relayed as their own stable codes", async () => {
	const unavailable = titleHarness({ files: standardFiles(), establishFails: "SSH_HOST_DISCONNECTED" });
	const relayed = await titleOf(unavailable, HOST_ID, NAMED);
	assert.equal(relayed.ok, false);
	assert.equal(relayed.code, "SSH_HOST_DISCONNECTED");

	const missing = titleHarness({ files: standardFiles() });
	const notFound = await titleOf(missing, HOST_ID, "session-gone.jsonl");
	assert.equal(notFound.ok, false);
	assert.equal(notFound.code, "PATH_NOT_FOUND", "the reader's own code must survive: " + JSON.stringify(notFound));

	// A directory masquerading as a session file is refused by the reader, not parsed as an empty head.
	const directory = titleHarness({ files: { "session-dir.jsonl": { kind: "directory", bytes: Buffer.alloc(0) } } });
	const refused = await titleOf(directory, HOST_ID, "session-dir.jsonl");
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "NOT_A_FILE");
	assert.deepEqual(directory.reads(), [], "a non-regular entry must not be read");
});

test("the title channel is not registered at all when the assembly does not provide it", () => {
	const harness = titleHarness({ files: standardFiles(), channels: { scan: "test:scan", register: "test:register" } });
	assert.equal(harness.handlers.has(TITLE_CHANNEL), false, "a missing channel name must fail closed, never bind another channel");
	assert.ok(harness.handlers.has("test:scan") && harness.handlers.has("test:register"));
});

test("the feature gate disables the title channel and still touches nothing", async () => {
	const harness = titleHarness({ files: standardFiles(), enabled: false });
	const result = await titleOf(harness, HOST_ID, NAMED);
	assert.equal(result.ok, false);
	assert.equal(result.code, "REMOTE_FEATURE_DISABLED");
	assert.equal(harness.frames.length, 0);
	assert.equal(harness.catalogCalls.factory, 0);
});

/*
 * The renderer half (H2) and the shared parser (H1) are pure modules, so they are attacked directly rather
 * than through React: the contracts that matter are that a late result cannot move a newer state object, that
 * the three list states stay apart, and that "already registered" (created=false) reaches the caller as its
 * own outcome instead of being folded into success.
 */

test("the shared title parser accepts the three name shapes and rejects a timestamp or malformed head", () => {
	const authoritative = inferSessionTitleFromHeadText('{"type":"session_info","name":"Refactor the parser"}\n');
	assert.equal(authoritative.name, "Refactor the parser");
	assert.equal(authoritative.fromSessionInfo, true);

	const legacy = inferSessionTitleFromHeadText('{"sessionName":"Old rename","ts":1750000000000}\n');
	assert.equal(legacy.name, "Old rename");

	const weak = inferSessionTitleFromHeadText('{"type":"message","message":{"role":"user","content":"Fix the failing test"}}\n');
	assert.equal(weak.name, "Fix the failing test", "the local pipeline titles a nameless session by its first user text");

	// The last authoritative record in the window wins.
	const last = inferSessionTitleFromHeadText('{"type":"session_info","name":"First"}\n{"type":"session_info","name":"Second"}\n');
	assert.equal(last.name, "Second");

	// A pi timestamp stem is not a name, "Untitled" is not a name, and a malformed/empty head yields nothing.
	assert.equal(inferSessionTitleFromHeadText('{"type":"session_info","name":"2026-02-03T10-00-00-000Z_abc"}\n').name, undefined);
	assert.equal(inferSessionTitleFromHeadText('{"type":"session_info","name":"Untitled"}\n').name, undefined);
	assert.equal(inferSessionTitleFromHeadText('not json at all\n{"type":"session"\n').name, undefined);
	assert.equal(inferSessionTitleFromHeadText("").name, undefined);
	assert.equal(inferSessionTitleFromHeadText('{"type":"session","id":"x"}\n').name, undefined, "a bare session header names nothing");
});

test("a late scan result is invalidated without touching the newer list state", () => {
	const controller = createRemoteSessionListController();
	const stale = controller.start("host-a");
	const second = controller.start("host-b");
	const scanning = controller.getState();
	assert.equal(scanning.phase, "scanning");
	assert.equal(controller.settle(stale, { kind: "ok", entries: [{ remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl", name: "a", size: 1, mtimeMs: 1 }] }), false);
	assert.equal(controller.getState(), scanning, "a superseded scan must not replace the state object");
	assert.equal(controller.getState().hostId, "host-b");

	// The current generation still lands, and the three states stay distinct.
	assert.equal(controller.settle(second, { kind: "ok", entries: [] }), true);
	assert.equal(controller.getState().phase, "empty", "a successful scan with no sessions is empty, not an error");
	const third = controller.start("host-b");
	assert.equal(controller.settle(third, { kind: "ok", entries: [{ remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl", name: "a", size: 1, mtimeMs: 1 }] }), true);
	assert.equal(controller.getState().phase, "entries");
	const fourth = controller.start("host-b");
	assert.equal(controller.settle(fourth, { kind: "failed", code: "SSH_HOST_DISCONNECTED" }), true);
	assert.equal(controller.getState().phase, "error");
	assert.equal(controller.getState().errorCode, "SSH_HOST_DISCONNECTED");
	assert.deepEqual(plain(controller.getState().entries), []);
	controller.restore(undefined);
	assert.equal(controller.getState().phase, "idle");
	// A reset invalidates an in-flight scan as well.
	const inFlight = controller.start("host-c");
	controller.reset();
	const idle = controller.getState();
	assert.equal(controller.settle(inFlight, { kind: "ok", entries: [] }), false);
	assert.equal(controller.getState(), idle);
});

test("a ceiling refusal stays a ceiling refusal and malformed scan payloads are rejected", () => {
	assert.ok(REMOTE_SESSION_LIMIT_CODES.has("REMOTE_SESSION_FILE_LIMIT_EXCEEDED"));
	assert.ok(REMOTE_SESSION_LIMIT_CODES.has("REMOTE_SESSION_DIR_LIMIT_EXCEEDED"));
	assert.ok(REMOTE_SESSION_LIMIT_CODES.has("REMOTE_SESSION_BUDGET_EXCEEDED"));
	assert.equal(REMOTE_SESSION_LIMIT_CODES.has("REMOTE_WORKSPACE_FILE_CHANGED"), false);

	const limit = createRemoteSessionListController();
	const generation = limit.start("host-a");
	assert.equal(limit.settle(generation, readScanResponse({ ok: false, code: "REMOTE_SESSION_FILE_LIMIT_EXCEEDED" })), true);
	assert.equal(limit.getState().phase, "error", "a ceiling refusal is a refusal, never a truncated list");
	assert.equal(limit.getState().errorCode, "REMOTE_SESSION_FILE_LIMIT_EXCEEDED");
	assert.deepEqual(plain(limit.getState().entries), []);

	const good = { remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl", name: "a", size: 1, mtimeMs: 1 };
	const rejected = [
		null,
		{ ok: true, entries: {} },
		{ ok: false, code: "not a code" },
		{ ok: true, entries: [{ ...good, remoteSessionId: "ws/.jsonl" }] },
		{ ok: true, entries: [{ ...good, remoteSessionId: "/abs/a.jsonl" }] },
		{ ok: true, entries: [{ ...good, name: "" }] },
		{ ok: true, entries: [{ ...good, name: "a/b" }] },
		{ ok: true, entries: [{ ...good, size: -1 }] },
		{ ok: true, entries: [good, good] },
	];
	for (const raw of rejected) assert.equal(readScanResponse(raw).kind, "rejected", JSON.stringify(raw) + " must be rejected, not shown as an empty list");
	assert.equal(readScanResponse({ ok: true, entries: [good] }).kind, "ok");
});

test("an already-registered session reaches the caller as created=false, and a mismatched echo is refused", () => {
	const created = readRegisterResponse({ ok: true, sessionId: "s1", created: true, remoteSessionId: "ws/a.jsonl" }, "ws/a.jsonl");
	assert.deepEqual(plain(created), { kind: "ok", sessionId: "s1", created: true, remoteSessionId: "ws/a.jsonl" });
	const existing = readRegisterResponse({ ok: true, sessionId: "s1", created: false, remoteSessionId: "ws/a.jsonl" }, "ws/a.jsonl");
	assert.deepEqual(plain(existing), { kind: "ok", sessionId: "s1", created: false, remoteSessionId: "ws/a.jsonl" });

	// An echo for another identity, a missing created flag and a free-text code are all unreadable.
	for (const raw of [{ ok: true, sessionId: "s1", created: false, remoteSessionId: "ws/other.jsonl" }, { ok: true, sessionId: "s1", remoteSessionId: "ws/a.jsonl" }, { ok: true, sessionId: "", created: false, remoteSessionId: "ws/a.jsonl" }, { ok: false, code: "boom /home/user" }, null]) {
		assert.equal(readRegisterResponse(raw, "ws/a.jsonl").kind, "rejected", JSON.stringify(raw) + " must be rejected");
	}
	assert.equal(readRegisterResponse({ ok: false, code: "REMOTE_SESSION_PROJECT_UNRESOLVED" }, "ws/a.jsonl").kind, "failed");
});

test("title fetching is lazy, per row and host-scoped", () => {
	const controller = createRemoteSessionTitleController();
	const first = controller.begin("host-a", "a.jsonl");
	assert.notEqual(first, null);
	assert.equal(controller.begin("host-a", "a.jsonl"), null, "a row that is already loading must not be requested twice");
	assert.equal(controller.statusOf("a.jsonl").status, "loading");

	// Each row has its own generation: settling one row must not disturb another row's in-flight request.
	const other = controller.begin("host-a", "b.jsonl");
	assert.notEqual(other, null);
	assert.equal(controller.settle(other, "host-a", "b.jsonl", { kind: "ok", title: "B", origin: "authoritative" }), true);
	assert.equal(controller.statusOf("b.jsonl").title, "B");
	assert.equal(controller.statusOf("a.jsonl").status, "loading");
	assert.equal(controller.settle(first, "host-a", "a.jsonl", { kind: "ok", title: "A", origin: "fallback" }), true);
	assert.equal(controller.statusOf("a.jsonl").origin, "fallback", "a fallback title keeps its origin so the UI can mark it provisional");
	assert.equal(controller.begin("host-a", "a.jsonl"), null, "a resolved row is cached, not re-requested");

	// Switching host drops the cache and invalidates the in-flight request of the previous host.
	const nextHost = controller.begin("host-b", "a.jsonl");
	assert.notEqual(nextHost, null, "another host re-requests even for the same relative id");
	assert.equal(controller.statusOf("b.jsonl").status, "idle", "the previous host's cache is gone");
	assert.equal(controller.settle(nextHost, "host-a", "a.jsonl", { kind: "ok", title: "stale", origin: "authoritative" }), false, "a result from the previous host must be dropped");
	assert.equal(controller.statusOf("a.jsonl").status, "loading");
	assert.equal(controller.settle(nextHost, "host-b", "a.jsonl", { kind: "ok", title: "B host", origin: "authoritative" }), true);

	controller.reset();
	assert.equal(controller.statusOf("a.jsonl").status, "idle");
});

test("title responses are narrowed, and unwired/failed states stay distinct", () => {
	// K2-3 之后 ok 分支多了一个**归一化的** tailDegraded（缺省=false）：三档 origin 的收窄语义一字未变。
	assert.deepEqual(plain(readTitleResponse({ ok: true, title: "T", titleOrigin: "authoritative" })), { kind: "ok", title: "T", origin: "authoritative", tailDegraded: false });
	assert.deepEqual(plain(readTitleResponse({ ok: true, title: "T", titleOrigin: "inferred" })), { kind: "ok", title: "T", origin: "inferred", tailDegraded: false });
	assert.deepEqual(plain(readTitleResponse({ ok: true, title: "T", titleOrigin: "fallback" })), { kind: "ok", title: "T", origin: "fallback", tailDegraded: false });
	assert.deepEqual(plain(readTitleResponse({ ok: true, title: "T", titleOrigin: "authoritative", tailDegraded: true })), { kind: "ok", title: "T", origin: "authoritative", tailDegraded: true }, "降级标记必须原样携带");
	assert.equal(readTitleResponse({ ok: true, title: "T", titleOrigin: "authoritative", tailDegraded: 1 }).kind, "rejected", "非布尔 tailDegraded 是读不懂");
	assert.deepEqual(plain(readTitleResponse({ ok: false, code: "REMOTE_SESSION_HOME_UNAVAILABLE" })), { kind: "failed", code: "REMOTE_SESSION_HOME_UNAVAILABLE" });
	// 空标题、未知档位、已废止的旧档位字面量（"parsed"）、缺档位、坏码：全都是「读不懂」，必须拒绝。
	for (const raw of [{ ok: true, title: "", titleOrigin: "authoritative" }, { ok: true, title: "T", titleOrigin: "guess" }, { ok: true, title: "T", titleOrigin: "parsed" }, { ok: true, title: "T" }, { ok: false, code: "boom" }, null]) {
		assert.equal(readTitleResponse(raw).kind, "rejected", JSON.stringify(raw) + " must be rejected");
	}

	const controller = createRemoteSessionTitleController();
	const unwired = controller.begin("host-a", "a.jsonl");
	assert.equal(controller.settle(unwired, "host-a", "a.jsonl", { kind: "unwired" }), true);
	assert.equal(controller.statusOf("a.jsonl").status, "unavailable", "an unwired channel must not look like a resolved title");
	const failed = controller.begin("host-a", "b.jsonl");
	assert.equal(controller.settle(failed, "host-a", "b.jsonl", { kind: "failed", code: "PATH_NOT_FOUND" }), true);
	assert.equal(controller.statusOf("b.jsonl").status, "failed");
	assert.equal(controller.statusOf("b.jsonl").code, "PATH_NOT_FOUND");
	// A restored snapshot must drop rows that were left "loading" by a previous mount.
	controller.restore("host-a", { "a.jsonl": { status: "ready", title: "kept", origin: "authoritative", code: null }, "b.jsonl": { status: "loading", title: null, origin: null, code: null } });
	assert.equal(controller.statusOf("a.jsonl").title, "kept");
	assert.equal(controller.statusOf("b.jsonl").status, "idle", "a stale loading row must be re-fetched, not left spinning");
});

/*
 * Scanner-level title: the layer the IPC handler delegates to. Testing it directly gives the substance of H1
 * independent of whether the assembly has wired the channel yet, and it is the same port that counts frames.
 */

test("scanner title: authoritative for a name line, inferred for a weak first message, fallback to the stem otherwise", async () => {
	const harness = titleHarness({ files: standardFiles() });
	const named = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: NAMED });
	assert.deepEqual(plain(named), { ok: true, title: "Refactor the parser", titleOrigin: "authoritative" });
	const weak = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: WEAK });
	assert.deepEqual(plain(weak), { ok: true, title: "Fix the failing test", titleOrigin: "inferred" });
	for (const id of [EMPTY_HEAD, MALFORMED, TIMESTAMP_NAME]) {
		const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: id });
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.titleOrigin, "fallback", id + " must fall back");
		assert.equal(result.title, id.replace(/\.jsonl$/, ""), id + " must answer its own stem");
	}
	assert.equal(harness.catalogCalls.ensureRemoteSession, 0, "the title path must never write the catalog");
	assert.equal(harness.catalogCalls.factory, 0);
});

test("scanner title: both window reads are bounded to one stat and at most two 64 KiB reads", async () => {
	const big = "session-big.jsonl";
	const payload = Buffer.concat([Buffer.from('{"type":"session","id":"big"}\n', "utf8"), Buffer.alloc(10 * 1024 * 1024, 121)]);
	const harness = titleHarness({ files: { [big]: { bytes: payload, mtimeMs: 3 } } });
	const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: big });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.titleOrigin, "fallback");
	assert.equal(harness.stats().length, 1, "exactly one sizing stat");
	assert.equal(harness.reads().length, 2, "one head read + one tail read");
	assert.equal(harness.reads()[0].params.bytes, MAX_HEAD, "the head read asks for the head ceiling, not the file size");
	assert.equal(harness.reads()[1].params.offset, payload.length - MAX_HEAD, "the tail read is anchored at the end");
	assert.ok(harness.reads().reduce((total, frame) => total + frame.params.bytes, 0) <= 2 * MAX_HEAD);
});

test("scanner title: identities, home and remote failures keep their own stable codes", async () => {
	const harness = titleHarness({ files: standardFiles() });
	// The scanner's own host check is shape/length only; the UUID gate belongs to the IPC boundary and is
	// asserted there. "not-a-uuid" is deliberately not in this list.
	for (const hostId of ["", 7, undefined, null]) {
		const result = await harness.scanner.title({ hostId, remoteSessionId: NAMED });
		assert.equal(result.code, "REMOTE_SESSION_HOST_ID_INVALID", JSON.stringify(hostId) + " answered " + result.code);
	}
	for (const remoteSessionId of ["", "/abs/a.jsonl", "ws/../a.jsonl", "ws\\a.jsonl", "a.txt", ".jsonl", "ws/.jsonl", "a".repeat(257) + ".jsonl", 7, undefined]) {
		const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId });
		assert.equal(result.code, "REMOTE_SESSION_ID_INVALID", JSON.stringify(remoteSessionId) + " answered " + result.code);
	}
	assert.equal(harness.frames.length, 0, "an invalid identity must not reach the wire");

	const gone = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "session-gone.jsonl" });
	assert.equal(gone.code, "PATH_NOT_FOUND", "the reader's own code must be relayed");

	for (const home of ["", "relative/home", "/home/de\u0000v", 42, undefined]) {
		const bad = titleHarness({ files: standardFiles(), home });
		const result = await bad.scanner.title({ hostId: HOST_ID, remoteSessionId: NAMED });
		assert.equal(result.code, "REMOTE_SESSION_HOME_UNAVAILABLE", JSON.stringify(home) + " answered " + result.code);
		assert.equal(bad.frames.length, 0);
	}
	const disconnected = titleHarness({ files: standardFiles(), establishFails: "SSH_HOST_DISCONNECTED" });
	const relayed = await disconnected.scanner.title({ hostId: HOST_ID, remoteSessionId: NAMED });
	assert.equal(relayed.code, "SSH_HOST_DISCONNECTED");
});

/*
 * Rendering-branch contract guard (H2). This repository has no DOM test harness, so - following
 * tests/settingsTabLayout.test.mjs - the branches are pinned at the source level: deleting the ceiling
 * branch, flipping the tentative condition or unmounting the section has to turn this red, because those are
 * exactly the regressions the state-level assertions above cannot see.
 */

const SECTIONS_SOURCE = "src/renderer/src/components/sidebar/RemoteSessionsSection.tsx";
const TITLE_STATE_SOURCE = "src/renderer/src/components/session/remoteSessionTitleState.ts";
const TITLE_STATE_SOURCE_TEXT = readFileSync(TITLE_STATE_SOURCE, "utf8");
const PROJECT_TREE_SOURCE = "src/renderer/src/components/sidebar/ProjectTree.tsx";
const ZH_COPY = "src/renderer/src/i18n/rendererCopy.zh-CN.ts";
const EN_COPY = "src/renderer/src/i18n/rendererCopy.en-US.ts";

test("the sidebar section keeps its ceiling branch and its tentative branch", () => {
	const source = readFileSync(SECTIONS_SOURCE, "utf8");

	// A ceiling refusal must take the "over the ceiling" copy, not the generic scan-failed copy, and it must
	// be decided before the fallback (a later branch would be dead code).
	const limitIndex = source.indexOf("REMOTE_SESSION_LIMIT_CODES.has(code)");
	assert.ok(limitIndex >= 0, "the ceiling branch must consult REMOTE_SESSION_LIMIT_CODES");
	assert.match(source.slice(limitIndex - 40, limitIndex + 160), /REMOTE_SESSION_LIMIT_CODES\.has\(code\)\s*\)\s*return\s+t\(\s*"sidebar\.remoteSessions\.limitExceeded"\s*\)/, "the ceiling branch must return the limitExceeded copy");
	const fallbackIndex = source.indexOf("sidebar.remoteSessions.scanFailed");
	assert.ok(fallbackIndex > limitIndex, "the generic failure copy must stay the fallback, after the ceiling branch");

	// Only an authoritative name may drop the provisional marker: inferred (first-message weak title) and
	// fallback (stem), plus unwired/loading/failed, are all provisional. The rule itself lives in the origin
	// vocabulary module, so this pins both the call site and the rule it calls.
	assert.match(source, /const tentative = isProvisionalTitleOrigin\(title\.origin\);/, "the tentative marker must be driven by titleOrigin");
	assert.match(TITLE_STATE_SOURCE_TEXT, /isProvisionalTitleOrigin\(origin: RemoteSessionTitleOrigin \| null\): boolean \{[\s\S]{0,240}?return origin !== "authoritative";/, "the provisional rule must be exactly 'not authoritative'");
	assert.match(source, /\{tentative \?[\s\S]{0,200}?sidebar\.remoteSessions\.tentative"/, "the tentative badge must render only in that branch");
	assert.match(source, /title\.title \?\? entry\.name/, "the placeholder must come from the scanned stem");

	// The three failure shapes stay apart: unwired and limit are distinct copies.
	assert.match(source, /code === REMOTE_SESSION_UNWIRED_CODE\)\s*return\s+t\(\s*"sidebar\.remoteSessions\.unwired"\s*\)/);
});

test("the sidebar section is mounted by the project tree, and both dictionaries carry its keys", () => {
	const tree = readFileSync(PROJECT_TREE_SOURCE, "utf8");
	assert.ok(tree.includes('import { RemoteSessionsSection } from "./RemoteSessionsSection"'), "the section must be imported by the tree that renders it");
	assert.match(tree, /<RemoteSessionsSection\s+hostId=/, "the section must be mounted with the host it belongs to");
	assert.ok(tree.includes("collectRegisteredRemoteSessionIds("), "the imported marker must come from the local catalog identities");

	const source = readFileSync(SECTIONS_SOURCE, "utf8");
	const keys = Array.from(new Set(Array.from(source.matchAll(/t\(\s*"(sidebar\.remoteSessions\.[A-Za-z0-9_]+)"/g)).map((match) => match[1])));
	assert.ok(keys.length >= 10, "the section should use the remote-session copy keys, found " + keys.length);
	const zh = readFileSync(ZH_COPY, "utf8");
	const en = readFileSync(EN_COPY, "utf8");
	for (const key of keys) {
		assert.ok(zh.includes('"' + key + '":'), "zh-CN is missing " + key);
		assert.ok(en.includes('"' + key + '":'), "en-US is missing " + key);
	}
});
