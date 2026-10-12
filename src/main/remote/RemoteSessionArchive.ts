/**
 * 远端会话**归档 / 取消归档**（P4.5b）：远端文件在它**自己所在的目录旁** `mv` 进 / 出 `.pideck-archive/`。
 *
 * 为什么是「移动远端文件」而不是「只改本机记录」：归档的语义就是「不在常规列表里，但数据还在」。
 * 只改本机记录的话，远端文件仍在原处，下次远端扫描会把它重新列为「可导入」（用户看到「归档了又回来」）。
 * 因此这里必须做一次远端写入——但它只**移动**文件，**从不删除**（远端没有回收站，`rm` 是永久删除；
 * 「删除归档」是另一个需二次确认的显式动作，本批明确不做，见 docs/remote-write-plan.md §0/§1）。
 *
 * 为什么归档目录取「文件所在目录旁的 `.pideck-archive/`」而不是会话根下的同名目录：
 * - 同目录 ⇒ **同一文件系统** ⇒ `mv` 是一次 rename（原子、无半截状态），这是方案 §2.3 的硬要求；
 * - 远端扫描的口径（`RemoteSessionScanner.collectEntries`）只在根目录与工作区子目录两层收集 `*.jsonl` 文件，
 *   并且跳过名为 `.pideck-archive` 的目录 ⇒ 归档后的文件不会再出现在常规列表里。
 *
 * 为什么不新增 helper op（模块级纪律）：`--root` 是每连接一个目录（会话文件在用户 home 下、不在项目 root 内），
 * 走 helper 要么改 root 语义、要么加 op，两者都被「零新增 helper op」冻结。于是与读取侧同一条通道：
 * 既有 pinned SSH 短命令（pin/指纹/路由摘要/严格配置每次都复查），由装配注入传输端口。
 *
 * 不变量（违反任何一条都是返工）：
 * - **路径判据与读取侧同源**：`resolveRemoteSessionPath` / `validateRemoteSessionHistoryPath` 是唯一实现，
 *   本模块不抄第二套归一化（远端路径必须绝对、规范化、**拒绝单引号**，命令里只出现单引号字面量）；
 * - **先判后发**：路径不合法、hostId/locator 不合法一个远端命令都不发（构造命令时即抛）；
 * - **不覆盖**：目标已存在时**拒绝**（`[ ! -e '<目标>' ] &&` 让命令以非 0 退出），绝不静默覆盖一条已有归档；
 * - **失败即停**：破坏性动作不自动重试，失败返回稳定码，绝不谎报成功；
 * - **脱敏**：日志只记稳定码与身份（hostId/sessionId），不记路径、不记命令、不记正文。
 */

// hostId 与 ssh 身份判据只允许有一份：与持久化边界共用 shared 的权威取值域。
import { PROJECT_HOST_ID_PATTERN, readSshSessionLocator, type SshSessionLocator } from "../../shared/projectLocation";
import { REMOTE_SESSION_HISTORY_CODES, resolveRemoteSessionPath, validateRemoteSessionHistoryPath, type RemoteSessionHistoryRootPort } from "./RemoteSessionHistoryReader";

/**
 * 归档目录名。与本地 `SessionScanner.ARCHIVE_DIR_NAME` 同为 `.pideck-archive`——同名不是巧合：
 * 用户在两台机器上看到的是同一套语义（排查时不必再问「远端的归档区叫什么」）。
 */
export const REMOTE_SESSION_ARCHIVE_DIR_NAME = ".pideck-archive";

