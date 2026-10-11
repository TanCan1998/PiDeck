import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const HOST = "11111111-1111-4111-8111-111111111111";
const A = { id: "project-a", name: "Project A", locator: { kind: "ssh", hostId: HOST, remotePath: "/srv/a" } };
const B = { id: "project-b", name: "Project B", locator: { kind: "ssh", hostId: HOST, remotePath: "/srv/b" } };
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { collectRegisteredRemoteSessionIds } = loadTsCommonJs("src/renderer/src/components/session/remoteSessionListState.ts");
const { sessionRecordToSummary } = loadTsCommonJs("src/renderer/src/atoms/session-selectors.ts");

/** Real persisted catalog + real IPC registration; local scanning and runtime attachment are forbidden. */
async function setup(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-catalog-list-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalogPath = join(directory, "session-catalog.json");
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const handlers = new Map();
	const localCalls = [];
	const pushes = [];
	const forbid = (name) => () => {
		localCalls.push(name);
		throw new Error("LOCAL_OPERATION_FOR_REMOTE:" + name);
	};
	const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, app: { getPath: () => directory } },
		},
	});
	registerSessionIpc({
		projectStore: { get: (id) => [A, B].find((p) => p.id === id) },
		sessionCatalog: catalog,
		sessionScanner: { list: forbid("scan"), readRecordMessagePage: forbid("body") },
		settingsStore: { get: forbid("local settings") },
		sessionRuntimeCoordinator: { attachCatalogRuntimes: forbid("runtime attachment") },
		mainCopy: (key) => key,
		getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => pushes.push({ channel, payload }) } }),
	});
	const list = (projectId, options) => handlers.get(ipcChannels.sessionsCatalogList)({}, projectId, options);
	const register = (projectId, remoteSessionId) =>
		catalog.ensureRemoteSession({
			projectId,
			hostId: HOST,
			remoteSessionId,
			remotePath: remoteSessionId,
			title: remoteSessionId
				.split("/")
				.pop()
				.replace(/\.jsonl$/, ""),
			updatedAt: 1700000000000,
		});
	return { catalog, catalogPath, register, list, localCalls, pushes, ticks: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("remote import -> catalog IPC -> imported badge and sidebar row preserves stable identity", async (t) => {
	const h = await setup(t);
	const id = "--srv-a--/imported.jsonl";
	const imported = await h.register(A.id, id);
	await h.register(B.id, "--srv-b--/other.jsonl");
	const before = await readFile(h.catalogPath, "utf8");
	// Use the production refresh hook, with only React rendering hosted by the existing deterministic harness.
	const hookHost = quickMessageHookHost();
	t.after(() => hookHost.unmount());
	const { useProjectSync } = loadTsCommonJs("src/renderer/src/hooks/useProjectSync.ts", { stubs: { react: hookHost.react } });
	let records = [];
	let loadState;
	const sync = hookHost.render(() =>
		useProjectSync({
			projects: [A, B],
			activeProjectId: A.id,
			setProjects: () => {},
			setActiveProjectId: () => {},
			showToast: () => {},
			t: (key) => key,
			replaceProjectSessions: (input) => {
				assert.equal(input.projectId, A.id);
				records = input.sessions;
			},
			setSessionCatalogLoadState: (input) => {
				loadState = input.state;
			},
			api: { sessions: { listCatalog: h.list } },
		}),
	);
	await sync.refreshProjectSessions(A.id, true);
	assert.equal(loadState.status, "ready");
	assert.equal(records.length, 1);
	assert.equal(records[0].id, imported.record.id);
	assert.equal(records[0].projectId, A.id);
	assert.equal(records[0].locator.remoteSessionId, id);
	assert.equal(records[0].filePath, undefined, "remote path must never be exposed as a local file path");
	assert.equal(collectRegisteredRemoteSessionIds(records, HOST).has(id), true, "the imported badge uses the returned catalog records");
	const row = sessionRecordToSummary(records[0]);
	assert.ok(row, "an imported SSH record must not disappear from the sidebar because it has no local file");
	assert.equal(row.id, imported.record.id);
	assert.equal(row.name, "imported");
	assert.equal(row.filePath, "", "do not fabricate a local path to make the row visible");
	const second = await h.register(A.id, id);
	assert.equal(second.created, false);
	assert.equal(second.record.id, row.id);
	assert.equal((await h.list(A.id, { scan: false })).length, 1);
	assert.equal(await readFile(h.catalogPath, "utf8"), before, "listing and idempotent registration must not rewrite the catalog");
	assert.deepEqual(h.localCalls, [], "catalog metadata reading must never invoke local scanning/body/runtime paths");
});

test("remote catalog list is read-only even when scan is requested, and never mixes neighboring projects", async (t) => {
	const h = await setup(t);
	await h.register(B.id, "--srv-b--/neighbor.jsonl");
	assert.equal((await h.list(A.id)).length, 0);
	assert.equal((await h.list(A.id, { scan: true })).length, 0);
	assert.equal((await h.list(A.id, { scan: false })).length, 0);
	assert.equal((await h.list(B.id)).length, 1);
	await assert.rejects(() => h.list("missing"), /project.notFound/);
	assert.deepEqual(h.localCalls, []);
});

test("a remote catalog read notifies the renderer exactly once, and the silent re-pull never loops", async (t) => {
	const h = await setup(t);
	await h.list(A.id);
	await h.ticks();
	assert.deepEqual(
		h.pushes.map((entry) => entry.channel),
		[ipcChannels.sessionsCatalogRefreshed],
	);
	// 跨 VM realm 的对象原型不同，deepEqual 会误判；只断言字段。
	assert.equal(h.pushes[0].payload.projectId, A.id, "the push must name the project whose loading state is waiting");
	// 渲染层收到推送后会以 scan:false 静默回拉；对它再推送一次就会自激成环。
	await h.list(A.id, { scan: false });
	await h.ticks();
	assert.equal(h.pushes.length, 1);
	// 本机项目仍走原路径：这条远端分支不得抢走它的后台扫描推送语义。
	await h.list(A.id, { scan: true });
	await h.ticks();
	assert.equal(h.pushes.length, 2);
	assert.deepEqual(h.localCalls, []);
});

test("SSH sidebar projection needs no local path, but local pathless pi records still stay hidden", () => {
	const base = { id: "s", projectId: A.id, title: "Remote session", source: "pi", environment: "native", status: "active", createdAt: 1, updatedAt: 1, preview: "", messageCount: 0 };
	assert.equal(sessionRecordToSummary(base), undefined);
	const summary = sessionRecordToSummary({ ...base, locator: { kind: "ssh", hostId: HOST, remoteSessionId: "--srv-a--/session.jsonl", remotePath: "--srv-a--/session.jsonl" } });
	assert.ok(summary);
	assert.equal(summary.id, base.id);
	assert.equal(summary.filePath, "");
	const { getProjectAgentSessionDisplay } = loadTsCommonJs("src/renderer/src/agentListDisplay.ts");
	const another = sessionRecordToSummary({ ...base, id: "s-2", locator: { kind: "ssh", hostId: HOST, remoteSessionId: "--srv-a--/second.jsonl" } });
	const display = getProjectAgentSessionDisplay({ agents: [], sessions: [summary, another] });
	assert.equal(display.children.length, 2, "two pathless remote records must not collapse into one sidebar row");
	assert.deepEqual(new Set(display.children.map((child) => child.session.id)), new Set(["s", "s-2"]));
});
