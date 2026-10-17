import type { IPty } from "node-pty";
import {
	buildRemoteTerminalInitFrame,
	decodeRemoteTerminalStartFrame,
	REMOTE_HELPER_METHOD_TERMINAL_PREPARE,
	REMOTE_TERMINAL_ERROR_MARKER,
	REMOTE_TERMINAL_FRAME_RS,
	REMOTE_TERMINAL_FRAME_TERMINATOR,
	REMOTE_TERMINAL_FRAME_US,
	REMOTE_TERMINAL_HANDSHAKE_TIMEOUT_MS,
	REMOTE_TERMINAL_PRE_START_MAX_BYTES,
	REMOTE_TERMINAL_READY_MARKER,
	REMOTE_TERMINAL_RUNNER_ERROR_CODES,
	REMOTE_TERMINAL_START_MARKER,
	REMOTE_TERMINAL_TICKET_REF_PATTERN,
} from "../remote/RemoteHelperContract";
import { deployedTerminalRunnerPath } from "../remote/RemoteBootstrapDeployment";
import { buildRemoteTerminalRunnerCommand } from "../remote/RemoteTerminalCommand";
import type { PinnedSshInvocation } from "../remote/SshVerifiedConnection";
import type { RemoteTerminalResource } from "./RemoteTerminalSessionManager";

/** Narrow view of the verified remote session the launcher needs; the adapter owns how it was established. */
export type SshTerminalLaunchSession = {
	readonly hostId: string;
	readonly hostRouteDigest: string;
	readonly nodePath: string;
	readonly deployRoot: string;
	readonly bundleSha256: string;
	request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
	withTerminalInvocation<T>(remoteCommand: string, launch: (invocation: PinnedSshInvocation, assertCurrent: () => Promise<void>) => T): Promise<T>;
};

export type SshTerminalSessionLauncherDependencies = {
	/** node-pty spawn, injected so tests can drive the handshake without a real PTY. */
	spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }): IPty;
	handshakeTimeoutMs?: number;
};

export type SshTerminalLaunchInput = {
	session: SshTerminalLaunchSession;
	projectId: string;
	hostId: string;
	signal: AbortSignal;
	callbacks: { data(data: string): void; exit(code: number): void };
	/** Re-read project authority immediately before the native spawn, after the pinned invocation was prepared. */
	beforeSpawn?: () => void;
};

const ERROR_CODES: ReadonlySet<string> = new Set(REMOTE_TERMINAL_RUNNER_ERROR_CODES);
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Only stable codes cross this boundary; anything else becomes START_FAILED, never raw diagnostics. */
function stableTerminalError(error: unknown): Error {
	const message = typeof error === "object" && error !== null && "message" in error && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
	return new Error(/^(?:SSH_|REMOTE_|PROJECT_|TERMINAL_)[A-Z0-9_]{1,100}$/.test(message) ? message : "REMOTE_TERMINAL_START_FAILED");
}

function readTicketRef(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("REMOTE_TERMINAL_START_FAILED");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 1 || typeof record.ticketRef !== "string" || !REMOTE_TERMINAL_TICKET_REF_PATTERN.test(record.ticketRef)) throw new Error("REMOTE_TERMINAL_START_FAILED");
	return record.ticketRef;
}

/**
 * Own the SSH side of one remote PTY (F3 / plan §6.5.2): mint one ticket for the verified session, build the
 * fixed Node+runner command, spawn inside the pinned host invocation, then run the bounded READY/START handshake.
 * The init frame is the only input written before START; everything after the START frame is terminal bytes and
 * is delivered exactly once, while anything between the frames is handshake/control echo and is stripped.
 */
export class SshTerminalSessionLauncher {
	private readonly handshakeTimeoutMs: number;
	constructor(private readonly deps: SshTerminalSessionLauncherDependencies) {
		this.handshakeTimeoutMs = deps.handshakeTimeoutMs ?? REMOTE_TERMINAL_HANDSHAKE_TIMEOUT_MS;
	}

	async start(input: SshTerminalLaunchInput): Promise<RemoteTerminalResource & { shell?: string }> {
		const { session, signal } = input;
		// The ticket binds the live host identity and route digest main already proved; a mismatch is a target change.
		if (session.hostId !== input.hostId) throw new Error("REMOTE_TERMINAL_TARGET_CHANGED");
		if (typeof session.hostRouteDigest !== "string" || !/^[0-9a-f]{64}$/.test(session.hostRouteDigest)) throw new Error("REMOTE_TERMINAL_START_FAILED");
		let prepared: unknown;
		try {
			prepared = await session.request(REMOTE_HELPER_METHOD_TERMINAL_PREPARE, { kind: "project", projectId: input.projectId, hostId: input.hostId, routeDigest: session.hostRouteDigest });
		} catch (error) {
			throw stableTerminalError(error);
		}
		const ticketRef = readTicketRef(prepared);
		const runnerPath = deployedTerminalRunnerPath({ deployRoot: session.deployRoot, bundleSha256: session.bundleSha256 });
		const command = buildRemoteTerminalRunnerCommand({ runnerPath, nodePath: session.nodePath });
		const spawned = await session.withTerminalInvocation(command, (invocation, assertCurrent) => {
			if (signal.aborted) throw new Error("REMOTE_TERMINAL_CLOSED");
			input.beforeSpawn?.();
			const pty = this.deps.spawn(invocation.executable, invocation.args, { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: { ...invocation.env, TERM: "xterm-256color" } });
			return { pty, assertCurrent };
		});
		return this.handshake(spawned.pty, spawned.assertCurrent, ticketRef, input);
	}

