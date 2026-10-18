/**
 * 远端会话 JSONL 的**受控改写**（P4.5c：编辑消息 / 删除消息 / 准备重发）。
 *
 * 为什么偏远端也要自己改写文件：pi 的 RPC 没有 edit/delete/truncate 类命令（远端会话的历史改写只能由
 * PiDeck 做），而远端 JSONL 在远端机器上，本机 fs 读不到。三条操作改写的是**同一条** JSONL，也共用同一
 * 套冲突与原子性规则，所以本切片是一个 single-seam：拆成三份等于把写面实现三次，原子性与冲突规则迟早
 * 各漂各的。
 *
 * 通道仍是既有 **pinned SSH 短命令**（`buildPinnedSshInvocation` 每次复查 pin/指纹/路由摘要/严格配置），
 * 不新增 helper op、不改 runner 契约（与 P4.5b 归档同一条通道，由装配注入同一份传输端口）。
 *
 * 传输包络（硬约束，算术写在这里而不是口口相传）：
 * - 单条远端命令 ≤ 8192 字符（`REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH`；`buildPinnedSshInvocation`
 *   会拒掉超长命令，也拒换行/控制字节）⇒ **整份内容塞不进一条命令**：写盘按
 *   `REMOTE_SESSION_HISTORY_WRITE_CHUNK_BYTES`(4096 原始字节 → base64 5464 字符)一条命令分块追加到
 *   临时文件；
 * - 单条命令的 stdout ≤ 256 KiB（`SshClientRuntime.run` 的 maxBuffer）⇒ 读回按
 *   `REMOTE_SESSION_HISTORY_READ_CHUNK_BYTES`（96 KiB 原始字节 → base64 约 128 KiB）一条命令分块读；
 * - 因此整份改写有**总字节上界** `REMOTE_SESSION_HISTORY_WRITE_MAX_BYTES`（默认 256 KiB）：超出
 *   fail-closed（`..._FILE_TOO_LARGE`），**绝不截断改写**。这个上界是传输成本上界（命令数是 O(字节/分块)），
 *   不是并发窗口——运行中的会话在本模块之外的冲突规则里已被拒。
 *
 * 不变量（违反任何一条都是返工）：
 * - **路径判据与读取侧同源**：只走 `resolveRemoteSessionPath` / `validateRemoteSessionHistoryPath`，
 *   不抄第二套归一化；命令里只出现单引号字面量（路径在校验期已拒单引号/控制字节）与 base64 字符集
 *   （构造期正则校验，不实现转义）；
 * - **先判后发**：路径/locator/操作/分块参数不合法时一个远端命令都不发（构造命令即抛）；
 * - **原子替换与权限**：同目录 `0600` 排他临时文件写完，守卫检查版本、摘要与 uid/gid 后保留原 mode 再 rename；
 *   禁止先截断/覆盖式追加目标；临时文件不以 `.jsonl` 结尾，远端扫描不会收取；
 * - **乐观冲突检测**：读前/实际读回摘要/读后/提交前一致才替换；最终复核到 rename 仍非严格互锁；
 * - **失败即停**：破坏性动作不自动重试。提交前失败不替换目标；提交后 SSH 回执丢失可能结果未知，
 *   必须重新加载核对，不能把所有错误都当成「从未提交」，也不能谎报成功；
 * - **脱敏**：日志只记稳定码与身份（hostId/sessionId）。本模块自己不记日志：路径、正文、命令行都
 *   不返回给调用方也不落日志，调用方（协调器/IPC）只按稳定码记录。
 *
 * 内容语义与本机链路**逐字对齐**（定位 + 改写规则都照搬既有实现）：
 * - 定位：`meta.entryId` 提示 → 合成 id `${agentId}-history-${entryId}` → 裸 id，且必须落在**活动分支**上；
 * - edit = 改写该条消息的正文（多 text 块只保留第一块）；
 * - delete = 给该条写墓碑；若目标是 assistant 回答，同一轮的过程链（thinking-only assistant / toolResult
 *   祖先）一并墓碑，直接子节点重挂到被删条目的父节点；
 * - resend = 该条及其全部后继写墓碑（理由 `resend-truncate`）。
 *
 * `SessionFileEditor` 是 fs 绑定的类、其纯逻辑（parseDocument/applyMutation/tombstone…）未导出，且本切片
 * 不允许改动那个文件，所以这里按既有实现重写一份同名同义的逻辑；两侧一致性由
 * `tests/remoteSessionHistoryWrite.test.mjs` 用**真实本机编辑器**在同一份夹具上跑出结果后逐字节比对钉住，
 * 而不是靠注释声明（时间戳也用同一份 `now` 注入，保证墓碑 ts 可比）。
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { buildRemoteSessionWriteGuardCommand, isRemoteSessionWriteGuardUntrustedOutput, parseRemoteSessionWriteGuardResult, REMOTE_SESSION_WRITE_GUARD_CODES, REMOTE_SESSION_WRITE_MAX_BYTES, type RemoteSessionFileRevision } from "./RemoteSessionWriteGuard";
// hostId 与 ssh 身份判据只允许有一份：与持久化边界共用 shared 的权威取值域。
import { PROJECT_HOST_ID_PATTERN, readSshSessionLocator, type SshSessionLocator } from "../../shared/projectLocation";
import type { ImageContent } from "../../shared/types";
import { stoppedMessageFingerprint, type StoppedMessageIdentity } from "../pi/stoppedMessageIdentity";
import { REMOTE_SESSION_HISTORY_CODES, remoteSessionHistoryMarker, resolveRemoteSessionPath, validateRemoteSessionHistoryPath, type RemoteSessionHistoryProjector, type RemoteSessionHistoryRootPort } from "./RemoteSessionHistoryReader";

/** 单次读取的原始字节上界（base64 + 76 列折行后仍留在传输层 256 KiB 输出上界之下）。 */
export const REMOTE_SESSION_HISTORY_READ_CHUNK_BYTES = 96 * 1024;
/**
 * 单次写入的原始字节上界。base64 后 5462 字符，加包装与临时路径后仍远小于 pinned 通道的单命令 8192
 * 字符上界（也落在各平台 argv 长度的安全区内）。
 */
export const REMOTE_SESSION_HISTORY_WRITE_CHUNK_BYTES = 4096;
/**
 * 整份改写的内容上界（字节）。读 + 写各 O(字节/分块) 条命令，所以这个上界是**成本**上界：默认 256 KiB
 * 时读 3 条 + 写 64 条左右。超出 fail-closed 而不是截断或排队。
 */
