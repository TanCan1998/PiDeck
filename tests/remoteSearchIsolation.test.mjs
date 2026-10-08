import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * F4 independent verification of remote name search (task-10): the frozen helper op (F1) and the
 * main-process reader plus the renderer state machine (F2).
 *
 * Deliberately adversarial and independent of the producers' own suites. Three things are proven here
 * that a happy-path test cannot prove about itself:
 *
 * 1. Escape: the frozen helper refuses every lexical escape and follows no symlink, including when the
 *    requested path itself is one.
 * 2. Bounds: hitting a cap (matches / scanned entries / depth) has to stop the traversal *immediately*.
 *    "truncated: true" alone is not evidence, so the helper runs behind a counting substitute: a module
 *    that patches process.getBuiltinModule before importing the frozen body and counts every directory
 *    open, every dirent read and every readdir entry. The assertions are on those *call counts*, not on
 *    the reported result. The seam is the helper's own documented access point (it loads its builtins
 *    through process.getBuiltinModule), so nothing in src/** is modified for it.
 * 3. Cancellation: a cancel landing while a search is in flight settles that id exactly once with
 *    REQUEST_CANCELLED, no later frame follows, and the traversal stops at the next boundary.
 *
 * The reader half drives createRemoteSearchReader with a scripted port, so every refusal is asserted
 * from the public API and "truncated" is shown to be passed through rather than re-derived.
 */

const CONTRACT_SOURCE = "src/main/remote/RemoteHelperContract.ts";
const contract = loadTsCommonJs(CONTRACT_SOURCE);
const entryModule = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const uploadModule = loadTsCommonJs("src/main/remote/RemoteBootstrapUpload.ts");
const bootstrapContract = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");
const readerModule = loadTsCommonJs("src/main/remote/RemoteSearchReader.ts");
const stateModule = loadTsCommonJs("src/renderer/src/components/session/remoteProjectSearchState.ts");

const { REMOTE_HELPER_CAPABILITIES, REMOTE_HELPER_ERROR_CODES, REMOTE_HELPER_MAX_SEARCH_DEPTH, REMOTE_HELPER_MAX_SEARCH_MATCHES, REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH, REMOTE_HELPER_MAX_SEARCH_SCANNED, REMOTE_HELPER_METHOD_FS_SEARCH_NAMES } = contract;
const { REMOTE_HELPER_ENTRY_SHA256, REMOTE_HELPER_ENTRY_VERSION, REMOTE_HELPER_INLINE_SOURCE } = entryModule;

/** The frozen values, stated independently here so a drift on either side fails loudly. */
const MAX_MATCHES = 512;
const MAX_SCANNED = 20000;
const MAX_DEPTH = 12;
const MAX_QUERY = 128;
const METHOD = "fs.searchNames";

const HOST_ID = "6f1d2c3b-4a59-4e8d-9f70-1a2b3c4d5e6f";
/** The helper rejects a HOME that is not an absolute POSIX path; this one is honest on every platform. */
const HELPER_HOME = "/home/pideck-verify";
const REQUEST_TIMEOUT_MS = 30000;
const GUARD_TIMEOUT_MS = 20000;

const sha256Of = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/** Production modules live in another VM realm, so deep comparisons are normalised through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

async function waitUntil(predicate, label, timeoutMs = GUARD_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const BASE = mkdtempSync(join(tmpdir(), "pideck-search-iso-"));
const COUNTS_DIR = join(BASE, "counts");
const ENTRY_PATH = join(BASE, "helper.mjs");
const RUNNER_PATH = join(BASE, "counting-runner.mjs");
mkdirSync(COUNTS_DIR, { recursive: true });
writeFileSync(ENTRY_PATH, REMOTE_HELPER_INLINE_SOURCE, "utf8");

/**
 * The counting seam: wrap the one documented builtin access point, import the frozen body afterwards and
 * report counters through a file on exit (stdout is the protocol stream and must stay clean).
 */
const RUNNER_SOURCE =
	'import { appendFileSync } from "node:fs";\n' +
	"const counts = { realpathSync: 0, statSync: 0, lstatSync: 0, opendirSync: 0, direntReads: 0, readdirSync: 0, readdirEntries: 0, openSync: 0, readSync: 0 };\n" +
	"const realGet = process.getBuiltinModule.bind(process);\n" +
	'const realFs = realGet("node:fs");\n' +
	'const wrapFn = (name) => { const fn = realFs[name]; if (typeof fn !== "function") return fn; return function (...args) { counts[name] = (counts[name] ?? 0) + 1; return fn.apply(realFs, args); }; };\n' +
	"const fsProxy = Object.create(realFs);\n" +
	'for (const name of ["realpathSync", "statSync", "lstatSync", "openSync", "readSync", "closeSync", "fstatSync"]) fsProxy[name] = wrapFn(name);\n' +
	"fsProxy.readdirSync = function (...args) { counts.readdirSync += 1; const result = realFs.readdirSync.apply(realFs, args); counts.readdirEntries += result.length; return result; };\n" +
	"fsProxy.opendirSync = function (...args) { counts.opendirSync += 1; const dir = realFs.opendirSync.apply(realFs, args); return { readSync() { counts.direntReads += 1; return dir.readSync(); }, closeSync() { return dir.closeSync(); }, [Symbol.iterator]() { return dir[Symbol.iterator](); } }; };\n" +
	'process.getBuiltinModule = (name) => (name === "node:fs" ? fsProxy : realGet(name));\n' +
	'process.on("exit", () => { try { appendFileSync(process.env.PIDECK_HELPER_COUNTS, JSON.stringify(counts)); } catch {} });\n' +
	"await import(" +
	JSON.stringify(pathToFileURL(ENTRY_PATH).href) +
	");\n";
writeFileSync(RUNNER_PATH, RUNNER_SOURCE, "utf8");

