import type { PinnedSshInvocation } from "./SshVerifiedConnection";

/**
 * Host-level connection state (plan §10). Deliberately separate from Agent/Runtime send state:
 * a ready host does not imply a ready Agent runtime, so these values must never be folded into
 * AgentStatus or reused as session transport state.
 */
export type RemoteHostConnectionState = "disconnected" | "connecting" | "probing" | "bootstrapping" | "ready" | "degraded" | "reconnecting" | "offline" | "needs-attention";

/** Staged progress of a "test connection" run (plan §11.1). */
export type SshConnectionPhase = "openssh" | "authenticate" | "platform" | "node" | "helper" | "pi";

/**
 * Redacted diagnostic record. Only stable codes, ids, phases and exit codes are kept; command
 * lines, identity paths, ProxyCommand text and response bodies must never reach this record.
 */
export type SshConnectionDiagnostic = {
	hostId: string;
	generation: number;
	phase: SshConnectionPhase;
	state: RemoteHostConnectionState;
	code: string;
	at: string;
	exitCode?: number;
};

export type SshProcessExitKind = "exited" | "failed" | "timeout" | "stopped";

export type SshProcessExit = {
	kind: SshProcessExitKind;
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Stable launcher-level cause (e.g. bounded-output overflow) that code/signal cannot express. */
	errorCode?: string;
};

/**
 * How long a launched process may live, stated per request (plan §3.6 of the remote Phase 4 design).
 *
 * `command` (the default when the field is absent) is a one-shot: the launcher owns a wall-clock deadline
 * (`timeoutMs`, default 30 s, clamped to SSH_LAUNCHER_MAX_TIMEOUT_MS) and force-kills at it. `session` is a
 * control or agent session that must be able to outlive any such budget: no deadline timer is armed at all,
 * `timeoutMs` must be omitted, and the process ends only through its paired stop path, a spawn failure, an
 * output/line budget violation, or ssh exiting on its own (our own ServerAliveInterval/ServerAliveCountMax
 * arguments are what notice a peer that stopped answering). Its owner - the connection machine here, a
 * runner lease for agent sessions - is responsible for converging it.
 */
export type SshLauncherLifetime = "command" | "session";

/**
 * A launch request always carries the freshly preflighted pinned invocation, so the process can
 * only use the absolute OpenSSH path and sanitized environment the route check approved.
 */
export type SshLauncherRequest = {
	hostId: string;
	generation: number;
	invocation: PinnedSshInvocation;
	timeoutMs?: number;
	/**
	 * Lifetime policy of this process; absent means `command`. A `session` request must not carry
	 * `timeoutMs`: a hidden wall-clock budget is worse than none, because the caller would believe the
	 * session is bounded while it is not (the launcher refuses that combination outright).
	 */
	lifetime?: SshLauncherLifetime;
	/** Cap for *unconsumed* output: bytes handed to a line subscriber stop counting against it. */
	maxOutputBytes?: number;
	/** Longest single line a stream may accumulate without a newline before the process is killed. */
	maxLineBytes?: number;
	/** Open a writable stdin (helper protocol requests). Defaults to closed. */
	stdin?: boolean;
};

export type SshLauncherHandle = {
	readonly pid: number | undefined;
	onExit(listener: (exit: SshProcessExit) => void): () => void;
	/** Decoded stdout lines: the helper protocol frames, one line per frame. */
	onStdoutLine(listener: (line: string) => void): () => void;
	/** Decoded stderr lines, for redacted diagnostics only (never parsed as protocol data). */
	onStderrLine(listener: (line: string) => void): () => void;
	/** Write one protocol line; throws after the process settled or when stdin was not requested. */
	write(line: string): void;
	stop(reason: "abort" | "shutdown"): Promise<void>;
};

/** Injected in production with the real spawner; tests supply a fake child process. */
export type SshProcessLauncher = {
	start(request: SshLauncherRequest): Promise<SshLauncherHandle>;
};

/** Bounded backoff schedule from plan §10: 1s, 2s, 5s, 10s, 30s capped. */
export const SSH_RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
