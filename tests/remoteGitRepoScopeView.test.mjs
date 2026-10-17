import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * G5d read-only repository scope at the view layer. The controller is created per selected repository, so every read
 * call has to name it: a single missed argument would silently read the project-root repository under a nested scope.
 * The tests below assert the exact argument on every read path, that writes never carry a scope, and that a nested
 * scope never offers init. The panel/hook source scans pin the selector, the read-only note and the four-layer wiring.
 */

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const projectId = "project";
const scoped = "packages/nested";
const oid = (char) => char.repeat(40);
const target = { projectId, relativePath: "tracked.txt" };
const snapshot = { head: oid("a"), branch: "main", groups: { merge: [], index: [], workingTree: [], untracked: [] } };
const page = { commits: [{ oid: oid("a"), parents: [], authorName: "A", authorEmail: "a@e.invalid", authorTimeSec: 1700000000, subject: "one" }], hasMore: true };
const detail = { oid: oid("a"), parents: [oid("b")], authorName: "A", authorEmail: "a@e.invalid", authorTimeSec: 1700000000, committerName: "A", committerEmail: "a@e.invalid", committerTimeSec: 1700000000, subject: "s", message: "s\n", files: [{ status: "M", path: "tracked.txt" }] };
const refs = { head: oid("a"), branch: "main", refs: [{ fullName: "refs/heads/main", name: "main", oid: oid("a"), kind: "branch" }] };
const compare = { base: { ref: "refs/heads/main", oid: oid("a") }, head: { ref: "refs/tags/v1", oid: oid("b") }, files: [{ status: "M", path: "tracked.txt" }] };
const recoveryEntry = { ref: "refs/pideck/recovery/20261017120000-ab12cd34", oid: oid("c"), path: "tracked.txt", bytes: 10, at: 1792138005 };
const syncFacts = { branch: "main", upstream: null, ahead: 0, behind: 0, remotes: ["origin"] };
const plain = (value) => JSON.parse(JSON.stringify(value));

/** One controller per scope: every read fake records its full argument list. */
function fixture(repoPath = scoped, api = {}) {
	const states = [];
	const calls = [];
	const record = (name, args) => {
		calls.push([name, ...args]);
	};
	const controller = createRemoteGitViewController(
		projectId,
		"identity",
		{
			cancelRemoteReads: async () => {},
			remoteSnapshot: async (...args) => {
				record("snapshot", args);
				return { ok: true, snapshot };
			},
			workspaceFileDiff: async (...args) => {
				record("workspaceDiff", args);
				return { path: target.relativePath, target, displayPath: target.relativePath, originalContent: "old", modifiedContent: "new" };
			},
			remoteLog: async (...args) => {
				record("log", args);
				return { ok: true, page };
			},
			remoteCommitDetail: async (...args) => {
				record("detail", args);
				return { ok: true, detail: { ...detail, oid: args[1] } };
			},
			remoteRefs: async (...args) => {
				record("refs", args);
				return { ok: true, refs };
			},
			remoteRefFileDiff: async (...args) => {
				record("refFileDiff", args);
				return { ok: true, diff: { path: target.relativePath, target, displayPath: target.relativePath, base: args[1], head: args[2], originalContent: "old", modifiedContent: "new" } };
			},
			remoteCompare: async (...args) => {
				record("compare", args);
				return { ok: true, compare };
			},
			recoveryList: async (...args) => {
				record("recoveryList", args);
				return { ok: true, entries: [recoveryEntry], truncated: false };
			},
			syncFacts: async (...args) => {
				record("syncFacts", args);
				return { ok: true, facts: syncFacts };
			},
			...api,
		},
		(state) => states.push(state),
		repoPath,
	);
	return { controller, calls, states, current: () => states.at(-1) };
}

async function driveAllReads(f) {
	await f.controller.refresh();
	await f.controller.openDiff("workingTree", target);
	await f.controller.loadHistory();
	await f.controller.loadMoreHistory();
	await f.controller.openCommitDetail(oid("a"));
	await f.controller.loadRefs();
	await f.controller.pollRefs();
	await f.controller.runCompare("refs/heads/main", "refs/tags/v1");
	await f.controller.openHistoryFileDiff(oid("a"), oid("b"), target);
	await f.controller.loadRecovery();
	await f.controller.loadSync();
}

