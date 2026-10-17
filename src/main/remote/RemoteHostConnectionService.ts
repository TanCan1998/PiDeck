import { buildPinnedSshInvocation, type PinnedSshInvocation } from "./SshVerifiedConnection";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { RemoteHostStore } from "./RemoteHostStore";
import { createRemoteHostOperationLock } from "./RemoteHostOperationLock";
import { resolveRemoteBrowseRoot } from "./RemoteBrowseRoot";
import { bootstrapPinnedHost, resolveRemoteNodeExecutable } from "./RemoteBootstrapSession";
import { resolveRemotePiExecutable } from "./RemotePiDiscovery";
import { deployedRunnerPath } from "./RemoteBootstrapDeployment";
import { createSshPiRuntimeLauncher } from "./SshPiRuntimeLauncher";
import type { PiRuntimeLauncher } from "../pi/PiSpawnHandle";
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
	/** Resolve the host user's own pi (login-shell PATH + 解释器形态 + 版本窗口) —— P4.1 的只读探测。 */
	resolvePi: typeof resolveRemotePiExecutable;
	/** Build the per-host connection manager. The manager itself owns attempt lifecycles. */
	createManager: (options: { userDataDir: string; client: SshClientRuntime; launcher: SshProcessLauncher; helperSession: SshHelperSession; onStateChange?: (entry: { hostId: string; state: ConnectionMachineState }) => void }) => SshConnectionManager;
	/** Mint the bootstrap nonce; injected so tests are deterministic. */
	createNonce: () => string;
	/** Mint the login-shell probe sentinel; injected so tests are deterministic. */
	createSentinel: () => string;
	/**
	 * Re-prove that a project's boundary still canonicalizes to itself (a pinned `readlink -f`). Injected so
	 * tests never probe a real host; the default is the same resolver the enrollment flow already uses.
	 */
	verifyRoot: (input: { userDataDir: string; hostId: string; client: SshClientRuntime; userPath: string }) => Promise<{ canonicalPath: string }>;
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
	/** Explicit disconnect closes independent terminal PTYs, not ordinary helper root switches. */
	onDisconnect?: (hostId: string) => void;
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
	/** 已验证且与本次会话同代的Node/主机版本，仅供main受控文件命令使用。 */
	readonly nodePath: string;
	/** The confirmed content address of the active bundle: the ticket and the runner path both name it. */
	readonly deployRoot: string;
	readonly bundleSha256: string;
	/** The pin-confirmed route digest of this host revision; the ticket binds it, main never guesses it. */
	readonly hostRouteDigest: string;
	readonly hostRevision: number;
	runCommand(remoteCommand: string): Promise<{ exitCode: number; stdout: string }>;
	/** Build and consume an interactive invocation under the host lock; no escaped stale spawn plan. */
	withTerminalInvocation<T>(remoteCommand: string, launch: (invocation: PinnedSshInvocation, assertCurrent: () => Promise<void>) => T): Promise<T>;
	request(method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (requestId: string) => void; repo?: string }): Promise<unknown>;
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
type PiProbeFacts = { readonly revision: number; readonly generation: number; readonly piPath: string; readonly version: string; readonly warning?: string };

/** 一台主机上「跑远端 pi 会话」所需的全部事实（P4.2 的启动准备消费它）。 */
export type RemotePiRuntimeFacts = {
	readonly nodePath: string;
	readonly piPath: string;
	readonly version: string;
	/** 高于已核验窗口时的提示码（放行但不冒充已核验组合）。 */
	readonly warning?: string;
	/** 远端 runner.mjs 的绝对路径（内容寻址部署包内，由 held bootstrap 推出）。 */
	readonly runnerPath: string;
};

