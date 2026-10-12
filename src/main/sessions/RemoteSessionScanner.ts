/**
 * 远端 Session 只读发现（G3，Phase 3 第三段）。
 *
 * 这里做的事有三件：**列出远端会话文件**（列表级元数据）、**把其中一条幂等登记进本地 SessionCatalog**，
 * 以及**按需解析一条会话的标题**（H1：有界读头部后交给本地标题管线，只读、不写 catalog）。
 * 列表级扫描仍然不做任何内容解析——标题走独立通道；不做侧栏 UI、不做 move/archive/delete（Phase 4/5）。
 *
 * 会话根（J2）：默认 `<remote home>/.pi/agent/sessions`，但 pi 的 user-level `settings.json` 可以用
 * `sessionDir` 把它换掉——所以每次操作先做一次**有界配置探测**（root=`<home>/.pi/agent`，读 `settings.json`
 * ≤64 KiB），配置缺失/读不到/畸形都退回默认根（与历史行为逐字一致），配置里的 `sessionDir` 不可用则给稳定码
 * 拒绝（理由见 resolveConfiguredSessionDir）。**边界**：`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`
 * 是远端进程环境（helper 1.6.0 没有读 env 的操作），project 级 `.pi/settings.json` 取决于会话自己的 cwd
 * （读内容前不可知）——两者都只做默认根扫描，详见 docs/remote-development-handoff.md 第六批。
 *
 * 边界与不变量（全部 fail-closed）：
 * - 远端路径**绝不进本地 fs**：本模块不 import node:fs，唯一的远端访问通道是
 *   port.withProjectSession(hostId, 会话根, task) —— 借用它做「任意 root 的受控操作边界」。
 * - 结果只含 { remoteSessionId, remotePath, name, size, mtimeMs }；没有任何远端正文。
 * - 上限是硬上限：工作区目录 ≤512、会话文件 ≤2000、单次扫描元数据字节预算 ≤1 MiB、并发 ≤4。
 *   越界是**拒绝**（稳定码），不是悄悄截断——截断后的列表看起来和完整列表一样。
 * - 每个失败都带稳定码；reader/连接层自己的稳定码原样转述，未知异常才折叠成 REMOTE_SESSION_SCAN_FAILED。
 *
 * 已知代价（有意为之，写在这里免得下次误读）：fs.list 不带 mtime，所以每个候选文件要一次 fs.stat
 * 才能填出 mtimeMs；最多 2000 次 stat、并发 4，是有界但不是零成本。下一增量若要有上限批量元数据，
 * 正确做法是在 helper 侧加 session.list，而不是在这里把 mtime 编造出来。
 */

import { type RemoteHelperListEntry } from "../remote/RemoteHelperContract";
// hostId 的判据只允许有一份：与持久化边界（readSshSessionLocator / 项目域）共用 shared 的权威取值域。
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import { createRemoteWorkspaceReader, REMOTE_WORKSPACE_MAX_HEAD_BYTES, REMOTE_WORKSPACE_MAX_WINDOW_BYTES, type RemoteWorkspacePort } from "../remote/RemoteWorkspaceReader";
import { SUBAGENT_ARTIFACTS_DIR_NAME } from "../../shared/sessionIdentity";
import type { RemoteSessionRegistration, RemoteSessionRegistrationInput } from "./SessionCatalog";
import { inferSessionTitleFromHeadText, type SessionTitleInference } from "./sessionNameLine";
// 渲染层要消费这三个结构，所以它们是 shared 契约而不是本模块私有类型；这里只转出，避免同一结构两处各定义一份。
import type { RemoteSessionEntry, RemoteSessionRegisterResult, RemoteSessionScanResult, RemoteSessionTitleResult } from "../../shared/types/remoteHost";
export type { RemoteSessionEntry, RemoteSessionRegisterResult, RemoteSessionScanResult } from "../../shared/types/remoteHost";
// H1 新增的按需标题结果同样只转出 shared 契约（remoteSessionWiring 钉的是上一行的既有形状，不合并两行）。
export type { RemoteSessionTitleResult } from "../../shared/types/remoteHost";

/**
 * 会话根的**默认值**相对远端 home 的后缀（冻结设计第 1 条；pi 未配置 `sessionDir` 时就是它）。
 * 注意它现在只是默认值：pi 的 user-level settings.json 可以把它换掉（见 REMOTE_SESSION_AGENT_DIR_SUFFIX）。
 */
export const REMOTE_SESSION_ROOT_SUFFIX = ".pi/agent/sessions";

/**
 * pi 的 user-level agent 目录（`<remote home>/.pi/agent`）：`settings.json` 与默认 sessions 目录都在它下面。
 * 证据：pi 1.0.4 dist/config.js 的 `getAgentDir()`（`$PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")`）、
 * `getSettingsPath()` 与 `getSessionsDir()`。
 */