export const REMOTE_SESSION_HISTORY_WRITE_MAX_BYTES = REMOTE_SESSION_WRITE_MAX_BYTES;

/** 本模块的稳定码词汇。 */
export const REMOTE_SESSION_HISTORY_WRITER_CODES = {
	/** 源文件在读取/上传期间变化：拒绝覆盖外部修改，调用方应重读后显式操作。 */
	fileChanged: REMOTE_SESSION_WRITE_GUARD_CODES.fileChanged,
	/** hostId 不是可用的诊断身份/传输键。 */
	hostIdInvalid: "REMOTE_SESSION_HISTORY_WRITER_HOST_ID_INVALID",
	/** locator 不是合法 ssh 身份。 */
	locatorInvalid: "REMOTE_SESSION_HISTORY_WRITER_LOCATOR_INVALID",
	/** 远端路径不可用（非绝对/含单引号/控制字节/超长）：绝不把它拼进命令行。 */
	pathInvalid: "REMOTE_SESSION_HISTORY_WRITER_PATH_INVALID",
	/** 远端路径既不是绝对路径、也推不出会话根（相对身份 + 没有根解析端口）。 */
	pathUnresolved: "REMOTE_SESSION_HISTORY_WRITER_PATH_UNRESOLVED",
	/** 传输层失败（ssh 起不来、超时、输出超上界）且自身不带稳定码。 */
	transportFailed: "REMOTE_SESSION_HISTORY_WRITER_TRANSPORT_FAILED",
	/**
	 * 提交点**之前**的远端命令失败（读、写临时文件、快照）：目标文件没被改动，本机状态必须原样不动，
	 * 调用方可以安全地重读后重试。
	 *
	 * 提交命令（rename）本身不适用这条保证：见 `resultUnconfirmed`。
	 */
	commandFailed: "REMOTE_SESSION_HISTORY_WRITER_COMMAND_FAILED",
	/**
	 * 提交命令已经发出、但它的回执丢了（传输层失败/非 0 退出/stdout 里没有可解析结果）：
	 * **rename 可能已经发生**，远端文件可能已是新内容。
	 *
	 * 为什么需要独立码：旧实现把所有提交错误都报成 `commandFailed`/「目标文件没被改动」，而守卫脚本
	 * 是「先 renameSync 再写结果」，SSH 恰好在 rename 之后断开时用户会被误导为「什么都没发生，重试即可」。
	 * 这个码的语义是「结果未确认」——必须重新加载远端会话核对，**不自动重试**（重试可能基于旧快照再写一次）。
	 */
	resultUnconfirmed: "REMOTE_SESSION_HISTORY_WRITER_RESULT_UNCONFIRMED",
	/** 读回的字节与命令请求的不一致（标记缺失/长度不符/编码非法）：输出不可信，绝不据此改写。 */
	transferInvalid: "REMOTE_SESSION_HISTORY_WRITER_TRANSFER_INVALID",
	/** 文件超出可改写上界（读 + 写都是 O(字节/分块) 条命令）。 */
	fileTooLarge: "REMOTE_SESSION_HISTORY_WRITER_FILE_TOO_LARGE",
	/** 内容不是本机链路能处理的那种 JSONL（非法 UTF-8 / 非对象行 / 重复 id / 会话头数量不符 / 父链断裂或成环）。 */
	fileInvalid: "REMOTE_SESSION_HISTORY_WRITER_FILE_INVALID",
	/** 文件里没有这条消息（或它不在活动分支上）。delete 对这种情形是 no-op，与在本机链路一致。 */
	messageNotFound: "REMOTE_SESSION_HISTORY_WRITER_MESSAGE_NOT_FOUND",
	/** 消息角色不允许该操作（edit 只允许 user/assistant；resend 只允许 user）。 */
	roleInvalid: "REMOTE_SESSION_HISTORY_WRITER_ROLE_INVALID",
	/** 操作不在取值域内（"edit" | "delete" | "resend"）。 */
	operationInvalid: "REMOTE_SESSION_HISTORY_WRITER_OPERATION_INVALID",
	/** 装配没提供写端口（实验开关关闭/旧装配）：稳定码而不是落回本机路径分支。 */
	unavailable: "REMOTE_SESSION_HISTORY_WRITER_UNAVAILABLE",
} as const;

/** 构造期参数不合法（与其它远端模块一致，构造即抛，不等到第一次改写）。 */
export const REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID = "REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID";

/**
 * 路径类稳定码的折叠：读取侧与本模块共用同一个解析实现（硬要求），但两边的码各有取值域，
 * 所以这里显式映射，而不是让 `REMOTE_SESSION_HISTORY_PATH_INVALID` 从写面接口里冒出来。
 */
const READER_PATH_CODE_TO_WRITER_CODE: Record<string, string> = {
	[REMOTE_SESSION_HISTORY_CODES.pathInvalid]: REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid,
	[REMOTE_SESSION_HISTORY_CODES.pathUnresolved]: REMOTE_SESSION_HISTORY_WRITER_CODES.pathUnresolved,
};

/** base64 载荷语法：只允许 base64 字符集（命令里因此不需要任何转义）。 */
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]*={0,2}$/;
/** 临时文件后缀用的随机串。 */
const TEMP_NONCE = /^[0-9a-f]{8,32}$/;
/** 单次调用的标记 nonce：与读取侧 `remoteSessionHistoryMarker` 同一形状（本地随机 hex）。 */
const MARKER_NONCE = /^[A-Za-z0-9]{8,64}$/;

/**
 * 稳定码错误：`message` 本身就是码（远端 IPC 一系的既有约定），可选携带**展示参数**
 * （目前只有体积：本机文案的 `{sizeMb}` / `{limitMb}` 要拿到真实上界，不能拿本机的 32MB 兜底骗人）。
 */
export class RemoteSessionHistoryWriteError extends Error {
	readonly details?: Record<string, unknown>;

	constructor(code: string, details?: Record<string, unknown>) {
		super(code);
		this.name = "RemoteSessionHistoryWriteError";
		this.details = details;
	}
}

/**
 * 把任意错误折叠成「稳定码 + 展示参数」（跨 realm 的 Error 取不到 instanceof，所以按 message 形状认码）。
 * 调用方据此把码映射成会话命令错误码，不需要知道本模块内部的异常类型。
 */
