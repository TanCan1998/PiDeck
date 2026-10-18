/**
 * Go file-index sidecar 的宿主侧客户端（工作区文件索引：名字模糊检索 + 有界内容检索）。
 *
 * 为什么存在：主进程的文件名搜索（src/main/fs/FileSystemService.ts::searchNames）是
 * 实时 BFS——8s 超时、200 条上限、单目录 >5000 项跳过、只匹配条目名本身、无内容检索。
 * 本服务拉起 Go sidecar（native/file-index，内存索引 + 多核扫描）把名字检索做成毫秒级
 * 带评分排序，并补上「在工作区文件内容里搜词」的能力。
 *
 * 失败语义（调用方依赖降级）：任何失败以 `{ ok: false, reason }` 返回、绝不抛异常——
 * sidecar 缺失/崩溃/超时一律回退现有 BFS（fail-open，与 SessionIndexService 同哲学）。
 *
 * 生命周期纪律（清理路径唯一归属地，参照 SessionIndexService）：
 * - roots 签名变化（切换项目）→ 杀旧进程按新 roots 重拉（索引在内存里，重扫由 Go 完成）；
 * - boot 超时 / 进程退出 / stdin 管道错误 → 结算 pending 并标记 dead，下次调用重试；
 * - dispose → 结算 + 杀进程（quitCleanup 登记）；
 * - 所有子进程事件回调核对进程身份，旧进程迟到事件只吸收；
 * - 就绪态用同步三元态 childState 暴露（isReady），交互路径据此降级而不是等 boot 结束。
 *
 * 已知取舍：单进程单 roots（切项目重建索引，Go 侧毫秒级~秒级）。首查未就绪时回退 BFS
 * 并后台预热，下一次输入即走索引。
 *
 * 本模块不 import electron（路径解析由装配层注入），tests 可用 PassThrough 假子进程直接驱动。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { FileContentSearchHit, FileContentSearchResult, FileSearchResult } from "../../shared/types";

/** 与 native/file-index/main.go 的 ProtocolVersion 对应；不匹配即拒用（回退 BFS）。 */
export const FILE_INDEX_PROTOCOL_VERSION = 1;

/** boot 上限：内存索引一次目录树扫描（大仓库秒级），20s 已是慢盘/杀毒的极端形态。 */
const DEFAULT_BOOT_TIMEOUT_MS = 20_000;
/** 单次检索上限：名字检索毫秒级；内容检索受全局字节预算约束，15s 只是进程卡死保险。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** stdout 单行上限：结果规模（200 条名字 / 50 条内容命中）远小于此，防异常帧撑爆内存。 */
export const MAX_FILE_INDEX_LINE_CHARS = 4 * 1024 * 1024;

/** 名字检索结果上限：与 FILE_SEARCH_MAX_RESULTS（共享契约）对齐，渲染层已有 200 条的心理预期。 */
const DEFAULT_NAME_LIMIT = 200;
/** 内容检索结果上限：面板只展示摘要条，再多用户会继续输入缩小范围。 */
const DEFAULT_CONTENT_LIMIT = 50;
/** 内容检索单文件上限：超过即跳过（大二进制/日志文件对「搜代码」没有价值却吃满预算）。 */
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
/** 内容检索全局扫描字节预算：一次查询最多读这么多字节，防止大仓库把磁盘打满。 */
const DEFAULT_MAX_SCANNED_BYTES = 64 * 1024 * 1024;

export type FileIndexLogger = {
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};

export type FileIndexFailureReason = "binary-missing" | "boot-failed" | "timeout" | "protocol" | "request-failed" | "not-ready";

export type FileIndexCallResult<T> = { ok: true; value: T } | { ok: false; reason: FileIndexFailureReason; message: string };

export type FileIndexStats = {
	rootCount: number;
	fileCount: number;
	dirCount: number;
	indexMs: number;
	truncated: boolean;
};

/** 名字命中：shared 的 FileSearchResult 加上 Go 侧评分（渲染层不需要评分，IPC 边界会剥掉）。 */
export type FileIndexNameHit = FileSearchResult & { score: number };

export type FileIndexNameResult = {
	hits: FileIndexNameHit[];
	indexed: number;
	truncated: boolean;
};

export type FileIndexServiceOptions = {
	/** 二进制定位：返回 null 表示 sidecar 不可用（未构建/未随包分发），调用方直接降级。 */
	resolveBinaryPath: () => string | null;
	logger?: FileIndexLogger;
	/** 单测注入假子进程用；生产默认 node:child_process。 */
	spawnFn?: typeof spawn;
	timeouts?: { boot?: number; request?: number };
};