export const REMOTE_SESSION_AGENT_DIR_SUFFIX = ".pi/agent";

/** pi 的 user-level 配置文件：J2 扫描期解析 `sessionDir` 的唯一可靠来源（project 作用域取决于会话 cwd）。 */
export const REMOTE_SESSION_SETTINGS_FILE_NAME = "settings.json";

/**
 * 单次扫描的硬上限（冻结设计第 7 条）。**只能下调，不能调高**（见 readLimits）：
 * 这些数字本身就是「有界」这件事的定义，允许调用方放大等于没有上限。
 */
export const REMOTE_SESSION_LIMITS = {
	/** 工作区目录（pi 的 encoded-cwd 子目录）上限。 */
	maxWorkspaceDirs: 512,
	/** 会话文件上限。 */
	maxFiles: 2000,
	/** 单次扫描的元数据字节预算：每个列出的目录项计 name 的 UTF-8 字节 + 结构开销，每次 stat 计 64 字节。 */
	maxTotalBytes: 1024 * 1024,
	/** 并发上限（列目录与 stat 共用）。 */
	concurrency: 4,
} as const;

/** 每个目录项的结构开销（与 name 长度一起计入字节预算）。 */
export const REMOTE_SESSION_ENTRY_OVERHEAD_BYTES = 32;
/** 每次 stat 计入字节预算的固定开销。 */
export const REMOTE_SESSION_STAT_OVERHEAD_BYTES = 64;
/** remoteSessionId 的长度上限：shared 的 SessionLocator.remoteSessionId 就是这个域。 */
export const REMOTE_SESSION_MAX_ID_LENGTH = 256;
/** remotePath 的长度上限：shared 的 SessionLocator.remotePath 域。 */
export const REMOTE_SESSION_MAX_PATH_LENGTH = 4096;
/** 装配时 port/limits 不合法（与其它远端模块一致，构造期抛出）。 */
export const REMOTE_SESSION_SCANNER_OPTIONS_INVALID = "REMOTE_SESSION_SCANNER_OPTIONS_INVALID";

/** 本模块的稳定码词汇；其余码来自 reader/连接层，原样转述。 */
export const REMOTE_SESSION_CODES = {
	/** hostId 不是可用的诊断身份/传输键。 */
	hostIdInvalid: "REMOTE_SESSION_HOST_ID_INVALID",
	/** 远端 home 解析不出（remoteHome 返回 undefined/空/非绝对路径）。 */
	homeUnavailable: "REMOTE_SESSION_HOME_UNAVAILABLE",
	/** remoteSessionId 不是合法的「相对会话根的 POSIX .jsonl 路径」。 */
	idInvalid: "REMOTE_SESSION_ID_INVALID",
	/** 工作区目录数越过硬上限。 */
	dirLimitExceeded: "REMOTE_SESSION_DIR_LIMIT_EXCEEDED",
	/** 会话文件数越过硬上限。 */
	fileLimitExceeded: "REMOTE_SESSION_FILE_LIMIT_EXCEEDED",
	/** 元数据字节预算耗尽。 */
	budgetExceeded: "REMOTE_SESSION_BUDGET_EXCEEDED",
	/** 本批不解析正文，归属由装配注入的 projectIdForHost 决定；解析不出就 fail closed。 */
	projectUnresolved: "REMOTE_SESSION_PROJECT_UNRESOLVED",
	/** 装配没有提供 catalog 端口（旧装配/正式包）。 */
	catalogUnavailable: "REMOTE_SESSION_CATALOG_UNAVAILABLE",
	/** catalog 写入失败且自身不带稳定码。 */
	registerFailed: "REMOTE_SESSION_REGISTER_FAILED",
	/** 扫描过程中出现了不带稳定码的异常。 */
	scanFailed: "REMOTE_SESSION_SCAN_FAILED",
	/** 按需标题解析过程中出现了不带稳定码的异常。 */
	titleFailed: "REMOTE_SESSION_TITLE_FAILED",
	/** 配置里的 sessionDir 不可用（非字符串/相对路径/控制字节/逃出 home）：拒绝而不是静默扫错目录。 */
	sessionDirInvalid: "REMOTE_SESSION_SESSION_DIR_INVALID",
} as const;

/** 一条远端会话的列表级元数据；不含任何正文。 */
// RemoteSessionEntry / RemoteSessionScanResult / RemoteSessionRegisterResult 定义在 shared/types/remoteHost.ts，
// 由本文件顶部 import + 转出（渲染层要消费同一结构，不允许两处各写一份）。

/** 一个已建立会话的窄请求面（与 RemoteProjectSession 结构同形，便于装配直接传服务）。 */
export type RemoteSessionSessionPort = {
	request(method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (requestId: string) => void }): Promise<unknown>;
	cancel(requestId: string, options?: { timeoutMs?: number }): Promise<unknown>;
};

