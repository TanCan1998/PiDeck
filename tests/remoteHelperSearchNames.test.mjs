import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * Protocol proof for the bounded filename search (fs.searchNames, helper build 1.6.0). Every case below
 * drives the *frozen* helper body as a real child process with a real --root and the production
 * RemoteControlClient, because the promises this method makes are promises about the filesystem: that a
 * link is never followed out of the root, that a ceiling stops the walk instead of the tree being walked
 * and then cut, and that a cancelled walk answers exactly one REQUEST_CANCELLED instead of half a listing.
 *
 * The ceilings are the contract's (512 matches, 20000 visited entries, depth 12), and the expectations are
 * computed from the disk in this process - names, kinds, sizes and the exact scanned count - never read
 * back out of an answer. One shape is read out of RemoteHelperContract.ts on purpose: the params and the
 * result fields, so a field renamed on one side fails here instead of travelling as an ignored extra key.
 */

const {
	REMOTE_HELPER_CAPABILITIES,
	REMOTE_HELPER_ERROR_CODES,
	REMOTE_HELPER_MAX_SEARCH_DEPTH,
	REMOTE_HELPER_MAX_SEARCH_MATCHES,
	REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH,
	REMOTE_HELPER_MAX_SEARCH_SCANNED,
	REMOTE_HELPER_METHOD_CANCEL,
	REMOTE_HELPER_METHOD_ECHO,
	REMOTE_HELPER_METHOD_FS_SEARCH_NAMES,
	REMOTE_HELPER_PROTOCOL_VERSION,
} = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_HELPER_ENTRY_FILE_NAME, REMOTE_HELPER_ENTRY_SHA256, REMOTE_HELPER_ENTRY_VERSION, REMOTE_HELPER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");

/** Same host id shape the host store mints; the client bounds it by length and control bytes only. */
const HOST_ID = "6f1d2c3b-4a59-4e8d-9f70-1a2b3c4d5e6f";
/** The helper never resolves HOME into a path, so a POSIX literal is the honest fixture on any platform. */
const HELPER_HOME = "/home/pideck-search";
const REQUEST_TIMEOUT_MS = 20_000;
const GUARD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;
/** A token that exists only outside the root: no frame may ever carry a path or an entry that names it. */
const DECOY = "pideck-search-decoy-5d21";
/** Contract source read back by this suite: the declared params/result shapes are the wire shapes. */
const CONTRACT_SOURCE = "src/main/remote/RemoteHelperContract.ts";

/** Every test drives a real child process, so each one carries a hard deadline of its own. */
const searchTest = (name, fn, timeoutMs = TEST_TIMEOUT_MS) => test(name, { timeout: timeoutMs }, fn);

