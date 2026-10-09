/**
 * 远端 Session 只读发现（G3，Phase 3 第三段）。
 *
 * 这里做的事有三件：**列出远端会话文件**（列表级元数据）、**把其中一条幂等登记进本地 SessionCatalog**，
 * 以及**按需解析一条会话的标题**（H1：有界读头部后交给本地标题管线，只读、不写 catalog）。
 * 列表级扫描仍然不做任何内容解析——标题走独立通道；不做侧栏 UI、不做 move/archive/delete（Phase 4/5）。
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

import { REMOTE_HELPER_MAX_HOST_ID_LENGTH, type RemoteHelperListEntry } from "../remote/RemoteHelperContract";
import { createRemoteWorkspaceReader, REMOTE_WORKSPACE_MAX_HEAD_BYTES, type RemoteWorkspacePort } from "../remote/RemoteWorkspaceReader";
import { SUBAGENT_ARTIFACTS_DIR_NAME } from "../../shared/sessionIdentity";
import type { RemoteSessionRegistration, RemoteSessionRegistrationInput } from "./SessionCatalog";
import { inferSessionTitleFromHeadText } from "./sessionNameLine";
// 渲染层要消费这三个结构，所以它们是 shared 契约而不是本模块私有类型；这里只转出，避免同一结构两处各定义一份。
import type { RemoteSessionEntry, RemoteSessionRegisterResult, RemoteSessionScanResult, RemoteSessionTitleResult } from "../../shared/types/remoteHost";
export type { RemoteSessionEntry, RemoteSessionRegisterResult, RemoteSessionScanResult } from "../../shared/types/remoteHost";
// H1 新增的按需标题结果同样只转出 shared 契约（remoteSessionWiring 钉的是上一行的既有形状，不合并两行）。
export type { RemoteSessionTitleResult } from "../../shared/types/remoteHost";

/** 会话根相对远端 home 的固定后缀（冻结设计第 1 条：<remote home>/.pi/agent/sessions）。 */
export const REMOTE_SESSION_ROOT_SUFFIX = ".pi/agent/sessions";

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
	withProjectSession<T>(hostId: string, root: string, task: (session: RemoteSessionSessionPort) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }>;
};

/** catalog 侧只用到 ensureRemoteSession 这一个入口（SessionCatalog 结构上满足）。 */
export type RemoteSessionCatalogPort = {
	ensureRemoteSession(input: RemoteSessionRegistrationInput): Promise<RemoteSessionRegistration>;
};

/** 远端会话归属哪个本地项目由装配决定（本批不解析正文，无法自行推断）。 */
export type RemoteSessionProjectResolver = (hostId: string) => string | undefined;

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

export type RemoteSessionScanner = {
	/** 只读列出远端会话；不写 catalog、不读正文。 */
	scan(hostId: string): Promise<RemoteSessionScanResult>;
	/** 在远端确认该文件仍存在后，幂等登记进 catalog 并返回稳定 sessionId。 */
	register(input: { hostId: string; remoteSessionId: string }): Promise<RemoteSessionRegisterResult>;
	/**
	 * 按需解析真实标题（H1）：有界读头部（≤ REMOTE_WORKSPACE_MAX_HEAD_BYTES）交给本地标题管线。
	 * 只读、不写 catalog；解析不出强制 fallback（title = 文件名 stem），绝不编造。
	 */
	title(input: { hostId: string; remoteSessionId: string }): Promise<RemoteSessionTitleResult>;
};

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

/** hostId 要在发帧前就能当诊断身份与传输键用；非法值不回显。 */
function readHostId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_HELPER_MAX_HOST_ID_LENGTH || CONTROL_CHARS.test(value)) return undefined;
	return value;
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

/** 文件名 stem（暂定标题）。时间戳 stem 由 catalog 的展示层清成 Untitled，这里不做产品判断。 */
function titleFromRemoteSessionId(remoteSessionId: string): string {
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

	/** 会话根 = <remote home>/.pi/agent/sessions；home 不是绝对 POSIX 路径就 fail closed。 */
	async function resolveSessionRoot(hostId: string): Promise<string | undefined> {
		let home: unknown;
		try {
			home = await port.remoteHome(hostId);
		} catch {
			return undefined;
		}
		if (typeof home !== "string" || home.length === 0 || home.length > REMOTE_SESSION_MAX_PATH_LENGTH || CONTROL_CHARS.test(home) || !home.startsWith("/")) return undefined;
		return home.replace(/\/+$/, "") + "/" + REMOTE_SESSION_ROOT_SUFFIX;
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
		async scan(hostId) {
			const host = readHostId(hostId);
			if (host === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
			const root = await resolveSessionRoot(host);
			if (root === undefined) return { ok: false, code: REMOTE_SESSION_CODES.homeUnavailable };
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
			const projectId = projectIdForHost?.(host);
			if (typeof projectId !== "string" || projectId.length === 0) return { ok: false, code: REMOTE_SESSION_CODES.projectUnresolved };
			const root = await resolveSessionRoot(host);
			if (root === undefined) return { ok: false, code: REMOTE_SESSION_CODES.homeUnavailable };
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
			const root = await resolveSessionRoot(host);
			if (root === undefined) return { ok: false, code: REMOTE_SESSION_CODES.homeUnavailable };
			try {
				// 只读：整次解析在受控 root 内完成，只发 readHead 内部的 sizing stat + 一次 ≤64 KiB 的 fs.read；
				// 刻意不接收也不需要 catalog —— 标题通道不写盘（写盘仍只属于 register）。
				const outcome = await port.withProjectSession(host, root, async (session) => {
					const reader = createRemoteWorkspaceReader({ port: sessionPort(session, host) });
					const head = await reader.readHead(host, remoteSessionId, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
					// 头尾可能截断多字节字符：fatal:false 会得到 U+FFFD，落在最后一行 → 该行 JSON.parse 失败被跳过。
					return new TextDecoder().decode(head.content);
				});
				if (!outcome.ok) return { ok: false, code: outcome.code };
				const inferred = inferSessionTitleFromHeadText(outcome.value);
				// 解析不出绝不编造：强制 fallback 到文件名 stem（与 G3 的暂定标题同一取值）。
				// parsed 含弱兜底（首条 user/assistant 文本）——那正是本地管线给出的标题，catalog 侧由所有权来源区分强弱。
				return inferred.name === undefined ? { ok: true, title: titleFromRemoteSessionId(remoteSessionId), titleOrigin: "fallback" } : { ok: true, title: inferred.name, titleOrigin: "parsed" };
			} catch (error) {
				return { ok: false, code: stableCodeOf(error) ?? REMOTE_SESSION_CODES.titleFailed };
			}
		},
	};
}
