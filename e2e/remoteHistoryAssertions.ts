import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionFileEditor, type SessionEntryTarget } from "../src/main/pi/SessionFileEditor";
import { buildSessionProjection, parseSessionEntries } from "../src/main/pi/sessionContextProjection";

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

/** 内容块 → 可见文本（字符串或 text 块数组；图片/工具块忽略）。 */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isRecord)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** 只取可见的真实 message；墓碑、thinking-only 与错误回复不能冒充新回复。 */
export function historyMessages(document: string, role: "user" | "assistant"): HistoryMessage[] {
	return historyEntries(document).flatMap((entry) => {
		if (entry.type !== "message" || typeof entry.id !== "string" || !isRecord(entry.message) || entry.message.role !== role) return [];
		const text = contentText(entry.message.content);
		if (!text.trim()) return [];
		return [{ entryId: entry.id, role, text, parentId: typeof entry.parentId === "string" ? entry.parentId : null, stopReason: typeof entry.message.stopReason === "string" ? entry.message.stopReason : undefined }];
	});
}

/**
 * 按 pi 原生 context_edit 投影后的**有效历史**（模型下次会看到的），而不是文件里的原始行。
 *
 * 合并后的远端写面契约（docs/remote-integration-notes.md §6）：编辑/删除只追加 context_edit，
 * 原文行保留（可追溯/可撤销）。因此「编辑后的正文」「删掉的消息」必须从投影结果断言；
 * 直接读原始 message 行会永远看到编辑前/删除前的旧内容。
 */
export function effectiveHistoryMessages(document: string, role: "user" | "assistant"): HistoryMessage[] {
	const projection = buildSessionProjection(parseSessionEntries(document.split("\n")));
	return projection.projectedEntries.flatMap((projected) => {
		if (projected.excluded || projected.entry.type !== "message" || projected.entryId.length === 0 || !isRecord(projected.entry.message) || projected.entry.message.role !== role) return [];
		const message = projected.messages[0];
		if (!isRecord(message)) return [];
		const text = contentText(message.content);
		if (!text.trim()) return [];
		return [
			{
				entryId: projected.entryId,
				role,
				text,
				parentId: typeof projected.entry.parentId === "string" ? projected.entry.parentId : null,
				stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
			},
		];
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
	const beforeIds = new Set(
		historyEntries(input.before)
			.map((entry) => entry.id)
			.filter((id): id is string => typeof id === "string"),
	);
	const entries = historyEntries(input.after);
	let now = input.startedAt;
	/**
	 * 合并后的契约（pi 原生 context_edit）：编辑/删除都不改写原文，而是向文件末尾追加
	 * `context_edit`（edit: replacement={content}，delete: replacement=null）；只有重发仍用
	 * `deleted` 墓碑截断分支。期望字节由本机真实编辑器重算，但 context_edit 的 UUID 与
	 * 服务端时钟是随机量——必须从远端实际字节里取出再注入，否则逐字节比较永远不可能相等。
	 */
	const appended = entries.filter((entry) => typeof entry.id === "string" && !beforeIds.has(entry.id));
	const mutations = appended.filter((entry) => entry.type === "context_edit");
	const uuids: string[] = [];
	const times: number[] = [];
	if (input.operation === "resend") {
		const tombstone = entries.find((entry) => entry.id === input.target.entryId);
		assert.equal(tombstone?.type, "deleted", "MUTATION_TARGET_NOT_TOMBSTONED");
		assert.ok(typeof tombstone.ts === "number" && tombstone.ts >= input.startedAt && tombstone.ts <= Date.now(), "MUTATION_TIMESTAMP_INVALID");
		now = tombstone.ts;
	} else {
		// 编辑/删除只允许追加 context_edit；混入其它新条目说明远端写了本机编辑器不会写的东西。
		assert.equal(appended.length, mutations.length, "MUTATION_UNEXPECTED_APPENDED_ENTRY");
		assert.ok(mutations.length > 0, "MUTATION_CONTEXT_EDIT_MISSING");
		if (input.operation === "edit") {
			assert.equal(mutations.length, 1, "MUTATION_CONTEXT_EDIT_COUNT_INVALID");
			assert.equal(mutations[0].targetId, input.target.entryId, "MUTATION_TARGET_NOT_EDITED");
			assert.notEqual(mutations[0].replacement, null, "MUTATION_REPLACEMENT_MISSING");
		} else {
			// 删除由目标条目与（assistant 时的）过程链祖先组成，顺序必须与编辑器一致。
			assert.equal(mutations[0].targetId, input.target.entryId, "MUTATION_TARGET_NOT_REMOVED");
			for (const mutation of mutations) assert.equal(mutation.replacement, null, "MUTATION_TARGET_NOT_REMOVED");
		}
		for (const mutation of mutations) {
			const id = typeof mutation.id === "string" ? mutation.id : "";
			const timestamp = typeof mutation.timestamp === "string" ? Date.parse(mutation.timestamp) : Number.NaN;
			assert.ok(id.length > 0, "MUTATION_CONTEXT_EDIT_ID_INVALID");
			assert.ok(Number.isFinite(timestamp) && timestamp >= input.startedAt && timestamp <= Date.now(), "MUTATION_TIMESTAMP_INVALID");
			uuids.push(id);
			times.push(timestamp);
		}
		now = times[0];
	}
	const directory = await mkdtemp(join(tmpdir(), "pideck-real-history-oracle-"));
	try {
		const path = join(directory, "session.jsonl");
		await writeFile(path, input.before);
		const editor = new SessionFileEditor({
			// 每个追加条目按远端实际时钟/ID 注入；备份文件命名等剩余调用用固定值即可（不参与字节比较）。
			now: () => times.shift() ?? now,
			randomUUID: () => uuids.shift() ?? "00000000-0000-4000-8000-000000000000",
		});
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