test("every read path names the selected repository scope", async () => {
	const f = fixture(scoped);
	await driveAllReads(f);
	const byName = new Map();
	for (const [name, ...args] of f.calls) {
		if (!byName.has(name)) byName.set(name, []);
		byName.get(name).push(args);
	}
	// The controller is created per scope, so it must name it on every read; a missing one silently reads the root.
	const scopeIndex = { snapshot: 1, log: 2, detail: 2, refs: 1, compare: 3, recoveryList: 1, syncFacts: 1 };
	for (const [name, index] of Object.entries(scopeIndex)) {
		assert.ok(byName.has(name), name + " must be read by the driven actions");
		for (const args of byName.get(name)) assert.equal(args[index], scoped, name + " must carry the repository scope");
	}
	// The workspace diff rides the legacy local-shaped channel: its scope is the ProjectFileTarget of the repository.
	for (const args of byName.get("workspaceDiff")) assert.deepEqual(plain(args[3]), { projectId, relativePath: scoped }, "workspaceDiff must scope the repository");
	// The per-file revision diff names the scope right after the file target.
	for (const args of byName.get("refFileDiff")) {
		assert.deepEqual(plain(args[3]), target, "refFileDiff keeps the file target in place");
		assert.equal(args[4], scoped, "refFileDiff must carry the repository scope");
	}
	// The refs reads happen at least twice (manual + quiet poll) and both are scoped.
	assert.ok(byName.get("refs").length >= 2, "manual and polled refs reads both run");
	// Root scope keeps the exact pre-G5d calls: an empty string is still passed by this controller, never dropped.
	const root = fixture("");
	await driveAllReads(root);
	for (const [name, ...args] of root.calls) {
		if (name === "workspaceDiff") assert.equal(args[3], undefined, "the root workspace diff passes no repo target");
		else if (name === "refFileDiff") assert.equal(args[4], "", "the root per-file diff passes the root scope");
		else if (name === "log" || name === "detail") assert.equal(args[2], "", name + " must pass the root scope explicitly");
		else if (name === "compare") assert.equal(args[3], "", "the root compare passes the root scope");
		else assert.equal(args[1], "", name + " must pass the root scope explicitly");
	}
});

test("a nested scope still never offers the explicit init", async () => {
	const calls = [];
	const f = fixture(scoped, {
		remoteSnapshot: async () => ({ ok: false, code: "GIT_NOT_REPOSITORY" }),
		initRemote: async (...args) => {
			calls.push(["init", ...args]);
			return { ok: true, branch: "main" };
		},
	});
	await f.controller.refresh();
	assert.equal(await f.controller.initRepository(), false, "a nested scope must not report a successful init");
	assert.equal(calls.length, 0, "a nested scope must never call initRemote");
});

const writeTokens = { mutationToken: "m".repeat(32), commitToken: "c".repeat(32), branchToken: "b".repeat(32), switchToken: "s".repeat(32), discardToken: "d".repeat(32), restoreToken: "r".repeat(32), dropToken: "p".repeat(32), fetchToken: "f".repeat(32), pushToken: "u".repeat(32), pullToken: "l".repeat(32) };
const tokenSnapshot = { ...snapshot, ...writeTokens, groups: { ...snapshot.groups, workingTree: [{ path: target.relativePath, target, displayPath: target.relativePath, status: 5, letter: "M" }] } };

/** Drive all ten write APIs through one controller and record the full argument list each fake receives. */
async function driveWrites(repoPath) {
	const writes = [];
	const record =
		(name) =>
		async (...args) => {
			writes.push([name, ...args]);
			if (name === "discard") return { ok: true, recoveryRef: "refs/pideck/recovery/x" };
			if (name === "restore") return { ok: true, path: target.relativePath, bytes: 1 };
			if (name === "fetch") return { ok: true, outcome: { upToDate: true, updated: [] } };
			if (name === "push") return { ok: true, outcome: { outcome: "up-to-date", refspec: "refs/heads/main:refs/heads/main" } };
			if (name === "pull") return { ok: true, outcome: { mode: "up-to-date", head: oid("a") } };
			return { ok: true };
		};
	const f = fixture(repoPath, {
		remoteSnapshot: async () => ({ ok: true, snapshot: tokenSnapshot }),
		mutateRemoteIndex: record("mutate"),
		commitRemote: record("commit"),
		createRemoteBranch: record("create"),
		switchRemoteBranch: record("switch"),
		discardRemote: record("discard"),
		recoveryRestore: record("restore"),
		recoveryDrop: record("drop"),
		fetchRemote: record("fetch"),
		pushRemote: record("push"),
		pullRemote: record("pull"),
	});
	await f.controller.refresh();
	await f.controller.loadSync();
	await f.controller.mutate("stage", "workingTree", target);
	await f.controller.loadSync();
	await f.controller.commit("message");
	await f.controller.loadSync();
	await f.controller.createBranch("feature");
	await f.controller.loadSync();
	await f.controller.switchBranch("feature");
	await f.controller.loadSync();
	await f.controller.discard("workingTree", target);
	await f.controller.loadSync();
	await f.controller.restoreRecovery(recoveryEntry);
	await f.controller.loadSync();
	await f.controller.dropRecovery(recoveryEntry);
	await f.controller.loadSync();
	await f.controller.fetch("origin");
	await f.controller.loadSync();
	await f.controller.push("origin", "main");
	await f.controller.loadSync();
	await f.controller.pull("origin", "main");
	return writes;
}

