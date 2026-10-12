import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const model = loadTsCommonJs("src/renderer/src/sessionManagerModel.ts");
const hostId = "11111111-1111-4111-8111-111111111111";
function remoteProject(id) {
	return { id, name: id, locator: { kind: "ssh", hostId, remotePath: "/work/shared" } };
}
function archived(id, projectId) {
	return { archivedRemoteSessionId: id, summary: { id, projectId, filePath: "", name: id, preview: "", updatedAt: 1, messageCount: 0 } };
}

test("remote archives belong to the exact catalog project, not a local path or another host's identical path", () => {
	const own = archived("own", "remote-a");
	const other = archived("other", "remote-b");
	const missingProject = archived("missing", undefined);
	assert.equal(
		model
			.filterArchivedPiByFamily([own, other, missingProject], [remoteProject("remote-a")])
			.map((item) => item.summary.id)
			.join(","),
		"own",
	);
	assert.equal(model.filterArchivedPiByFamily([own], [{ id: "local", name: "local", path: "/work/shared" }]).length, 0);
});

test("remote worktree archive label uses project identity without requiring originalPath", () => {
	const root = remoteProject("root");
	const child = { ...remoteProject("child"), worktreeParentId: root.id, name: "feature" };
	assert.equal(model.archivedPiWorkspaceLabel(archived("child-session", "child"), [root, child]), "feature");
	assert.equal(model.archivedPiWorkspaceLabel(archived("root-session", "root"), [root, child]), undefined);
});

test("file-backed SSH sessions appear in the manager but remote drafts do not", () => {
	const session = archived("remote", "remote-a").summary;
	assert.equal(model.isManagerSessionSummary({ ...session, locator: { kind: "ssh", hostId, remoteSessionId: "ws/session.jsonl" } }), true);
	assert.equal(model.isManagerSessionSummary({ ...session, locator: { kind: "ssh", hostId } }), false);
});

test("catalog summary projection preserves SSH identity for the real manager input", () => {
	const { sessionRecordToSummary } = loadTsCommonJs("src/renderer/src/atoms/session-selectors.ts", { stubs: { "./session-atoms": {} } });
	const locator = { kind: "ssh", hostId, remoteSessionId: "ws/session.jsonl", remotePath: "/sessions/ws/session.jsonl" };
	const record = { id: "remote", projectId: "remote-a", title: "Remote", locator, source: "pi", environment: "native", preview: "", messageCount: 2, status: "active", createdAt: 1, updatedAt: 1 };
	const summary = sessionRecordToSummary(record);
	assert.equal(summary.locator?.kind, "ssh");
	assert.equal(summary.locator?.remoteSessionId, locator.remoteSessionId);
	assert.equal(summary.filePath, "");
	assert.equal(model.isManagerSessionSummary(summary), true);
});

test("remote archived rows are not eligible for single or bulk permanent deletion", () => {
	const remote = { kind: "pi", item: archived("remote", "remote-a") };
	const local = { kind: "pi", item: { summary: { ...archived("local", "local").summary, filePath: "/archive/local.jsonl" }, originalPath: "/local.jsonl" } };
	const dsh = { kind: "dsh", item: { dshSessionId: "dsh", cwd: "/work", archivedAt: 1 } };
	assert.equal(model.canDeleteManagerArchivedRow(remote), false);
	assert.equal(model.canDeleteManagerArchivedRow(local), true);
	assert.equal(model.canDeleteManagerArchivedRow(dsh), true);
});

const { restoreArchivedPiSession } = loadTsCommonJs("src/renderer/src/utils/sessionArchiveActions.ts");

test("restore routes remote catalog ID and local archive path through distinct preload methods", async () => {
	const calls = [];
	const ports = {
		unarchiveRemoteRecord: async (id) => {
			calls.push(["remote", id]);
			return true;
		},
		unarchiveRecord: async (path) => {
			calls.push(["local", path]);
			return true;
		},
	};
	await restoreArchivedPiSession(archived("remote-id", "remote-a"), ports);
	await restoreArchivedPiSession({ summary: { ...archived("local-id", "local").summary, filePath: "/archive/local.jsonl" }, originalPath: "/local.jsonl" }, ports);
	assert.deepEqual(calls, [
		["remote", "remote-id"],
		["local", "/archive/local.jsonl"],
	]);
});

test("failed remote restore never falls back to local filesystem restore", async () => {
	let localCalls = 0;
	await assert.rejects(
		restoreArchivedPiSession(archived("remote-id", "remote-a"), {
			unarchiveRemoteRecord: async () => {
				throw new Error("REMOTE_SESSION_ARCHIVE_COMMAND_FAILED");
			},
			unarchiveRecord: async () => {
				localCalls += 1;
				return true;
			},
		}),
		/REMOTE_SESSION_ARCHIVE_COMMAND_FAILED/,
	);
	assert.equal(localCalls, 0);
});

test("archive UI applies the deletion policy at single-row, selection and final execution boundaries", () => {
	const source = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
	assert.match(source, /canDeleteManagerArchivedRow\(row\)\s*&&\s*\([\s\S]{0,500}?setPendingDeleteArchived\(\[row\]\)/);
	assert.match(source, /disabled=\{!canDeleteManagerArchivedRow\(row\)\}/);
	assert.match(source, /deletableArchivedRows\.map\(managerArchivedRowKey\)/);
	assert.match(source, /pending\.filter\(canDeleteManagerArchivedRow\)\.map/);
	assert.match(source, /props\.onUnarchive\(row\.item\)/);
});
