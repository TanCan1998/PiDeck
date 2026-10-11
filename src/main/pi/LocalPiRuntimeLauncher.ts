/**
 * 本地 pi 运行时启动器：`child_process.spawn` 的直接包裹（Phase 4 P4.0）。
 *
 * 行为必须与抽取前的 `PiProcess` **逐字一致**——它只是把同一段 spawn/停止/退出上报搬到一个可替换的
 * 边界后面，好让 P4.2 的远端实现接管同一条缝。逐字保留的四处细节：
 * 1. spawn 选项：`stdio: ["pipe","pipe","pipe"]`、`shell` 来自 plan、Unix 上 `detached: true`
 *    （pi 成为进程组组长，停止时才能用 `-pid` 对整组兜底）、`windowsHide: true`（PiDeck 是无控制台
 *    的 GUI 进程）、`windowsVerbatimArguments` 原样透传（Windows npm shim 含空格时靠它）。
 * 2. 停止顺序（Windows）：先 `taskkill /T /F` 整树、再 `kill()` 根进程——pi 的子代理是 pi 自己
 *    spawn 的独立进程，只杀根会把它们留成孤儿继续烧 token；`/T` 需要根进程存活才能枚举整棵树。
 * 3. 停止顺序（Unix）：先 `SIGTERM`（保持 pi 的优雅退出语义），再延迟对 `-pid` 补 `SIGKILL`
 *    （清理 pi 退出后残留的子代理）。计时器 `unref`，不阻止进程退出。
 * 4. spawn 失败只发 `error` 不发 `exit`：这类失败必须能被调用方认出来（`pid === undefined`），
 *    否则挂起的 RPC 请求要空等满超时、停放的扩展永不还原。
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { killProcessTree } from "../git/gitProcess";
import type { LocalPiRuntimeLaunchPlan, PiRuntimeExit, PiRuntimeLauncher, PiSpawnHandle } from "./PiSpawnHandle";

/** Unix 上给进程组补 SIGKILL 的延迟：与抽取前 `PiProcess.stop()` 的 3s 逐字一致。 */
export const LOCAL_PI_GROUP_KILL_DELAY_MS = 3_000;

export type LocalPiRuntimeLauncherOptions = {
	/** 可注入（测试）：默认 `node:child_process.spawn`。 */
	readonly spawn?: typeof nodeSpawn;
	/** 可注入（测试）：默认 `killProcessTree`（仅 Windows 分支使用）。 */
	readonly killTree?: (pid: number) => void;
	readonly platform?: NodeJS.Platform;
	readonly groupKillDelayMs?: number;
	/** 可注入（测试）：默认 `setTimeout` + `unref`。 */
	readonly schedule?: (task: () => void, delayMs: number) => void;
	/** 可注入（测试）：Unix 上对进程组补的 `SIGKILL`（默认 `process.kill(-pid, "SIGKILL")`，ESRCH 忽略）。 */
	readonly groupKill?: (pid: number) => void;
};

/** 进程组兜底：失败（ESRCH：组已不存在）忽略——组随最后一个成员退出自然消失。 */
/** 进程组兜底：失败（ESRCH：组已不存在）忽略——组随最后一个成员退出自然消失。 */
function defaultGroupKill(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		/* 组已不存在 */
	}
}

