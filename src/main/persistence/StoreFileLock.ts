/**
 * Generic cross-process file lock for the persisted stores (`projects.json`, `session-catalog.json`,
 * `remote-hosts.json`) and the host-rebind transaction.
 *
 * Owns:
 * - the lock owner shape `{ pid, bootId, startedAt }` and the boot identity it is compared against
 *   (`currentBootId` derives it from uptime, so no `/proc` and no platform branch is needed);
 * - the liveness decision, exposed as the pure `classifyStoreFileLockOwner` so "may this lock be
 *   reclaimed?" can be tested without a filesystem and without a second process;
 * - create / reclaim / release of one `<root>/<name>.lock` file.
 *
 * Does not own: what the lock protects, how long the holder keeps it, or what happens when the
 * acquisition fails. Each caller passes its own stable codes so a refusal stays attributable
 * (`PROJECT_STORE_BUSY` cannot be mistaken for `REMOTE_HOST_REBIND_TX_LOCK_UNWRITABLE`).
 *
 * Why one shared implementation: the owner/reclaim rules are the safety argument ("only a provably
 * dead owner may be preempted"). A second copy of them would drift, and the copy that drifts is the
 * one that hands two writers the same file.
 */
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { uptime } from "node:os";

const MAX_LOCK_BYTES = 4096;

export type StoreFileLockOwner = { readonly pid: number; readonly bootId: string; readonly startedAt: string };

/** What "this owner is still alive" is judged against: our own pid, our boot id, and the liveness probe. */
export type StoreFileLockProbe = {
	/** The observing process: a lock owned by this pid is always live, because it is us. */
	readonly pid: number;
	readonly bootId: string;
	/** Injectable process liveness probe; defaults to a `kill(pid, 0)`-based check. */
	readonly isProcessAlive: (pid: number) => boolean;
};

export type StoreFileLock = { release(): Promise<void> };

export type StoreFileLockOptions = {
	/** Directory that must exist before the lock file can be created. */
	readonly rootDir: string;
	/** The lock file itself; passed in so the path layout stays defined in one place per domain. */
	readonly lockPath: string;
	/** Stable code thrown when the lock directory cannot be written (that is not contention). */
	readonly unwritableCode: string;
	/** The injected boot identity of the acquiring process. */
	readonly bootId: string;
	readonly isProcessAlive: (pid: number) => boolean;
	readonly now: () => number;
};

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Boot identity without /proc: two processes on the same boot derive the same value. */
export function currentBootId(): string {
	return String(Math.round((Date.now() - uptime() * 1000) / 1000));
}

export function defaultIsProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM still proves the pid exists; only ESRCH proves it is gone.
		return errorCode(error) !== "ESRCH";
	}
}

/**
 * Only a provably dead owner may be preempted, and "unreadable" is not "dead" — an opaque or
 * half-written lock could still belong to a live writer, and stealing it would create two writers.
 * A different boot id proves the recorded pid belongs to some other process now, so that owner is
 * stale even if a process with that pid exists.
 */
export function classifyStoreFileLockOwner(owner: StoreFileLockOwner | undefined, probe: StoreFileLockProbe): "live" | "stale" {
	if (owner === undefined) return "live";
	// Our own pid always holds the lock: re-entering here would mean a bug, never a reclaim.
	if (owner.pid === probe.pid) return "live";
	if (owner.bootId !== probe.bootId) return "stale";
	return probe.isProcessAlive(owner.pid) ? "live" : "stale";
}

/** Owner metadata read fail-closed: unreadable, garbage or mis-sized all mean "cannot be judged". */
async function readLockOwner(lockPath: string): Promise<StoreFileLockOwner | undefined> {
	let text: string;
	try {
		const stats = await lstat(lockPath);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > MAX_LOCK_BYTES) return undefined;
		text = await readFile(lockPath, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) < 1 || typeof parsed.bootId !== "string" || typeof parsed.startedAt !== "string") return undefined;
	return { pid: Number(parsed.pid), bootId: parsed.bootId, startedAt: parsed.startedAt };
}

/**
 * Acquire the mutex, or `undefined` when another live process holds it. Callers give up instead of
 * waiting (a store that blocks on another instance looks like a hang, not like a conflict). The file
 * is created with "wx" so it is a real cross-process mutex, and a provably stale owner is reclaimed
 * at most once (one retry, then give up). `release` is idempotent: a lock that is already gone is
 * exactly the released state.
 */
export async function acquireStoreFileLock(options: StoreFileLockOptions): Promise<StoreFileLock | undefined> {
	await mkdir(options.rootDir, { recursive: true });
	const owner: StoreFileLockOwner = { pid: process.pid, bootId: options.bootId, startedAt: new Date(options.now()).toISOString() };
	const probe: StoreFileLockProbe = { pid: process.pid, bootId: options.bootId, isProcessAlive: options.isProcessAlive };
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await open(options.lockPath, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
			} finally {
				await handle.close();
			}
			return {
				release: async () => {
					try {
						await unlink(options.lockPath);
					} catch {
						// Already gone: that is the released state.
					}
				},
			};
		} catch (error) {
			// Anything but "somebody else made it first" is an unwritable lock directory, not contention.
			if (errorCode(error) !== "EEXIST") throw new Error(options.unwritableCode);
			const existing = await readLockOwner(options.lockPath);
			if (classifyStoreFileLockOwner(existing, probe) === "live") return undefined;
			try {
				await unlink(options.lockPath);
			} catch {
				// The stale lock vanished under us (or cannot be removed): give up rather than spin.
				return undefined;
			}
		}
	}
	return undefined;
}