/**
 * 本模块需要的远端能力：解析 home，以及「在一个受控 root 里跑完整个操作」。
 * 刻意不复刻 RemoteHostConnectionService 的类型：G2 正在给它加 remoteHome，
 * 用窄端口并行开发不会把两批改动耦合在一起（装配处直接传服务，结构上满足）。
 */
export type RemoteSessionScannerPort = {
	remoteHome(hostId: string): Promise<string | undefined>;
	/** 可选：缓存状态读不到时**按需建立会话**再读一次（生产端口提供；缺失时退回只读）。 */
	remoteHomeEnsuring?(hostId: string): Promise<string | undefined>;
	withProjectSession<T>(hostId: string, root: string, task: (session: RemoteSessionSessionPort) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }>;
};

/** catalog 侧只用到 ensureRemoteSession 这一个入口（SessionCatalog 结构上满足）。 */
export type RemoteSessionCatalogPort = {
	ensureRemoteSession(input: RemoteSessionRegistrationInput): Promise<RemoteSessionRegistration>;
	/**
	 * 可选：这条远端会话是否已被用户「移除记录」（墓碑命中）。列表级发现用它把已移除的会话从「可导入」
	 * 里排除——远端文件仍在（PiDeck 不删远端数据），但「删了又回来」是用户可感知的错误。
	 */
	isRemoteSessionDismissed?(hostId: string, remoteSessionId: string): boolean;
};

/** 远端会话归属哪个本地项目由装配决定（本批不解析正文，无法自行推断）。 */
export type RemoteSessionProjectResolver = (hostId: string, remoteSessionId: string) => string | undefined;

export type RemoteSessionScannerLimits = {
	maxWorkspaceDirs: number;
	maxFiles: number;
	maxTotalBytes: number;
	concurrency: number;
};

export type RemoteSessionScannerOptions = {
	port: RemoteSessionScannerPort;
	catalog?: RemoteSessionCatalogPort;
	projectIdForHost?: RemoteSessionProjectResolver;
	/** 只允许把这些硬上限调小（测试用）。 */
	limits?: Partial<RemoteSessionScannerLimits>;
};

/**
 * 会话根解析结果：`ok:false` 一律带本模块的稳定码（home 不可用 / `sessionDir` 不可用），调用方原样转述。
 * 与内部 `resolveSessionRoot` 同形：这里只是给它一个名字（别处要么沿用，要么再抄一遍）。
 */
export type RemoteSessionRootResolution = { readonly ok: true; readonly root: string } | { readonly ok: false; readonly code: string };

export type RemoteSessionScanner = {
	/** 只读列出远端会话；不写 catalog、不读正文。 */
	scan(hostId: string): Promise<RemoteSessionScanResult>;
	/**
	 * 会话根解析（J2）：默认 `<remote home>/.pi/agent/sessions`，被 user-level `settings.json` 的
	 * `sessionDir` 覆盖时用它。scan/register/title 内部走的就是这一个函数。
	 *
	 * 为什么转出：别处（远端 runtime 把 pi 上报的会话文件折成 `remoteSessionId` 时）必须用**同一份**
	 * 会话根判定。各自再拼一次 `<home>/.pi/agent/sessions` 就会在配了自定义 `sessionDir` 的机器上
	 * 折出看似正常但错的相对路径。
	 */
	resolveSessionRoot(hostId: string): Promise<RemoteSessionRootResolution>;
	/** 在远端确认该文件仍存在后，幂等登记进 catalog 并返回稳定 sessionId。 */
	register(input: { hostId: string; remoteSessionId: string }): Promise<RemoteSessionRegisterResult>;
	/**
	 * 按需解析真实标题（H1）：有界读头部（≤ REMOTE_WORKSPACE_MAX_HEAD_BYTES）交给本地标题管线。
	 * 只读、不写 catalog；解析不出强制 fallback（title = 文件名 stem），绝不编造。
	 */
	title(input: { hostId: string; remoteSessionId: string }): Promise<RemoteSessionTitleResult>;
};

/**
 * POSIX 路径规范化：折叠空段与 `.`，解析 `..`；试图越过根（`..` 逃逸）或结果为空返回 undefined。
 * 远端会话根必须是一个确定的绝对路径，规范化是「仍在 home 之内」判定的前提。
 */
function normalizePosixPath(path: string): string | undefined {
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return undefined;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.length === 0 ? undefined : "/" + segments.join("/");
}

