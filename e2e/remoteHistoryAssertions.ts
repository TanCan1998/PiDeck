import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionFileEditor, type SessionEntryTarget } from "../src/main/pi/SessionFileEditor";

export type HistoryMessage = SessionEntryTarget & { entryId: string; parentId?: string | null; stopReason?: string };
type Entry = Record<string, unknown>;

function isRecord(value: unknown): value is Entry {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 真机证据必须是完整 JSONL，重复身份/坏行不能被 filter 静默丢掉。 */
export function historyEntries(document: string): Entry[] {
	const entries = document
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const value: unknown = JSON.parse(line);
			assert.ok(isRecord(value), "HISTORY_ENTRY_NOT_OBJECT");
			return value;
		});
	assert.equal(entries.filter((entry) => entry.type === "session").length, 1, "HISTORY_SESSION_HEADER_INVALID");
	const ids = entries.map((entry) => entry.id).filter((id): id is string => typeof id === "string");
	assert.equal(new Set(ids).size, ids.length, "HISTORY_DUPLICATE_ENTRY_ID");
	return entries;
}

/** 只取可见的真实 message；墓碑、thinking-only 与错误回复不能冒充新回复。 */
export function historyMessages(document: string, role: "user" | "assistant"): HistoryMessage[] {
	return historyEntries(document).flatMap((entry) => {
		if (entry.type !== "message" || typeof entry.id !== "string" || !isRecord(entry.message) || entry.message.role !== role) return [];
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter(isRecord)
							.filter((block) => block.type === "text" && typeof block.text === "string")
							.map((block) => block.text)
							.join("\n")
					: "";
		if (!text.trim()) return [];
		return [{ entryId: entry.id, role, text, parentId: typeof entry.parentId === "string" ? entry.parentId : null, stopReason: typeof entry.message.stopReason === "string" ? entry.message.stopReason : undefined }];
	});
}

/** 新 user 与新 assistant 必须是新 entryId，且 assistant 的父链确实经过本次新 user。 */
export function freshRemoteTurn(before: string, after: string, prompt: string): { user: HistoryMessage; assistant: HistoryMessage } | undefined {
	const oldIds = new Set(historyEntries(before).map((entry) => entry.id));
	const entries = new Map(
		historyEntries(after)
			.filter((entry) => typeof entry.id === "string")
			.map((entry) => [entry.id, entry]),
	);
	const user = historyMessages(after, "user").find((message) => !oldIds.has(message.entryId) && message.text === prompt);
	if (!user) return undefined;
	const assistant = historyMessages(after, "assistant").find((message) => {
		if (oldIds.has(message.entryId) || message.stopReason === "error" || message.stopReason === "aborted") return false;
		const visited = new Set<string>();
		let parentId = message.parentId;
		while (parentId && !visited.has(parentId)) {
			if (parentId === user.entryId) return true;
			visited.add(parentId);
			const parent = entries.get(parentId);
			parentId = typeof parent?.parentId === "string" ? parent.parentId : null;
		}
		return false;
	});
	return assistant ? { user, assistant } : undefined;
}

/**
 * 用本机真实编辑器生成整份期望字节，不自己复制墓碑/重挂规则。
 * 墓碑时钟只绑定本次 target 的 ts（并校验操作时间区间）；其余字段与原始行字节全部严格比较。
 * 重发允许 pi 在改写后的原文档末尾追加新回合，但不能改写/遗漏原文档的任何一行。
 */
export async function assertRemoteMutationMatchesLocal(input: { before: string; after: string; operation: "edit" | "delete" | "resend"; target: HistoryMessage; startedAt: number; newText?: string }): Promise<void> {
	const entries = historyEntries(input.after);
	let now = input.startedAt;
	if (input.operation !== "edit") {
		const tombstone = entries.find((entry) => entry.id === input.target.entryId);
		assert.equal(tombstone?.type, "deleted", "MUTATION_TARGET_NOT_TOMBSTONED");
		assert.ok(typeof tombstone.ts === "number" && tombstone.ts >= input.startedAt && tombstone.ts <= Date.now(), "MUTATION_TIMESTAMP_INVALID");
		now = tombstone.ts;
	}
	const directory = await mkdtemp(join(tmpdir(), "pideck-real-history-oracle-"));
	try {
		const path = join(directory, "session.jsonl");
		await writeFile(path, input.before);
		const editor = new SessionFileEditor({ now: () => now });
		const options = { file: { protocolPath: path, hostPath: path, environment: "native" }, target: input.target, reload: async () => undefined } satisfies Parameters<SessionFileEditor["deleteMessage"]>[0];
		if (input.operation === "edit") {
			assert.ok(typeof input.newText === "string", "EDIT_TEXT_MISSING");
			await editor.editMessage({ ...options, newText: input.newText });
		} else if (input.operation === "delete") await editor.deleteMessage(options);
		else await editor.truncateForResend(options);
		const expected = await readFile(path, "utf8");
		const actual = input.operation === "resend" ? input.after.slice(0, expected.length) : input.after;
		assert.equal(actual, expected, "REMOTE_MUTATION_DIFFERS_FROM_LOCAL_EDITOR");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