const OUTSIDE_DIR = join(BASE, "outside");
const ROOT = join(BASE, "root");
const MANY_DIR = join(BASE, "many");
mkdirSync(OUTSIDE_DIR, { recursive: true });
mkdirSync(join(ROOT, "sub"), { recursive: true });
mkdirSync(MANY_DIR, { recursive: true });
writeFileSync(join(OUTSIDE_DIR, "secret-match.txt"), "outside secret\n");
writeFileSync(join(ROOT, "match-here.txt"), "root file\n");
writeFileSync(join(ROOT, "sub", "inner-match.txt"), "inner file\n");
// Windows cannot infer a link type, so both shapes are spelled out; a junction needs no privilege.
symlinkSync(OUTSIDE_DIR, join(ROOT, "out-dir"), process.platform === "win32" ? "junction" : "dir");
symlinkSync(join(OUTSIDE_DIR, "secret-match.txt"), join(ROOT, "out-file"), process.platform === "win32" ? "file" : undefined);
symlinkSync(join(ROOT, "sub"), join(ROOT, "link-to-sub"), process.platform === "win32" ? "junction" : "dir");

/** A depth chain: dirs d1..d16, each holding one matching file at its own depth. */
const DEEP_ROOT = join(BASE, "deep");
mkdirSync(DEEP_ROOT, { recursive: true });
{
	let current = DEEP_ROOT;
	for (let depth = 1; depth <= 16; depth += 1) {
		current = join(current, "d" + depth);
		mkdirSync(current);
		writeFileSync(join(current, "at-" + depth + "-match.txt"), "depth " + depth + "\n");
	}
}

/**
 * One directory far wider than the scanned-entry cap; every name contains "txt", so one query matches
 * everything and another matches nothing. Deliberately much larger than the cap: an implementation that
 * kept walking after a cap would read all of it, which is what makes the counter assertions below bite.
 * `z-more/` sorts after every `m*.txt`, so a traversal that stops at the match cap never reaches it.
 */
const WIDE_COUNT = MAX_SCANNED + 5000;
for (let index = 0; index < WIDE_COUNT; index += 1) {
	writeFileSync(join(MANY_DIR, "m" + String(index).padStart(6, "0") + ".txt"), "");
}
mkdirSync(join(MANY_DIR, "z-more"));
writeFileSync(join(MANY_DIR, "z-more", "zz-extra.txt"), "beyond the cap\n");

after(() => rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

let countsSequence = 0;

/**
 * One real helper child process behind the counting runner, spoken to with raw NDJSON frames.
 *
 * Raw frames on purpose: the ops under test are adversarial (an invalid frame, a cancel racing a
 * request), so the exact bytes on the wire are the test's own rather than a client's opinion.
 */
function startHelper(options = {}) {
	const countsFile = join(COUNTS_DIR, "counts-" + String((countsSequence += 1)).padStart(4, "0") + ".json");
	const args = [RUNNER_PATH, ...(options.root === undefined ? [] : ["--root", options.root])];
	const child = spawn(process.execPath, args, { env: { ...process.env, HOME: HELPER_HOME, PIDECK_HELPER_COUNTS: countsFile }, stdio: ["pipe", "pipe", "pipe"] });
	const frames = [];
	const lines = [];
	let buffered = "";
	let stderr = "";
	let exitCode = null;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdin.on("error", () => {});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		let index = buffered.indexOf("\n");
		while (index >= 0) {
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			lines.push(line);
			try {
				frames.push(JSON.parse(line));
			} catch {
				frames.push({ malformed: line });
			}
			index = buffered.indexOf("\n");
		}
	});
	const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
	exited.then((code) => {
		exitCode = code;
	});
	let requestSequence = 0;
	const nextId = () => "req-" + String((requestSequence += 1));

	function frameOf(method, params, id) {
		return { v: 1, hostId: HOST_ID, generation: 1, id, method, ...(params === undefined ? {} : { params }) };
	}

	function send(method, params, id) {
		const requestId = id ?? nextId();
		child.stdin.write(JSON.stringify(frameOf(method, params, requestId)) + "\n");
		return requestId;
	}

	/** Write several frames in one chunk: ordering in one tick is what makes a cancel in-flight. */
	function sendTogether(entries) {
		const chunk = entries.map((entry) => JSON.stringify(frameOf(entry.method, entry.params, entry.id)) + "\n").join("");
		child.stdin.write(chunk);
	}

	async function waitForFrame(id, timeoutMs = REQUEST_TIMEOUT_MS) {
		return waitUntil(() => frames.find((frame) => frame.id === id), "frame " + id + " (stderr: " + stderr + ")", timeoutMs);
	}

	/** Wait for the helper to exit, then read the counters it wrote on exit. */
	async function finish() {
		child.stdin.end();
		await waitUntil(() => exitCode !== null, "helper exit");
		const raw = existsSync(countsFile) ? readFileSync(countsFile, "utf8") : "{}";
		return JSON.parse(raw);
	}

	function kill() {
		try {
			child.stdin.destroy();
			child.kill();
		} catch {
			// already gone
		}
	}

	return {
		frames,
		lines,
		send,
		sendTogether,
		nextId,
		waitForFrame,
		finish,
		kill,
		framesFor: (id) => frames.filter((frame) => frame.id === id),
		stderrText: () => stderr,
		waitForExit: () => exited,
	};
}

/** Directory-level reads, whichever enumeration API the body chose. */
const directoryReads = (counts) => (counts.opendirSync ?? 0) + (counts.readdirSync ?? 0);
/** Entries the traversal actually looked at, whichever enumeration API the body chose. */
const entriesVisited = (counts) => (counts.direntReads ?? 0) + (counts.readdirEntries ?? 0);

async function searchOnce(helper, params) {
	const id = helper.send(METHOD, params);
	return helper.waitForFrame(id);
}

function assertCode(frame, code, label) {
	assert.equal(frame.ok, false, label + ": expected a refusal, got " + JSON.stringify(frame));
	assert.equal(frame.error?.code, code, label + ": wrong refusal code in " + JSON.stringify(frame));
}

