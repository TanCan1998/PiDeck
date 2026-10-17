/**
 * Remote terminal runner entry (security review F3, plan §6.5.2): the fixed program main launches with
 * `ssh -tt` after the helper minted a one-shot launch ticket, plus the identity of the file a deploy bundle
 * uploads it as.
 *
 * Why a frozen string instead of a real module, like `RemoteRunnerEntry`: a deployed bundle is
 * content-addressed, so the code and the hash that names it must be the same object. The test suite asserts
 * the bytes (REMOTE_TERMINAL_RUNNER_ENTRY_SHA256) as well as the behaviour against a real PTY.
 *
 * The body owns no launch policy. It captures the borrowed termios state, disables echo so the init frame
 * cannot be echoed, writes the fixed READY frame, reads one bounded newline-terminated base64url init frame
 * ({v:1,ticketRef}), consumes the helper's ticket atomically (rename, then open O_NOFOLLOW, then strict schema
 * and expiry/bundle/cwd re-checks), restores termios on every path, records the selected login shell in the
 * fixed START frame and hands that shell the TTY. Every failure is one bounded ERROR frame after the restore
 * and a non-zero exit; win32 fails closed before touching the filesystem.
 *
 * Editing the body is a protocol change: update REMOTE_TERMINAL_RUNNER_ENTRY_VERSION and the frozen digest in
 * the same commit.
 */

/** File name the terminal runner is uploaded and executed under inside an immutable deploy bundle (§168). */
export const REMOTE_TERMINAL_RUNNER_ENTRY_FILE_NAME = "terminal-runner.mjs";

/** Terminal runner build identity; it is a literal in the frozen source as well. */
export const REMOTE_TERMINAL_RUNNER_ENTRY_VERSION = "1.0.1";

