import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildRemoteTerminalRunnerCommand } = loadTsCommonJs("src/main/remote/RemoteTerminalCommand.ts");
const BUNDLE = "a".repeat(64);
const RUNNER = "/home/dev/.pideck/remote-host/bundles/" + BUNDLE + "/terminal-runner.mjs";
const NODE = "/usr/local/bin/node";

test("the remote terminal command is only the trusted node plus the active bundle terminal runner", () => {
	assert.equal(buildRemoteTerminalRunnerCommand({ runnerPath: RUNNER, nodePath: NODE }), "'" + NODE + "' '" + RUNNER + "'");
	const command = buildRemoteTerminalRunnerCommand({ runnerPath: "/home/my user/.pideck/remote-host/bundles/" + BUNDLE + "/terminal-runner.mjs", nodePath: "/opt/my node/bin/node" });
	assert.ok(command.includes("/opt/my node/bin/node"));
	assert.ok(command.includes("my user"));
	// No cwd, shell, ticket, user text or option-looking token can travel in this command.
	for (const value of ["/workspace/project", "bash", "ticketRef", "--root"]) assert.equal(command.includes(value), false);
});

test("only a terminal runner inside an active content-addressed bundle is accepted", () => {
	for (const runnerPath of ["terminal-runner.mjs", "relative/terminal-runner.mjs", "/home/dev/terminal-runner.mjs", "/home/dev/.pideck/remote-host/bundles/" + BUNDLE + "/runner.mjs", "/home/dev/.pideck/remote-host/bundles/zzz/terminal-runner.mjs"]) {
		assert.throws(() => buildRemoteTerminalRunnerCommand({ runnerPath, nodePath: NODE }), /REMOTE_TERMINAL_OPTIONS_INVALID/, String(runnerPath));
	}
	for (const nodePath of ["node", ""]) assert.throws(() => buildRemoteTerminalRunnerCommand({ runnerPath: RUNNER, nodePath }), /REMOTE_TERMINAL_OPTIONS_INVALID/);
	assert.ok(buildRemoteTerminalRunnerCommand({ runnerPath: RUNNER, nodePath: "/opt/my node/bin/node" }).includes("/opt/my node/bin/node"));
});