test("the frozen contract states the search op, its fields and all three caps", () => {
	assert.equal(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, METHOD);
	assert.equal(REMOTE_HELPER_MAX_SEARCH_MATCHES, MAX_MATCHES);
	assert.equal(REMOTE_HELPER_MAX_SEARCH_SCANNED, MAX_SCANNED);
	assert.equal(REMOTE_HELPER_MAX_SEARCH_DEPTH, MAX_DEPTH);
	assert.equal(REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH, MAX_QUERY);
	assert.ok(REMOTE_HELPER_CAPABILITIES.includes(METHOD), "search must be a negotiated capability");
	assert.ok(REMOTE_HELPER_ERROR_CODES.includes("QUERY_INVALID"), "QUERY_INVALID must be in the closed error vocabulary");

	// The declared field sets are read out of the contract rather than restated, so a renamed or added
	// field shows up here instead of passing on both sides at once.
	const source = readFileSync(CONTRACT_SOURCE, "utf8");
	const fieldsOf = (name) => {
		const match = new RegExp("export\\s+type\\s+" + name + "\\s*=\\s*\\{([\\s\\S]*?)\\};").exec(source);
		assert.ok(match, "RemoteHelperContract does not declare " + name);
		return Array.from(match[1].matchAll(/([A-Za-z][A-Za-z0-9]*)\??\s*:/g)).map((field) => field[1]);
	};
	assert.deepEqual(fieldsOf("RemoteHelperSearchParams"), ["path", "query", "maxMatches"]);
	assert.deepEqual(fieldsOf("RemoteHelperSearchEntry"), ["path", "name", "kind", "bytes"]);
	assert.deepEqual(fieldsOf("RemoteHelperSearchResult"), ["entries", "scanned", "truncated"]);

	// The frozen body cannot import the contract, so its literals are the only other copy; every one has
	// to be present or the remote half silently answers something the contract never declared.
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes('"' + METHOD + '"'), "the frozen body must dispatch " + METHOD);
	for (const value of [MAX_MATCHES, MAX_SCANNED, MAX_DEPTH, MAX_QUERY]) {
		assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(value)), "the frozen body must carry the cap " + value);
	}
});

test("the inline helper source, its declared digest and the bundle manifest agree", () => {
	const digest = sha256Of(REMOTE_HELPER_INLINE_SOURCE);
	assert.equal(digest, REMOTE_HELPER_ENTRY_SHA256, "the inline source changed without updating REMOTE_HELPER_ENTRY_SHA256");
	assert.equal(readFileSync(ENTRY_PATH, "utf8"), REMOTE_HELPER_INLINE_SOURCE);
	const bytes = Buffer.byteLength(REMOTE_HELPER_INLINE_SOURCE, "utf8");
	assert.equal(bytes, REMOTE_HELPER_INLINE_SOURCE.length, "the frozen body stays printable ASCII");
	// The manifest is recomputed here from the bytes on disk, never read back from the producer: a bundle
	// whose manifest declared a digest nobody recomputed is exactly the drift this catches.
	const manifest = uploadModule.buildBundleManifest([{ name: entryModule.REMOTE_HELPER_ENTRY_FILE_NAME, sha256: digest, bytes }]);
	assert.deepEqual(JSON.parse(JSON.stringify(manifest.files)), [{ name: entryModule.REMOTE_HELPER_ENTRY_FILE_NAME, sha256: REMOTE_HELPER_ENTRY_SHA256, bytes }]);
});

test("adding a method to the frozen body bumps the helper build version", () => {
	// The entry's own header states the rule: editing the body is a protocol change, so version and digest
	// move in the same commit. Search was added after build 1.5.0 existed, so 1.5.0 is the stale value.
	assert.notEqual(REMOTE_HELPER_ENTRY_VERSION, "1.5.0", "the frozen body gained " + METHOD + " but still reports build 1.5.0");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes('"' + REMOTE_HELPER_ENTRY_VERSION + '"'), "hello must report REMOTE_HELPER_ENTRY_VERSION");
});

test("the helper refuses every lexical escape before touching the filesystem", async () => {
	const helper = startHelper({ root: ROOT });
	try {
		const cases = [
			["..", "PATH_OUTSIDE_ROOT", "a bare traversal segment"],
			["../outside", "PATH_OUTSIDE_ROOT", "a traversal segment leaving the root"],
			["sub/../../outside", "PATH_OUTSIDE_ROOT", "a traversal hidden mid-path"],
			["/etc", "PATH_OUTSIDE_ROOT", "an absolute path"],
			["C:/Windows", "PATH_OUTSIDE_ROOT", "a Windows drive prefix"],
			["sub\\inner", "PATH_OUTSIDE_ROOT", "a backslash separator"],
			["%2e%2e/outside", "PATH_OUTSIDE_ROOT", "a percent-encoded traversal"],
			["%2fetc", "PATH_OUTSIDE_ROOT", "a percent-encoded separator"],
			["a\u0000b", "PROTOCOL_INVALID", "a control byte in the path"],
			["../".repeat(300) + "outside", "PATH_OUTSIDE_ROOT", "a deeply repeated traversal"],
			["x".repeat(4097), "PROTOCOL_INVALID", "an over-long path"],
			["missing-dir", "PATH_NOT_FOUND", "a path that does not exist"],
			["match-here.txt", "NOT_A_DIRECTORY", "a regular file"],
			// Containment is decided before classification, so a link whose target leaves the root is an escape
			// whatever it points at; a link that stays inside the root is classified as the link it is.
			["out-dir", "PATH_OUTSIDE_ROOT", "a link whose target leaves the root"],
			["out-dir/secret-match.txt", "PATH_OUTSIDE_ROOT", "a path through a link that leaves the root"],
			["link-to-sub", "NOT_A_DIRECTORY", "an in-root directory link is not a directory to search"],
			["link-to-sub/inner-match.txt", "NOT_A_FILE", "a component above the entry is a link"],
		];
		for (const entry of cases) {
			assertCode(await searchOnce(helper, { path: entry[0], query: "match" }), entry[1], entry[2]);
		}
	} finally {
		helper.kill();
	}
});

