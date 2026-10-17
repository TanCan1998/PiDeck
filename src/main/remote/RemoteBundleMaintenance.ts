/**
 * Host-side retention sweep for the deployed helper bundles（security review F2 / plan §4.2）。
 *
 * 为什么需要它：helper bundle 是**内容寻址**目录（`<deployRoot>/bundles/<bundleSha256>`），每次 PiDeck 版本
 * 变更都会在同一台远端主机上多出一份快照；bootstrap 被杀/断电还会留下 `.staging-*` 目录和 `.deploy.lock`。
 * 旧实现只有 bootstrap 进程自己的失败/EOF 清理，没有 host 侧保留策略（plan §4.2：active/rollback/lease
 * 可达性保留、未引用快照 ≤2 份且 ≤7 天、staging >1h 清理）。本模块实现其中**部署根内**的部分。
 *
 * 安全纪律：
 * - 在 `bootstrapPinnedHost` 完成**已确认激活之后**执行；失败绝不会把一次成功部署判成失败（非致命、只记日志）；
 * - 不引入 helper 协议变更：走既有 pinned SSH 短命令 + 固定内联 Node 源码（与 write guard / bootstrap inline
 *   同一套纪律：唯一源码常量、argv 逐个 POSIX quoting、stdout 单标记 JSON、稳定码词汇）；
 * - 判据按「可达性 + 年龄」而不是目录排序猜测：
 *   - **本次激活的 active bundle** 永远保留；扫描里找不到它 ⇒ fail closed，跳过整个 bundle 清理；
 *   - 最新一份非 active 快照视为 **rollback**，永远保留；
 *   - 其余未引用快照最多保留 2 份且不超过 7 天；
 *   - **并发连接保护**：年龄 < 1h 的未引用快照不删（另一台机器/另一个 PiDeck 版本可能正连在它上面；
 *     plan 要求的「连接注册/lease」尚未实现，这是当前能做到的最保守替代，见
 *     docs/remote-security-remediation.md 的残留风险）；
 *   - `.staging-*` 只在**没有活跃 deploy lock** 时、目录 mtime 超过 1h 才删（上传中的 staging mtime 会更新）；
 *   - `.deploy.lock` 持有者按 pid + Linux /proc start identity 判定存活（与 bootstrap 同一判据）：
 *     存活 ⇒ 整个 sweep 跳过（另一个客户端可能正在部署）；已死 ⇒ 删除 stale lock；
 *   - 目录若无法验证（非目录/符号链接/owner 或 mode 不符）⇒ **不删除**并计入 unverifiable。
 *
 * 已知边界：24h artifact TTL（runtime/security/export 临时文件）不在部署根内，本模块不覆盖；
 * 终端 launch ticket 属 F3，未实现。
 */
import { randomBytes } from "node:crypto";
import { quotePosixArgument } from "./RemoteBootstrapContract";
import { REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME, REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } from "./RemoteHelperContract";
import { isRemoteRunnerAbsolutePath } from "./RemoteRunnerContract";
import type { SshClientRuntime } from "./SshClientRuntime";
import { buildPinnedSshInvocation } from "./SshVerifiedConnection";

/** 保留参数（plan §4.2；数值改变会改变远端清理行为，必须与测试一起评审）。 */
export const REMOTE_BUNDLE_MAINTENANCE_RETENTION = {
	/** 无活跃 deploy lock 的 `.staging-*` 超过该年龄可清理（plan: >1h）。 */
	stagingTtlMs: 60 * 60 * 1000,
	/** 未引用快照的最长保留时间（plan: ≤7 天）。 */
	unreferencedTtlMs: 7 * 24 * 60 * 60 * 1000,
	/** 除 active/rollback 外最多保留的未引用快照数（plan: ≤2 份）。 */
	maxUnreferencedSnapshots: 2,
	/**
	 * 未引用快照的最小删除年龄（并发保护）：另一台机器/另一个 PiDeck 版本可能刚激活并正连在这份 bundle 上。
	 * plan 的多客户端方案是「连接注册 + lease」，当前未实现，因此用年龄门槛兜住最常见窗口。
	 */
	minimumDeleteAgeMs: 60 * 60 * 1000,
} as const;

