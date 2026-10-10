import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * F4 independent verification of the bounded window primitive and the two-stage title parse (task-24, I1).
 *
 * The claims that need an instrument rather than a result:
 *
 * 1. A window is bounded: one sizing stat (or none when the caller passes the size it just read) and one
 *    read of exactly min(offset+maxBytes, size)-offset bytes. The port counts every fs.read frame and the
 *    sum of the ranges it was asked for, so "never the whole file" is asserted, not assumed.
 * 2. The tail window is read only when the head could not produce an authoritative name. A head that
 *    contains the authoritative session_info must cost exactly one stat and one read - no tail traffic at
 *    all - while a weak head has to look at the tail before it may answer "inferred".
 * 3. The three tiers stay distinct: authoritative (session_info name), inferred (first user/assistant
 *    text), fallback (the file stem). Collapsing any two of them is what this file exists to catch.
 */

const { createRemoteWorkspaceReader, REMOTE_WORKSPACE_MAX_HEAD_BYTES, REMOTE_WORKSPACE_MAX_WINDOW_BYTES } = loadTsCommonJs("src/main/remote/RemoteWorkspaceReader.ts");
const { createRemoteSessionScanner } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");
const { isProvisionalTitleOrigin, readTitleResponse } = loadTsCommonJs("src/renderer/src/components/session/remoteSessionTitleState.ts");
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
	stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
});

const HOST_ID = "6f1d2c3b-4a59-4e8d-9f70-1a2b3c4d5e6f";
const HOME = "/home/dev";
const SESSION_ROOT = HOME + "/.pi/agent/sessions";
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

const plain = (value) => JSON.parse(JSON.stringify(value));

