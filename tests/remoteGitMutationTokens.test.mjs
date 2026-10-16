import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { createRemoteGitMutationTokens } = loadTsCommonJs("src/main/git/RemoteGitMutationTokens.ts");
const expected = { kind: "index", revision: "a".repeat(64), hostRevision: 7, target: { hostId: "host", remotePath: "/owned/project" } };
const commitExpected = { ...expected, kind: "commit" };

test("index grants are window/project scoped, replaced on refresh, and consumed exactly once", () => {
	const grants = createRemoteGitMutationTokens();
	const first = grants.issue(1, "project", expected),
		next = grants.issue(1, "project", expected);
	assert.throws(() => grants.take(1, "project", "index", first), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	assert.throws(() => grants.take(2, "project", "index", next), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	assert.throws(() => grants.take(1, "other", "index", next), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	assert.equal(grants.take(1, "project", "index", next), expected);
	assert.throws(() => grants.take(1, "project", "index", next), /GIT_WRITE_SNAPSHOT_EXPIRED/);
});

test("index grants expire after 15 minutes and cannot be revived by resetting the clock", () => {
	let now = 100;
	const grants = createRemoteGitMutationTokens(() => now),
		token = grants.issue(1, "project", expected);
	now += 15 * 60_000;
	assert.throws(() => grants.take(1, "project", "index", token), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	now = 100;
	assert.throws(() => grants.take(1, "project", "index", token), /GIT_WRITE_SNAPSHOT_EXPIRED/);
});

test("index grants have a 128-entry ceiling and revoke only the intended sender/project", () => {
	const grants = createRemoteGitMutationTokens();
	const oldest = grants.issue(1, "first", expected);
	for (let index = 0; index < 128; index++) grants.issue(1, `project-${index}`, expected);
	assert.throws(() => grants.take(1, "first", "index", oldest), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	const owner = grants.issue(1, "selected", expected),
		other = grants.issue(2, "selected", expected);
	grants.revoke(1, "selected");
	assert.throws(() => grants.take(1, "selected", "index", owner), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	assert.equal(grants.take(2, "selected", "index", other), expected);
	const last = grants.issue(3, "selected", expected);
	grants.clear();
	assert.throws(() => grants.take(3, "selected", "index", last), /GIT_WRITE_SNAPSHOT_EXPIRED/);
});

test("a grant is bound to the action kind it was issued for, and a mismatch does not burn it", () => {
	const grants = createRemoteGitMutationTokens();
	const indexGrant = grants.issue(1, "project", expected),
		commitGrant = grants.issue(1, "project", commitExpected);
	// One snapshot hands out both grants, so issuing the second must not revoke the first.
	assert.equal(grants.take(1, "project", "index", indexGrant).kind, "index");
	assert.equal(grants.take(1, "project", "commit", commitGrant).kind, "commit");
	const spent = grants.issue(1, "project", expected);
	assert.throws(() => grants.take(1, "project", "commit", spent), /GIT_RESULT_INVALID/);
	assert.equal(grants.take(1, "project", "index", spent).kind, "index", "a wrong-kind attempt must not burn the grant");
	// A refresh replaces only its own kind.
	const stale = grants.issue(1, "project", expected),
		kept = grants.issue(1, "project", commitExpected);
	const fresh = grants.issue(1, "project", expected);
	assert.throws(() => grants.take(1, "project", "index", stale), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	assert.equal(grants.take(1, "project", "index", fresh).kind, "index");
	assert.equal(grants.take(1, "project", "commit", kept).kind, "commit");
});