/** 固定内联入口名，与测试/源码契约一起钉住。 */
export const REMOTE_BUNDLE_MAINTENANCE_ENTRY = "--pideck-bundle-sweep-v1";
/** 结果标记前缀；主进程与远端脚本必须用同一形状（脚本里校验，主进程用同一函数构造）。 */
export const REMOTE_BUNDLE_MAINTENANCE_MARKER_PREFIX = "PIDECK_SWEEP_";

/** 稳定码词汇：任何失败都必须折叠到这些值之一，绝不把 stderr/路径带出去。 */
export const REMOTE_BUNDLE_MAINTENANCE_CODES = {
	/** 构造/接线不合法（path/sha/nonce/now）——命令一条都不发。 */
	inputInvalid: "REMOTE_MAINTENANCE_INPUT_INVALID",
	/** 传输失败或远端脚本退出非 0（stderr 不外传）。sweep 失败是**非致命**的（调用方只记日志）。 */
	sweepFailed: "REMOTE_MAINTENANCE_SWEEP_FAILED",
	/** 远端输出不可信（标记缺失/JSON 撕裂/字段形状非法）：不据此删除任何东西，也不能谎报成功。 */
	resultInvalid: "REMOTE_MAINTENANCE_RESULT_INVALID",
} as const;

/** 远端脚本允许报告的 skip 原因（闭集：未知原因 = 输出不可信）。 */
export const REMOTE_BUNDLE_MAINTENANCE_SKIP_REASONS = ["DEPLOY_ROOT_UNVERIFIABLE", "DEPLOY_LOCK_HELD", "DEPLOY_LOCK_REMOVE_FAILED", "BUNDLES_DIR_UNVERIFIABLE", "ACTIVE_BUNDLE_MISSING"] as const;
export type RemoteBundleMaintenanceSkipReason = (typeof REMOTE_BUNDLE_MAINTENANCE_SKIP_REASONS)[number];
const SKIP_REASONS: ReadonlySet<string> = new Set(REMOTE_BUNDLE_MAINTENANCE_SKIP_REASONS);
const SHA256 = /^[0-9a-f]{64}$/;
const MARKER_NONCE = /^[A-Za-z0-9]{8,64}$/;