/**
 * 校验并规范化配置里的 `sessionDir`（返回 undefined = 不可用）。
 *
 * 支持 pi 的 `~` 展开语义（CHANGELOG #3514：settings.json 里的 sessionDir 会展开 `~`）；`~user` 需要远端
 * passwd，helper 没有这个操作 ⇒ 拒绝。**拒绝而不是退回默认根**的理由：pi 的相对路径是按**会话自己的 cwd**
 * 解析的（pi docs/settings.md:64），单一扫描根在原理上不可能正确；退回默认根会给出「看起来正常但是错的
 * 列表」——那正是「发现不了比报错更糟」要避免的形态。越出 home 之外的目录同样拒绝（扫描边界只承诺 home 内）。
 */
function resolveConfiguredSessionDir(value: string, home: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > REMOTE_SESSION_MAX_PATH_LENGTH || CONTROL_CHARS.test(trimmed)) return undefined;
	const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? home + trimmed.slice(1) : trimmed;
	if (!expanded.startsWith("/")) return undefined;
	const normalized = normalizePosixPath(expanded);
	if (normalized === undefined) return undefined;
	if (normalized !== home && !normalized.startsWith(home + "/")) return undefined;
	return normalized;
}

/** home 判据与 G3 逐字一致（绝对 POSIX、长度受限、无控制字节），额外去掉尾部斜杠。 */
function readRemoteHome(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_SESSION_MAX_PATH_LENGTH || CONTROL_CHARS.test(value) || !value.startsWith("/")) return undefined;
	return value === "/" ? "/" : value.replace(/\/+$/, "");
}

/** 一个码就是一个码，绝不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** 远端拒绝控制字节；这里也不把它们当成词汇的一部分。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** 常规扫描跳过的目录：归档/回收，以及 pi-subagents 的产物转储（与本地 SessionScanner 同口径）。 */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([".pideck-archive", ".trash", SUBAGENT_ARTIFACTS_DIR_NAME]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 稳定码转述：错误对象自己的 code 或 message 是稳定码时原样返回，否则 undefined（交由调用方折叠）。 */
function stableCodeOf(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	const code = error.code;
	if (typeof code === "string" && STABLE_CODE.test(code)) return code;
	const message = error.message;
	if (typeof message === "string" && STABLE_CODE.test(message)) return message;
	return undefined;
}

/**
 * hostId 要在发帧前就能当诊断身份与传输键用；非法值不回显。
 *
 * K2-1：判据收敛到 shared 的 `PROJECT_HOST_ID_PATTERN`——hostId 只可能由 `RemoteHostStore` 用
 * `randomUUID()` 生成（持久化边界、codec、pin、诊断、IPC 全部只接受这一形状）。以前这里只要求
 * 「非空 ≤64 无控制字节」，于是非 UUID 会先打一次远端往返，直到写 catalog 才以
 * `REMOTE_SESSION_IDENTITY_INVALID` 拒绝：同一个坏输入在两个边界得到两种结论，且失败点更靠后。
 * 现在两个边界同判据，稳定码仍是 `REMOTE_SESSION_HOST_ID_INVALID`。
 */
function readHostId(value: unknown): string | undefined {
	return typeof value === "string" && PROJECT_HOST_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * remoteSessionId 必须是**相对会话根的 POSIX .jsonl 路径**：非空、≤256、无控制字节、无反斜杠、非绝对、
 * 无 . / .. 段、无空段、末段是带 stem 的 .jsonl（".jsonl" 这种空 stem 不算会话身份，列表扫描也跳过它）。
 * 它同时会被当作 helper 请求路径用，形状不合法就一个帧都不发。
 */
function readRemoteSessionId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_SESSION_MAX_ID_LENGTH) return undefined;
	if (CONTROL_CHARS.test(value) || value.includes("\\") || value.startsWith("/")) return undefined;
	const segments = value.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || segment === "." || segment === "..") return undefined;
	}
	// 末段必须是有 stem 的 .jsonl：".jsonl" 这类空 stem 文件不是会话身份，扫描侧同样跳过它。
	const last = segments[segments.length - 1] ?? "";
	if (last.length <= ".jsonl".length || !last.toLowerCase().endsWith(".jsonl")) return undefined;
	return value;
}

/**
 * 权威标题判据（I1 三档口径）：标题来自**名字字段**——pi 的 session_info，或旧版 PiDeck 私有
 * sessionName 行——而不是首条 user/assistant 文本的弱兜底。本地管线用同一个 fromSessionInfo 标志
 * 把权威名落成 catalog 的 manual、弱兜底落成 fallback，所以这里必须同判据。
 */
function isAuthoritativeTitle(inference: SessionTitleInference): boolean {
	return inference.name !== undefined && inference.fromSessionInfo;
}

/**
 * 文件名 stem（暂定标题）。时间戳 stem 由 catalog 的展示层清成 Untitled，这里不做产品判断。
 *
 * 转出是给别的「登记一条远端会话」的路径用的（别处再写一遍 `basename` 去后缀就会与这里漂移）。
 */
