/**
 * 远端 pi 运行时端口（Phase 4 P4.2 产品路由）。
 *
 * 这里只有一件事：把「远端会话怎么起来」从 `AgentManager` 里**借出去**。AgentManager 需要知道
 * 的只有两句：给我一条远端启动计划，给我配对的启动器；至于事实怎么探测（远端解释器/pi 入口/
 * runner 路径）、ssh 怎么拉、握手怎么等，全部留在 `RemoteHostConnectionService` 那条已验证的
 * 通道里 —— 这正是「PiDeck 不复制 pi 行为、也不为访问 pi 开第二条通道」的落点。
 *
 * 为什么端口是「注入 + 缺省拒绝」而不是「AgentManager 里判断远端」：
 * - 正式包/未开启实验时**不存在**远端能力，端口也不会被注入。缺省路径必须是拒绝（见
 *   `createRemoteUnlocked`），而不是拿远端项目的 cwd 去起一个本机 pi —— 后者不会报错，
 *   只会 stat 到一个本机同名路径（或 ENOENT 被吞掉），用户看到的是「会话莫名其妙起来了」。
 * - 端口由装配处构造（`src/main/index.ts`）：门禁表达式与连接服务单例都只允许有一份。
 *
 * 本模块**不**碰本机路径：plan 里的每个路径都由 `buildRemotePiRuntimePlan` 在构造点按远端
 * 绝对 POSIX 形状验过（本机 Windows 路径、相对路径当场抛稳定码）。
 */
import { randomUUID } from "node:crypto";
import type { RemotePiRuntimeFacts } from "../remote/RemoteHostConnectionService";
import type { PiRuntimeLauncher, RemoteSshPiRuntimeLaunchPlan } from "./PiSpawnHandle";
import { buildRemotePiRuntimePlan } from "./piRemoteRuntimePlan";
import type { PiRpcBaseArgsSettings } from "./piRpcArgs";

/**
 * 远端运行时域的稳定码（消息即码：调用方（协调器/测试）按字符串判定，绝不按措辞）。
 *
 * 为什么不是 `REMOTE_FEATURE_DISABLED`（远端 IPC 通道回答「门禁没开」的那个码）：会话链路里
 * 「拿不到服务」有三种来源，调用方无法区分——实验门禁关闭、装配还没跑到（本服务是懒建单例）、
 * 服务建造失败（ssh 客户端发现等）。前两种恰好是同一个「不可用」，第三种还要带上自己的原因，
 * 所以会话链路用一个更宽的 `unavailable`，而不是把「连不上/没建好」误报成「功能没开」。
 * **门禁位置不变**：仍只由 `registerIpc` 里的 `!app.isPackaged && PIDECK_REMOTE_EXPERIMENTAL === "1"`
 * 裁定，本模块不自己读环境变量（读第二处迟早会与它漂移）。
 */
export const REMOTE_RUNTIME_CODES = {
	/** 连接服务拿不到（门禁关闭 / 尚未装配 / 建造失败）：远端运行时不可用（**不**回退本机）。 */
	unavailable: "REMOTE_RUNTIME_UNAVAILABLE",
	/** `createLauncher()` 在 `prepare()` 之前被调用（端口契约错用）。 */
	launcherUnprepared: "REMOTE_RUNTIME_LAUNCHER_UNPREPARED",
	/** 远端会话属于一条 catalog 记录，而本批无法把它表达成 ssh locator（见 createRemoteUnlocked）。 */
	catalogIdentityUnsupported: "REMOTE_SESSION_CATALOG_IDENTITY_UNSUPPORTED",
	/** 本地专属操作（本机 fs/git/终端 cwd/会话文件读写）被要求对远端运行时执行。 */
	localOperationUnsupported: "REMOTE_RUNTIME_LOCAL_OPERATION_UNSUPPORTED",
} as const;

/** 启动准备入参：远端主机 + 远端工作目录 + 可选的「重开同一会话」。 */
export type RemoteRuntimePrepareInput = {
	readonly hostId: string;
	/** 远端项目根（canonical 远端绝对 POSIX；本机路径在这里是错误输入）。 */
	readonly remoteCwd: string;
	/** 「重开同一会话」时带上的远端会话文件（pi 自己报回来的那条远端路径）。 */
	readonly sessionFile?: string;
	/** 匿名会话：远端 pi 不落会话文件（与本地 `PiProcess.start` 追加 `--no-session` 同一语义）。 */
	readonly noSession?: boolean;
};

/**
 * AgentManager 看到的全部远端能力。
 *
 * `prepare()` 与 `createLauncher()` 是**配对**的两次调用：`prepare()` 负责解析出这一轮的
 * 远端事实与计划，并把与它同源（同一个已验证 client）的启动器记下来；`createLauncher()`
 * 只把上一轮 `prepare()` 配好的启动器交出去。这样计划与启动器一定来自同一份连接事实——
 * 分成两条路各取一次，就会出现「用 A 会话的探测结果、经 B 通道起进程」。
 */
