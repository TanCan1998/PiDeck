import { posix } from "node:path";
import { quotePosixArgument } from "./RemoteBootstrapContract";
import { readCanonicalBrowseRoot } from "./RemoteBrowseRoot";

export type RemoteTerminalCommandInput = { root: string; nodePath: string; nonce: string };

/** Fixed interactive entry: validate cwd before announcing readiness; never interpolate executable code. */
export function buildRemoteTerminalCommand(input: RemoteTerminalCommandInput): string {
	if (!input || !/^[0-9a-f]{32}$/.test(input.nonce)) throw new Error("REMOTE_TERMINAL_OPTIONS_INVALID");
	for (const value of [input.root, input.nodePath]) if (readCanonicalBrowseRoot(value).canonicalPath !== value) throw new Error("REMOTE_TERMINAL_OPTIONS_INVALID");
	const root = quotePosixArgument(input.root);
	// ENV is deliberately empty: an interactive sh rc must not silently move the initial project cwd.
	// PATH changes only this process; it exposes the already-verified Node without modifying the host.
	const command = `cd -- ${root} && [ "$(pwd -P)" = ${root} ] && [ -x /bin/sh ] || exit 73; PATH=${quotePosixArgument(posix.dirname(input.nodePath))}:"$PATH"; export PATH; ENV=; export ENV; printf '\\036PIDECK_TERM_${input.nonce}\\037'; exec /bin/sh -i`;
	if (command.length > 8192) throw new Error("REMOTE_TERMINAL_OPTIONS_INVALID");
	return command;
}
