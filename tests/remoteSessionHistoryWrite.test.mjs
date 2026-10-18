import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端会话 JSONL 的**受控改写**（P4.5c：编辑消息 / 删除消息 / 准备重发）。
 *
 * 不连真机：远端短命令是**假 SSH exec**——它按真实 shell 语义执行（`wc -c`、`tail -c +N | head -c M`、
 * GNU `base64`（含 76 列折行）、`base64 -d` 的 `>`/`>>` 重定向、`mv`），跑在一份内存文件表上。
 * 于是「分块读的边界」「临时文件按序分块写完才 mv」「失败时目标文件一个字节都没动」这些最容易写错的
 * 东西被真正测到，而不是靠 mock 返回现成结果把 bug 掩盖过去。
 *
 * 内容语义的判据不是「像本机」，而是**用真实本机 `SessionFileEditor` 在同一份夹具上跑一遍再逐字节比对**
 *（时间戳也用同一份注入时钟，墓碑 ts 因此可比）。
 *
 * 覆盖：三条操作的内容语义（含 delete 的过程链墓碑与子节点重挂、resend 的后继全墓碑 + 原文快照）；
 * 读/写的分块边界与命令形状（只出现单引号字面量与 base64）；运行中由协调器拒绝（见 sessionRuntimeCoordinator
 * 测试）；路径非法零命令；远端失败 ⇒ 稳定码 + 目标文件不变 + 不重试；超上界/坏文档 fail-closed。
 */

const HOST = "11111111-1111-4111-8111-111111111111";
const HOME = "/home/dev";
const SESSION_ROOT = HOME + "/.pi/agent/sessions";
const REMOTE_ID = "ws/target.jsonl";
const TARGET_PATH = SESSION_ROOT + "/" + REMOTE_ID;
const FIXED_TS = 1_700_000_100_000;
const BANNER = "Now using node v20.19.0 (npm v10.8.2)\n";

/** 稳定码不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** 远端 shell 可能混进登录横幅（~/.bashrc）——标记就是为它准备的。 */
const WRAP_COLUMNS = 76;

const {
	createRemoteSessionHistoryWriter,
	buildRemoteSessionHistoryChunkReadCommand,
	buildRemoteSessionHistoryChunkWriteCommand,
	buildRemoteSessionHistoryReplaceCommand,
	remoteSessionHistoryTempPath,
	parseRemoteSessionHistoryChunk,
	remoteSessionHistoryWriteFailure,
	REMOTE_SESSION_HISTORY_WRITER_CODES,
	REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID,
	REMOTE_SESSION_HISTORY_READ_CHUNK_BYTES,
	REMOTE_SESSION_HISTORY_WRITE_CHUNK_BYTES,
} = loadTsCommonJs("src/main/remote/RemoteSessionHistoryWriter.ts");
const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
const { stoppedMessageFingerprint } = loadTsCommonJs("src/main/pi/stoppedMessageIdentity.ts");
const projector = new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
const { SessionFileEditor, SessionFileEditorError } = loadTsCommonJs("src/main/pi/SessionFileEditor.ts");
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { SessionRuntimeCoordinator } = loadTsCommonJs("src/main/sessions/SessionRuntimeCoordinator.ts");
const { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_SESSION_HISTORY_TRANSPORT_BYTES } = loadTsCommonJs("src/main/remote/RemoteSessionHistoryReader.ts");