export function titleFromRemoteSessionId(remoteSessionId: string): string {
	const base = remoteSessionId.slice(remoteSessionId.lastIndexOf("/") + 1);
	const stem = base.replace(/\.jsonl$/i, "").trim();
	return stem.length > 0 ? stem : "Untitled";
}

function isJsonlName(name: string): boolean {
	return name.toLowerCase().endsWith(".jsonl") && name.length > ".jsonl".length;
}

/** 只允许把硬上限调小：maxWorkspaceDirs/maxFiles/maxTotalBytes/concurrency 都在 [1, 默认值] 内才是合法装配。 */
function readLimits(value: unknown): RemoteSessionScannerLimits | undefined {
	const limits: RemoteSessionScannerLimits = { ...REMOTE_SESSION_LIMITS };
	if (value === undefined) return limits;
	if (!isRecord(value)) return undefined;
	for (const key of ["maxWorkspaceDirs", "maxFiles", "maxTotalBytes", "concurrency"] as const) {
		const raw = value[key];
		if (raw === undefined) continue;
		if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > REMOTE_SESSION_LIMITS[key]) return undefined;
		limits[key] = raw;
	}
	return limits;
}

function isRemoteSessionScannerPort(value: unknown): value is RemoteSessionScannerPort {
	return isRecord(value) && typeof value.remoteHome === "function" && typeof value.withProjectSession === "function";
}

/** 把已建立会话适配成 reader 需要的 port；hostId 不一致一律拒绝（否则诊断会说谎）。 */
function sessionPort(session: RemoteSessionSessionPort, hostId: string): RemoteWorkspacePort {
	const port: RemoteWorkspacePort = {
		request: (requestHostId, method, params, options) => (requestHostId === hostId ? session.request(method, params, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
	};
	if (typeof session.cancel === "function") {
		port.cancel = (requestHostId, requestId, options) => (requestHostId === hostId ? session.cancel(requestId, options) : Promise.reject(new Error("SSH_HOST_NOT_READY")));
	}
	return port;
}

type Budget = { remaining: number };

/** 元数据字节预算：一旦为负立刻拒绝（预算是有界这件事的体现，不是统计值）。 */
function charge(budget: Budget, bytes: number): void {
	budget.remaining -= bytes;
	if (budget.remaining < 0) throw new Error(REMOTE_SESSION_CODES.budgetExceeded);
}

function chargeListing(budget: Budget, entries: readonly RemoteHelperListEntry[]): void {
	for (const entry of entries) charge(budget, Buffer.byteLength(entry.name, "utf8") + REMOTE_SESSION_ENTRY_OVERHEAD_BYTES);
}

/** 并发受限的 map：worker 数不超过 limits.concurrency，且结果按输入顺序落位。 */
async function mapBounded<Input, Output>(items: readonly Input[], concurrency: number, run: (item: Input, index: number) => Promise<Output>): Promise<Output[]> {
	const results = new Array<Output>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await run(items[index] as Input, index);
		}
	});
	await Promise.all(workers);
	return results;
}