export function remoteSessionHistoryWriteFailure(error: unknown): { code: string; details?: Record<string, unknown> } {
	if (isRecord(error)) {
		const message = error.message;
		if (typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message)) {
			const details = error.details;
			return isRecord(details) ? { code: message, details } : { code: message };
		}
	}
	return { code: REMOTE_SESSION_HISTORY_WRITER_CODES.transportFailed };
}

function stable(code: string, details?: Record<string, unknown>): RemoteSessionHistoryWriteError {
	return new RemoteSessionHistoryWriteError(code, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只让本身已经是稳定码的 message 通过；其余折叠成 fallback（路径/命令行/errno 永不外传）。 */
function codeOf(error: unknown, fallback: string): string {
	if (isRecord(error)) {
		const message = error.message;
		if (typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message)) return message;
	}
	return fallback;
}

// ---------------------------------------------------------------------------
// 远端命令（纯函数：测试直接断言命令行形状与顺序）
// ---------------------------------------------------------------------------

/** 失败即抛：像构造命令这类「先判后发」的边界，判据不合法就一个远端命令都不发。 */
function requireMarkerNonce(value: unknown): string {
	if (typeof value !== "string" || !MARKER_NONCE.test(value)) throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	return value;
}

/**
 * 分块读取命令：`printf '<marker>'; [wc -c < '<path>';] tail -c +<start> -- '<path>' | head -c <count> | base64`。
 *
 * 为什么带标记：ssh 非交互会话仍可能 source `~/.bashrc`（nvm 初始化就是这样）往 stdout 里混登录横幅，
 * 前导噪声因此不会走进解析——标记与解析共用一个函数（`remoteSessionHistoryMarker`），两侧不会漂移。
 * 为什么 base64：改写要把读回的字节**原样**写回去，逐字节可比；按文本读会被非 UTF-8 字节/替换字符污染。
 * 为什么把 `wc -c` 放进第一条：分块循环需要文件大小才知道总长度与「读完了没有」。
 */
export function buildRemoteSessionHistoryChunkReadCommand(input: { remotePath: unknown; start: unknown; count: unknown; nonce: unknown; withSize?: boolean }): string {
	const remotePath = validateRemoteSessionHistoryPath(input?.remotePath);
	if (remotePath === undefined) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid);
	const start = input?.start;
	const count = input?.count;
	if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1) throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > REMOTE_SESSION_HISTORY_READ_CHUNK_BYTES) throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	const marker = `printf '${remoteSessionHistoryMarker(requireMarkerNonce(input?.nonce))}'`;
	const size = input.withSize ? `wc -c < '${remotePath}'; ` : "";
	return `${marker}; ${size}tail -c +${start} -- '${remotePath}' | head -c ${count} | base64`;
}

/**
 * 分块写入命令：`printf '%s' '<base64>' | base64 -d > '<临时路径>'`（后续块用 `>>`）。
 *
 * `>` 只作用于**临时文件**（目标文件在最后一步被 `mv` 原子替换），所以「先截断」在这里不成立；
 * 载荷是构造期校验过字符集的 base64，命令里除了单引号字面量没有别的语法。
 */
export function buildRemoteSessionHistoryChunkWriteCommand(input: { remotePath: unknown; chunk: unknown; append?: boolean }): string {
	const remotePath = validateRemoteSessionHistoryPath(input?.remotePath);
	if (remotePath === undefined) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid);
	if (typeof input?.chunk !== "string" || input.chunk.length === 0 || input.chunk.length > Math.ceil(REMOTE_SESSION_HISTORY_WRITE_CHUNK_BYTES / 3) * 4 || !BASE64_PAYLOAD.test(input.chunk)) throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	return `${input.append === true ? "" : "umask 077; set -C; "}printf '%s' '${input.chunk}' | base64 -d ${input.append === true ? ">>" : ">"} '${remotePath}'`;
}

/** 原子替换命令：`mv -- '<临时路径>' '<目标路径>'`（同一目录 ⇒ 同一文件系统 ⇒ rename 原子）。 */
export function buildRemoteSessionHistoryReplaceCommand(input: { from: unknown; to: unknown }): string {
	const from = validateRemoteSessionHistoryPath(input?.from);
	const to = validateRemoteSessionHistoryPath(input?.to);
	if (from === undefined || to === undefined) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid);
	return `mv -- '${from}' '${to}'`;
}

/** 同目录临时路径：`<目录>/.<文件名>.<nonce>.pideck-tmp`（不以 `.jsonl` 结尾 ⇒ 远端扫描不会捡走它）。 */
export function remoteSessionHistoryTempPath(remotePath: unknown, nonce: unknown): string {
	const validated = validateRemoteSessionHistoryPath(remotePath);
	if (validated === undefined) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid);
	if (typeof nonce !== "string" || !TEMP_NONCE.test(nonce)) throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	const separator = validated.lastIndexOf("/");
	const directory = validated.slice(0, separator);
	const name = validated.slice(separator + 1);
	// `validateRemoteSessionHistoryPath` 已拒 `/` 结尾与空串 ⇒ 目录与文件名都非空（防御性复查）。
	if (directory.length === 0 || name.length === 0) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid);
	const tempPath = `${directory}/.${name}.${nonce}.pideck-tmp`;
	if (validateRemoteSessionHistoryPath(tempPath) === undefined) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid);
	return tempPath;
}

/**
 * 解析一次分块读取的 stdout（纯函数）：`<marker>[<文件字节数>\n]<base64>`。
 *
 * 折行由远端 `base64` 决定（GNU 默认 76 列），所以解码前把空白全部去掉再校验字符集。`expectedBytes`
 * 给了就校验长度（每块少一个字节都说明这次读不可信）；首块还不知道文件大小时由调用方拿到 size 后再校验。
 */
