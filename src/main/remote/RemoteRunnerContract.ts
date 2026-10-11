/**
 * Frozen remote runner contract (Phase 4 P4.2, plan §4.1 "Agent 通路" and §7.2): the frames, bounds and
 * stable codes the two halves of the runner handshake agree on, plus the two pure builders main uses to
 * reach a runner at all — the fixed remote command and the one init frame.
 *
 * Why a contract module instead of straight launcher code: the runner is a content-addressed artifact
 * (`RemoteRunnerEntry`) that owns a `pi --mode rpc` process group on a host PiDeck does not own, so what it
 * accepts on stdin and what it may answer on stdout is a wire contract in the same sense
 * `RemoteHelperContract` is one for the helper. Everything here is a literal or a pure function — no
 * filesystem, no child process, no network — and the frozen body repeats every literal under test, because it
 * cannot import anything.
 *
 * The shapes, which the frozen body implements word for word:
 *
 * - startup is `<node> <runnerPath>` and nothing else: the remote command carries no cwd, no pi argument and
 *   no user text (plan §4.1), so nothing a user types can reach a remote shell.
 * - stdin carries exactly one init frame, `{v:1,op:"start",nonce,cwd,argv}`, at most
 *   REMOTE_RUNNER_MAX_INIT_FRAME_BYTES including its newline. Everything a runner is asked to do — where to
 *   run, what to run, under which identity — is inside that one frame; a frame that does not satisfy the
 *   rules below is refused with one error frame and no process at all.
 * - stdout carries exactly one handshake frame and then pi's own bytes: `ready` (written only after the lease
 *   is durable) or `error`. The runner writes no frame of its own after `ready` and never parses or reframes
 *   pi's JSONL, because a supervisor that understood the conversation would have to change with it (§7.2).
 *
 * Codes: REMOTE_RUNNER_CODES is the whole vocabulary an `error` frame may carry, and one code is the entire
 * message — a path, a nonce or a remote body never travels inside one. The builders here throw
 * RUNNER_INPUT_INVALID for the local half of the same rule (a runner path, an init frame or a deployment
 * result that would violate the runner's input contract) instead of inventing a second code family, so main
 * maps one table to the UI and a remote refusal answers with the same word a local one uses.
 */

import { quotePosixArgument } from "./RemoteBootstrapContract";
import { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } from "./RemoteHelperContract";

/** Wire version of the runner handshake. A runner of another version is not launched. */
export const REMOTE_RUNNER_PROTOCOL_VERSION = 1;

/**
 * Stable runner codes. RUNNER_INPUT_INVALID is the refusal of a frame the runner cannot read (and of the
 * local input the builders below reject), RUNNER_SPAWN_FAILED the failure of `spawn` itself,
 * RUNNER_LEASE_UNWRITABLE the unusable lease location, and RUNNER_INTERNAL everything the runner cannot
 * attribute — a missing builtin, a platform without POSIX process groups, a lost invariant.
 */
export const REMOTE_RUNNER_CODE_INPUT_INVALID = "RUNNER_INPUT_INVALID";
export const REMOTE_RUNNER_CODES = [REMOTE_RUNNER_CODE_INPUT_INVALID, "RUNNER_SPAWN_FAILED", "RUNNER_LEASE_UNWRITABLE", "RUNNER_INTERNAL"] as const;
export type RemoteRunnerCode = (typeof REMOTE_RUNNER_CODES)[number];

/** One init frame, its terminator included: the runner refuses a line at or past this cap. */
export const REMOTE_RUNNER_MAX_INIT_FRAME_BYTES = 8192;
/** argv always carries the interpreter and the pi entry, so two is the floor and 32 the ceiling. */
export const REMOTE_RUNNER_MIN_ARGV_LENGTH = 2;
export const REMOTE_RUNNER_MAX_ARGV_LENGTH = 32;
/** Ceiling for cwd and for argv[0]/argv[1]; they are the paths of the fixed remote command template. */
export const REMOTE_RUNNER_MAX_PATH_LENGTH = 4096;
/** Ceiling for every remaining argument (a pi flag or one of its values). */
export const REMOTE_RUNNER_MAX_ARG_LENGTH = 4096;
/**
 * One run's nonce, and the shape the lease file name is built from. It is deliberately the looser shape
 * (`[A-Za-z0-9_-]{16,64}`) rather than the bootstrap handshake's own stricter one: the runner is a separate
 * artifact with a separate contract, and a launcher that generated a bootstrap nonce still satisfies it.
 * The pattern is exported as its source because the frozen body repeats that literal.
 */
