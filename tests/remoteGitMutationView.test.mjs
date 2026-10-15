import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const target = { projectId: "project", relativePath: "one.txt" };
const resource = { target, path: "one.txt", displayPath: "one.txt", status: 5, letter: "M" };
const snapshot = { head: "a".repeat(40), branch: "main", mutationToken: "b".repeat(32), groups: { merge: [], index: [], workingTree: [resource], untracked: [] } };
function fixture(mutation) {
	const states = [],
		calls = [];
	const controller = createRemoteGitViewController(
		"project",
		"identity",
		{
			cancelRemoteReads: async () => calls.push("cancel"),
			remoteSnapshot: async () => {
				calls.push("read");
				return { ok: true, snapshot };
			},
			workspaceFileDiff: async () => null,
			mutateRemoteIndex: async (...args) => {
				calls.push(args);
				return mutation();
			},
		},
		(state) => states.push(state),
	);
	return { controller, calls, current: () => states.at(-1) };
}

test("remote index view serializes one explicit write, disables refresh, and refreshes only after confirmed success", async () => {
	let resolve;
	const f = fixture(
		() =>
			new Promise((accept) => {
				resolve = accept;
			}),
	);
	await f.controller.refresh();
	const pending = f.controller.mutate("stage", "workingTree", target);
	assert.equal(f.current().mutating, true);
	await f.controller.refresh();
	await f.controller.mutate("stage", "workingTree", target);
	assert.equal(f.calls.length, 2);
	resolve({ ok: true });
	await pending;
	assert.equal(f.calls.filter((call) => call === "read").length, 2);
	assert.deepEqual(f.calls[1], ["project", "stage", "workingTree", target, snapshot.mutationToken]);
});

test("remote index unknown outcome clears grant/facts without read or write replay", async () => {
	const f = fixture(() => ({ ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" }));
	await f.controller.refresh();
	await f.controller.mutate("stage", "workingTree", target);
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(f.current().snapshot, undefined);
	await f.controller.mutate("stage", "workingTree", target);
	assert.equal(f.calls.length, 2);
});

test("remote index view refuses cross-project, wrong group and unobserved targets without writes", async () => {
	const f = fixture(() => ({ ok: true }));
	await f.controller.refresh();
	await f.controller.mutate("stage", "workingTree", { ...target, projectId: "other" });
	await f.controller.mutate("stage", "workingTree", { ...target, relativePath: "outside.txt" });
	await f.controller.mutate("unstage", "workingTree", target);
	assert.deepEqual(f.calls, ["read"]);
});

test("connection loss during write becomes unconfirmed, and late success cannot refresh a new generation", async () => {
	let resolve;
	const f = fixture(
		() =>
			new Promise((accept) => {
				resolve = accept;
			}),
	);
	await f.controller.refresh();
	const pending = f.controller.mutate("stage", "workingTree", target);
	f.controller.invalidateConnection();
	resolve({ ok: true });
	await pending;
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(f.current().snapshot, undefined);
	assert.equal(f.calls.filter((call) => call === "read").length, 1);
});

test("disposing an idle remote index view revokes its issued grant", async () => {
	const f = fixture(() => ({ ok: true }));
	await f.controller.refresh();
	f.controller.dispose();
	assert.deepEqual(f.calls, ["read", "cancel"]);
});