type HostEntry = {
	generation: number;
	held?: HeldBootstrap;
	/**
	 * Cached pi probe of this host, valid exactly as long as the held bootstrap it was taken under.
	 *
	 * The probe costs two remote round trips (login-shell PATH, then the version command), and every new
	 * remote session needs the answer; caching it per held session keeps session creation cheap without
	 * inventing a TTL (a reconnect or rebind drops the held session, which drops this with it).
	 */
	piProbe?: PiProbeFacts;
	manager?: SshConnectionManager;
	/** In-flight connect, so dispose can wait for it instead of racing the spawn. */
	inFlight?: Promise<RemoteHostConnectResult>;
};

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 16 random bytes base64url: matches the 15–63 character nonce the frozen entry accepts. */
const DEFAULT_NONCE_BYTES = 16;
/** Nonces must stay distinguishable between attempts of the same host. */
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;

/**
 * 生成一个**必定符合 NONCE 契约**的引导 nonce。
 *
 * 契约（与冻结的 helper bundle 共用）要求首字符是字母数字，而 `randomBytes(n).toString("base64url")`
 * 的首字符有 2/64 ≈ 3.1% 的概率是 `-` 或 `_` —— 曾经的实现正好用它，于是服务**自己生成、自己校验**
 * 时会偶发抛 `REMOTE_CONNECTION_NONCE_INVALID`，表现为「有时连得上、有时一按连接就失败」。
 * 真机 e2e 抓到了这一次（第 5 次运行卡在连接步骤）。hex 恒满足契约，且同样不透明、同样 128 位熵。
 * 不修契约是因为它同时约束远端 helper（改契约要 bump bundle 版本与 sha）。
 */
export function createBootstrapNonce(): string {
	return randomBytes(DEFAULT_NONCE_BYTES).toString("hex");
}
/** Control bytes must never survive in a path handed on to another module. */
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;
/** Upper bound of a remote HOME, matching the helper contract's own ceiling. */
const MAX_REMOTE_HOME_LENGTH = 4096;

/**
 * Re-validate a remote HOME on the way out of this service.
 *
 * The manager stores only what its own shape check accepted, but this value is still remote input: it
 * arrives in a helper handshake, and callers join it into remote session paths. The egress check is
 * therefore repeated here (non-empty, absolute POSIX, no control bytes, bounded length) instead of trusting
 * an upstream filter, and a value that does not pass is reported as "unknown" rather than partially used.
 */
function readRemoteHome(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_HOME_LENGTH) return undefined;
	if (value.charAt(0) !== "/" || CONTROL_BYTES.test(value)) return undefined;
	return value;
}

