/**
 * GUI 扩展桥的宿主端点（§9.2）。
 *
 * **方向**：PiDeck **监听**、pi **连接**。桥只做 HTTP 客户端，
 * 因此没有端口冲突、没有陈旧发现文件、没有 fs.watch。
 *
 * - 每个 agent spawn 时分配一个**独立 token 与路径**（多会话天然隔离，§9.2）
 * - `POST /bridge/<token>/ui`：桥推更新（body `{updates:[...]}`），
 *   响应体带回待处理事件 `{events:[...]}`（一次往返完成双向）；
 *   渲染层要求重同步时额外带 `{resync:true}`，桥据此全量重推一次（§9.4）
 * - `POST /bridge/<token>/model-trace`：pi-deck-model-trace 扩展推模型请求快照
 *   （`ModelTraceInput`，同一 token 鉴权；会话由 token 反查，不新开端口/通道）
 * - 只绑 `127.0.0.1`，只认带正确 token 的请求
 *
 * **fail-safe**：端点起不来只是「桥不工作」，pi 会话与 PiDeck 都照常（§14.5）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { BridgeEvent, BridgeServiceName, BridgeUpdate, ModelTraceInput } from "../../../shared/types/bridge";
import { getAppLogger } from "../../logging/sharedLogger";

/** 宿主原生服务执行器（filePicker/openPath；由 AgentManager 注入真实 Electron 实现）。 */
export type BridgeServiceHandler = (service: BridgeServiceName, args: unknown) => Promise<unknown>;

/** 单个 agent 的桥会话。 */
type BridgeSession = {
	agentId: string;
	token: string;
	/** 待回灌给桥的事件队列。 */
	pendingEvents: BridgeEvent[];
	/** 最近一次收到桥数据的时间（诊断用）。 */
	lastSeenAt: number;
	/** 桥推来的更新计数（诊断用）。 */
	updateCount: number;
	/**
	 * 渲染层要求「全量重推一次」（§9.4）。
	 *
	 * 只在**下一次**轮询的响应体里带一次，带完立即清掉 —— 否则桥会每轮都重推。
	 */
	resyncRequested: boolean;
	/** 收到更新时的回调（由 AgentManager 注入，负责转发给渲染进程）。 */
	onUpdate: (update: BridgeUpdate) => void;
	/**
	 * 收到模型请求快照时的回调（由 AgentManager 注入）。
	 * 缺省表示不采集（旧调用方/测试）：快照被静默丢弃，桥其余功能不受影响。
	 */
	onModelTrace?: (trace: ModelTraceInput) => void;
};

/** 端点启动结果。 */
export type BridgeServerInfo = {
	/** 桥应访问的 base URL（注入给 pi 的 `PIDECK_BRIDGE_URL`）。 */
	baseUrl: string;
};

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4MB：单帧 UI 树的合理上界
const MAX_PENDING_EVENTS = 500;

/**
 * 桥端点服务。
 *
 * 进程内单例：一个 PiDeck 主进程只起一个 HTTP server，用 token 区分会话。
 */
export class BridgeServer {
	private server: Server | null = null;
	private port = 0;
	private readonly sessions = new Map<string, BridgeSession>();
	/** token → agentId 反查（请求路径里只有 token）。 */
	private readonly agentByToken = new Map<string, string>();
	/** 宿主原生服务执行器（未注入时 service-call 直接回错误，fail-safe）。 */
	private serviceHandler: BridgeServiceHandler | null = null;

	/** 注入服务执行器（AgentManager 启动时调用一次；BridgeServer 自身不 import electron）。 */
	setServiceHandler(handler: BridgeServiceHandler | null): void {
		this.serviceHandler = handler;
	}

	/** 端点是否已就绪。 */
	get ready(): boolean {
		return this.server !== null;
	}

	/** 当前监听端口（未启动为 0）。 */
	get listeningPort(): number {
		return this.port;
	}

