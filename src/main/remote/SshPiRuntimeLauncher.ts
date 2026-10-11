/**
 * 远端 pi 运行时启动器（Phase 4 P4.2，设计 §3.3 方案 A「Agent 通路」）。
 *
 * 一条 pinned ssh 只干一件事：启动 P4.2 的冻结 `runner.mjs`；cwd、pi 参数、用户文本**都不进命令行**，
 * 而是握手后经 stdin 发一帧初始化请求（计划原文：不得把 cwd/Pi 参数/用户文本拼进远端 shell command）。
 * runner 负责 spawn 真 pi、写 lease、回收进程组；本模块只负责：
 *
 * 1. 拼固定命令 `<node> <runner>`（两段都走 POSIX 引用，路径形状先验）；
 * 2. 用 `lifetime: "session"` 启动（**不武装 wall-clock 期限**——远端会话要能活过任何固定预算；
 *    它只由配对 stop、spawn 失败、输出/行预算越界或 ssh 自行退出结束）；
 * 3. 写初始化帧 → 有界等 ready（或 error）；
 * 4. 把 ssh 的三根流交接成 `PiSpawnHandle`（stdin 逐行转发、stdout/stderr 直通、stop 转接）。
 *
 * **字节保留（计划点名的那条）**：`SshLauncherHandle` 只有「按行」投递，但它内部带 line backlog ——
 * 订阅者出现前到达的完整行会被保留并投递（且计入未消费字节预算）。所以握手读完 ready 后立即退订，
 * ready 之后（含同一 chunk 内后续）的行会留给随后挂上的 RPC 客户端，一个字节都不丢。pi 的 RPC 是
 * JSONL，按行交接与按字节交接等价；换行之外的内容（空行）本来就不是帧。
 *
 * 边界：本模块**不**做 lease 对账、**不**管本机路径（远端 plan 里出现本机路径是构造点的错误，
 * 见 `piRemoteRuntimePlan.ts` 的形状门）。
 */
import { PassThrough, Writable } from "node:stream";
import { buildPinnedSshInvocation } from "./SshVerifiedConnection";
import type { SshClientRuntime } from "./SshClientRuntime";
import type { SshLauncherHandle, SshProcessLauncher } from "./RemoteHostConnectionTypes";
import { SSH_LAUNCHER_MAX_OUTPUT_BYTES, SSH_LAUNCHER_DEFAULT_MAX_LINE_BYTES } from "./SshProcessLauncher";
import { buildRemoteRunnerCommand, decodeRemoteRunnerResultFrame, type RemoteRunnerReadyFrame } from "./RemoteRunnerContract";
import type { PiRuntimeExit, PiRuntimeLauncher, PiSpawnHandle, RemoteSshPiRuntimeLaunchPlan } from "./../pi/PiSpawnHandle";

/** 握手上限：ready/error 必须在此时限内到，否则视为「握手未确认」并停掉会话。 */
export const REMOTE_RUNTIME_HANDSHAKE_TIMEOUT_MS = 30_000;

export type SshPiRuntimeLauncherDeps = {
	readonly userDataDir: string;
	readonly client: SshClientRuntime;
	readonly launcher: SshProcessLauncher;
	readonly handshakeTimeoutMs?: number;
};

/** 远端启动器自己的稳定码（消息即码本身）。 */
export const REMOTE_RUNTIME_CODES = ["REMOTE_RUNTIME_LAUNCH_PLAN_INVALID", "REMOTE_RUNTIME_HANDSHAKE_INVALID", "REMOTE_RUNTIME_HANDSHAKE_TIMEOUT", "REMOTE_RUNTIME_HANDSHAKE_UNCONFIRMED"] as const;
export type RemoteRuntimeCode = (typeof REMOTE_RUNTIME_CODES)[number];

function fail(code: RemoteRuntimeCode): never {
	throw new Error(code);
}

/** 握手失败时把会话语收干净：失败路径同样必须配对释放（否则留下一条没人管的 ssh）。 */
async function stopQuietly(session: SshLauncherHandle): Promise<void> {
	await session.stop("abort").catch(() => undefined);
}

/**
 * 等 runner 的 ready/error。
 *
 * 失败关闭：拿到非帧的行、非法帧、nonce 不符都当场失败（不猜、不重试）；ssh 在 ready 前退出或超时
 * 同样失败，并且**一定先停会话语**再抛。
 */
