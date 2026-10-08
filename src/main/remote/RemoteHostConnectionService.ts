import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { RemoteHostStore } from "./RemoteHostStore";
import { createRemoteHostOperationLock } from "./RemoteHostOperationLock";
import { bootstrapPinnedHost, resolveRemoteNodeExecutable } from "./RemoteBootstrapSession";
import { createSshConnectionManager, type SshConnectionManager, type SshHelperSession } from "./SshConnectionManager";
import { createSshProcessLauncher } from "./SshProcessLauncher";
import { diagnosticCodeFromError } from "./SshConnectionDiagnostics";
import type { SshClientRuntime } from "./SshClientRuntime";
import type { SshProcessLauncher } from "./RemoteHostConnectionTypes";
import type { ConnectionMachineState } from "./RemoteHostConnectionState";

/**
 * The verified bootstrap result of one host, held for exactly as long as the store revision it was
 * produced under. A rebind, a disable or a re-verification bumps that revision, and a helper session
 * from a superseded revision may point at a retired deploy root, so it must never be reused.
 */
type HeldBootstrap = {
	revision: number;
	session: SshHelperSession;
	generation: number;
};

/** Narrow, injectable view of the coordinator so tests never touch a real SSH process. */
export type RemoteHostConnectionPorts = {
	/** Re-preflight both commands against the persisted pin, then run the frozen one-file bootstrap. */
	bootstrap: typeof bootstrapPinnedHost;
	/** Resolve the host user's own node through their login shell. */
	resolveNode: typeof resolveRemoteNodeExecutable;
	/** Build the per-host connection manager. The manager itself owns attempt lifecycles. */
	createManager: (options: { userDataDir: string; client: SshClientRuntime; launcher: SshProcessLauncher; helperSession: SshHelperSession; onStateChange?: (entry: { hostId: string; state: ConnectionMachineState }) => void }) => SshConnectionManager;
	/** Mint the bootstrap nonce; injected so tests are deterministic. */
	createNonce: () => string;
	/** Mint the login-shell probe sentinel; injected so tests are deterministic. */
	createSentinel: () => string;
};

export type RemoteHostConnectionServiceOptions = {
	userDataDir: string;
	client: SshClientRuntime;
	launcher?: SshProcessLauncher;
	/**
	 * Absolute remote Node binary, overriding discovery. Optional on purpose: the path can only be known
	 * by asking the host, so requiring it here would invert the real order of events — a caller would have
	 * to produce the answer before the connection that discovers it. Supply it only to pin a specific
	 * binary; otherwise the service resolves the host user's own node via their login shell.
	 */
	nodePath?: string;
	/** Verified workspace root the helper confines `fs.*` to. Omitted is the legal host-only session. */
	root?: string;
	/**
	 * Forwarded to each manager so the owner learns about transitions that happen after `connect()`
	 * returns — a later degradation, a reconnect, or the shutdown that follows a successful ready.
	 */
	onStateChange?: (entry: { hostId: string; state: ConnectionMachineState }) => void;
	ports?: Partial<RemoteHostConnectionPorts>;
};

/** Redacted outcome of one connect request: stable codes only, never pins or paths. */
export type RemoteHostConnectResult = { ok: true; hostId: string; state: ConnectionMachineState } | { ok: false; hostId: string; code: string };

/**
 * One helper session held for the whole duration of a read-only operation.
 *
 * `request`/`cancel` are already bound to the manager this session was established on, so the caller never
 * names a host or a manager: it cannot accidentally address a session that replaced this one mid-read.
 */
export type RemoteProjectSession = {
	readonly hostId: string;
	request(method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (requestId: string) => void }): Promise<unknown>;
	cancel(requestId: string, options?: { timeoutMs?: number }): Promise<unknown>;
};

/**
 * States in which the host is already working on its own connection: an attempt is in flight or the manager
 * is healing itself. A read must report them rather than rebuild — a rebuild would race that attempt.
 */
const TRANSIENT_SESSION_STATES: ReadonlySet<string> = new Set(["connecting", "probing", "bootstrapping", "reconnecting", "degraded", "needs-attention"]);

/**
 * Which generation number a connect attempt receives. The manager fences attempts by its own
 * generation; this counter names the bootstrap attempt and the nonce lineage only, so the two
 * fences stay independent and neither module has to know the other's numbering.
 */
