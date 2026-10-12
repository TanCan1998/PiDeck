import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createAgentSessionReplacer } = loadTsCommonJs("src/main/sessions/agentSessionReplacement.ts");
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { SessionRuntimeCoordinator } = loadTsCommonJs("src/main/sessions/SessionRuntimeCoordinator.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Real catalog/coordinator isolate the extracted local policy from process spawning. */
async function setup(t) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-local-replacement-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const catalog = new SessionCatalog(join(dir, "catalog.json"));
	await catalog.load();
	const origin = await catalog.ensureRuntimeTarget({ projectId: "project-1", title: "Origin", source: "pi", environment: "wsl", filePath: "/home/dev/sessions/old.jsonl", wslDistro: "Ubuntu", wslUser: "dev", piSessionId: "pi-old" });
	const oldEntry = plain(catalog.get(origin.id));
	const tab = { id: "agent-1", projectId: "project-1", deckSessionId: origin.id, title: "Origin", status: "idle", createdAt: 1, sessionPath: origin.filePath, sessionId: "pi-old", sessionSource: "pi", sessionEnvironment: "wsl", wslDistro: "Ubuntu", wslUser: "dev" };
	const renames = [];
	const agents = {
		list: () => [tab],
		rename: async (id, title) => {
			renames.push({ id, title });
			tab.title = title;
			return tab;
		},
	};
	const coordinator = new SessionRuntimeCoordinator(catalog, agents, async () => ({ accepted: true }));
	coordinator.bindExistingAgent(origin.id, tab.id);
	const events = [];
	const replace = createAgentSessionReplacer({
		agentManager: agents,
		sessionCatalog: catalog,
		sessionRuntimeCoordinator: coordinator,
		appLogger: { warn: () => undefined },
		forkedSuffix: () => "(fork)",
		resolveProjectLocator: () => undefined,
		onDetached: () => events.push("detach"),
		onAttached: () => events.push("attach"),
		onRestored: () => events.push("restore"),
	});
	return { catalog, coordinator, origin, oldEntry, tab, renames, events, replace };
}

for (const operation of ["fork", "clone", "switch"]) {
	test(`extracted local ${operation} preserves WSL identity and suffix/metadata policy`, async (t) => {
		const h = await setup(t);
		const result = await h.replace(
			h.tab.id,
			async () => {
				h.tab.sessionPath = "/home/dev/sessions/new.jsonl";
				h.tab.sessionId = "pi-new";
				return { cancelled: false, text: "selected" };
			},
			{ markForked: operation !== "switch" },
		);
		const target = h.catalog.get(result.targetSessionId);
		assert.notEqual(target.id, h.origin.id);
		assert.equal(target.locator.kind, "local");
		assert.equal(target.filePath, h.tab.sessionPath);
		assert.equal(target.environment, "wsl");
		assert.equal(target.wslDistro, "Ubuntu");
		assert.equal(target.wslUser, "dev");
		assert.equal(target.piSessionId, "pi-new");
		assert.equal(target.title, operation === "switch" ? "Origin" : "Origin (fork)");
		assert.equal(target.forked, operation === "switch" ? false : true);
		assert.equal(h.renames.length, operation === "switch" ? 0 : 1);
		assert.deepEqual(plain(h.catalog.get(h.origin.id)), h.oldEntry);
		assert.deepEqual(h.events, ["detach", "attach"]);
		assert.equal(h.coordinator.getSessionId(h.tab.id), target.id);
		assert.equal(h.tab.deckSessionId, target.id);
		assert.equal(result.text, "selected");
	});
}

test("extracted local cancellation keeps result fields and original identity", async (t) => {
	const h = await setup(t);
	const result = await h.replace(h.tab.id, async () => ({ cancelled: true, text: "kept" }), { markForked: true });
	assert.deepEqual(plain(result), { cancelled: true, text: "kept" });
	assert.equal(h.coordinator.getSessionId(h.tab.id), h.origin.id);
	assert.deepEqual(h.events, ["detach", "restore"]);
	assert.deepEqual(h.renames, []);
	assert.deepEqual(plain(h.catalog.get(h.origin.id)), h.oldEntry);
});

for (const changed of [false, true]) {
	test(`extracted local failure ${changed ? "after identity change fails closed" : "before change restores origin"}`, async (t) => {
		const h = await setup(t);
		await assert.rejects(
			h.replace(h.tab.id, async () => {
				if (changed) h.tab.sessionPath = "/home/dev/sessions/new.jsonl";
				throw new Error("REPLACEMENT_FAILED");
			}),
			/REPLACEMENT_FAILED/,
		);
		assert.equal(h.coordinator.getSessionId(h.tab.id), changed ? undefined : h.origin.id);
		assert.deepEqual(h.events, changed ? ["detach"] : ["detach", "restore"]);
		assert.deepEqual(plain(h.catalog.get(h.origin.id)), h.oldEntry);
	});
}

test("unbound local runtime retains payload without creating catalog targets", async (t) => {
	const h = await setup(t);
	h.coordinator.unbindAgent(h.tab.id);
	const result = await h.replace(h.tab.id, async () => ({ text: "external" }));
	assert.deepEqual(plain(result), { text: "external" });
	assert.equal(h.catalog.listEntries().length, 1);
	assert.deepEqual(h.events, []);
});