/** Production objects live in another VM realm, so deep comparisons are normalised through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Bound one await: a helper that stops answering must fail the test, never stall the runner. */
function guard(promise, label, timeoutMs = GUARD_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for " + label)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Await on a rejecting promise: the refusal is returned instead of thrown, so a code can be asserted. */
async function rejection(promise, label) {
	try {
		await guard(promise, label);
	} catch (error) {
		return error;
	}
	throw new Error(label + " answered a result where a refusal was expected");
}

/** Field names of one contract type, read out of the contract source: the wire shape is asserted exactly. */
function contractTypeFields(typeName) {
	const source = readFileSync(CONTRACT_SOURCE, "utf8");
	const match = new RegExp("export\\s+type\\s+" + typeName + "\\s*=\\s*\\{([\\s\\S]*?)\\};").exec(source);
	assert.ok(match, "RemoteHelperContract does not declare " + typeName);
	return Array.from(match[1].matchAll(/([A-Za-z][A-Za-z0-9]*)\??\s*:/g)).map((entry) => entry[1]);
}

/** The entry the deploy bundle uploads, written once per run so every child starts the reviewed bytes. */
const ENTRY_DIRECTORY = mkdtempSync(join(tmpdir(), "pideck-search-entry-"));
const ENTRY_PATH = join(ENTRY_DIRECTORY, REMOTE_HELPER_ENTRY_FILE_NAME);
writeFileSync(ENTRY_PATH, REMOTE_HELPER_INLINE_SOURCE, "utf8");
after(() => rmSync(ENTRY_DIRECTORY, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/** A fresh temporary directory that the hook removes; a Windows removal may need the retries. */
function tempDirectory(t, prefix) {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
	return directory;
}

/** A link that says its type on the platforms that cannot infer it (Windows needs file/junction). */
function link(target, path, kind) {
	symlinkSync(target, path, process.platform === "win32" ? kind : kind === "junction" ? "dir" : undefined);
}

/**
 * One real helper process plus the production client that speaks to it. root:null starts no --root at all
 * (the legal host-only session), any other root is used as it is, and a missing root gets a fresh empty
 * directory. Raw writes stay available for the frame the client refuses to send (a short timeoutMs).
 */
function startHelper(t, options = {}) {
	const env = { ...process.env, HOME: HELPER_HOME };
	const rootArgs = options.root === null ? [] : ["--root", options.root === undefined ? tempDirectory(t, "pideck-search-root-") : options.root];
	const child = spawn(process.execPath, [ENTRY_PATH, ...rootArgs], { env, stdio: ["pipe", "pipe", "pipe"] });
	const sent = [];
	const lines = [];
	const frames = [];
	const diagnostics = [];
	const frameWaiters = new Set();
	let buffered = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdin.on("error", () => {});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const client = createRemoteControlClient({
		hostId: HOST_ID,
		send: (line) => {
			sent.push(line);
			child.stdin.write(line + "\n");
		},
		onDiagnostic: (entry) => {
			diagnostics.push(plain(entry));
		},
	});
	client.openConnection();
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		let index;
		while ((index = buffered.indexOf("\n")) >= 0) {
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			lines.push(line);
			try {
				frames.push(JSON.parse(line));
			} catch {
				// A stdout line that is not JSON is a finding of its own; the raw line stays in lines.
			}
			client.handleLine(line);
			for (const waiter of [...frameWaiters]) waiter();
		}
	});
	t.after(() => {
		client.closeConnection();
		child.stdin.destroy();
		child.kill();
	});

	/** Resolves with the first inbound frame that matches, whoever else answers in between. */
	function waitForFrame(predicate, label, timeoutMs = GUARD_TIMEOUT_MS) {
		const found = frames.find(predicate);
		if (found !== undefined) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				frameWaiters.delete(waiter);
				reject(new Error("timed out waiting for " + label));
			}, timeoutMs);
			const waiter = () => {
				const frame = frames.find(predicate);
				if (frame === undefined) return;
				clearTimeout(timer);
				frameWaiters.delete(waiter);
				resolve(frame);
			};
			frameWaiters.add(waiter);
		});
	}

	return {
		child,
		client,
		sent,
		lines,
		frames,
		diagnostics,
		root: rootArgs.length > 0 ? rootArgs[1] : null,
		stderr: () => stderr,
		/** The id the client minted for outbound frame N, which is how a test reaches cancellation by id. */
		requestIdAt(index) {
			const frame = JSON.parse(sent[index]);
			assert.ok(typeof frame.id === "string" && frame.id.length > 0, "no id in outbound frame " + index);
			return frame.id;
		},
		writeLine(text) {
			child.stdin.write(text + "\n");
		},
		waitForFrame,
	};
}

/** The request frames of one session, in order: the method, the params and the timeout are the contract's. */
function searchRequestsOf(session) {
	return session.sent.map((line) => JSON.parse(line)).filter((frame) => frame.method === REMOTE_HELPER_METHOD_FS_SEARCH_NAMES);
}

/** One successful search, normalised out of the helper's realm. */
async function search(session, params) {
	return plain(await guard(session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, params, { timeoutMs: REQUEST_TIMEOUT_MS }), "fs.searchNames"));
}

searchTest("the contract and the frozen source declare the same search op and the same ceilings", () => {
	// The frozen body cannot import the contract, so its literals are compared here, byte for byte.
	assert.deepEqual(Array.from(REMOTE_HELPER_CAPABILITIES), ["echo", "fs.stat", "fs.list", "fs.read", "fs.searchNames"]);
	assert.equal(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, "fs.searchNames");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes('"' + REMOTE_HELPER_METHOD_FS_SEARCH_NAMES + '"'), "the method must be dispatched in the frozen body");
	for (const capability of REMOTE_HELPER_CAPABILITIES) assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes('"' + capability + '"'), capability + " must be advertised by hello");
	assert.ok(REMOTE_HELPER_ERROR_CODES.includes("QUERY_INVALID"), "QUERY_INVALID must be a declared code");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes('"QUERY_INVALID"'), "the frozen body must answer QUERY_INVALID");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes('"' + REMOTE_HELPER_ENTRY_VERSION + '"'), "hello must report the exported build");
	for (const ceiling of [REMOTE_HELPER_MAX_SEARCH_MATCHES, REMOTE_HELPER_MAX_SEARCH_SCANNED, REMOTE_HELPER_MAX_SEARCH_DEPTH, REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH]) {
		assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(ceiling)), ceiling + " must be a literal of the frozen body");
	}
	assert.equal(REMOTE_HELPER_MAX_SEARCH_MATCHES, 512);
	assert.equal(REMOTE_HELPER_MAX_SEARCH_SCANNED, 20000);
	assert.equal(REMOTE_HELPER_MAX_SEARCH_DEPTH, 12);
	assert.equal(REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH, 128);
	// The deployment identity is the digest of these exact bytes; the entry module re-exports it.
	assert.equal(createHash("sha256").update(REMOTE_HELPER_INLINE_SOURCE, "utf8").digest("hex"), REMOTE_HELPER_ENTRY_SHA256);
	assert.deepEqual(contractTypeFields("RemoteHelperSearchParams").sort(), ["maxMatches", "path", "query"]);
	assert.deepEqual(contractTypeFields("RemoteHelperSearchEntry").sort(), ["bytes", "kind", "name", "path"]);
	assert.deepEqual(contractTypeFields("RemoteHelperSearchResult").sort(), ["entries", "scanned", "truncated"]);
});