function defaultPorts(): RemoteHostConnectionPorts {
	return {
		bootstrap: bootstrapPinnedHost,
		resolveNode: resolveRemoteNodeExecutable,
		resolvePi: resolveRemotePiExecutable,
		createManager: (options) => createSshConnectionManager(options),
		createNonce: createBootstrapNonce,
		createSentinel: () => randomBytes(DEFAULT_NONCE_BYTES).toString("hex"),
		verifyRoot: (input) => resolveRemoteBrowseRoot(input),
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
	/**
	 * The most recent **failed** re-check of one confirmed root, keyed by host and then by root.
	 *
	 * This is the whole storage of design (i) and it is deliberately project-scoped: a moved directory is a
	 * property of *this project's persisted path*, not of the host's health, so nothing here may drive the
	 * host connection state. Moving project A's root must not block reads of project B on the same host -
	 * that is exactly why the drift is not routed into the host's needs-attention state.
	 *
	 * Only stable codes are stored (both producers below are stable), a later failure overwrites the earlier
	 * one for the same key, and a successful re-check of that key removes it. Nothing else clears a key: a
	 * query must never be able to make an unresolved boundary look healthy.
	 */
	const rootFailures = new Map<string, Map<string, string>>();
	let disposed = false;

	/** Remember (or overwrite) the failure of one confirmed root, and answer the caller's failure shape. */
	function rememberRootFailure(hostId: string, root: string, code: string): { ok: false; code: string } {
		const byRoot = rootFailures.get(hostId) ?? new Map<string, string>();
		byRoot.set(root, code);
		rootFailures.set(hostId, byRoot);
		return { ok: false, code };
	}

	/** A re-check proved this boundary again: the key - and only this key - is cleared. */
	function forgetRootFailure(hostId: string, root: string): void {
		const byRoot = rootFailures.get(hostId);
		if (byRoot === undefined) return;
		byRoot.delete(root);
		if (byRoot.size === 0) rootFailures.delete(hostId);
	}
	let disposing: Promise<void> | undefined;

	/** Read the current store revision, so a held bootstrap can be tied to the profile it came from. */
	async function readRevision(): Promise<number> {
		return (await RemoteHostStore.open(options.userDataDir)).getSnapshot().revision;
	}

	/** The revision and the pin-confirmed route digest of one host, read together so they cannot disagree. */
	async function readVerifiedRoute(hostId: string): Promise<{ revision: number; routeDigest: string } | null> {
		const snapshot = (await RemoteHostStore.open(options.userDataDir)).getSnapshot();
		if (snapshot.status !== "ready") return null;
		const profile = snapshot.profiles.find((item) => item.id === hostId);
		const endpoint = profile && profile.disabledAt === undefined ? profile.verifiedEndpoint : undefined;
		if (!endpoint || typeof endpoint.routeDigest !== "string" || !/^[0-9a-f]{64}$/.test(endpoint.routeDigest)) return null;
		return { revision: snapshot.revision, routeDigest: endpoint.routeDigest };
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
		let manager: SshConnectionManager | undefined;
		manager = ports.createManager({
			userDataDir: options.userDataDir,
			client: options.client,
			launcher,
			helperSession: held.session,
			...(options.onStateChange === undefined
				? {}
				: {
						onStateChange: (change: { hostId: string; state: ConnectionMachineState }) => {
							// Root switches dispose the old helper asynchronously. Its shutdown is not a new host outage.
							if (manager && hosts.get(change.hostId)?.manager === manager) options.onStateChange?.(change);
						},
					}),
		});
		return manager;
	}

	/** Drop every resource of one host. The manager owns its attempts, so it is disposed first. */
	function discard(entry: HostEntry): void {
		entry.held = undefined;
		// 同一个 held bootstrap 才代表同一台远端机器的同一份 pi 事实：一旦丢弃会话，缓存的探测也必须丢弃，
		// 否则重连后会拿着一台已退役/已重建主机的 pi 路径去启会话。
		entry.piProbe = undefined;
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
		if (explicitlyDisconnected.has(hostId)) return { ok: false, hostId, code: "SSH_HOST_DISCONNECTED" };
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
			// needs-attention is terminal for the reducer: `begin-attempt` is dropped there, so a plain connect
			// would only report the terminal state back and the user's own "connect" could never leave it. The
			// reducer's one legal exit is `user-retry`, which is exactly what an explicit connect means here.
			const state = manager.getState(hostId).state === "needs-attention" ? await manager.retry(hostId) : await manager.connect(hostId);
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
	/**
	 * Re-prove that a project's boundary still canonicalizes to itself.
	 *
	 * A persisted `remotePath` is only a string from `ProjectStore`; nothing about it proves the directory is
	 * still the one the user confirmed. A path that was deleted, replaced, or whose symlink now points
	 * elsewhere would otherwise be read as if it were that boundary. Worth one pinned `readlink -f` per
	 * session establishment (drift is a low-frequency event); far too expensive on every read.
	 *
	 * This is also the only place a project's root status changes: a failure is recorded under (hostId, root)
	 * and a success clears that same key, so `projectRootStatus` answers from evidence instead of guessing.
	 */
	async function verifyProjectRoot(hostId: string, root: string): Promise<{ ok: true } | { ok: false; code: string }> {
		let canonicalPath: string;
		try {
			canonicalPath = (await ports.verifyRoot({ userDataDir: options.userDataDir, hostId, client: options.client, userPath: root })).canonicalPath;
		} catch {
			// The probe's own code describes the probe, not the project boundary; callers act on the latter.
			return rememberRootFailure(hostId, root, "SSH_PROJECT_ROOT_UNRESOLVED");
		}
		if (canonicalPath !== root) return rememberRootFailure(hostId, root, "SSH_PROJECT_ROOT_CHANGED");
		// Only a proven boundary clears the record - and only its own key, so another project's unresolved
		// root on the same host stays visible.
		forgetRootFailure(hostId, root);
		return { ok: true };
	}

	async function establishProjectSession(hostId: string, root: string): Promise<{ ok: true; session: RemoteProjectSession } | { ok: false; code: string }> {
		const entry = entryFor(hostId);
		// 保存令牌绑定host store代数；登记/重绑后不能一直复用旧held使所有重载永久失败。
		if (entry.held && entry.held.revision !== (await readRevision())) discard(entry);
		if ((workspaceRoots.get(hostId) ?? options.root) !== root) {
			// A different root means a different helper session: the running one was started with the old
			// `--root` (possibly none), so nothing about it can be reused.
			workspaceRoots.set(hostId, root);
			discard(entry);
		}
		let manager = entry.manager;
		// A ready session on the requested root is the only case that needs neither a probe nor a new session.
		let reestablish = true;
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
			} else if (current.state === "ready") {
				// A ready session normally skips the re-check: that is the hot-path promise, and a reuse must not pay
				// for a probe. The one exception is a key this service already marked failed - the record is then the
				// only thing making the project look broken, so re-verify before serving. It is also the only way such
				// a record can clear on a host whose session was re-established without a probe (an explicit connect
				// is not a boundary check), which would otherwise leave a permanent false warning while reads work.
				reestablish = rootFailures.get(hostId)?.has(root) === true;
			}
		}
		if (reestablish) {
			// Re-check the boundary before rebuilding or reconnecting on it. Runs here, inside the host's
			// operation lock: probing first and establishing outside it would leave a window in which the
			// verified path is not the path the session is actually confined to.
			const verified = await verifyProjectRoot(hostId, root);
			if (!verified.ok) {
				// Fail-closed read plus a per-project record (design (i), phase 4). The record is deliberately
				// project-scoped: a moved directory is a property of this confirmed path, not of the host's health,
				// so nothing here may drive the host connection state. Routing it into the host's needs-attention
				// would let one moved directory block every other project on that host - the exact outcome (i)
				// exists to avoid. Surfacing happens through `projectRootStatus`, which answers from this record
				// without touching the host: no connect, no probe, no session.
				//
				// Consequence, stated so it is not re-wired by accident: drift no longer calls
				// `manager.reportNeedsAttention` at all. That manager entry point and the reducer's newly opened
				// disconnected/offline sources stay as a general capability (the reachable needs-attention trigger
				// for root drift remains the helper handshake, SSH_HELPER_ROOT_MISMATCH, FATAL - covered end to end
				// in tests/sshConnectionManager.test.mjs), but they have no production caller for this condition.
				return verified;
			}
		}
		if (manager === undefined) {
			const held = await ensureHeld(entry, hostId);
			manager = managerFor(held);
			entry.manager = manager;
			const connected = await manager.connect(hostId);
			if (connected.state !== "ready") return { ok: false, code: connected.lastCode ?? "SSH_HOST_NOT_READY" };
		} else if (reestablish) {
			// disconnected/offline: the verified helper location is still valid, so revive in place instead of
			// paying for node discovery and another upload.
			const revived = await manager.connect(hostId);
			if (revived.state !== "ready") return { ok: false, code: revived.lastCode ?? "SSH_HOST_NOT_READY" };
		}
		const bound = manager;
		const held = entry.held;
		if (!held) return { ok: false, code: "SSH_HOST_NOT_READY" };
		// The launch ticket binds a host revision and its pin-confirmed route. A stale revision still fails closed, but a
		// store that cannot name the route must not disable ordinary reads: `hostRouteDigest: ""` makes the terminal
		// launcher refuse to mint (it requires 64 hex) while reads stay independent of the ticket surface.
		const route = await readVerifiedRoute(hostId);
		if (route !== null && route.revision !== held.revision) return { ok: false, code: "SSH_HOST_NOT_READY" };
		return {
			ok: true,
			session: {
				hostId,
				nodePath: held.session.nodePath,
				deployRoot: held.session.deployRoot,
				bundleSha256: held.session.bundleSha256,
				hostRouteDigest: route?.routeDigest ?? "",
				hostRevision: held.revision,
				async runCommand(remoteCommand) {
					// 每块重新校验pin和host store代数；不能拿旧Node路径向重绑后的主机发写命令。
					if (disposed || hosts.get(hostId)?.manager !== bound || bound.getState(hostId).state !== "ready" || (await readRevision()) !== held.revision) throw new Error("SSH_HOST_NOT_READY");
					const invocation = await buildPinnedSshInvocation(options.userDataDir, hostId, "ssh-batch", { client: options.client, remoteCommand });
					// pin/route构造本身有await；必须在真正启动写命令前再次把host代数绑定到已验证Node。
					if (disposed || hosts.get(hostId)?.manager !== bound || bound.getState(hostId).state !== "ready" || (await readRevision()) !== held.revision) throw new Error("SSH_HOST_NOT_READY");
					const result = await options.client.run(invocation.executable, invocation.args);
					return { exitCode: result.exitCode, stdout: result.stdout };
				},
				async withTerminalInvocation(remoteCommand, launch) {
					const assertBound = async () => {
						if (disposed || explicitlyDisconnected.has(hostId) || hosts.get(hostId)?.manager !== bound || bound.getState(hostId).state !== "ready" || (await readRevision()) !== held.revision) throw new Error("SSH_HOST_NOT_READY");
					};
					await assertBound();
					const invocation = await buildPinnedSshInvocation(options.userDataDir, hostId, "ssh-terminal", { client: options.client, remoteCommand });
					await assertBound();
					// The PTY outlives helper-root switches, but never a host rebind, explicit disconnect or disposal.
					const assertCurrent = async () => {
						if (disposed || explicitlyDisconnected.has(hostId) || (await readRevision()) !== held.revision) throw new Error("SSH_HOST_NOT_READY");
					};
					return launch(invocation, assertCurrent);
				},
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

	/** 只读缓存里的 home（`remoteHome` 的实现体；抽出来让「确保式」版本复用同一套校验）。 */
	const readCachedHome = async (hostId: string): Promise<string | undefined> => {
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return undefined;
		const manager = hosts.get(hostId)?.manager;
		if (manager === undefined) return undefined;
		try {
			// Only a live session whose handshake succeeded may name a home: reconnecting/offline (and a
			// terminal needs-attention) are not "connected", and a home recorded by an earlier ready session
			// must not outlive the session it was proven on.
			const state = manager.getState(hostId).state;
			if (state !== "ready" && state !== "degraded") return undefined;
			return readRemoteHome(manager.getHome(hostId));
		} catch {
			return undefined;
		}
	};

	/**
	 * 解析某主机的已验证 HOME，**缓存状态读不到时按需建立会话**。
	 *
	 * `remoteHome` 是纯读：它只从「已经活着的会话」回答。这对会话扫描不够——扫描要用 HOME 推
	 * 会话根，而它通常紧跟在「登记/读取项目」之后执行，那些路径会在任务结束时收掉自己建立的临时
	 * 会话。于是扫描正好落进「没有缓存 manager/状态」的窗口，报「拿不到 home」，尽管那一刻完全
	 * 可以建立会话。真机 e2e 证据：前后状态都是 ready、同主机稍后再扫就成功。
	 *
	 * 这里 connect 不是额外开销：扫描本来就要做远端 I/O。**UI 用的 `remoteHome` 保持只读不变**。
	 */
	const readHomeEnsuring = async (hostId: string): Promise<string | undefined> => {
		if (disposed || explicitlyDisconnected.has(hostId)) return undefined;
		const cached = await readCachedHome(hostId);
		if (cached !== undefined) return cached;
		const entry = entryFor(hostId);
		const run = operationLock.run(hostId, () => connectLocked(hostId));
		entry.inFlight = run;
		try {
			const result = await run;
			if (!result.ok) return undefined;
		} catch {
			return undefined;
		} finally {
			if (entry.inFlight === run) entry.inFlight = undefined;
		}
		return readCachedHome(hostId);
	};
	return {
		/**
		 * The verified client this service drives.
		 *
		 * Exposed to main-only consumers that must run their own pinned command against the same client the
		 * connection uses — resolving a browse root, for instance. Sharing the instance is the point: a second
		 * client could resolve through a different environment than the one the session was verified with.
		 */
		client: options.client,
		/**
		 * 与会话配对的远端启动器：复用本服务**已验证的** client 与同一个 ssh launcher。
		 *
		 * 为什么在这里造而不是让调用方自己 new：第二条通道一旦用另一个 client 实例，就会用一套不同于会话
		 * 验证时的环境/路径去拉 ssh——那正是「连得上但行为不一样」的根源；而且 launcher 的生命周期本就属于本服务。
		 */
		createPiRuntimeLauncher(): PiRuntimeLauncher {
			return createSshPiRuntimeLauncher({ userDataDir: options.userDataDir, client: options.client, launcher });
		},
		/** Bootstrap-then-connect one host. Every failure is a stable code, never a thrown message. */
		async connect(hostId: string): Promise<RemoteHostConnectResult> {
			const entry = entryFor(hostId);
			// Only this explicit user boundary may undo a disconnect; session scanning also uses connectLocked.
			const run = operationLock.run(hostId, () => {
				explicitlyDisconnected.delete(hostId);
				return connectLocked(hostId);
			});
			entry.inFlight = run;
			try {
				return await run;
			} finally {
				if (entry.inFlight === run) entry.inFlight = undefined;
			}
		},
		/**
		 * The verified remote HOME of one host, for readers that derive a remote session root from it.
		 *
		 * Narrow on purpose, and it never throws: an unknown host, a host with no manager, a host whose
		 * machine is not actually connected, and a home that does not look like an absolute POSIX path all
		 * answer `undefined`. Callers run across IPC, where "not connected yet" is an ordinary state, not an
		 * error. The value is remote input, so it is re-validated here rather than trusted because the
		 * manager already filtered it once.
		 */
		async remoteHome(hostId: string): Promise<string | undefined> {
			return readCachedHome(hostId);
		},
		/**
		 * 与 `remoteHome` 同一语义，但缓存状态读不到时**按需建立会话**再读一次。
		 *
		 * 会话扫描专用（`RemoteSessionScanner` 是 `remoteHome` 的唯一生产调用方）：扫描总是紧跟
		 * 在登记/读取项目之后，而那些路径会收掉临时会话，导致纯读在那一刻拿不到 home。
		 */
		async remoteHomeEnsuring(hostId: string): Promise<string | undefined> {
			return readHomeEnsuring(hostId);
		},
		/**
		 * The last re-check outcome of one project's confirmed boundary, by (hostId, root).
		 *
		 * Read-only and side-effect free by construction: the answer comes from what previous re-checks
		 * recorded, so asking never connects, never probes and never opens a session - that is what lets the UI
		 * ask on every render without waking a host. A key this service never saw, or one whose re-check later
		 * succeeded, is "ok": the status says nothing is *known* to be wrong with this path, and knowing more
		 * requires a real re-check at session establishment, not a query.
		 *
		 * Project-scoped on purpose (design (i)): the same host can hold a drifted project and healthy ones,
		 * and each answers for its own root.
		 */
		projectRootStatus(hostId: string, root: string): { status: "ok" } | { status: "needs-attention"; code: string } {
			const code = rootFailures.get(hostId)?.get(root);
			return code === undefined ? { status: "ok" } : { status: "needs-attention", code };
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
				options.onDisconnect?.(hostId);
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
		 * 一台主机上「跑远端 pi 会话」所需的全部事实：解释器、pi 入口、runner 路径。
		 *
		 * 只读，但**按需建立受管会话**（与会话扫描的 `remoteHomeEnsuring` 同一立场：调用它的路径紧接着就要
		 * 起会话，先拿事实再单独连一次只会多一次往返）。`runnerPath` 由 held bootstrap 的
		 * `{deployRoot, bundleSha256}` 推出（内容寻址，不存在“路径漂移”）；pi 探测按 held bootstrap 缓存
		 * （重连/rebind 会丢掉 held，缓存随之失效——所以不需要 TTL）。
		 *
		 * 失败一律稳定码：`SSH_HOST_ID_INVALID`（入参）、`SSH_HOST_NOT_READY`（会话没建起来），
		 * 其余是探测自己的 `REMOTE_PI_*` 码原样透传（调用方据此给升级指引）。
		 */
		async remotePiRuntimeFacts(hostId: string): Promise<RemotePiRuntimeFacts> {
			if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("SSH_HOST_ID_INVALID");
			return operationLock.run(hostId, async () => {
				const entry = entryFor(hostId);
				if (entry.held === undefined) {
					const result = await connectLocked(hostId);
					if (!result.ok) throw new Error("SSH_HOST_NOT_READY");
				}
				const held = entry.held;
				if (held === undefined) throw new Error("SSH_HOST_NOT_READY");
				const cached = entry.piProbe;
				const probe =
					cached !== undefined && cached.revision === held.revision && cached.generation === held.generation
						? cached
						: await (async (): Promise<PiProbeFacts> => {
								const observation = await ports.resolvePi({ userDataDir: options.userDataDir, hostId, client: options.client, sentinel: ports.createSentinel(), nodePath: held.session.nodePath });
								const facts: PiProbeFacts = { revision: held.revision, generation: held.generation, piPath: observation.piPath, version: observation.version, ...(observation.warning === undefined ? {} : { warning: observation.warning }) };
								entry.piProbe = facts;
								return facts;
							})();
				return {
					nodePath: held.session.nodePath,
					piPath: probe.piPath,
					version: probe.version,
					...(probe.warning === undefined ? {} : { warning: probe.warning }),
					runnerPath: deployedRunnerPath({ bundleSha256: held.session.bundleSha256, deployRoot: held.session.deployRoot, active: `./bundles/${held.session.bundleSha256}` }),
				};
			});
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
		request(hostId: string, method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (requestId: string) => void; repo?: string }): Promise<unknown> {
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
		async withProjectSession<T>(hostId: string, root: string, task: (session: RemoteProjectSession) => Promise<T>, readOptions?: { requireReady?: boolean; signal?: AbortSignal }): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
			if (disposed) return { ok: false, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
			if (!HOST_ID.test(hostId) || typeof root !== "string" || root.length === 0) return { ok: false, code: "SSH_HOST_NOT_READY" };
			return operationLock.run(hostId, async () => {
				// The user's explicit disconnect outranks a background read: report it rather than reconnecting.
				if (explicitlyDisconnected.has(hostId)) return { ok: false, code: "SSH_HOST_DISCONNECTED" };
				// Git panel reads may switch a ready helper's project root, but never revive an offline host.
				// Apply this inside the same host lock, not just in a renderer/preflight state check.
				if (readOptions?.signal?.aborted) return { ok: false, code: "REQUEST_CANCELLED" };
				if (readOptions?.requireReady && hosts.get(hostId)?.manager?.getState(hostId).state !== "ready") return { ok: false, code: "SSH_HOST_NOT_READY" };
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
				if (readOptions?.signal?.aborted) return { ok: false, code: "REQUEST_CANCELLED" };
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
				for (const hostId of hosts.keys()) options.onDisconnect?.(hostId);
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
