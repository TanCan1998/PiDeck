import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * `SessionCatalog.attachRuntime` 的远端分支（P4.2 收口：同一远端会话恰好一条记录）。
 *
 * 这组用例直接对真 catalog 断言「远端路径怎么被写」这一件事 —— 远端会话的会话文件在那台机器上，
 * 所以 attach 只能回写 **ssh 身份**，并且必须把同一远端会话已有的那条记录（握手登记先立的 / 扫描
 * 发现的）吸收进渲染层手上那个 id：
 *
 * 1. draft + 已登记条目 ⇒ 一条记录（draft 存活，相对身份由被吸收的那条带过来）；
 * 2. 同路径**不同 hostId** ⇒ 两回事，互不吸收；
 * 3. 已经是同一身份的条目：回写幂等，已存的相对身份不得被冲掉；
 * 4. 非法 hostId（非 UUID）⇒ 稳定码拒绝，零写入。
 */

const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
	stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
});

const HOST_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const HOST_B = "9c1d5f7a-2b3e-4c5d-8e9f-0a1b2c3d4e5f";
const REMOTE_PATH = "/home/dev/.pi/agent/sessions/-srv-remote-app/shared.jsonl";
const REMOTE_ID = "-srv-remote-app/shared.jsonl";

/** 跨 VM realm 的比较前先归一化（deepStrictEqual 会比较原型）。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

async function makeCatalog(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-attach-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalog = new SessionCatalog(join(directory, "session-catalog.json"));
	await catalog.load();
	return catalog;
}

/** 握手登记（`ensureRemoteSession`）：远端 pi 上报会话文件后那条**唯一**的 ssh 身份写入口。 */
function register(catalog, { projectId = "project-a", hostId = HOST_A, remoteSessionId = REMOTE_ID, remotePath = REMOTE_PATH, title = "shared" } = {}) {
	return catalog.ensureRemoteSession({ projectId, hostId, remoteSessionId, remotePath, title, updatedAt: 5 });
}

test("draft 吸收同身份的已登记条目：恰好一条，远端路径不进本机字段", async (t) => {
	const catalog = await makeCatalog(t);
	const draft = await catalog.createDraft({ projectId: "project-a", title: "新会话", environment: "native" });
	// 登记先立的那条：picked 模型/档位要能被 draft 继承，创建时间取更早的那个。
	const registered = await register(catalog);
	await catalog.update(registered.record.id, { model: { provider: "anthropic", modelId: "claude-x" }, thinkingLevel: "high" });

	const attached = await catalog.attachRuntime({ sessionId: draft.id, remoteLocator: { kind: "ssh", hostId: HOST_A, remotePath: REMOTE_PATH } });

	assert.equal(attached.id, draft.id);
	assert.equal(catalog.listEntries().length, 1, "同一远端会话必须恰好一条记录");
	const entry = catalog.listEntries()[0];
	assert.equal(entry.id, draft.id);
	assert.equal(entry.status, "active");
	// 远端身份完整：相对身份由被吸收的那条带过来（会话根的判断不在这里复刻）。
	assert.deepEqual(plain(entry.locator), { kind: "ssh", hostId: HOST_A, remoteSessionId: REMOTE_ID, remotePath: REMOTE_PATH });
	// 本机镜像字段一个都不许有。
	assert.equal(entry.filePath, undefined);
	assert.equal(entry.originKey, undefined);
	assert.equal(entry.piSessionId, undefined);
	assert.equal(entry.wslDistro, undefined);
	// 补空缺：draft 没有的偏好从被吸收的记录继承。
	assert.equal(entry.model?.modelId, "claude-x");
	assert.equal(entry.thinkingLevel, "high");
	assert.equal(entry.createdAt, draft.createdAt, "创建时间取更早的那个（草稿先建）");
});

test("同路径不同 hostId：互不吸收（两台主机上的两个会话）", async (t) => {
	const catalog = await makeCatalog(t);
	const draft = await catalog.createDraft({ projectId: "project-a", title: "新会话", environment: "native" });
	await register(catalog, { hostId: HOST_B, title: "另一台主机" });

	const attached = await catalog.attachRuntime({ sessionId: draft.id, remoteLocator: { kind: "ssh", hostId: HOST_A, remotePath: REMOTE_PATH } });

	assert.equal(attached.locator.hostId, HOST_A);
	const entries = catalog.listEntries();
	assert.equal(entries.length, 2, "不同 hostId 是不同会话，不得互相顶掉");
	assert.deepEqual(plain(entries.map((entry) => entry.locator.hostId).sort()), [HOST_A, HOST_B].sort());
});

test("已是同一身份的条目：回写幂等且不丢相对身份", async (t) => {
	const catalog = await makeCatalog(t);
	const registered = await register(catalog);

	const attached = await catalog.attachRuntime({ sessionId: registered.record.id, remoteLocator: { kind: "ssh", hostId: HOST_A, remotePath: REMOTE_PATH } });

	assert.equal(catalog.listEntries().length, 1);
	assert.deepEqual(plain(attached.locator), { kind: "ssh", hostId: HOST_A, remoteSessionId: REMOTE_ID, remotePath: REMOTE_PATH });
	assert.equal(attached.filePath, undefined);
});

test("ssh 条目不得被本机 filePath 分支解释（回写方向同样按 locator 路由）", async (t) => {
	const catalog = await makeCatalog(t);
	const registered = await register(catalog);

	await assert.rejects(() => catalog.attachRuntime({ sessionId: registered.record.id, filePath: "/home/dev/elsewhere.jsonl" }), /UNSUPPORTED_PROJECT_LOCATION/);
	const entry = catalog.listEntries()[0];
	assert.equal(entry.filePath, undefined);
	assert.deepEqual(plain(entry.locator), { kind: "ssh", hostId: HOST_A, remoteSessionId: REMOTE_ID, remotePath: REMOTE_PATH });
});

test("非法 hostId：稳定码拒绝且零写入（这条写入路径不得落下伪身份）", async (t) => {
	const catalog = await makeCatalog(t);
	const draft = await catalog.createDraft({ projectId: "project-a", title: "新会话", environment: "native" });

	await assert.rejects(() => catalog.attachRuntime({ sessionId: draft.id, remoteLocator: { kind: "ssh", hostId: "not-a-host-id", remotePath: REMOTE_PATH } }), /REMOTE_SESSION_IDENTITY_INVALID/);
	const entry = catalog.listEntries()[0];
	assert.equal(entry.locator, undefined);
	assert.equal(entry.filePath, undefined);
	assert.equal(entry.status, "draft");
});