/** The tree the semantics test walks; its answer is stated below as the disk has it, not as the helper says. */
function createMatchFixture(t) {
	const base = tempDirectory(t, "pideck-search-match-");
	const root = join(base, "root");
	const outside = join(base, "outside");
	mkdirSync(join(root, "SubTXT"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(root, "Alpha.txt"), "alpha content\n");
	writeFileSync(join(root, "beta.TXT"), "beta\n");
	writeFileSync(join(root, "notes.md"), "notes\n");
	writeFileSync(join(root, "SubTXT", "inner.txt"), "inner\n");
	writeFileSync(join(root, "SubTXT", "txt-inside-link.txt"), "through a link?\n");
	writeFileSync(join(outside, "secret.txt"), DECOY);
	link(join(root, "SubTXT"), join(root, "link-dir"), "junction");
	link(join(root, "Alpha.txt"), join(root, "link-to-txt"), "file");
	link(outside, join(root, "outside-txt-link"), "junction");
	return { base, root, outside };
}

searchTest("searchNames matches basenames case-insensitively, lists directories, and never follows a link", async (t) => {
	const fixture = createMatchFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const answer = await search(session, { path: ".", query: "txt" });

	// The shape of the answer and of the request is the contract's, exactly.
	assert.deepEqual(Object.keys(answer).sort(), ["entries", "scanned", "truncated"]);
	assert.equal(answer.truncated, false);
	const request = searchRequestsOf(session)[0];
	assert.equal(request.v, REMOTE_HELPER_PROTOCOL_VERSION);
	assert.equal(request.hostId, HOST_ID);
	assert.deepEqual(Object.keys(request.params), ["path", "query"]);

	// Disk truth, read here: two matching files per directory, the rest at the root, sorted by path.
	const size = (relative) => lstatSync(join(fixture.root, ...relative.split("/"))).size;
	assert.deepEqual(
		answer.entries.map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind, bytes: entry.bytes })),
		[
			{ path: "Alpha.txt", name: "Alpha.txt", kind: "file", bytes: size("Alpha.txt") },
			{ path: "SubTXT", name: "SubTXT", kind: "directory", bytes: undefined },
			{ path: "SubTXT/inner.txt", name: "inner.txt", kind: "file", bytes: size("SubTXT/inner.txt") },
			{ path: "SubTXT/txt-inside-link.txt", name: "txt-inside-link.txt", kind: "file", bytes: size("SubTXT/txt-inside-link.txt") },
			{ path: "beta.TXT", name: "beta.TXT", kind: "file", bytes: size("beta.TXT") },
			{ path: "link-to-txt", name: "link-to-txt", kind: "other", bytes: undefined },
			{ path: "outside-txt-link", name: "outside-txt-link", kind: "other", bytes: undefined },
		],
	);
	// A link is described as itself: no size, and the directory it names is never entered.
	for (const entry of answer.entries) assert.equal(Object.hasOwn(entry, "bytes"), entry.kind === "file", entry.path + ": only a regular file carries bytes");
	assert.equal(
		answer.entries.some((entry) => entry.path.startsWith("link-dir/") || entry.path.startsWith("outside-txt-link/")),
		false,
		"a link is never descended into, inside the root or out of it",
	);
	// Every visited entry is counted: seven at the root plus two inside SubTXT. Nothing outside was read.
	assert.equal(answer.scanned, 9);
	assert.ok(answer.scanned >= answer.entries.length);
	assert.ok(answer.scanned <= REMOTE_HELPER_MAX_SEARCH_SCANNED);
	for (const text of [session.lines.join("\n"), session.stderr(), JSON.stringify(session.diagnostics)]) {
		assert.equal(text.includes(DECOY), false, "the decoy outside the root must never be read");
	}
	assert.deepEqual(session.diagnostics, []);
	assert.equal(session.lines.length, session.frames.length, "every stdout line is a protocol frame");
});

