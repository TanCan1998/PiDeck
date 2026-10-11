/**
 * Transaction lock for the cross-store host rebind transaction
 * (`docs/remote-host-cross-store-design.md` §5.1 R1/R4/R6).
 *
 * The owner shape, the R6 liveness decision and the create/reclaim/release mechanics live in
 * `src/main/persistence/StoreFileLock.ts`, shared with the two reference stores (`projects.json`,
 * `session-catalog.json`): all three must answer "may this lock be reclaimed?" identically, and a
 * second copy of that rule is the copy that hands two writers the same file.
 *
 * This module owns only what is rebind-specific: the lock file's location is decided by
 * `HostRebindJournal` (which owns the `<userDataDir>` layout), and the stable code a failed lock
 * directory reports is `REMOTE_HOST_REBIND_TX_LOCK_UNWRITABLE` rather than a store code.
 */
import { acquireStoreFileLock, classifyStoreFileLockOwner, type StoreFileLockOwner, type StoreFileLockProbe } from "../persistence/StoreFileLock";

export { currentBootId, defaultIsProcessAlive } from "../persistence/StoreFileLock";

/** The one stable code this module throws; `HOST_REBIND_CODES` references it. */
export const REBIND_TX_LOCK_UNWRITABLE = "REMOTE_HOST_REBIND_TX_LOCK_UNWRITABLE";

export type HostRebindTxLockOwner = StoreFileLockOwner;

/** What "this owner is still alive" is judged against: our own pid, our boot id, and the liveness probe. */
export type HostRebindTxLockProbe = StoreFileLockProbe;

export type HostRebindTxLock = { release(): Promise<void> };

export type HostRebindTxLockOptions = {
	readonly userDataDir: string;
	/** `<userDataDir>/remote-host-rebind.lock`; passed in so the path layout stays defined in one place. */
	readonly lockPath: string;
	/** The injected boot identity of the acquiring process (§5.1 R6). */
	readonly bootId: string;
	readonly isProcessAlive: (pid: number) => boolean;
	readonly now: () => number;
};

/**
 * R6: only a provably dead owner may be preempted, and "unreadable" is not "dead" — an opaque or
 * half-written lock could still belong to a live writer, and stealing it would create two writers
 * (§5.4 step 2 fails closed the same way). A different boot id proves the recorded pid belongs to
 * some other process now, so that owner is stale even if a process with that pid exists.
 */
export const classifyRebindTxLockOwner = classifyStoreFileLockOwner;

/**
 * Acquire the tx mutex, or `undefined` when another live process holds it (R4: give up this recovery
 * instead of waiting). A provably stale owner is reclaimed at most once (one retry, then give up).
 * `release` is idempotent: a lock that is already gone is exactly the released state.
 */
export async function acquireRebindTxLock(options: HostRebindTxLockOptions): Promise<HostRebindTxLock | undefined> {
	return acquireStoreFileLock({
		rootDir: options.userDataDir,
		lockPath: options.lockPath,
		unwritableCode: REBIND_TX_LOCK_UNWRITABLE,
		bootId: options.bootId,
		isProcessAlive: options.isProcessAlive,
		now: options.now,
	});
}