test("the helper refuses an invalid query or params shape without answering a result", async () => {
	const helper = startHelper({ root: ROOT });
	try {
		assertCode(await searchOnce(helper, { path: ".", query: "" }), "QUERY_INVALID", "empty query");
		assertCode(await searchOnce(helper, { path: ".", query: "x".repeat(MAX_QUERY + 1) }), "QUERY_INVALID", "over-long query");
		assertCode(await searchOnce(helper, { path: ".", query: "a\u0000b" }), "QUERY_INVALID", "control byte in query");
		assertCode(await searchOnce(helper, { path: ".", query: 7 }), "QUERY_INVALID", "non-string query");
		assertCode(await searchOnce(helper, { path: "." }), "QUERY_INVALID", "missing query");
		assertCode(await searchOnce(helper, { path: ".", query: "m", maxMatches: "3" }), "PROTOCOL_INVALID", "non-numeric maxMatches");
		assertCode(await searchOnce(helper, { path: ".", query: "m", maxMatches: 1.5 }), "PROTOCOL_INVALID", "fractional maxMatches");
		assertCode(await searchOnce(helper, { path: ".", query: "m", maxMatches: Number.POSITIVE_INFINITY }), "PROTOCOL_INVALID", "infinite maxMatches");
		const id = helper.send(METHOD, "not-an-object");
		assertCode(await helper.waitForFrame(id), "PROTOCOL_INVALID", "non-object params");
		// The ceiling is inclusive, so a query of exactly 128 characters must still be served.
		const atCeiling = await searchOnce(helper, { path: ".", query: "m".repeat(MAX_QUERY) });
		assert.equal(atCeiling.ok, true, "a query at the declared ceiling must be accepted: " + JSON.stringify(atCeiling));
	} finally {
		helper.kill();
	}
});

test("a host-only helper refuses search with PATH_OUTSIDE_ROOT and starts no traversal", async () => {
	const helper = startHelper({});
	try {
		assertCode(await searchOnce(helper, { path: ".", query: "match" }), "PATH_OUTSIDE_ROOT", "host-only search");
		const counts = await helper.finish();
		assert.equal(directoryReads(counts), 0, "a helper with no root must not open a directory");
		assert.equal(entriesVisited(counts), 0, "a helper with no root must not read a directory entry");
	} finally {
		helper.kill();
	}
});

test("symlinks are never followed by search, and are reported as other", async () => {
	const helper = startHelper({ root: ROOT });
	try {
		// The links are named for "out", the real files for "match": two queries keep the link assertions out of
		// reach of a name filter that could hide a followed link.
		const frame = await searchOnce(helper, { path: ".", query: "out" });
		assert.equal(frame.ok, true, JSON.stringify(frame));
		const entries = frame.result.entries;
		const byPath = new Map(entries.map((entry) => [entry.path, entry]));
		// Both links match by name and both are "other": the file link must not report its target's size,
		// the directory link must not be descended into.
		assert.deepEqual(byPath.get("out-file"), { path: "out-file", name: "out-file", kind: "other" });
		assert.deepEqual(byPath.get("out-dir"), { path: "out-dir", name: "out-dir", kind: "other" });
		assert.ok(!entries.some((entry) => entry.path.startsWith("out-dir/") || entry.path.startsWith("link-to-sub/")), "no entry may be reached through a link: " + JSON.stringify(entries));
		// The outside tree does hold a matching file, so following either link would put it here.
		assert.ok(!entries.some((entry) => entry.name === "secret-match.txt"), "a link target's content must never be reported");
		assert.ok(!entries.some((entry) => entry.path.includes("..") || entry.path.startsWith("/")), "no result path may be absolute or traverse upwards");
		const paths = entries.map((entry) => entry.path);
		assert.deepEqual(paths, [...paths].sort(), "entries must come back sorted by path");
		assert.ok(frame.result.scanned >= entries.length, "scanned counts every visited entry, so it cannot be smaller than the match count");
		// The two regular files are found by their own names, and nothing from the link target joins them.
		const files = await searchOnce(helper, { path: ".", query: "match" });
		assert.equal(files.ok, true, JSON.stringify(files));
		assert.deepEqual(
			files.result.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
			["match-here.txt", "sub/inner-match.txt"],
		);
		assert.ok(!files.result.entries.some((entry) => entry.name === "secret-match.txt"), "a followed link would surface the outside file here too");
	} finally {
		helper.kill();
	}
});

test("the match cap stops the traversal at the cap (counted), not just the result list", async () => {
	const helper = startHelper({ root: MANY_DIR });
	try {
		// Every `m*.txt` matches and `z-more/zz-extra.txt` matches too, but z-more sorts after all of them, so
		// the cap is filled inside the first directory. A traversal that really stops there never opens z-more:
		// that is visible in the counter, independently of what the result says.
		const frame = await searchOnce(helper, { path: ".", query: "txt" });
		assert.equal(frame.ok, true, JSON.stringify(frame));
		assert.equal(frame.result.entries.length, MAX_MATCHES, "the default cap must yield exactly " + MAX_MATCHES + " matches");
		assert.equal(frame.result.truncated, true, "hitting the match cap is a truncation");
		assert.equal(frame.result.scanned, MAX_MATCHES, "the traversal must stop at the entry that filled the cap");
		assert.ok(!frame.result.entries.some((entry) => entry.path.startsWith("z-more/")), "a directory after the cap must not be reached: " + JSON.stringify(frame.result.entries));
		const counts = await helper.finish();
		assert.equal(directoryReads(counts), 1, "after the match cap was reached, no further directory may be opened");
		const visited = entriesVisited(counts);
		// The hard per-call bound. It is deliberately not the match cap: returning the 512 matches in name order
		// requires listing the current directory in full first (a streaming break would make the truncated
		// prefix depend on readdir order), so enumeration is bounded by the scanned cap. The traversal-level
		// stop above is the part of "stop immediately" that does not conflict with the ordering guarantee.
		assert.ok(visited >= MAX_MATCHES && visited <= MAX_SCANNED + 1, "the per-call read bound was broken: read " + visited + " entries out of " + (WIDE_COUNT + 1));
	} finally {
		helper.kill();
	}
});

