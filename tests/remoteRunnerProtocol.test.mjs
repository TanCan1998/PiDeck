import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * Contract-level proof of the runner handshake (plan §4.1 "Agent 通路"): the pure rules main and the frozen
 * runner body have to agree on. Nothing here starts a process — the body is driven for real in
 * remoteRunnerEntry.test.mjs — so this suite is about the shapes themselves: the two-token remote command with
 * its quoting and its ceiling, the single init line with every field rule and the frame cap, the two terminal
 * frames, and the closed code table.
 *
 * The division of labour is deliberate: this file proves what the *contract* refuses, the entry suite proves
 * that the deployed body refuses the same inputs and that it enforces the same numbers, and it repeats each
 * literal against the frozen source.
 */

const {
	REMOTE_RUNNER_CODE_INPUT_INVALID,
	REMOTE_RUNNER_CODES,
	REMOTE_RUNNER_KILL_CONFIRM_MS,
	REMOTE_RUNNER_LEASE_DIRECTORY_SEGMENTS,
	REMOTE_RUNNER_LEASE_VERSION,
	REMOTE_RUNNER_MAX_ARGV_LENGTH,
	REMOTE_RUNNER_MAX_ARG_LENGTH,
	REMOTE_RUNNER_MAX_INIT_FRAME_BYTES,
	REMOTE_RUNNER_MAX_PATH_LENGTH,
	REMOTE_RUNNER_MAX_TERM_GRACE_MS,
	REMOTE_RUNNER_MIN_ARGV_LENGTH,
	REMOTE_RUNNER_MIN_TERM_GRACE_MS,
	REMOTE_RUNNER_NONCE_PATTERN,
	REMOTE_RUNNER_POLL_MS,
	REMOTE_RUNNER_PROTOCOL_VERSION,
	REMOTE_RUNNER_TERM_GRACE_ENV,
	REMOTE_RUNNER_TERM_GRACE_MS,
	buildRemoteRunnerCommand,
	buildRemoteRunnerInitFrame,
	decodeRemoteRunnerInitFrame,
	decodeRemoteRunnerResultFrame,
	isRemoteRunnerAbsolutePath,
} = loadTsCommonJs("src/main/remote/RemoteRunnerContract.ts");
const { quotePosixArgument } = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");

const NODE = "/usr/bin/node";
const PI = "/home/dev/.nvm/versions/node/v24.11.0/bin/pi";
const RUNNER = `/home/dev/.pideck/remote-host/bundles/${"a".repeat(64)}/runner.mjs`;
const CWD = "/home/dev/project";
/** 20 characters of the nonce alphabet; the boundary lengths are exercised separately. */
const NONCE = "runner-protocol-0001";

/** Cross-realm comparisons go through JSON, because the production objects live in another VM realm. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const text = (value) => JSON.stringify(value);
const validInit = (overrides = {}) => ({ v: 1, op: "start", nonce: NONCE, cwd: CWD, argv: [NODE, PI, "--mode", "rpc"], ...overrides });
const without = (value, key) => {
	const copy = { ...value };
	delete copy[key];
	return copy;
};

/** The refusal code of one call, or null when it did not refuse at all. */
function codeOf(fn) {
	try {
		fn();
		return null;
	} catch (error) {
		return error.message;
	}
}

const refuses = (fn, label) => assert.equal(codeOf(fn), REMOTE_RUNNER_CODE_INPUT_INVALID, label);

