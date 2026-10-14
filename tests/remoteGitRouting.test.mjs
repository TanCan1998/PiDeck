import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const projectId = "remote-project";
const target = { projectId, relativePath: "file.txt" };

/** Run real registered Git handlers; every attempted local fs/process/service call is a hard failure. */
function fixture() {
	const handlers = new Map();
	const calls = [];
	const forbidden = new Proxy(
		{},
		{
			get: (_object, name) => () => {
				calls.push(String(name));
				throw new Error("LOCAL_OPERATION_FORBIDDEN");
			},
		},
	);
	const { registerGitIpc } = loadTsCommonJs("src/main/ipc/gitIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, dialog: forbidden, app: { getPath: () => "/unused" } },
			"node:fs/promises": forbidden,
			"node:child_process": forbidden,
		},
	});
	const groups = { merge: [], index: [], workingTree: [], untracked: [] };
	const diff = { target, path: "file.txt", displayPath: "file.txt", originalContent: "old", modifiedContent: "new" };
	const remoteCalls = [];
	registerGitIpc({
		appLogger: forbidden,
		mainCopy: (key) => key,
		gitService: forbidden,
		gitRefsWatcher: { on: () => undefined, acquire: forbidden.acquire, release: forbidden.release },
		getMainWindow: () => null,
		piLocator: forbidden,
		projectStore: { get: (id) => (id === projectId ? { id, locator: { kind: "ssh", hostId: "host", remotePath: "/not-a-local-path" } } : undefined) },
		settingsStore: forbidden,
		worktreeService: forbidden,
		remoteGitReads: {
			status: async (...args) => {
				remoteCalls.push(["status", ...args]);
				return groups;
			},
			workspaceDiff: async (...args) => {
				remoteCalls.push(["diff", ...args]);
				return diff;
			},
		},
	});
	return { handlers, calls, remoteCalls, groups, diff, event: { sender: { id: 1 } } };
}

test("existing status/diff IPC selects SSH reads before local repository/fs/executable parsing", async () => {
	const f = fixture();
	assert.equal(await f.handlers.get(ipcChannels.gitStatus)(f.event, projectId), f.groups);
	assert.equal(await f.handlers.get(ipcChannels.gitWorkspaceFileDiff)(f.event, projectId, "workingTree", target), f.diff);
	assert.deepEqual(f.calls, []);
	assert.deepEqual(
		f.remoteCalls.map((call) => call[0]),
		["status", "diff"],
	);
});

test("all unsupported project Git operations reject SSH with zero local work and zero remote writes", async () => {
	const f = fixture();
	const argumentsByChannel = new Map([
		["gitListRepos", [projectId]],
		["gitBranches", [projectId]],
		["gitCheckout", [projectId, "main"]],
		["gitCreateBranch", [projectId, "new"]],
		["gitOriginalContent", [target]],
		["gitWorktreeList", [projectId]],
		["gitWorktreeCreate", [projectId, "new"]],
		["gitWorktreeRemove", [projectId, { projectId: "child", relativePath: "" }]],
		["gitCommitLog", [projectId]],
		["gitCommitCount", [projectId]],
		["gitRefs", [projectId]],
		["gitBranchCompare", [projectId, "main", "other"]],
		["gitCommitDetail", [projectId, "a".repeat(40)]],
		["gitCommitFileDiff", [projectId, "a".repeat(40), target]],
		["gitDiffFileBetween", [projectId, "main", "other", target]],
		["gitStage", [projectId, [target]]],
		["gitUnstage", [projectId, [target]]],
		["gitDiscard", [projectId, "workingTree", target]],
		["gitDiscardFiles", [projectId, [{ group: "workingTree", target }]]],
		["gitDeleteFiles", [projectId, [target]]],
		["gitCommit", [projectId, "message"]],
		["gitCherryPick", [projectId, "a".repeat(40)]],
		["gitRevert", [projectId, "a".repeat(40)]],
		["gitPush", [projectId]],
		["gitPull", [projectId]],
		["gitReset", [projectId, "a".repeat(40), "mixed"]],
		["gitDropCommit", [projectId, "a".repeat(40)]],
		["gitGenerateCommitMessage", [projectId]],
		["gitInit", [projectId]],
		["gitFetch", [projectId]],
		["gitAheadBehind", [projectId]],
		["gitWatchRefs", [projectId]],
	]);
	for (const [key, args] of argumentsByChannel) {
		const handler = f.handlers.get(ipcChannels[key]);
		assert.equal(typeof handler, "function", key);
		await assert.rejects(handler(f.event, ...args), (error) => /(?:UNSUPPORTED|WORKTREE_TARGET_NOT_OWNED_BY_PROJECT)/.test(error.message), key);
	}
	assert.deepEqual(f.calls, []);
	assert.deepEqual(f.remoteCalls, []);
});