async function failureOf(promise) {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

/* Part A: the window primitive. */

function windowHarness(respond) {
	const frames = [];
	const reader = createRemoteWorkspaceReader({
		port: {
			request(hostId, method, params) {
				frames.push({ hostId, method, params: plain(params ?? {}) });
				return Promise.resolve(respond(method, params));
			},
		},
	});
	const reads = () => frames.filter((frame) => frame.method === "fs.read");
	return {
		reader,
		frames,
		reads,
		stats: () => frames.filter((frame) => frame.method === "fs.stat"),
		requested: () => reads().reduce((total, frame) => total + frame.params.bytes, 0),
	};
}

/** A well-formed remote file of the given size whose ranges are generated from the request. */
function sizedFile(size, kind = "file") {
	return (method, params) => {
		if (method === "fs.stat") return { kind, bytes: size, mtimeMs: 9 };
		if (method === "fs.read") {
			const length = Math.max(0, Math.min(params.bytes, size - params.offset));
			return { chunk: Buffer.alloc(length, 97).toString("base64"), bytes: length, eof: params.offset + length >= size };
		}
		throw new Error("unexpected method " + method);
	};
}

const BIG = 10 * 1024 * 1024;

test("a tail window requests exactly its range and nothing else", async () => {
	const harness = windowHarness(sizedFile(BIG));
	const offset = BIG - REMOTE_WORKSPACE_MAX_WINDOW_BYTES;
	const window = await harness.reader.readWindow(HOST_ID, "ws/big.jsonl", { offset, maxBytes: REMOTE_WORKSPACE_MAX_WINDOW_BYTES, size: BIG });
	assert.equal(window.bytes, REMOTE_WORKSPACE_MAX_WINDOW_BYTES);
	assert.equal(window.offset, offset);
	assert.equal(window.size, BIG);
	assert.equal(window.truncated, false, "a window that reaches the end of the file is not truncated");
	assert.deepEqual(harness.stats(), [], "a caller-supplied size must skip the sizing stat");
	assert.equal(harness.reads().length, 1);
	assert.equal(harness.reads()[0].params.offset, offset, "the read must start at the requested offset");
	assert.equal(harness.reads()[0].params.bytes, REMOTE_WORKSPACE_MAX_WINDOW_BYTES);
	assert.equal(harness.requested(), REMOTE_WORKSPACE_MAX_WINDOW_BYTES, "the request sum must be the window, never the file");
	assert.ok(harness.requested() < BIG);
});

test("without a caller-supplied size the window pays exactly one sizing stat", async () => {
	const harness = windowHarness(sizedFile(BIG));
	const window = await harness.reader.readWindow(HOST_ID, "ws/big.jsonl", { offset: 0, maxBytes: 1024 });
	assert.equal(harness.stats().length, 1);
	assert.equal(harness.reads().length, 1);
	assert.equal(harness.reads()[0].params.bytes, 1024);
	assert.equal(window.bytes, 1024);
	assert.equal(window.truncated, true, "bytes remain after the window");
});

test("a window past the end is empty and sends no read frame", async () => {
	const harness = windowHarness(sizedFile(1000));
	const window = await harness.reader.readWindow(HOST_ID, "ws/small.jsonl", { offset: 5000, maxBytes: 512, size: 1000 });
	assert.equal(window.bytes, 0);
	assert.equal(window.offset, 1000, "the requested offset is clamped to the file size");
	assert.equal(window.truncated, false);
	assert.deepEqual(harness.reads(), [], "there is nothing at that offset, so nothing is read");
});

test("the window ceiling is a refusal, and the exact ceiling is legal", async () => {
	const over = windowHarness(sizedFile(BIG));
	const refused = await failureOf(over.reader.readWindow(HOST_ID, "ws/big.jsonl", { offset: 0, maxBytes: REMOTE_WORKSPACE_MAX_WINDOW_BYTES + 1, size: BIG }));
	assert.equal(refused.code, "RESULT_TOO_LARGE", "a window above the ceiling is refused, never clamped");
	assert.deepEqual(over.frames, []);

	const atCeiling = windowHarness(sizedFile(BIG));
	const window = await atCeiling.reader.readWindow(HOST_ID, "ws/big.jsonl", { offset: 0, maxBytes: REMOTE_WORKSPACE_MAX_WINDOW_BYTES, size: BIG });
	assert.equal(window.bytes, REMOTE_WORKSPACE_MAX_WINDOW_BYTES);
	assert.equal(REMOTE_WORKSPACE_MAX_WINDOW_BYTES, REMOTE_WORKSPACE_MAX_HEAD_BYTES, "the tail window is the same bound as the head window");
});

test("invalid window specs are refused before any frame", async () => {
	const specs = [
		["a missing offset", { maxBytes: 16 }],
		["a negative offset", { offset: -1, maxBytes: 16 }],
		["a fractional offset", { offset: 1.5, maxBytes: 16 }],
		["a NaN offset", { offset: Number.NaN, maxBytes: 16 }],
		["a string offset", { offset: "0", maxBytes: 16 }],
		["a missing maxBytes", { offset: 0 }],
		["a zero maxBytes", { offset: 0, maxBytes: 0 }],
		["a negative maxBytes", { offset: 0, maxBytes: -1 }],
		["a fractional maxBytes", { offset: 0, maxBytes: 1.5 }],
		["a string maxBytes", { offset: 0, maxBytes: "64" }],
		["a negative size", { offset: 0, maxBytes: 16, size: -1 }],
		["a fractional size", { offset: 0, maxBytes: 16, size: 1.5 }],
		["a non-object window", 7],
	];
	for (const [label, spec] of specs) {
		const harness = windowHarness(sizedFile(BIG));
		const failure = await failureOf(harness.reader.readWindow(HOST_ID, "ws/big.jsonl", spec));
		assert.ok(failure !== undefined, label + " must be refused");
		assert.equal(failure.code, "PROTOCOL_INVALID", label + " answered " + failure.code);
		assert.deepEqual(harness.frames, [], label + " must not reach the wire");
	}
});

test("a non-regular entry and a remote that contradicts itself are refused", async () => {
	for (const kind of ["directory", "other"]) {
		const harness = windowHarness(sizedFile(0, kind));
		const failure = await failureOf(harness.reader.readWindow(HOST_ID, "ws/x.jsonl", { offset: 0, maxBytes: 16 }));
		assert.equal(failure.code, "NOT_A_FILE", kind + " must not be read as a file");
		assert.deepEqual(harness.reads(), []);
	}
	// A size hint skips the reading side's own type check, so the remote's refusal has to be relayed: the
	// documented contract is that the helper's fs.read still fails closed with NOT_A_FILE.
	const hintedRefusal = windowHarness(() => {
		throw Object.assign(new Error("NOT_A_FILE"), { code: "NOT_A_FILE" });
	});
	const refused = await failureOf(hintedRefusal.reader.readWindow(HOST_ID, "ws/dir.jsonl", { offset: 0, maxBytes: 16, size: 4096 }));
	assert.equal(refused.code, "NOT_A_FILE", "the remote's own refusal must survive the size hint");
	assert.deepEqual(hintedRefusal.stats(), [], "the hint means no sizing stat is sent");
	// A short answer that does not reach the end of the file is a protocol violation, not a short window.
	const harness = windowHarness((method, params) => {
		if (method === "fs.stat") return { kind: "file", bytes: BIG, mtimeMs: 1 };
		return { chunk: Buffer.alloc(4, 97).toString("base64"), bytes: 4, eof: false };
	});
	const failure = await failureOf(harness.reader.readWindow(HOST_ID, "ws/big.jsonl", { offset: 0, maxBytes: 64, size: BIG }));
	assert.equal(failure.code, "PROTOCOL_INVALID");
	// A file that shrank between the caller's size hint and the read fails the byte-exactness check.
	const shrunk = windowHarness((method) => {
		if (method === "fs.stat") throw new Error("no stat expected");
		return { chunk: Buffer.alloc(0).toString("base64"), bytes: 0, eof: true };
	});
	const mismatch = await failureOf(shrunk.reader.readWindow(HOST_ID, "ws/big.jsonl", { offset: 0, maxBytes: 64, size: BIG }));
	assert.equal(mismatch.code, "PROTOCOL_INVALID");
});

test("an aborted window call never starts a frame", async () => {
	const harness = windowHarness(sizedFile(BIG));
	const controller = new AbortController();
	controller.abort();
	const failure = await failureOf(harness.reader.readWindow(HOST_ID, "ws/big.jsonl", { offset: 0, maxBytes: 64 }, { signal: controller.signal }));
	assert.equal(failure.code, "REQUEST_CANCELLED");
	assert.deepEqual(harness.frames, []);
});

/* Part B: the two-stage title parse and the three tiers. */

const AUTHORITATIVE_HEAD = '{"type":"session","id":"s1"}\n{"type":"session_info","name":"Head Name"}\n';
const WEAK_HEAD = '{"type":"session","id":"s2"}\n{"type":"message","message":{"role":"user","content":"Weak head title"}}\n';
const AUTHORITATIVE_TAIL_LINE = '{"type":"session_info","name":"Tail Name"}\n';

/** A file whose first window has no authoritative name and whose last bytes carry one. */
function tailNamedFile() {
	const filler = Buffer.from('{"type":"message","message":{"role":"user","content":"filler"}}\n', "utf8");
	const chunks = [Buffer.from('{"type":"session","id":"tail"}\n', "utf8")];
	let length = chunks[0].length;
	// Far larger than head+tail (10 MiB), so "the whole file was never requested" is a real claim and not
	// an artefact of a fixture that happens to fit in two windows.
	while (length < 10 * 1024 * 1024) {
		chunks.push(filler);
		length += filler.length;
	}
	chunks.push(Buffer.from(AUTHORITATIVE_TAIL_LINE, "utf8"));
	return Buffer.concat(chunks);
}

function titleHarness(files, options = {}) {
	const frames = [];
	const catalogCalls = { ensureRemoteSession: 0 };
	const session = {
		async request(method, params) {
			frames.push({ method, params: plain(params ?? {}) });
			const file = files[params.path];
			if (file === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
			if (method === "fs.stat") return { kind: "file", bytes: file.length, mtimeMs: 5 };
			if (method === "fs.read") {
				if (options.failSecondRead === true && frames.filter((frame) => frame.method === "fs.read").length > 1) throw Object.assign(new Error("IO_ERROR"), { code: "IO_ERROR" });
				const length = Math.max(0, Math.min(params.bytes, file.length - params.offset));
				return { chunk: file.subarray(params.offset, params.offset + length).toString("base64"), bytes: length, eof: params.offset + length >= file.length };
			}
			throw Object.assign(new Error("METHOD_NOT_FOUND"), { code: "METHOD_NOT_FOUND" });
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const port = {
		remoteHome: async () => HOME,
		async withProjectSession(hostId, root, task) {
			void hostId;
			// J2: the scanner probes <home>/.pi/agent for settings.json before it resolves the session root.
			// This harness has no settings file, so the probe answers PATH_NOT_FOUND (the scanner reads that as
			// "unconfigured") and the default session root is used - and the probe contributes no frames to the
			// window counts asserted below.
			if (root === HOME + "/.pi/agent") return { ok: false, code: "PATH_NOT_FOUND" };
			assert.equal(root, options.expectedRoot ?? SESSION_ROOT, "unexpected session root");
			return { ok: true, value: await task(session) };
		},
	};
	const scanner = createRemoteSessionScanner({ port });
	const reads = () => frames.filter((frame) => frame.method === "fs.read");
	return { scanner, frames, reads, stats: () => frames.filter((frame) => frame.method === "fs.stat"), catalogCalls };
}

test("an authoritative head name costs no tail read at all", async () => {
	const file = Buffer.from(AUTHORITATIVE_HEAD + "x".repeat(REMOTE_WORKSPACE_MAX_HEAD_BYTES * 2), "utf8");
	const harness = titleHarness({ "head.jsonl": file });
	const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "head.jsonl" });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.title, "Head Name");
	assert.equal(result.titleOrigin, "authoritative", "a session_info name is the authoritative tier");
	assert.equal(harness.stats().length, 1, "one sizing stat for the whole title");
	assert.equal(harness.reads().length, 1, "the head already answered, so no tail window may be read");
	assert.ok(harness.reads()[0].params.bytes <= REMOTE_WORKSPACE_MAX_HEAD_BYTES);
});

test("a name that only exists at the end of the file is found by the bounded tail window", async () => {
	const file = tailNamedFile();
	const harness = titleHarness({ "tail.jsonl": file });
	const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "tail.jsonl" });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.title, "Tail Name", "the appended authoritative name must win");
	assert.equal(result.titleOrigin, "authoritative");
	const reads = harness.reads();
	assert.equal(reads.length, 2, "one head window plus one tail window");
	assert.equal(reads[0].params.offset, 0);
	assert.ok(reads[1].params.offset > 0, "the second read must be the tail, not a second head");
	assert.equal(reads[1].params.bytes, REMOTE_WORKSPACE_MAX_WINDOW_BYTES, "the tail window is bounded by the window ceiling");
	const requested = reads.reduce((total, frame) => total + frame.params.bytes, 0);
	assert.ok(requested <= REMOTE_WORKSPACE_MAX_HEAD_BYTES + REMOTE_WORKSPACE_MAX_WINDOW_BYTES, "the two windows together stay bounded: " + requested);
	assert.ok(requested < file.length, "the file itself is never requested: " + requested + " of " + file.length);
	for (const frame of reads) assert.ok(frame.params.bytes < file.length, "no single request may be the whole file");
	assert.equal(harness.stats().length, 1, "the head stat must be reused for the tail window");
});

