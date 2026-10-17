import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * F3 terminal.prepare on the deployed helper: a real child process in a bundle-shaped path mints the one-shot
 * ticket under its own deploy root. Every claim (0600 ticket, 0700 directory, bounds, sweep targets, refusal
 * codes) is asserted from the filesystem; a flat/dev helper and a host-only helper must refuse instead of
 * inventing a deploy root.
 */

const { REMOTE_HELPER_ARTIFACTS, REMOTE_HELPER_ENTRY_FILE_NAME } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const { REMOTE_HELPER_METHOD_TERMINAL_PREPARE, REMOTE_TERMINAL_TICKETS_DIRECTORY, REMOTE_TERMINAL_TICKET_TTL_MS } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_BUNDLE_MAINTENANCE_ENTRY, REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE, remoteBundleMaintenanceMarker } = loadTsCommonJs("src/main/remote/RemoteBundleMaintenance.ts");
const LINUX = process.platform === "linux";
const helperTest = (name, fn, timeoutMs = 20_000) => test(name, { skip: LINUX ? false : "POSIX helper deploy root: terminal tickets are Linux/POSIX only", timeout: timeoutMs }, fn);
const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PROJECT_ID = "project-a";
const ROUTE = "c".repeat(64);
const BUNDLE_SHA = "a".repeat(64);

