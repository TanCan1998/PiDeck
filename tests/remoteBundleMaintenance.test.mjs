import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Host 侧 bundle / staging 保留清理（security review F2 / plan §4.2）。
 *
 * 判据不是「mock 返回什么」，而是**真实执行冻结的内联源码**：在一个临时假 HOME 下构造
 * `<home>/.pideck/remote-host/bundles/<sha>`、`.staging-*`、`.deploy.lock`，用 `utimesSync` 指定年龄，
 * 然后 spawn 一个真实 Node 子进程跑生产源码，再断言目录的**实际存在性**。这样 TTL/保留份数/
 * 活跃 bundle 保护/失败关闭都不是注释承诺。
 */

const POSIX = process.platform !== "win32";
const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const {
	REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE,
	REMOTE_BUNDLE_MAINTENANCE_ENTRY,
	REMOTE_BUNDLE_MAINTENANCE_MARKER_PREFIX,
	REMOTE_BUNDLE_MAINTENANCE_RETENTION,
	REMOTE_BUNDLE_MAINTENANCE_CODES,
	REMOTE_BUNDLE_MAINTENANCE_SKIP_REASONS,
	buildRemoteBundleMaintenanceCommand,
	parseRemoteBundleMaintenanceResult,
	remoteBundleMaintenanceMarker,
} = loadTsCommonJs("src/main/remote/RemoteBundleMaintenance.ts");
const { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_BOOTSTRAP_STAGING_PREFIX, REMOTE_BOOTSTRAP_LOCK_FILE_NAME } = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");

const MARKER = `${REMOTE_BUNDLE_MAINTENANCE_MARKER_PREFIX}testnonce1234567890`;
const ACTIVE = "a".repeat(64);

function sha(seed) {
	return seed.repeat(64).slice(0, 64);
}