type ReadyFrame = { type: "ready"; protocolVersion?: number; rootCount?: number; fileCount?: number; dirCount?: number; indexMs?: number; truncated?: boolean };
type ResponseFrame = { type: "response"; id?: number; ok?: boolean; result?: unknown; error?: string };
type HostRecord = ReadyFrame | ResponseFrame | { type: string };

type RequestFrame = {
	cmd: "refresh" | "search-name" | "search-content";
	query?: string;
	limit?: number;
	maxFileBytes?: number;
	maxScannedBytes?: number;
};

type PendingRequest = {
	id: number;
	resolve: (value: never) => void;
	timer: NodeJS.Timeout;
};

function parseRecord(line: string): HostRecord | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return typeof (parsed as { type?: unknown }).type === "string" ? (parsed as HostRecord) : undefined;
	} catch {
		return undefined;
	}
}

export class FileIndexService {
	private readonly resolveBinaryPath: () => string | null;
	private readonly logger?: FileIndexLogger;
	private readonly spawnFn: typeof spawn;
	private readonly bootTimeoutMs: number;
	private readonly requestTimeoutMs: number;

	private disposed = false;
	private child: ChildProcessWithoutNullStreams | null = null;
	private childReady: Promise<"ready" | "dead"> | null = null;
	/** booting/ready/dead 三元态：isReady() 必须同步判断，不能 await childReady。 */
	private childState: "booting" | "ready" | "dead" | null = null;
	/** 当前进程的 roots 签名（\0 join）；变化即重启，防止索引口径漂移。 */
	private childRootsKey: string | null = null;
	private notifyReady: () => void = () => {};
	private notifyDead: () => void = () => {};
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	private stderrTail: string[] = [];
	private pending = new Map<number, PendingRequest>();
	private nextId = 1;

	constructor(options: FileIndexServiceOptions) {
		this.resolveBinaryPath = options.resolveBinaryPath;
		this.logger = options.logger;
		this.spawnFn = options.spawnFn ?? spawn;
		this.bootTimeoutMs = options.timeouts?.boot ?? DEFAULT_BOOT_TIMEOUT_MS;
		this.requestTimeoutMs = options.timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	/**
	 * 就绪探测：同步返回「现在发请求不会卡在 boot 上」。不拉进程、不等待。
	 * 交互路径（文件名搜索）先用它判断——未就绪直接回退 BFS，后台预热继续，
	 * 索引就绪后下一次输入自然走索引。
	 */
	isReady(roots: string[]): boolean {
		if (this.disposed || !this.child || this.childState !== "ready") return false;
		return this.childRootsKey === roots.join("\0");
	}

	/**
	 * 后台预热：fire-and-forget 建索引，失败静默（调用方已有 BFS 兜底）。
	 * 未就绪时每次搜索都会调它，因此必须防重入（booting/ready 且 roots 未变则直接返回）。
	 */
	warmup(roots: string[]): void {
		if (this.disposed || roots.length === 0) return;
		if (this.child && this.childRootsKey === roots.join("\0") && (this.childState === "booting" || this.childState === "ready")) return;
		void this.refresh(roots).catch(() => {});
	}

	/** 名字模糊检索（评分排序）。未就绪时会等 boot 结束，交互路径应先 isReady 判断。 */
	async searchNames(roots: string[], query: string, limit = DEFAULT_NAME_LIMIT): Promise<FileIndexCallResult<FileIndexNameResult>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<FileIndexNameResult>({ cmd: "search-name", query, limit });
	}