searchTest("searchNames matches directory names too and stays relative to the directory it was given", async (t) => {
	const fixture = createMatchFixture(t);
	const session = startHelper(t, { root: fixture.root });

	const byDirectory = await search(session, { path: ".", query: "subtxt" });
	assert.deepEqual(
		byDirectory.entries.map((entry) => entry.path),
		["SubTXT"],
		"the directory name takes part in the match, whatever its case",
	);
	const fromSub = await search(session, { path: "SubTXT", query: "TXT" });
	assert.deepEqual(
		fromSub.entries.map((entry) => entry.path),
		["inner.txt", "txt-inside-link.txt"],
		"paths are relative to the requested directory, not to the root",
	);
	assert.equal(fromSub.scanned, 2);
	assert.deepEqual(
		searchRequestsOf(session).map((frame) => frame.params.path),
		[".", "SubTXT"],
	);
});

/** A tree with count files whose names all contain match, plus a non-matching file that sorts first. */
function createWideFixture(t, count) {
	const root = tempDirectory(t, "pideck-search-wide-");
	writeFileSync(join(root, "aaa-first.txt"), "not a match\n");
	for (let index = 0; index < count; index += 1) writeFileSync(join(root, "match-" + String(index).padStart(4, "0") + ".txt"), "");
	return root;
}

searchTest("the match ceiling truncates a full list at the entry that fills it", async (t) => {
	const root = createWideFixture(t, REMOTE_HELPER_MAX_SEARCH_MATCHES + 88);
	const session = startHelper(t, { root });
	const answer = await search(session, { path: ".", query: "match" });

	// 512 matches, not one more, and the answer says so instead of looking like the whole tree.
	assert.equal(answer.entries.length, REMOTE_HELPER_MAX_SEARCH_MATCHES);
	assert.equal(answer.truncated, true);
	assert.deepEqual(
		answer.entries.map((entry) => entry.path),
		Array.from({ length: REMOTE_HELPER_MAX_SEARCH_MATCHES }, (_value, index) => "match-" + String(index).padStart(4, "0") + ".txt"),
		"a truncated answer is a deterministic name-order prefix",
	);
	// The walk stopped at the 512th match: the non-matching entry before them was visited, nothing after.
	assert.equal(answer.scanned, REMOTE_HELPER_MAX_SEARCH_MATCHES + 1);

	// maxMatches is clamped on the helper side: a small value truncates earlier, a huge one to the ceiling,
	// and 0 becomes 1 rather than an empty answer.
	const small = await search(session, { path: ".", query: "match", maxMatches: 3 });
	assert.deepEqual(
		small.entries.map((entry) => entry.path),
		["match-0000.txt", "match-0001.txt", "match-0002.txt"],
	);
	assert.equal(small.truncated, true);
	assert.equal(small.scanned, 4);
	const zero = await search(session, { path: ".", query: "match", maxMatches: 0 });
	assert.equal(zero.entries.length, 1);
	assert.equal(zero.truncated, true);
	const huge = await search(session, { path: ".", query: "match", maxMatches: 100000 });
	assert.equal(huge.entries.length, REMOTE_HELPER_MAX_SEARCH_MATCHES);
	assert.equal(huge.truncated, true);
	assert.deepEqual(Object.keys(searchRequestsOf(session).at(-1).params).sort(), ["maxMatches", "path", "query"]);
});

searchTest(
	"the entry ceiling stops at 20000 visited entries and never counts or matches the next one",
	async (t) => {
		// The only entry whose name contains the query sorts last, so a walk that went one entry too far would
		// answer it; the ceiling must instead stop before it, with exactly 20000 entries visited.
		const root = tempDirectory(t, "pideck-search-many-");
		const total = REMOTE_HELPER_MAX_SEARCH_SCANNED;
		for (let index = 0; index < total; index += 1) writeFileSync(join(root, "a-" + String(index).padStart(5, "0") + ".tmp"), "");
		writeFileSync(join(root, "zzzz-match.txt"), "");
		const session = startHelper(t, { root });
		const answer = await search(session, { path: ".", query: "match" });

		assert.deepEqual(answer.entries, [], "the entry past the ceiling was never visited, so it was never matched");
		assert.equal(answer.scanned, total);
		assert.equal(answer.truncated, true);
	},
	180_000,
);