export function parseRemoteSessionHistoryChunk(stdout: unknown, input: { marker?: unknown; withSize?: boolean; expectedBytes?: unknown }): { size?: number; bytes: Buffer } {
	if (typeof stdout !== "string" || typeof input?.marker !== "string") throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
	const markerIndex = stdout.indexOf(input.marker);
	if (markerIndex < 0) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
	let rest = stdout.slice(markerIndex + input.marker.length);
	let size: number | undefined;
	if (input.withSize === true) {
		const newline = rest.indexOf("\n");
		// BSD `wc -c` 会右对齐补空格，所以取整前先 trim。
		const text = newline < 0 ? "" : rest.slice(0, newline).trim();
		if (!/^\d{1,20}$/.test(text)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
		size = Number(text);
		if (!Number.isSafeInteger(size)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
		rest = rest.slice(newline + 1);
	}
	const payload = rest.replace(/\s+/g, "");
	const expectedBytes = input?.expectedBytes;
	if (!BASE64_PAYLOAD.test(payload)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
	const bytes = Buffer.from(payload, "base64");
	if (expectedBytes !== undefined && (typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || bytes.length !== expectedBytes)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
	return size === undefined ? { bytes } : { size, bytes };
}

// ---------------------------------------------------------------------------
// 端口与入口
// ---------------------------------------------------------------------------

/** 远端短命令传输端口：与读取/归档同一条 pinned SSH 通道，由装配注入同一份实现。 */
export type RemoteSessionHistoryWriterTransportPort = {
	runRemoteCommand(input: { hostId: string; remoteCommand: string }): Promise<{ exitCode: number; stdout: string }>;
};

export type RemoteSessionHistoryWriterPorts = {
	transport: RemoteSessionHistoryWriterTransportPort;
	/** 既有连接服务已验证的远端 Node，不能临时走 PATH 或本机解释器兜底。 */
	resolveNodePath?: (hostId: string) => Promise<string>;
	/** 与远端读取侧共用的投影器：停止后按内容摘要恢复 live ID，只作唯一匹配，不能模糊挑选。 */
	project?: RemoteSessionHistoryProjector;
	/** 相对身份需要它；缺失时相对 identity 以 `PATH_UNRESOLVED` fail-closed（绝不猜会话根）。 */
	resolveSessionRoot?: RemoteSessionHistoryRootPort;
	/** 墓碑/context_edit 时间戳（测试注入固定时钟，好与本机编辑器逐字节比对）。 */
	now?: () => number;
	/** context_edit 记录 id（测试注入固定序列做逐字节比对；缺省 randomUUID）。 */
	createUuid?: () => string;
	/** 只允许调小（测试用）；缺省 256 KiB。 */
	maxFileBytes?: number;
	/** 只允许调小（测试用）；缺省 96 KiB。 */
	readChunkBytes?: number;
	/** 只允许调小（测试用）；缺省 4096。 */
	writeChunkBytes?: number;
};

export type RemoteSessionMessageOperation = "edit" | "delete" | "resend";

export type RemoteSessionMessageMutationInput = {
	hostId: string;
	locator: SshSessionLocator;
	operation: RemoteSessionMessageOperation;
	/** 渲染层消息 id（live randomUUID 或合成 `${agentId}-history-${entryId}`）。 */
	messageId: string;
	/** 渲染层消息携带的文件条目 id（meta.entryId），首选锚点。 */
	entryId?: string;
	/** 协调器在停止前留存的有界身份摘要；仅内部传递，渲染层不能提供它。 */
	stoppedIdentity?: StoppedMessageIdentity;
	/** edit 的新正文；其余操作忽略。 */
	newText?: string;
};

/** 协调器依赖的窄接口：三条操作都只经这一个写面。 */
export type RemoteSessionMessageMutationPort = {
	mutate(input: RemoteSessionMessageMutationInput): Promise<{ text: string; images?: ImageContent[] } | undefined>;
};

// ---------------------------------------------------------------------------
// JSONL 文档（与本机 SessionFileEditor 同一套行/条目模型）
// ---------------------------------------------------------------------------

type JsonlEntry = Record<string, unknown>;

type JsonlLine = {
	content: string;
	eol: string;
	entry?: JsonlEntry;
};

type JsonlDocument = {
	lines: JsonlLine[];
	entryLineById: Map<string, number>;
};

type LocatedEntry = { lineIndex: number; entry: JsonlEntry; entryId: string };

/** 按行切分并**保留原始行尾**（`\n` / `\r\n` / `\r`）：未改动的行因此逐字节写回。 */
function splitJsonl(text: string): JsonlLine[] {
	if (!text) return [];
	const lines: JsonlLine[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (character !== "\r" && character !== "\n") continue;
		let eol = character;
		if (character === "\r" && text[index + 1] === "\n") {
			eol = "\r\n";
			index += 1;
		}
		const end = index + 1 - eol.length;
		lines.push({ content: text.slice(start, end), eol });
		start = index + 1;
	}
	if (start < text.length) lines.push({ content: text.slice(start), eol: "" });
	return lines;
}

function entryIdOf(entry: JsonlEntry): string | undefined {
	if (typeof entry.id === "string" && entry.id) return entry.id;
	if (typeof entry.entryId === "string" && entry.entryId) return entry.entryId;
	return undefined;
}

function parentIdOf(entry: JsonlEntry): string | null | undefined {
	if (entry.parentId === null) return null;
	return typeof entry.parentId === "string" ? entry.parentId : undefined;
}

function messageOf(entry: JsonlEntry): Record<string, unknown> | undefined {
	return isRecord(entry.message) ? entry.message : undefined;
}

function roleOf(entry: JsonlEntry): string | undefined {
	const role = messageOf(entry)?.role;
	return typeof role === "string" ? role : undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is Record<string, unknown> => isRecord(block))
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text))
		.join("");
}

/** 与 `SessionFileEditor.setMessageText` 同一套规则：多 text 块只保留第一块，其余原样留在原位。 */
function setMessageText(message: Record<string, unknown>, text: string): void {
	const content = message.content;
	if (typeof content === "string") {
		message.content = text;
		return;
	}
	if (Array.isArray(content)) {
		const next: unknown[] = [];
		let replacedText = false;
		for (const candidate of content) {
			if (!isRecord(candidate) || candidate.type !== "text") {
				next.push(candidate);
				continue;
			}
			if (replacedText) continue;
			next.push({ ...candidate, text });
			replacedText = true;
		}
		if (!replacedText) next.push({ type: "text", text });
		content.splice(0, content.length, ...next);
		return;
	}
	message.content = [{ type: "text", text }];
}

/** 改一行：条目与它的序列化正文一起换掉（未改动的行保持原字节）。 */
function replaceLine(document: JsonlDocument, lineIndex: number, entry: JsonlEntry): void {
	document.lines[lineIndex].entry = entry;
	document.lines[lineIndex].content = JSON.stringify(entry);
}

/**
 * 墓碑。必须保留 id + parentId：pi `SessionManager._buildIndex` 把文件里最后一条带 id 的记录当 leaf，
 * 再沿 parentId 回溯活动分支；只写 `originalEntryId` 的旧墓碑会让 leaf 落在一条无父节点的记录上，
 * `get_messages` 整页变空。
 */
function tombstone(entryId: string, now: number, parentId?: string | null, reason?: string): JsonlEntry {
	return {
		type: "deleted",
		id: entryId,
		originalEntryId: entryId,
		parentId: parentId ?? null,
		ts: now,
		...(reason ? { reason } : {}),
	};
}

/**
 * 文档解析（失败一律 `FILE_INVALID`）：与非 UTF-8 / 非对象行 / 重复 id / 会话头数量不符 / 父链断裂或成环
 * 的情形都拒绝——本机编辑器会拒，写面就必须拒（否则同一份输入在两条链路上得到不同结果）。
 */
function parseDocument(text: string): JsonlDocument {
	const lines = splitJsonl(text);
	if (!lines.some((line) => line.content.trim())) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid);
	const entryLineById = new Map<string, number>();
	let sessionHeaderCount = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.content.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line.content);
		} catch {
			throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid);
		}
		if (!isRecord(parsed)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid);
		line.entry = parsed;
		if (line.entry.type === "session") sessionHeaderCount += 1;
		const entryId = entryIdOf(line.entry);
		if (!entryId) continue;
		if (entryLineById.has(entryId)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid);
		entryLineById.set(entryId, index);
	}
	if (sessionHeaderCount !== 1) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid);
	for (const [entryId, lineIndex] of entryLineById) {
		const parentId = parentIdOf(lines[lineIndex].entry!);
		if (parentId && !entryLineById.has(parentId)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid);
	}
	const completed = new Set<string>();
	for (const entryId of entryLineById.keys()) {
		const visiting = new Set<string>();
		let current: string | null | undefined = entryId;
		while (current && !completed.has(current)) {
			if (visiting.has(current)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid);
			visiting.add(current);
			const lineIndex = entryLineById.get(current);
			current = lineIndex === undefined ? undefined : parentIdOf(lines[lineIndex].entry!);
		}
		for (const visited of visiting) completed.add(visited);
	}
	return { lines, entryLineById };
}