async function awaitRunnerReady(session: SshLauncherHandle, expected: { nonce: string; timeoutMs: number }): Promise<RemoteRunnerReadyFrame> {
	return new Promise<RemoteRunnerReadyFrame>((resolve, reject) => {
		let settled = false;
		let offLine: (() => void) | undefined;
		let offExit: (() => void) | undefined;
		const finish = (outcome: { ok: true; ready: RemoteRunnerReadyFrame } | { ok: false; code: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			offLine?.();
			offExit?.();
			if (outcome.ok) {
				resolve(outcome.ready);
				return;
			}
			// 失败时**只**负责报错：会话语的释放由 launch() 的 catch 统一做（单一清理点，避免两处各停一次）。
			reject(new Error(outcome.code));
		};
		const timer = setTimeout(() => finish({ ok: false, code: "REMOTE_RUNTIME_HANDSHAKE_TIMEOUT" }), expected.timeoutMs);
		offExit = session.onExit(() => finish({ ok: false, code: "REMOTE_RUNTIME_HANDSHAKE_UNCONFIRMED" }));
		offLine = session.onStdoutLine((line) => {
			let frame: ReturnType<typeof decodeRemoteRunnerResultFrame>;
			try {
				frame = decodeRemoteRunnerResultFrame(line);
			} catch {
				// ready 之前出现非帧内容 = 协议违约（runner 在 ready 之后才开始直通 pi 的字节）。
				finish({ ok: false, code: "REMOTE_RUNTIME_HANDSHAKE_INVALID" });
				return;
			}
			if (frame.op === "error") {
				// runner 自己的码原样带出去：它是「远端没起来」的唯一权威归因（消息即码，诊断层只认这个）。
				finish({ ok: false, code: frame.code });
				return;
			}
			if (frame.nonce !== expected.nonce) {
				// 不属于本次握手的 ready：可能来自上一次运行的残留连接，绝不能当成自己的会话。
				finish({ ok: false, code: "REMOTE_RUNTIME_HANDSHAKE_INVALID" });
				return;
			}
			finish({ ok: true, ready: frame });
		});
		if (settled) {
			clearTimeout(timer);
			offLine?.();
			offExit?.();
		}
	});
}

/** 把会话语交接成 `PiSpawnHandle`：三根流 + stop 转接，不含任何协议解释。 */
function createRemoteHandle(session: SshLauncherHandle): PiSpawnHandle {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const exitListeners = new Set<(exit: PiRuntimeExit) => void>();
	let exited = false;
	let stopPromise: Promise<void> | undefined;
	// 订阅先挂上：backlog 里的行（ready 之后、RPC 客户端订阅之前）会在这里被投递，然后流进 client。
	session.onStdoutLine((line) => stdout.write(`${line}\n`));
	session.onStderrLine((line) => stderr.write(`${line}\n`));
	session.onExit((exit) => {
		exited = true;
		const fact: PiRuntimeExit = { code: exit.code, signal: exit.signal };
		stdout.end();
		stderr.end();
		for (const listener of exitListeners) listener(fact);
	});
	const stdin = new Writable({
		write(chunk, _encoding, callback) {
			try {
				// PiRpcClient 写的是「一帧一行」；会话语的 write 只接受单行，所以按行拆开写，并且
				// **去掉行尾换行**（由协议层自己补），避免把 \n 混进帧内容。
				const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
				for (const line of text.split("\n")) {
					if (line.length === 0) continue;
					session.write(line);
				}
				callback();
			} catch (error) {
				callback(error instanceof Error ? error : new Error(String(error)));
			}
		},
	});
	return {
		stdin,
		stdout,
		stderr,
		get pid() {
			return session.pid;
		},
		stop(reason) {
			// abort 与 shutdown 在会话层是同一条收敛路径（launcher 的既有语义）；这里只是转述。
			stopPromise ??= session.stop(reason === "abort" ? "abort" : "shutdown");
			return stopPromise;
		},
		onExit(listener) {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		onSpawnError() {
			// 远端没有「spawn 失败但进程在」的中间态：失败在 launch() 里以 reject 表达（见上）。
			return () => undefined;
		},
	};
}

export class SshPiRuntimeLauncher implements PiRuntimeLauncher {
	private readonly userDataDir: string;
	private readonly client: SshClientRuntime;
	private readonly launcher: SshProcessLauncher;
	private readonly handshakeTimeoutMs: number;

	constructor(deps: SshPiRuntimeLauncherDeps) {
		if (typeof deps?.userDataDir !== "string" || typeof deps.client?.run !== "function" || typeof deps.launcher?.start !== "function") fail("REMOTE_RUNTIME_LAUNCH_PLAN_INVALID");
		this.userDataDir = deps.userDataDir;
		this.client = deps.client;
		this.launcher = deps.launcher;
		this.handshakeTimeoutMs = deps.handshakeTimeoutMs ?? REMOTE_RUNTIME_HANDSHAKE_TIMEOUT_MS;
	}

	async launch(plan: RemoteSshPiRuntimeLaunchPlan): Promise<PiSpawnHandle> {
		if (plan?.kind !== "remote-ssh") fail("REMOTE_RUNTIME_LAUNCH_PLAN_INVALID");
		// 命令构造是最后一道路径门（两段路径形状 + 引用 + 命令长度上限都在里面）。
		const remoteCommand = buildRemoteRunnerCommand(plan.runnerPath, plan.nodePath);
		const invocation = await buildPinnedSshInvocation(this.userDataDir, plan.hostId, "ssh-batch", { client: this.client, remoteCommand });
		const session = await this.launcher.start({
			hostId: plan.hostId,
			generation: plan.generation,
			invocation,
			// session 档：远端会话必须能活过任何固定预算（command 档仍是有界短命令）。
			lifetime: "session",
			stdin: true,
			// 未消费字节预算放到上限：契约客户端会持续消费，但握手期与突发输出不该被 64 KiB 默认值掐掉。
			maxOutputBytes: SSH_LAUNCHER_MAX_OUTPUT_BYTES,
			maxLineBytes: SSH_LAUNCHER_DEFAULT_MAX_LINE_BYTES,
		});
		try {
			// 初始化帧：cwd + [解释器, pi 入口, ...pi 参数]。任何用户文本都不进命令行。
			session.write(JSON.stringify({ v: 1, op: "start", nonce: plan.nonce, cwd: plan.cwd, argv: [plan.nodePath, plan.piPath, ...plan.args] }));
			await awaitRunnerReady(session, { nonce: plan.nonce, timeoutMs: this.handshakeTimeoutMs });
		} catch (error) {
			await stopQuietly(session);
			throw error;
		}
		return createRemoteHandle(session);
	}
}

export function createSshPiRuntimeLauncher(deps: SshPiRuntimeLauncherDeps): PiRuntimeLauncher {
	return new SshPiRuntimeLauncher(deps);
}