searchTest(
	"the depth ceiling stops at 12 segments and the directory at the ceiling is not entered",
	async (t) => {
		const root = tempDirectory(t, "pideck-search-depth-");
		// root/d01/.../d11 holds two matches at depth 12 and the directory d12 at the ceiling; the match inside
		// d12 (depth 13) is never reached. The first depth-12 match sorts before the ceiling directory and is
		// answered, the second sorts after it and is not, because the walk stops where the ceiling is reached.
		let path = root;
		for (let level = 1; level <= 12; level += 1) {
			path = join(path, "d" + String(level).padStart(2, "0"));
			mkdirSync(path);
			if (level === 11) {
				writeFileSync(join(path, "a-deep12-match.txt"), "");
				writeFileSync(join(path, "z-deep12-match.txt"), "");
			}
			if (level === 12) writeFileSync(join(path, "deep13-match.txt"), "");
		}
		writeFileSync(join(root, "root-match.txt"), "");
		const session = startHelper(t, { root });
		const answer = await search(session, { path: ".", query: "match" });

		const prefix = Array.from({ length: 11 }, (_value, index) => "d" + String(index + 1).padStart(2, "0")).join("/");
		assert.deepEqual(
			answer.entries.map((entry) => entry.path),
			[prefix + "/a-deep12-match.txt", "root-match.txt"],
			"the answer is sorted by path, whichever branch an entry came from",
		);
		assert.equal(answer.entries[0].path.split("/").length, REMOTE_HELPER_MAX_SEARCH_DEPTH, "the deepest answer sits at the ceiling");
		assert.equal(answer.truncated, true, "not entering the directory at the ceiling means part of the tree was not visited");
		assert.equal(
			answer.entries.some((entry) => entry.path.includes("deep13-match.txt")),
			false,
			"an entry at depth 13 is beyond the ceiling",
		);
		assert.equal(
			answer.entries.some((entry) => entry.path.includes("z-deep12-match.txt")),
			false,
			"the walk stops where the ceiling is reached",
		);
	},
	60_000,
);

searchTest("an unusable query is refused as QUERY_INVALID before any filesystem access", async (t) => {
	const fixture = createMatchFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const refusals = [
		["a missing query", { path: "." }],
		["an empty query", { path: ".", query: "" }],
		["an over-long query", { path: ".", query: "x".repeat(REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH + 1) }],
		["a control byte in the query", { path: ".", query: "a\u0000b" }],
		["a newline in the query", { path: ".", query: "a\nb" }],
	];
	for (const [label, params] of refusals) {
		const error = await rejection(session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, params, { timeoutMs: REQUEST_TIMEOUT_MS }), label);
		assert.equal(error.code, "QUERY_INVALID", label);
		assert.equal(error.retryable, false, label);
		assert.ok(REMOTE_HELPER_ERROR_CODES.includes(error.code), label + ": the code must be in the contract");
	}
	// A query at the ceiling is legal, and a mistyped maxMatches is a protocol error rather than a clamp.
	const atCeiling = await search(session, { path: ".", query: "x".repeat(REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH) });
	assert.deepEqual(atCeiling.entries, []);
	const mistyped = await rejection(session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, { path: ".", query: "txt", maxMatches: "many" }, { timeoutMs: REQUEST_TIMEOUT_MS }), "a mistyped maxMatches");
	assert.equal(mistyped.code, "PROTOCOL_INVALID");
	const fractional = await rejection(session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, { path: ".", query: "txt", maxMatches: 1.5 }, { timeoutMs: REQUEST_TIMEOUT_MS }), "a fractional maxMatches");
	assert.equal(fractional.code, "PROTOCOL_INVALID");
	// No walk happened for a refusal: the only refusals on the wire are the query and the maxMatches ones.
	assert.deepEqual(
		session.frames.filter((frame) => frame.ok === false).map((frame) => frame.error.code),
		["QUERY_INVALID", "QUERY_INVALID", "QUERY_INVALID", "QUERY_INVALID", "QUERY_INVALID", "PROTOCOL_INVALID", "PROTOCOL_INVALID"],
	);
});