export const REMOTE_RUNNER_NONCE_PATTERN = "^[A-Za-z0-9_-]{16,64}$";
/** One nonce must not be able to name a file outside the lease directory. */
const NONCE = new RegExp(REMOTE_RUNNER_NONCE_PATTERN);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Lease identity: `<home>/.pideck/remote-host/leases/<nonce>.json`, holding `{v,nonce,pid,pgid,startedAt,
 * command,args}`. The layout is part of the contract because it is what a later reconciliation reads after a
 * runner died without removing its lease: the directory has to be the one the deploy root already owns, and
 * the file name has to be reproducible from the nonce alone.
 */
export const REMOTE_RUNNER_LEASE_VERSION = 1;
export const REMOTE_RUNNER_LEASE_DIRECTORY_SEGMENTS = [".pideck", "remote-host", "leases"] as const;

/**
 * The bounded wait between the group SIGTERM and its SIGKILL, and the environment variable a harness may use
 * to shorten it (never to remove it: a value outside the bounds below is ignored). Reclamation has to be
 * bounded so a group that ignores SIGTERM cannot keep a runner — and therefore an SSH channel — alive.
 */
export const REMOTE_RUNNER_TERM_GRACE_MS = 5000;
export const REMOTE_RUNNER_MIN_TERM_GRACE_MS = 1;
export const REMOTE_RUNNER_MAX_TERM_GRACE_MS = 60_000;
export const REMOTE_RUNNER_TERM_GRACE_ENV = "PIDECK_REMOTE_RUNNER_TERM_GRACE_MS";
/** How long the runner keeps looking after the SIGKILL before it gives up and keeps the lease. */
export const REMOTE_RUNNER_KILL_CONFIRM_MS = 2000;
/** Interval between two liveness probes of the group. */
export const REMOTE_RUNNER_POLL_MS = 50;

export type RemoteRunnerInitFrame = { v: 1; op: "start"; nonce: string; cwd: string; argv: readonly string[] };
/** `pid` and `pgid` are equal by construction: the pi process is a detached group leader of its own. */
export type RemoteRunnerReadyFrame = { v: 1; op: "ready"; nonce: string; pid: number; pgid: number; startedAt: string };
export type RemoteRunnerErrorFrame = { v: 1; op: "error"; code: RemoteRunnerCode };
export type RemoteRunnerResultFrame = RemoteRunnerReadyFrame | RemoteRunnerErrorFrame;
export type RemoteRunnerInitInput = { nonce: string; cwd: string; argv: readonly string[] };

/** ISO 8601 in the single shape `Date#toISOString` produces, which is the only shape the runner sends. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(code: RemoteRunnerCode): never {
	throw new Error(code);
}

/**
 * The one path shape every path in this contract must have: absolute POSIX, bounded, no control byte, no
 * trailing separator, no empty/`.`/`..` segment and not the filesystem root (which a trailing separator rule
 * already excludes). Rejecting rather than normalizing is deliberate — the caller either has the canonical
 * path the remote reported or it has a bug, and a silently trimmed slash would hide it. A Windows path can
 * never satisfy this, which is the point: the remote side of this protocol is POSIX only.
 */
export function isRemoteRunnerAbsolutePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_RUNNER_MAX_PATH_LENGTH) return false;
	if (!value.startsWith("/") || value.endsWith("/") || CONTROL_CHARS.test(value)) return false;
	return !value
		.slice(1)
		.split("/")
		.some((segment) => segment === "" || segment === "." || segment === "..");
}

function requireAbsolutePath(value: unknown): string {
	if (!isRemoteRunnerAbsolutePath(value)) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	return value;
}

/**
 * Read an init frame the way the frozen runner does. `null` means refused; the caller turns that into the one
 * RUNNER_INPUT_INVALID error frame. Unknown fields are ignored on purpose (a later launcher may add one
 * without an older runner refusing the frame), while every field that is read has to satisfy the same rules
 * the body enforces: version and op, the nonce shape, a POSIX absolute cwd, an argv of 2..32 bounded
 * control-free arguments whose first two are the interpreter and the pi entry.
 */
function readInitFrame(value: unknown): RemoteRunnerInitFrame | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const frame = value as Record<string, unknown>;
	if (frame.v !== 1 || frame.op !== "start") return null;
	const nonce = frame.nonce;
	if (typeof nonce !== "string" || !NONCE.test(nonce)) return null;
	const cwd = frame.cwd;
	if (!isRemoteRunnerAbsolutePath(cwd)) return null;
	const argv = frame.argv;
	if (!Array.isArray(argv) || argv.length < REMOTE_RUNNER_MIN_ARGV_LENGTH || argv.length > REMOTE_RUNNER_MAX_ARGV_LENGTH) return null;
	const args: string[] = [];
	for (const [index, entry] of argv.entries()) {
		if (typeof entry !== "string" || entry.length > REMOTE_RUNNER_MAX_ARG_LENGTH || CONTROL_CHARS.test(entry)) return null;
		if (index < 2 && !isRemoteRunnerAbsolutePath(entry)) return null;
		args.push(entry);
	}
	return { v: 1, op: "start", nonce, cwd, argv: args };
}