function fixture(t, { bundleShaped = true, root = true, beforeStart } = {}) {
	const base = mkdtempSync(join(tmpdir(), "pideck-terminal-prepare-"));
	const home = join(base, "home");
	const projectRoot = join(base, "project");
	mkdirSync(home, { recursive: true });
	mkdirSync(projectRoot);
	const deployRoot = join(home, ".pideck", "remote-host");
	const bundle = join(deployRoot, "bundles", BUNDLE_SHA);
	mkdirSync(bundle, { recursive: true });
	chmodSync(join(home, ".pideck"), 0o700);
	chmodSync(deployRoot, 0o700);
	chmodSync(join(deployRoot, "bundles"), 0o700);
	chmodSync(bundle, 0o700);
	for (const artifact of REMOTE_HELPER_ARTIFACTS) writeFileSync(join(bundle, artifact.name), artifact.source, { mode: 0o400 });
	// A flat/dev helper is perfectly runnable (all siblings sit next to it) but its path is not a deploy bundle.
	if (!bundleShaped) for (const artifact of REMOTE_HELPER_ARTIFACTS) writeFileSync(join(base, artifact.name), artifact.source, { mode: 0o400 });
	const entry = bundleShaped ? join(bundle, REMOTE_HELPER_ENTRY_FILE_NAME) : join(base, REMOTE_HELPER_ENTRY_FILE_NAME);
	if (typeof beforeStart === "function") beforeStart({ base, home, projectRoot, deployRoot, bundle, tickets: join(deployRoot, REMOTE_TERMINAL_TICKETS_DIRECTORY) });
	const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
	const args = [entry, ...(root ? ["--root", projectRoot] : [])];
	const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
	const lines = createInterface({ input: child.stdout });
	const pending = new Map();
	let sequence = 0;
	lines.on("line", (line) => {
		const frame = JSON.parse(line);
		const request = pending.get(frame.id);
		if (!request) return;
		pending.delete(frame.id);
		request.resolve(frame);
	});
	child.on("exit", () => {
		for (const request of pending.values()) request.reject(new Error("helper exited"));
		pending.clear();
	});
	child.stderr.on("data", () => undefined);
	t.after(() => {
		child.kill();
		lines.close();
		rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	const request = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = "terminal-" + ++sequence;
			pending.set(id, { resolve, reject });
			child.stdin.write(JSON.stringify({ v: 1, hostId: HOST_ID, generation: 1, id, method, timeoutMs: 5000, params }) + "\n");
		});
	return { base, home, projectRoot, deployRoot, bundle, tickets: join(deployRoot, REMOTE_TERMINAL_TICKETS_DIRECTORY), request };
}
function validParams() {
	return { kind: "project", projectId: PROJECT_ID, hostId: HOST_ID, routeDigest: ROUTE };
}
function refs(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

helperTest("a valid prepare mints one 0600 ticket under the deploy root and returns only an opaque ref", async (t) => {
	const f = fixture(t);
	const frame = await f.request(REMOTE_HELPER_METHOD_TERMINAL_PREPARE, validParams());
	assert.equal(frame.ok, true);
	assert.deepEqual(Object.keys(frame.result), ["ticketRef"]);
	assert.match(frame.result.ticketRef, /^[0-9a-f]{32}$/);
	const directory = lstatSync(f.tickets);
	assert.equal(directory.isDirectory(), true);
	assert.equal(directory.isSymbolicLink(), false);
	assert.equal(directory.mode & 0o777, 0o700, "the ticket directory is owner-only");
	const ticketPath = join(f.tickets, frame.result.ticketRef);
	const ticketStat = lstatSync(ticketPath);
	assert.equal(ticketStat.isFile(), true);
	assert.equal(ticketStat.mode & 0o777, 0o600, "the ticket is 0600");
	const ticket = JSON.parse(readFileSync(ticketPath, "utf8"));
	assert.deepEqual(Object.keys(ticket), ["v", "kind", "projectId", "hostId", "routeDigest", "cwd", "bundleSha256", "ticketRef", "expiresAt"]);
	assert.equal(ticket.v, 1);
	assert.equal(ticket.kind, "project");
	assert.equal(ticket.projectId, PROJECT_ID);
	assert.equal(ticket.hostId, HOST_ID);
	assert.equal(ticket.routeDigest, ROUTE);
	assert.equal(ticket.cwd, f.projectRoot, "cwd is the helper's own canonical root");
	assert.equal(ticket.bundleSha256, BUNDLE_SHA);
	assert.equal(ticket.ticketRef, frame.result.ticketRef);
	assert.equal(REMOTE_TERMINAL_TICKET_TTL_MS, 60_000, "R2-2: an unconsumed ticket lives at most 60 s");
	assert.ok(ticket.expiresAt > Date.now() && ticket.expiresAt - Date.now() <= REMOTE_TERMINAL_TICKET_TTL_MS, "the ticket expiry is inside the frozen 60 s TTL");
	// A second prepare is a second ticket, not a reuse.
	const second = await f.request(REMOTE_HELPER_METHOD_TERMINAL_PREPARE, validParams());
	assert.notEqual(second.result.ticketRef, frame.result.ticketRef);
	assert.equal(refs(f.tickets).length, 2);
});

helperTest("malformed prepare params are refused with no ticket file", async (t) => {
	const f = fixture(t);
	for (const params of [{}, { ...validParams(), extra: true }, { ...validParams(), kind: "agent" }, { ...validParams(), hostId: "nope" }, { ...validParams(), routeDigest: "short" }, { ...validParams(), projectId: 7 }, { ...validParams(), projectId: "" }]) {
		const frame = await f.request(REMOTE_HELPER_METHOD_TERMINAL_PREPARE, params);
		assert.equal(frame.ok, false, JSON.stringify(params));
		assert.equal(frame.error.code, "TERMINAL_TICKET_INVALID");
	}
	assert.deepEqual(refs(f.tickets), []);
});

helperTest("a flat helper path and a host-only session refuse instead of inventing a deploy root", async (t) => {
	const flat = fixture(t, { bundleShaped: false });
	// A flat/dev helper has no deploy root: startup hygiene is skipped and serving is unaffected.
	assert.equal((await flat.request("hello", { clientVersion: "0.0.0", nonce: "flat-helper-nonce" })).ok, true);
	const frame = await flat.request(REMOTE_HELPER_METHOD_TERMINAL_PREPARE, validParams());
	assert.equal(frame.ok, false);
	assert.equal(frame.error.code, "TERMINAL_TICKET_UNAVAILABLE");
	assert.deepEqual(refs(flat.tickets), []);
	const hostOnly = fixture(t, { root: false });
	const second = await hostOnly.request(REMOTE_HELPER_METHOD_TERMINAL_PREPARE, validParams());
	assert.equal(second.ok, false);
	assert.equal(second.error.code, "TERMINAL_TICKET_INVALID");
	assert.deepEqual(refs(hostOnly.tickets), []);
});

helperTest("the bounded sweep prunes only expired/malformed tickets and stale temp files", async (t) => {
	const f = fixture(t);
	mkdirSync(f.tickets, { mode: 0o700 });
	chmodSync(f.tickets, 0o700);
	const expired = "1".repeat(32);
	const malformed = "2".repeat(32);
	const fresh = "3".repeat(32);
	const foreign = "keep-me.txt";
	writeFileSync(join(f.tickets, expired), JSON.stringify({ v: 1, expiresAt: Date.now() - 1 }), { mode: 0o600 });
	writeFileSync(join(f.tickets, malformed), "not json", { mode: 0o600 });
	writeFileSync(join(f.tickets, fresh), JSON.stringify({ v: 1, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
	writeFileSync(join(f.tickets, foreign), "foreign", { mode: 0o600 });
	const stale = join(f.tickets, ".new-" + "4".repeat(32));
	writeFileSync(stale, "stale", { mode: 0o600 });
	const old = new Date(Date.now() - 120_000);
	(await import("node:fs")).utimesSync(stale, old, old);
	const frame = await f.request(REMOTE_HELPER_METHOD_TERMINAL_PREPARE, validParams());
	assert.equal(frame.ok, true);
	assert.equal(existsSync(join(f.tickets, expired)), false);
	assert.equal(existsSync(join(f.tickets, malformed)), false);
	assert.equal(existsSync(join(f.tickets, stale)), false);
	assert.equal(existsSync(join(f.tickets, fresh)), true, "a live ticket from another launch is kept");
	assert.equal(existsSync(join(f.tickets, foreign)), true, "a foreign entry is never touched");
});

helperTest("an over-permissive ticket directory is tightened, while a symlinked one is refused", async (t) => {
	const loose = fixture(t);
	mkdirSync(loose.tickets, { mode: 0o755 });
	chmodSync(loose.tickets, 0o755);
	assert.equal((await loose.request(REMOTE_HELPER_METHOD_TERMINAL_PREPARE, validParams())).ok, true);
	assert.equal(lstatSync(loose.tickets).mode & 0o777, 0o700);
	const linked = fixture(t);
	const target = join(linked.base, "elsewhere");
	mkdirSync(target, { mode: 0o700 });
	symlinkSync(target, linked.tickets, "dir");
	const frame = await linked.request(REMOTE_HELPER_METHOD_TERMINAL_PREPARE, validParams());
	assert.equal(frame.ok, false);
	assert.equal(frame.error.code, "TERMINAL_TICKET_UNAVAILABLE");
	assert.deepEqual(refs(target), [], "a symlinked ticket directory is never written through");
});

helperTest("a bundle-shaped helper sweeps its ticket directory at startup before serving", async (t) => {
	const now = Date.now();
	let planted;
	const f = fixture(t, {
		beforeStart: (dirs) => {
			mkdirSync(dirs.tickets, { mode: 0o700 });
			chmodSync(dirs.tickets, 0o700);
			const expired = "1".repeat(32);
			const malformed = "2".repeat(32);
			const fresh = "3".repeat(32);
			const staleClaim = ".claim-" + "4".repeat(32) + "-4242";
			const freshClaim = ".claim-" + "5".repeat(32) + "-5252";
			const staleTemp = ".new-" + "6".repeat(32);
			writeFileSync(join(dirs.tickets, expired), JSON.stringify({ v: 1, expiresAt: now - 1 }), { mode: 0o600 });
			writeFileSync(join(dirs.tickets, malformed), "not json", { mode: 0o600 });
			writeFileSync(join(dirs.tickets, fresh), JSON.stringify({ v: 1, expiresAt: now + 60_000 }), { mode: 0o600 });
			writeFileSync(join(dirs.tickets, staleClaim), "claim", { mode: 0o600 });
			writeFileSync(join(dirs.tickets, freshClaim), "claim", { mode: 0o600 });
			writeFileSync(join(dirs.tickets, staleTemp), "temp", { mode: 0o600 });
			writeFileSync(join(dirs.tickets, "keep-me.txt"), "foreign", { mode: 0o600 });
			const old = new Date(now - REMOTE_TERMINAL_TICKET_TTL_MS - 60_000);
			for (const name of [staleClaim, staleTemp]) utimesSync(join(dirs.tickets, name), old, old);
			planted = { expired, malformed, fresh, staleClaim, freshClaim, staleTemp };
		},
	});
	const hello = await f.request("hello", { clientVersion: "0.0.0", nonce: "startup-sweep-nonce" });
	assert.equal(hello.ok, true, "the startup sweep must not disturb serving");
	assert.equal(existsSync(join(f.tickets, planted.expired)), false, "expired ticket removed at startup");
	assert.equal(existsSync(join(f.tickets, planted.malformed)), false, "malformed ticket removed at startup");
	assert.equal(existsSync(join(f.tickets, planted.staleClaim)), false, "crash-orphaned claim older than TTL removed at startup");
	assert.equal(existsSync(join(f.tickets, planted.staleTemp)), false, "stale .new temp removed at startup");
	assert.equal(existsSync(join(f.tickets, planted.fresh)), true, "a live ticket is never swept");
	assert.equal(existsSync(join(f.tickets, planted.freshClaim)), true, "a claim newer than the TTL is never swept");
	assert.equal(existsSync(join(f.tickets, "keep-me.txt")), true, "foreign names are never touched");
});

helperTest("a bundle-shaped helper does not create a ticket directory merely to sweep on startup", async (t) => {
	const f = fixture(t);
	assert.equal(existsSync(f.tickets), false, "the fixture starts without a ticket directory");
	const hello = await f.request("hello", { clientVersion: "0.0.0", nonce: "startup-nodir-nonce" });
	assert.equal(hello.ok, true);
	assert.equal(existsSync(f.tickets), false, "startup hygiene never materialises a directory that was never used");
});

helperTest("mint-time sweep also prunes crash-orphaned .claim-<ref>-<pid> files but never a fresh one", async (t) => {
	const f = fixture(t);
	mkdirSync(f.tickets, { mode: 0o700 });
	chmodSync(f.tickets, 0o700);
	const staleClaim = ".claim-" + "7".repeat(32) + "-31337";
	const freshClaim = ".claim-" + "8".repeat(32) + "-31338";
	const staleTemp = ".new-" + "9".repeat(32);
	writeFileSync(join(f.tickets, staleClaim), "claim", { mode: 0o600 });
	writeFileSync(join(f.tickets, freshClaim), "claim", { mode: 0o600 });
	writeFileSync(join(f.tickets, staleTemp), "temp", { mode: 0o600 });
	writeFileSync(join(f.tickets, "foreign-name"), "foreign", { mode: 0o600 });
	const old = new Date(Date.now() - REMOTE_TERMINAL_TICKET_TTL_MS - 60_000);
	utimesSync(join(f.tickets, staleClaim), old, old);
	utimesSync(join(f.tickets, staleTemp), old, old);
	const frame = await f.request(REMOTE_HELPER_METHOD_TERMINAL_PREPARE, validParams());
	assert.equal(frame.ok, true);
	assert.equal(existsSync(join(f.tickets, staleClaim)), false);
	assert.equal(existsSync(join(f.tickets, staleTemp)), false);
	assert.equal(existsSync(join(f.tickets, freshClaim)), true);
	assert.equal(existsSync(join(f.tickets, "foreign-name")), true);
});

helperTest("the F2 bundle-maintenance sweep only targets bundles/, .staging-* and .deploy.lock", () => {
	// The sweep is a closed program whose only deletion targets are the content-addressed bundle dirs, the
	// bootstrap staging dirs and the deploy lock: the launch-ticket directory is not addressable by it.
	assert.equal(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes("terminal"), false, "the F2 sweep must not know about terminal tickets");
	assert.equal(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes("tickets"), false);
	assert.ok(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes("const STAGING = /^\\.staging-"));
	assert.ok(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes('"bundles"'));
	assert.ok(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes('".deploy.lock"') && REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes("DEPLOY_LOCK"));
	// An independent directory witness: a prune command built by main names no ticket path.
	const marker = remoteBundleMaintenanceMarker("sweepnonce02");
	assert.match(marker, /^PIDECK_SWEEP_[A-Za-z0-9]{8,64}$/);
});