test("the remote command is the fixed two-token template, quoted for a POSIX shell", () => {
	assert.equal(buildRemoteRunnerCommand(RUNNER, NODE), [quotePosixArgument(NODE), quotePosixArgument(RUNNER)].join(" "));
	assert.equal(buildRemoteRunnerCommand(RUNNER, NODE), `'/usr/bin/node' '${RUNNER}'`, "the interpreter comes first, the runner entry second");
	// Nothing user-shaped is ever interpolated, and a path the remote shell would split or expand stays one
	// literal token: the space, the command substitution and the apostrophe are all inside single quotes.
	const runner = "/home/dev/my project/$(touch pwned)/it's/runner.mjs";
	assert.equal(buildRemoteRunnerCommand(runner, "/opt/my node/bin/node"), "'/opt/my node/bin/node' '/home/dev/my project/$(touch pwned)/it'\\''s/runner.mjs'");
	assert.equal((buildRemoteRunnerCommand(RUNNER, NODE).match(/'/g) ?? []).length % 2, 0, "quotes are balanced");
});

test("a path that is not absolute POSIX is refused with the stable input code", () => {
	const rejectedPaths = ["relative/path/runner.mjs", "", "/", "runner.mjs", "/home/dev/runner.mjs/", "/home/dev/../runner.mjs", "/home//dev/runner.mjs", "/home/dev/\u0001/runner.mjs", "C:\\node\\node.exe", `/${"x".repeat(4096)}`];
	for (const value of rejectedPaths) {
		refuses(() => buildRemoteRunnerCommand(value, NODE), `runner path ${JSON.stringify(value)}`);
		refuses(() => buildRemoteRunnerCommand(RUNNER, value), `node path ${JSON.stringify(value)}`);
		assert.equal(isRemoteRunnerAbsolutePath(value), false, `${JSON.stringify(value)} must not be a runner path`);
	}
	for (const value of [undefined, null, 42, {}, [], true]) {
		refuses(() => buildRemoteRunnerCommand(value, NODE), `runner path ${String(value)}`);
		refuses(() => buildRemoteRunnerCommand(RUNNER, value), `node path ${String(value)}`);
	}
	assert.equal(isRemoteRunnerAbsolutePath(RUNNER), true);
	assert.equal(isRemoteRunnerAbsolutePath("/usr/bin/node"), true);
});

test("two long paths cannot overflow the pinned ssh remoteCommand ceiling", () => {
	// One path is at its ceiling; two of them plus quoting are 8197 characters, past the 8192 the argv
	// boundary accepts, so the builder has to refuse rather than emit what the launcher would reject.
	const longest = (length) => `/${"a".repeat(length - 1)}`;
	refuses(() => buildRemoteRunnerCommand(longest(REMOTE_RUNNER_MAX_PATH_LENGTH), longest(REMOTE_RUNNER_MAX_PATH_LENGTH)), "two paths at the ceiling");
	const command = buildRemoteRunnerCommand(longest(4093), longest(4093));
	assert.equal(command.length, 8191, "the boundary fixture really does sit one character under the ceiling");
	assert.ok(command.length <= 8192, `the assembled command must fit (${command.length})`);
	refuses(() => buildRemoteRunnerCommand(longest(4094), longest(4094)), "one character more per path");
});

test("the init frame round-trips as the one line a runner accepts", () => {
	const argv = [NODE, PI, "--mode", "rpc", "--session", "/home/dev/sessions/s.jsonl"];
	const line = buildRemoteRunnerInitFrame({ nonce: NONCE, cwd: CWD, argv });
	// The terminator belongs to the transport, exactly as it does for the bootstrap frames.
	assert.equal(line.includes("\n"), false, "the builder emits the line without its newline");
	assert.deepEqual(plain(decodeRemoteRunnerInitFrame(line)), { v: 1, op: "start", nonce: NONCE, cwd: CWD, argv });
	assert.deepEqual(plain(decodeRemoteRunnerInitFrame(Buffer.from(line, "utf8"))), { v: 1, op: "start", nonce: NONCE, cwd: CWD, argv }, "the byte form decodes to the same frame");
	assert.deepEqual(Object.keys(JSON.parse(line)), ["v", "op", "nonce", "cwd", "argv"], "the line is one NDJSON object with exactly the contract fields");
});

test("every malformed init frame is refused", () => {
	const extra = Array.from({ length: REMOTE_RUNNER_MAX_ARGV_LENGTH - 2 + 1 }, () => "--flag");
	const cases = [
		["a version other than 1", text({ ...validInit(), v: 2 })],
		["a version that is a string", text({ ...validInit(), v: "1" })],
		["no version", text(without(validInit(), "v"))],
		["an op other than start", text({ ...validInit(), op: "start2" })],
		["a numeric op", text({ ...validInit(), op: 1 })],
		["no op", text(without(validInit(), "op"))],
		["a nonce one character short", text({ ...validInit(), nonce: "a".repeat(15) })],
		["a nonce one character too long", text({ ...validInit(), nonce: "a".repeat(65) })],
		["a nonce with a separator", text({ ...validInit(), nonce: `${"a".repeat(15)}/b` })],
		["a nonce with a newline", text({ ...validInit(), nonce: `${"a".repeat(15)}\n` })],
		["a nonce that is not a string", text({ ...validInit(), nonce: 42 })],
		["no nonce", text(without(validInit(), "nonce"))],
		["a relative cwd", text({ ...validInit(), cwd: "home/dev/project" })],
		["a cwd with a traversal segment", text({ ...validInit(), cwd: `${CWD}/../project2` })],
		["a cwd with an empty segment", text({ ...validInit(), cwd: "/home//dev" })],
		["a cwd with a trailing separator", text({ ...validInit(), cwd: `${CWD}/` })],
		["a cwd that is the filesystem root", text({ ...validInit(), cwd: "/" })],
		["a cwd with a control byte", text({ ...validInit(), cwd: `${CWD}\u0000` })],
		["a cwd past the path ceiling", text({ ...validInit(), cwd: `/${"a".repeat(REMOTE_RUNNER_MAX_PATH_LENGTH)}` })],
		["a cwd that is not a string", text({ ...validInit(), cwd: 7 })],
		["a one-element argv", text({ ...validInit(), argv: [NODE] })],
		["an argv one element past the ceiling", text({ ...validInit(), argv: [NODE, PI, ...extra] })],
		["an argv that is not an array", text({ ...validInit(), argv: "node pi" })],
		["no argv", text(without(validInit(), "argv"))],
		["a relative interpreter", text({ ...validInit(), argv: ["node", PI] })],
		["a relative pi entry", text({ ...validInit(), argv: [NODE, "pi"] })],
		["a pi entry with a traversal segment", text({ ...validInit(), argv: [NODE, "/home/dev/../pi"] })],
		["an argument with a newline", text({ ...validInit(), argv: [NODE, PI, "--prompt", "line\nbreak"] })],
		["an argument past the argument ceiling", text({ ...validInit(), argv: [NODE, PI, "x".repeat(REMOTE_RUNNER_MAX_ARG_LENGTH + 1)] })],
		["an argument that is not a string", text({ ...validInit(), argv: [NODE, PI, 9] })],
		["a frame that is a JSON array", "[]"],
		["a frame that is a JSON scalar", "42"],
		["a frame that is not JSON", "{not json"],
		["an empty line", ""],
	];
	for (const [title, line] of cases) {
		refuses(() => decodeRemoteRunnerInitFrame(line), title);
		refuses(() => decodeRemoteRunnerInitFrame(Buffer.from(line, "utf8")), `${title} (bytes)`);
	}
	// A byte sequence that is not UTF-8 is not a frame at all: a lossy decode would turn it into U+FFFD and
	// let a mangled path through as if it had been spelled that way.
	const mangle = Buffer.concat([Buffer.from('{"v":1,"op":"start","nonce":"', "utf8"), Buffer.from([0xff, 0xfe]), Buffer.from('","cwd":"/home/dev","argv":["/usr/bin/node","/usr/bin/pi"]}', "utf8")]);
	refuses(() => decodeRemoteRunnerInitFrame(mangle), "a non-utf8 frame");
});

test("the init frame cap counts the terminator, and the boundary is exact", () => {
	const overCap = text({ ...validInit(), argv: [NODE, PI, "a".repeat(4096), "b".repeat(4096), "c".repeat(4096)] });
	assert.ok(Buffer.byteLength(overCap, "utf8") + 1 > REMOTE_RUNNER_MAX_INIT_FRAME_BYTES, "the fixture really is over the cap");
	refuses(() => decodeRemoteRunnerInitFrame(overCap), "a frame past the cap");
	refuses(() => buildRemoteRunnerInitFrame({ nonce: NONCE, cwd: CWD, argv: [NODE, PI, "a".repeat(4096), "b".repeat(4096), "c".repeat(4096)] }), "the builder refuses the same frame");

	// A padding argument grows the encoded frame one byte at a time, so the boundary is hit exactly. The
	// fixed argument in front of it puts the reachable range across the cap.
	const atCap = (() => {
		for (let length = 0; length <= REMOTE_RUNNER_MAX_ARG_LENGTH; length += 1) {
			const line = text({ ...validInit(), argv: [NODE, PI, "a".repeat(REMOTE_RUNNER_MAX_ARG_LENGTH), "x".repeat(length)] });
			if (Buffer.byteLength(line, "utf8") + 1 === REMOTE_RUNNER_MAX_INIT_FRAME_BYTES) return line;
		}
		throw new Error("could not build a frame of exactly the cap size");
	})();
	assert.equal(Buffer.byteLength(atCap, "utf8") + 1, REMOTE_RUNNER_MAX_INIT_FRAME_BYTES);
	assert.deepEqual(plain(decodeRemoteRunnerInitFrame(atCap)).argv.slice(0, 2), [NODE, PI], "a frame of exactly the cap is accepted");
	const oneByteMore = `${atCap.slice(0, -2)}y${atCap.slice(-2)}`;
	assert.equal(Buffer.byteLength(oneByteMore, "utf8") + 1, REMOTE_RUNNER_MAX_INIT_FRAME_BYTES + 1);
	refuses(() => decodeRemoteRunnerInitFrame(oneByteMore), "one byte past the cap");
});

test("a ready frame is decoded exactly and every deviation is refused", () => {
	const ready = { v: 1, op: "ready", nonce: NONCE, pid: 4242, pgid: 4242, startedAt: "2026-10-11T08:21:55.825Z" };
	assert.deepEqual(plain(decodeRemoteRunnerResultFrame(text(ready))), ready);
	assert.deepEqual(plain(decodeRemoteRunnerResultFrame(Buffer.from(text(ready), "utf8"))), ready, "the byte form decodes to the same frame");
	const deviations = [
		["a version other than 1", { ...ready, v: 2 }],
		["an unknown op", { ...ready, op: "started" }],
		["a nonce outside the shape", { ...ready, nonce: "short" }],
		["a nonce that is not a string", { ...ready, nonce: 1 }],
		["a pid that is a string", { ...ready, pid: "4242" }],
		["a pid that is init", { ...ready, pid: 1 }],
		["a fractional pid", { ...ready, pid: 4242.5 }],
		["a pgid that is not the pid", { ...ready, pgid: 4243 }],
		["no pgid", without(ready, "pgid")],
		["a startedAt that is not an instant", { ...ready, startedAt: "2026-10-11" }],
		["a startedAt that is not a string", { ...ready, startedAt: 0 }],
		["no startedAt", without(ready, "startedAt")],
	];
	for (const [title, frame] of deviations) refuses(() => decodeRemoteRunnerResultFrame(text(frame)), title);
	for (const line of ["[]", "42", "null", "", "{oops", '{"v":1}']) refuses(() => decodeRemoteRunnerResultFrame(line), line);
});

test("an error frame carries one code of the closed table", () => {
	assert.deepEqual([...REMOTE_RUNNER_CODES], ["RUNNER_INPUT_INVALID", "RUNNER_SPAWN_FAILED", "RUNNER_LEASE_UNWRITABLE", "RUNNER_INTERNAL"]);
	assert.equal(REMOTE_RUNNER_CODE_INPUT_INVALID, "RUNNER_INPUT_INVALID");
	for (const code of REMOTE_RUNNER_CODES) {
		assert.match(code, /^RUNNER_[A-Z_]+$/, code);
		assert.deepEqual(plain(decodeRemoteRunnerResultFrame(text({ v: 1, op: "error", code }))), { v: 1, op: "error", code });
	}
	// A code from another domain, free text and a missing code are all the same refusal: the vocabulary is
	// closed, so a caller can branch on the string without ever matching a message.
	for (const code of ["HELPER_INTERNAL", "RUNNER_", "runner_input_invalid", "BOOTSTRAP_INTERNAL", 42, null]) refuses(() => decodeRemoteRunnerResultFrame(text({ v: 1, op: "error", code })), String(code));
	refuses(() => decodeRemoteRunnerResultFrame(text({ v: 1, op: "error" })), "no code");
	// Unknown fields are ignored on purpose, in both directions: a later runner or launcher may add one
	// without the other side having to refuse a frame it fully understood.
	assert.deepEqual(plain(decodeRemoteRunnerResultFrame(text({ v: 1, op: "error", code: "RUNNER_INTERNAL", detail: "x" }))), { v: 1, op: "error", code: "RUNNER_INTERNAL" });
	assert.deepEqual(plain(decodeRemoteRunnerResultFrame(text({ v: 1, op: "ready", nonce: NONCE, pid: 4242, pgid: 4242, startedAt: "2026-10-11T08:21:55.825Z", region: "eu" }))).region, undefined);
});

test("the declared limits are the ones the frozen body repeats", () => {
	assert.equal(REMOTE_RUNNER_PROTOCOL_VERSION, 1);
	assert.equal(REMOTE_RUNNER_MAX_INIT_FRAME_BYTES, 8192);
	assert.equal(REMOTE_RUNNER_MIN_ARGV_LENGTH, 2);
	assert.equal(REMOTE_RUNNER_MAX_ARGV_LENGTH, 32);
	assert.equal(REMOTE_RUNNER_MAX_PATH_LENGTH, 4096);
	assert.equal(REMOTE_RUNNER_MAX_ARG_LENGTH, 4096);
	assert.equal(REMOTE_RUNNER_NONCE_PATTERN, "^[A-Za-z0-9_-]{16,64}$");
	assert.deepEqual([...REMOTE_RUNNER_LEASE_DIRECTORY_SEGMENTS], [".pideck", "remote-host", "leases"]);
	assert.equal(REMOTE_RUNNER_LEASE_VERSION, 1);
	assert.equal(REMOTE_RUNNER_TERM_GRACE_MS, 5000);
	assert.equal(REMOTE_RUNNER_MIN_TERM_GRACE_MS, 1);
	assert.equal(REMOTE_RUNNER_MAX_TERM_GRACE_MS, 60_000);
	assert.ok(REMOTE_RUNNER_MIN_TERM_GRACE_MS < REMOTE_RUNNER_TERM_GRACE_MS && REMOTE_RUNNER_TERM_GRACE_MS < REMOTE_RUNNER_MAX_TERM_GRACE_MS, "the default grace sits inside its own bounds, so a harness can only shorten it");
	assert.equal(REMOTE_RUNNER_TERM_GRACE_ENV, "PIDECK_REMOTE_RUNNER_TERM_GRACE_MS");
	assert.equal(REMOTE_RUNNER_KILL_CONFIRM_MS, 2000);
	assert.equal(REMOTE_RUNNER_POLL_MS, 50);
	// Both nonce boundaries are legal, and one character outside them is not.
	for (const nonce of ["a".repeat(16), "a".repeat(64), "A-b_0".repeat(4)]) {
		assert.equal(plain(decodeRemoteRunnerInitFrame(buildRemoteRunnerInitFrame({ nonce, cwd: CWD, argv: [NODE, PI] }))).nonce, nonce, nonce);
	}
	for (const nonce of ["a".repeat(15), "a".repeat(65)]) refuses(() => buildRemoteRunnerInitFrame({ nonce, cwd: CWD, argv: [NODE, PI] }), nonce);
});