export function createRemoteSessionScanner(options: RemoteSessionScannerOptions): RemoteSessionScanner {
	if (!isRecord(options) || !isRemoteSessionScannerPort(options.port)) throw new Error(REMOTE_SESSION_SCANNER_OPTIONS_INVALID);
	const parsedLimits = readLimits(options.limits);
	if (parsedLimits === undefined) throw new Error(REMOTE_SESSION_SCANNER_OPTIONS_INVALID);
	const limits: RemoteSessionScannerLimits = parsedLimits;
	const { port, catalog, projectIdForHost } = options;

	/**
	 * 解析会话根（J2，供 scan / title / register 共用）：
	 * home（握手）→ <home>/.pi/agent/settings.json 的 `sessionDir`（有界读，≤64 KiB）→ 默认 <home>/.pi/agent/sessions。
	 *
	 * 三种结果分得很清：
	 * - 配置**缺失 / 读不到 / 不是文件 / 畸形 JSON / 截断** ⇒ 默认根（与今天行为逐字一致，不让扫描整体失败）；
	 * - 配置里的 `sessionDir` **不可用**（非字符串、相对路径、控制字节、逃出 home）⇒ 稳定码
	 *   REMOTE_SESSION_SESSION_DIR_INVALID，**不退回默认根**：那会在配了自定义目录的机器上给出看起来正常但错的列表；
	 * - 合法（含 `~` 展开与 `.`/`..` 规范化）⇒ 用它当会话根。
	 *
	 * 代价（如实记录）：一次操作 = 1 次配置探测（root=<home>/.pi/agent 的一次 withProjectSession + 1 stat + 1 次 ≤64 KiB read）
	 * + 1 次真正的会话操作；两次的 root 不同会让服务的 helper 会话切换（现有服务语义）。
	 */
	async function resolveSessionRoot(hostId: string): Promise<RemoteSessionRootResolution> {
		let home: unknown;
		try {
			// 优先「确保式」：扫描通常紧跟登记/读取项目之后，而那条路径会在任务结束时收掉它建立的临时
			// 会话 —— 纯读会正好落进「没有缓存状态」的窗口并报 home 不可用（真机 e2e 实测：前后状态都
			// 是 ready，同主机稍后再扫就成功）。端口没提供确保式方法时退回只读，既有测试替身不受影响。
			const ensureHome = port.remoteHomeEnsuring;
			home = typeof ensureHome === "function" ? await ensureHome.call(port, hostId) : await port.remoteHome(hostId);
		} catch {
			return { ok: false, code: REMOTE_SESSION_CODES.homeUnavailable };
		}
		const homeDir = readRemoteHome(home);
		if (homeDir === undefined) return { ok: false, code: REMOTE_SESSION_CODES.homeUnavailable };
		const configured = await readConfiguredSessionDir(hostId, homeDir);
		if (!configured.ok) return configured;
		return { ok: true, root: configured.sessionDir ?? homeDir + "/" + REMOTE_SESSION_ROOT_SUFFIX };
	}

	/**
	 * 读 user-level `settings.json` 并取出 `sessionDir`（pi 1.0.4 证据见模块常量注释）。
	 * 读不到/非文件/畸形/非对象 JSON 都返回 `{ ok: true }`（= 未配置 ⇒ 默认根）。
	 */
	async function readConfiguredSessionDir(hostId: string, home: string): Promise<{ readonly ok: true; readonly sessionDir?: string } | { readonly ok: false; readonly code: string }> {
		let raw: string | undefined;
		try {
			const outcome = await port.withProjectSession(hostId, home + "/" + REMOTE_SESSION_AGENT_DIR_SUFFIX, async (session) => {
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, hostId) });
				const head = await reader.readHead(hostId, REMOTE_SESSION_SETTINGS_FILE_NAME, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
				// 配置可能截断多字节字符：U+FFFD 落在字符串里会让 JSON.parse 失败，于是按「未配置」处理。
				return new TextDecoder().decode(head.content);
			});
			if (outcome.ok) raw = outcome.value;
		} catch {
			// 不存在 / 不是普通文件 / 权限 / 传输失败：一律按「未配置」处理（今天就是扫默认根）。
			raw = undefined;
		}
		if (raw === undefined) return { ok: true };
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { ok: true };
		}
		if (!isRecord(parsed)) return { ok: true };
		const value = parsed.sessionDir;
		// pi 的判据是 `sessionDir ? normalizePath(sessionDir) : sessionDir`：falsy（含空串）等于未配置。
		if (value === undefined || value === null || value === "") return { ok: true };
		if (typeof value !== "string") return { ok: false, code: REMOTE_SESSION_CODES.sessionDirInvalid };
		const sessionDir = resolveConfiguredSessionDir(value, home);
		return sessionDir === undefined ? { ok: false, code: REMOTE_SESSION_CODES.sessionDirInvalid } : { ok: true, sessionDir };
	}

	/**
	 * 列出会话根下的会话文件（两层：根 → 工作区子目录 → *.jsonl；根目录下的 *.jsonl 也收，与本地 collectJsonl 同口径）。
	 *
	 * 目录列表与每个候选的 stat 都并发受限；上限与字节预算在**发起之前**判断，越界即抛稳定码。
	 * 任何一次列目录失败都会让整次扫描失败：返回「少一半但看起来完整」的列表比失败更糟。
	 */
	async function collectEntries(hostId: string, session: RemoteSessionSessionPort): Promise<RemoteSessionEntry[]> {
		const reader = createRemoteWorkspaceReader({ port: sessionPort(session, hostId) });
		const budget: Budget = { remaining: limits.maxTotalBytes };
		const rootListing = await reader.list(hostId, ".");
		chargeListing(budget, rootListing.entries);

		const workspaceDirs: string[] = [];
		const candidates: string[] = [];
		for (const entry of rootListing.entries) {
			if (entry.kind === "directory") {
				if (!SKIP_DIRECTORIES.has(entry.name)) workspaceDirs.push(entry.name);
				continue;
			}
			// 非 .jsonl 文件、以及 symlink/其它类型：不是会话文件，直接跳过（跳过不是错误）。
			if (entry.kind === "file" && isJsonlName(entry.name)) candidates.push(entry.name);
		}
		// 目录上限在列它们之前判断：越界就不必再为它们发 512+ 个帧。
		if (workspaceDirs.length > limits.maxWorkspaceDirs) throw new Error(REMOTE_SESSION_CODES.dirLimitExceeded);

		// 预算在 worker 里就扣：一旦越界就停止继续发列目录请求，而不是等 512 个目录都列完再判。
		const listings = await mapBounded(workspaceDirs, limits.concurrency, async (directory) => {
			const listing = await reader.list(hostId, directory);
			chargeListing(budget, listing.entries);
			return listing;
		});
		for (let index = 0; index < workspaceDirs.length; index += 1) {
			const directory = workspaceDirs[index];
			const listing = listings[index];
			for (const entry of listing.entries) {
				if (entry.kind === "file" && isJsonlName(entry.name)) candidates.push(directory + "/" + entry.name);
			}
		}
		// 文件上限同样在 stat 之前判断：越界是稳定码，不是截断。
		if (candidates.length > limits.maxFiles) throw new Error(REMOTE_SESSION_CODES.fileLimitExceeded);

		const entries = await mapBounded(candidates, limits.concurrency, async (remoteSessionId) => {
			charge(budget, REMOTE_SESSION_STAT_OVERHEAD_BYTES);
			const stat = await reader.stat(hostId, remoteSessionId);
			// 列表与 stat 之间类型变了（并发改名/替换）：跳过这条，不把非文件登记成会话。
			if (stat.kind !== "file") return undefined;
			const entry: RemoteSessionEntry = { remoteSessionId, remotePath: remoteSessionId, name: titleFromRemoteSessionId(remoteSessionId), size: stat.bytes, mtimeMs: stat.mtimeMs };
			return entry;
		});
		// 输出顺序固定（按远端身份升序）：同一棵远端目录树的两次扫描结果逐字可比。
		return entries.filter((entry): entry is RemoteSessionEntry => entry !== undefined).sort((left, right) => (left.remoteSessionId < right.remoteSessionId ? -1 : left.remoteSessionId > right.remoteSessionId ? 1 : 0));
	}

	return {
		// 导出物就是上面那个内部函数本身（同一个函数对象，不包一层）：语义逐字相同，没有第二条实现。
		resolveSessionRoot,
		async scan(hostId) {
			const host = readHostId(hostId);
			if (host === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
			const resolvedRoot = await resolveSessionRoot(host);
			if (!resolvedRoot.ok) return { ok: false, code: resolvedRoot.code };
			const root = resolvedRoot.root;
			try {
				const outcome = await port.withProjectSession(host, root, (session) => collectEntries(host, session));
				// withProjectSession 的建立失败（未连接/已断开）原样转述它自己的稳定码。
				if (!outcome.ok) return { ok: false, code: outcome.code };
				return { ok: true, entries: outcome.value };
			} catch (error) {
				return { ok: false, code: stableCodeOf(error) ?? REMOTE_SESSION_CODES.scanFailed };
			}
		},
		async register(input) {
			const host = readHostId(input?.hostId);
			if (host === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
			const remoteSessionId = readRemoteSessionId(input?.remoteSessionId);
			// 非法 id 一个帧都不发：形状不合法就不可能是一次远端发现。
			if (remoteSessionId === undefined) return { ok: false, code: REMOTE_SESSION_CODES.idInvalid };
			if (catalog === undefined) return { ok: false, code: REMOTE_SESSION_CODES.catalogUnavailable };
			// 归属必须按**会话所在目录**判定：同一主机上的两个项目不能靠「第一个」猜（真机 e2e 抓到过归错项目）。
			const projectId = projectIdForHost?.(host, remoteSessionId);
			if (typeof projectId !== "string" || projectId.length === 0) return { ok: false, code: REMOTE_SESSION_CODES.projectUnresolved };
			const resolvedRoot = await resolveSessionRoot(host);
			if (!resolvedRoot.ok) return { ok: false, code: resolvedRoot.code };
			const root = resolvedRoot.root;
			try {
				// 登记前先在远端确认这条 id 现在仍是一个普通文件：远端 id 不能凭空编造。
				const outcome = await port.withProjectSession(host, root, (session) => createRemoteWorkspaceReader({ port: sessionPort(session, host) }).stat(host, remoteSessionId));
				if (!outcome.ok) return { ok: false, code: outcome.code };
				if (outcome.value.kind !== "file") return { ok: false, code: "NOT_A_FILE" };
				// 登记的标题仍是文件名 stem（暂定，catalog 里标成 fallback）：真实标题走 title() 按需解析，
				// 登记路径**不读正文**（列表级发现必须与内容解析分离）。
				const registration = await catalog.ensureRemoteSession({ projectId, hostId: host, remoteSessionId, remotePath: remoteSessionId, title: titleFromRemoteSessionId(remoteSessionId), updatedAt: outcome.value.mtimeMs });
				return { ok: true, sessionId: registration.record.id, created: registration.created, remoteSessionId, remotePath: remoteSessionId };
			} catch (error) {
				return { ok: false, code: stableCodeOf(error) ?? REMOTE_SESSION_CODES.registerFailed };
			}
		},
		async title(input) {
			const host = readHostId(input?.hostId);
			if (host === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
			const remoteSessionId = readRemoteSessionId(input?.remoteSessionId);
			if (remoteSessionId === undefined) return { ok: false, code: REMOTE_SESSION_CODES.idInvalid };
			const resolvedRoot = await resolveSessionRoot(host);
			if (!resolvedRoot.ok) return { ok: false, code: resolvedRoot.code };
			const root = resolvedRoot.root;
			try {
				// 只读：整次解析在受控 root 内完成。帧预算 = 1 次 sizing stat + 头读 +（仅在头不足时）尾读，
				// 每段各自 ≤64 KiB；刻意不接收也不需要 catalog —— 标题通道不写盘（写盘仍只属于 register）。
				const outcome = await port.withProjectSession(host, root, async (session) => {
					const reader = createRemoteWorkspaceReader({ port: sessionPort(session, host) });
					const head = await reader.readHead(host, remoteSessionId, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
					// 头尾可能截断多字节字符：fatal:false 会得到 U+FFFD，落在最后一行 → 该行 JSON.parse 失败被跳过。
					const headText = new TextDecoder().decode(head.content);
					const headInference = inferSessionTitleFromHeadText(headText);
					// 头内已经有权威名（session_info 或旧版私有 sessionName 行）就够了：不读尾。
					if (isAuthoritativeTitle(headInference)) return { inference: headInference, tailDegraded: false };
					// 头已经覆盖整个文件（size ≤ 头上限）：尾窗口就是同一段内容，不重复读。
					if (head.size <= REMOTE_WORKSPACE_MAX_HEAD_BYTES) return { inference: headInference, tailDegraded: false };
					// pi 的 `/name` 是**追加在文件尾**的，所以只有头不足时才补一次有界尾窗口。
					// 尾读复用头读的 size ⇒ 全程只有 1 次 sizing stat；尾读是增益步骤：失败降级为头部结果
					// （与本地 readHeadAndInfer 的 best-effort 口径一致），而头读失败仍然按稳定码拒绝——
					// 那时连文件是否存在都没有证据。
					try {
						// 零重叠（K2-2）：尾窗起点取**头窗结束处**与「贴住文件尾」两者中更靠后的一个。
						// size > 128 KiB 时与原来一致（就是最后 ≤64 KiB）；64 KiB < size < 128 KiB 时只读头窗
						// 没覆盖的那段，不再重复传输头窗覆盖过的字节。
						const offset = Math.max(head.bytes, head.size - REMOTE_WORKSPACE_MAX_WINDOW_BYTES);
						const tail = await reader.readWindow(host, remoteSessionId, { offset, maxBytes: REMOTE_WORKSPACE_MAX_WINDOW_BYTES, size: head.size });
						if (tail.bytes === 0) return { inference: headInference, tailDegraded: false };
						// 同一套解析器跑 head + tail（本地 readHeadAndInfer 也是把两个窗口拼起来解析一次）：
						// 权威名优先，弱兜底仍取最早一条 user 文本（头窗口在前）。
						return { inference: inferSessionTitleFromHeadText(headText + "\n" + new TextDecoder().decode(tail.content)), tailDegraded: false };
					} catch {
						// 尾读失败**不再静默**（K2-3）：标题与档位仍是头部那份（诚实降级、绝不编造），
						// 但把「尾窗没读到」这件事如实带给调用方与界面。
						return { inference: headInference, tailDegraded: true };
					}
				});
				if (!outcome.ok) return { ok: false, code: outcome.code };
				const { inference, tailDegraded } = outcome.value;
				// tailDegraded 只在**真的降级**时出现（缺省即正常）：不给 shared 契约与既有 deepEqual 加噪声。
				const degraded = tailDegraded ? { tailDegraded: true } : {};
				// 解析不出绝不编造：强制 fallback 到文件名 stem（与 G3 的暂定标题同一取值）。
				if (inference.name === undefined) return { ok: true, title: titleFromRemoteSessionId(remoteSessionId), titleOrigin: "fallback", ...degraded };
				// 档位如实区分（口径冻结 authoritative/inferred/fallback）：来自名字字段 = authoritative
				// （含旧版私有 sessionName 行——本地 scannedTitleOrigin 对同一判据落 manual）；首条消息弱兜底 = inferred。
				return { ok: true, title: inference.name, titleOrigin: isAuthoritativeTitle(inference) ? "authoritative" : "inferred", ...degraded };
			} catch (error) {
				return { ok: false, code: stableCodeOf(error) ?? REMOTE_SESSION_CODES.titleFailed };
			}
		},
	};
}