function serializeDocument(document: JsonlDocument): Buffer {
	return Buffer.from(document.lines.map((line) => `${line.content}${line.eol}`).join(""), "utf8");
}

/**
 * 活动分支：无显式 leaf 时取**文件里最后一条带 id 且不是墓碑**的记录，再沿 parentId 回溯。
 * 与本机 `SessionFileEditor.activeBranchIds` 同一条规则（远端没有 RPC leaf，也不该用 RPC leaf 代替）。
 */
function activeBranchIds(document: JsonlDocument): Set<string> {
	let leafId: string | undefined;
	for (let index = document.lines.length - 1; index >= 0; index -= 1) {
		const entry = document.lines[index].entry;
		if (!entry || entry.type === "deleted") continue;
		const candidate = entryIdOf(entry);
		if (candidate) {
			leafId = candidate;
			break;
		}
	}
	if (!leafId) return new Set();
	const result = new Set<string>();
	let current: string | null | undefined = leafId;
	while (current && !result.has(current)) {
		result.add(current);
		const lineIndex = document.entryLineById.get(current);
		if (lineIndex === undefined) break;
		current = parentIdOf(document.lines[lineIndex].entry!);
	}
	return result;
}

/**
 * 定位目标条目（返回 undefined = 文件里没有这条消息）。与本机 `readMessageByMessageId` 同一套锚点：
 * `entryId` 提示优先（live randomUUID 在文件里必然不存在），其次渲染层合成 id 里的 entryId，再是裸 id；
 * 命中还必须落在**活动分支**上（被 rewind/fork 甩掉的旧分支条目不算，改它们等于改用户看不到的历史）。
 */
function locateEntry(document: JsonlDocument, input: { messageId: string; entryId?: string; stoppedIdentity?: StoppedMessageIdentity }, project?: RemoteSessionHistoryProjector): LocatedEntry | undefined {
	const branchIds = activeBranchIds(document);
	const resolvedHint = input.entryId ?? input.stoppedIdentity?.entryId;
	const candidates: Array<string | undefined> = [resolvedHint, syntheticHistoryEntryId(input.messageId), input.messageId];
	for (const candidate of candidates) {
		if (!candidate || !branchIds.has(candidate)) continue;
		const lineIndex = document.entryLineById.get(candidate);
		if (lineIndex === undefined) continue;
		const entry = document.lines[lineIndex].entry!;
		if (entry.type !== "message") continue;
		return { lineIndex, entry, entryId: candidate };
	}
	// 实时 ID 不在 JSONL：与本机读者同一判据（活动分支、同角色、5 秒时间窗、完整内容摘要唯一命中）。
	// 不按「最近一条相同文本」猜身份，重复 prompt/离支记录/未落盘消息必须拒绝，不能误改。
	const identity = input.stoppedIdentity;
	if (resolvedHint !== undefined || !identity || !project || !Number.isFinite(identity.timestamp)) return undefined;
	const matches: LocatedEntry[] = [];
	const nearby: LocatedEntry[] = [];
	for (const entryId of branchIds) {
		const lineIndex = document.entryLineById.get(entryId);
		if (lineIndex === undefined) continue;
		const entry = document.lines[lineIndex].entry;
		if (!entry || entry.type !== "message" || roleOf(entry) !== identity.role) continue;
		const raw = messageOf(entry);
		const timestamp = typeof raw?.timestamp === "number" ? raw.timestamp : typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
		if (Math.abs(timestamp - identity.timestamp) <= 5000) nearby.push({ lineIndex, entry, entryId });
	}
	if (nearby.length > 256) return undefined;
	for (const candidate of nearby) {
		const projected = project([messageOf(candidate.entry)], [candidate.entryId]);
		if (projected.some((message) => message.role === identity.role && stoppedMessageFingerprint(message) === identity.fingerprint)) matches.push(candidate);
	}
	return matches.length === 1 ? matches[0] : undefined;
}

/** 渲染层合成消息 id（`${agentId}-history-${entryId}`）→ entryId。 */
function syntheticHistoryEntryId(messageId: string): string | undefined {
	const marker = "-history-";
	const index = messageId.lastIndexOf(marker);
	if (index < 0) return undefined;
	const entryId = messageId.slice(index + marker.length);
	return entryId || undefined;
}

