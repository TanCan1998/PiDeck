/**
 * Go session-store sidecar 的宿主侧客户端（会话数据面 Wave 1 骨架）。
 *
 * 为什么存在：同一份 pi 会话 JSONL 现在被 4 套 TS 各自解析（SessionScanner /
 * SessionCatalog / SessionHistoryReader / usageStats），每次打开会话都要重新读盘。
 * 本服务拉起 Go sidecar（native/session-store），用持久化快照 + 行边界增量扫描维护
 * 每文件的状态（已提交字节数/条目数/压缩标记），为 Wave 2 的窗口化读取与
 * Wave 3 的摘要/用量聚合打底。
 *
 * 失败语义（调用方依赖降级）：任何失败以 `{ ok: false, reason }` 返回、绝不抛异常——
 * sidecar 缺失/崩溃/超时一律回退现有 TS 解析路径（fail-open，与 SessionIndexService、
 * FileIndexService 同哲学）。
 *
 * 生命周期纪律（清理路径唯一归属地）：
 * - boot 超时 / 进程退出 / stdin 管道错误 → 结算 pending 并标记 dead，下次调用重试；
 * - dispose → 结算 + 杀进程（quitCleanup 登记）；
 * - 所有子进程事件回调核对进程身份，旧进程迟到事件只吸收；
 * - 就绪态用同步三元态 childState 暴露（isReady），调用方据此降级而不是等 boot 结束。
 *
 * 与两个兄弟服务的差异：roots 是**逐请求**参数（不是 spawn 参数），因此换 roots 不重启
 * 进程——同一进程可以服务任意会话根，快照按路径记账，与 roots 集合无关。
 *
 * 本模块不 import electron（路径解析由装配层注入），tests 可用 PassThrough 假子进程直接驱动。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** 与 native/session-store/main.go 的 protocolVersion 对应；不匹配即拒用（回退 TS 解析）。 */
export const SESSION_STORE_PROTOCOL_VERSION = 1;

/** boot 上限：打开快照 + 起进程，正常是毫秒级；20s 已是慢盘/杀毒的极端形态。 */
const DEFAULT_BOOT_TIMEOUT_MS = 20_000;
/**
 * 单次请求上限：`list-files` 首次要读完全部会话文件（实测 889 文件/595MiB ≈ 7.2s），
 * 慢盘上可能更久；命中快照时是几十毫秒。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** stdout 单行上限：结果按文件数增长（889 文件 ≈ 221KB），留足余量防异常帧撑爆内存。 */
export const MAX_SESSION_STORE_LINE_CHARS = 8 * 1024 * 1024;

export type SessionStoreLogger = {
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};

export type SessionStoreFailureReason = "binary-missing" | "boot-failed" | "timeout" | "protocol" | "request-failed" | "not-ready";

export type SessionStoreCallResult<T> = { ok: true; value: T } | { ok: false; reason: SessionStoreFailureReason; message: string };

/** 与 Go 侧 fileState 逐字段对齐（native/session-store/store.go）。 */
export type SessionStoreFileState = {
	path: string;
	/** 已提交字节数：恒落在完整行边界上，残行不计入。 */
	size: number;
	mtimeMs: number;
	/** Wave 1 内部口径：带字符串 id 的完整行数（精确去重口径属 Wave 2）。 */
	entryCount: number;
	hasCompaction: boolean;
	endsWithNewline: boolean;
};

export type SessionStoreListStats = {
	files: SessionStoreFileState[];
	reused: number;
	incremental: number;
	full: number;
	pruned: number;
	indexMs: number;
};

export type SessionStoreReadyInfo = {
	snapshotFiles: number;
	bootMs: number;
};

export type SessionStoreServiceOptions = {
	/** 快照落盘路径（装配层给 `<userData>/session-store/state.bin`）。 */
	statePath: string;
	/** 二进制定位：返回 null 表示 sidecar 不可用（未构建/未随包分发），调用方直接降级。 */
	resolveBinaryPath: () => string | null;
	logger?: SessionStoreLogger;
	/** 单测注入假子进程用；生产默认 node:child_process。 */
	spawnFn?: typeof spawn;
	timeouts?: { boot?: number; request?: number };
};

type ReadyFrame = { type: "ready"; protocolVersion?: number; snapshotFiles?: number; bootMs?: number };
type ResponseFrame = { type: "response"; id?: number; ok?: boolean; result?: unknown; error?: string };
type HostRecord = ReadyFrame | ResponseFrame | { type: string };