function decodeLine(line: string | Uint8Array): string {
	if (typeof line === "string") return line;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(line);
	} catch {
		return fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	}
}

function readJsonLine(line: string | Uint8Array): unknown {
	const text = decodeLine(line);
	try {
		return JSON.parse(text);
	} catch {
		return fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	}
}

/**
 * Decode one init line exactly as the frozen runner reads it: the line *without* its terminator, because the
 * runner cuts it out of the byte stream itself and counts the newline against the cap. Reaching the cap
 * (bytes + 1 > REMOTE_RUNNER_MAX_INIT_FRAME_BYTES) is therefore a refusal here too, so a launcher that built
 * an over-cap line fails before it writes anything.
 */
export function decodeRemoteRunnerInitFrame(line: string | Uint8Array): RemoteRunnerInitFrame {
	const bytes = typeof line === "string" ? Buffer.byteLength(line, "utf8") : line.byteLength;
	if (bytes + 1 > REMOTE_RUNNER_MAX_INIT_FRAME_BYTES) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	const frame = readInitFrame(readJsonLine(line));
	if (frame === null) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	return frame;
}

/**
 * Serialize one init line: the exact bytes a launcher writes, newline excluded (the transport adds it, the
 * way `BootstrapSession.write` does). The frame is validated through the same reader above, so this builder
 * cannot emit something the runner would refuse, and the cap is applied to the encoded form.
 */
export function buildRemoteRunnerInitFrame(input: RemoteRunnerInitInput): string {
	if (typeof input !== "object" || input === null) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	const frame = readInitFrame({ v: 1, op: "start", nonce: input.nonce, cwd: input.cwd, argv: input.argv });
	if (frame === null) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	const line = JSON.stringify(frame);
	if (Buffer.byteLength(line, "utf8") + 1 > REMOTE_RUNNER_MAX_INIT_FRAME_BYTES) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	return line;
}

/**
 * Decode one handshake line from the runner's stdout: `ready` or `error`, and nothing else.
 *
 * The line is the part before the first newline; what follows it in the same read is pi's own bytes and is the
 * caller's to preserve byte for byte (plan §4.1), which is why this function takes a line and never a stream.
 * `ready` is only admitted with the nonce of this run, a pid/pgid pair that is a real process group (`pgid`
 * equals `pid` by construction), and an ISO instant; `error` only with a code of the closed table above.
 */
export function decodeRemoteRunnerResultFrame(line: string | Uint8Array): RemoteRunnerResultFrame {
	const value = readJsonLine(line);
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	const frame = value as Record<string, unknown>;
	if (frame.v !== 1) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	if (frame.op === "error") {
		const code = frame.code;
		if (typeof code !== "string" || !REMOTE_RUNNER_CODES.some((known) => known === code)) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
		return { v: 1, op: "error", code: code as RemoteRunnerCode };
	}
	if (frame.op !== "ready") fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	if (typeof frame.nonce !== "string" || !NONCE.test(frame.nonce)) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	const pid = readProcessId(frame.pid);
	const pgid = readProcessId(frame.pgid);
	if (pid !== pgid) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	if (typeof frame.startedAt !== "string" || !ISO_INSTANT.test(frame.startedAt)) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	return { v: 1, op: "ready", nonce: frame.nonce, pid, pgid, startedAt: frame.startedAt };
}

/** A pid is accepted only where a spawned child could be named: 1 is init, which this runner never spawned. */
function readProcessId(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 2) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	return value;
}

/**
 * The one remote command that starts a deployed runner: `'<node>' '<runnerPath>'`, two quoted tokens and
 * nothing else.
 *
 * The interpreter comes first because the deployed runner is a `.mjs` file and the same reasoning as
 * `buildRemotePiVersionCommand` applies: the remote login shell is the only thing that splits this string, so
 * every token is validated here and then quoted individually, and the cwd, the pi arguments and any user text
 * travel in the init frame instead of in a command line. The parameters follow the pi discovery builder's
 * order (entry first, interpreter second) so the two call sites read the same way.
 */
export function buildRemoteRunnerCommand(runnerPath: string, nodePath: string): string {
	const command = [quotePosixArgument(requireAbsolutePath(nodePath)), quotePosixArgument(requireAbsolutePath(runnerPath))].join(" ");
	// Two 4096-character paths plus quoting exceed the pinned ssh remoteCommand ceiling, which lives in
	// another domain: refuse here with this contract's code instead of letting that boundary do it.
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) fail(REMOTE_RUNNER_CODE_INPUT_INVALID);
	return command;
}