/** 远端 sweep 的结果摘要（只有计数/布尔/闭集 skip 码，不含任何远端路径）。 */
export type RemoteBundleMaintenanceOutcome = {
	removedBundles: number;
	keptBundles: number;
	removedStaging: number;
	keptStaging: number;
	removedStaleLock: boolean;
	/** 无法验证因此未处理的条目数（fail closed：不删）。 */
	unverifiable: number;
	skipped: RemoteBundleMaintenanceSkipReason[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(code: string): never {
	throw new Error(code);
}

/**
 * 固定内联源码。只使用 node:fs / node:path；参数全部走 argv 且逐个校验；stdout 只写一条
 * `<marker><json>`，任何异常折叠成一条 `{ok:false,code}`。
 *
 * 为什么用 String.raw：脚本里的正则转义必须原样到达远端（普通模板字面量会把 `\s`/`\d` 吃掉）：
 * 脚本内所有 JS 字符串用双引号——命令会作为一个 shell 单引号字面量下发，双引号无需转义。
 */
export const REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE = String.raw`"use strict";
const fs = require("node:fs"), path = require("node:path");
const ENTRY = ${JSON.stringify(REMOTE_BUNDLE_MAINTENANCE_ENTRY)};
const SHA = /^[0-9a-f]{64}$/;
const MARKER = /^${REMOTE_BUNDLE_MAINTENANCE_MARKER_PREFIX}[A-Za-z0-9]{8,64}$/;
const STAGING = /^\.staging-[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const STAGING_TTL_MS = ${REMOTE_BUNDLE_MAINTENANCE_RETENTION.stagingTtlMs};
const UNREFERENCED_TTL_MS = ${REMOTE_BUNDLE_MAINTENANCE_RETENTION.unreferencedTtlMs};
const KEEP_UNREFERENCED = ${REMOTE_BUNDLE_MAINTENANCE_RETENTION.maxUnreferencedSnapshots};
const MIN_DELETE_AGE_MS = ${REMOTE_BUNDLE_MAINTENANCE_RETENTION.minimumDeleteAgeMs};
const BUNDLE_DIR = ${JSON.stringify(REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME)};
const BUNDLE_MODE = 448;
const DEPLOY_LOCK = ".deploy.lock";
const INPUT_INVALID = ${JSON.stringify(REMOTE_BUNDLE_MAINTENANCE_CODES.inputInvalid)};
const argv = process.argv.slice(1);
const marker = argv.length === 5 && MARKER.test(argv[1]) ? argv[1] : "";
function out(value) { process.stdout.write(marker + JSON.stringify(value)); }
function fail(code) { if (marker) out({ ok: false, code: code }); process.exitCode = 1; }
function empty(skipped) { return { ok: true, removedBundles: 0, keptBundles: 0, removedStaging: 0, keptStaging: 0, removedStaleLock: false, unverifiable: 0, skipped: skipped || [] }; }
function canonical(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096 || !path.isAbsolute(value) || CONTROL.test(value)) return false;
	if (value !== path.normalize(value) || value === path.dirname(value)) return false;
	const segments = value.split(path.sep), start = segments[0] === "" ? 1 : 0;
	return !segments.slice(start).some(function (segment) { return segment === "" || segment === "." || segment === ".."; });
}
function privateDir(target) {
	let stat = null;
	try { stat = fs.lstatSync(target); } catch { return null; }
	if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
	if (typeof process.getuid === "function") { if (stat.uid !== process.getuid()) return null; if ((stat.mode & 0o077) !== 0) return null; }
	return stat;
}
function bundleEntry(target) {
	let stat = null;
	try { stat = fs.lstatSync(target); } catch { return null; }
	if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
	if (typeof process.getuid === "function") { if (stat.uid !== process.getuid()) return null; if ((stat.mode & 0o777) !== BUNDLE_MODE) return null; }
	return stat;
}
function startId(pid) {
	if (process.platform !== "linux") return null;
	try { const raw = fs.readFileSync("/proc/" + pid + "/stat", "utf8"); return raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19] || null; } catch { return null; }
}
function holderAlive(holder) {
	if (!holder || !Number.isSafeInteger(holder.pid) || holder.pid <= 1) return false;
	try { process.kill(holder.pid, 0); } catch (error) { if (!error || error.code !== "EPERM") return false; }
	if (typeof holder.start === "string") { const live = startId(holder.pid); if (live !== null && live !== holder.start) return false; }
	return true;
}
function removeVerified(target, dev, ino) {
	let stat = null;
	try { stat = fs.lstatSync(target); } catch { return false; }
	if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== String(dev) || String(stat.ino) !== String(ino)) return false;
	try { fs.rmSync(target, { recursive: true, force: true }); return true; } catch { return false; }
}
function removeExpiredStaging(deployRoot, now, result) {
	for (const name of fs.readdirSync(deployRoot)) {
		if (!STAGING.test(name)) continue;
		const target = path.join(deployRoot, name);
		let stat = null;
		try { stat = fs.lstatSync(target); } catch { result.unverifiable += 1; continue; }
		if (!stat.isDirectory() || stat.isSymbolicLink()) { result.unverifiable += 1; continue; }
		if (now - Number(stat.mtimeMs) <= STAGING_TTL_MS) { result.keptStaging += 1; continue; }
		if (removeVerified(target, stat.dev, stat.ino)) result.removedStaging += 1;
		else result.unverifiable += 1;
	}
}
function sweepBundles(deployRoot, activeSha, now, result) {
	const bundlesDir = path.join(deployRoot, BUNDLE_DIR);
	let bundlesPresent = false;
	try { bundlesPresent = fs.lstatSync(bundlesDir).isDirectory(); } catch {}
	if (!bundlesPresent) return;
	if (privateDir(bundlesDir) === null) { result.skipped.push("BUNDLES_DIR_UNVERIFIABLE"); return; }
	const known = new Set(), verified = [];
	for (const name of fs.readdirSync(bundlesDir)) {
		if (!SHA.test(name)) { result.unverifiable += 1; continue; }
		const target = path.join(bundlesDir, name);
		const stat = bundleEntry(target);
		if (stat === null) { result.unverifiable += 1; continue; }
		known.add(name);
		verified.push({ name: name, target: target, stat: stat });
	}
	if (!known.has(activeSha)) { result.skipped.push("ACTIVE_BUNDLE_MISSING"); return; }
	const others = verified.filter(function (entry) { return entry.name !== activeSha; }).sort(function (left, right) { return Number(right.stat.mtimeMs) - Number(left.stat.mtimeMs); });
	for (let index = 0; index < others.length; index += 1) {
		const entry = others[index], age = now - Number(entry.stat.mtimeMs);
		const rollback = index === 0;
		const young = age < MIN_DELETE_AGE_MS;
		const withinKept = index - 1 < KEEP_UNREFERENCED && age <= UNREFERENCED_TTL_MS;
		if (rollback || young || withinKept) continue;
		if (removeVerified(entry.target, entry.stat.dev, entry.stat.ino)) result.removedBundles += 1;
		else result.unverifiable += 1;
	}
	result.keptBundles = known.size - result.removedBundles;
}
function sweep(deployRoot, activeSha, now) {
	const result = empty([]);
	const lockPath = path.join(deployRoot, DEPLOY_LOCK);
	let lockPresent = false;
	try { fs.lstatSync(lockPath); lockPresent = true; } catch {}
	if (lockPresent) {
		let holder = null;
		try { holder = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch {}
		if (holderAlive(holder)) { out(empty(["DEPLOY_LOCK_HELD"])); return; }
		try { fs.unlinkSync(lockPath); result.removedStaleLock = true; } catch { result.skipped.push("DEPLOY_LOCK_REMOVE_FAILED"); }
	}
	sweepBundles(deployRoot, activeSha, now, result);
	removeExpiredStaging(deployRoot, now, result);
	out(result);
}
try {
	if (argv.length !== 5 || argv[0] !== ENTRY || marker === "") fail(INPUT_INVALID);
	else {
		const deployRoot = argv[2], activeSha = argv[3], now = Number(argv[4]);
		const home = process.env.HOME;
		if (!canonical(deployRoot) || !SHA.test(activeSha) || !Number.isSafeInteger(now) || now < 1) fail(INPUT_INVALID);
		else if (!canonical(home) || deployRoot !== path.join(home, ".pideck", "remote-host") || privateDir(deployRoot) === null) out(empty(["DEPLOY_ROOT_UNVERIFIABLE"]));
		else sweep(deployRoot, activeSha, now);
	}
} catch { fail(${JSON.stringify(REMOTE_BUNDLE_MAINTENANCE_CODES.sweepFailed)}); }
`
	// 单行化：这条源码会作为**一个 shell 参数**下发，pinned 通道拒绝参数里的换行/控制字节；
	// 与 write guard / project-file 命令的固定源码同一做法（脚本里没有需要保空白语义的字符串字面量）。
	.replace(/\s+/g, " ")
	.trim();

/** 结果标记：构造命令与解析输出必须用同一个函数，两侧不会漂移。 */
export function remoteBundleMaintenanceMarker(nonce: unknown): string {
	if (typeof nonce !== "string" || !MARKER_NONCE.test(nonce)) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.inputInvalid);
	return `${REMOTE_BUNDLE_MAINTENANCE_MARKER_PREFIX}${nonce}`;
}

/**
 * 构造一次 host-side sweep 的远端命令。
 *
 * 与 bootstrap/write-guard 同一套「先判后发」：node/deployRoot/active sha/nonce/now 任一不合法就抛稳定码，
 * 一个字节都不发。deployRoot 用 runner 契约的 canonical POSIX 判据（remote 侧只可能是 POSIX）；
 * nodePath 必须是绝对路径且 basename 为 `node`（与 write guard 对解释器的要求一致）。
 */
export function buildRemoteBundleMaintenanceCommand(input: { nodePath: unknown; deployRoot: unknown; activeBundleSha256: unknown; nonce: unknown; nowMs?: unknown }): { command: string; marker: string } {
	const nodePath = typeof input?.nodePath === "string" && isRemoteRunnerAbsolutePath(input.nodePath) && input.nodePath.slice(input.nodePath.lastIndexOf("/") + 1) === "node" ? input.nodePath : undefined;
	const deployRoot = isRemoteRunnerAbsolutePath(input?.deployRoot) ? input.deployRoot : undefined;
	const activeBundleSha256 = typeof input?.activeBundleSha256 === "string" && SHA256.test(input.activeBundleSha256) ? input.activeBundleSha256 : undefined;
	const marker = remoteBundleMaintenanceMarker(input?.nonce);
	const nowMs = input?.nowMs === undefined ? Date.now() : input.nowMs;
	if (nodePath === undefined || deployRoot === undefined || activeBundleSha256 === undefined || typeof nowMs !== "number" || !Number.isSafeInteger(nowMs) || nowMs < 1) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.inputInvalid);
	const command = [nodePath, "-e", REMOTE_BUNDLE_MAINTENANCE_INLINE_SOURCE, "--", REMOTE_BUNDLE_MAINTENANCE_ENTRY, marker, deployRoot, activeBundleSha256, String(nowMs)].map(quotePosixArgument).join(" ");
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.inputInvalid);
	return { command, marker };
}

