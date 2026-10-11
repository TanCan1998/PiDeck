/**
 * pi 运行时进程的「可替换启动面」（Phase 4 P4.0，实施计划 §6.2）。
 *
 * 为什么需要这层：远端会话与本地会话的区别**只在"进程从哪里起来"**——Pi RPC 的帧、事件、
 * runtimeGeneration fencing、诊断与生命周期语义必须完全一致。把启动面抽成一个 handle，
 * `PiProcess` 就能只认 handle 而不认 `child_process`，P4.2 的远端实现（一条 pinned ssh +
 * runner 握手之后的字节流）因此不需要复制任何 RPC 语义。
 *
 * 边界（刻意不做的事）：
 * - **不在这里准备启动参数**。命令定位、版本探测、WSL 路径转换、扩展/技能/提示词白名单、
 *   命令行长度 fallback、环境清洗都留在调用方（今天在 `PiProcess.start()`）：那些是"plan 怎么来"
 *   的问题，属于 location-aware 的准备阶段（P4.2）。本模块只回答"给我一个 plan，怎么把它变成
 *   一个可停可等的进程"。
 * - **不解析 stdout**。handle 只交出三条流；`PiRpcClient` 照旧由调用方挂在 `stdout`/`stdin` 上。
 * - **不做 fencing**。重建 runtime 时递增 `runtimeGeneration` 是 owner（`SessionRuntimeCoordinator`）
 *   的职责，launcher 重建只是它的一次动作。
 *
 * 与计划文本的一处偏差（已记录）：计划给的接口只有 `onExit`。但 Node 的 spawn 失败**只发 error、
 * 不发 exit**（pid 从未拿到），而本仓库依赖这个区分做启动失败归因（`diagnostics.spawnFailed`、
 * 不能用 `exit` 语义混淆"起来过又退出"）。因此 handle 额外提供 `onSpawnError`：`launch()` 只在
 * **同步**抛错时 reject，异步的 spawn 失败仍走这个回调，调用方的既有错误路径逐字不变。
 */

/** 进程退出事实。`code`/`signal` 与 Node 的 `exit` 事件同名同义。 */
export type PiRuntimeExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

/** 为什么停：本地实现只用于日志/诊断；远端 runner 用它决定 lease 的回收措辞（P4.2）。 */
export type PiRuntimeStopReason = "abort" | "restart" | "shutdown";

/**
 * 本地启动计划：逐字段对应今天 `PiProcess` 传给 `spawn` 的输入，**不新增语义**。
 *
 * `kind` 是位置判别式：P4.2 增加 `{ kind: "remote-ssh"; ... }`，届时该变体只允许包含远端路径与
 * 已部署 artifact 引用——任何本机绝对路径出现在远端 plan 里都是错的（契约测试会在那一批加）。
 */
export type PiRuntimeLaunchPlan = {
	readonly kind: "local";
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	/** 已经过 `PiLocator.createProcessEnv` 清洗与安全门注入的环境（launcher 不再追加任何变量）。 */
	readonly env: NodeJS.ProcessEnv;
	/** Windows 上的 npm shim 需要 shell 解析（与 `PiLocator.createInvocation().shell` 同源）。 */
	readonly shell: boolean;
	readonly windowsVerbatimArguments?: boolean;
};

/** 一个已经起来的 pi 运行时进程。 */
export type PiSpawnHandle = {
	readonly stdin: NodeJS.WritableStream;
	readonly stdout: NodeJS.ReadableStream;
	readonly stderr: NodeJS.ReadableStream;
	/** 尚未拿到 pid（spawn 未成功）时为 undefined，与 Node 语义一致。 */
	readonly pid: number | undefined;
	/**
	 * 停止进程（含进程树回收）。幂等：重复调用不会重复发信号或重复武装兜底。
	 * 返回的 promise 在**观察到退出**后 resolve（已退出则立即 resolve）；不 reject。
	 */
	stop(reason: PiRuntimeStopReason): Promise<void>;
	/** 返回退订函数。注册时若已退出，监听器会在下一个微任务收到一次（不丢事件）。 */
	onExit(listener: (exit: PiRuntimeExit) => void): () => void;
	/** spawn 失败（Node 的 error 事件；此时不会有 exit 事件）。返回退订函数。 */
	onSpawnError(listener: (error: Error) => void): () => void;
};

/** 启动面。`launch()` 的 reject 属于**同步**失败（参数非法、spawn 同步抛错）。 */
export type PiRuntimeLauncher = {
	launch(plan: PiRuntimeLaunchPlan): Promise<PiSpawnHandle>;
};