/** 本模块的稳定码词汇。 */
export const REMOTE_SESSION_ARCHIVE_CODES = {
	/** hostId 不是可用的诊断身份/传输键。 */
	hostIdInvalid: "REMOTE_SESSION_ARCHIVE_HOST_ID_INVALID",
	/** locator 不是合法 ssh 身份。 */
	locatorInvalid: "REMOTE_SESSION_ARCHIVE_LOCATOR_INVALID",
	/** 远端路径不可用（非绝对/含单引号/控制字节/超长）：绝不把它拼进命令行。 */
	pathInvalid: "REMOTE_SESSION_ARCHIVE_PATH_INVALID",
	/** 远端路径既不是绝对路径、也推不出会话根（相对身份 + 没有根解析端口）。 */
	pathUnresolved: "REMOTE_SESSION_ARCHIVE_PATH_UNRESOLVED",
	/** 传输层失败（ssh 起不来、超时、输出超上界）且自身不带稳定码。 */
	transportFailed: "REMOTE_SESSION_ARCHIVE_TRANSPORT_FAILED",
	/** 远端命令退出码非 0（stderr 不外传）：文件没移动，本机状态必须原样不动。 */
	commandFailed: "REMOTE_SESSION_ARCHIVE_COMMAND_FAILED",
	/** 本机索引里没有这条远端归档条目（恢复身份不存在）。 */
	entryNotFound: "REMOTE_SESSION_ARCHIVE_ENTRY_NOT_FOUND",
	/** 会话有运行实例：运行中禁止 move（先判后发，一个远端命令都不发）。 */
	busy: "REMOTE_SESSION_ARCHIVE_BUSY",
	/** 装配没提供远端归档端口（旧装配/正式包）：稳定码而不是落回本机路径。 */
	unavailable: "REMOTE_SESSION_ARCHIVE_UNAVAILABLE",
} as const;

/** 构造期参数不合法（与其它远端模块一致，构造即抛，不等到第一次调用）。 */
export const REMOTE_SESSION_ARCHIVE_OPTIONS_INVALID = "REMOTE_SESSION_ARCHIVE_OPTIONS_INVALID";

/**
 * 路径类稳定码的折叠：读取侧与归档侧共用同一个解析实现（这是硬要求），但两边的码各有取值域，
 * 所以这里显式映射，而不是让 `REMOTE_SESSION_HISTORY_PATH_INVALID` 从一个归档接口里冒出来。
 * 新增路径类码时必须同步这张表（漏了会表现为「归档返回读取侧的码」）。
 */
const READER_PATH_CODE_TO_ARCHIVE_CODE: Record<string, string> = {
	[REMOTE_SESSION_HISTORY_CODES.pathInvalid]: REMOTE_SESSION_ARCHIVE_CODES.pathInvalid,
	[REMOTE_SESSION_HISTORY_CODES.pathUnresolved]: REMOTE_SESSION_ARCHIVE_CODES.pathUnresolved,
};