test("an explicit maxMatches is clamped and the cap still stops the traversal", async () => {
	const helper = startHelper({ root: MANY_DIR });
	try {
		const three = await searchOnce(helper, { path: ".", query: "txt", maxMatches: 3 });
		assert.equal(three.ok, true, JSON.stringify(three));
		assert.equal(three.result.entries.length, 3);
		assert.equal(three.result.truncated, true);
		const zero = await searchOnce(helper, { path: ".", query: "txt", maxMatches: 0 });
		assert.equal(zero.ok, true, JSON.stringify(zero));
		assert.equal(zero.result.entries.length, 1, "a non-positive maxMatches clamps to one, never to unlimited");
		const huge = await searchOnce(helper, { path: ".", query: "txt", maxMatches: 1000000 });
		assert.equal(huge.ok, true, JSON.stringify(huge));
		assert.equal(huge.result.entries.length, MAX_MATCHES, "an over-large maxMatches clamps to the contract cap");
	} finally {
		helper.kill();
	}
});

test("the scanned-entry cap reports exactly the cap and truncated, with zero matches", async () => {
	const helper = startHelper({ root: MANY_DIR });
	try {
		const frame = await searchOnce(helper, { path: ".", query: "no-such-name-anywhere" });
		assert.equal(frame.ok, true, JSON.stringify(frame));
		assert.deepEqual(frame.result.entries, []);
		assert.equal(frame.result.scanned, MAX_SCANNED, "the traversal must stop at the scanned cap, not one entry later");
		assert.equal(frame.result.truncated, true, "stopping at the scanned cap is a truncation");
		const counts = await helper.finish();
		const visited = entriesVisited(counts);
		// The cap is detected by looking one entry past it, so at most one extra read is legitimate; anything
		// more means the walk continued through a directory holding WIDE_COUNT + 1 entries.
		assert.ok(visited >= MAX_SCANNED && visited <= MAX_SCANNED + 1, "read " + visited + " entries: the traversal did not stop at the scanned cap");
		assert.equal(directoryReads(counts), 1, "stopping at the scanned cap must not open another directory");
	} finally {
		helper.kill();
	}
});

test("the depth cap stops the descent and is counted at the directory level", async () => {
	const helper = startHelper({ root: DEEP_ROOT });
	try {
		const frame = await searchOnce(helper, { path: ".", query: "at-" });
		assert.equal(frame.ok, true, JSON.stringify(frame));
		assert.equal(frame.result.truncated, true, "a directory at the depth cap must make the answer a truncation");
		const depths = frame.result.entries.map((entry) => Number(/at-(\d+)-match/.exec(entry.name)?.[1] ?? "0"));
		assert.ok(depths.length > 0, "the shallow entries must still be reported: " + JSON.stringify(frame.result));
		// Depth 0 is the requested directory; a directory whose own depth is MAX_DEPTH is not entered, so the
		// deepest reported file sits at MAX_DEPTH.
		assert.ok(Math.max(...depths) <= MAX_DEPTH, "an entry deeper than the cap was reported: " + JSON.stringify(frame.result.entries));
		assert.ok(!frame.result.entries.some((entry) => /at-(1[3-9]|2\d)-match/.test(entry.name)), "a file below the cap was visited");
		const counts = await helper.finish();
		// Directories at depth 0..MAX_DEPTH-1 are entered: exactly MAX_DEPTH reads, never sixteen.
		assert.equal(directoryReads(counts), MAX_DEPTH, "opened " + directoryReads(counts) + " directories, so the descent did not stop at depth " + MAX_DEPTH);
	} finally {
		helper.kill();
	}
});

test("a cancel that lands while a search is in flight settles it once as REQUEST_CANCELLED", async () => {
	const helper = startHelper({ root: MANY_DIR });
	try {
		helper.send("hello");
		await helper.waitForFrame("req-1");
		const searchId = "search-inflight";
		const cancelId = "cancel-inflight";
		// Both frames in one write: the helper dispatches them in order in the same tick, so the search is
		// admitted (it holds a slot) before the cancel is seen. That is what makes this in-flight.
		helper.sendTogether([
			{ method: METHOD, params: { path: ".", query: "no-such-name-anywhere" }, id: searchId },
			{ method: "cancel", params: { requestId: searchId }, id: cancelId },
		]);
		const refused = await helper.waitForFrame(searchId);
		assertCode(refused, "REQUEST_CANCELLED", "in-flight cancel");
		assert.equal(refused.error.retryable, false, "a cancellation is not retryable");
		const cancelAnswer = await helper.waitForFrame(cancelId);
		assert.deepEqual(cancelAnswer.result, { cancelled: true });
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(helper.framesFor(searchId).length, 1, "a cancelled search must settle exactly once: " + JSON.stringify(helper.framesFor(searchId)));
		assert.ok(!helper.framesFor(searchId).some((frame) => frame.ok === true), "a cancelled search must never answer a partial result");
		const counts = await helper.finish();
		const visited = entriesVisited(counts);
		assert.ok(visited < WIDE_COUNT, "the traversal kept running after the cancel: visited " + visited + " of " + WIDE_COUNT);
	} finally {
		helper.kill();
	}
});

