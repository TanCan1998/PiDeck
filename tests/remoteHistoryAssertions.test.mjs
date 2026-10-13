import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { historyEntries, historyMessages, freshRemoteTurn, assertRemoteMutationMatchesLocal } = loadTsCommonJs("e2e/remoteHistoryAssertions.ts");
const header = { type: "session", id: "session", version: 3, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" };
const message = (id, parentId, role, text, extra = {}) => ({ type: "message", id, parentId, timestamp: header.timestamp, message: { role, content: [{ type: "text", text }], ...extra } });
const serialize = (entries) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const user = message("u1", null, "user", "prompt");
const assistant = message("a1", "u1", "assistant", "answer");
const laterUser = message("u2", "a1", "user", "next");
const before = serialize([header, user, assistant, laterUser]);
const tombstone = (entry, ts, reason) => ({ type: "deleted", id: entry.id, originalEntryId: entry.id, parentId: entry.parentId, ts, ...(reason ? { reason } : {}) });

// 这些判据自己也必须能红：真实主机成功并不能掩盖坏 JSONL、旧回复或宽松的字节比较。
test("history evidence rejects invalid JSONL, missing header and duplicate identities", () => {
	assert.throws(() => historyEntries("{\n"));
	assert.throws(() => historyEntries(serialize([header, "not an object"])));
	assert.throws(() => historyEntries(serialize([user])), /HISTORY_SESSION_HEADER_INVALID/);
	assert.throws(() => historyEntries(serialize([header, user, user])), /HISTORY_DUPLICATE_ENTRY_ID/);
	assert.equal(historyEntries(before).length, 4);
});

test("old replies, error/aborted replies and replies outside the new user parent chain do not prove resend", () => {
	const newUser = message("new-u", null, "user", "prompt");
	assert.equal(freshRemoteTurn(before, serialize([header, user, assistant, laterUser, newUser]), "prompt"), undefined);
	for (const stopReason of ["error", "aborted"]) {
		const newAnswer = message("new-a", "new-u", "assistant", "not a success", { stopReason });
		assert.equal(freshRemoteTurn(before, serialize([header, newUser, newAnswer]), "prompt"), undefined);
	}
	const unrelatedAnswer = message("new-a", "u1", "assistant", "unrelated");
	assert.equal(freshRemoteTurn(before, serialize([header, user, newUser, unrelatedAnswer]), "prompt"), undefined);
	const thinking = { ...message("thinking", "new-u", "assistant", ""), message: { role: "assistant", content: [{ type: "thinking", thinking: "plan" }] } };
	assert.equal(freshRemoteTurn(before, serialize([header, newUser, thinking]), "prompt"), undefined);
	const newAnswer = message("new-a", "thinking", "assistant", "new answer", { stopReason: "stop" });
	const turn = freshRemoteTurn(before, serialize([header, newUser, thinking, newAnswer]), "prompt");
	assert.equal(turn.user.entryId, "new-u");
	assert.equal(turn.assistant.entryId, "new-a");
});

test("edit oracle compares the entire UTF-8 document, not just the replacement text", async () => {
	const newText = "中文\n'quoted'\\".repeat(600);
	const edited = { ...assistant, message: { ...assistant.message, content: [{ type: "text", text: newText }] } };
	const after = serialize([header, user, edited, laterUser]);
	const target = historyMessages(before, "assistant")[0];
	const input = { before, operation: "edit", target, startedAt: Date.now(), newText };
	await assertRemoteMutationMatchesLocal({ ...input, after });
	const corruptedOtherEntry = serialize([header, { ...user, parentId: "session" }, edited, laterUser]);
	await assert.rejects(assertRemoteMutationMatchesLocal({ ...input, after: corruptedOtherEntry }), /REMOTE_MUTATION_DIFFERS_FROM_LOCAL_EDITOR/);
});

test("delete oracle verifies reparenting and rejects removal of unrelated fields", async () => {
	const ts = Date.now();
	const deleted = tombstone(assistant, ts);
	const after = serialize([header, user, deleted, { ...laterUser, parentId: "u1" }]);
	const input = { before, operation: "delete", target: historyMessages(before, "assistant")[0], startedAt: ts };
	await assertRemoteMutationMatchesLocal({ ...input, after });
	await assert.rejects(assertRemoteMutationMatchesLocal({ ...input, after: serialize([header, user, deleted, laterUser]) }), /REMOTE_MUTATION_DIFFERS_FROM_LOCAL_EDITOR/);
	await assert.rejects(assertRemoteMutationMatchesLocal({ ...input, after: serialize([header, user, { ...deleted, ts: ts - 1 }, { ...laterUser, parentId: "u1" }]) }), /MUTATION_TIMESTAMP_INVALID/);
});

test("resend oracle permits new appended entries but verifies every old byte and the full tombstone set", async () => {
	const ts = Date.now();
	const prefix = [header, ...[user, assistant, laterUser].map((entry) => tombstone(entry, ts, "resend-truncate"))];
	const additions = [message("new-u", null, "user", "prompt"), message("new-a", "new-u", "assistant", "new answer")];
	const input = { before, operation: "resend", target: historyMessages(before, "user")[0], startedAt: ts };
	await assertRemoteMutationMatchesLocal({ ...input, after: serialize([...prefix, ...additions]) });
	await assert.rejects(assertRemoteMutationMatchesLocal({ ...input, after: serialize([header, prefix[1], assistant, prefix[3], ...additions]) }), /REMOTE_MUTATION_DIFFERS_FROM_LOCAL_EDITOR/);
});

test("remote mutation acceptance is a default UI chain with a real local-editor oracle and no IPC shortcut", () => {
	const spec = readFileSync("e2e/remoteSessionAcceptance.spec.ts", "utf8");
	const flow = readFileSync("e2e/remote-history-mutations.ts", "utf8");
	const oracle = readFileSync("e2e/remoteHistoryAssertions.ts", "utf8");
	assert.match(spec, /await\s+verifyRemoteHistoryMutations\(/);
	assert.match(flow, /getByTitle\("编辑"/);
	assert.match(flow, /getByRole\("button",\s*\{\s*name:\s*"保存"/);
	assert.match(flow, /getByTitle\("用同一条用户消息再次发送给 AI"/);
	assert.match(flow, /getByTitle\("删除"/);
	assert.match(flow, /assertRemoteMutationMatchesLocal\(/);
	assert.match(flow, /freshRemoteTurn\(/);
	assert.match(oracle, /new\s+SessionFileEditor\(/);
	assert.match(oracle, /assert\.equal\(actual,\s*expected/);
	assert.ok(!/piDesktop|ipcRenderer|createRemoteSessionHistoryWriter/.test(flow), "all product writes must be UI-driven, not direct calls to the writer");
	assert.ok(!/PIDECK_E2E_P45|MUTATION_PROBE|ALLOW_FAILURE/.test(spec + flow), "the acceptance must not have a bypass switch");
});