function defaultSchedule(task: () => void, delayMs: number): void {
	const timer = setTimeout(task, delayMs);
	timer.unref?.();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 计划校验：宁可在这里拒绝，也不要把半个 plan 交给 spawn（错误信息就是稳定码本身）。 */
function assertLaunchPlan(plan: unknown): asserts plan is LocalPiRuntimeLaunchPlan {
	if (!isRecord(plan) || plan.kind !== "local") throw new Error("PI_RUNTIME_LAUNCH_PLAN_INVALID");
	if (typeof plan.command !== "string" || plan.command.trim().length === 0) throw new Error("PI_RUNTIME_LAUNCH_PLAN_INVALID");
	if (!Array.isArray(plan.args) || plan.args.some((arg) => typeof arg !== "string")) throw new Error("PI_RUNTIME_LAUNCH_PLAN_INVALID");
	if (typeof plan.cwd !== "string" || plan.cwd.trim().length === 0) throw new Error("PI_RUNTIME_LAUNCH_PLAN_INVALID");
	if (typeof plan.shell !== "boolean") throw new Error("PI_RUNTIME_LAUNCH_PLAN_INVALID");
	if (!isRecord(plan.env)) throw new Error("PI_RUNTIME_LAUNCH_PLAN_INVALID");
	if (plan.windowsVerbatimArguments !== undefined && typeof plan.windowsVerbatimArguments !== "boolean") throw new Error("PI_RUNTIME_LAUNCH_PLAN_INVALID");
}

/**
 * 把一个已经 spawn 的 child 包成 handle。
 *
 * 监听器在 handle 创建时立刻挂上（不等调用方注册）：spawn 失败/立刻退出在 Node 里可能发生在
 * `launch()` 返回之前，晚挂就会丢掉那次事件——抽取前 `PiProcess` 正是在 spawn 之后立即绑定，
 * 这里保持同样的时序。已结算的事件对**之后**注册的监听器重放一次，保证不丢。
 */
function createLocalHandle(child: ChildProcessWithoutNullStreams, options: { readonly killTree: (pid: number) => void; readonly platform: NodeJS.Platform; readonly schedule: (task: () => void, delayMs: number) => void; readonly groupKillDelayMs: number; readonly groupKill: (pid: number) => void }): PiSpawnHandle {
	type ExitListener = (exit: PiRuntimeExit) => void;
	type ErrorListener = (error: Error) => void;
	// 用 EventEmitter 而不是自建集合：与 Node 的 child 一致地处理"先结算后注册"的重放语义。
	const events = new EventEmitter();
	let exited = false;
	let exitFact: PiRuntimeExit | undefined;
	let spawnedError: Error | undefined;
	let stopIssued = false;

	child.on("exit", (code, signal) => {
		exited = true;
		exitFact = { code, signal };
		events.emit("exit", exitFact);
	});
	child.on("error", (error: Error) => {
		spawnedError = error;
		events.emit("spawn-error", error);
	});

	return {
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr,
		get pid() {
			return child.pid;
		},
		onExit(listener: ExitListener) {
			events.on("exit", listener);
			let removed = false;
			// 已退出：**只向新注册的这个监听器**重放一次（下一个微任务），否则调用方会永远等一个不会再来的
			// 事件；不能 `events.emit`（那会把已经收过事件的旧监听器重复通知一遍）。
			if (exited && exitFact) {
				const fact = exitFact;
				queueMicrotask(() => {
					if (!removed) listener(fact);
				});
			}
			return () => {
				removed = true;
				events.off("exit", listener);
			};
		},
		onSpawnError(listener: ErrorListener) {
			events.on("spawn-error", listener);
			let removed = false;
			if (spawnedError) {
				const error = spawnedError;
				queueMicrotask(() => {
					if (!removed) listener(error);
				});
			}
			return () => {
				removed = true;
				events.off("spawn-error", listener);
			};
		},
		async stop(_reason) {
			// 已退出：没有东西可停（与抽取前 `PiProcess.stop()` 的 `if (!this.proc) return` 同义）。
			if (exited) return;
			const pid = child.pid;
			if (!stopIssued) {
				stopIssued = true;
				if (pid !== undefined && options.platform === "win32") options.killTree(pid);
				child.kill();
				if (pid !== undefined && options.platform !== "win32") {
					options.schedule(() => options.groupKill(pid), options.groupKillDelayMs);
				}
			}
			if (exited) return;
			await new Promise<void>((resolve) => {
				const off = this.onExit(() => {
					off();
					resolve();
				});
			});
		},
	};
}

export class LocalPiRuntimeLauncher implements PiRuntimeLauncher {
	private readonly spawnFn: typeof nodeSpawn;
	private readonly killTree: (pid: number) => void;
	/** 未显式注入时**每次 launch 重新读 `process.platform`**（与抽取前 `PiProcess` 的求值时机一致：
	 *  测试会在加载后改沙箱里的 platform）。 */
	private readonly platformOverride: NodeJS.Platform | undefined;
	private readonly groupKillDelayMs: number;
	private readonly schedule: (task: () => void, delayMs: number) => void;
	private readonly groupKill: (pid: number) => void;

	constructor(options: LocalPiRuntimeLauncherOptions = {}) {
		this.spawnFn = options.spawn ?? nodeSpawn;
		this.killTree = options.killTree ?? ((pid) => killProcessTree(pid));
		this.platformOverride = options.platform;
		this.groupKillDelayMs = options.groupKillDelayMs ?? LOCAL_PI_GROUP_KILL_DELAY_MS;
		this.schedule = options.schedule ?? defaultSchedule;
		this.groupKill = options.groupKill ?? defaultGroupKill;
	}

	async launch(plan: LocalPiRuntimeLaunchPlan): Promise<PiSpawnHandle> {
		assertLaunchPlan(plan);
		const platform = this.platformOverride ?? process.platform;
		// 同步抛错（cwd 非法等）直接 reject；异步的 spawn 失败走 handle.onSpawnError（Node 语义）。
		const child = this.spawnFn(plan.command, [...plan.args], {
			cwd: plan.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			shell: plan.shell,
			detached: platform !== "win32",
			env: plan.env,
			windowsHide: true,
			windowsVerbatimArguments: plan.windowsVerbatimArguments,
		});
		return createLocalHandle(child, {
			killTree: this.killTree,
			platform,
			schedule: this.schedule,
			groupKillDelayMs: this.groupKillDelayMs,
			groupKill: this.groupKill,
		});
	}
}