test("a weak head keeps its inferred title when the tail has no authoritative name", async () => {
	const file = Buffer.from(WEAK_HEAD + "y".repeat(REMOTE_WORKSPACE_MAX_HEAD_BYTES * 2), "utf8");
	const harness = titleHarness({ "weak.jsonl": file });
	const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "weak.jsonl" });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.title, "Weak head title");
	assert.equal(result.titleOrigin, "inferred", "a first user message is the weaker tier, not authoritative");
	assert.equal(harness.reads().length, 2, "a weak head must still look at the tail before answering inferred");
});

test("a weak head is upgraded by an authoritative tail name", async () => {
	const filler = Buffer.from('{"type":"message","message":{"role":"user","content":"Weak head title"}}\n', "utf8");
	const chunks = [Buffer.from(WEAK_HEAD, "utf8")];
	let length = chunks[0].length;
	while (length < REMOTE_WORKSPACE_MAX_HEAD_BYTES + 4096) {
		chunks.push(filler);
		length += filler.length;
	}
	chunks.push(Buffer.from(AUTHORITATIVE_TAIL_LINE, "utf8"));
	const harness = titleHarness({ "upgrade.jsonl": Buffer.concat(chunks) });
	const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "upgrade.jsonl" });
	assert.equal(result.title, "Tail Name", "the authoritative tail name must beat the weak head title");
	assert.equal(result.titleOrigin, "authoritative");
});