test("a queued search cancelled before it starts is refused without any traversal", async () => {
	const helper = startHelper({ root: MANY_DIR });
	try {
		helper.send("hello");
		await helper.waitForFrame("req-1");
		// Four delayed echoes occupy all four concurrency slots, so the search behind them is only queued.
		for (let index = 0; index < 4; index += 1) helper.send("echo", { text: "hold", delayMs: 2500 });
		const searchId = helper.send(METHOD, { path: ".", query: "no-such-name-anywhere" });
		const cancelId = helper.send("cancel", { requestId: searchId });
		const refused = await helper.waitForFrame(searchId);
		assertCode(refused, "REQUEST_CANCELLED", "queued cancel");
		const cancelAnswer = await helper.waitForFrame(cancelId);
		assert.deepEqual(cancelAnswer.result, { cancelled: true });
		// A second cancel of an already settled id must not produce another frame for it.
		const secondId = helper.send("cancel", { requestId: searchId });
		const second = await helper.waitForFrame(secondId);
		assert.deepEqual(second.result, { cancelled: false, reason: "already-settled" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(helper.framesFor(searchId).length, 1, "exactly one frame may settle a cancelled request");
		const counts = await helper.finish();
		assert.equal(directoryReads(counts), 0, "a search cancelled while queued must never open a directory");
		assert.equal(entriesVisited(counts), 0, "a search cancelled while queued must never read an entry");
	} finally {
		helper.kill();
	}
});

test("the frozen digest check is sensitive to a one-byte edit, so a stale sha cannot pass", () => {
	// The detector has to be shown to bite, not just to agree. A single appended byte is the smallest edit
	// that changes the artifact, and the recomputed digest must move with it.
	const tampered = REMOTE_HELPER_INLINE_SOURCE + " ";
	assert.notEqual(sha256Of(tampered), REMOTE_HELPER_ENTRY_SHA256, "a one-byte edit must change the recomputed digest");
	assert.notEqual(sha256Of(tampered), sha256Of(REMOTE_HELPER_INLINE_SOURCE));
});

test("a declared digest that does not describe the uploaded bytes is refused before any transfer", async () => {
	const directory = mkdtempSync(join(BASE, "manifest-"));
	const bytes = Buffer.byteLength(REMOTE_HELPER_INLINE_SOURCE, "utf8");
	writeFileSync(join(directory, entryModule.REMOTE_HELPER_ENTRY_FILE_NAME), REMOTE_HELPER_INLINE_SOURCE, "utf8");
	const nonce = "nonce000000000001";
	const ready = {
		op: "ready",
		protocolVersion: 1,
		bundleSha256: uploadModule.buildBundleManifest([{ name: entryModule.REMOTE_HELPER_ENTRY_FILE_NAME, sha256: REMOTE_HELPER_ENTRY_SHA256, bytes }]).bundleSha256,
		nonce,
		deployRoot: "/home/pideck/.pideck/remote-host",
		staging: bootstrapContract.REMOTE_BOOTSTRAP_STAGING_PREFIX + nonce,
		stagingMode: "0700",
	};
	const connection = { executable: "/usr/bin/scp", destination: "pideck-host", args: ["-F", "/home/pideck/.pideck/ssh-config"], env: { PATH: "/usr/bin" }, openSshVersion: "OpenSSH_9.6p1 Ubuntu-3ubuntu13" };
	const stale = { ...ready, bundleSha256: "b".repeat(64) };
	const refused = await failureOf(uploadModule.withPrivateBundleUploadPlan({ connection, ready: stale, directory, names: [entryModule.REMOTE_HELPER_ENTRY_FILE_NAME] }, async () => "transferred"));
	assert.ok(refused !== undefined, "a stale declared digest must not reach a transfer");
	assert.equal(refused.code ?? refused.message, "BUNDLE_MANIFEST_INVALID");
	// The agreeing value does pass, so the refusal above is the digest check and not a broken fixture.
	const accepted = await uploadModule.withPrivateBundleUploadPlan({ connection, ready, directory, names: [entryModule.REMOTE_HELPER_ENTRY_FILE_NAME] }, async (plan) => plan.manifest.bundleSha256);
	assert.equal(accepted, ready.bundleSha256, "the observed bytes must reproduce the declared bundle address");
});

/*
 * Reader half: createRemoteSearchReader is driven with a scripted port. Every value below is remote data,
 * so the assertion is that only the exact contract shape survives and everything else is refused with a
 * stable code - never silently accepted, never turned into an empty result.
 */

function scriptedReader(respond) {
	const sent = [];
	const diagnostics = [];
	const reader = readerModule.createRemoteSearchReader({
		port: {
			request(hostId, method, params, options) {
				sent.push({ hostId, method, params, options });
				return Promise.resolve(respond(hostId, method, params, options));
			},
		},
		onDiagnostic(entry) {
			diagnostics.push(entry);
		},
	});
	return { reader, sent, diagnostics };
}

async function failureOf(promise) {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

const GOOD_ENTRY = { path: "sub/a.txt", name: "a.txt", kind: "file", bytes: 3 };

test("the search reader rebuilds exactly the contract shape and passes truncated through", async () => {
	const { reader, sent } = scriptedReader(() => ({ entries: [GOOD_ENTRY, { path: "sub", name: "sub", kind: "directory" }], scanned: 9, truncated: true }));
	const result = await reader.search(HOST_ID, ".", "a");
	// `plain` on the whole array, not per element: the reader returns a VM-realm array, and deepStrictEqual
	// compares array prototypes across realms too.
	assert.deepEqual(plain(result.entries), [GOOD_ENTRY, { path: "sub", name: "sub", kind: "directory" }], "a file entry keeps bytes, a directory entry carries none");
	assert.equal(result.scanned, 9);
	assert.equal(result.truncated, true, "truncated is remote truth and must be passed through, not re-derived");
	assert.equal(sent.length, 1);
	assert.equal(sent[0].method, METHOD);
	assert.deepEqual(plain(sent[0].params), { path: ".", query: "a" });

	// Zero matches with truncated true must survive as a truncated result, not collapse into "empty".
	const truncatedEmpty = scriptedReader(() => ({ entries: [], scanned: MAX_SCANNED, truncated: true }));
	const survived = await truncatedEmpty.reader.search(HOST_ID, ".", "a");
	assert.equal(survived.truncated, true);
	assert.deepEqual(plain(survived.entries), []);
});

test("the search reader refuses every malformed result shape with PROTOCOL_INVALID", async () => {
	const cases = [
		[null, "a null result"],
		[{}, "a result with no fields"],
		[{ entries: [], scanned: 0 }, "a missing truncated"],
		[{ entries: [], scanned: 0, truncated: false, extra: 1 }, "an extra result field"],
		[{ entries: {}, scanned: 0, truncated: false }, "entries that is not an array"],
		[{ entries: [], scanned: 0, truncated: "yes" }, "a non-boolean truncated"],
		[{ entries: [], scanned: -1, truncated: false }, "a negative scanned"],
		[{ entries: [], scanned: 1.5, truncated: false }, "a fractional scanned"],
		[{ entries: [], scanned: MAX_SCANNED + 1, truncated: false }, "scanned past the contract cap"],
		[{ entries: [GOOD_ENTRY, GOOD_ENTRY], scanned: 1, truncated: false }, "scanned smaller than the match count"],
		[{ entries: [{ path: "sub/a.txt", name: "a.txt", kind: "file" }], scanned: 1, truncated: false }, "a file entry with no bytes"],
		[{ entries: [{ path: "sub", name: "sub", kind: "directory", bytes: 4 }], scanned: 1, truncated: false }, "a directory entry carrying bytes"],
		[{ entries: [{ path: "sub/a.txt", name: "a.txt", kind: "file", bytes: -1 }], scanned: 1, truncated: false }, "a negative file size"],
		[{ entries: [{ path: "sub/a.txt", name: "a.txt", kind: "socket" }], scanned: 1, truncated: false }, "an unknown kind"],
		[{ entries: [{ path: "sub/a.txt", name: "a.txt", kind: "file", bytes: 1, x: 1 }], scanned: 1, truncated: false }, "an extra entry field"],
		[{ entries: [{ name: "a.txt", kind: "file", bytes: 1 }], scanned: 1, truncated: false }, "an entry with no path"],
		[{ entries: [{ path: "", name: "a.txt", kind: "file", bytes: 1 }], scanned: 1, truncated: false }, "an empty entry path"],
		[{ entries: [{ path: "/abs", name: "a.txt", kind: "file", bytes: 1 }], scanned: 1, truncated: false }, "an absolute entry path"],
		[{ entries: [{ path: "../up", name: "up", kind: "directory" }], scanned: 1, truncated: false }, "a traversing entry path"],
		[{ entries: [{ path: "a//b", name: "b", kind: "directory" }], scanned: 1, truncated: false }, "an empty path segment"],
		[{ entries: [{ path: "a/", name: "a", kind: "directory" }], scanned: 1, truncated: false }, "a trailing separator"],
		[{ entries: [{ path: "a\\b", name: "b", kind: "directory" }], scanned: 1, truncated: false }, "a backslash entry path"],
		[{ entries: [{ path: "sub/a\u0000b", name: "a", kind: "file", bytes: 1 }], scanned: 1, truncated: false }, "a control byte in the entry path"],
		[{ entries: [{ path: "sub", name: "other", kind: "directory" }], scanned: 1, truncated: false }, "a name that is not the path's last segment"],
		[{ entries: [{ path: "C:/x", name: "x", kind: "directory" }], scanned: 1, truncated: false }, "a drive-prefixed entry path"],
	];
	for (const entry of cases) {
		const { reader } = scriptedReader(() => entry[0]);
		const failure = await failureOf(reader.search(HOST_ID, ".", "a"));
		assert.ok(failure !== undefined, entry[1] + " was accepted");
		assert.equal(failure.code, "PROTOCOL_INVALID", entry[1] + " answered " + failure.code);
	}
});

test("the search reader refuses an over-cap match list with RESULT_TOO_LARGE", async () => {
	const entries = Array.from({ length: MAX_MATCHES + 1 }, (_, index) => ({ path: "f" + index + ".txt", name: "f" + index + ".txt", kind: "file", bytes: 1 }));
	const { reader } = scriptedReader(() => ({ entries, scanned: entries.length, truncated: false }));
	const failure = await failureOf(reader.search(HOST_ID, ".", "f"));
	assert.ok(failure !== undefined, "an over-cap match list must be refused, not truncated");
	assert.equal(failure.code, "RESULT_TOO_LARGE");
});

test("the search reader validates query, path and options before writing a frame", async () => {
	const invalidQueries = ["", "x".repeat(MAX_QUERY + 1), "a\u0000b", 7, undefined];
	for (const query of invalidQueries) {
		const { reader, sent } = scriptedReader(() => ({ entries: [], scanned: 0, truncated: false }));
		const failure = await failureOf(reader.search(HOST_ID, ".", query));
		assert.ok(failure !== undefined, "query " + JSON.stringify(query) + " must be refused");
		assert.equal(failure.code, "QUERY_INVALID", "query " + JSON.stringify(query) + " answered " + failure.code);
		assert.equal(sent.length, 0, "an invalid query must not put a frame on the wire");
	}
	const badPath = scriptedReader(() => ({ entries: [], scanned: 0, truncated: false }));
	const pathFailure = await failureOf(badPath.reader.search(HOST_ID, "", "a"));
	assert.equal(pathFailure.code, "PROTOCOL_INVALID");
	assert.equal(badPath.sent.length, 0, "an invalid path must not put a frame on the wire");
	const badHost = scriptedReader(() => ({ entries: [], scanned: 0, truncated: false }));
	const hostFailure = await failureOf(badHost.reader.search("", ".", "a"));
	assert.equal(hostFailure.code, "PROTOCOL_INVALID");

	// The request path is only shape-checked here: containment is the helper's rule against its own root,
	// so an escape-looking path is forwarded verbatim rather than answered by a second local opinion.
	const forwarded = scriptedReader(() => ({ entries: [], scanned: 0, truncated: false }));
	await forwarded.reader.search(HOST_ID, "../outside", "a");
	assert.equal(forwarded.sent[0].params.path, "../outside", "the reader must not invent its own containment verdict");
});

test("the search reader clamps maxMatches locally and refuses an impossible one", async () => {
	const clamped = scriptedReader(() => ({ entries: [], scanned: 0, truncated: false }));
	await clamped.reader.search(HOST_ID, ".", "a", { maxMatches: 1000000 });
	assert.equal(clamped.sent[0].params.maxMatches, MAX_MATCHES, "an over-large maxMatches must be clamped before the frame");
	const kept = scriptedReader(() => ({ entries: [], scanned: 0, truncated: false }));
	await kept.reader.search(HOST_ID, ".", "a", { maxMatches: 7 });
	assert.equal(kept.sent[0].params.maxMatches, 7);
	const omitted = scriptedReader(() => ({ entries: [], scanned: 0, truncated: false }));
	await omitted.reader.search(HOST_ID, ".", "a");
	assert.ok(!Object.hasOwn(omitted.sent[0].params, "maxMatches"), "an omitted maxMatches must not be invented");
	for (const value of [0, -1, 1.5, "3", Number.NaN]) {
		const { reader, sent } = scriptedReader(() => ({ entries: [], scanned: 0, truncated: false }));
		const failure = await failureOf(reader.search(HOST_ID, ".", "a", { maxMatches: value }));
		assert.ok(failure !== undefined, "maxMatches " + String(value) + " must be refused");
		assert.equal(failure.code, "PROTOCOL_INVALID");
		assert.equal(sent.length, 0, "an impossible maxMatches must not put a frame on the wire");
	}
});

test("the search reader relays a stable transport code and folds free text", async () => {
	const stable = scriptedReader(() => {
		throw new Error("SSH_CONNECTION_NOT_READY");
	});
	const relayed = await failureOf(stable.reader.search(HOST_ID, ".", "a"));
	assert.equal(relayed.code, "SSH_CONNECTION_NOT_READY");
	const freeText = scriptedReader(() => {
		throw new Error("error opening /home/user/secret/project: EACCES");
	});
	const folded = await failureOf(freeText.reader.search(HOST_ID, ".", "a"));
	assert.equal(folded.code, readerModule.REMOTE_SEARCH_READER_CODES.requestFailed);
	assert.ok(!folded.message.includes("/home/user"), "free text must not travel in the error");
});

test("the search reader refuses to be wired without a usable port", () => {
	assert.throws(() => readerModule.createRemoteSearchReader({}), /REMOTE_WORKSPACE_READER_OPTIONS_INVALID/);
	assert.throws(() => readerModule.createRemoteSearchReader({ port: {} }), /REMOTE_WORKSPACE_READER_OPTIONS_INVALID/);
	assert.throws(() => readerModule.createRemoteSearchReader({ port: { request: async () => undefined }, onDiagnostic: 1 }), /REMOTE_WORKSPACE_READER_OPTIONS_INVALID/);
});

/*
 * Renderer half: a late result must be structurally unable to overwrite a newer query.
 */

test("a late search result is invalidated without touching the newer state object", () => {
	const controller = stateModule.createRemoteProjectSearchController();
	assert.equal(controller.getState().phase, "idle");
	const staleGeneration = controller.start("first");
	assert.equal(controller.getState().phase, "searching");
	const currentGeneration = controller.start("second");
	assert.notEqual(currentGeneration, staleGeneration, "starting a search mints a new generation");
	const searchingState = controller.getState();
	const accepted = controller.settle(staleGeneration, { kind: "ok", entries: [{ path: "a.txt", name: "a.txt", kind: "file", bytes: 1 }], scanned: 1, truncated: false });
	assert.equal(accepted, false, "a result from a superseded generation must be rejected");
	assert.equal(controller.getState(), searchingState, "a rejected late result must not replace the state object");
	assert.equal(controller.getState().query, "second");
	assert.equal(controller.settle(currentGeneration, { kind: "ok", entries: [], scanned: 5, truncated: false }), true);
	assert.equal(controller.getState().phase, "empty");
});

test("reset invalidates an in-flight generation and a truncated empty result is not empty", () => {
	const controller = stateModule.createRemoteProjectSearchController();
	const generation = controller.start("q");
	controller.reset();
	const idleState = controller.getState();
	assert.equal(idleState.phase, "idle");
	assert.equal(controller.settle(generation, { kind: "ok", entries: [], scanned: 0, truncated: false }), false, "a result arriving after reset must be dropped");
	assert.equal(controller.getState(), idleState, "reset state must survive a late result untouched");
	const live = controller.start("q2");
	assert.equal(controller.settle(live, { kind: "ok", entries: [], scanned: 20000, truncated: true }), true);
	assert.equal(controller.getState().phase, "results", "a truncated answer with no matches must not be reported as empty");
	assert.equal(controller.getState().truncated, true);
	const failed = controller.start("q3");
	assert.equal(controller.settle(failed, { kind: "failed", code: "RESULT_TOO_LARGE" }), true);
	assert.equal(controller.getState().phase, "error");
	assert.equal(controller.getState().errorCode, "RESULT_TOO_LARGE");
});

test("the renderer rejects a malformed search response instead of rendering it as empty", () => {
	const rejected = [
		null,
		{ ok: true, entries: [], scanned: 0 },
		{ ok: true, entries: [], scanned: 0, truncated: "no" },
		{ ok: true, entries: [{}], scanned: 1, truncated: false },
		{ ok: true, entries: [{ path: "../x", name: "x", kind: "file", bytes: 1 }], scanned: 1, truncated: false },
		{ ok: false, code: "not a code" },
	];
	for (const raw of rejected) {
		assert.equal(stateModule.readSearchResponse(raw).kind, "rejected", JSON.stringify(raw) + " must be rejected");
	}
	assert.deepEqual(plain(stateModule.readSearchResponse({ ok: false, code: "PATH_NOT_FOUND" })), { kind: "failed", code: "PATH_NOT_FOUND" });
	assert.deepEqual(plain(stateModule.readSearchResponse({ ok: true, entries: [], scanned: 4, truncated: true })), { kind: "ok", entries: [], scanned: 4, truncated: true });
});