	private handshake(pty: IPty, assertCurrent: () => Promise<void>, ticketRef: string, input: SshTerminalLaunchInput): Promise<RemoteTerminalResource & { shell?: string }> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let ready = false;
			let initSent = false;
			let disposed = false;
			let preStart = "";
			let dataListener: { dispose(): void } | undefined;
			let exitListener: { dispose(): void } | undefined;
			const timer = setTimeout(() => settle(new Error("REMOTE_TERMINAL_START_TIMEOUT")), this.handshakeTimeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				try {
					dataListener?.dispose();
				} catch {}
				try {
					exitListener?.dispose();
				} catch {}
				input.signal.removeEventListener("abort", onAbort);
			};
			const disposePty = () => {
				if (disposed) return;
				disposed = true;
				cleanup();
				try {
					pty.kill();
				} catch {
					/* An already exited native PTY is released. */
				}
			};
			const resource = (): RemoteTerminalResource & { shell?: string } => ({
				pty: {
					write: (data: string) => pty.write(data),
					resize: (cols: number, rows: number) => pty.resize(cols, rows),
					pause: () => pty.pause(),
					resume: () => pty.resume(),
				},
				assertCurrent,
				dispose: disposePty,
				shell: shell,
			});
			let shell: string | undefined;
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (error) {
					disposePty();
					reject(error);
					return;
				}
				resolve(resource());
			};
			const onAbort = () => {
				if (settled) disposePty();
				else settle(new Error("REMOTE_TERMINAL_CLOSED"));
			};
			/**
			 * Extract one handshake frame from the pre-start buffer. Windows node-pty ConPTY strips the C0 RS/US
			 * wrapper but keeps CRLF; therefore the plain marker is matched and the frame ends at the first CRLF,
			 * with an optional US and/or extra CR accepted before it (Linux PTY with ONLCR sends CR CR LF). Bytes
			 * between frames are ConPTY noise/control echo and are discarded by advancing to the terminator.
			 */
			const takeFrame = (marker: string): { token: string; rest: string } | null => {
				const at = preStart.indexOf(marker);
				if (at < 0) return null;
				// RS is never required and never needed to locate the end: the terminator is authoritative.
				const after = at + marker.length;
				let end = preStart.indexOf(REMOTE_TERMINAL_FRAME_TERMINATOR, after);
				let terminator = REMOTE_TERMINAL_FRAME_TERMINATOR.length;
				if (end < 0) {
					// A bare LF is the last tolerated termination shape; anything else means the frame is incomplete.
					end = preStart.indexOf("\n", after);
					terminator = 1;
					if (end < 0) return null;
				}
				let token = preStart.slice(after, end);
				for (;;) {
					const last = token.charAt(token.length - 1);
					if (last === REMOTE_TERMINAL_FRAME_US || last === "\r") token = token.slice(0, -1);
					else break;
				}
				return { token: token, rest: preStart.slice(end + terminator) };
			};
			const consume = (data: string) => {
				if (ready) {
					input.callbacks.data(data);
					return;
				}
				preStart += data;
				if (Buffer.byteLength(preStart, "utf8") > REMOTE_TERMINAL_PRE_START_MAX_BYTES) {
					settle(new Error("REMOTE_TERMINAL_START_FAILED"));
					return;
				}
				const earlyError = takeFrame(REMOTE_TERMINAL_ERROR_MARKER);
				if (earlyError !== null) {
					settle(new Error(ERROR_CODES.has(earlyError.token) ? earlyError.token : "TERMINAL_INTERNAL"));
					return;
				}
				if (!initSent) {
					const readyFrame = takeFrame(REMOTE_TERMINAL_READY_MARKER);
					if (readyFrame === null) return;
					preStart = readyFrame.rest;
					initSent = true;
					pty.write(buildRemoteTerminalInitFrame(ticketRef));
				}
				const startFrame = takeFrame(REMOTE_TERMINAL_START_MARKER);
				if (startFrame === null) return;
				const decoded = decodeRemoteTerminalStartFrame(startFrame.token);
				if (decoded === null) {
					settle(new Error("REMOTE_TERMINAL_START_FAILED"));
					return;
				}
				preStart = "";
				ready = true;
				shell = decoded.shell;
				settled = true;
				clearTimeout(timer);
				// Frames are gone; the remainder may hold the first shell bytes of the same chunk. Delivered once.
				if (startFrame.rest.length > 0) input.callbacks.data(startFrame.rest);
				resolve(resource());
			};
			dataListener = pty.onData(consume);
			exitListener = pty.onExit((event) => {
				if (!ready) {
					settle(new Error("REMOTE_TERMINAL_START_FAILED"));
					return;
				}
				input.callbacks.exit(event.exitCode);
			});
			input.signal.addEventListener("abort", onAbort, { once: true });
			if (input.signal.aborted) onAbort();
		});
	}
}