	/**
	 * 启动端点（幂等）。失败返回 null —— 调用方据此不注入 env，桥静默不工作。
	 */
	async start(): Promise<BridgeServerInfo | null> {
		if (this.server) return { baseUrl: this.baseUrl() };
		try {
			const server = createServer((req, res) => {
				void this.handleRequest(req, res);
			});
			// 只绑回环：桥与 PiDeck 同机，不对外暴露
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					resolve();
				});
			});
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				return null;
			}
			this.server = server;
			this.port = address.port;
			void getAppLogger()?.info("gui-bridge", "Bridge endpoint listening", { port: this.port });
			return { baseUrl: this.baseUrl() };
		} catch (error) {
			void getAppLogger()?.warn("gui-bridge", "Bridge endpoint failed to start; bridge stays idle", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/** 关闭端点（应用退出时调用）。 */
	stop(): void {
		for (const session of this.sessions.values()) session.pendingEvents.length = 0;
		this.sessions.clear();
		this.agentByToken.clear();
		const server = this.server;
		this.server = null;
		this.port = 0;
		if (server) {
			try {
				server.close();
			} catch {
				// 已关闭
			}
		}
	}

	/**
	 * 为一个 agent 注册桥会话，返回要注入给 pi 的环境变量。
	 *
	 * `onUpdate` 由 AgentManager 注入：收到桥的更新后转发给渲染进程；
	 * `onModelTrace` 同理，接收 pi-deck-model-trace 推来的模型请求快照。
	 */
	registerAgent(agentId: string, onUpdate: (update: BridgeUpdate) => void, onModelTrace?: (trace: ModelTraceInput) => void): { url: string; token: string } {
		// 同 agentId 重复注册（重启/重连）→ 复用 token，保留队列
		const existing = this.findByAgent(agentId);
		const token = existing?.token ?? randomUUID();
		const session: BridgeSession = {
			agentId,
			token,
			pendingEvents: existing?.pendingEvents ?? [],
			lastSeenAt: Date.now(),
			updateCount: existing?.updateCount ?? 0,
			resyncRequested: existing?.resyncRequested ?? false,
			onUpdate,
			onModelTrace: onModelTrace ?? existing?.onModelTrace,
		};
		this.sessions.set(token, session);
		this.agentByToken.set(token, agentId);
		return { url: `${this.baseUrl()}/${token}`, token };
	}

	/** 注销某 agent 的桥会话（agent 停止 / 会话删除）。 */
	unregisterAgent(agentId: string): void {
		const session = this.findByAgent(agentId);
		if (!session) return;
		this.sessions.delete(session.token);
		this.agentByToken.delete(session.token);
	}

	/**
	 * 把渲染层来的交互事件排入该 agent 的待回灌队列。
	 *
	 * 桥会在下一次轮询（~100ms）时取走。返回是否找到会话。
	 */
	pushEvent(agentId: string, event: BridgeEvent): boolean {
		const session = this.findByAgent(agentId);
		if (!session) return false;
		// 队列上限：超出丢最旧的（避免渲染层刷屏把内存顶爆）
		if (session.pendingEvents.length >= MAX_PENDING_EVENTS) session.pendingEvents.shift();
		session.pendingEvents.push(event);
		return true;
	}

	/**
	 * 标记「下一次轮询时要求桥全量重推一次」（§9.4）。
	 *
	 * 渲染层在丢过桥状态时调用（换绑定 / 切会话 / 开设置弹窗 / 应用启动）。
	 * 返回是否找到会话；找不到（agent 已停 / 桥未注册）返回 false，调用方静默忽略。
	 */
	requestResync(agentId: string): boolean {
		const session = this.findByAgent(agentId);
		if (!session) return false;
		session.resyncRequested = true;
		return true;
	}

	/** 诊断：某 agent 的桥是否活着（最近有数据往来）。 */
	isAgentConnected(agentId: string, withinMs = 5000): boolean {
		const session = this.findByAgent(agentId);
		if (!session) return false;
		return Date.now() - session.lastSeenAt < withinMs;
	}

	private baseUrl(): string {
		return `http://127.0.0.1:${this.port}/bridge`;
	}

	private findByAgent(agentId: string): BridgeSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.agentId === agentId) return session;
		}
		return undefined;
	}

	/** 处理一次桥的请求。任何异常都返回 200 空体，避免桥侧重试风暴。 */
	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// 异常兜底响应按路由区分：/ui 的桥期待 {events}，trace 侧不解析响应体
		let route: "ui" | "model-trace" = "ui";
		try {
			if (req.method !== "POST") {
				this.respond(res, 405, { error: "method not allowed" });
				return;
			}
			const url = req.url ?? "";
			// 路径形态：/bridge/<token>/ui 或 /bridge/<token>/model-trace
			const match = url.match(/^\/bridge\/([^/]+)\/(ui|model-trace)\/?$/);
			if (!match) {
				this.respond(res, 404, { error: "not found" });
				return;
			}
			const token = match[1];
			route = match[2] as "ui" | "model-trace";
			const session = this.sessions.get(token);
			if (!session) {
				// 未知 token：可能是上一轮 runtime 的残留请求，静默接受但不做事
				this.respond(res, 200, route === "model-trace" ? { ok: false } : { events: [] });
				return;
			}
			// 请求头 token 强校验：路径 token 与请求头都必须是同一个秘密（PR 评审 §3）。
			// 以前写成「存在才比对」，缺头就放行 —— 等于第二层不存在；桥的 transport
			// （`pi-deck-gui-bridge-transport.ts` 的 postJson）一直在带这个头。
			const headerToken = req.headers["x-pideck-bridge-token"];
			if (headerToken !== token) {
				this.respond(res, 403, { error: "token mismatch" });
				return;
			}

			if (route === "model-trace") {
				await this.handleModelTraceRequest(session, req, res);
				return;
			}

			const body = await readBody(req);
			let parsed: { updates?: BridgeUpdate[] } = {};
			if (body.trim()) {
				try {
					parsed = JSON.parse(body) as { updates?: BridgeUpdate[] };
				} catch {
					// 非法 JSON：当作空更新（不打断桥的轮询）
					parsed = {};
				}
			}

			session.lastSeenAt = Date.now();
			const updates = Array.isArray(parsed.updates) ? parsed.updates : [];
			session.updateCount += updates.length;
			for (const update of updates) {
				try {
					// service-call 在主进程就地消化：不转发渲染层，结果进事件队列随下一轮轮询带回
					if (update.type === "service-call") {
						void this.handleServiceCall(session, update);
						continue;
					}
					session.onUpdate(update);
				} catch (error) {
					// 单个更新转发失败不影响其余，也不影响桥
					void getAppLogger()?.warn("gui-bridge", "Bridge update forwarding failed", {
						agentId: session.agentId,
						type: update?.type,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			// 响应体带回待处理事件（一次往返完成双向，§9.2）
			const events = session.pendingEvents.splice(0, session.pendingEvents.length);
			// 渲染层要求全量重推（§9.4）：只带一次，带完就清。
			// 老桥不认这个字段 → 行为不变（fail-safe，§14.5）。
			const resync = session.resyncRequested;
			session.resyncRequested = false;
			this.respond(res, 200, resync ? { events, resync: true } : { events });
		} catch (error) {
			// 端点自身出错也不能让桥卡住：返回 200 空体
			void getAppLogger()?.warn("gui-bridge", "Bridge request handling failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			try {
				this.respond(res, 200, route === "model-trace" ? { ok: false } : { events: [] });
			} catch {
				// 响应已发出
			}
		}
	}

	/** 执行一次宿主服务调用，把结果排入该会话的事件队列（随下一次轮询响应带回）。 */
	private async handleServiceCall(session: BridgeSession, update: Extract<BridgeUpdate, { type: "service-call" }>): Promise<void> {
		const { serviceId, service, args } = update;
		if (typeof serviceId !== "string" || !serviceId) {
			return; // 形状非法：没有 serviceId 可回，只能丢弃并记日志
		}
		if (typeof service !== "string") {
			this.pushEvent(session.agentId, { type: "service-result", serviceId, ok: false, error: "invalid service-call" });
			return;
		}
		const handler = this.serviceHandler;
		if (!handler) {
			this.pushEvent(session.agentId, { type: "service-result", serviceId, ok: false, error: "service unavailable" });
			return;
		}
		try {
			const result = await handler(service as BridgeServiceName, args);
			this.pushEvent(session.agentId, { type: "service-result", serviceId, ok: true, result: result === undefined ? null : result });
		} catch (error) {
			// 服务失败不能影响桥：回错误结果，扩展侧 Promise reject
			void getAppLogger()?.warn("gui-bridge", "Bridge service call failed", {
				agentId: session.agentId,
				service,
				error: error instanceof Error ? error.message : String(error),
			});
			this.pushEvent(session.agentId, { type: "service-result", serviceId, ok: false, error: error instanceof Error ? error.message : "service failed" });
		}
	}

	/**
	 * 处理一次模型请求快照推入（POST /bridge/<token>/model-trace）。
	 *
	 * 与 /ui 的区别：这是**单向**投递（响应体不带事件），且形状非法直接 400 ——
	 * trace 侧（pi-deck-model-trace 扩展）不重试，不存在重试风暴问题。
	 * 注意**不更新** lastSeenAt：isAgentConnected 的语义是「UI 桥在轮询」，
	 * 模型快照可以独立于桥工作（用户可能只关了桥扩展）。
	 */
	private async handleModelTraceRequest(session: BridgeSession, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readBody(req);
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			this.respond(res, 400, { ok: false, error: "invalid json" });
			return;
		}
		if (!isModelTraceInput(parsed)) {
			this.respond(res, 400, { ok: false, error: "invalid trace" });
			return;
		}
		try {
			session.onModelTrace?.(parsed);
		} catch (error) {
			// 单个快照处理失败不影响桥，也不影响后续快照
			void getAppLogger()?.warn("gui-bridge", "Model trace forwarding failed", {
				agentId: session.agentId,
				kind: parsed.kind,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.respond(res, 200, { ok: true });
	}

	private respond(res: ServerResponse, status: number, body: unknown): void {
		if (res.writableEnded) return;
		const text = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(text),
		});
		res.end(text);
	}
}

/**
 * 桥侧对模型快照的最小校验：形状不对直接拒绝。
 * 字段全量对齐由 tests/modelTraceExtension.test.mjs 断言（扩展侧是自包含 .ts，无法共享类型）。
 */
function isModelTraceInput(value: unknown): value is ModelTraceInput {
	if (typeof value !== "object" || value === null) return false;
	const trace = value as Record<string, unknown>;
	if (typeof trace.traceId !== "string" || trace.traceId.length === 0 || typeof trace.ts !== "number") return false;
	if (trace.kind === "request") return typeof trace.payloadJson === "string" && typeof trace.payloadBytes === "number";
	if (trace.kind === "response") return typeof trace.status === "number";
	return false;
}

/** 读取请求体，带大小上限。 */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				// 超限：停止累积，但要把流读干净，否则连接不复用
				chunks.length = 0;
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** 进程级单例（主进程一份）。 */
let sharedServer: BridgeServer | null = null;

export function getBridgeServer(): BridgeServer {
	if (!sharedServer) sharedServer = new BridgeServer();
	return sharedServer;
}

/** 应用退出时调用。 */
export function stopBridgeServer(): void {
	sharedServer?.stop();
	sharedServer = null;
}
