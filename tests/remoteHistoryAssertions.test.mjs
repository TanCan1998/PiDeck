import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { historyEntries, historyMessages, freshRemoteTurn, assertRemoteMutationMatchesLocal } = loadTsCommonJs("e2e/remoteHistoryAssertions.ts");
const { SessionFileEditor } = loadTsCommonJs("src/main/pi/SessionFileEditor.ts");
const header = { type: "session", id: "session", version: 3, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" };
const message = (id, parentId, role, text, extra = {}) => ({ type: "message", id, parentId, timestamp: header.timestamp, message: { role, content: [{ type: "text", text }], ...extra } });
const serialize = (entries) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const user = message("u1", null, "user", "prompt");
const assistant = message("a1", "u1", "assistant", "answer");
const laterUser = message("u2", "a1", "user", "next");
const before = serialize([header, user, assistant, laterUser]);
const tombstone = (entry, ts, reason) => ({ type: "deleted", id: entry.id, originalEntryId: entry.id, parentId: entry.parentId, ts, ...(reason ? { reason } : {}) });

/**
 * 合并后的本机编辑契约（pi 原生 context_edit）：编辑/删除不改写原文，只向文件末尾追加
 * context_edit（edit: replacement={content}，delete: replacement=null）。远端侧字节用同一份
 * 真实编辑器生成，再由 oracle 注入相同的 UUID/时钟重算期望值；手写字节不再代表契约。
 */
async function localMutation(before, operation, target, startedAt, newText) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-fixture-"));
	try {
		const path = join(directory, "session.jsonl");
		await writeFile(path, before, "utf8");
		const editor = new SessionFileEditor({ now: () => startedAt });
		const options = { file: { protocolPath: path, hostPath: path, environment: "native" }, target, reload: async () => undefined };
		if (operation === "edit") await editor.editMessage({ ...options, newText });
		else await editor.deleteMessage(options);
		return await readFile(path, "utf8");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

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
	const target = historyMessages(before, "assistant")[0];
	const startedAt = Date.now();
	const after = await localMutation(before, "edit", target, startedAt, newText);
	const input = { before, after, operation: "edit", target, startedAt, newText };
	await assertRemoteMutationMatchesLocal(input);
	// 篡改一条与被编辑条目无关的记录：整份字节比较必须变红（只比对替换文本会假绿）。
	const corrupted = JSON.parse(JSON.stringify(historyEntries(after)));
	corrupted.find((entry) => entry.id === "u1").parentId = "session";
	await assert.rejects(assertRemoteMutationMatchesLocal({ ...input, after: serialize(corrupted) }), /REMOTE_MUTATION_DIFFERS_FROM_LOCAL_EDITOR/);
});

test("delete oracle verifies the appended context_edit and rejects unrelated changes", async () => {
	const target = historyMessages(before, "assistant")[0];
	const startedAt = Date.now();
	const after = await localMutation(before, "delete", target, startedAt);
	const input = { before, after, operation: "delete", target, startedAt };
	await assertRemoteMutationMatchesLocal(input);
	// 删除只追加 context_edit，不改写后继消息父链；篡改无关字段必须变红。
	const corrupted = JSON.parse(JSON.stringify(historyEntries(after)));
	corrupted.find((entry) => entry.id === "u2").parentId = "u1";
	await assert.rejects(assertRemoteMutationMatchesLocal({ ...input, after: serialize(corrupted) }), /REMOTE_MUTATION_DIFFERS_FROM_LOCAL_EDITOR/);
	// context_edit 时间戳早于操作开始：必须报 MUTATION_TIMESTAMP_INVALID。
	const stale = JSON.parse(JSON.stringify(historyEntries(after)));
	stale.find((entry) => entry.type === "context_edit").timestamp = new Date(startedAt - 1).toISOString();
	await assert.rejects(assertRemoteMutationMatchesLocal({ ...input, after: serialize(stale) }), /MUTATION_TIMESTAMP_INVALID/);
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
