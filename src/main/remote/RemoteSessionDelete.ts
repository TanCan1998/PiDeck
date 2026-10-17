/**
 * 远端会话**数据永久删除**（Phase 5 必须）：只删已归档远端会话在归档区里的那一个 JSONL 文件。
 *
 * 为什么单独成模块而不是塞进 P4.5b 的 RemoteSessionArchive：归档只做 move（可恢复），删除是
 * **不可恢复**的另一类动作——它需要自己的确认协议、自己的稳定码和「回执丢失 ⇒ 结果未确认」
 * 语义。把两者混在一起，迟早出现「归档失败也走删除码」或「删除失败被当成移动失败」。
 *
 * 通道与 P4.5b/P4.5c 相同：既有 pinned SSH 短命令（每次复查 pin/指纹/路由/严格配置），远端执行
 * 一段**固定 Node 标准库脚本**（远端 Node 来自 remotePiRuntimeFacts，不新增 helper op、不碰
 * helper 的 --root 语义）。为什么不是裸 rm：shell 的 rm 会跟随符号链接、接受任意路径形状，
 * 而这里要的是「先做 canonical containment 再只 unlink 一个已验证的普通文件」：
 * - 目标必须是 `/.pideck-archive/<name>.jsonl` 形状（本模块唯一路径判据，与归档侧同名常量）；
 * - `lstat` 必须是普通文件且不是符号链接（不跟随叶子）；
 * - 父目录 `realpathSync(dir) === dir`（父链上没有符号链接重定向，canonical containment 复核）；
 * - unlink 前再 lstat 一次并比对 `(dev, ino)`（缩小检查→删除之间的替换窗口；仍非严格互锁，
 *   与既有归档 move 的边界一致）。
 *
 * 不变量（违反任何一条都是返工）：
 * - **先判后发**：hostId/路径/Node 路径不合法时一个远端命令都不发；
 * - **有界**：单条命令拼接后必须 ≤ REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH(8192)；脚本只接受一个
 *   路径参数，命令里只出现单引号字面量（路径判据已拒单引号/控制字节）；
 * - **确定失败 vs 未确认**：脚本在 unlink 之前自报的失败是确定结论（没删）；**拿不到可信回执**
 *   （ssh 断、无标记、JSON 撕裂、脚本退出码非 0）一律 `RESULT_UNCONFIRMED`——远端可能已删，
 *   绝不重试、绝不谎报「没删」；
 * - **脱敏**：本模块不记日志；错误只带稳定码，路径/命令/stderr 不外传。
 */

import { randomBytes } from "node:crypto";
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import { REMOTE_SESSION_DELETE_CODES, type RemoteSessionDeleteCode } from "../../shared/sessionDeleteCodes";
import { quotePosixArgument } from "./RemoteBootstrapContract";
import { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } from "./RemoteHelperContract";
import { REMOTE_SESSION_ARCHIVE_DIR_NAME } from "./RemoteSessionArchive";
import { remoteSessionHistoryMarker, validateRemoteSessionHistoryPath } from "./RemoteSessionHistoryReader";

/** 固定脚本压平后的预算（8192 命令上界之外的第二个、更紧的防线；脚本只增不改语义）。 */
export const REMOTE_SESSION_DELETE_SCRIPT_MAX_CHARS = 2_048;

/** 脚本自己会报告的四类确定结论（按本模块闭集折叠；其余一律 commandFailed）。 */
const SCRIPT_CODES = ["pathInvalid", "fileMissing", "fileChanged", "commandFailed"] as const;
type ScriptCode = (typeof SCRIPT_CODES)[number];

/**
 * 远端固定删除脚本（单行拼接后压平）。**只接受一个已验证的归档路径参数**；所有失败在 unlink
 * 之前抛出，因此脚本报告 error 时一定「什么都没删」。输出格式与写入守卫一致：marker + 一个 JSON。
 * argv 约定：node -e script delete <marker> <path> ⇒ process.argv.slice(2) 才是 [marker, path]。
 */