searchTest("searchNames keeps the path rules and the root confinement of the rest of the batch", async (t) => {
	const fixture = createMatchFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const cases = [
		["a parent escape", { path: "../outside", query: "txt" }, "PATH_OUTSIDE_ROOT"],
		["an absolute path", { path: "/etc", query: "txt" }, "PATH_OUTSIDE_ROOT"],
		["a backslash", { path: "SubTXT\\inner.txt", query: "txt" }, "PATH_OUTSIDE_ROOT"],
		["a percent-encoded dot", { path: "%2e%2e", query: "txt" }, "PATH_OUTSIDE_ROOT"],
		["a missing directory", { path: "nope", query: "txt" }, "PATH_NOT_FOUND"],
		["a regular file", { path: "Alpha.txt", query: "txt" }, "NOT_A_DIRECTORY"],
		["a link to a directory", { path: "link-dir", query: "txt" }, "NOT_A_DIRECTORY"],
		["a link out of the root", { path: "outside-txt-link", query: "txt" }, "PATH_OUTSIDE_ROOT"],
	];
	for (const [label, params, code] of cases) {
		const error = await rejection(session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, params, { timeoutMs: REQUEST_TIMEOUT_MS }), label);
		assert.equal(error.code, code, label);
		assert.equal(error.retryable, false, label);
	}
	assert.equal(JSON.stringify(session.frames).includes(DECOY), false, "no refusal may relay the decoy");

	// A helper started without --root is host-only: the method is refused with the code every fs method
	// uses there, because there is no root for a path to be inside of.
	const hostOnly = startHelper(t, { root: null });
	const refused = await rejection(hostOnly.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, { path: ".", query: "txt" }, { timeoutMs: REQUEST_TIMEOUT_MS }), "a host-only search");
	assert.equal(refused.code, "PATH_OUTSIDE_ROOT");
	assert.deepEqual(hostOnly.diagnostics, []);
});

/** A tree wide enough that the walk spans many slices, so a cancel lands while it is still running. */
function createSlowFixture(t) {
	const root = tempDirectory(t, "pideck-search-slow-");
	for (let directory = 0; directory < 40; directory += 1) {
		const nested = join(root, "dir-" + String(directory).padStart(2, "0"));
		mkdirSync(nested, { recursive: true });
		for (let file = 0; file < 64; file += 1) writeFileSync(join(nested, "match-" + String(file).padStart(3, "0") + ".txt"), "");
	}
	return root;
}

searchTest("a search parked in the waiting room is withdrawn exactly once", async (t) => {
	const root = createSlowFixture(t);
	const session = startHelper(t, { root });
	// Four raw echoes hold every slot for over a second, so the search has to be parked in the FIFO room.
	for (let index = 0; index < 4; index += 1) {
		session.writeLine(JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation: 9, id: "hold-" + index, method: REMOTE_HELPER_METHOD_ECHO, params: { text: "hold", delayMs: 1200 } }));
	}
	await delay(150);
	const pending = session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, { path: ".", query: "match" });
	// The handler is attached now: the withdrawal settles this promise before the cancel response is read, and
	// an unhandled rejection would fail the run instead of the assertion being tested.
	const outcome = rejection(pending, "the withdrawn parked search");
	const searchId = session.requestIdAt(session.sent.length - 1);
	// A walk that had been admitted would be over by now: it is a few thousand entries spread over many
	// slices, and no answer at all is what proves this request never started.
	await delay(150);
	assert.equal(session.frames.filter((frame) => frame.id === searchId).length, 0, "the search must still be waiting for a slot");
	const withdrawn = plain(await guard(session.client.cancel(searchId), "cancel of a parked search"));
	assert.deepEqual(withdrawn, { cancelled: true });
	const error = await outcome;
	assert.equal(error.code, "REQUEST_CANCELLED");
	assert.equal(error.retryable, false);
	await guard(
		session.waitForFrame((frame) => frame.id === "hold-3", "the last slot holder"),
		"the last slot holder",
	);
	const framesForSearch = session.frames.filter((frame) => frame.id === searchId);
	assert.equal(framesForSearch.length, 1, "one request, one terminal frame - and it is the withdrawal");
	assert.equal(framesForSearch[0].ok, false);
	assert.equal(framesForSearch[0].error.code, "REQUEST_CANCELLED");
	assert.equal(session.stderr(), "", "the helper writes protocol frames only");
});