/**
 * 解析远端 sweep 的结果（纯函数）：标记之后只接受一个 JSON；计数/布尔/闭集 skip 码严格重建，
 * 任何多余字段或未知码都视为输出不可信（不据此删除，也不能谎报成功）。
 */
export function parseRemoteBundleMaintenanceResult(stdout: unknown, marker: unknown): RemoteBundleMaintenanceOutcome {
	if (typeof stdout !== "string" || typeof marker !== "string" || !marker.startsWith(REMOTE_BUNDLE_MAINTENANCE_MARKER_PREFIX) || !MARKER_NONCE.test(marker.slice(REMOTE_BUNDLE_MAINTENANCE_MARKER_PREFIX.length))) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid);
	const start = stdout.indexOf(marker);
	if (start < 0) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid);
	let value: unknown;
	try {
		value = JSON.parse(stdout.slice(start + marker.length));
	} catch {
		refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid);
	}
	if (!isRecord(value)) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid);
	if (value.ok === false) {
		if (typeof value.code === "string" && (value.code === REMOTE_BUNDLE_MAINTENANCE_CODES.inputInvalid || value.code === REMOTE_BUNDLE_MAINTENANCE_CODES.sweepFailed)) refuse(value.code);
		refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid);
	}
	if (value.ok !== true) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid);
	const outcome: RemoteBundleMaintenanceOutcome = { removedBundles: 0, keptBundles: 0, removedStaging: 0, keptStaging: 0, removedStaleLock: false, unverifiable: 0, skipped: [] };
	for (const key of ["removedBundles", "keptBundles", "removedStaging", "keptStaging", "unverifiable"] as const) {
		const count = value[key];
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 100000) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid);
		outcome[key] = count;
	}
	if (typeof value.removedStaleLock !== "boolean" || !Array.isArray(value.skipped) || value.skipped.length > REMOTE_BUNDLE_MAINTENANCE_SKIP_REASONS.length) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid);
	const seen = new Set<string>();
	for (const reason of value.skipped) {
		if (typeof reason !== "string") refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid);
		const known = REMOTE_BUNDLE_MAINTENANCE_SKIP_REASONS.find((item) => item === reason);
		if (known === undefined || seen.has(known)) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.resultInvalid);
		seen.add(known);
		outcome.skipped.push(known);
	}
	outcome.removedStaleLock = value.removedStaleLock;
	return outcome;
}