/** 该条及其全部后继（沿 parentId 正向闭包）；墓碑不参与。 */
function descendantEntryIds(document: JsonlDocument, rootEntryId: string): Set<string> {
	const descendants = new Set<string>([rootEntryId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const line of document.lines) {
			const entry = line.entry;
			if (!entry || entry.type === "deleted") continue;
			const entryId = entryIdOf(entry);
			const parentId = parentIdOf(entry);
			if (!entryId || !parentId || !descendants.has(parentId) || descendants.has(entryId)) continue;
			descendants.add(entryId);
			changed = true;
		}
	}
	return descendants;
}

/**
 * 同一轮回答的**过程节点**：toolResult，以及「只带思考、没有可见文本」的 assistant。
 * 删掉回答时它们必须一起墓碑——否则会被 `groupToolMessages` 并进下一轮回答（用户反馈过的串台）。
 */
function isProcessNode(entry: JsonlEntry | undefined): entry is JsonlEntry {
	if (!entry || entry.type !== "message") return false;
	const role = roleOf(entry);
	if (role === "toolResult") return true;
	if (role !== "assistant") return false;
	const content = messageOf(entry)?.content;
	const hasThinking = Array.isArray(content) ? content.some((block) => isRecord(block) && block.type === "thinking" && typeof block.thinking === "string" && String(block.thinking).trim() !== "") : false;
	return hasThinking && !textOf(content).trim();
}

/**
 * 会话文件当前叶节点（新追加条目的 parentId）：跳过 `session` 头，取最后一条带 id 的条目。
 * 与 `SessionFileEditor.currentLeafId` / pi `SessionManager._buildIndex` 同一条规则：
 * 编辑/删除之后追加的 `context_edit` 才是真正的叶，跳过它会把新记录挂成平行分支。
 */
function currentLeafId(document: JsonlDocument): string | null {
	for (let index = document.lines.length - 1; index >= 0; index -= 1) {
		const entry = document.lines[index].entry;
		if (!entry || entry.type === "session") continue;
		const candidate = entryIdOf(entry);
		if (candidate) return candidate;
	}
	return null;
}

/**
 * 追加一条 pi 原生 `context_edit` 记录（pi docs/session-format.md#context_edit）。
 *
 * 形状与顺序必须与本机 `SessionFileEditor.appendContextEdit` 逐字节一致（含 JSON key 顺序）：
 * 远端与本地写的是同一份会话历史，两种格式会让同一条消息在两个入口里表现不同。
 * 连续追加多条时按顺序串成 parent 链——都挂在同一个 parent 上会让后一条成为侧分支而静默失效。
 */
function appendContextEdit(document: JsonlDocument, targetId: string, replacement: { content: unknown } | null, now: number, createUuid: () => string): void {
	const entry: JsonlEntry = {
		type: "context_edit",
		id: createUuid(),
		parentId: currentLeafId(document),
		timestamp: new Date(now).toISOString(),
		targetId,
		replacement,
	};
	const eol = document.lines.length > 0 ? document.lines[document.lines.length - 1].eol || "\n" : "\n";
	document.lines.push({ content: JSON.stringify(entry), eol, entry });
	document.entryLineById.set(entry.id as string, document.lines.length - 1);
}

/**
 * 「只改文本」的替换内容（保留图片 / 工具块等其它块）：与 `SessionFileEditor.replaceTextInContent` 同语义。
 * 不能直接拿 newText 当 content：pi 会用 replacement.content **整体**替换消息内容，图片会被纯文本顶掉。
 */
function replaceTextInContent(content: unknown, text: string): unknown {
	if (typeof content === "string") return text;
	if (!Array.isArray(content)) return [{ type: "text", text }];
	const next: unknown[] = [];
	let replaced = false;
	for (const candidate of content) {
		const isText = Boolean(isRecord(candidate) && candidate.type === "text");
		if (!isText) {
			next.push(candidate);
			continue;
		}
		if (replaced) continue;
		next.push({ ...candidate, text });
		replaced = true;
	}
	if (!replaced) next.push({ type: "text", text });
	return next;
}

/** 三种改写的规则（与本机 `SessionFileEditor.applyMutation` 逐条对应）。 */
function applyMutation(document: JsonlDocument, located: LocatedEntry, kind: RemoteSessionMessageOperation, now: number, newText: string | undefined, createUuid: () => string): void {
	if (kind === "edit") {
		const message = messageOf(located.entry);
		if (!message || (message.role !== "user" && message.role !== "assistant")) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.roleInvalid);
		// 2026-11 语义（与本机 SessionFileEditor 同步）：改写不是原地改文本，而是追加 pi 原生
		// `context_edit` —— 原文行保留（可追溯/可撤销），只有模型下次看到的上下文被替换。
		appendContextEdit(document, located.entryId, { content: replaceTextInContent(message.content, newText ?? "") }, now, createUuid);
		return;
	}

	if (kind === "delete") {
		const targets = [located.entryId];
		if (roleOf(located.entry) === "assistant") {
			// 同一轮的过程链（toolResult / thinking-only assistant）必须一起移出上下文：
			// 留着会被 groupToolMessages 并进下一轮回答（用户反馈过的串台）。
			// 沿父链上溯，遇到 user 或带文本的 assistant（上一段回答）即停：那是用户要保留的边界。
			let cursor = parentIdOf(located.entry);
			while (cursor) {
				const lineIndex = document.entryLineById.get(cursor);
				if (lineIndex === undefined) break;
				const ancestor = document.lines[lineIndex].entry;
				if (!ancestor || !isProcessNode(ancestor)) break;
				targets.push(cursor);
				cursor = parentIdOf(ancestor);
			}
		}
		// 删除 = 追加 `replacement: null`（把目标移出模型上下文）。目标行不改写，
		// 所以子节点不需要重挂——重挂只对「把目标行替换成墓碑」的旧语义成立。
		for (const targetId of targets) appendContextEdit(document, targetId, null, now, createUuid);
		return;
	}

	if (roleOf(located.entry) !== "user") throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.roleInvalid);
	const removeIds = descendantEntryIds(document, located.entryId);
	for (let index = 0; index < document.lines.length; index += 1) {
		const entry = document.lines[index].entry;
		if (!entry || entry.type === "deleted") continue;
		const entryId = entryIdOf(entry);
		if (!entryId || !removeIds.has(entryId)) continue;
		replaceLine(document, index, tombstone(entryId, now, parentIdOf(entry), "resend-truncate"));
	}
}