type RequestFrame = {
	cmd: "list-files" | "refresh";
	roots: string[];
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

export class SessionStoreService {
	private readonly statePath: string;
	private readonly resolveBinaryPath: () => string | null;
	private readonly logger?: SessionStoreLogger;
	private readonly spawnFn: typeof spawn;
	private readonly bootTimeoutMs: number;
	private readonly requestTimeoutMs: number;

	private disposed = false;
	private child: ChildProcessWithoutNullStreams | null = null;
	private childReady: Promise<"ready" | "dead"> | null = null;
	/** booting/ready/dead 三元态：isReady() 必须同步判断，不能 await childReady。 */
	private childState: "booting" | "ready" | "dead" | null = null;
	private readyInfo: SessionStoreReadyInfo | null = null;
	private notifyReady: () => void = () => {};
	private notifyDead: () => void = () => {};
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	private stderrTail: string[] = [];
	private pending = new Map<number, PendingRequest>();
	private nextId = 1;

	constructor(options: SessionStoreServiceOptions) {
		this.statePath = options.statePath;
		this.resolveBinaryPath = options.resolveBinaryPath;
		this.logger = options.logger;
		this.spawnFn = options.spawnFn ?? spawn;
		this.bootTimeoutMs = options.timeouts?.boot ?? DEFAULT_BOOT_TIMEOUT_MS;
		this.requestTimeoutMs = options.timeouts?.request ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	/** 就绪探测：同步返回「现在发请求不会卡在 boot 上」。不拉进程、不等待。 */
	isReady(): boolean {
		return !this.disposed && this.child !== null && this.childState === "ready";
	}

	/** 最近一次 ready 帧（诊断/日志用）；未就绪为 null。 */
	snapshotInfo(): SessionStoreReadyInfo | null {
		return this.readyInfo;
	}

	/**
	 * 后台预热：只把进程拉起来（快照在 Go 侧 load，毫秒级），不发请求。
	 * fire-and-forget，失败静默（调用方有 TS 解析兜底）。
	 */
	warmup(): void {
		if (this.disposed || this.childState === "booting" || this.childState === "ready") return;
		void this.ensureChild().catch(() => {});
	}

	/**
	 * 扫描会话根并返回文件状态（未变的复用快照、追加的只读尾段、变短的重扫）。
	 * 调用方应先 isReady() 判断；这里会等 boot 结束。
	 */
	async listFiles(roots: readonly string[]): Promise<SessionStoreCallResult<SessionStoreListStats>> {
		if (roots.length === 0) return { ok: false, reason: "not-ready", message: "无会话根目录" };
		const boot = await this.ensureChild();
		if (!boot.ok) return boot;
		return this.request<SessionStoreListStats>({ cmd: "list-files", roots: [...roots] });
	}

	/** 显式重建：与 listFiles 同一条请求（Go 侧按 mtime/size 自动决定复用/增量/全扫）。 */
	async refresh(roots: readonly string[]): Promise<SessionStoreCallResult<SessionStoreListStats>> {
		if (roots.length === 0) return { ok: false, reason: "not-ready", message: "无会话根目录" };
		const boot = await this.ensureChild();
		if (!boot.ok) return boot;
		return this.request<SessionStoreListStats>({ cmd: "refresh", roots: [...roots] });
	}

	/** 退出清理：结算所有在途请求并杀进程（幂等）。 */
	dispose(): void {
		this.disposed = true;
		this.settleAll("protocol", "会话存储服务已停止");
		this.killChild("dispose");
	}

	/** 保证子进程存在且已就绪（roots 逐请求传入，进程本身与 roots 无关）。 */
	private async ensureChild(): Promise<SessionStoreCallResult<true>> {
		if (this.disposed) return { ok: false, reason: "boot-failed", message: "会话存储服务已停止" };
		if (this.child && this.childReady) {
			const state = await this.childReady;
			return state === "ready" ? { ok: true, value: true } : { ok: false, reason: "boot-failed", message: "会话存储进程启动失败" };
		}

		const binaryPath = this.resolveBinaryPath();
		if (!binaryPath) return { ok: false, reason: "binary-missing", message: "会话存储二进制不存在（未构建或未随包分发）" };

		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.spawnFn(binaryPath, [this.statePath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessWithoutNullStreams;
		} catch {
			return { ok: false, reason: "binary-missing", message: "会话存储进程启动失败" };
		}

		this.child = child;
		this.childState = "booting";
		this.readyInfo = null;
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
				const trimmed = entry.trim();
				if (!trimmed) continue;
				this.stderrTail.push(trimmed);
				this.logger?.debug(`session-store: ${trimmed}`);
			}
			// 只保留尾部若干行：进程崩溃时要能报出 Go 侧最后一句原因，又不无限增长。
			if (this.stderrTail.length > 10) this.stderrTail = this.stderrTail.slice(-10);
		});
		child.on("error", (error: Error) => {
			if (this.child !== child) return;
			this.logger?.error(`session-store 进程错误：${error.message}`);
			this.markChildDead("boot-failed", "会话存储进程启动失败");
		});
		child.on("close", (code: number | null) => {
			if (this.child !== child) return;
			const tail = this.stderrTail.at(-1);
			this.logger?.warn(`session-store 进程退出（code ${code ?? "null"}）${tail ? `：${tail}` : ""}`);
			this.markChildDead("boot-failed", `会话存储进程退出（code ${code ?? "null"}）`);
		});

		const ready = new Promise<"ready" | "dead">((resolveReady) => {
			let settled = false;
			const bootTimer = setTimeout(() => {
				setImmediate(() => {
					if (settled) return;
					settled = true;
					this.logger?.warn(`session-store boot 超时（${this.bootTimeoutMs}ms），本次降级`);
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
		return state === "ready" ? { ok: true, value: true } : { ok: false, reason: "boot-failed", message: "会话存储进程启动失败" };
	}

	/** 拆掉当前子进程并置 dead（不杀进程，由调用方决定）。 */
	private teardownChild(): ChildProcessWithoutNullStreams | null {
		const child = this.child;
		this.child = null;
		this.childReady = null;
		this.childState = "dead";
		this.readyInfo = null;
		this.buffer = "";
		this.decoder = new StringDecoder("utf8");
		this.notifyDead();
		return child;
	}

	/** 杀掉当前子进程：结算由调用方负责（boot 超时时 pending 尚未建立）。 */
	private killChild(reason: string): void {
		const child = this.teardownChild();
		if (!child) return;
		this.logger?.debug(`停止 session-store（${reason}）`);
		try {
			child.kill();
		} catch {
			// 进程可能已退出：kill 失败不影响状态机（这里只需尽量回收）。
		}
	}

	private handleStdinError(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.child !== child) return;
		this.logger?.error(`session-store stdin 错误：${error.message}`);
		this.killChild("stdin-error");
		this.settleAll("protocol", "会话存储进程管道已关闭");
	}

	/** 进程死亡：拆连接 + 结算在途请求（迟到事件由身份核对拦掉）。 */
	private markChildDead(reason: SessionStoreFailureReason, message: string): void {
		this.teardownChild();
		this.settleAll(reason, message);
	}

	/** 发送请求并等待配对响应（超时/进程死亡都会结算，绝不悬挂）。 */
	private request<T>(frame: RequestFrame): Promise<SessionStoreCallResult<T>> {
		const child = this.child;
		if (!child) return Promise.resolve({ ok: false, reason: "boot-failed", message: "会话存储进程不可用" });
		const id = this.nextId++;
		return new Promise<SessionStoreCallResult<T>>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.logger?.warn(`session-store 请求超时：cmd=${frame.cmd} id=${id}`);
				resolve({ ok: false, reason: "timeout", message: "会话存储扫描超时" });
			}, this.requestTimeoutMs);
			this.pending.set(id, { id, resolve: resolve as (value: never) => void, timer });
			try {
				child.stdin.write(`${JSON.stringify({ ...frame, id })}\n`);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				const message = error instanceof Error ? error.message : String(error);
				this.logger?.error(`session-store 写入失败：${message}`);
				resolve({ ok: false, reason: "protocol", message: "会话存储进程管道写入失败" });
			}
		});
	}

	/** 逐行消费 stdout（NDJSON）：行缓冲有上界，溢出即判定协议异常并回收进程。 */
	private consumeStdout(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		if (this.buffer.length > MAX_SESSION_STORE_LINE_CHARS) {
			this.logger?.error(`session-store stdout 行缓冲溢出：丢弃 ${this.buffer.length} 字节`);
			this.buffer = "";
			this.killChild("protocol");
			this.settleAll("protocol", "会话存储响应异常");
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
			this.logger?.warn(`session-store stdout 非法行（已忽略）：${JSON.stringify(rawLine.slice(0, 200))}`);
			return;
		}
		if (record.type === "ready") {
			const ready = record as ReadyFrame;
			if (ready.protocolVersion !== SESSION_STORE_PROTOCOL_VERSION) {
				this.logger?.error(`session-store 协议版本不匹配：sidecar=${String(ready.protocolVersion)} 宿主=${SESSION_STORE_PROTOCOL_VERSION}`);
				this.killChild("protocol-version");
				this.settleAll("protocol", "会话存储协议版本不匹配");
				return;
			}
			this.readyInfo = { snapshotFiles: ready.snapshotFiles ?? 0, bootMs: ready.bootMs ?? 0 };
			this.logger?.info(`session-store ready：快照 ${this.readyInfo.snapshotFiles} 文件，boot ${this.readyInfo.bootMs}ms`);
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
			(pending.resolve as (value: SessionStoreCallResult<unknown>) => void)({ ok: true, value: response.result ?? null });
		} else {
			this.logger?.warn(`session-store 请求失败：${response.error ?? "unknown"}`);
			(pending.resolve as (value: SessionStoreCallResult<unknown>) => void)({ ok: false, reason: "request-failed", message: response.error ?? "会话存储扫描失败" });
		}
	}

	private settleAll(reason: SessionStoreFailureReason, message: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			(pending.resolve as (value: SessionStoreCallResult<unknown>) => void)({ ok: false, reason, message });
		}
		this.pending.clear();
	}
}
