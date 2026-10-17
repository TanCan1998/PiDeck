import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const target = { projectId: "project", relativePath: "one.txt" };
const resource = { target, path: "one.txt", displayPath: "one.txt", status: 5, letter: "M" };
const snapshot = { head: "a".repeat(40), branch: "main", mutationToken: "b".repeat(32), commitToken: "c".repeat(32), groups: { merge: [], index: [], workingTree: [resource], untracked: [] } };
function fixture(mutation, read = () => ({ ok: true, snapshot }), commitResult = () => ({ ok: true })) {
	const states = [],
		calls = [];
	const controller = createRemoteGitViewController(
		"project",
		"identity",
		{
			cancelRemoteReads: async () => calls.push("cancel"),
			remoteSnapshot: async () => {
				calls.push("read");
				return read();
			},
			workspaceFileDiff: async () => null,
			mutateRemoteIndex: async (...args) => {
				calls.push(args);
				return mutation();
			},
			commitRemote: async (...args) => {
				calls.push(["commit", ...args]);
				return commitResult();
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
	assert.deepEqual(f.calls[1], ["project", "stage", "workingTree", target, snapshot.mutationToken, ""]);
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

test("repeated reconnect/offline events cannot erase an uncertain index-write warning", async () => {
	let resolve;
	const f = fixture(
		() =>
			new Promise((accept) => {
				resolve = accept;
			}),
	);
	await f.controller.refresh();
	const pending = f.controller.mutate("stage", "workingTree", target);
	for (let transition = 0; transition < 4; transition++) {
		f.controller.invalidateConnection();
		assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
		assert.equal(f.current().snapshot, undefined);
	}
	resolve({ ok: true });
	await pending;
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(f.calls.filter((call) => call === "read").length, 1);
	await f.controller.refresh();
	assert.equal(f.current().errorCode, undefined);
	assert.equal(f.current().snapshot.mutationToken, snapshot.mutationToken);
});

test("a failed manual refresh cannot claim to have resolved an uncertain write", async () => {
	let readCount = 0;
	const f = fixture(
		() => ({ ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" }),
		() => (++readCount === 1 ? { ok: true, snapshot } : { ok: false, code: "SSH_HOST_DISCONNECTED" }),
	);
	await f.controller.refresh();
	await f.controller.mutate("stage", "workingTree", target);
	await f.controller.refresh();
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(f.current().snapshot, undefined);
	assert.equal(f.calls.filter((call) => Array.isArray(call)).length, 1);
});

test("disposing an idle remote index view revokes its issued grant", async () => {
	const f = fixture(() => ({ ok: true }));
	await f.controller.refresh();
	f.controller.dispose();
	assert.deepEqual(f.calls, ["read", "cancel"]);
});

test("an explicit commit sends the message verbatim, counts one confirmation and only then re-reads", async () => {
	const f = fixture();
	await f.controller.refresh();
	await f.controller.commit("subject\n\nbody\n");
	assert.deepEqual(
		f.calls.filter((call) => Array.isArray(call)),
		[["commit", "project", "subject\n\nbody\n", "c".repeat(32), ""]],
	);
	assert.equal(f.current().confirmedCommits, 1);
	assert.ok(f.current().mutating !== true, "the in-flight flag must be released once the commit is confirmed");
	assert.equal(f.current().errorCode, undefined);
	assert.equal(f.calls.filter((call) => call === "read").length, 2, "facts come from one fresh read after the confirmation");
});

test("a refused commit drops the facts, reports its own code and is not retried", async () => {
	const codes = ["GIT_COMMIT_IDENTITY_REQUIRED", "GIT_COMMIT_NOTHING_STAGED", "GIT_COMMIT_HEAD_CHANGED"];
	for (const code of codes) {
		const f = fixture(undefined, undefined, () => ({ ok: false, code }));
		await f.controller.refresh();
		await f.controller.commit("subject\n");
		assert.equal(f.current().errorCode, code);
		assert.equal(f.current().snapshot, undefined, "a refusal must not leave stale repository facts");
		assert.equal(f.calls.filter((call) => Array.isArray(call)).length, 1, code + ": never replayed");
	}
});

test("an uncertain commit keeps the warning across reconnects and is cleared only by a fresh read", async () => {
	const f = fixture(undefined, undefined, () => ({ ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" }));
	await f.controller.refresh();
	await f.controller.commit("subject\n");
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	for (let transition = 0; transition < 3; transition++) {
		f.controller.invalidateConnection();
		assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
		assert.equal(f.current().snapshot, undefined);
	}
	await f.controller.commit("subject\n");
	assert.equal(f.calls.filter((call) => Array.isArray(call)).length, 1, "an uncertain commit is never replayed automatically");
	await f.controller.refresh();
	assert.equal(f.current().errorCode, undefined);
	assert.equal(f.current().snapshot.commitToken, snapshot.commitToken);
});

test("a commit whose reply is lost becomes unknown instead of a failure", async () => {
	const f = fixture(undefined, undefined, () => {
		throw new Error("Error invoking remote method 'git:remote-commit'");
	});
	await f.controller.refresh();
	await f.controller.commit("subject\n");
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(f.current().snapshot, undefined);
});

test("an empty message or a missing grant never reaches the commit API", async () => {
	const f = fixture();
	await f.controller.refresh();
	await f.controller.commit("   \n");
	await f.controller.commit("");
	assert.deepEqual(
		f.calls.filter((call) => Array.isArray(call)),
		[],
	);
	const without = fixture(undefined, () => ({ ok: true, snapshot: { ...snapshot, commitToken: undefined } }));
	await without.controller.refresh();
	await without.controller.commit("subject\n");
	assert.deepEqual(
		without.calls.filter((call) => Array.isArray(call)),
		[],
		"a helper without the capability has no commit grant",
	);
});