/**
 * 在一条已验证的 pinned SSH 通道上执行 host-side sweep。
 *
 * 失败语义：排线/参数错误抛 `REMOTE_MAINTENANCE_INPUT_INVALID`；传输失败/非 0 退出抛
 * `REMOTE_MAINTENANCE_SWEEP_FAILED`；输出不可信抛 `REMOTE_MAINTENANCE_RESULT_INVALID`。
 * 调用方（bootstrap）必须当作**非致命**处理：已确认的部署不因清理失败而失败。
 */
export async function maintainDeployedBundles(input: { userDataDir: string; hostId: string; client: SshClientRuntime; nodePath: string; deployRoot: string; activeBundleSha256: string; now?: () => number }): Promise<RemoteBundleMaintenanceOutcome> {
	const nonce = randomBytes(16).toString("hex");
	const { command, marker } = buildRemoteBundleMaintenanceCommand({ nodePath: input.nodePath, deployRoot: input.deployRoot, activeBundleSha256: input.activeBundleSha256, nonce, nowMs: (input.now ?? Date.now)() });
	const invocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: command });
	let result: { exitCode: number; stdout: string };
	try {
		result = await input.client.run(invocation.executable, invocation.args);
	} catch {
		refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.sweepFailed);
	}
	if (!isRecord(result) || !Number.isSafeInteger(result.exitCode) || typeof result.stdout !== "string") refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.sweepFailed);
	if (result.exitCode !== 0) refuse(REMOTE_BUNDLE_MAINTENANCE_CODES.sweepFailed);
	return parseRemoteBundleMaintenanceResult(result.stdout, marker);
}