type HostEntry = {
	generation: number;
	held?: HeldBootstrap;
	manager?: SshConnectionManager;
	/** In-flight connect, so dispose can wait for it instead of racing the spawn. */
	inFlight?: Promise<RemoteHostConnectResult>;
};

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 16 random bytes base64url: matches the 15–63 character nonce the frozen entry accepts. */
const DEFAULT_NONCE_BYTES = 16;
/** Nonces must stay distinguishable between attempts of the same host. */
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;

function defaultPorts(): RemoteHostConnectionPorts {
	return {
		bootstrap: bootstrapPinnedHost,
		resolveNode: resolveRemoteNodeExecutable,
		createManager: (options) => createSshConnectionManager(options),
		createNonce: () => randomBytes(DEFAULT_NONCE_BYTES).toString("base64url"),
		createSentinel: () => randomBytes(DEFAULT_NONCE_BYTES).toString("hex"),
	};
}

/**
 * Own the wired connection lifecycle of remote hosts: one verified bootstrap per host, held until the
 * store revision it was produced under changes, plus the manager that consumes it.
 *
 * Bootstrap and connect are deliberately separate steps. `bootstrapPinnedHost` takes no cancellation
 * parameter and only stops its own entry process in its own `finally`, so an abort can be honoured
 * *between* bootstrap and connect but never inside a running upload. Stating that here is cheaper than
 * pretending the seam is cancellable: the upload stays bounded by the coordinator's own session
 * deadline. Both fences are re-checked at every step, so a host whose profile changed mid-flight
 * never reaches the manager with a stale helper location.
 *
 * Nothing in this module is reachable in production: no IPC channel and no assembly site reference it.
 *
 * Node discovery is deliberately owned here rather than required from the caller: the remote Node binary
 * can only be known by asking the host, so demanding it as construction input would force every caller to
 * produce the answer before the connection that finds it. `options.nodePath` remains as an override for
 * pinning a specific binary.
 */
