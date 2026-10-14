import * as pty from "node-pty";
import type { Project } from "../../shared/types";
import { isRemoteProject } from "../../shared/projectLocation";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { buildRemoteTerminalCommand } from "../remote/RemoteTerminalCommand";
import { RemoteTerminalSessionManager, type RemoteTerminalResource } from "./RemoteTerminalSessionManager";

/** Wire the remote terminal domain to the one pinned host service and native PTY; no local shell fallback. */
export function createRemoteTerminalManager(options: { project(id: string): Project | undefined; service(): Promise<RemoteHostConnectionService> | undefined; emit(senderId: number, channel: string, payload: unknown): void }): RemoteTerminalSessionManager {
	return new RemoteTerminalSessionManager({
		locator: (id) => {
			const project = options.project(id);
			return project && isRemoteProject(project) ? { hostId: project.locator.hostId, remotePath: project.locator.remotePath } : undefined;
		},
		emit: options.emit,
		async start(target, nonce, signal, callbacks) {
			const service = await options.service();
			if (!service) throw new Error("REMOTE_FEATURE_DISABLED");
			if (signal.aborted) throw new Error("REMOTE_TERMINAL_CLOSED");
			const result = await service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const command = buildRemoteTerminalCommand({ root: target.remotePath, nodePath: session.nodePath, nonce });
				return session.withTerminalInvocation(command, (invocation, assertCurrent): RemoteTerminalResource => {
					if (signal.aborted) throw new Error("REMOTE_TERMINAL_CLOSED");
					// Pin preparation awaited: re-read project authority at the actual native side effect, not just publication.
					const project = options.project(target.projectId);
					if (!project || !isRemoteProject(project) || project.locator.hostId !== target.hostId || project.locator.remotePath !== target.remotePath) throw new Error("REMOTE_TERMINAL_TARGET_CHANGED");
					const terminal = pty.spawn(invocation.executable, invocation.args, { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: { ...invocation.env, TERM: "xterm-256color" } });
					let disposed = false;
					const listeners = [terminal.onData(callbacks.data), terminal.onExit((event) => callbacks.exit(event.exitCode))];
					const dispose = () => {
						if (disposed) return;
						disposed = true;
						signal.removeEventListener("abort", dispose);
						for (const listener of listeners) listener.dispose();
						try {
							terminal.kill();
						} catch {
							/* An exited native PTY is already released. */
						}
					};
					signal.addEventListener("abort", dispose, { once: true });
					return { pty: terminal, assertCurrent, dispose };
				});
			});
			if (!result.ok) throw new Error(result.code);
			return result.value;
		},
	});
}
