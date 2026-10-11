/**
 * Read-modify-write over one persisted JSON store, under a cross-process lock and with an explicit
 * revision token.
 *
 * Why this exists (INV-5a，`docs/remote-cross-store-consistency-plan.md` §2.1): a store used to build
 * its next snapshot from its own in-memory copy and write the whole file. Two live writers (two
 * PiDeck versions are allowed to run against the same userData) each advanced "their" revision, so
 * the later rename silently dropped the earlier writer's committed records. This module makes the
 * mutation a function of the *freshly read* state, so a commit is always built on what is on disk.
 *
 * Contract:
 * - `readFresh` is called **inside** the lock. Implementations must fail closed (throw their own
 *   stable code) when the file cannot be trusted; "unreadable" must never degrade to "empty".
 * - `mutate` receives the fresh state and returns the next state plus `changed`. `changed === false`
 *   writes nothing at all (read-only paths stay read-only).
 * - `expectedRevision` is the strict mode: when the disk no longer matches the caller's token the
 *   write is refused with `conflictCode` and the disk stays byte-identical. Stores whose mutators
 *   are retry-safe by construction (they re-apply onto fresh state) do not pass it; callers holding
 *   a snapshot that must not be clobbered do.
 * - Every refusal has its own stable code: `busyCode` (another live owner), `conflictCode` (stale
 *   token), `unwritableCode` (lock directory not writable). They must not be collapsed into one,
 *   because "retry later" and "re-read and retry" are different user actions.
 *
 * Does not own: the file format, backup rotation, or the revision field's spelling — those stay in
 * each store's codec/write helper.
 */
import { acquireStoreFileLock, currentBootId, defaultIsProcessAlive } from "./StoreFileLock";

export type StoreFileCasRead<TState> = { readonly state: TState; readonly revision: number };

export type StoreFileCasOutcome<TState, TValue> = {
	readonly state: TState;
	readonly changed: boolean;
	readonly value: TValue;
};

export type StoreFileCasOptions<TState, TValue> = {
	/** Directory that must exist before the lock can be created (same root as the store file). */
	readonly rootDir: string;
	readonly lockPath: string;
	readonly unwritableCode: string;
	readonly busyCode: string;
	readonly conflictCode: string;
	readonly readFresh: () => Promise<StoreFileCasRead<TState>>;
	readonly expectedRevision?: number;
	/** May be async: the mutation body is the caller's transaction (guards included), so it can await.
	 *  Everything it does runs while the lock is held — keep it short and never wait on user input. */
	readonly mutate: (fresh: TState) => StoreFileCasOutcome<TState, TValue> | Promise<StoreFileCasOutcome<TState, TValue>>;
	readonly write: (state: TState, revision: number) => Promise<void>;
	readonly bootId?: string;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly now?: () => number;
};

/** Runs one locked read-modify-write. Returns the mutation's value; throws a stable code on refusal. */
export async function withStoreFileCas<TState, TValue>(options: StoreFileCasOptions<TState, TValue>): Promise<TValue> {
	const lock = await acquireStoreFileLock({
		rootDir: options.rootDir,
		lockPath: options.lockPath,
		unwritableCode: options.unwritableCode,
		bootId: options.bootId ?? currentBootId(),
		isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
		now: options.now ?? Date.now,
	});
	if (!lock) throw new Error(options.busyCode);
	try {
		const fresh = await options.readFresh();
		if (options.expectedRevision !== undefined && fresh.revision !== options.expectedRevision) throw new Error(options.conflictCode);
		const outcome = await options.mutate(fresh.state);
		if (outcome.changed) await options.write(outcome.state, fresh.revision + 1);
		return outcome.value;
	} finally {
		await lock.release();
	}
}

/**
 * Reads the fresh state under the same lock without writing. Used by the host-rebind read port,
 * whose values are compared against disk by the write port later: a read that answered from memory
 * would make that comparison meaningless (§1.7 第 8 条).
 */
export async function readStoreFileFresh<TState>(options: {
	readonly rootDir: string;
	readonly lockPath: string;
	readonly unwritableCode: string;
	readonly busyCode: string;
	readonly readFresh: () => Promise<StoreFileCasRead<TState>>;
	readonly bootId?: string;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly now?: () => number;
}): Promise<StoreFileCasRead<TState>> {
	const lock = await acquireStoreFileLock({
		rootDir: options.rootDir,
		lockPath: options.lockPath,
		unwritableCode: options.unwritableCode,
		bootId: options.bootId ?? currentBootId(),
		isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
		now: options.now ?? Date.now,
	});
	if (!lock) throw new Error(options.busyCode);
	try {
		return await options.readFresh();
	} finally {
		await lock.release();
	}
}