export const REMOTE_SESSION_DELETE_SCRIPT = [
	'const fs = require("node:fs"), p = require("node:path");',
	"const [marker, target] = process.argv.slice(2);",
	"function report(result) { process.stdout.write(marker + JSON.stringify(result)); }",
	"let result;",
	"try {",
	"  const dir = p.dirname(target);",
	'  if (!target.startsWith("/") || !target.endsWith(".jsonl") || p.basename(dir) !== ".pideck-archive") throw new Error("pathInvalid");',
	"  const before = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });",
	'  if (!before) throw new Error("fileMissing");',
	'  if (!before.isFile() || before.isSymbolicLink()) throw new Error("pathInvalid");',
	'  if (fs.realpathSync(dir) !== dir) throw new Error("pathInvalid");',
	"  const after = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });",
	'  if (!after || !after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new Error("fileChanged");',
	"  fs.unlinkSync(target);",
	"  result = { ok: true };",
	"} catch (error) {",
	'  const codes = ["pathInvalid", "fileMissing", "fileChanged", "commandFailed"];',
	'  result = { ok: false, code: codes.includes(error.message) ? error.message : "commandFailed" };',
	"}  ",
	"report(result);",
]
	.join(" ")
	.replace(/\s+/g, " ")
	.trim();

function stable(code: string): Error {
	return new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只透传本身已经是稳定码的 message；路径/命令行/errno 永不外传。 */
function codeOf(error: unknown, fallback: RemoteSessionDeleteCode): RemoteSessionDeleteCode {
	if (isRecord(error)) {
		const message = error.message;
		if (typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message)) return message as RemoteSessionDeleteCode;
	}
	return fallback;
}

/**
 * 归档路径纯判据：读侧同源校验 + 「必须在 `.pideck-archive` 目录下、必须是 `.jsonl`」。
 * 本模块唯一的路径入口；命令构造与运行时复核都先过它（绝不信任磁盘上的旧索引值）。
 */
export function assertRemoteSessionArchivedPath(value: unknown): string {
	const validated = validateRemoteSessionHistoryPath(value);
	if (validated === undefined) throw stable(REMOTE_SESSION_DELETE_CODES.pathInvalid);
	if (!validated.endsWith(".jsonl")) throw stable(REMOTE_SESSION_DELETE_CODES.pathInvalid);
	const separator = validated.lastIndexOf("/");
	const directory = validated.slice(0, separator);
	if (directory.length === 0 || directory.slice(directory.lastIndexOf("/") + 1) !== REMOTE_SESSION_ARCHIVE_DIR_NAME) throw stable(REMOTE_SESSION_DELETE_CODES.pathInvalid);
	return validated;
}

/** 远端 Node 路径只接受绝对路径且 basename 必须是 node（与写入守卫同一判据）。 */
function assertRemoteNodePath(value: unknown): string {
	const validated = validateRemoteSessionHistoryPath(value);
	if (validated === undefined || validated.split("/").at(-1) !== "node") throw stable(REMOTE_SESSION_DELETE_CODES.nodePathInvalid);
	return validated;
}

/**
 * 构造远端删除命令：`'<node>' -e '<script>' 'delete' '<marker>' '<archivedPath>'`。
 * 与写入守卫同一形态：固定脚本 + marker，路径只作为单引号字面量参数，不拼 shell 语法。
 * 返回 command 与 marker：调用方必须用同一个 marker 解析回执（两侧各算一份迟早漂移）。
 */
export function buildRemoteSessionDeleteCommand(input: { nodePath: unknown; archivedPath: unknown; nonce: unknown }): { command: string; marker: string } {
	const nodePath = assertRemoteNodePath(input?.nodePath);
	const archivedPath = assertRemoteSessionArchivedPath(input?.archivedPath);
	if (typeof input?.nonce !== "string" || !/^[a-f0-9]{32}$/.test(input.nonce)) throw stable(REMOTE_SESSION_DELETE_CODES.optionsInvalid);
	const marker = remoteSessionHistoryMarker(input.nonce);
	const command = [nodePath, "-e", REMOTE_SESSION_DELETE_SCRIPT, "delete", marker, archivedPath].map(quotePosixArgument).join(" ");
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) throw stable(REMOTE_SESSION_DELETE_CODES.optionsInvalid);
	return { command, marker };
}

/**
 * 解析脚本回执（纯函数，测试无需远端）。
 * - `{kind:"ok"}`：脚本确认 unlink 已执行；
 * - `{kind:"error", code}`：脚本在 unlink 前自报的**确定失败**；
 * - `{kind:"untrusted"}`：标记缺失/重复/JSON 撕裂/形状非法 ⇒ 结果未确认（退出码由调用方判）。
 */
