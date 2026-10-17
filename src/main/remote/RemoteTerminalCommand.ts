import { buildRemoteRunnerCommand } from "./RemoteRunnerContract";

export type RemoteTerminalRunnerCommandInput = { runnerPath: string; nodePath: string };

/**
 * The fixed interactive entry for a remote PTY (F3 / plan §6.5.2): the trusted Node executable plus the
 * frozen terminal runner inside the active bundle, and nothing else. Cwd, shell, ticket and user text travel
 * over the runner's init frame, never in this command line; a path that is not exactly
 * `<deployRoot>/bundles/<64hex>/terminal-runner.mjs` is refused before the pinned ssh boundary is reached.
 */
export function buildRemoteTerminalRunnerCommand(input: RemoteTerminalRunnerCommandInput): string {
	if (!input || typeof input !== "object") throw new Error("REMOTE_TERMINAL_OPTIONS_INVALID");
	if (typeof input.runnerPath !== "string" || !/^\/.+\/bundles\/[0-9a-f]{64}\/terminal-runner\.mjs$/.test(input.runnerPath)) throw new Error("REMOTE_TERMINAL_OPTIONS_INVALID");
	try {
		return buildRemoteRunnerCommand(input.runnerPath, input.nodePath);
	} catch {
		throw new Error("REMOTE_TERMINAL_OPTIONS_INVALID");
	}
}