/** The frozen terminal runner body; see the module comment for the frame and ticket contract. */
export const REMOTE_TERMINAL_RUNNER_INLINE_SOURCE = String.raw`"use strict";
/* Remote terminal runner for terminal-runner build 1.0.1 (plan section 6.5.2 / security review F3): the fixed program main launches over ssh -tt with a one-shot ticket. It owns no launch policy: it consumes the helper-minted ticket atomically, borrows the terminal only long enough to read one bounded init frame, restores termios, then hands the account login shell a clean TTY. */
const fs = process.getBuiltinModule("node:fs");
const posix = process.getBuiltinModule("node:path");
const cp = process.getBuiltinModule("node:child_process");
const TICKETS_DIRECTORY = "terminal-tickets";
const READY_FRAME = "\u001ePIDECK_TERMINAL/1 READY\u001f";
const START_PREFIX = "\u001ePIDECK_TERMINAL/1 START ";
const ERROR_PREFIX = "\u001ePIDECK_TERMINAL/1 ERROR ";
const FRAME_SUFFIX = "\u001f";
const REF = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{64}$/;
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_TICKET_BYTES = 4096;
const MAX_INIT_CHARS = 1024;
const INPUT_TIMEOUT_MS = 10000;
const STTY_TIMEOUT_MS = 5000;
const SHELL_PATH_MAX_BYTES = 4096;
const TICKET_KEYS = ["v", "kind", "projectId", "hostId", "routeDigest", "cwd", "bundleSha256", "ticketRef", "expiresAt"];
let savedTermios = null;
let claimPath = null;
let sttyPath = null;
let started = false;
/* One frame writer on fd 1, the TTY: synchronous bytes, never a buffered stream that a later spawn could reorder. */
function emitFrame(text) { fs.writeSync(1, text + "\r\n"); }
function emitError(code) { emitFrame(ERROR_PREFIX + code + FRAME_SUFFIX); }
function restoreTermios() { if (savedTermios === null) return; const saved = savedTermios; savedTermios = null; try { cp.spawnSync(sttyPath, [saved], { stdio: [0, "ignore", "ignore"], timeout: STTY_TIMEOUT_MS }); } catch {} }
function codeOf(error) { const message = error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : ""; return /^TERMINAL_[A-Z_]{1,64}$/.test(message) ? message : "TERMINAL_INTERNAL"; }
function fail(code) { if (started === true) return; started = true; restoreTermios(); if (claimPath !== null) { try { fs.unlinkSync(claimPath); } catch {} claimPath = null; } try { emitError(code); } catch {} process.exit(1); }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/* The deploy root and bundle hash are read from our own path: <deployRoot>/bundles/<64hex>/terminal-runner.mjs. */
function readOwnLocation() { const entry = process.argv[1]; if (typeof entry !== "string" || entry.length === 0 || entry.length > 8192 || entry.charAt(0) !== "/" || CONTROL.test(entry)) return null; const parts = entry.split("/"); if (parts.length < 5 || parts[parts.length - 1] !== "terminal-runner.mjs" || parts[parts.length - 3] !== "bundles" || SHA.test(parts[parts.length - 2]) === false) return null; for (let index = 1; index < parts.length - 3; index += 1) { if (parts[index] === "" || parts[index] === "." || parts[index] === "..") return null; } const deployRoot = parts.slice(0, parts.length - 3).join("/"); if (deployRoot === "" || deployRoot === "/") return null; return { deployRoot: deployRoot, bundleSha256: parts[parts.length - 2] }; }
/* stty is resolved once from absolute PATH entries only; the fixed fallbacks are the last resort. */
function resolveStty() { const pathValue = typeof process.env.PATH === "string" ? process.env.PATH : ""; for (const directory of pathValue.split(":")) { if (directory.charAt(0) !== "/" || CONTROL.test(directory)) continue; const candidate = directory + "/stty"; try { const stats = fs.statSync(candidate); if (stats.isFile() === false) continue; fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {} } for (const candidate of ["/bin/stty", "/usr/bin/stty"]) { try { const stats = fs.statSync(candidate); if (stats.isFile() === false) continue; fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {} } return null; }
/* Capture the borrowed terminal, then disable echo so the init frame can never appear on the wire back to main. */
function captureTermios() { if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) throw new Error("TERMINAL_TERMIOS_FAILED"); const snapshot = cp.spawnSync(sttyPath, ["-g"], { stdio: [0, "pipe", "pipe"], timeout: STTY_TIMEOUT_MS, encoding: "utf8" }); const saved = typeof snapshot.stdout === "string" ? snapshot.stdout.trim() : ""; if (snapshot.status !== 0 || saved.length === 0 || saved.length > 1024 || /^[0-9a-fA-F:]+$/.test(saved) === false) throw new Error("TERMINAL_TERMIOS_FAILED"); savedTermios = saved; const disabled = cp.spawnSync(sttyPath, ["-echo"], { stdio: [0, "ignore", "pipe"], timeout: STTY_TIMEOUT_MS, encoding: "utf8" }); if (disabled.status !== 0) throw new Error("TERMINAL_TERMIOS_FAILED"); }
/* One newline-terminated line from stdin; canonical mode delivers the line, the timer bounds a silent peer. */
function readInitFrame() { return new Promise(function (resolve, reject) { let buffered = ""; let settled = false; const timer = setTimeout(function () { finish(new Error("TERMINAL_INPUT_TIMEOUT")); }, INPUT_TIMEOUT_MS); function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); process.stdin.removeListener("data", onData); process.stdin.pause(); if (error) reject(error); else resolve(value); } function onData(chunk) { buffered += chunk.toString("utf8"); if (buffered.length > MAX_INIT_CHARS + 1) { finish(new Error("TERMINAL_INPUT_INVALID")); return; } const at = buffered.indexOf("\n"); if (at < 0) return; let line = buffered.slice(0, at); if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); finish(null, line); } process.stdin.setEncoding("utf8"); process.stdin.on("data", onData); process.stdin.resume(); }); }
function decodeInit(line) { if (typeof line !== "string" || line.length === 0 || line.length > MAX_INIT_CHARS || /^[A-Za-z0-9_-]+$/.test(line) === false) return null; let value = null; try { value = JSON.parse(Buffer.from(line, "base64url").toString("utf8")); } catch { return null; } if (isRecord(value) === false || Object.keys(value).length !== 2 || value.v !== 1 || typeof value.ticketRef !== "string" || REF.test(value.ticketRef) === false) return null; return value.ticketRef; }
function readTicketDirectory(deployRoot) { const directory = deployRoot + "/" + TICKETS_DIRECTORY; let stats = null; try { stats = fs.lstatSync(directory); } catch { throw new Error("TERMINAL_TICKET_INVALID"); } if (stats.isDirectory() === false || stats.isSymbolicLink()) throw new Error("TERMINAL_TICKET_INVALID"); if (typeof process.getuid === "function") { if (stats.uid !== process.getuid() || (stats.mode & 448) !== 448 || (stats.mode & 63) !== 0) throw new Error("TERMINAL_TICKET_INVALID"); } return directory; }
/* Atomic single use: rename out of the shared name first, then read the claimed file without following a link. */
function consumeTicket(location, ticketRef) { const directory = readTicketDirectory(location.deployRoot); const ticketPath = directory + "/" + ticketRef; let stats = null; try { stats = fs.lstatSync(ticketPath); } catch (error) { throw new Error(error !== null && error.code === "ENOENT" ? "TERMINAL_TICKET_ALREADY_CONSUMED" : "TERMINAL_TICKET_INVALID"); } if (stats.isFile() === false || stats.isSymbolicLink()) throw new Error("TERMINAL_TICKET_INVALID"); if (typeof process.getuid === "function" && (stats.uid !== process.getuid() || (stats.mode & 511) !== 384)) throw new Error("TERMINAL_TICKET_INVALID"); const claim = directory + "/.claim-" + ticketRef + "-" + process.pid; claimPath = claim; try { fs.renameSync(ticketPath, claim); } catch (error) { claimPath = null; throw new Error(error !== null && error.code === "ENOENT" ? "TERMINAL_TICKET_ALREADY_CONSUMED" : "TERMINAL_TICKET_INVALID"); } let descriptor = null; let bytes = null; try { descriptor = fs.openSync(claim, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW === undefined ? 0 : fs.constants.O_NOFOLLOW)); const opened = fs.fstatSync(descriptor); if (opened.isFile() === false || opened.size > MAX_TICKET_BYTES) throw new Error("TERMINAL_TICKET_INVALID"); bytes = fs.readFileSync(descriptor); } catch (error) { if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} } throw error; } if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} } try { fs.unlinkSync(claim); claimPath = null; } catch {} return parseTicket(bytes, ticketRef, location); }
/* Strict ticket schema; a ticket that is well-formed but stale, for another bundle or for a moved cwd reports that. */
function parseTicket(bytes, ticketRef, location) { let value = null; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("TERMINAL_TICKET_INVALID"); } if (isRecord(value) === false || Object.keys(value).length !== TICKET_KEYS.length) throw new Error("TERMINAL_TICKET_INVALID"); for (const key of TICKET_KEYS) { if (Object.prototype.hasOwnProperty.call(value, key) === false) throw new Error("TERMINAL_TICKET_INVALID"); } if (value.v !== 1 || value.kind !== "project" || typeof value.projectId !== "string" || value.projectId.length === 0 || value.projectId.length > 256 || CONTROL.test(value.projectId) || typeof value.hostId !== "string" || HOST_ID.test(value.hostId) === false || typeof value.routeDigest !== "string" || SHA.test(value.routeDigest) === false || typeof value.cwd !== "string" || value.cwd.length === 0 || value.cwd.length > 4096 || value.cwd.charAt(0) !== "/" || CONTROL.test(value.cwd) || typeof value.bundleSha256 !== "string" || SHA.test(value.bundleSha256) === false || value.ticketRef !== ticketRef || Number.isSafeInteger(value.expiresAt) === false) throw new Error("TERMINAL_TICKET_INVALID"); if (value.expiresAt <= Date.now()) throw new Error("TERMINAL_TICKET_EXPIRED"); if (value.bundleSha256 !== location.bundleSha256) throw new Error("TERMINAL_BUNDLE_MISMATCH"); let canonical = null; try { canonical = fs.realpathSync(value.cwd); } catch {} if (canonical !== value.cwd) throw new Error("TERMINAL_CWD_CHANGED"); let stats = null; try { stats = fs.statSync(value.cwd); } catch {} if (stats === null || stats.isDirectory() === false) throw new Error("TERMINAL_CWD_CHANGED"); return { cwd: value.cwd }; }
/* $SHELL from the runner own environment: absolute, printable, a regular executable, no arguments; /bin/sh otherwise. */
function validShellPath(value) { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= SHELL_PATH_MAX_BYTES && value.charAt(0) === "/" && CONTROL.test(value) === false && /^[A-Za-z0-9._@+/-]+$/.test(value); }
function selectShell() { const configured = process.env.SHELL; if (validShellPath(configured)) { try { const stats = fs.statSync(configured); if (stats.isFile() === true) { fs.accessSync(configured, fs.constants.X_OK); return configured; } } catch {} } return "/bin/sh"; }
/* The selected shell is recorded in the START frame so main can report it; the shell itself gets a clean TTY. */
function startShell(ticket) { const shell = selectShell(); let stats = null; try { stats = fs.statSync(shell); fs.accessSync(shell, fs.constants.X_OK); } catch { throw new Error("TERMINAL_SHELL_UNAVAILABLE"); } if (stats.isFile() === false) throw new Error("TERMINAL_SHELL_UNAVAILABLE"); restoreTermios(); emitFrame(START_PREFIX + Buffer.from(shell, "utf8").toString("base64url") + FRAME_SUFFIX); started = true; let child = null; try { child = cp.spawn(shell, [], { argv0: "-" + posix.basename(shell), cwd: ticket.cwd, stdio: "inherit", env: process.env, shell: false }); } catch { process.exit(1); } child.on("error", function () { process.exit(1); }); child.on("exit", function (code) { process.exit(code === null || Number.isSafeInteger(code) === false ? 1 : code); }); for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(signal, function () { try { child.kill(signal); } catch {} }); }
function main() { if (posix === null || fs === null || cp === null || typeof cp.spawnSync !== "function") return fail("TERMINAL_INTERNAL"); if (process.platform === "win32") return fail("TERMINAL_INTERNAL"); const location = readOwnLocation(); if (location === null) return fail("TERMINAL_INTERNAL"); sttyPath = resolveStty(); if (sttyPath === null) return fail("TERMINAL_TERMIOS_FAILED"); try { captureTermios(); } catch (error) { return fail(codeOf(error)); } try { emitFrame(READY_FRAME); } catch { process.exit(1); } readInitFrame().then(function (line) { const ticketRef = decodeInit(line); if (ticketRef === null) return fail("TERMINAL_INPUT_INVALID"); let ticket = null; try { ticket = consumeTicket(location, ticketRef); } catch (error) { return fail(codeOf(error)); } try { startShell(ticket); } catch (error) { return fail(codeOf(error)); } }, function (error) { return fail(codeOf(error)); }); }
main();`.replace(/\r?\n[\t ]*/g, "");

/**
 * sha256 of REMOTE_TERMINAL_RUNNER_INLINE_SOURCE as UTF-8 bytes: the identity a bundle manifest declares and
 * the test suite re-computes, so the runner that consumes a launch ticket is the runner that was reviewed.
 */
export const REMOTE_TERMINAL_RUNNER_ENTRY_SHA256 = "0c9e382f36f36528b78c4eca04fc87e9f1478050e12f2fbaa9f788a32c8d63cd";