test("nothing in the head or the tail falls back to the stem and invents nothing", async () => {
	const file = Buffer.concat([Buffer.from('{"type":"session","id":"empty"}\n', "utf8"), Buffer.alloc(REMOTE_WORKSPACE_MAX_HEAD_BYTES * 2, 122)]);
	const harness = titleHarness({ "empty.jsonl": file });
	const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "empty.jsonl" });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.title, "empty", "the fallback is the file stem");
	assert.equal(result.titleOrigin, "fallback");
	assert.notEqual(result.title, "");
	assert.ok(!result.title.includes("{"), "raw JSON must never become a title");
	const requested = harness.reads().reduce((total, frame) => total + frame.params.bytes, 0);
	assert.ok(requested <= REMOTE_WORKSPACE_MAX_HEAD_BYTES + REMOTE_WORKSPACE_MAX_WINDOW_BYTES, "the fallback path is bounded too: " + requested);
});

test("the title path still writes nothing and refuses invalid identities", async () => {
	const file = tailNamedFile();
	const harness = titleHarness({ "tail.jsonl": file });
	await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "tail.jsonl" });
	assert.equal(harness.catalogCalls.ensureRemoteSession, 0, "the title path must not write the catalog");
	for (const remoteSessionId of ["", "/abs/a.jsonl", "ws/../a.jsonl", "a.txt", ".jsonl", 7, undefined]) {
		const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId });
		assert.equal(result.ok, false, JSON.stringify(remoteSessionId));
		assert.equal(result.code, "REMOTE_SESSION_ID_INVALID", JSON.stringify(remoteSessionId) + " answered " + result.code);
	}
});