	/** 内容检索（有界实时扫描）。同样应先 isReady 再调用。 */
	async searchContent(roots: string[], query: string, limit = DEFAULT_CONTENT_LIMIT, maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxScannedBytes = DEFAULT_MAX_SCANNED_BYTES): Promise<FileIndexCallResult<FileContentSearchResult & { hits: FileContentSearchHit[] }>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<FileContentSearchResult & { hits: FileContentSearchHit[] }>({ cmd: "search-content", query, limit, maxFileBytes, maxScannedBytes });
	}

	/** 重建索引（预热与手动刷新用）。 */
	async refresh(roots: string[]): Promise<FileIndexCallResult<FileIndexStats>> {
		const boot = await this.ensureChild(roots);
		if (!boot.ok) return boot;
		return this.request<FileIndexStats>({ cmd: "refresh" });
	}

	/** 退出清理：结算所有在途请求并杀进程（幂等）。 */
	dispose(): void {
		this.disposed = true;
		this.settleAll("protocol", "文件索引服务已停止");
		this.killChild("dispose");
	}

	/** 保证子进程存在且已就绪（roots 签名变化即重启）。 */
	private async ensureChild(roots: string[]): Promise<FileIndexCallResult<true>> {
		if (this.disposed) return { ok: false, reason: "boot-failed", message: "文件索引服务已停止" };
		if (roots.length === 0) return { ok: false, reason: "not-ready", message: "无文件索引根目录" };

		const rootsKey = roots.join("\0");
		if (this.child && this.childRootsKey === rootsKey && this.childReady) {
			const state = await this.childReady;
			return state === "ready" ? { ok: true, value: true } : { ok: false, reason: "boot-failed", message: "文件索引进程启动失败" };
		}
		if (this.child) {
			// 项目切换：旧进程的索引口径已不适用，先结算在途请求再换进程。
			this.settleAll("protocol", "文件索引根目录已变更，索引进程重启");
			this.killChild("roots-swap");
		}

		const binaryPath = this.resolveBinaryPath();
		if (!binaryPath) return { ok: false, reason: "binary-missing", message: "文件索引二进制不存在（未构建或未随包分发）" };

		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.spawnFn(binaryPath, [...roots], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessWithoutNullStreams;
		} catch {
			return { ok: false, reason: "binary-missing", message: "文件索引进程启动失败" };
		}

		this.child = child;
		this.childRootsKey = rootsKey;
		this.childState = "booting";
		this.stderrTail = [];
		this.pending = new Map();
		this.buffer = "";
		this.decoder = new StringDecoder("utf8");

		child.stdin.on("error", (error: Error) => this.handleStdinError(child, error));
		child.stdout.on("data", (chunk: Buffer) => {
			if (this.child === child) this.consumeStdout(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (this.child !== child) return;
			const line = chunk.toString("utf8").trim();
			if (!line) return;
			for (const entry of line.split("\n")) {
				this.stderrTail.push(entry.trim());
				this.logger?.debug(`file-index: ${entry.trim()}`);
			}
			// 只保留尾部若干行：进程崩溃时要能报出 Go 侧最后一句原因，又不无限增长。
			if (this.stderrTail.length > 10) this.stderrTail = this.stderrTail.slice(-10);
		});
		child.on("error", (error: Error) => {
			if (this.child !== child) return;
			this.logger?.error(`file-index 进程错误：${error.message}`);
			this.markChildDead("boot-failed", "文件索引进程启动失败");
		});
		child.on("close", (code: number | null) => {
			if (this.child !== child) return;
			const tail = this.stderrTail.at(-1);
			this.logger?.warn(`file-index 进程退出（code ${code ?? "null"}）${tail ? `：${tail}` : ""}`);
			this.markChildDead("boot-failed", `文件索引进程退出（code ${code ?? "null"}）`);
		});

		const ready = new Promise<"ready" | "dead">((resolveReady) => {
			let settled = false;
			const bootTimer = setTimeout(() => {
				setImmediate(() => {
					if (settled) return;
					settled = true;
					this.logger?.warn(`file-index boot 超时（${this.bootTimeoutMs}ms），本次降级`);
					resolveReady("dead");
					this.killChild("boot-timeout");
				});
			}, this.bootTimeoutMs);
			this.notifyReady = () => {
				if (settled) return;
				settled = true;
				clearTimeout(bootTimer);
				this.childState = "ready";
				resolveReady("ready");
			};
			this.notifyDead = () => {
				if (settled) return;
				settled = true;
				clearTimeout(bootTimer);
				this.childState = "dead";
				resolveReady("dead");
			};
		});
		this.childReady = ready;

		const state = await ready;
		return state === "ready" ? { ok: true, value: true } : { ok: false, reason: "boot-failed", message: "文件索引进程启动失败" };
	}

	/** 拆掉当前子进程并置 dead（不杀进程，由调用方决定）。 */
	private teardownChild(): ChildProcessWithoutNullStreams | null {
		const child = this.child;
		this.child = null;
		this.childReady = null;
		this.childRootsKey = null;
		this.childState = "dead";
		this.buffer = "";
		this.decoder = new StringDecoder("utf8");
		this.notifyDead();
		return child;
	}

	/** 杀掉当前子进程：结算由调用方负责（boot 超时时 pending 尚未建立）。 */
	private killChild(reason: string): void {
		const child = this.teardownChild();
		if (!child) return;
		this.logger?.debug(`停止 file-index（${reason}）`);
		try {
			child.kill();
		} catch {
			// 进程可能已退出：kill 失败不影响状态机（这里只需尽量回收）。
		}
	}

	private handleStdinError(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.child !== child) return;
		this.logger?.error(`file-index stdin 错误：${error.message}`);
		this.killChild("stdin-error");
		this.settleAll("protocol", "文件索引进程管道已关闭");
	}

	/** 进程死亡：拆连接 + 结算在途请求（迟到事件由身份核对拦掉）。 */
	private markChildDead(reason: FileIndexFailureReason, message: string): void {
		this.teardownChild();
		this.settleAll(reason, message);
	}

	/** 发送请求并等待配对响应（超时/进程死亡都会结算，绝不悬挂）。 */
	private request<T>(frame: RequestFrame): Promise<FileIndexCallResult<T>> {
		const child = this.child;
		if (!child) return Promise.resolve({ ok: false, reason: "boot-failed", message: "文件索引进程不可用" });
		const id = this.nextId++;
		return new Promise<FileIndexCallResult<T>>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.logger?.warn(`file-index 请求超时：cmd=${frame.cmd} id=${id}`);
				resolve({ ok: false, reason: "timeout", message: "文件索引检索超时" });
			}, this.requestTimeoutMs);
			this.pending.set(id, { id, resolve: resolve as (value: never) => void, timer });
			try {
				child.stdin.write(`${JSON.stringify({ ...frame, id })}\n`);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				const message = error instanceof Error ? error.message : String(error);
				this.logger?.error(`file-index 写入失败：${message}`);
				resolve({ ok: false, reason: "protocol", message: "文件索引进程管道写入失败" });
			}
		});
	}

	/** 逐行消费 stdout（NDJSON）：行缓冲有上界，溢出即判定协议异常并回收进程。 */
	private consumeStdout(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		if (this.buffer.length > MAX_FILE_INDEX_LINE_CHARS) {
			this.logger?.error(`file-index stdout 行缓冲溢出：丢弃 ${this.buffer.length} 字节`);
			this.buffer = "";
			this.killChild("protocol");
			this.settleAll("protocol", "文件索引响应异常");
			return;
		}
		for (;;) {
			const lf = this.buffer.indexOf("\n");
			if (lf === -1) break;
			const line = this.buffer.slice(0, lf);
			this.buffer = this.buffer.slice(lf + 1);
			if (!line.trim()) continue;
			this.handleRecord(parseRecord(line), line);
		}
	}

	private handleRecord(record: HostRecord | undefined, rawLine: string): void {
		if (!record) {
			this.logger?.warn(`file-index stdout 非法行（已忽略）：${JSON.stringify(rawLine.slice(0, 200))}`);
			return;
		}
		if (record.type === "ready") {
			const ready = record as ReadyFrame;
			if (ready.protocolVersion !== FILE_INDEX_PROTOCOL_VERSION) {
				this.logger?.error(`file-index 协议版本不匹配：sidecar=${String(ready.protocolVersion)} 宿主=${FILE_INDEX_PROTOCOL_VERSION}`);
				this.killChild("protocol-version");
				this.settleAll("protocol", "文件索引协议版本不匹配");
				return;
			}
			this.logger?.info(`file-index ready：${String(ready.fileCount ?? "?")} 文件 / ${String(ready.dirCount ?? "?")} 目录，索引 ${String(ready.indexMs ?? "?")}ms${ready.truncated ? "（已截断）" : ""}`);
			this.notifyReady();
			return;
		}
		if (record.type !== "response") return;
		const response = record as ResponseFrame;
		const pending = this.pending.get(response.id ?? -1);
		if (!pending) return; // 迟到响应（超时已结算）直接丢弃
		this.pending.delete(response.id ?? -1);
		clearTimeout(pending.timer);
		if (response.ok) {
			(pending.resolve as (value: FileIndexCallResult<unknown>) => void)({ ok: true, value: response.result ?? null });
		} else {
			this.logger?.warn(`file-index 请求失败：${response.error ?? "unknown"}`);
			(pending.resolve as (value: FileIndexCallResult<unknown>) => void)({ ok: false, reason: "request-failed", message: response.error ?? "文件索引检索失败" });
		}
	}

	private settleAll(reason: FileIndexFailureReason, message: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			(pending.resolve as (value: FileIndexCallResult<unknown>) => void)({ ok: false, reason, message });
		}
		this.pending.clear();
	}
}
