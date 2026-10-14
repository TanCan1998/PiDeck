import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { assertRemoteNodeTestExecuted } = loadTsCommonJs("e2e/remote-file-editing.ts", {
	stubs: {
		"@playwright/test": { expect: (actual, message) => ({ toBe: (expected) => assert.equal(actual, expected, message) }) },
		"./remote-fixtures": {},
	},
});
function document({ command = "node test.cjs", toolId = "t1", isError = false, output = "REMOTE_FILE_TEST_OK\n", onlyAssistant = false } = {}) {
	const entries = [
		{ type: "session", id: "s" },
		{ type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text: "test" }] } },
	];
	if (!onlyAssistant)
		entries.push(
			{ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command } }] } },
			{ type: "message", id: "r", parentId: "a", message: { role: "toolResult", toolCallId: toolId, isError, content: [{ type: "text", text: output }] } },
		);
	entries.push({ type: "message", id: "reply", parentId: onlyAssistant ? "u" : "r", message: { role: "assistant", content: [{ type: "text", text: "REMOTE_FILE_TEST_OK" }] } });
	return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}
test("agent task oracle requires real node call and correlated successful tool result", () => {
	assert.doesNotThrow(() => assertRemoteNodeTestExecuted(document()));
	assert.doesNotThrow(() => assertRemoteNodeTestExecuted(document({ command: "cd /project && /opt/node/bin/node test.cjs" })));
});
for (const [name, options] of [
	["assistant claim", { onlyAssistant: true }],
	["cat source", { command: "cat test.cjs" }],
	["other tool result", { toolId: "different" }],
	["failed test", { isError: true }],
	["marker in source text", { output: "console.log('REMOTE_FILE_TEST_OK');" }],
])
	test(`agent task oracle rejects ${name}`, () => {
		assert.throws(() => assertRemoteNodeTestExecuted(document(options)));
	});
