import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionCommandFailure, requireSessionCommand, sessionCommandFailureToast } = loadTsCommonJs("src/renderer/src/utils/sessionCommands.ts", { stubs: { "../i18n": { t: (key) => key } } });

test("remote write conflict uses a reload instruction, not a generic failure or successful no-op", () => {
	const error = new SessionCommandFailure({ code: "SESSION_COMMAND_FAILED", debugDetails: "REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED" });
	assert.equal(error.message, "sessionCommand.remoteFileChanged");
	assert.match(sessionCommandFailureToast(error), /^sessionCommand\.remoteFileChanged/);
	assert.throws(
		() => requireSessionCommand({ ok: false, error: { code: "SESSION_COMMAND_FAILED", debugDetails: "REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED" } }),
		(failure) => failure.message === "sessionCommand.remoteFileChanged",
	);
});

test("existing failure mapping remains unchanged for all other commands", () => {
	assert.equal(new SessionCommandFailure({ code: "SESSION_COMMAND_FAILED", debugDetails: "REMOTE_SESSION_HISTORY_WRITER_COMMAND_FAILED" }).message, "sessionCommand.commandFailed");
	assert.equal(new SessionCommandFailure({ code: "MESSAGE_NOT_FOUND", debugDetails: "REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED" }).message, "sessionCommand.messageNotFound");
});

test("remote write conflict has Chinese and English copy with an actionable reload instruction", () => {
	assert.match(readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"), /"sessionCommand\.remoteFileChanged"\s*:\s*"[^"\n]*重新加载/);
	assert.match(readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"), /"sessionCommand\.remoteFileChanged"\s*:\s*"[^"\n]*Reload/);
});