/** 命令形状：唯一解析点。生产实现的模板字面量一变，这里先红。 */
const READ_WITH_SIZE_SHAPE = /^printf '([A-Za-z0-9_]+)'; wc -c < '([^'\\]+)'; tail -c \+(\d+) -- '[^'\\]+' \| head -c (\d+) \| base64$/;
const READ_CHUNK_SHAPE = /^printf '([A-Za-z0-9_]+)'; tail -c \+(\d+) -- '([^'\\]+)' \| head -c (\d+) \| base64$/;
const WRITE_CHUNK_SHAPE = /^(?:umask 077; set -C; )?printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d (>>|>) '([^'\\]+)'$/;
const GUARD_SHAPE = /^'([^']+)' '-e' '[^']*' '(snapshot|commit)' '([^']+)' '([^']+)' '([^']*)' '([^']*)' '(\d+)'$/;
const isCommit = (command) => GUARD_SHAPE.exec(command)?.[2] === "commit";
const REPLACE_SHAPE = /^mv -- '([^'\\]+)' '([^'\\]+)'$/;

function wrapColumns(text) {
	if (text.length <= WRAP_COLUMNS) return `${text}\n`;
	const lines = [];
	for (let index = 0; index < text.length; index += WRAP_COLUMNS) lines.push(text.slice(index, index + WRAP_COLUMNS));
	return `${lines.join("\n")}\n`;
}

function ancestorsOf(path) {
	const segments = path.split("/");
	const dirs = new Set();
	for (let index = 1; index < segments.length; index += 1) dirs.add(segments.slice(0, index).join("/"));
	return dirs;
}

/**
 * 假远端 shell：内存文件表 + 上述读/上传/守卫命令的语义。
 * `failAt(command, index)` 让测试指定「第几条命令在远端失败」，用于验证失败即停与目标文件不变。
 */
function fakeShell(initialFiles, options = {}) {
	const files = new Map(Object.entries(initialFiles).map(([path, content]) => [path, Buffer.from(content, "utf8")]));
	const dirs = new Set();
	for (const path of files.keys()) for (const dir of ancestorsOf(path)) dirs.add(dir);
	const commands = [];
	const transport = {
		async runRemoteCommand({ remoteCommand }) {
			if (remoteCommand.length > 8192) throw new Error("TEST_REMOTE_COMMAND_LIMIT_EXCEEDED");
			const index = commands.length;
			commands.push(remoteCommand);
			if (options.failAt?.(remoteCommand, index)) return { exitCode: 1, stdout: "" };
			let match = GUARD_SHAPE.exec(remoteCommand);
			if (match) {
				const [, , operation, marker, path, temporary, expectedJson, limit] = match;
				const content = files.get(path);
				const result = (value) => ({ exitCode: 0, stdout: `${options.banner ? BANNER : ""}${marker}${JSON.stringify(value)}` });
				if (!content) return result({ ok: false, code: "commandFailed" });
				const revision = { mode: 0o600, size: content.length, dev: "1", ino: "1", uid: "1", gid: "1", mtimeNs: "1", ctimeNs: "1", digest: createHash("sha256").update(content).digest("hex") };
				if (content.length > Number(limit)) return result({ ok: false, code: "fileTooLarge", details: { size: content.length, limit: Number(limit) } });
				if (operation === "snapshot") return result({ ok: true, revision });
				const expected = JSON.parse(expectedJson);
				const upload = files.get(temporary);
				if (!upload || upload.length !== expected.nextSize || createHash("sha256").update(upload).digest("hex") !== expected.nextDigest) return result({ ok: false, code: "transferInvalid" });
				if (JSON.stringify(revision) !== JSON.stringify(expected.source)) return result({ ok: false, code: "fileChanged" });
				files.set(path, upload);
				files.delete(temporary);
				return result({ ok: true });
			}
			match = READ_WITH_SIZE_SHAPE.exec(remoteCommand);
			if (match) {
				const [, marker, sizePath, start, count] = match;
				const content = files.get(sizePath);
				if (content === undefined) return { exitCode: 1, stdout: "" };
				const slice = content.subarray(Number(start) - 1, Number(start) - 1 + Number(count));
				// BSD 的 `wc -c` 会右对齐补空格：解析必须容忍（生产解析先 trim）。
				return { exitCode: 0, stdout: `${options.banner ? BANNER : ""}${marker}${String(content.length).padStart(8, " ")}\n${wrapColumns(slice.toString("base64"))}` };
			}
			match = READ_CHUNK_SHAPE.exec(remoteCommand);
			if (match) {
				const [, marker, start, path, count] = match;
				const content = files.get(path);
				if (content === undefined) return { exitCode: 1, stdout: "" };
				const slice = content.subarray(Number(start) - 1, Number(start) - 1 + Number(count));
				return { exitCode: 0, stdout: `${marker}${wrapColumns(slice.toString("base64"))}` };
			}
			match = WRITE_CHUNK_SHAPE.exec(remoteCommand);
			if (match) {
				const [, payload, operator, path] = match;
				const written = Buffer.from(payload, "base64");
				if (operator === ">>") {
					const current = files.get(path);
					if (current === undefined) return { exitCode: 1, stdout: "" };
					files.set(path, Buffer.concat([current, written]));
					return { exitCode: 0, stdout: "" };
				}
				if (files.has(path)) return { exitCode: 1, stdout: "" };
				files.set(path, written);
				return { exitCode: 0, stdout: "" };
			}
			match = REPLACE_SHAPE.exec(remoteCommand);
			if (match) {
				const [, from, to] = match;
				const content = files.get(from);
				if (content === undefined) return { exitCode: 1, stdout: "" };
				if (!dirs.has(to.slice(0, to.lastIndexOf("/")))) return { exitCode: 1, stdout: "" };
				files.set(to, content);
				files.delete(from);
				return { exitCode: 0, stdout: "" };
			}
			throw new Error(`UNEXPECTED_REMOTE_COMMAND: ${remoteCommand}`);
		},
	};
	const writeCommands = () => commands.filter((command) => WRITE_CHUNK_SHAPE.test(command));
	const replaceCommands = () => commands.filter(isCommit);
	return {
		files,
		commands,
		transport,
		resolveSessionRoot: async () => ({ ok: true, root: SESSION_ROOT }),
		text: (path = TARGET_PATH) => files.get(path)?.toString("utf8"),
		bytes: (path = TARGET_PATH) => files.get(path),
		writeCommands,
		replaceCommands,
	};
}

/**
 * 确定性 uuid：dev 的编辑/删除改为追加 pi 原生 `context_edit`（带新 id）。远端写面与本机
 * `SessionFileEditor` 各跑一遍还要逐字节相等，所以两边必须注入同一条 id 序列。
 */
function stableUuid() {
	let sequence = 0;
	return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
}

/**
 * 归一化**新生成记录**的 id：`context_edit`（以及重发时被墓碑掉的它们）用的 id 在生产里是随机 UUID，
 * 两侧独立运行不可能相同；而 id / parentId 链必须参与比对，所以按出现顺序换成稳定占位符。
 * 判据是 UUID 形状：夹具里的原始条目 id 都是 `u1`/`a1`/`sys1` 这类短 id，不会误伤。
 * 归一化之后仍然逐字节比对——随机 id 是唯一被放行的差异。
 */
function normalizeGeneratedIds(buffer) {
	const lines = buffer
		.toString("utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const names = new Map();
	const nameOf = (id) => {
		if (!names.has(id)) names.set(id, `generated-${names.size + 1}`);
		return names.get(id);
	};
	const isGenerated = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
	for (const entry of lines) {
		if (isGenerated(entry.id)) entry.id = nameOf(entry.id);
		if (isGenerated(entry.originalEntryId)) entry.originalEntryId = nameOf(entry.originalEntryId);
		if (isGenerated(entry.parentId)) entry.parentId = nameOf(entry.parentId);
	}
	return lines.map((entry) => JSON.stringify(entry)).join("\n");
}

function createWriter(shell, options = {}) {
	return createRemoteSessionHistoryWriter({ transport: shell.transport, resolveNodePath: async () => "/usr/bin/node", resolveSessionRoot: shell.resolveSessionRoot, now: () => FIXED_TS, createUuid: stableUuid(), ...options });
}

function locatorWith(remotePath) {
	return { kind: "ssh", hostId: HOST, remoteSessionId: REMOTE_ID, remotePath };
}

const ABSOLUTE_LOCATOR = locatorWith(TARGET_PATH);

/** 一条真实形状的 pi 会话：含过程链（thinking-only assistant → toolResult）与一条 system 条目。 */
function fixtureDocument() {
	const line = (entry) => JSON.stringify(entry);
	const stamp = "2026-01-01T00:00:00.000Z";
	return `${[
		line({ type: "session", id: "sess-1", timestamp: stamp }),
		line({ type: "message", id: "u1", parentId: null, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: "hello world" }] } }),
		line({ type: "message", id: "a1", parentId: "u1", timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } }),
		line({ type: "message", id: "a2", parentId: "a1", timestamp: stamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "plan the work" }] } }),
		line({ type: "message", id: "tr1", parentId: "a2", timestamp: stamp, message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } }),
		line({ type: "message", id: "a3", parentId: "tr1", timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } }),
		line({
			type: "message",
			id: "u2",
			parentId: "a3",
			timestamp: stamp,
			message: {
				role: "user",
				content: [
					{ type: "text", text: "again" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
				],
			},
		}),
		line({ type: "message", id: "sys1", parentId: "u2", timestamp: stamp, message: { role: "system", content: [{ type: "text", text: "system prompt" }] } }),
	].join("\n")}\n`;
}

/** 大夹具：强制分块读/写（分块大小由测试调小）。 */
function largeDocument(messageCount = 40) {
	const stamp = "2026-01-01T00:00:00.000Z";
	const lines = [JSON.stringify({ type: "session", id: "sess-big", timestamp: stamp })];
	let parentId = null;
	for (let index = 0; index < messageCount; index += 1) {
		const id = `m${index}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: stamp,
				message: { role: "user", content: [{ type: "text", text: `message-${index}-${"x".repeat(64)}` }] },
			}),
		);
		parentId = id;
	}
	return `${lines.join("\n")}\n`;
}

/** 本机链路同一份夹具的改写结果：真实 `SessionFileEditor` + 真实临时文件。 */
async function localMutation(t, document, kind, target, newText) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-write-local-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "session.jsonl");
	await writeFile(path, document);
	const editor = new SessionFileEditor({ now: () => FIXED_TS, randomUUID: stableUuid() });
	const file = { protocolPath: path, hostPath: path, environment: "native" };
	const reload = async () => undefined;
	if (kind === "edit") await editor.editMessage({ file, target, newText, reload });
	else if (kind === "delete") await editor.deleteMessage({ file, target, reload });
	else await editor.truncateForResend({ file, target, reload });
	return await readFile(path);
}

const USER_TARGET = { entryId: "u1", role: "user", text: "hello world" };
const ASSISTANT_TARGET = { entryId: "a3", role: "assistant", text: "second answer" };
const EARLIER_ASSISTANT_TARGET = { entryId: "a1", role: "assistant", text: "first answer" };

/** 一次远端改写的通用入口（默认走 absolute locator + 标记 id 形状与渲染层一致）。 */
async function remoteMutation(shell, operation, input = {}, options = {}) {
	const writer = createWriter(shell, options);
	return await writer.mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation, messageId: `_viewer-history-${input.entryId ?? "u1"}`, ...input });
}

test("live IDs without entryId still mutate the persisted remote turn after stop", async (t) => {
	for (const operation of ["edit", "delete", "resend"]) {
		const document = fixtureDocument();
		const shell = fakeShell({ [TARGET_PATH]: document });
		const raw = JSON.parse(document.split("\n")[1]).message;
		const projected = projector.convert("viewer", [raw], ["u1"])[0];
		const timestamp = Date.parse("2026-01-01T00:00:00.000Z");
		const stoppedIdentity = { role: "user", timestamp, fingerprint: stoppedMessageFingerprint(projected) };
		const writer = createWriter(shell, { project: (messages, ids) => projector.convert("viewer", messages, ids) });
		const result = await writer.mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation, messageId: "live-random-id", stoppedIdentity, newText: "edited live message" });
		const expected = await localMutation(t, document, operation, USER_TARGET, "edited live message");
		assert.deepEqual(shell.bytes(), expected, `${operation}: the message exists on disk, so delete must not report a no-op`);
		if (operation === "resend") assert.equal(result.text, "hello world");
	}
});

test("stopped-identity fallback rejects ambiguous, stale and mismatched messages without remote writes", async () => {
	const document = fixtureDocument();
	const raw = JSON.parse(document.split("\n")[1]).message;
	const projected = projector.convert("viewer", [raw], ["u1"])[0];
	const identity = { role: "user", timestamp: Date.parse("2026-01-01T00:00:00.000Z"), fingerprint: stoppedMessageFingerprint(projected) };
	const duplicate = JSON.stringify({ type: "message", id: "duplicate", parentId: "sys1", timestamp: "2026-01-01T00:00:00.000Z", message: raw });
	for (const [content, stoppedIdentity] of [
		[document + duplicate + "\n", identity],
		[document, { ...identity, timestamp: identity.timestamp + 5001 }],
		[document, { ...identity, fingerprint: "wrong" }],
		[document, { ...identity, role: "assistant" }],
	]) {
		const shell = fakeShell({ [TARGET_PATH]: content });
		const writer = createWriter(shell, { project: (messages, ids) => projector.convert("viewer", messages, ids) });
		assert.equal(await rejectionCode(() => writer.mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation: "delete", messageId: "live-random-id", stoppedIdentity })), REMOTE_SESSION_HISTORY_WRITER_CODES.messageNotFound);
		assert.equal(shell.writeCommands().length, 0);
		assert.equal(shell.replaceCommands().length, 0);
		assert.equal(shell.text(), content);
	}
});

test("edit writes the same bytes as the local SessionFileEditor (byte-for-byte parity)", async (t) => {
	const document = fixtureDocument();
	const shell = fakeShell({ [TARGET_PATH]: document });

	const result = await remoteMutation(shell, "edit", { entryId: "u1", newText: "edited text" });

	assert.equal(result, undefined);
	const expected = await localMutation(t, document, "edit", USER_TARGET, "edited text");
	assert.deepEqual(shell.bytes(), expected);
	assert.notEqual(shell.text(), document, "夹具必须真的被改写（否则这个断言毫无意义）");
	// 改写后仍是**完整可解析**的 JSONL（原子替换保证的是整份，不是半截）。
	const rewritten = shell
		.text()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(rewritten.filter((entry) => entry.type === "session").length, 1);
	// 原 8 行一条不改 + 追加一条 context_edit（dev 语义：原文不改写）。
	assert.equal(rewritten.length, 9);
	assert.equal(rewritten.filter((entry) => entry.type === "context_edit").length, 1);
	// 编辑不再原地改目标行：原文仍在文件里，替换只存在于 context_edit 的 replacement。
	const originalLine = shell
		.text()
		.split("\n")
		.find((line) => line.includes('"id":"u1"'));
	assert.match(originalLine, /"text":"hello world"/);
	const edit = rewritten.find((entry) => entry.type === "context_edit");
	assert.equal(edit.targetId, "u1");
	assert.match(JSON.stringify(edit.replacement), /edited text/);
	assert.equal(shell.text().includes("first answer"), true);
});

test("delete removes the answer and its process chain from context via context_edit (same bytes as local)", async (t) => {
	const document = fixtureDocument();
	const shell = fakeShell({ [TARGET_PATH]: document });

	await remoteMutation(shell, "delete", { entryId: "a3" });

	const expected = await localMutation(t, document, "delete", ASSISTANT_TARGET);
	assert.deepEqual(shell.bytes(), expected);
	const entries = shell
		.text()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	// dev 语义（2026-11）：删除 = 追加 `replacement: null` 的 pi 原生 context_edit，原文行不改写。
	// 过程链（thinking-only assistant + toolResult）与目标回答一起移出上下文；上一段回答保留。
	const contextEdits = entries.filter((entry) => entry.type === "context_edit");
	assert.deepEqual(
		contextEdits.map((entry) => entry.targetId),
		["a3", "tr1", "a2"],
	);
	for (const entry of contextEdits) assert.equal(entry.replacement, null);
	assert.equal(entries.filter((entry) => entry.type === "deleted").length, 0, "delete 不再写墓碑");
	// 目标行没被改写 ⇒ 子节点保持原父节点（重挂只属于旧墓碑语义）。
	assert.equal(entries.find((entry) => entry.id === "u2").parentId, "a3");
	assert.equal(entries.find((entry) => entry.id === "a1").type, "message");
	assert.equal(entries.find((entry) => entry.id === "a2").reason, undefined);
});

test("deleting an assistant without a process chain appends exactly one context_edit (same bytes as local)", async (t) => {
	const document = fixtureDocument();
	const shell = fakeShell({ [TARGET_PATH]: document });

	await remoteMutation(shell, "delete", { entryId: "a1" });

	const expected = await localMutation(t, document, "delete", EARLIER_ASSISTANT_TARGET);
	assert.deepEqual(shell.bytes(), expected);
	const entries = shell
		.text()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		entries.filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId),
		["a1"],
	);
	// a2 是上一段回答（带文本），不是过程链：保持原父节点，不重挂。
	assert.equal(entries.find((entry) => entry.id === "a2").parentId, "a1");
});

test("prepare-resend tombstones the message and every descendant and returns the original snapshot", async (t) => {
	const document = fixtureDocument();
	const shell = fakeShell({ [TARGET_PATH]: document });

	const result = await remoteMutation(shell, "resend", { entryId: "u2" });

	// 跨 realm 的对象/数组不能 deepStrictEqual（原型不同），只比字段。
	assert.equal(result.text, "again");
	assert.equal(result.images.length, 1);
	assert.equal(result.images[0].type, "image");
	assert.equal(result.images[0].mimeType, "image/png");
	assert.equal(result.images[0].data, "AAAA");
	const expected = await localMutation(t, document, "resend", { entryId: "u2", role: "user", text: "again" });
	assert.deepEqual(shell.bytes(), expected);
	const entries = shell
		.text()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		entries.filter((entry) => entry.type === "deleted").map((entry) => entry.id),
		["u2", "sys1"],
	);
	// 理由与本机一致（截断标记），且墓碑保留 id/parentId（否则 pi 的活动分支会断）。
	for (const entry of entries.filter((item) => item.type === "deleted")) {
		assert.equal(entry.reason, "resend-truncate");
		assert.equal(typeof entry.id, "string");
	}
	// 未波及的历史保持原样。
	assert.equal(entries.find((entry) => entry.id === "a3").type, "message");
});

test("the whole rewrite is private temp chunks followed by exactly one guarded atomic replacement", async () => {
	const shell = fakeShell({ [TARGET_PATH]: fixtureDocument() });

	await remoteMutation(shell, "edit", { entryId: "u1", newText: "edited" });

	// 读前快照 + 分块读 + 读后复核 + 私密写 + 最后一次守卫提交；不能退化回裸 mv。
	assert.equal(shell.commands.length, 5);
	assert.equal(GUARD_SHAPE.exec(shell.commands[0])?.[2], "snapshot");
	assert.equal(GUARD_SHAPE.exec(shell.commands[2])?.[2], "snapshot");
	const read = READ_WITH_SIZE_SHAPE.exec(shell.commands[1]);
	assert.notEqual(read, null, `读命令形状不符: ${shell.commands[0]}`);
	assert.equal(read[4], String(REMOTE_SESSION_HISTORY_READ_CHUNK_BYTES), "单次读取窗口上界必须是有界常量");
	// 读窗口的 base64 输出留在传输层 256 KiB 上界之下（两边的算术必须自洽，否则大文件读取必失败）。
	assert.equal(Math.ceil(REMOTE_SESSION_HISTORY_READ_CHUNK_BYTES / 3) * 4 < REMOTE_SESSION_HISTORY_TRANSPORT_BYTES, true);
	const [, , , start] = read;
	assert.equal(start, "1", "第一次读从文件首字节开始");
	assert.match(shell.commands[1], new RegExp(`'${TARGET_PATH.replaceAll("/", "\\/")}'`));

	const write = WRITE_CHUNK_SHAPE.exec(shell.commands[3]);
	assert.notEqual(write, null, `写命令形状不符: ${shell.commands[1]}`);
	const [, , operator, tempPath] = write;
	assert.equal(operator, ">", "第一块用 `>` 创建临时文件（后续块用 `>>` 追加）");
	assert.notEqual(tempPath, TARGET_PATH, "内容只能写进临时文件");
	assert.equal(tempPath.slice(0, tempPath.lastIndexOf("/")), TARGET_PATH.slice(0, TARGET_PATH.lastIndexOf("/")), "临时文件必须在同目录（同一文件系统 ⇒ rename 原子）");
	assert.match(tempPath.split("/").pop(), /^\..+\.pideck-tmp$/, "临时文件名隐藏且不以 .jsonl 结尾（远端扫描不会捡走它）");

	const commit = GUARD_SHAPE.exec(shell.commands[4]);
	assert.equal(commit?.[2], "commit");
	assert.equal(commit?.[4], TARGET_PATH);
	assert.equal(commit?.[5], tempPath);
	assert.equal(JSON.parse(commit[6]).nextDigest, createHash("sha256").update(shell.bytes()).digest("hex"));
	// 写内容的过程只碰临时文件：唯一提到目标路径的**写**命令是最后那条 mv。
	assert.deepEqual(
		shell.writeCommands().filter((command) => command.includes(TARGET_PATH)),
		[],
	);
	// 命令里只允许单引号字面量与 base64 字符集：没有任何第二套语法。
	for (const command of shell.commands) {
		assert.equal(/["`$\\\n]/.test(command.replace(/'[^']*'/g, "''")), false, `用户参数不得逃出单引号 argv: ${command}`);
		assert.equal(/[\r\n]/.test(command), false, "单命令禁止换行");
		assert.equal(command.length <= REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH, true, `命令超过 pinned 通道的单命令上界: ${command.length}`);
	}
});

test("chunked transfer over many read/write commands produces the same bytes as a single chunk", async () => {
	const document = largeDocument();
	assert.equal(document.length > 4096, true, "夹具必须大于单块上界，否则分块路径根本没被走到");
	const chunked = fakeShell({ [TARGET_PATH]: document });
	const plain = fakeShell({ [TARGET_PATH]: document });

	await remoteMutation(chunked, "edit", { entryId: "m3", newText: "smaller" }, { readChunkBytes: 512, writeChunkBytes: 64 });
	await remoteMutation(plain, "edit", { entryId: "m3", newText: "smaller" });

	// 分块只是传输细节，结果必须与「一块装下」完全一致。
	assert.deepEqual(chunked.bytes(), plain.bytes());
	assert.equal(chunked.writeCommands().length > 1, true, "必须真的走了多块写入");
	// 块数 = 内容字节 / 分块大小（向上取整），两种分块大小各自成立。
	assert.equal(chunked.writeCommands().length, Math.ceil(chunked.bytes().length / 64));
	assert.equal(plain.writeCommands().length, Math.ceil(plain.bytes().length / REMOTE_SESSION_HISTORY_WRITE_CHUNK_BYTES));
	// `wc -c` 只在第一条读命令里（后续块用游标续读）。
	assert.equal(chunked.commands.filter((command) => command.includes("wc -c")).length, 1);
	assert.equal(chunked.replaceCommands().length, 1);
});

test("a login banner in stdout does not corrupt the rewrite (marker guards the payload)", async () => {
	const document = fixtureDocument();
	const shell = fakeShell({ [TARGET_PATH]: document }, { banner: true });

	await remoteMutation(shell, "edit", { entryId: "u1", newText: "after banner" });

	assert.match(shell.text(), /"text":"after banner"/);
	// 横幅绝不会被当成内容写回。
	assert.equal(shell.text().includes("Now using node"), false);
	assert.match(shell.text(), /"text":"first answer"/);
});

test("a failing remote command stops immediately: stable code, target bytes untouched, no retry", async () => {
	const document = fixtureDocument();
	// ① 读失败：没有写、没有 mv。
	const readFailure = fakeShell({ [TARGET_PATH]: document }, { failAt: (_command, index) => index === 0 });
	assert.equal(await rejectionCode(() => remoteMutation(readFailure, "edit", { entryId: "u1", newText: "x" })), REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed);
	assert.equal(readFailure.commands.length, 1, "失败即停：不得自动重试");
	assert.equal(readFailure.bytes().toString("utf8"), document, "读失败时目标文件一个字节都没动");
	assert.deepEqual(readFailure.writeCommands(), []);
	assert.deepEqual(readFailure.replaceCommands(), []);

	// ② 写临时文件失败：目标文件不变，且不再往下发命令。
	const writeFailure = fakeShell({ [TARGET_PATH]: document }, { failAt: (command) => WRITE_CHUNK_SHAPE.test(command) });
	assert.equal(await rejectionCode(() => remoteMutation(writeFailure, "delete", { entryId: "a3" })), REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed);
	assert.equal(writeFailure.commands.length, 4);
	assert.equal(writeFailure.bytes().toString("utf8"), document);
	assert.deepEqual(writeFailure.replaceCommands(), []);

	// ③ 提交命令失败：守卫脚本是「renameSync 之后才写结果」，所以非 0 退出/回执丢失不能声称「目标未改动」，
	// 必须报独立的「结果未确认」码（F5）；此处假 shell 没有执行 rename，故文件确实没变，但语义上不允许依赖这点。
	const replaceFailure = fakeShell({ [TARGET_PATH]: document }, { failAt: isCommit });
	assert.equal(await rejectionCode(() => remoteMutation(replaceFailure, "delete", { entryId: "a3" })), REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed);
	assert.equal(replaceFailure.commands.length, 5);
	assert.equal(replaceFailure.bytes().toString("utf8"), document);
	assert.equal(replaceFailure.replaceCommands().length, 1, "失败即停：提交命令只发一次，绝不自动重试");
	assert.equal(REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed.match(STABLE_CODE) !== null, true);
	assert.notEqual(REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed, REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed);
});

test("a commit whose rename succeeded but whose reply was lost reports result-unconfirmed, never a false 'untouched' (F5)", async (t) => {
	const document = fixtureDocument();
	const applied = await localMutation(t, document, "delete", ASSISTANT_TARGET);
	/** 提交命令的标记（守卫脚本把它写在结果最前面）。 */
	const commitMarker = (command) => GUARD_SHAPE.exec(command)?.[3];

	// ① SSH 在 rename 之后断开：真实 rename 已由假 shell 执行，回执抛传输错误。
	const dropped = fakeShell({ [TARGET_PATH]: document });
	const droppedRun = dropped.transport.runRemoteCommand;
	dropped.transport.runRemoteCommand = async (input) => {
		const result = await droppedRun(input);
		if (isCommit(input.remoteCommand)) throw new Error("SSH_HOST_COMMAND_TIMEOUT");
		return result;
	};
	assert.equal(await rejectionCode(() => remoteMutation(dropped, "delete", { entryId: "a3" })), REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed);
	assert.deepEqual(dropped.bytes(), applied, "rename 已经发生 —— 这正是‘目标未改动’不成立的原因");
	assert.equal(dropped.replaceCommands().length, 1, "未确认不等于自动重试：提交命令只发了一次");

	// ② 退出码 0 但 stdout 丢了（标记缺失）：远端已替换，本机只能报未确认。
	const lost = fakeShell({ [TARGET_PATH]: document });
	const lostRun = lost.transport.runRemoteCommand;
	lost.transport.runRemoteCommand = async (input) => {
		const result = await lostRun(input);
		return isCommit(input.remoteCommand) ? { exitCode: 0, stdout: "" } : result;
	};
	assert.equal(await rejectionCode(() => remoteMutation(lost, "delete", { entryId: "a3" })), REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed);
	assert.deepEqual(lost.bytes(), applied);
	assert.equal(lost.replaceCommands().length, 1);

	// ③ 结果行撕裂（半个 JSON）：同样无法证明 rename 没发生 ⇒ 未确认，而不是 transferInvalid。
	const torn = fakeShell({ [TARGET_PATH]: document });
	const tornRun = torn.transport.runRemoteCommand;
	torn.transport.runRemoteCommand = async (input) => {
		const result = await tornRun(input);
		return isCommit(input.remoteCommand) ? { exitCode: 0, stdout: `${commitMarker(input.remoteCommand)}{"ok":tru` } : result;
	};
	assert.equal(await rejectionCode(() => remoteMutation(torn, "delete", { entryId: "a3" })), REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed);
	assert.deepEqual(torn.bytes(), applied);

	// ④ 守卫脚本**亲自报告**的提交前失败（fileChanged）必须保留原码：那是确定没有 rename 的拒绝，
	// 折叠成「未确认」会让真正的冲突诊断失真。
	const conflict = fakeShell({ [TARGET_PATH]: document });
	const conflictRun = conflict.transport.runRemoteCommand;
	let conflictCommits = 0;
	conflict.transport.runRemoteCommand = async (input) => {
		// 模拟守卫脚本「校验失败 ⇒ rename 未执行 ⇒ 写出 {ok:false}」：不调用原始实现，因此文件保持原样。
		if (isCommit(input.remoteCommand)) {
			conflictCommits += 1;
			return { exitCode: 0, stdout: `${commitMarker(input.remoteCommand)}{"ok":false,"code":"fileChanged"}` };
		}
		return conflictRun(input);
	};
	assert.equal(await rejectionCode(() => remoteMutation(conflict, "delete", { entryId: "a3" })), REMOTE_SESSION_HISTORY_WRITER_CODES.fileChanged);
	assert.equal(conflict.bytes().toString("utf8"), document, "脚本明确拒绝时目标文件确实未改动");
	assert.equal(conflictCommits, 1, "未确认/失败都不自动重试：提交命令只发一次");
});

test("a truncated read is refused instead of writing back half the history", async () => {
	const document = fixtureDocument();
	// 远端少回一个字节：长度校验必须拦住它（写回半截内容是最坏的结果）。
	const shell = fakeShell({ [TARGET_PATH]: document }, { failAt: (command) => command.includes("wc -c") });
	// 第一条命令「成功」但内容被截断：用一个在 read 之后动手的通道模拟。
	const truncated = fakeShell({ [TARGET_PATH]: document });
	const original = truncated.transport.runRemoteCommand;
	truncated.transport.runRemoteCommand = async (input) => {
		const result = await original(input);
		// 丢掉尾部 5 个字符（换行 + 4 个 base64 字符 = 3 个数据字节）：只丢 padding 不会改变解码长度，
		// 那样测的就不是「少回数据」了。
		if (result.stdout.includes("PIDECK_HISTORY_") && READ_WITH_SIZE_SHAPE.test(input.remoteCommand)) {
			return { exitCode: 0, stdout: result.stdout.slice(0, result.stdout.length - 5) };
		}
		return result;
	};
	assert.equal(await rejectionCode(() => createWriter(truncated).mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation: "edit", messageId: "m", entryId: "u1", newText: "x" })), REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
	assert.equal(truncated.bytes().toString("utf8"), document);
	assert.deepEqual(truncated.writeCommands(), []);
	// 上面的夹具本身：一条成功但非 0 退出的命令同样是稳定码（不是裸异常）。
	assert.equal(await rejectionCode(() => remoteMutation(shell, "edit", { entryId: "u1", newText: "x" })), REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed);
	assert.equal(shell.bytes().toString("utf8"), document);
});

test("a file over the rewrite bound fails closed before any write", async () => {
	const document = largeDocument();
	const shell = fakeShell({ [TARGET_PATH]: document });

	assert.equal(await rejectionCode(() => remoteMutation(shell, "edit", { entryId: "m0", newText: "x" }, { maxFileBytes: 64 })), REMOTE_SESSION_HISTORY_WRITER_CODES.fileTooLarge);
	assert.equal(shell.bytes().toString("utf8"), document);
	assert.deepEqual(shell.writeCommands(), []);
	// 上界在读完第一条（拿到大小）后立刻生效：不把整份文件拉回来。
	assert.equal(shell.commands.length, 1);
});

test("an unparsable or graph-broken document is refused (same inputs the local editor refuses)", async () => {
	const cases = {
		duplicate: '{"type":"session","id":"s"}\n{"type":"message","id":"x","parentId":null,"message":{"role":"user","content":[]}}\n{"type":"message","id":"x","parentId":null,"message":{"role":"user","content":[]}}\n',
		invalidJson: '{"type":"session","id":"s"}\nnot-json\n',
		danglingParent: '{"type":"session","id":"s"}\n{"type":"message","id":"x","parentId":"ghost","message":{"role":"user","content":[]}}\n',
	};
	for (const [name, document] of Object.entries(cases)) {
		const shell = fakeShell({ [TARGET_PATH]: document });
		assert.equal(await rejectionCode(() => remoteMutation(shell, "edit", { entryId: "x", newText: "y" })), REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid, name);
		assert.equal(shell.bytes().toString("utf8"), document, name);
		assert.deepEqual(shell.writeCommands(), [], name);
	}
});

test("delete of a message that is not in the remote file is a no-op (no remote writes at all)", async () => {
	const document = fixtureDocument();
	const shell = fakeShell({ [TARGET_PATH]: document });

	const result = await remoteMutation(shell, "delete", { entryId: "does-not-exist", messageId: "live-uuid" });

	assert.equal(result, undefined);
	assert.deepEqual(shell.writeCommands(), []);
	assert.deepEqual(shell.replaceCommands(), []);
	assert.equal(shell.bytes().toString("utf8"), document);
	// edit/resend 依赖正文：找不到就必须报未找到（与在本机链路一致）。
	const editShell = fakeShell({ [TARGET_PATH]: document });
	assert.equal(await rejectionCode(() => remoteMutation(editShell, "edit", { entryId: "does-not-exist", messageId: "live-uuid", newText: "y" })), REMOTE_SESSION_HISTORY_WRITER_CODES.messageNotFound);
	const resendShell = fakeShell({ [TARGET_PATH]: document });
	assert.equal(await rejectionCode(() => remoteMutation(resendShell, "resend", { entryId: "does-not-exist", messageId: "live-uuid" })), REMOTE_SESSION_HISTORY_WRITER_CODES.messageNotFound);
});

test("role rules match the local chain (system entries refuse edit and resend)", async (t) => {
	const document = fixtureDocument();
	const editShell = fakeShell({ [TARGET_PATH]: document });
	assert.equal(await rejectionCode(() => remoteMutation(editShell, "edit", { entryId: "sys1", newText: "y" })), REMOTE_SESSION_HISTORY_WRITER_CODES.roleInvalid);
	assert.equal(editShell.bytes().toString("utf8"), document);
	// 本机同判据（AgentManager 把非 user 角色映射成 assistant 后由编辑器拒）。
	await assert.rejects(
		() => localMutation(t, document, "edit", { entryId: "sys1", role: "assistant", text: "system prompt" }, "y"),
		(error) => error instanceof SessionFileEditorError && error.code === "SESSION_ENTRY_ROLE_INVALID",
	);

	const resendShell = fakeShell({ [TARGET_PATH]: document });
	assert.equal(await rejectionCode(() => remoteMutation(resendShell, "resend", { entryId: "sys1" })), REMOTE_SESSION_HISTORY_WRITER_CODES.roleInvalid);
	assert.equal(resendShell.bytes().toString("utf8"), document);
});

test("invalid remote paths and identities are refused before any command is sent", async () => {
	// 相对身份 + 没有会话根解析端口 = fail-closed（绝不猜 <home>/.pi/agent/sessions）。
	const relative = createRemoteSessionHistoryWriter({ transport: fakeShell({}).transport, now: () => FIXED_TS });
	assert.equal(await rejectionCode(() => relative.mutate({ hostId: HOST, locator: locatorWith(REMOTE_ID), operation: "delete", messageId: "m" })), REMOTE_SESSION_HISTORY_WRITER_CODES.pathUnresolved);

	// 含单引号的远端路径：绝不进命令行（拒绝而不是实现一套转义）。
	const quoted = fakeShell({ [TARGET_PATH]: fixtureDocument() });
	assert.equal(await rejectionCode(() => createWriter(quoted).mutate({ hostId: HOST, locator: locatorWith(`${SESSION_ROOT}/ws/it's.jsonl`), operation: "delete", messageId: "m" })), REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid);
	assert.deepEqual(quoted.commands, [], "路径非法时一个远端命令都不发");

	// 非规范绝对路径（F6）：与读取侧同一判据，写面同样在发命令前拒绝。
	for (const badPath of ["${SESSION_ROOT}//ws/x.jsonl", "${SESSION_ROOT}/../escape.jsonl", "${SESSION_ROOT}/./ws/x.jsonl"]) {
		const nonCanonical = fakeShell({ [TARGET_PATH]: fixtureDocument() });
		assert.equal(await rejectionCode(() => createWriter(nonCanonical).mutate({ hostId: HOST, locator: locatorWith(badPath), operation: "delete", messageId: "m" })), REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid, badPath);
		assert.deepEqual(nonCanonical.commands, [], `非规范路径必须零命令: ${badPath}`);
	}

	// hostId / locator / operation 判据。
	const identity = fakeShell({ [TARGET_PATH]: fixtureDocument() });
	const writer = createWriter(identity);
	assert.equal(await rejectionCode(() => writer.mutate({ hostId: "nope", locator: ABSOLUTE_LOCATOR, operation: "delete", messageId: "m" })), REMOTE_SESSION_HISTORY_WRITER_CODES.hostIdInvalid);
	assert.equal(await rejectionCode(() => writer.mutate({ hostId: HOST, locator: { ...ABSOLUTE_LOCATOR, hostId: "22222222-2222-4222-8222-222222222222" }, operation: "delete", messageId: "m" })), REMOTE_SESSION_HISTORY_WRITER_CODES.locatorInvalid);
	assert.equal(await rejectionCode(() => writer.mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation: "truncate", messageId: "m" })), REMOTE_SESSION_HISTORY_WRITER_CODES.operationInvalid);
	assert.deepEqual(identity.commands, [], "身份/操作非法时一个远端命令都不发");

	// 纯构造器判据：文档里的形状（只允许单引号字面量 + base64 字符集）。
	const codeOf = (run) => {
		try {
			run();
		} catch (error) {
			return typeof error?.message === "string" ? error.message : String(error);
		}
		throw new Error("EXPECTED_THROW");
	};
	assert.equal(
		codeOf(() => buildRemoteSessionHistoryReplaceCommand({ from: `${SESSION_ROOT}/a.jsonl`, to: `${SESSION_ROOT}/b'c.jsonl` })),
		REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid,
	);
	assert.equal(
		codeOf(() => remoteSessionHistoryTempPath(`${SESSION_ROOT}/a'c.jsonl`, "abcd1234")),
		REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid,
	);
	assert.equal(
		codeOf(() => buildRemoteSessionHistoryChunkWriteCommand({ remotePath: `${SESSION_ROOT}/a.jsonl`, chunk: "AAAA'$(rm -rf /)'" })),
		REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID,
	);
	assert.equal(buildRemoteSessionHistoryReplaceCommand({ from: `${SESSION_ROOT}/a.jsonl`, to: `${SESSION_ROOT}/b.jsonl` }), `mv -- '${SESSION_ROOT}/a.jsonl' '${SESSION_ROOT}/b.jsonl'`);
	assert.equal(
		codeOf(() => buildRemoteSessionHistoryChunkReadCommand({ remotePath: `${SESSION_ROOT}/a.jsonl`, start: 1, count: 1, nonce: "short" })),
		REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID,
	);
	assert.equal(buildRemoteSessionHistoryChunkWriteCommand({ remotePath: `${SESSION_ROOT}/a.jsonl`, chunk: "QUJD", append: true }), `printf '%s' 'QUJD' | base64 -d >> '${SESSION_ROOT}/a.jsonl'`);
	assert.match(remoteSessionHistoryTempPath(`${SESSION_ROOT}/a.jsonl`, "deadbeefdeadbeef"), /^\/home\/dev\/\.pi\/agent\/sessions\/\..+\.pideck-tmp$/);

	// 分块解析：标记缺失/长度不符都折叠成稳定码（跨 realm 的错误只能按 message 认码）。
	assert.equal(
		codeOf(() => parseRemoteSessionHistoryChunk("no marker here", { marker: "PIDECK_HISTORY_ab", withSize: true, expectedBytes: 1 })),
		REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid,
	);
	assert.equal(
		codeOf(() => parseRemoteSessionHistoryChunk("PIDECK_HISTORY_ab3\nQUJD", { marker: "PIDECK_HISTORY_ab", withSize: true, expectedBytes: 4 })),
		REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid,
	);
	assert.equal(parseRemoteSessionHistoryChunk("PIDECK_HISTORY_ab   3\nQUJD\n", { marker: "PIDECK_HISTORY_ab", withSize: true, expectedBytes: 3 }).size, 3);
	assert.deepEqual(parseRemoteSessionHistoryChunk("banner\nPIDECK_HISTORY_ab QUJD\n", { marker: "PIDECK_HISTORY_ab", withSize: false, expectedBytes: 3 }).bytes, Buffer.from("ABC"));
	assert.equal(remoteSessionHistoryWriteFailure(Object.assign(new Error(REMOTE_SESSION_HISTORY_WRITER_CODES.fileTooLarge), { details: { size: 1, limit: 2 } })).details.limit, 2);
	assert.equal(remoteSessionHistoryWriteFailure(new Error("boom")).code, REMOTE_SESSION_HISTORY_WRITER_CODES.transportFailed);
	assert.equal(REMOTE_SESSION_HISTORY_WRITE_CHUNK_BYTES, 4096);
});