/** 假 HOME + 部署根 + `bundles/`；POSIX 上把权限设成 bootstrap 实际会产生的 0700。 */
function fakeHost(t) {
	const home = mkdtempSync(join(tmpdir(), "pideck-sweep-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const deployRoot = join(home, ".pideck", "remote-host");
	const bundlesDir = join(deployRoot, "bundles");
	mkdirSync(bundlesDir, { recursive: true, mode: 0o700 });
	if (POSIX) {
		chmodSync(join(home, ".pideck"), 0o700);
		chmodSync(deployRoot, 0o700);
		chmodSync(bundlesDir, 0o700);
	}
	return { home, deployRoot, bundlesDir };
}

function setAge(target, ageMs) {
	const at = new Date(NOW - ageMs);
	utimesSync(target, at, at);
}

/** 一份完整（内容寻址目录 + 一个文件）的 bundle，年龄由 mtime 表达。 */
function addBundle(host, name, ageMs) {
	const directory = join(host.bundlesDir, name);
	mkdirSync(directory, { mode: 0o700 });
	writeFileSync(join(directory, "helper.mjs"), `// ${name}\n`);
	if (POSIX) chmodSync(directory, 0o700);
	setAge(directory, ageMs);
	return directory;
}

function addStaging(host, nonce, ageMs, leftover = true) {
	const directory = join(host.deployRoot, `${REMOTE_BOOTSTRAP_STAGING_PREFIX}${nonce}`);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (leftover) {
		mkdirSync(join(directory, "nested"), { mode: 0o700 });
		writeFileSync(join(directory, "nested", "partial.bin"), "partial");
	}
	setAge(directory, ageMs);
	return directory;
}

function addLock(host, holder) {
	const lockPath = join(host.deployRoot, REMOTE_BOOTSTRAP_LOCK_FILE_NAME);
	writeFileSync(lockPath, JSON.stringify(holder), { mode: 0o600 });
	return lockPath;
}

/** 真实子进程执行生产内联源码；HOME 指向假 home，argv 与生产 builder 的协议一致。 */
function runSweep(host, activeSha, options = {}) {
	const marker = options.marker ?? MARKER;
	const now = options.now ?? NOW;
	const deployRoot = options.deployRoot ?? host.deployRoot;
	const child = spawnSync(process.execPath, ["-e", REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE, "--", REMOTE_BUNDLE_MAINTENANCE_ENTRY, marker, deployRoot, activeSha, String(now)], { env: { ...process.env, HOME: options.home ?? host.home }, encoding: "utf8" });
	return { child, marker };
}

function outcome(host, activeSha = ACTIVE, options = {}) {
	const { child, marker } = runSweep(host, activeSha, options);
	assert.equal(child.status, 0, `远端 sweep 必须正常退出，stderr=${child.stderr.slice(0, 400)}`);
	return parseRemoteBundleMaintenanceResult(child.stdout, marker);
}

test("the frozen source and retention constants are a stable contract", () => {
	// 单行 + 无单引号：命令会作为一个 shell 单引号字面量下发，换行/控制字节会被 pinned 通道拒绝。
	assert.equal(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes("\n"), false);
	assert.equal(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes("'"), false);
	assert.ok(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes(REMOTE_BUNDLE_MAINTENANCE_ENTRY));
	assert.ok(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes(REMOTE_BUNDLE_MAINTENANCE_MARKER_PREFIX));
	assert.ok(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes(REMOTE_BOOTSTRAP_STAGING_PREFIX));
	assert.ok(REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE.includes(REMOTE_BOOTSTRAP_LOCK_FILE_NAME));
	// plan §4.2 的数值被写死进冻结源码：改动必须同时改这里，防止「常量改了、远端还是旧行为」。
	assert.equal(REMOTE_BUNDLE_MAINTENANCE_RETENTION.stagingTtlMs, 60 * 60 * 1000);
	assert.equal(REMOTE_BUNDLE_MAINTENANCE_RETENTION.unreferencedTtlMs, 7 * 24 * 60 * 60 * 1000);
	assert.equal(REMOTE_BUNDLE_MAINTENANCE_RETENTION.maxUnreferencedSnapshots, 2);
	assert.equal(REMOTE_BUNDLE_MAINTENANCE_RETENTION.minimumDeleteAgeMs, 60 * 60 * 1000);
});

test("keeps the active bundle, the rollback snapshot and at most two more unreferenced snapshots", (t) => {
	const host = fakeHost(t);
	addBundle(host, ACTIVE, 30 * DAY); // 本次激活的 bundle：无论多旧都保留
	addBundle(host, sha("c"), 2 * HOUR); // 最新非 active ⇒ rollback 快照，永远保留
	addBundle(host, sha("d"), 3 * HOUR); // 未引用快照 1（≤2 份）
	addBundle(host, sha("b"), 2 * DAY + HOUR); // 未引用快照 2（≤2 份）
	addBundle(host, sha("e"), 2 * DAY + 2 * HOUR); // 超出「最多 2 份」且已过 1h 并发保护 ⇒ 删除

	const result = outcome(host);
	assert.equal(result.removedBundles, 1);
	assert.equal(result.keptBundles, 4);
	assert.equal(result.unverifiable, 0);
	assert.ok(existsSync(join(host.bundlesDir, ACTIVE)), "active bundle 必须保留");
	assert.ok(existsSync(join(host.bundlesDir, sha("c"))), "rollback（最新非 active）必须保留");
	assert.ok(existsSync(join(host.bundlesDir, sha("d"))), "未引用快照 1 保留");
	assert.ok(existsSync(join(host.bundlesDir, sha("b"))), "未引用快照 2 保留");
	assert.equal(existsSync(join(host.bundlesDir, sha("e"))), false, "超额的旧快照必须删除");
});

test("an unreferenced snapshot older than seven days is deleted even when slots are free", (t) => {
	const host = fakeHost(t);
	addBundle(host, ACTIVE, 10 * DAY);
	addBundle(host, sha("b"), HOUR); // rollback（新）保留
	addBundle(host, sha("c"), 8 * DAY); // 超过 7 天 TTL ⇒ 删除
	addBundle(host, sha("d"), 9 * DAY); // 超过 7 天 TTL ⇒ 删除

	const result = outcome(host);
	assert.equal(result.removedBundles, 2);
	assert.ok(existsSync(join(host.bundlesDir, ACTIVE)));
	assert.ok(existsSync(join(host.bundlesDir, sha("b"))));
	assert.equal(existsSync(join(host.bundlesDir, sha("c"))), false);
	assert.equal(existsSync(join(host.bundlesDir, sha("d"))), false);
});

test("very recent unreferenced snapshots are never deleted: another client may be connected to one", (t) => {
	// 并发连接保护：plan 的「连接注册/lease」未实现，年龄门槛是当前的替代。四份都在 1h 内 ⇒ 一份也不删。
	const host = fakeHost(t);
	addBundle(host, ACTIVE, 40 * DAY);
	for (const [name, age] of [
		["b", 5 * 60 * 1000],
		["c", 10 * 60 * 1000],
		["d", 20 * 60 * 1000],
		["e", 45 * 60 * 1000],
	])
		addBundle(host, sha(name), age);
	const result = outcome(host);
	assert.equal(result.removedBundles, 0);
	assert.equal(result.keptBundles, 5);
});

test("staging directories are swept only after an hour; partial leftovers included", (t) => {
	const host = fakeHost(t);
	addBundle(host, ACTIVE, DAY);
	const old = addStaging(host, "oldstaging1234567", 65 * 60 * 1000);
	const fresh = addStaging(host, "freshstaging12345", 30 * 60 * 1000);
	// 无活跃 lock 的旧 staging（含半截上传内容）⇒ 清理；上传中的目录 mtime 会更新，不会被删。
	const result = outcome(host);
	assert.equal(result.removedStaging, 1);
	assert.equal(result.keptStaging, 1);
	assert.equal(existsSync(old), false);
	assert.ok(existsSync(fresh));
});

test("a live deploy lock makes the sweep non-destructive and skips everything", (t) => {
	const host = fakeHost(t);
	addBundle(host, ACTIVE, 30 * DAY);
	addBundle(host, sha("b"), 2 * HOUR);
	addBundle(host, sha("c"), 3 * HOUR);
	addBundle(host, sha("d"), 4 * HOUR);
	const doomed = addBundle(host, sha("f"), 2 * DAY + 2 * HOUR); // 无 lock 时会被删（在 3 份未引用快照之外）
	const oldStaging = addStaging(host, "oldstaging1234567", 70 * 60 * 1000);
	const lockPath = addLock(host, { pid: process.pid, start: null, nonce: "live" });

	const result = outcome(host);
	assert.deepEqual([...result.skipped], ["DEPLOY_LOCK_HELD"]);
	assert.equal(result.removedBundles, 0);
	assert.equal(result.removedStaging, 0);
	assert.equal(result.removedStaleLock, false);
	assert.ok(existsSync(doomed), "另一个客户端可能正在部署/运行：任何删除都不允许");
	assert.ok(existsSync(oldStaging));
	assert.ok(existsSync(lockPath), "活跃 lock 绝不能被 sweep 删除");
});

test("a crash-left deploy lock is removed and the sweep continues", (t) => {
	const host = fakeHost(t);
	addBundle(host, ACTIVE, 30 * DAY);
	addBundle(host, sha("b"), 2 * HOUR);
	addBundle(host, sha("c"), 3 * HOUR);
	addBundle(host, sha("d"), 4 * HOUR);
	const doomed = addBundle(host, sha("f"), 2 * DAY + 2 * HOUR);
	const lockPath = addLock(host, { pid: 2 ** 31 - 1, start: null, nonce: "dead" });
	const result = outcome(host);
	assert.equal(result.removedStaleLock, true);
	assert.equal(existsSync(lockPath), false, "持有者已死 ⇒ stale lock 清理（与 bootstrap 的回收判据一致）");
	assert.equal(result.skipped.includes("DEPLOY_LOCK_REMOVE_FAILED"), false);
	assert.equal(existsSync(doomed), false);
});

test("a deploy root that cannot be verified is left completely untouched (fail closed)", (t) => {
	const host = fakeHost(t);
	addBundle(host, ACTIVE, DAY);
	const doomed = addBundle(host, sha("f"), 2 * DAY + 2 * HOUR);
	// HOME 与部署根不一致（另一台环境/被改写）⇒ 不猜、不删。
	const wrongHome = mkdtempSync(join(tmpdir(), "pideck-sweep-other-"));
	t.after(() => rmSync(wrongHome, { recursive: true, force: true }));
	const result = outcome(host, ACTIVE, { home: wrongHome });
	assert.deepEqual([...result.skipped], ["DEPLOY_ROOT_UNVERIFIABLE"]);
	assert.equal(result.removedBundles, 0);
	assert.ok(existsSync(doomed));
});

test("the active bundle missing from the scan fails the bundle sweep closed", (t) => {
	const host = fakeHost(t);
	// 只放旧快照，不放本次激活的 sha：目录被外部动过 ⇒ 无法判断 active，宁可整段跳过。
	const old = addBundle(host, sha("f"), 30 * DAY);
	const result = outcome(host);
	assert.ok(result.skipped.includes("ACTIVE_BUNDLE_MISSING"));
	assert.equal(result.removedBundles, 0);
	assert.ok(existsSync(old));
});

test("unverifiable entries are kept and counted, never deleted", (t) => {
	const host = fakeHost(t);
	addBundle(host, ACTIVE, DAY);
	// 1) sha 形状的普通文件；2) 非 sha 名字的目录。
	const fileLikeSha = join(host.bundlesDir, sha("f"));
	writeFileSync(fileLikeSha, "not a bundle");
	const foreign = join(host.bundlesDir, "not-a-sha-name");
	mkdirSync(foreign, { mode: 0o700 });
	if (POSIX) chmodSync(foreign, 0o700);
	const result = outcome(host);
	assert.equal(result.unverifiable, 2);
	assert.equal(result.removedBundles, 0);
	assert.ok(existsSync(fileLikeSha));
	assert.ok(existsSync(foreign));
});

test("the command builder sends only validated tokens and stays inside the pinned command budget", () => {
	const built = buildRemoteBundleMaintenanceCommand({ nodePath: "/usr/bin/node", deployRoot: "/home/dev/.pideck/remote-host", activeBundleSha256: ACTIVE, nonce: "abcdef0123456789", nowMs: NOW });
	assert.equal(built.marker, `${REMOTE_BUNDLE_MAINTENANCE_MARKER_PREFIX}abcdef0123456789`);
	assert.ok(built.command.length <= REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH, `command too long: ${built.command.length}`);
	// token 逐个 quoting；远端 shell 只看到 argv。
	for (const token of ["/usr/bin/node", "-e", "--", REMOTE_BUNDLE_MAINTENANCE_ENTRY, built.marker, "/home/dev/.pideck/remote-host", ACTIVE, String(NOW)]) assert.ok(built.command.includes(`'${token}'`), `missing quoted token: ${token}`);
	for (const bad of [
		{ nodePath: "node" },
		{ nodePath: "/usr/bin/nodejs" },
		{ deployRoot: "/home/dev/.pideck/remote-host/" },
		{ deployRoot: "/home/dev/.pideck/../remote-host" },
		{ deployRoot: "/home/dev//.pideck/remote-host" },
		{ activeBundleSha256: "A".repeat(64) },
		{ activeBundleSha256: "a".repeat(63) },
		{ nonce: "short" },
		{ nonce: "not-allowed-character" },
		{ nowMs: 0 },
		{ nowMs: 1.5 },
	]) {
		assert.throws(
			() => buildRemoteBundleMaintenanceCommand({ nodePath: "/usr/bin/node", deployRoot: "/home/dev/.pideck/remote-host", activeBundleSha256: ACTIVE, nonce: "abcdef0123456789", nowMs: NOW, ...bad }),
			(error) => error.message === REMOTE_BUNDLE_MAINTENANCE_CODES.inputInvalid,
		);
	}
});

test("the result parser accepts only one strictly shaped outcome after the marker", () => {
	const valid = { ok: true, removedBundles: 1, keptBundles: 2, removedStaging: 0, keptStaging: 3, removedStaleLock: true, unverifiable: 0, skipped: ["DEPLOY_LOCK_REMOVE_FAILED"] };
	const parsed = parseRemoteBundleMaintenanceResult(`login banner\n${MARKER}${JSON.stringify(valid)}`, MARKER);
	const { ok: accepted, ...expectedOutcome } = valid;
	assert.equal(accepted, true);
	// 跨 realm 的对象/数组不能 deepStrictEqual（原型不同）：按生产契约的 JSON 形状比较。
	assert.deepEqual(JSON.parse(JSON.stringify(parsed)), expectedOutcome);
	assert.deepEqual([...parsed.skipped], ["DEPLOY_LOCK_REMOVE_FAILED"]);
	const rejects = (stdout, marker = MARKER) =>
		assert.throws(
			() => parseRemoteBundleMaintenanceResult(stdout, marker),
			(error) => error.message === REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid,
		);
	rejects("no marker in output");
	rejects(`${MARKER}{"ok":true`);
	rejects(`${MARKER}{"ok":false,"code":"SOMETHING_ELSE"}`);
	rejects(`${MARKER}{"ok":true,"removedBundles":-1,"keptBundles":0,"removedStaging":0,"keptStaging":0,"removedStaleLock":false,"unverifiable":0,"skipped":[]}`);
	rejects(`${MARKER}{"ok":true,"removedBundles":1,"keptBundles":0,"removedStaging":0,"keptStaging":0,"removedStaleLock":"yes","unverifiable":0,"skipped":[]}`);
	rejects(`${MARKER}{"ok":true,"removedBundles":1,"keptBundles":0,"removedStaging":0,"keptStaging":0,"removedStaleLock":false,"unverifiable":0,"skipped":["NOT_A_REASON"]}`);
	rejects(`${MARKER}{"ok":true,"removedBundles":1,"keptBundles":0,"removedStaging":0,"keptStaging":0,"removedStaleLock":false,"unverifiable":0,"skipped":["DEPLOY_LOCK_HELD","DEPLOY_LOCK_HELD"]}`);
	// 脚本报告的失败码原样转述（调用方按稳定码记日志），未知码才是「输出不可信」。
	for (const code of [REMOTE_BUNDLE_MAINTENANCE_CODES.sweepFailed, REMOTE_BUNDLE_MAINTENANCE_CODES.inputInvalid])
		assert.throws(
			() => parseRemoteBundleMaintenanceResult(`${MARKER}{"ok":false,"code":"${code}"}`, MARKER),
			(error) => error.message === code,
		);
	assert.throws(
		() => parseRemoteBundleMaintenanceResult(`${MARKER}{"ok":true}`, "PIDECK_SWEEP_short"),
		(error) => error.message === REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid,
	);
	assert.deepEqual([...REMOTE_BUNDLE_MAINTENANCE_SKIP_REASONS], ["DEPLOY_ROOT_UNVERIFIABLE", "DEPLOY_LOCK_HELD", "DEPLOY_LOCK_REMOVE_FAILED", "BUNDLES_DIR_UNVERIFIABLE", "ACTIVE_BUNDLE_MISSING"]);
});