export function parseRemoteSessionDeleteResult(stdout: string, marker: string): { kind: "ok" } | { kind: "error"; code: ScriptCode } | { kind: "untrusted" } {
	if (typeof stdout !== "string" || typeof marker !== "string" || marker.length === 0) return { kind: "untrusted" };
	const first = stdout.indexOf(marker);
	if (first < 0 || first !== stdout.lastIndexOf(marker)) return { kind: "untrusted" };
	const body = stdout.slice(first + marker.length);
	if (body.trim() !== body || body.length === 0) return { kind: "untrusted" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { kind: "untrusted" };
	}
	if (!isRecord(parsed)) return { kind: "untrusted" };
	if (parsed.ok === true) return Object.keys(parsed).length === 1 ? { kind: "ok" } : { kind: "untrusted" };
	if (parsed.ok !== false || typeof parsed.code !== "string" || !SCRIPT_CODES.includes(parsed.code as ScriptCode) || Object.keys(parsed).length !== 2) return { kind: "untrusted" };
	return { kind: "error", code: parsed.code as ScriptCode };
}

const SCRIPT_CODE_TO_DELETE_CODE: Record<ScriptCode, RemoteSessionDeleteCode> = {
	pathInvalid: REMOTE_SESSION_DELETE_CODES.pathInvalid,
	fileMissing: REMOTE_SESSION_DELETE_CODES.fileMissing,
	fileChanged: REMOTE_SESSION_DELETE_CODES.fileChanged,
	commandFailed: REMOTE_SESSION_DELETE_CODES.commandFailed,
};

export type RemoteSessionDeleteTransportPort = {
	runRemoteCommand(input: { hostId: string; remoteCommand: string }): Promise<{ exitCode: number; stdout: string }>;
};

export type RemoteSessionDeletePorts = {
	transport: RemoteSessionDeleteTransportPort;
	/** 远端 Node 路径（装配从 remotePiRuntimeFacts 取，与写入守卫同源）；缺失/非法 ⇒ NODE_PATH_INVALID。 */
	resolveNodePath: (hostId: string) => Promise<string | undefined | null>;
};

export type RemoteSessionDelete = {
	/**
	 * 删除一条已归档远端会话的远端文件。成功返回（调用方随后清理本机索引）；
	 * 任何确定失败抛闭集码；回执不可信抛 `RESULT_UNCONFIRMED`（调用方必须保留索引、不重试）。
	 */
	deleteArchived(input: { hostId: string; archivedPath: string }): Promise<void>;
};

export function createRemoteSessionDelete(ports: RemoteSessionDeletePorts): RemoteSessionDelete {
	if (!isRecord(ports) || typeof ports.transport?.runRemoteCommand !== "function" || typeof ports.resolveNodePath !== "function") throw stable(REMOTE_SESSION_DELETE_CODES.optionsInvalid);
	return {
		async deleteArchived(input) {
			const hostId = typeof input?.hostId === "string" && PROJECT_HOST_ID_PATTERN.test(input.hostId) ? input.hostId : undefined;
			if (hostId === undefined) throw stable(REMOTE_SESSION_DELETE_CODES.hostIdInvalid);
			const archivedPath = assertRemoteSessionArchivedPath(input?.archivedPath);
			let nodePath: string;
			try {
				nodePath = assertRemoteNodePath(await ports.resolveNodePath(hostId));
			} catch {
				throw stable(REMOTE_SESSION_DELETE_CODES.nodePathInvalid);
			}
			const { command, marker } = buildRemoteSessionDeleteCommand({ nodePath, archivedPath, nonce: randomBytes(16).toString("hex") });
			let result: { exitCode: number; stdout: string };
			try {
				result = await ports.transport.runRemoteCommand({ hostId, remoteCommand: command });
			} catch (error) {
				throw stable(codeOf(error, REMOTE_SESSION_DELETE_CODES.transportFailed));
			}
			if (!isRecord(result) || typeof result.stdout !== "string" || !Number.isSafeInteger(result.exitCode)) throw stable(REMOTE_SESSION_DELETE_CODES.resultUnconfirmed);
			if (result.exitCode !== 0) throw stable(REMOTE_SESSION_DELETE_CODES.resultUnconfirmed);
			const parsed = parseRemoteSessionDeleteResult(result.stdout, marker);
			if (parsed.kind === "untrusted") throw stable(REMOTE_SESSION_DELETE_CODES.resultUnconfirmed);
			if (parsed.kind === "error") throw stable(SCRIPT_CODE_TO_DELETE_CODE[parsed.code]);
		},
	};
}