export type RemoteRuntimePort = {
	prepare(input: RemoteRuntimePrepareInput): Promise<RemoteSshPiRuntimeLaunchPlan>;
	createLauncher(): PiRuntimeLauncher;
};

/** 端口需要的连接服务面（`RemoteHostConnectionService` 结构上满足，无需 import 具体实现）。 */
export type RemoteRuntimeServicePort = {
	remotePiRuntimeFacts(hostId: string): Promise<RemotePiRuntimeFacts>;
	createPiRuntimeLauncher(): PiRuntimeLauncher;
};

export type RemoteRuntimePortDeps = {
	/**
	 * 按需解析连接服务；门禁关闭或装配缺失时返回 undefined（端口据此 fail-closed）。
	 *
	 * 给解析器而不是给实例：连接服务是「实验门禁 + 异步探活」下的懒建对象，而 AgentManager
	 * 比它更早装配；解析器只在真正要起远端会话时才求值，也不会重复建第二个 client。
	 */
	resolveService(): Promise<RemoteRuntimeServicePort | undefined> | RemoteRuntimeServicePort | undefined;
	/** pi 的基础参数只认这一个设置来源（与本地 `PiProcess` 同一份：`piRpcOffline`）。 */
	settings(): PiRpcBaseArgsSettings;
	/** 一次运行的身份（runner lease 命名/握手校验）；缺省随机，测试可注入固定值。 */
	createNonce?(): string;
};

/**
 * 错误自带的稳定码（错误对象的 `code` 或 `message` 本身是稳定码），否则 undefined。
 * 与 `RemoteSessionScanner` 的 `stableCodeOf` 同口径：稳定码是「一个大写词」，不是一句话。
 */
function stableRemoteCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as { code?: unknown; message?: unknown };
	for (const value of [record.code, record.message]) {
		if (typeof value === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)) return value;
	}
	return undefined;
}

/** 与引导握手同一个 nonce 形态（首字符字母数字，16..64）：`randomUUID` 去横线正好 32 位 hex。 */
function defaultNonce(): string {
	return randomUUID().replace(/-/g, "");
}

export function createRemoteRuntimePort(deps: RemoteRuntimePortDeps): RemoteRuntimePort {
	let launcher: PiRuntimeLauncher | undefined;
	/** 计划里的 generation 是「这台主机上的第几次启动」：同一次运行内单调递增即可，不做跨重启持久化。 */
	let generation = 0;
	return {
		async prepare(input: RemoteRuntimePrepareInput): Promise<RemoteSshPiRuntimeLaunchPlan> {
			// **每次调用**都重新解析服务：AgentManager 比连接服务先装配，门禁/连接状态也随时可能变
			// （还没建、建失败、被 gate 关掉）。任何「构造时捕获一个当时还不存在的实例」的写法都会让
			// 远端永远拿不到服务（那正是本批要避免的静默失败）。
			let service: RemoteRuntimeServicePort | undefined;
			try {
				service = await deps.resolveService();
			} catch (error) {
				// 建造失败（如找不到可用的 ssh 客户端）自己带的稳定码更有指向性，能转述就转述；
				// 不带稳定码的异常折叠成 unavailable（与远端其它模块的失败关闭口径一致）。
				throw new Error(stableRemoteCode(error) ?? REMOTE_RUNTIME_CODES.unavailable);
			}
			if (!service) throw new Error(REMOTE_RUNTIME_CODES.unavailable);
			// 事实先取（它会确保主机已连上、runner 已按内容寻址部署），再在构造点验 plan 的形状。
			const facts = await service.remotePiRuntimeFacts(input.hostId);
			const plan = buildRemotePiRuntimePlan({
				hostId: input.hostId,
				generation: (generation += 1),
				remoteCwd: input.remoteCwd,
				nodePath: facts.nodePath,
				piPath: facts.piPath,
				runnerPath: facts.runnerPath,
				nonce: (deps.createNonce ?? defaultNonce)(),
				...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
				settings: deps.settings(),
			});
			launcher = service.createPiRuntimeLauncher();
			// `--no-session` 在这里补：`buildRemotePiArgs` 只产出基础参数与 `--session`（远端与本地共享
			// 同一份基础参数，不允许两处各写一套），而匿名会话在本地由 `PiProcess.start` 追加同一面旗标。
			// 远端不补，pi 会把一次 PiDeck 匿名会话写成一个远端会话文件——PiDeck 这边并不认它。
			return input.noSession ? { ...plan, args: [...plan.args, "--no-session"] } : plan;
		},
		createLauncher(): PiRuntimeLauncher {
			if (!launcher) throw new Error(REMOTE_RUNTIME_CODES.launcherUnprepared);
			return launcher;
		},
	};
}