test("constructor rejects an invalid assembly and folds transport errors into a stable code", async () => {
	const codeOf = (run) => {
		try {
			run();
		} catch (error) {
			return typeof error?.message === "string" ? error.message : String(error);
		}
		throw new Error("EXPECTED_THROW");
	};
	assert.equal(
		codeOf(() => createRemoteSessionHistoryWriter({})),
		REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID,
	);
	assert.equal(
		codeOf(() => createRemoteSessionHistoryWriter({ transport: fakeShell({}).transport, maxFileBytes: 64 * 1024 * 1024 })),
		REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID,
	);
	// 连接层自己的稳定码原样转述（不吞成裸异常、也不谎报命令失败）。
	const shell = fakeShell({ [TARGET_PATH]: fixtureDocument() });
	shell.transport.runRemoteCommand = async () => {
		throw new Error("SSH_HOST_NOT_READY");
	};
	assert.equal(await rejectionCode(() => createWriter(shell).mutate({ hostId: HOST, locator: ABSOLUTE_LOCATOR, operation: "delete", messageId: "m", entryId: "a3" })), "SSH_HOST_NOT_READY");
});

/** 稳定码断言：rejection 的 message 是码（远端一系的既有约定）。 */
async function rejectionCode(run) {
	try {
		await run();
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

/**
 * 接线级证据：真实 `SessionCatalog` + 真实 `SessionRuntimeCoordinator` + 真实写面 + 假远端 shell。
 * 三条链路在 ssh 记录上的完整行为（本机路径入口一次都不参与），结果与本机编辑器同序改写逐字节一致。
 */
test("the three chains over an ssh record end to end: remote file rewritten, local path never touched", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-write-chain-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalog = new SessionCatalog(join(directory, "session-catalog.json"));
	await catalog.load();
	const document = fixtureDocument();
	const shell = fakeShell({ [TARGET_PATH]: document });
	// 同一个写面实例（同一条 uuid 序列）：三次操作共用一份文件，重复 id 会被文档校验拒绝。
	const writer = createWriter(shell, { createUuid: stableUuid() });
	const coordinator = new SessionRuntimeCoordinator(
		catalog,
		{ backend: "pi", list: () => [] },
		async () => ({ accepted: false, delivery: "rejected", error: "unused", sessionId: "unused", requestId: "unused" }),
		undefined,
		undefined,
		() => writer,
	);
	const localPathLookups = [];
	const originalGetLocalFilePath = catalog.getLocalFilePath.bind(catalog);
	catalog.getLocalFilePath = (sessionId) => {
		localPathLookups.push(sessionId);
		return originalGetLocalFilePath(sessionId);
	};
	const registration = await catalog.ensureRemoteSession({ projectId: "project-remote", hostId: HOST, remoteSessionId: REMOTE_ID, remotePath: TARGET_PATH, title: "远端会话", updatedAt: 1 });
	const sessionId = registration.record.id;

	// 三条链路（同一份会话上的连续操作）：编辑 → 删除回答 → 重发截断。
	const edited = await coordinator.editCatalogMessage(sessionId, "live-1", "edited remotely", "u1");
	const deleted = await coordinator.deleteCatalogMessage(sessionId, "live-2", "a3");
	const resent = await coordinator.prepareCatalogResend(sessionId, "live-3", "u2");

	assert.equal(edited.ok, true);
	assert.equal(deleted.ok, true);
	assert.equal(resent.ok, true);
	assert.equal(resent.value.text, "again");
	assert.equal(resent.value.images.length, 1);
	assert.equal(resent.value.images[0].data, "AAAA");

	// 同序跑一遍真实本机编辑器：两条链路必须得到**同一份字节**（判据不是「看起来像」）。
	const localDirectory = await mkdtemp(join(tmpdir(), "pideck-remote-write-chain-local-"));
	t.after(() => rm(localDirectory, { recursive: true, force: true }));
	const localPath = join(localDirectory, "session.jsonl");
	await writeFile(localPath, document);
	const editor = new SessionFileEditor({ now: () => FIXED_TS, randomUUID: stableUuid() });
	const file = { protocolPath: localPath, hostPath: localPath, environment: "native" };
	const reload = async () => undefined;
	await editor.editMessage({ file, target: USER_TARGET, newText: "edited remotely", reload });
	await editor.deleteMessage({ file, target: ASSISTANT_TARGET, reload });
	await editor.truncateForResend({ file, target: { entryId: "u2", role: "user", text: "again" }, reload });
	// 三次操作各自新增/墓碑了随机 id 的记录：先归一化这些 id，再逐字节比对（其余字节必须完全一致）。
	assert.equal(normalizeGeneratedIds(shell.bytes()), normalizeGeneratedIds(await readFile(localPath)));

	// ssh 记录全程不碰本机路径入口。
	assert.deepEqual(localPathLookups, []);

	// 本机会话在同一条协调器上仍走本机分支（远端 shell 一条命令都不发）。
	const commandsBefore = shell.commands.length;
	const draft = await catalog.createDraft({ projectId: "project-local", title: "本机会话", environment: "native" });
	await catalog.update(draft.id, { filePath: join(directory, "local.jsonl") });
	const localResult = await coordinator.editCatalogMessage(draft.id, "live-4", "local edit", "entry-x");
	assert.equal(localResult.ok, false, "替身 agents 没有本机写面能力：失败恰好证明它走的是本机分支");
	assert.deepEqual(shell.commands.length, commandsBefore);
});

test("SSH stop retains the live identity before gateway cache destruction and isolates it by host and path", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-live-stop-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalog = new SessionCatalog(join(directory, "catalog.json"));
	await catalog.load();
	const registration = await catalog.ensureRemoteSession({ projectId: "remote", hostId: HOST, remoteSessionId: REMOTE_ID, remotePath: TARGET_PATH, title: "live", updatedAt: 1 });
	const sessionId = registration.record.id;
	const document = fixtureDocument();
	const shell = fakeShell({ [TARGET_PATH]: document });
	const writer = createWriter(shell, { project: (messages, ids) => projector.convert("viewer", messages, ids) });
	const messages = [{ id: "live-random-id", role: "user", text: "hello world", timestamp: Date.parse("2026-01-01T00:00:10.000Z"), meta: { persistedTimestamp: Date.parse("2026-01-01T00:00:00.000Z") } }];
	const tabs = [{ id: "agent-live", projectId: "remote", status: "idle", sessionPath: TARGET_PATH, createdAt: 1 }];
	const retained = [];
	const gateway = {
		backend: "pi",
		list: () => tabs,
		getMessages: () => {
			assert.equal(tabs.length, 1, "identity must be captured before stop, not after runtime caches are destroyed");
			return messages;
		},
		stop: async () => {
			tabs.length = 0;
			messages.length = 0;
		},
	};
	const coordinator = new SessionRuntimeCoordinator(
		catalog,
		gateway,
		async () => undefined,
		undefined,
		undefined,
		() => ({
			mutate: async (input) => {
				retained.push(input.stoppedIdentity);
				return writer.mutate(input);
			},
		}),
	);
	coordinator.bindExistingAgent(sessionId, "agent-live");
	const stopped = await coordinator.stopRuntime(coordinator.getTarget(sessionId));
	assert.equal(stopped.ok, true);
	const deleted = await coordinator.deleteCatalogMessage(sessionId, "live-random-id");
	assert.equal(deleted.ok, true);
	assert.equal(retained[0].role, "user");
	assert.equal("text" in retained[0], false, "only the fingerprint may outlive the runtime, not the message body");
	assert.deepEqual(shell.bytes(), await localMutation(t, document, "delete", USER_TARGET));

	const otherHost = await catalog.ensureRemoteSession({ projectId: "other-host", hostId: "22222222-2222-4222-8222-222222222222", remoteSessionId: REMOTE_ID, remotePath: TARGET_PATH, title: "other host", updatedAt: 1 });
	const otherPath = await catalog.ensureRemoteSession({ projectId: "other-path", hostId: HOST, remoteSessionId: "ws/other.jsonl", remotePath: SESSION_ROOT + "/ws/other.jsonl", title: "other path", updatedAt: 1 });
	// 这里只核对端口收到的身份（另一台主机不存在于假文件表），不伪造文件成功结果。
	await coordinator.deleteCatalogMessage(otherHost.record.id, "live-random-id");
	await coordinator.deleteCatalogMessage(otherPath.record.id, "live-random-id");
	assert.equal(retained[1], undefined);
	assert.equal(retained[2], undefined);
});
