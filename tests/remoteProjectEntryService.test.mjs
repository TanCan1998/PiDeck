import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const POSIX = process.platform === "linux";
const { createRemoteProjectEntryService } = loadTsCommonJs("src/main/remote/RemoteProjectEntryService.ts");
const NODE = realpathSync(process.execPath);
const revision = { mode: 420, size: 7, dev: "100", ino: "200", uid: "1000", gid: "1000", mtimeNs: "111", ctimeNs: "222" };
const statOk = { ok: true, stat: { kind: "file", bytes: 7, mtimeMs: 1 }, revision };

/**
 * 服务层确定性宿主：所有远端 I/O 用 responses 队列伪造，命令本身由生产 builder 构造（命令必须真实合法），
 * 但 marker 从构造出的命令里取回，保证解析口径与真实命令一致。
 */
async function harness(t) {
	const root = await mkdtemp(join(tmpdir(), "pideck-entry-svc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const calls = [];
	const responses = [];
	const gates = [];
	let time = 0;
	let hostRevision = 1;
	let locator = { hostId: "11111111-1111-4111-8111-111111111111", remotePath: root };
	let commandHook;
	const service = createRemoteProjectEntryService({
		locator: (id) => (id === "project" ? locator : id === "other" ? { hostId: "22222222-2222-4222-8222-222222222222", remotePath: root } : undefined),
		withProject: async (_target, work) =>
			work({
				nodePath: NODE,
				get hostRevision() {
					return hostRevision;
				},
				runCommand: async (command) => {
					calls.push(command);
					if (gates.length > 0) await gates.shift();
					if (commandHook) commandHook(command);
					const marker = /PIDECK_(?:ENTRY|TRASH)_[a-f0-9]{32}/.exec(command)?.[0];
					const response = responses.shift();
					if (response === undefined) throw new Error("unexpected remote command");
					if (typeof response === "string") return { exitCode: 0, stdout: response };
					return { exitCode: 0, stdout: marker + JSON.stringify(response) };
				},
			}),
		now: () => time,
	});
	return {
		root,
		calls,
		responses,
		gates,
		service,
		advance: () => {
			time += 31 * 60 * 1000;
		},
		rebindHost: () => {
			hostRevision += 1;
		},
		mutateLocator: () => {
			locator = { ...locator, remotePath: root + "-other" };
		},
		setCommandHook: (hook) => {
			commandHook = hook;
		},
	};
}

test("entry tokens bind sender/project/path/locator snapshot/host revision and are consumed once", { skip: !POSIX }, async (t) => {
	const h = await harness(t);
	h.responses.push(statOk);
	const issued = await h.service.stat(1, "project", "a.txt");
	assert.match(issued.version, /^[a-f0-9]{32}$/);
	assert.equal(issued.stat.kind, "file");
	// 每个非法持有者都不得烧掉令牌：先全部失败，再用合法参数成功。
	for (const attempt of [() => h.service.rename(2, "project", "a.txt", "b.txt", issued.version), () => h.service.rename(1, "other", "a.txt", "b.txt", issued.version), () => h.service.rename(1, "project", "other.txt", "b.txt", issued.version)]) await assert.rejects(attempt, /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(h.calls.length, 1);
	h.mutateLocator();
	await assert.rejects(h.service.rename(1, "project", "a.txt", "b.txt", issued.version), /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(h.calls.length, 1);
});

test("rename runs the mandated identity re-check then the mutation, and consumes the token before awaiting", { skip: !POSIX }, async (t) => {
	const h = await harness(t);
	h.responses.push(statOk);
	const issued = await h.service.stat(1, "project", "a.txt");
	h.responses.push(statOk, { ok: true, relativePath: "b.txt" });
	const renamed = await h.service.rename(1, "project", "a.txt", "b.txt", issued.version);
	assert.equal(renamed.relativePath, "b.txt");
	assert.equal(h.calls.length, 3);
	assert.match(h.calls[1], /'stat'/);
	assert.match(h.calls[2], /'rename'/);
	await assert.rejects(h.service.rename(1, "project", "a.txt", "b.txt", issued.version), /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(h.calls.length, 3);
});

test("a changed entry between stat and rename is CHANGED with zero mutation commands", { skip: !POSIX }, async (t) => {
	const h = await harness(t);
	h.responses.push(statOk);
	const issued = await h.service.stat(1, "project", "a.txt");
	h.responses.push({ ...statOk, revision: { ...revision, mtimeNs: "999" } });
	await assert.rejects(h.service.rename(1, "project", "a.txt", "b.txt", issued.version), /REMOTE_FILE_CHANGED/);
	assert.equal(h.calls.length, 2);
	assert.doesNotMatch(h.calls[1], /'rename'/);
});

test("host revision change, TTL expiry and window destruction all revoke entry tokens", { skip: !POSIX }, async (t) => {
	const rebound = await harness(t);
	rebound.responses.push(statOk);
	const first = await rebound.service.stat(1, "project", "a.txt");
	rebound.rebindHost();
	await assert.rejects(rebound.service.rename(1, "project", "a.txt", "b.txt", first.version), /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(rebound.calls.length, 1);
	const expired = await harness(t);
	expired.responses.push(statOk);
	const second = await expired.service.stat(1, "project", "a.txt");
	expired.advance();
	await assert.rejects(expired.service.rename(1, "project", "a.txt", "b.txt", second.version), /REMOTE_FILE_VERSION_INVALID/);
	const released = await harness(t);
	released.responses.push(statOk);
	const third = await released.service.stat(1, "project", "a.txt");
	released.service.releaseSender(1);
	await assert.rejects(released.service.rename(1, "project", "a.txt", "b.txt", third.version), /REMOTE_FILE_VERSION_INVALID/);
});

test("create/restore/prune are sender single-flight; a second write is BUSY while the first is in flight", { skip: !POSIX }, async (t) => {
	const h = await harness(t);
	let release;
	h.gates.push(new Promise((resolve) => (release = resolve)));
	h.responses.push({ ok: true, relativePath: "new.txt", kind: "file" });
	const creating = h.service.createFile(1, "project", "", "new.txt");
	await new Promise((resolve) => setImmediate(resolve));
	await assert.rejects(h.service.createDirectory(1, "project", "", "dir"), /REMOTE_FILE_BUSY/);
	await assert.rejects(h.service.pruneTrash(1, "project", ["20261017T093012Z-aaaaaaaa"]), /REMOTE_FILE_BUSY/);
	release();
	const created = await creating;
	assert.equal(created.relativePath, "new.txt");
	assert.equal(created.kind, "file");
});

test("invalid inputs and protected paths never open a session or consume a token", { skip: !POSIX }, async (t) => {
	const h = await harness(t);
	assert.equal(h.calls.length, 0);
	await assert.rejects(h.service.stat(1, "project", "../secret"), /REMOTE_FILE_PATH_INVALID/);
	await assert.rejects(h.service.stat(1, "project", ".pideck-trash/x"), /REMOTE_FILE_PROTECTED_PATH/);
	await assert.rejects(h.service.stat(1, "project", ""), /REMOTE_FILE_PATH_INVALID/);
	await assert.rejects(h.service.createFile(1, "project", "", "a/b"), /REMOTE_FILE_NAME_INVALID/);
	await assert.rejects(h.service.createFile(1, "project", "", ".pideck-tmp"), /REMOTE_FILE_NAME_INVALID/);
	await assert.rejects(h.service.createDirectory(1, "project", ".git", "x"), /REMOTE_FILE_PROTECTED_PATH/);
	await assert.rejects(h.service.rename(1, "project", ".git/a", "b", "a".repeat(32)), /REMOTE_FILE_PROTECTED_PATH/);
	await assert.rejects(h.service.restoreTrash(1, "project", "not-an-id"), /REMOTE_FILE_INPUT_INVALID/);
	await assert.rejects(
		h.service.pruneTrash(
			1,
			"project",
			Array.from({ length: 33 }, (_, index) => "20261017T0930" + String(index % 100).padStart(2, "0") + "Z-aaaaaaaa"),
		),
		/REMOTE_FILE_INPUT_INVALID/,
	);
	await assert.rejects(h.service.listTrash(1, "unknown"), /REMOTE_PROJECT_NOT_FOUND/);
	assert.equal(h.calls.length, 0);
});

test("unknown write results are UNCONFIRMED and never retried; read protocol errors stay COMMAND_FAILED", { skip: !POSIX }, async (t) => {
	const h = await harness(t);
	h.responses.push("garbage-without-marker");
	await assert.rejects(h.service.createFile(1, "project", "", "new.txt"), /REMOTE_FILE_RESULT_UNCONFIRMED/);
	assert.equal(h.calls.length, 1);
	h.responses.push("garbage-without-marker");
	await assert.rejects(h.service.stat(1, "project", "a.txt"), /REMOTE_FILE_COMMAND_FAILED/);
	h.responses.push({ ok: false, code: "REMOTE_FILE_TRANSFER_INVALID" });
	await assert.rejects(h.service.createDirectory(1, "project", "", "dir"), /REMOTE_FILE_TRANSFER_INVALID/);
	h.responses.push({ ok: false, code: "REMOTE_FILE_BOGUS_NOT_A_CODE" });
	await assert.rejects(h.service.createDirectory(1, "project", "", "dir"), /REMOTE_FILE_COMMAND_FAILED/);
	// 传输异常（不是稳定码）在写路径上按未确认处理，且不重试。
	const failing = await harness(t);
	failing.setCommandHook(() => {
		throw new Error("ssh transport lost");
	});
	await assert.rejects(failing.service.createFile(1, "project", "", "new.txt"), /REMOTE_FILE_RESULT_UNCONFIRMED/);
	assert.equal(failing.calls.length, 1);
});

test("trash list/restore/prune results are re-validated field by field", { skip: !POSIX }, async (t) => {
	const h = await harness(t);
	const manifest = { schemaVersion: 1, id: "20261017T093012Z-aaaaaaaa", originalPath: "old.txt", name: "old.txt", kind: "file", bytes: 3, deletedAt: "2026-10-17T09:30:12.000Z", expiresAt: "2026-11-16T09:30:12.000Z", revision };
	h.responses.push({ ok: true, entries: [{ id: "20261017T093012Z-aaaaaaaa", state: "intact", raw: manifest }], truncated: false });
	const listed = await h.service.listTrash(1, "project");
	assert.equal(listed.entries.length, 1);
	assert.equal(listed.entries[0].originalPath, "old.txt");
	assert.equal(listed.entries[0].kind, "file");
	assert.equal(listed.entries[0].state, "intact");
	// 未知字段/类型错误的 manifest ⇒ 该条目 invalid（不信任远端回传字段）。
	h.responses.push({ ok: true, entries: [{ id: "20261017T093012Z-aaaaaaaa", state: "intact", raw: { ...manifest, extra: 1 } }], truncated: false });
	assert.equal((await h.service.listTrash(1, "project")).entries[0].state, "invalid");
	h.responses.push({ ok: true, entries: "not-an-array", truncated: false });
	await assert.rejects(h.service.listTrash(1, "project"), /REMOTE_FILE_COMMAND_FAILED/);
	// prune：removed/kept 必须与请求集合自洽，kept code 必须是闭集稳定码。
	h.responses.push({ ok: true, relativePath: "old.txt" });
	assert.equal((await h.service.restoreTrash(1, "project", "20261017T093012Z-aaaaaaaa")).relativePath, "old.txt");
	h.responses.push({ ok: true, relativePath: "../escape" });
	await assert.rejects(h.service.restoreTrash(1, "project", "20261017T093012Z-aaaaaaaa"), /REMOTE_FILE_RESULT_UNCONFIRMED/);
	h.responses.push({ ok: true, removed: ["20261017T093012Z-aaaaaaaa"], kept: [] });
	const pruned = await h.service.pruneTrash(1, "project", ["20261017T093012Z-aaaaaaaa"]);
	assert.equal(pruned.removed.length, 1);
	assert.equal(pruned.removed[0], "20261017T093012Z-aaaaaaaa");
	assert.equal(pruned.kept.length, 0);
	h.responses.push({ ok: true, removed: ["20261017T093012Z-bbbbbbbb"], kept: [] });
	await assert.rejects(h.service.pruneTrash(1, "project", ["20261017T093012Z-aaaaaaaa"]), /REMOTE_FILE_RESULT_UNCONFIRMED/);
	h.responses.push({ ok: true, removed: [], kept: [{ id: "20261017T093012Z-aaaaaaaa", code: "NOT_A_CODE" }] });
	await assert.rejects(h.service.pruneTrash(1, "project", ["20261017T093012Z-aaaaaaaa"]), /REMOTE_FILE_RESULT_UNCONFIRMED/);
});
test("each operation's remote command count is fixed (frozen §8 budget; rename/delete include the §5.3 re-check)", { skip: !POSIX }, async (t) => {
	const stat = await harness(t);
	stat.responses.push(statOk);
	await stat.service.stat(1, "project", "a.txt");
	assert.equal(stat.calls.length, 1);
	const createFile = await harness(t);
	createFile.responses.push({ ok: true, relativePath: "new.txt", kind: "file" });
	await createFile.service.createFile(1, "project", "", "new.txt");
	assert.equal(createFile.calls.length, 1);
	const createDir = await harness(t);
	createDir.responses.push({ ok: true, relativePath: "dir", kind: "directory" });
	await createDir.service.createDirectory(1, "project", "", "dir");
	assert.equal(createDir.calls.length, 1);
	const rename = await harness(t);
	rename.responses.push(statOk);
	const renameToken = (await rename.service.stat(1, "project", "a.txt")).version;
	rename.responses.push(statOk, { ok: true, relativePath: "b.txt" });
	await rename.service.rename(1, "project", "a.txt", "b.txt", renameToken);
	// 1 次 entry-stat（签发令牌）+ §5.3 的复核 stat + 1 次 rename = 3；其中执行阶段固定 2。
	assert.equal(rename.calls.length, 3);
	const remove = await harness(t);
	remove.responses.push(statOk);
	const deleteToken = (await remove.service.stat(1, "project", "a.txt")).version;
	remove.responses.push(statOk);
	// trashId 是 main 生成的：从构造出的命令 JSON 里回读，回执必须回显同一个 id。
	remove.setCommandHook((command) => {
		const match = /"trashId":"([^"]+)"/.exec(command);
		if (match !== null) remove.responses[0] = { ok: true, trashId: match[1] };
	});
	await remove.service.deleteEntry(1, "project", "a.txt", deleteToken);
	assert.equal(remove.calls.length, 3);
	const list = await harness(t);
	list.responses.push({ ok: true, entries: [], truncated: false });
	await list.service.listTrash(1, "project");
	assert.equal(list.calls.length, 1);
	const restore = await harness(t);
	restore.responses.push({ ok: true, relativePath: "a.txt" });
	await restore.service.restoreTrash(1, "project", "20261017T093012Z-aaaaaaaa");
	assert.equal(restore.calls.length, 1);
	const prune = await harness(t);
	prune.responses.push({ ok: true, removed: ["20261017T093012Z-aaaaaaaa"], kept: [] });
	await prune.service.pruneTrash(1, "project", ["20261017T093012Z-aaaaaaaa"]);
	assert.equal(prune.calls.length, 1);
});
