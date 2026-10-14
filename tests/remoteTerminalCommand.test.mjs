import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("terminal command pins actual cwd, quotes paths as data and only adjusts its own environment", (t) => {
	const { buildRemoteTerminalCommand } = loadTsCommonJs("src/main/remote/RemoteTerminalCommand.ts");
	const root = mkdtempSync(join(tmpdir(), "remote-terminal-command-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const directory = join(root, "space ' $ ; directory");
	mkdirSync(directory);
	const nonce = "1".repeat(32);
	const command = buildRemoteTerminalCommand({ root: directory, nodePath: process.execPath, nonce });
	const result = spawnSync("/bin/sh", ["-c", command], { input: "printf 'CWD=%s\n' \"$PWD\"; node -p 'process.version'; exit\n", encoding: "utf8", timeout: 5000 });
	assert.equal(result.status, 0, result.stderr);
	assert.ok(result.stdout.includes("\x1ePIDECK_TERM_" + nonce + "\x1f"));
	assert.ok(result.stdout.includes("CWD=" + directory));
	assert.ok(result.stdout.includes(process.version));
	assert.ok(command.length <= 8192);
	const alias = join(root, "alias");
	symlinkSync(directory, alias);
	const drift = spawnSync("/bin/sh", ["-c", buildRemoteTerminalCommand({ root: alias, nodePath: process.execPath, nonce })], { encoding: "utf8", timeout: 5000 });
	assert.notEqual(drift.status, 0);
	assert.ok(!drift.stdout.includes("PIDECK_TERM_"));
});

test("terminal command rejects noncanonical roots, control bytes, invalid nonces and Node paths", () => {
	const { buildRemoteTerminalCommand } = loadTsCommonJs("src/main/remote/RemoteTerminalCommand.ts");
	const valid = { root: "/workspace/one", nodePath: "/node/bin/node", nonce: "a".repeat(32) };
	for (const root of ["/", "relative", "/a/../b", "/a/", "/a\n"]) assert.throws(() => buildRemoteTerminalCommand({ ...valid, root }));
	for (const nonce of ["", "a".repeat(33), "not-a-command"]) assert.throws(() => buildRemoteTerminalCommand({ ...valid, nonce }));
	assert.throws(() => buildRemoteTerminalCommand({ ...valid, nodePath: "node" }));
});
