import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { decodeProjectStoreSnapshot, encodeProjectStoreSnapshot } = loadTsCommonJs("src/main/projects/projectStoreCodec.ts");

/**
 * ssh 记录的 hostId 是 RemoteHostStore 的 profile 主键（randomUUID 生成），不是任意字符串。
 * 本文件所有远端夹具都用这个值域内的 id；域外取值由下面的定向用例单独断言。
 */
const SSH_HOST_ID = "01234567-89ab-4def-8123-456789abcdef";

function project(overrides = {}) {
	return {
		id: "project-1",
		name: "repo",
		path: "C:\\work\\repo",
		lastOpenedAt: 10,
		environment: "windows",
		...overrides,
	};
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("v1 project array reads through the local adapter and marks migration needed", () => {
	const decoded = decodeProjectStoreSnapshot([project(), project({ id: "wsl-1", path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo", environment: "wsl" })]);
	assert.equal(decoded.sourceVersion, 1);
	assert.equal(decoded.revision, 0);
	assert.equal(decoded.projects[0].environment, "windows");
	assert.equal(decoded.projects[1].environment, "wsl");
	assert.equal(decoded.projects[1].path, "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo");
});

test("v2 snapshot persists location only in the locator and round-trips through local compatibility", () => {
	const source = [project(), project({ id: "wsl-1", path: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo", environment: "wsl", wslDistro: "Ubuntu" })];
	const encoded = encodeProjectStoreSnapshot(source, 7);
	assert.equal(encoded.schemaVersion, 2);
	assert.equal(encoded.revision, 7);
	for (const entry of encoded.projects) {
		assert.equal(Object.hasOwn(entry, "path"), false);
		assert.equal(Object.hasOwn(entry, "environment"), false);
		assert.equal(Object.hasOwn(entry, "wslDistro"), false);
	}
	assert.deepEqual(plain(encoded.projects[0].locator), { kind: "local", environment: "native", localPath: "C:\\work\\repo" });
	assert.deepEqual(plain(encoded.projects[1].locator), { kind: "local", environment: "wsl", localPath: "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo", wslDistro: "Ubuntu" });
	const decoded = decodeProjectStoreSnapshot(plain(encoded));
	assert.equal(decoded.sourceVersion, 2);
	assert.equal(decoded.revision, 7);
	assert.deepEqual(plain(decoded.projects), plain(source));
});

test("v2 SSH project decodes to a RemoteProject without fabricating a local path", () => {
	const remote = {
		schemaVersion: 2,
		revision: 3,
		projects: [{ id: "remote-1", name: "repo", lastOpenedAt: 10, locator: { kind: "ssh", hostId: SSH_HOST_ID, remotePath: "/srv/repo" } }],
	};
	const decoded = decodeProjectStoreSnapshot(remote);
	assert.equal(decoded.projects.length, 1);
	assert.equal(Object.hasOwn(decoded.projects[0], "path"), false, "ssh 项目没有本机 path");
	assert.equal(Object.hasOwn(decoded.projects[0], "environment"), false);
	assert.deepEqual(plain(decoded.projects[0].locator), { kind: "ssh", hostId: SSH_HOST_ID, remotePath: "/srv/repo" });
});

test("v2 SSH project round-trips through encode/decode without ever gaining a local path", () => {
	const source = { id: "remote-1", name: "repo", lastOpenedAt: 10, locator: { kind: "ssh", hostId: SSH_HOST_ID, remotePath: "/srv/repo" } };
	const encoded = encodeProjectStoreSnapshot([source], 5);
	assert.deepEqual(plain(encoded.projects[0]), source);
	const decoded = decodeProjectStoreSnapshot(plain(encoded));
	assert.deepEqual(plain(decoded.projects[0]), source);
});

// ssh 记录只允许 hostId + remotePath：任何把这批字段当本机路径的形状都必须在加载时拒绝，
// 否则 store 会把一个未验证的字符串当成授权根。
test("v2 ssh records reject a non-absolute, root, traversal, or control-byte remotePath", () => {
	const base = { schemaVersion: 2, revision: 2 };
	const entry = (remotePath) => ({ id: "remote-1", name: "repo", lastOpenedAt: 1, locator: { kind: "ssh", hostId: SSH_HOST_ID, remotePath } });
	// 注：POSIX 下反斜杠是合法文件名字符，helper 的 realpath 接受它，所以不在此拒绝。
	for (const remotePath of ["relative/path", "/", "/srv/repo/", "/srv/../etc", "/srv/./repo", "/srv/repo\u0000x", ""]) {
		assert.throws(() => decodeProjectStoreSnapshot({ ...base, projects: [entry(remotePath)] }), /PROJECT_STORE_INVALID_V2_PROJECT/, `remotePath ${JSON.stringify(remotePath)} must be refused`);
	}
});

// hostId 的权威取值域来自 RemoteHostStore：它用 randomUUID() 生成 id，其 codec / pin / bootstrap /
// 连接诊断都只接受这个 UUID 形状，登记 IPC 也先用同一正则校验。codec 若放行域外 hostId，就会
// 加载出一条永远命中不了任何主机的"远端项目"；引用扫描却按 UUID 拒绝同一记录 ⇒ 语义不一致。
test("v2 ssh records reject a hostId outside the host store id domain", () => {
	const base = (hostId) => ({ schemaVersion: 2, revision: 1, projects: [{ id: "remote-1", name: "repo", lastOpenedAt: 1, locator: { kind: "ssh", hostId, remotePath: "/srv/repo" } }] });
	for (const hostId of ["host-a", "", `${SSH_HOST_ID} `, SSH_HOST_ID.toUpperCase(), SSH_HOST_ID.slice(0, -1), `${SSH_HOST_ID}\u0000`]) {
		assert.throws(() => decodeProjectStoreSnapshot(base(hostId)), /PROJECT_STORE_INVALID_V2_PROJECT/, `hostId ${JSON.stringify(hostId)} must be refused`);
	}
});

test("v2 local locators reject a hostId field", () => {
	const snapshot = { schemaVersion: 2, revision: 1, projects: [{ id: "p-1", name: "p", lastOpenedAt: 1, locator: { kind: "local", environment: "native", localPath: "/tmp/p", hostId: SSH_HOST_ID } }] };
	assert.throws(() => decodeProjectStoreSnapshot(snapshot), /PROJECT_STORE_INVALID_V2_PROJECT/);
});

test("v2 ssh records reject local-only fields such as kind/worktree", () => {
	const locator = { kind: "ssh", hostId: SSH_HOST_ID, remotePath: "/srv/repo" };
	for (const extra of [{ kind: "chat" }, { worktreeEnabled: true }, { worktreeParentId: "p" }]) {
		assert.throws(() => decodeProjectStoreSnapshot({ schemaVersion: 2, revision: 1, projects: [{ id: "remote-1", name: "repo", lastOpenedAt: 1, locator, ...extra }] }), /PROJECT_STORE_INVALID_V2_PROJECT/);
	}
});

test("v2 records reject legacy path fields and malformed locators", () => {
	assert.throws(
		() =>
			decodeProjectStoreSnapshot({
				schemaVersion: 2,
				revision: 1,
				projects: [{ ...project(), locator: { kind: "local", environment: "native", localPath: "C:\\work\\repo" } }],
			}),
		/PROJECT_STORE_INVALID_V2_PROJECT/,
	);
	assert.throws(() => decodeProjectStoreSnapshot({ schemaVersion: 2, revision: 1, projects: [{ id: "p", name: "repo", lastOpenedAt: 1, locator: { kind: "local", environment: "native", localPath: "" } }] }), /PROJECT_STORE_INVALID_V2_PROJECT/);
});

test("invalid snapshots and revisions fail closed", () => {
	assert.throws(() => decodeProjectStoreSnapshot({ schemaVersion: 3, revision: 2, projects: [] }), /PROJECT_STORE_INVALID_SNAPSHOT/);
	assert.throws(() => decodeProjectStoreSnapshot([project({ path: "" })]), /PROJECT_STORE_INVALID_PROJECT/);
	assert.throws(() => encodeProjectStoreSnapshot([], 0), /PROJECT_STORE_INVALID_REVISION/);
});