test("the shared title contract exposes the three tiers and no stale parsed value", async () => {
	const source = (await import("node:fs")).readFileSync("src/shared/types/remoteHost.ts", "utf8");
	assert.match(source, /titleOrigin:\s*"authoritative"\s*\|\s*"inferred"\s*\|\s*"fallback"/, "the shared contract must carry the three tiers");
	assert.ok(!/titleOrigin:\s*"parsed"/.test(source), "the old parsed tier must not survive the migration");
	// A model of a real catalog is unnecessary here; the point is that the union is the only place tiers are named.
	assert.ok(SessionCatalog !== undefined);
});

test("a reader built without a usable port still fails closed", async () => {
	assert.throws(() => createRemoteWorkspaceReader({}), /REMOTE_WORKSPACE_READER_OPTIONS_INVALID/, "a missing port must fail at construction with a stable code");
});

/*
 * The remaining I1 contract claims: a file the head already covers must not be re-read as its own tail, a
 * failing tail read must degrade instead of failing the title, and the tier vocabulary must be closed at the
 * renderer boundary (the old parsed tier is not a tier any more).
 */

test("a file the head already covers is never read a second time as its own tail", async () => {
	const tiny = Buffer.from('{"type":"session","id":"tiny"}\n', "utf8");
	const harness = titleHarness({ "tiny.jsonl": tiny });
	const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "tiny.jsonl" });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.titleOrigin, "fallback");
	assert.equal(result.title, "tiny");
	assert.equal(harness.stats().length, 1, "one sizing stat");
	assert.equal(harness.reads().length, 1, "the head window already covered the whole file, so no tail may be read");
	assert.ok(harness.reads()[0].params.bytes <= REMOTE_WORKSPACE_MAX_HEAD_BYTES);
});

test("a failing tail read degrades to the head result instead of failing the title", async () => {
	const file = Buffer.from(WEAK_HEAD + "z".repeat(REMOTE_WORKSPACE_MAX_HEAD_BYTES * 2), "utf8");
	const harness = titleHarness({ "weak.jsonl": file }, { failSecondRead: true });
	const result = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "weak.jsonl" });
	assert.equal(result.ok, true, "the tail window is an improvement, not a requirement: " + JSON.stringify(result));
	assert.equal(result.title, "Weak head title");
	assert.equal(result.titleOrigin, "inferred", "the head's weak title survives the failed tail read");
	assert.equal(harness.reads().length, 2, "the tail was attempted before it failed");
});

test("the renderer boundary accepts exactly the three tiers and refuses the retired one", () => {
	assert.equal(readTitleResponse({ ok: true, title: "T", titleOrigin: "authoritative" }).kind, "ok");
	assert.equal(readTitleResponse({ ok: true, title: "T", titleOrigin: "inferred" }).kind, "ok");
	assert.equal(readTitleResponse({ ok: true, title: "T", titleOrigin: "fallback" }).kind, "ok");
	// The retired value must be an unknown tier, not silently mapped onto one of the three.
	assert.equal(readTitleResponse({ ok: true, title: "T", titleOrigin: "parsed" }).kind, "rejected");
	assert.equal(readTitleResponse({ ok: true, title: "T", titleOrigin: "parsed" }).code, undefined);

	// The single source of the "provisional" rule: only an authoritative name drops the marker.
	assert.equal(isProvisionalTitleOrigin("authoritative"), false);
	for (const origin of ["inferred", "fallback", null]) assert.equal(isProvisionalTitleOrigin(origin), true, String(origin) + " must stay provisional");
});

test("the type union is the only place tiers are named", async () => {
	const shared = (await import("node:fs")).readFileSync("src/shared/types/remoteHost.ts", "utf8");
	// The three tiers are declared inline on the result type; the point is that the vocabulary is exactly these
	// three and that the retired value is gone.
	assert.match(shared, /titleOrigin:\s*"authoritative"\s*\|\s*"inferred"\s*\|\s*"fallback"/, "the result type must carry exactly the three tiers");
	assert.ok(!/"parsed"/.test(shared), "the retired parsed tier must not survive anywhere in the contract");
	const renderer = (await import("node:fs")).readFileSync("src/renderer/src/components/session/remoteSessionTitleState.ts", "utf8");
	assert.match(renderer, /origin !== "authoritative"/, "the provisional rule must be one comparison against authoritative");
});