function stable(code: string): Error {
	return new Error(code);
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

/** 路径解析失败 → 本模块的稳定码（同一实现的码映射，见 READER_PATH_CODE_TO_ARCHIVE_CODE）。 */
async function resolveRemotePath(input: { hostId: string; locator: SshSessionLocator; resolveSessionRoot?: RemoteSessionHistoryRootPort }): Promise<string> {
	try {
		return await resolveRemoteSessionPath(input);
	} catch (error) {
		const code = codeOf(error, REMOTE_SESSION_ARCHIVE_CODES.pathInvalid);
		throw stable(READER_PATH_CODE_TO_ARCHIVE_CODE[code] ?? REMOTE_SESSION_ARCHIVE_CODES.pathInvalid);
	}
}

/**
 * 归档目标路径（纯函数）：`<文件所在目录>/.pideck-archive/<原文件名>`。
 * 输入必须是**已校验**的绝对远端路径（唯一校验入口 `validateRemoteSessionHistoryPath`，
 * 本函数只做「切目录/取文件名」这一件事，不重复实现判据）。
 */
export function remoteSessionArchiveTarget(remotePath: string): { archiveDir: string; archivedPath: string } {
	const validated = validateRemoteSessionHistoryPath(remotePath);
	if (validated === undefined) throw stable(REMOTE_SESSION_ARCHIVE_CODES.pathInvalid);
	const separator = validated.lastIndexOf("/");
	const directory = validated.slice(0, separator);
	const name = validated.slice(separator + 1);
	// 依赖 `validateRemoteSessionHistoryPath` 已拒掉 `/` 结尾与空串 ⇒ 这里必有非空目录与非空文件名。
	if (directory.length === 0 || name.length === 0) throw stable(REMOTE_SESSION_ARCHIVE_CODES.pathInvalid);
	const archiveDir = `${directory}/${REMOTE_SESSION_ARCHIVE_DIR_NAME}`;
	if (validateRemoteSessionHistoryPath(archiveDir) === undefined) throw stable(REMOTE_SESSION_ARCHIVE_CODES.pathInvalid);
	const archivedPath = `${archiveDir}/${name}`;
	if (validateRemoteSessionHistoryPath(archivedPath) === undefined) throw stable(REMOTE_SESSION_ARCHIVE_CODES.pathInvalid);
	return { archiveDir, archivedPath };
}

/**
 * 建目录命令：`mkdir -p -- '<dir>'`。
 *
 * 为什么单独一步（而不是与 `mv` 拼成一条 `&&`）：方案要求「先确保目录存在、再 move」两步，
 * 分开之后每一步的失败都能对应到确定的状态（建目录失败 ⇒ 什么都没动；move 失败 ⇒ 只多了个空目录），
 * 也让测试能逐字断言两条命令的顺序。
 */
export function buildRemoteSessionArchiveDirCommand(archiveDir: unknown): string {
	const validated = validateRemoteSessionHistoryPath(archiveDir);
	if (validated === undefined) throw stable(REMOTE_SESSION_ARCHIVE_CODES.pathInvalid);
	return `mkdir -p -- '${validated}'`;
}

/**
 * 移动命令：`[ ! -e '<目标>' ] && mv -- '<源>' '<目标>'`。
 *
 * 为什么不是裸 `mv`：`mv` 对已存在的目标**静默覆盖**——归档时会悄悄毁掉上一条同名归档，
 * 恢复时会悄悄覆盖同名的活会话。`[ ! -e ]` 把「目标已存在」变成一个非 0 退出码，
 * 于是调用方拿到 `COMMAND_FAILED` 并**保持本机状态不动**（绝不谎报成功）。
 * 只允许单引号字面量，路径里的单引号在校验期已被拒绝。
 */
export function buildRemoteSessionArchiveMoveCommand(input: { from: unknown; to: unknown }): string {
	const from = validateRemoteSessionHistoryPath(input?.from);
	const to = validateRemoteSessionHistoryPath(input?.to);
	if (from === undefined || to === undefined) throw stable(REMOTE_SESSION_ARCHIVE_CODES.pathInvalid);
	return `[ ! -e '${to}' ] && mv -- '${from}' '${to}'`;
}

/**
 * 远端短命令传输端口：与 `RemoteSessionHistoryReader` 的读取端口同一条 pinned SSH 通道，
 * 由装配注入（生产实现每次重新过 `buildPinnedSshInvocation`）。
 */
export type RemoteSessionArchiveTransportPort = {
	runRemoteCommand(input: { hostId: string; remoteCommand: string }): Promise<{ exitCode: number; stdout: string }>;
};

export type RemoteSessionArchivePorts = {
	transport: RemoteSessionArchiveTransportPort;
	/** 相对身份需要它；缺失时相对 identity 以 `PATH_UNRESOLVED` fail-closed（绝不猜会话根）。 */
	resolveSessionRoot?: RemoteSessionHistoryRootPort;
};

export type RemoteSessionArchive = {
	/** 把远端会话文件移进同目录旁的 `.pideck-archive/`；返回移动前后的绝对路径（本机索引要记这两条）。 */
	moveIntoArchive(input: { hostId: string; locator: SshSessionLocator }): Promise<{ originalPath: string; archivedPath: string }>;
	/** 按索引记下的两个绝对路径把文件移回原位；目标已存在则拒绝（不覆盖同名活会话）。 */
	moveBack(input: { hostId: string; originalPath: string; archivedPath: string }): Promise<{ originalPath: string }>;
};

export function createRemoteSessionArchive(ports: RemoteSessionArchivePorts): RemoteSessionArchive {
	if (!isRecord(ports) || typeof ports.transport?.runRemoteCommand !== "function") throw stable(REMOTE_SESSION_ARCHIVE_OPTIONS_INVALID);

	/**
	 * 发一条远端命令并只关心退出码。
	 *
	 * 输出**不解析**：`mkdir`/`mv` 没有需要读的返回值，而远端 stdout 里可能有登录横幅（`~/.bashrc` 的
	 * nvm 初始化就是这样）——按输出判断状态会得到一个会说谎的判据。失败一律折叠成稳定码，stderr 不外传。
	 */
	async function run(hostId: string, command: string): Promise<void> {
		let result: { exitCode: number; stdout: string };
		try {
			result = await ports.transport.runRemoteCommand({ hostId, remoteCommand: command });
		} catch (error) {
			// 连接层自己的稳定码（SSH_HOST_NOT_READY / SSH_HOST_ROUTE_CHANGED …）原样转述。
			throw stable(codeOf(error, REMOTE_SESSION_ARCHIVE_CODES.transportFailed));
		}
		if (!isRecord(result) || typeof result.stdout !== "string") throw stable(REMOTE_SESSION_ARCHIVE_CODES.transportFailed);
		// 非 0 = 没移动（目标已存在 / 源不存在 / 权限）：不重试、不猜测，交给调用方如实报告。
		if (result.exitCode !== 0) throw stable(REMOTE_SESSION_ARCHIVE_CODES.commandFailed);
	}

	/** hostId 要在发帧前就能当诊断身份与传输键用；非法值不回显（与读取侧同判据）。 */
	function readHostId(value: unknown): string | undefined {
		return typeof value === "string" && PROJECT_HOST_ID_PATTERN.test(value) ? value : undefined;
	}

	return {
		async moveIntoArchive(input) {
			const hostId = readHostId(input?.hostId);
			if (hostId === undefined) throw stable(REMOTE_SESSION_ARCHIVE_CODES.hostIdInvalid);
			const locator = readSshSessionLocator(input?.locator);
			if (locator === undefined || locator.hostId !== hostId) throw stable(REMOTE_SESSION_ARCHIVE_CODES.locatorInvalid);
			const originalPath = await resolveRemotePath({ hostId, locator, resolveSessionRoot: ports.resolveSessionRoot });
			const { archiveDir, archivedPath } = remoteSessionArchiveTarget(originalPath);
			// 两步、按序、不重试：先确保目录存在，再 move（同文件系统 ⇒ rename 原子）。
			await run(hostId, buildRemoteSessionArchiveDirCommand(archiveDir));
			await run(hostId, buildRemoteSessionArchiveMoveCommand({ from: originalPath, to: archivedPath }));
			return { originalPath, archivedPath };
		},
		async moveBack(input) {
			const hostId = readHostId(input?.hostId);
			if (hostId === undefined) throw stable(REMOTE_SESSION_ARCHIVE_CODES.hostIdInvalid);
			// 两个路径都来自本机索引（持久化输入）：进命令前重新过一遍判据，绝不信任磁盘上的旧值。
			const archivedPath = validateRemoteSessionHistoryPath(input?.archivedPath);
			const originalPath = validateRemoteSessionHistoryPath(input?.originalPath);
			if (archivedPath === undefined || originalPath === undefined) throw stable(REMOTE_SESSION_ARCHIVE_CODES.pathInvalid);
			await run(hostId, buildRemoteSessionArchiveMoveCommand({ from: archivedPath, to: originalPath }));
			return { originalPath };
		},
	};
}