/**
 * 重发要带回输入框的原文（与本机 `SessionHistoryReader.extractResendContent` 同一规则：
 * 文本块按序拼接，参考图只认 `image/source:{type:"base64"}`）。
 */
function extractResendContent(content: unknown): { text: string; images?: ImageContent[] } {
	if (typeof content === "string") return { text: content };
	if (!Array.isArray(content)) return { text: "" };
	const textParts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		const source = isRecord(block.source) ? block.source : undefined;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		} else if (block.type === "image" && source?.type === "base64" && typeof source.data === "string") {
			images.push({
				type: "image",
				mimeType: typeof source.media_type === "string" ? source.media_type : "image/png",
				data: source.data,
			});
		}
	}
	return { text: textParts.join("\n"), ...(images.length > 0 ? { images } : {}) };
}

// ---------------------------------------------------------------------------
// 写面本体
// ---------------------------------------------------------------------------

export type RemoteSessionHistoryWriter = RemoteSessionMessageMutationPort;

export function createRemoteSessionHistoryWriter(ports: RemoteSessionHistoryWriterPorts): RemoteSessionHistoryWriter {
	if (!isRecord(ports) || typeof ports.transport?.runRemoteCommand !== "function" || (ports.project !== undefined && typeof ports.project !== "function") || (ports.resolveNodePath !== undefined && typeof ports.resolveNodePath !== "function")) throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	const maxFileBytes = ports.maxFileBytes ?? REMOTE_SESSION_HISTORY_WRITE_MAX_BYTES;
	const readChunkBytes = ports.readChunkBytes ?? REMOTE_SESSION_HISTORY_READ_CHUNK_BYTES;
	const writeChunkBytes = ports.writeChunkBytes ?? REMOTE_SESSION_HISTORY_WRITE_CHUNK_BYTES;
	const now = ports.now ?? Date.now;
	const createUuid = ports.createUuid ?? randomUUID;
	if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > REMOTE_SESSION_HISTORY_WRITE_MAX_BYTES) throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	if (!Number.isSafeInteger(readChunkBytes) || readChunkBytes < 1 || readChunkBytes > REMOTE_SESSION_HISTORY_READ_CHUNK_BYTES) throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	if (!Number.isSafeInteger(writeChunkBytes) || writeChunkBytes < 1 || writeChunkBytes > REMOTE_SESSION_HISTORY_WRITE_CHUNK_BYTES) throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	if (typeof now !== "function" || typeof createUuid !== "function") throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);

	/** hostId 要在发帧前就能当诊断身份与传输键用；非法值不回显（与读取侧同判据）。 */
	function readHostId(value: unknown): string | undefined {
		return typeof value === "string" && PROJECT_HOST_ID_PATTERN.test(value) ? value : undefined;
	}

	/** 发一条远端命令：失败一律折叠成稳定码，stderr 不外传（连接层自己的稳定码原样转述）。 */
	async function run(hostId: string, command: string): Promise<{ exitCode: number; stdout: string }> {
		let result: { exitCode: number; stdout: string };
		try {
			result = await ports.transport.runRemoteCommand({ hostId, remoteCommand: command });
		} catch (error) {
			throw stable(codeOf(error, REMOTE_SESSION_HISTORY_WRITER_CODES.transportFailed));
		}
		if (!isRecord(result) || typeof result.stdout !== "string" || !Number.isSafeInteger(result.exitCode)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transportFailed);
		return { exitCode: result.exitCode, stdout: result.stdout };
	}

	/**
	 * 分块读回整份文件（有界）。
	 *
	 * 三条防线：大小先判上界（超出 fail-closed，不读完）、每块长度必须与请求一致（少一字节即拒绝，
	 * 绝不写回半截内容）、循环次数由「大小 / 分块」自然有界。UTF-8 解码用 fatal：文件里有非法字节时
	 * 本机链路同样拒绝（`SESSION_FILE_INVALID_JSONL`），这里也必须拒绝——否则写回时会把替换字符写进历史。
	 */
	async function readRemoteFile(hostId: string, remotePath: string): Promise<{ text: string; digest: string }> {
		const nonce = randomBytes(8).toString("hex");
		const marker = remoteSessionHistoryMarker(nonce);
		const chunks: Buffer[] = [];
		let assembled = 0;
		let size: number | undefined;
		for (;;) {
			const start = assembled + 1;
			const count = size === undefined ? readChunkBytes : Math.min(readChunkBytes, size - assembled);
			const command = buildRemoteSessionHistoryChunkReadCommand({ remotePath, start, count, nonce, withSize: size === undefined });
			const result = await run(hostId, command);
			// 非 0 = 没读到（文件不在/权限/对端 shell 不认命令）：不重试、不猜测。
			if (result.exitCode !== 0) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed);
			const parsed = parseRemoteSessionHistoryChunk(result.stdout, { marker, withSize: size === undefined, expectedBytes: size === undefined ? undefined : Math.min(count, size - assembled) });
			if (size === undefined) {
				size = parsed.size;
				if (size === undefined || size === 0) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid);
				if (size > maxFileBytes) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileTooLarge, { size, limit: maxFileBytes });
			}
			// 长度必须**恰好**等于请求的分块（首块在拿到 size 后才算得出）：少一个字节都说明这次读不可信，
			// 宁可拒绝也不把半截历史写回去。
			const expected = Math.min(count, size - assembled);
			if (parsed.bytes.length !== expected) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
			chunks.push(parsed.bytes);
			assembled += parsed.bytes.length;
			if (assembled >= size) break;
		}
		try {
			const bytes = Buffer.concat(chunks);
			return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), digest: createHash("sha256").update(bytes).digest("hex") };
		} catch {
			throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid);
		}
	}

	/** 身份+摘要在读前、读后和最后一次远端提交命令中复核；不冒充内核 compare-and-swap。 */
	async function snapshot(hostId: string, nodePath: string, remotePath: string): Promise<RemoteSessionFileRevision> {
		const nonce = randomBytes(8).toString("hex");
		const result = await run(hostId, buildRemoteSessionWriteGuardCommand({ operation: "snapshot", nodePath, remotePath, nonce, maxBytes: maxFileBytes }));
		if (result.exitCode !== 0) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed);
		const revision = parseRemoteSessionWriteGuardResult(result.stdout, remoteSessionHistoryMarker(nonce));
		if (!revision) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
		return revision;
	}

	/**
	 * 私密临时文件分块写完 → 验证源版本与上传摘要 → 保留权限并同目录原子替换。
	 *
	 * 失败分两类，**不能混用**（F5，security review §(f)）：
	 * - 提交命令之前（分块写临时文件）失败 ⇒ `commandFailed`：目标文件一个字节都没动，可以安全地重读后重试；
	 * - 提交命令本身失败 ⇒ `resultUnconfirmed`：守卫脚本的执行顺序是「校验 → renameSync → 写结果」，
	 *   传输层断开、非 0 退出、或 stdout 里没有可解析结果时，rename **可能已经发生**。旧实现把它归成
	 *   `commandFailed`（注释还写着「目标文件没被改动」），用户会被告知「重试即可」——那是基于错误前提的重试。
	 *   这个分支绝不自动重试，也绝不谎报成功；调用方/渲染层必须重新加载核对（见 coordinator 的错误映射）。
	 *
	 * 临时文件上传为 0600；本切片不自动删除远端文件（未确认时残留的 `.pideck-tmp` 不在本切片的清理面内）。
	 */
	async function writeRemoteFile(hostId: string, nodePath: string, remotePath: string, bytes: Buffer, source: RemoteSessionFileRevision): Promise<void> {
		if (bytes.length > maxFileBytes) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileTooLarge, { size: bytes.length, limit: maxFileBytes });
		const tempPath = remoteSessionHistoryTempPath(remotePath, randomBytes(8).toString("hex"));
		for (let offset = 0; offset < bytes.length; offset += writeChunkBytes) {
			const chunk = bytes.subarray(offset, offset + writeChunkBytes).toString("base64");
			const result = await run(hostId, buildRemoteSessionHistoryChunkWriteCommand({ remotePath: tempPath, chunk, append: offset > 0 }));
			if (result.exitCode !== 0) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed);
		}
		const nonce = randomBytes(8).toString("hex");
		const marker = remoteSessionHistoryMarker(nonce);
		let replaced: { exitCode: number; stdout: string };
		try {
			replaced = await run(hostId, buildRemoteSessionWriteGuardCommand({ operation: "commit", nodePath, remotePath, temporaryPath: tempPath, source, nonce, maxBytes: maxFileBytes, nextDigest: createHash("sha256").update(bytes).digest("hex"), nextSize: bytes.length }));
		} catch {
			// 传输层抛错（ssh 断开/超时/输出超上界）：命令已发出，rename 是否发生无法从本地判断。
			throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed);
		}
		if (replaced.exitCode !== 0) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed);
		let revision: RemoteSessionFileRevision | undefined;
		try {
			revision = parseRemoteSessionWriteGuardResult(replaced.stdout, marker);
		} catch (error) {
			// 输出不可信（标记缺失/JSON 撕裂/形状非法）⇒ 无法证明 rename 没发生 ⇒ 未确认。
			// 但脚本亲自报告的守卫码（fileChanged/transferInvalid 等）是**提交前**的明确拒绝（result 只在
			// catch 里写，rename 之后只会写 {ok:true}），必须原样保留——把它们也折叠成「未确认」会让冲突诊断失真。
			if (isRemoteSessionWriteGuardUntrustedOutput(error)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed);
			throw error;
		}
		// commit 动作的成功应答是 {ok:true}（没有 revision）；带 revision 说明这不是本次提交的结果，输出不可信。
		if (revision !== undefined) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
	}

	async function resolveRemotePath(input: { hostId: string; locator: SshSessionLocator }): Promise<string> {
		try {
			return await resolveRemoteSessionPath({ hostId: input.hostId, locator: input.locator, resolveSessionRoot: ports.resolveSessionRoot });
		} catch (error) {
			const code = codeOf(error, REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid);
			throw stable(READER_PATH_CODE_TO_WRITER_CODE[code] ?? REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid);
		}
	}

	return {
		async mutate(input) {
			const hostId = readHostId(input?.hostId);
			if (hostId === undefined) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.hostIdInvalid);
			const locator = readSshSessionLocator(input?.locator);
			if (locator === undefined || locator.hostId !== hostId) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.locatorInvalid);
			const operation = input?.operation;
			if (operation !== "edit" && operation !== "delete" && operation !== "resend") throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.operationInvalid);
			const messageId = typeof input?.messageId === "string" ? input.messageId : "";
			const entryId = typeof input?.entryId === "string" && input.entryId.length > 0 ? input.entryId : undefined;
			// 先判后发：路径解析成功之前一条远端命令都不发。
			const remotePath = await resolveRemotePath({ hostId, locator });
			if (!ports.resolveNodePath) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.unavailable);
			let nodePath: string;
			try {
				nodePath = await ports.resolveNodePath(hostId);
			} catch (error) {
				throw stable(codeOf(error, REMOTE_SESSION_HISTORY_WRITER_CODES.unavailable));
			}
			const original = await snapshot(hostId, nodePath, remotePath);
			const read = await readRemoteFile(hostId, remotePath);
			if (read.digest !== original.digest || JSON.stringify(await snapshot(hostId, nodePath, remotePath)) !== JSON.stringify(original)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.fileChanged);
			const document = parseDocument(read.text);
			const located = locateEntry(document, { messageId, ...(entryId === undefined ? {} : { entryId }), stoppedIdentity: input.stoppedIdentity }, ports.project);
			if (!located) {
				// 文件里没有这条消息：delete 是 no-op（不产生远端写命令，消息本来就不在历史里），
				// edit/resend 依赖正文，必须报未找到——与本机链路的判定一致。
				// 停止摘要存在但身份无法唯一核对时，delete 也必须拒绝，不能把定位缺陷伪装成删除成功。
				if (operation === "delete" && !input.stoppedIdentity) return undefined;
				throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.messageNotFound);
			}
			if (operation === "resend") {
				const snapshot = extractResendContent(messageOf(located.entry)?.content);
				applyMutation(document, located, "resend", now(), undefined, createUuid);
				await writeRemoteFile(hostId, nodePath, remotePath, serializeDocument(document), original);
				return { text: snapshot.text, ...(snapshot.images === undefined ? {} : { images: snapshot.images }) };
			}
			applyMutation(document, located, operation, now(), input.newText ?? "", createUuid);
			await writeRemoteFile(hostId, nodePath, remotePath, serializeDocument(document), original);
			return undefined;
		},
	};
}