searchTest("a running search is aborted at an entry boundary and never returns a partial listing", async (t) => {
	const root = createSlowFixture(t);
	const session = startHelper(t, { root });
	const pending = session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, { path: ".", query: "match" });
	const outcome = rejection(pending, "the aborted search");
	const searchId = session.requestIdAt(session.sent.length - 1);
	// The walk spans many slices, so nothing can have settled at the moment the cancel is written.
	assert.equal(session.frames.filter((frame) => frame.id === searchId).length, 0);
	const withdrawn = plain(await guard(session.client.cancel(searchId), "cancel of a running search"));
	assert.deepEqual(withdrawn, { cancelled: true });
	const error = await outcome;
	assert.equal(error.code, "REQUEST_CANCELLED");
	assert.equal(error.retryable, false);
	// The client rejects the pending call as soon as the withdraw is accepted, so the walk's own terminal
	// frame is awaited here: it is the evidence that the walk really stopped at an entry boundary.
	const terminal = await guard(
		session.waitForFrame((frame) => frame.id === searchId, "the aborted walk's terminal frame"),
		"the aborted walk's terminal frame",
	);
	assert.equal(terminal.ok, false);
	assert.equal(terminal.error.code, "REQUEST_CANCELLED");
	for (const frame of session.frames) assert.equal(frame.id === searchId && frame.ok === true, false, "a cancelled search may not answer a result, partial or not");
	assert.equal(session.frames.filter((frame) => frame.id === searchId).length, 1, "exactly one terminal frame");
	assert.equal(session.sent.map((line) => JSON.parse(line)).filter((frame) => frame.method === REMOTE_HELPER_METHOD_CANCEL).length, 1, "the withdraw was written exactly once");

	// A second withdraw reports already-settled and adds no frame: one request settles exactly once.
	const second = plain(await guard(session.client.cancel(searchId), "a second cancel"));
	assert.deepEqual(second, { cancelled: false, reason: "already-settled" });
	await delay(50);
	assert.equal(session.frames.filter((frame) => frame.id === searchId).length, 1);
	const unknown = plain(await guard(session.client.cancel("req-999999"), "a cancel of an unknown request"));
	assert.deepEqual(unknown, { cancelled: false, reason: "already-settled" });

	// The aborted walk gave its slot back: four zero-delay echoes all run at once and all answer.
	await Promise.all(Array.from({ length: 4 }, (_value, index) => guard(session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "after-" + index }), "echo after the abort " + index)));
	assert.equal(session.stderr(), "", "the helper writes protocol frames only");
});

searchTest("a search that never gets a slot in time is refused with the helper's own REQUEST_TIMEOUT", async (t) => {
	const root = createSlowFixture(t);
	const session = startHelper(t, { root });
	// Raw frames, because the frame's timeoutMs is the helper's deadline and the client would apply the same
	// value to its own timer: here the deadline is already past when the waiting room hands the slot on.
	for (let index = 0; index < 4; index += 1) {
		session.writeLine(JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation: 4, id: "hold-" + index, method: REMOTE_HELPER_METHOD_ECHO, params: { text: "hold", delayMs: 400 } }));
	}
	session.writeLine(JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation: 4, id: "raw-search", method: REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, timeoutMs: 1, params: { path: ".", query: "match" } }));
	const frame = await guard(
		session.waitForFrame((candidate) => candidate.id === "raw-search", "the timed-out search"),
		"the timed-out search",
	);
	assert.equal(frame.ok, false);
	assert.equal(frame.error.code, "REQUEST_TIMEOUT");
	assert.equal(frame.error.retryable, true);
	assert.equal(frame.generation, 4);
	assert.equal(Object.hasOwn(frame, "result"), false);
	// The slot is free afterwards, which is what shows the refusal came from the waiting room and not from a
	// walk that quietly kept its slot.
	const echo = plain(await guard(session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "after" }), "an echo after the timeout"));
	assert.equal(echo.text, "after");
});

/**
 * A preload that wraps node:fs behind a counter before the frozen body loads it. The helper asks for its
 * builtins through process.getBuiltinModule, so the wrapper is what it gets, and every opendirSync and
 * Dir.readSync it performs is recorded. The counts are written on exit, which is what lets a test assert
 * the *work* of a call - that a directory was never opened at all - instead of inferring it from an answer.
 */
const COUNTING_PRELOAD_SOURCE = [
	'import { appendFileSync } from "node:fs";',
	"const countFile = process.env.PIDECK_SEARCH_COUNT_FILE;",
	"const opened = [];",
	"let reads = 0;",
	"const real = process.getBuiltinModule.bind(process);",
	"process.getBuiltinModule = (name) => {",
	"	const module = real(name);",
	'	if (name !== "node:fs") return module;',
	"	return new Proxy(module, {",
	"		get(target, property) {",
	'			if (property === "opendirSync") {',
	"				return (targetPath, options) => {",
	"					opened.push(String(targetPath));",
	"					const directory = target.opendirSync(targetPath, options);",
	"					return {",
	"						readSync: () => { reads += 1; return directory.readSync(); },",
	"						closeSync: () => directory.closeSync(),",
	"					};",
	"				};",
	"			}",
	"			const value = target[property];",
	'			return typeof value === "function" ? value.bind(target) : value;',
	"		},",
	"	});",
	"};",
	'process.on("exit", () => { try { appendFileSync(countFile, JSON.stringify({ opened, reads })); } catch { /* the count file is a probe, not part of the protocol */ } });',
].join("\n");