export function createRemoteHostConnectionService(options: RemoteHostConnectionServiceOptions) {
	if (typeof options?.userDataDir !== "string" || !isAbsolute(options.userDataDir) || typeof options.client?.run !== "function") throw new Error("REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID");
	// An override must still look like an absolute path; a bad one is a wiring bug, not a host condition.
	if (options.nodePath !== undefined && (typeof options.nodePath !== "string" || options.nodePath.length === 0 || !isAbsolute(options.nodePath))) throw new Error("REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID");
	const ports: RemoteHostConnectionPorts = { ...defaultPorts(), ...options.ports };
	const launcher = options.launcher ?? createSshProcessLauncher();
	const hosts = new Map<string, HostEntry>();
	/**
	 * Per-host workspace root, overriding the construction option.
	 *
	 * The root is not a read-time filter: it is the helper's `--root` at session start, so a session that
	 * started without one serves no path at all (`fs.*` is refused with PATH_OUTSIDE_ROOT). Confirming a
	 * browse root therefore has to reach the connection and invalidate any session that was established
	 * without it, which is why this lives here rather than only in the IPC layer that asked for it.
	 */
	const workspaceRoots = new Map<string, string>();
	/**
	 * Serializes every operation that needs a stable helper session on one host: a root switch, a whole
	 * listing or file read, an explicit connect, an explicit disconnect. One helper session exists per host
	 * and its `--root` is fixed for its lifetime, so operations of two projects on the same host must never
	 * interleave. Keyed per host, so different hosts still work in parallel.
	 */
	const operationLock = createRemoteHostOperationLock();
	/**
	 * Hosts the user explicitly disconnected. A background read must not undo that decision by quietly
	 * reconnecting, so the intent is remembered here instead of being re-derived from the root string
	 * (the root string matching proves nothing about whether a live session exists).
	 */
	const explicitlyDisconnected = new Set<string>();
	let disposed = false;
	let disposing: Promise<void> | undefined;

	/** Read the current store revision, so a held bootstrap can be tied to the profile it came from. */
	async function readRevision(): Promise<number> {
		return (await RemoteHostStore.open(options.userDataDir)).getSnapshot().revision;
	}

	function entryFor(hostId: string): HostEntry {
		const existing = hosts.get(hostId);
		if (existing !== undefined) return existing;
		const created: HostEntry = { generation: 0 };
		hosts.set(hostId, created);
		return created;
	}

	/** Build the per-host connection manager over one verified helper session. */
	function managerFor(held: HeldBootstrap): SshConnectionManager {
		return ports.createManager({ userDataDir: options.userDataDir, client: options.client, launcher, helperSession: held.session, ...(options.onStateChange === undefined ? {} : { onStateChange: options.onStateChange }) });
	}

	/** Drop every resource of one host. The manager owns its attempts, so it is disposed first. */
	function discard(entry: HostEntry): void {
		entry.held = undefined;
		const manager = entry.manager;
		entry.manager = undefined;
		if (manager !== undefined) void manager.dispose().catch(() => undefined);
	}

	/**
	 * Produce (or reuse) the verified helper session of one host.
	 *
	 * The store revision is read *after* any bootstrap, never before one, and a held session is only
	 * reused when it still matches the revision on disk. Ordering it the other way round would make a
	 * rebind that lands between two connects look like ordinary progress: the caller would read the new
	 * revision first, find nothing held under it, and bootstrap a second time while the manager built
	 * on the previous deploy root stayed alive. Reading the revision first and comparing afterwards
	 * means any disagreement invalidates the held session instead of blessing it.
	 */
	async function ensureHeld(entry: HostEntry, hostId: string): Promise<HeldBootstrap> {
		const current = await readRevision();
		if (entry.held !== undefined) {
			if (entry.held.revision === current) return entry.held;
			// A rebind/disable/re-verification superseded this helper location: the deploy root it names
			// may have been retired, so drop both the session and the manager that was built on it.
			discard(entry);
		}
		const generation = entry.generation;
		const nonce = ports.createNonce();
		if (!NONCE.test(nonce)) throw new Error("REMOTE_CONNECTION_NONCE_INVALID");
		// Resolve the node before bootstrapping. An explicit override skips discovery; otherwise the host
		// user's own node is found via their login shell. Only a fresh bootstrap pays for discovery — a
		// revision that already has a held session returns above without reaching here.
		const nodePath = options.nodePath ?? (await ports.resolveNode({ userDataDir: options.userDataDir, hostId, client: options.client, sentinel: ports.createSentinel() })).nodePath;
		const prepared = await ports.bootstrap({ userDataDir: options.userDataDir, hostId, generation, nonce, nodePath, client: options.client, launcher });
		// Re-read after the await: a rebind during the upload invalidates this result instead of
		// publishing a helper location that the profile no longer describes.
		const after = await readRevision();
		if (after !== current) throw new Error("SSH_HOST_NOT_READY");
		// Read the effective root after any await: a confirmation that landed while this bootstrap was in
		// flight must not be published under a session that started without it.
		const effectiveRoot = workspaceRoots.get(hostId) ?? options.root;
		const held: HeldBootstrap = {
			revision: after,
			generation,
			session: { nodePath, deployRoot: prepared.deployRoot, bundleSha256: prepared.bundleSha256, ...(effectiveRoot !== undefined ? { root: effectiveRoot } : {}) },
		};
		entry.held = held;
		return held;
	}

	async function connectLocked(hostId: string): Promise<RemoteHostConnectResult> {
		if (disposed) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
		if (!HOST_ID.test(hostId)) return { ok: false, hostId, code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		const entry = entryFor(hostId);
		// An explicit connect is the user re-asserting this host, so later background reads may use it again.
		explicitlyDisconnected.delete(hostId);
		entry.generation += 1;
		try {
			// A machine latched by an explicit disconnect can never be revived — the reducer drops every later
			// begin-attempt — so a latched manager is replaced instead of being reported as a live session.
			// Without this, the user's own "connect" after a disconnect succeeded on paper while the session
			// stayed dead, and every read kept failing with SSH_CONNECTION_NOT_READY.
			if (entry.manager !== undefined && entry.manager.getState(hostId).latched === true) discard(entry);
			const held = await ensureHeld(entry, hostId);
			if (disposed) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
			const manager = entry.manager ?? managerFor(held);
			entry.manager = manager;
			const state = await manager.connect(hostId);
			return { ok: true, hostId, state };
		} catch (error) {
			// A failed connect must not leave a helper session behind that the next attempt would trust.
			discard(entry);
			return { ok: false, hostId, code: diagnosticCodeFromError(error) };
		}
	}

	/**
	 * Establish (or revive) the ready session a project read needs, with the host's root applied.
	 *
	 * Split out of `withProjectSession` so that all of it runs *inside* the caller's lock, and so a thrown
	 * establish error can be translated into its own stable code instead of being flattened by the caller
	 * into a generic read failure. The returned session is bound to the manager it was established on.
	 */
	async function establishProjectSession(hostId: string, root: string): Promise<{ ok: true; session: RemoteProjectSession } | { ok: false; code: string }> {
		const entry = entryFor(hostId);
		if ((workspaceRoots.get(hostId) ?? options.root) !== root) {
			// A different root means a different helper session: the running one was started with the old
			// `--root` (possibly none), so nothing about it can be reused.
			workspaceRoots.set(hostId, root);
			discard(entry);
		}
		let manager = entry.manager;
		if (manager !== undefined) {
			const current = manager.getState(hostId);
			if (current.latched === true) {
				// Latched is terminal for that machine; a fresh manager is the only way back.
				discard(entry);
				manager = undefined;
			} else if (TRANSIENT_SESSION_STATES.has(current.state)) {
				// An attempt is already in flight, or the manager is healing itself: rebuilding here would fight
				// it, so report the state's own code and let its owner finish.
				return { ok: false, code: current.lastCode ?? "SSH_HOST_NOT_READY" };
			} else if (current.state !== "ready") {
				// disconnected/offline: the verified helper location is still valid, so revive in place instead
				// of paying for node discovery and another upload.
				const revived = await manager.connect(hostId);
				if (revived.state !== "ready") return { ok: false, code: revived.lastCode ?? "SSH_HOST_NOT_READY" };
			}
		}
		if (manager === undefined) {
			const held = await ensureHeld(entry, hostId);
			manager = managerFor(held);
			entry.manager = manager;
			const connected = await manager.connect(hostId);
			if (connected.state !== "ready") return { ok: false, code: connected.lastCode ?? "SSH_HOST_NOT_READY" };
		}
		const bound = manager;
		return {
			ok: true,
			session: {
				hostId,
				request(method, params, options) {
					if (hosts.get(hostId)?.manager !== bound) return Promise.reject(new Error("SSH_HOST_NOT_READY"));
					return bound.request(hostId, method, params, options);
				},
				cancel(requestId, options) {
					if (hosts.get(hostId)?.manager !== bound) return Promise.reject(new Error("SSH_HOST_NOT_READY"));
					return bound.cancel(hostId, requestId, options);
				},
			},
		};
	}

	return {
		/**
		 * The verified client this service drives.
		 *
		 * Exposed to main-only consumers that must run their own pinned command against the same client the
		 * connection uses — resolving a browse root, for instance. Sharing the instance is the point: a second
		 * client could resolve through a different environment than the one the session was verified with.
		 */
		client: options.client,
		/** Bootstrap-then-connect one host. Every failure is a stable code, never a thrown message. */
		async connect(hostId: string): Promise<RemoteHostConnectResult> {
			const entry = entryFor(hostId);
			// Queued behind any read of this host: tearing the session down under a read is the defect this
			// batch removes, and an explicit connect would do exactly that.
			const run = operationLock.run(hostId, () => connectLocked(hostId));
			entry.inFlight = run;
			try {
				return await run;
			} finally {
				if (entry.inFlight === run) entry.inFlight = undefined;
			}
		},
		/**
		 * Point this host's next session at a confirmed workspace root.
		 *
		 * Discards the held session and its manager: the running helper was started with a different `--root`
		 * (possibly none), and the root is fixed for the life of a helper process, so nothing about that
		 * session can be reused. The caller reconnects; the next bootstrap carries the new root.
		 */
		setWorkspaceRoot(hostId: string, root: string | undefined): void {
			if (root === undefined) workspaceRoots.delete(hostId);
			else workspaceRoots.set(hostId, root);
			const entry = hosts.get(hostId);
			if (entry !== undefined) discard(entry);
		},
		// 刻意不提供 getWorkspaceRoot()：它只能回答「配置里记着的 root」，永远证明不了 live helper 是否
		// ready。上一版正是用它的字符串相等当作「会话可用」的判据，于是同 root 的失败重试永远跳过重连。
		// 需要 root + 就绪判定时走 withProjectSession（或 IPC 的 projectReadTarget），不要在读路径上再问一次配置值。
		/**
		 * Release the live session of one host without forgetting its verified bootstrap.
		 *
		 * The user's decision is recorded here, not re-derived later: a background read of the same root must
		 * report "disconnected" instead of quietly reconnecting and undoing what the user asked for. Only an
		 * explicit `connect` clears it again.
		 */
		async disconnect(hostId: string, reason: "abort" | "shutdown"): Promise<void> {
			await operationLock.run(hostId, async () => {
				if (HOST_ID.test(hostId)) explicitlyDisconnected.add(hostId);
				const entry = hosts.get(hostId);
				const manager = entry?.manager;
				if (manager !== undefined) await manager.disconnect(hostId, reason).catch(() => undefined);
			});
		},
		listDiagnostics(hostId?: string) {
			if (hostId !== undefined) return hosts.get(hostId)?.manager?.listDiagnostics(hostId) ?? [];
			return [...hosts.values()].flatMap((entry) => entry.manager?.listDiagnostics() ?? []);
		},
		/**
		 * Send one helper request on a ready host.
		 *
		 * **Not for project reads.** This resolves the host's *current* manager at call time, so a root switch
		 * between two calls of one operation would serve them from different sessions — the exact defect this
		 * batch removed. Read-only project surfaces must go through `withProjectSession`, which holds the
		 * host's operation lock for the whole operation and pins the session to one manager.
		 *
		 * Kept because it is the documented narrow transport-port shape (the reader owns the method-level
		 * contract; the service owns the session) and it is what main-only callers use for one-off pinned
		 * commands. The manager already refuses anything but a ready host with a live protocol client.
		 */
		request(hostId: string, method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (requestId: string) => void }): Promise<unknown> {
			const manager = hosts.get(hostId)?.manager;
			if (manager === undefined) return Promise.reject(new Error("SSH_HOST_NOT_READY"));
			return manager.request(hostId, method, params, options);
		},
		/** Withdraw a request a ready host is still holding, by the id `request` reported. */
		cancel(hostId: string, requestId: string, options?: { timeoutMs?: number }): Promise<unknown> {
			const manager = hosts.get(hostId)?.manager;
			if (manager === undefined) return Promise.reject(new Error("SSH_HOST_NOT_READY"));
			return manager.cancel(hostId, requestId, options);
		},
		/**
		 * Run one whole read-only operation against a host confined to `root`, with the session pinned.
		 *
		 * This is the single per-host boundary the whole batch exists for: switching the root, establishing the
		 * session and every frame of the operation that follows happen while holding the host's operation lock,
		 * so another project's switch queues behind instead of tearing the session down mid-read. The previous
		 * shape serialized only the switch and left the multi-chunk read outside the boundary.
		 *
		 * Beyond exclusion, the session handed to the task is *bound* to the manager it was established on: if
		 * anything ever replaces or discards that manager, the next frame fails closed with SSH_HOST_NOT_READY
		 * instead of being served by a session confined to a different root. Exclusion alone would leave that
		 * failure mode reachable the moment a future caller mutates the session outside the lock, and silently
		 * returning another project's file is the exact outcome worth a guard.
		 *
		 * Setup failures settle as `{ ok: false, code }`; a failure of the operation itself rejects so the
		 * caller keeps the reader's own stable codes.
		 */
		async withProjectSession<T>(hostId: string, root: string, task: (session: RemoteProjectSession) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
			if (disposed) return { ok: false, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
			if (!HOST_ID.test(hostId) || typeof root !== "string" || root.length === 0) return { ok: false, code: "SSH_HOST_NOT_READY" };
			return operationLock.run(hostId, async () => {
				// The user's explicit disconnect outranks a background read: report it rather than reconnecting.
				if (explicitlyDisconnected.has(hostId)) return { ok: false, code: "SSH_HOST_DISCONNECTED" };
				let session: RemoteProjectSession;
				try {
					const established = await establishProjectSession(hostId, root);
					if (!established.ok) return established;
					session = established.session;
				} catch (error) {
					// Establishing can fail in ways only the connection layer can name (a failed bootstrap, a
					// disposed manager). Relaying its own stable code keeps the UI's hint truthful; a thrown
					// surprise would otherwise be flattened into a generic read failure by the caller.
					return { ok: false, code: diagnosticCodeFromError(error) };
				}
				return { ok: true, value: await task(session) };
			});
		},
		/**
		 * Stop every host. Waits for in-flight connects so a bootstrap that is still uploading cannot
		 * publish a helper session into a disposed service; idempotent, because quit paths run twice.
		 */
		dispose(): Promise<void> {
			disposing ??= (async () => {
				disposed = true;
				const entries = [...hosts.values()];
				const pending = entries.flatMap((entry) => (entry.inFlight === undefined ? [] : [entry.inFlight.catch(() => undefined)]));
				await Promise.all(pending);
				await Promise.all(
					entries.map(async (entry) => {
						discard(entry);
					}),
				);
				hosts.clear();
			})();
			return disposing;
		},
	};
}

export type RemoteHostConnectionService = ReturnType<typeof createRemoteHostConnectionService>;
