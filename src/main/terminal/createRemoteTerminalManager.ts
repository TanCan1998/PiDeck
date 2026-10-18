import { loadNodePty } from "./nodePtyRuntime";
import type { Project } from "../../shared/types";
import { isRemoteProject } from "../../shared/projectLocation";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { RemoteTerminalSessionManager, type RemoteTerminalResource } from "./RemoteTerminalSessionManager";
import { SshTerminalSessionLauncher } from "./SshTerminalSessionLauncher";

/**
 * Wire the remote terminal domain to the one pinned host service and native PTY; no local shell fallback.
 * The launcher owns the F3 ticket mint + fixed terminal-runner handshake; the manager keeps tab/replay
 * ownership. The pinned host session is the only producer of the ticket params (live host id, route digest,
 * project id, canonical root): nothing here accepts renderer-supplied authority.
 */
export function createRemoteTerminalManager(options: { project(id: string): Project | undefined; service(): Promise<RemoteHostConnectionService> | undefined; emit(senderId: number, channel: string, payload: unknown): void }): RemoteTerminalSessionManager {
	const launcher = new SshTerminalSessionLauncher({ spawn: (file, args, spawnOptions) => loadNodePty().spawn(file, args, spawnOptions) });
	return new RemoteTerminalSessionManager({
		locator: (id) => {
			const project = options.project(id);
			return project && isRemoteProject(project) ? { hostId: project.locator.hostId, remotePath: project.locator.remotePath } : undefined;
		},
		emit: options.emit,
		async start(target, signal, callbacks): Promise<RemoteTerminalResource> {
			const service = await options.service();
			if (!service) throw new Error("REMOTE_FEATURE_DISABLED");
			if (signal.aborted) throw new Error("REMOTE_TERMINAL_CLOSED");
			const result = await service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				// Re-read project authority at the actual native side effect, not just at publication.
				const assertProject = () => {
					const project = options.project(target.projectId);
					if (!project || !isRemoteProject(project) || project.locator.hostId !== target.hostId || project.locator.remotePath !== target.remotePath) throw new Error("REMOTE_TERMINAL_TARGET_CHANGED");
				};
				assertProject();
				return launcher.start({ session, projectId: target.projectId, hostId: target.hostId, signal, callbacks, beforeSpawn: assertProject });
			});
			if (!result.ok) throw new Error(result.code);
			return result.value;
		},
	});
}