/** One search frame against a real counted helper: the answer, and what it asked of the filesystem. */
async function searchWithCounts(t, root, params) {
	const probe = tempDirectory(t, "pideck-search-count-");
	const preload = join(probe, "count-fs.mjs");
	const countFile = join(probe, "counts.json");
	writeFileSync(preload, COUNTING_PRELOAD_SOURCE, "utf8");
	const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, ENTRY_PATH, "--root", root], { env: { ...process.env, HOME: HELPER_HOME, PIDECK_SEARCH_COUNT_FILE: countFile }, stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => child.kill());
	let buffered = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdin.on("error", () => {});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const answered = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for the counted search")), GUARD_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			buffered += chunk;
			let index;
			while ((index = buffered.indexOf("\n")) >= 0) {
				const line = buffered.slice(0, index);
				buffered = buffered.slice(index + 1);
				const frame = JSON.parse(line);
				if (frame.id !== "count-search") continue;
				clearTimeout(timer);
				resolve(frame);
			}
		});
	});
	child.stdin.write(JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation: 0, id: "count-search", method: REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, params: params }) + "\n");
	const frame = await guard(answered, "the counted search");
	const exited = new Promise((resolve) => child.on("exit", resolve));
	child.stdin.end();
	assert.equal(await guard(exited, "the counted helper exit"), 0);
	assert.equal(stderr, "", "a counted helper still writes protocol frames only");
	return { frame: plain(frame), counts: JSON.parse(readFileSync(countFile, "utf8")) };
}

/** The last path segment of a counted opendir call, so an assertion names the directory it means. */
const directoryName = (opened) => opened.split(/[\\/]/).pop();

searchTest("the match ceiling converges on the current directory and never opens the next one", async (t) => {
	const root = tempDirectory(t, "pideck-search-converge-");
	for (const directory of ["aaa-bulk", "zzz-bulk"]) {
		mkdirSync(join(root, directory));
		for (let index = 0; index < 600; index += 1) writeFileSync(join(root, directory, "bulk-" + String(index).padStart(3, "0") + ".txt"), "");
	}
	// The count is taken from the helper's own filesystem calls, so "the sibling was never entered" is a
	// fact about opendir, not an inference from the entries that came back.
	const { frame, counts } = await searchWithCounts(t, root, { path: ".", query: "bulk" });
	assert.equal(frame.ok, true);
	const answer = plain(frame.result);
	assert.equal(answer.entries.length, REMOTE_HELPER_MAX_SEARCH_MATCHES);
	assert.equal(answer.truncated, true);
	// The comparisons stop where the ceiling is reached: the sibling directory's name was seen at the root
	// (it is a match of the query), and nothing inside it was ever listed.
	assert.equal(answer.scanned, REMOTE_HELPER_MAX_SEARCH_MATCHES);
	assert.equal(answer.entries[0].path, "aaa-bulk");
	assert.equal(answer.entries.at(-1).path, "zzz-bulk");
	assert.equal(
		answer.entries.some((entry) => entry.path.startsWith("zzz-bulk/")),
		false,
		"a directory the ceiling stopped at is never entered",
	);
	assert.deepEqual(counts.opened.map(directoryName), [directoryName(root), "aaa-bulk"], "the walk opened the requested root and the directory it was already in - and no other");
	assert.ok(counts.reads <= REMOTE_HELPER_MAX_SEARCH_SCANNED + 1, "the entry ceiling bounds the dirent reads of one call");
});

searchTest("one wide directory is read to its end, and the entry ceiling - not the match ceiling - bounds that", async (t) => {
	const root = tempDirectory(t, "pideck-search-wide-count-");
	const entries = 3000;
	for (let index = 0; index < entries; index += 1) writeFileSync(join(root, "bulk-" + String(index).padStart(4, "0") + ".txt"), "");
	const { frame, counts } = await searchWithCounts(t, root, { path: ".", query: "bulk" });
	const answer = plain(frame.result);
	assert.equal(answer.entries.length, REMOTE_HELPER_MAX_SEARCH_MATCHES);
	assert.equal(answer.truncated, true);
	// No comparison happens past the ceiling, which is what this value counts.
	assert.equal(answer.scanned, REMOTE_HELPER_MAX_SEARCH_MATCHES);
	// The directory itself is read to its end - every name has to be seen before its entries can be visited
	// in name order - and the entry ceiling is what bounds that read, an order of magnitude above this tree.
	assert.equal(counts.reads, entries + 1);
	assert.ok(counts.reads <= REMOTE_HELPER_MAX_SEARCH_SCANNED + 1);
	assert.deepEqual(counts.opened.map(directoryName), [directoryName(root)]);
});