/** The exact shape each write API is called with: the repository scope is always the trailing argument. */
function expectedWriteCalls(scope) {
	return [
		["mutate", projectId, "stage", "workingTree", target, "m".repeat(32), scope],
		["commit", projectId, "message", "c".repeat(32), scope],
		["create", projectId, "feature", "b".repeat(32), scope],
		["switch", projectId, "feature", "s".repeat(32), scope],
		["discard", projectId, "workingTree", target, "d".repeat(32), scope],
		["restore", projectId, recoveryEntry.ref, recoveryEntry.oid, recoveryEntry.path, "r".repeat(32), scope],
		["drop", projectId, recoveryEntry.ref, recoveryEntry.oid, "p".repeat(32), scope],
		["fetch", projectId, "origin", "f".repeat(32), scope],
		["push", projectId, "origin", "main", "u".repeat(32), scope],
		["pull", projectId, "origin", "main", "l".repeat(32), scope],
	];
}

test("every write API receives the controller's exact repository scope", async () => {
	assert.deepEqual(plain(await driveWrites(scoped)), expectedWriteCalls(scoped), "a nested controller must name its repository on every write");
	// A root controller still sends the empty string explicitly: never undefined, so a missing argument cannot silently
	// mean the root repository.
	assert.deepEqual(plain(await driveWrites("")), expectedWriteCalls(""), "a root controller must name the root scope explicitly");
});

test("the panel exposes the scope selector and keeps init root-only", () => {
	const panel = readFileSync("src/renderer/src/components/workspace/RemoteGitPanel.tsx", "utf8");
	for (const id of ["remote-git-repo-scope", "remote-git-repo-select", "remote-git-repos-truncated"]) assert.match(panel, new RegExp('data-testid="' + id + '"'), id);
	assert.ok(!panel.includes("remote-git-repo-readonly-note"), "the G5d read-only note is gone: a nested scope writes its own repository");
	assert.ok(!panel.includes("remoteGit.repoReadOnlyNote"), "no dictionary key for a removed note may remain in the panel");
	assert.match(panel, /useRemoteGitView\(project, repoPath\)/, "the selected scope must key the controller");
	assert.match(panel, /repos\.length > 1[\s\S]{0,120}?!rootRepoPresent/, "the selector is shown for multi-repo projects and rootless nested ones");
	// The write controls depend on the scope-bound grant alone; only init keeps an explicit root-only condition (G5e).
	for (const gate of ["canCommit", "canCreateBranch", "canSwitchBranch", "canDiscard", "canRestore", "canDrop", "canFetch", "canPush", "canPull"]) {
		assert.match(panel, new RegExp("const " + gate + " = (?! !nested)"), gate + " exists");
		assert.ok(!new RegExp("const " + gate + " = !nested").test(panel), gate + " must not be disabled for a nested scope");
	}
	assert.ok(!/disabled=\{nested \|\|/.test(panel), "no write control may still be disabled by the nested flag");
	assert.match(panel, /!nested && \(state\.errorCode === "GIT_NOT_REPOSITORY"/, "init is offered only from the root scope");
	assert.match(panel, /void initRepository\(\)\.then/, "a successful init re-discovers the repository list");
	const hook = readFileSync("src/renderer/src/hooks/useRemoteGitView.ts", "utf8");
	assert.match(hook, /JSON\.stringify\(\[project\.id, project\.locator\.hostId, project\.locator\.remotePath, repoPath\]\)/, "the scope is part of the controller identity key");
	assert.match(hook, /createRemoteGitViewController\(project\.id, projectKey, desktopApi\.git, setState, repoPath\)/);
	assert.match(hook, /\[project\.id, project\.locator\.hostId, projectKey, repoPath\]/, "switching scope disposes the old controller");
	const reposHook = readFileSync("src/renderer/src/hooks/useRemoteGitRepos.ts", "utf8");
	assert.match(reposHook, /desktopApi\.git\.remoteRepos\(project\.id\)/, "discovery goes through the preload API");
	assert.ok(!/remoteSnapshot|loadSync/.test(reposHook), "discovery never reads repository facts or sync facts");
});

test("the repository-scope API is wired through all four layers and the dictionaries", () => {
	assert.match(readFileSync("src/shared/ipc.ts", "utf8"), /gitRemoteRepos:\s*"git:remote-repos"/);
	assert.match(readFileSync("src/main/ipc/remoteGitReadIpc.ts", "utf8"), /ipcMain\.handle\(ipcChannels\.gitRemoteRepos/);
	assert.match(readFileSync("src/preload/index.ts", "utf8"), /remoteRepos:\s*\(projectId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.gitRemoteRepos/);
	assert.match(readFileSync("src/renderer/src/previewApi.ts", "utf8"), /remoteRepos:\s*async \(\) => \(\{ ok: false, code: "REMOTE_FEATURE_DISABLED" \}\)/);
	// Read channels carry a trailing repo argument in preload; write channels carry one too since G5e.
	const preload = readFileSync("src/preload/index.ts", "utf8");
	for (const signature of [
		"remoteSnapshot: (projectId: string, repo?: string)",
		"remoteLog: (projectId: string, options?: { maxCount?: number; skip?: number }, repo?: string)",
		"remoteCommitDetail: (projectId: string, oid: string, repo?: string)",
		"remoteRefs: (projectId: string, repo?: string)",
		"remoteRefFileDiff: (projectId: string, base: string | null, head: string, target: ProjectFileTarget, repo?: string)",
		"remoteCompare: (projectId: string, base: string, head: string, repo?: string)",
		"recoveryList: (projectId: string, repo?: string)",
		"syncFacts: (projectId: string, repo?: string)",
	])
		assert.ok(preload.includes(signature), signature);
	// The write channels keep their existing arguments and append the scope after the token (or after all args).
	assert.match(preload, /commitRemote: \(projectId: string, message: string, token: string, repo\?: string\)/, "commit appends the scope after the token");
	assert.match(preload, /mutateRemoteIndex: \(projectId: string, operation: "stage" \| "unstage", group: import\("\.\.\/shared\/types"\)\.GitResourceGroupType, target: ProjectFileTarget, token: string, repo\?: string\)/, "index mutations append the scope after the token");
	for (const name of ["createRemoteBranch", "switchRemoteBranch", "discardRemote", "recoveryRestore", "recoveryDrop", "fetchRemote", "pushRemote", "pullRemote"]) assert.match(preload, new RegExp(name + ": \\([^)]*token: string, repo\\?: string\\)"), name + " appends the scope after the token");
	const ipc = readFileSync("src/main/ipc/remoteGitReadIpc.ts", "utf8");
	for (const channel of ["gitRemoteMutateIndex", "gitRemoteCommit", "gitRemoteCreateBranch", "gitRemoteSwitchBranch", "gitRemoteDiscard", "gitRemoteRecoveryRestore", "gitRemoteRecoveryDrop", "gitRemoteFetch", "gitRemotePush", "gitRemotePull"]) {
		const at = ipc.indexOf("ipcChannels." + channel + ", async (");
		assert.ok(at >= 0, channel + " is registered");
		assert.ok(ipc.slice(at, at + 900).includes("token: unknown, repo: unknown"), channel + " must take the trailing scope after the token");
	}
	const zh = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const en = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	for (const key of ["remoteGit.repoScope", "remoteGit.repoScopeRoot", "remoteGit.repoReposTruncated", "remoteGit.repoNotFound"]) {
		assert.equal(typeof zh[key], "string", key + " zh");
		assert.equal(typeof en[key], "string", key + " en");
	}
	assert.equal(zh["remoteGit.repoReadOnlyNote"], undefined, "the G5d read-only note key is deleted");
	assert.equal(en["remoteGit.repoReadOnlyNote"], undefined, "the G5d read-only note key is deleted");
});
