import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { sep } from "node:path";
import type { IPty } from "node-pty";
import { ipcChannels } from "../../shared/ipc";
import { terminalOwnerKeyFor } from "../../shared/types/terminal";
import type { TerminalShell, TerminalTab, TerminalTarget } from "../../shared/types";
import { isLocalProject } from "../../shared/projectLocation";
import type { ProjectStore } from "../projects/ProjectStore";
import { LocalTerminalSessionLauncher, getTerminalShellCandidates, type TerminalWslSettings } from "./TerminalSessionLauncher";
import { createTerminalDataBatcher, type TerminalDataBatcher } from "./terminalDataBatching";

export { getTerminalShellCandidates };

// 简单日志，不依赖 appLogger 以避免循环引用
const log = (msg: string) => {
	console.error(`[TerminalSessionManager] ${msg}`);
};

type TerminalRuntime = {
	tab: TerminalTab;
	pty: IPty;
	/** 主进程回放缓冲（切回时重建 xterm 用），有 200K 字符上限 */
	buffer: string;
	/** PTY 输出合批器：16ms 内的小 chunk 合成一次 IPC emit，exit/close 前必须 flush 保序 */
	batcher: TerminalDataBatcher;
};

type Emit = (channel: string, payload: unknown) => void;
const MAX_TERMINAL_REPLAY_BUFFER = 200_000;
export function isAgentOwnerKey(ownerKey: string): boolean {
	return ownerKey.startsWith("agent:");
}

/**
 * 裸命令名走 PATH 查找，绝对/相对路径查 existsSync。找不到时该 shell 标为不可用。
 * 只做存在性检查，不真的 spawn PTY —— 探测不应有副作用（不会留下多余 shell 进程）。
 */
export function isShellCommandAvailable(command: string): boolean {
	if (command.includes("/") || command.includes("\\")) return existsSync(command);
	const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
	for (const dir of dirs) {
		if (!dir) continue;
		for (const ext of exts) {
			if (existsSync(`${dir}${sep}${command}${ext}`)) return true;
		}
	}
	return false;
}
export class TerminalSessionManager {
	private readonly runtimes = new Map<string, Map<string, TerminalRuntime>>();
	/** 每归属锿的标题序号计数器：标题必须与序号一一对应，关闭后不复用，
	 * 否则同桶两个活动 tab 会同名（「pwsh 2」×2）。桶删除时同步清理（见 close/closeAgent/closeOwner）。 */
	private readonly ownerSeq = new Map<string, number>();

	private readonly launcher: LocalTerminalSessionLauncher;

	constructor(
		private readonly getAgentCwd: (agentId: string) => string,
		private readonly emit: Emit,
		private readonly projectStore: Pick<ProjectStore, "get">,
		private readonly getSettings: () => TerminalWslSettings = () => ({}),
	) {
		this.launcher = new LocalTerminalSessionLauncher(getSettings, log);
	}

	/** Targets are resolved from trusted runtime/project stores, never from renderer paths. */
	private cwdFor(target: TerminalTarget): string {
		if (target.kind === "agent") return this.getAgentCwd(target.agentId);
		const project = this.projectStore.get(target.projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		if (project.kind === "chat") throw new Error("TERMINAL_PROJECT_UNSUPPORTED");
		// 远端终端（Phase 5）尚未实现：拒绝而不是拿远端路径当本机 cwd 启动本地 shell。
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		return project.path;
	}

	list(target: TerminalTarget) {
		return [...(this.runtimes.get(terminalOwnerKeyFor(target))?.values() ?? [])].map((runtime) => this.snapshot(runtime));
	}

	/**
	 * 返回当前平台可用的终端 shell 列表，供前端下拉选择。
	 * 返回前检测每个候选是否可 spawn，不可用的标记为 available: false。
	 */
	listShells(): { shell: TerminalShell; label: string; available: boolean }[] {
		return this.launcher.candidates().map((c) => ({
			shell: c.shell,
			label: this.displayShell(c.shell),
			// 候选列表本身已按平台探测过（shellCandidates 里 git-bash/wsl 走 existsSync），
			// 这里补一层可执行性判定：绝对路径查 existsSync，裸命令名走 PATH 查找。
			// 判为不可用时置灰，避免用户点了 shell 却 spawn 失败（此前恒 true 是死代码）。
			available: isShellCommandAvailable(c.command),
		}));
	}

	ensure(target: TerminalTarget) {
		const existing = this.list(target);
		if (existing.length > 0) return existing;
		// Renderer 在 StrictMode 下会重复触发 mount effect；这里提供原子兜底，
		// 避免 list -> create 两步之间的竞态导致“未点击却多出两个终端”。
		return [this.create(target)];
	}

	create(target: TerminalTarget, shell?: TerminalShell): TerminalTab {
		const ownerKey = terminalOwnerKeyFor(target);
		const resolvedCwd = this.cwdFor(target);
		// spawn 必须先于桶/序号分配：node-pty 不可用或所有 shell 都 spawn 失败时
		// create 会抛错，不能留下空桶和已被消耗的标题序号（渲染层每次挂载都会重试）。
		const spawned = this.launcher.spawn({ cwd: resolvedCwd, preferredShell: shell });
		const runtimes = this.ensureOwner(ownerKey);
		// 单调递增序号：不能用 runtimes.size + 1（关闭一个 tab 后 size 回退，新建会与存活 tab 撞名）
		const seq = (this.ownerSeq.get(ownerKey) ?? 0) + 1;
		this.ownerSeq.set(ownerKey, seq);
		const id = randomUUID();
		const tab: TerminalTab = {
			id,
			agentId: target.kind === "agent" ? target.agentId : "",
			ownerKey,
			title: `${this.displayShell(spawned.shell)} ${seq}`,
			shell: spawned.shell,
			createdAt: Date.now(),
		};
		// 16ms（一帧）合批：node-pty 高吞吐时逐 chunk emit 会让主进程与渲染层
		// 双双被 IPC 调用频率打满；合批后打字回显延迟人眼不可感知。
		const runtime: TerminalRuntime = {
			tab,
			pty: spawned.pty,
			buffer: "",
			batcher: createTerminalDataBatcher((data) => {
				this.emit(ipcChannels.terminalData, { tabId: id, data });
			}),
		};
		runtimes.set(id, runtime);

		spawned.pty.onData((data) => {
			this.appendBuffer(runtime, data);
			runtime.batcher.push(data);
		});
		spawned.pty.onExit((event) => {
			// 保序：退出事件发出前，把已收到的输出全部送达渲染层
			runtime.batcher.flush();
			tab.exited = true;
			tab.exitCode = event.exitCode;
			const exitText = `\r\n[process exited${event.exitCode != null ? ` with code ${event.exitCode}` : ""}]\r\n`;
			this.appendBuffer(runtime, exitText);
			this.emit(ipcChannels.terminalExit, {
				tabId: id,
				exitCode: event.exitCode,
			});
		});

		return tab;
	}

	input(tabId: string, data: string) {
		// 与 resize 同源约定：tab 已删（用户关闭/agent 重启 closeAgent）后，渲染层 xterm
		// 卸载前的迟到按键静默忽略——requireTab 式 throw 会经 ipcMain.handle 变成渲染层 rejection。
		const found = this.findRuntime(tabId);
		if (!found || found.runtime.tab.exited) return;
		found.runtime.pty.write(data);
	}

	resize(tabId: string, cols: number, rows: number) {
		// 终端已关闭时静默忽略 resize，避免已销毁的 tab 触发未处理异常
		const found = this.findRuntime(tabId);
		if (!found || found.runtime.tab.exited) return;
		found.runtime.pty.resize(Math.max(2, cols), Math.max(1, rows));
	}

	close(tabId: string) {
		const found = this.findRuntime(tabId);
		if (!found) return;
		// 关闭前冲刷并停用合批器：kill 触发的 onExit 仍会 flush，但 dispose 后为 no-op，
		// 避免已删 runtime 的尾巴数据在 close 之后迟到
		found.runtime.batcher.flush();
		found.runtime.batcher.dispose();
		found.runtime.pty.kill();
		found.tabs.delete(tabId);
		if (found.tabs.size === 0) {
			this.runtimes.delete(found.runtime.tab.ownerKey);
			this.ownerSeq.delete(found.runtime.tab.ownerKey);
		}
	}

	/** 关闭某个 agent 的全部终端（agent 退出/重启时调用） */
	closeAgent(agentId: string) {
		const tabs = this.runtimes.get(`agent:${agentId}`);
		if (!tabs) return;
		for (const runtime of tabs.values()) {
			runtime.batcher.flush();
			runtime.batcher.dispose();
			runtime.pty.kill();
		}
		this.runtimes.delete(`agent:${agentId}`);
		this.ownerSeq.delete(`agent:${agentId}`);
	}

	closeAll() {
		for (const ownerKey of this.runtimes.keys()) {
			this.closeOwner(ownerKey);
		}
	}

	private closeOwner(ownerKey: string) {
		const tabs = this.runtimes.get(ownerKey);
		if (!tabs) return;
		for (const runtime of tabs.values()) {
			runtime.batcher.flush();
			runtime.batcher.dispose();
			runtime.pty.kill();
		}
		this.runtimes.delete(ownerKey);
		this.ownerSeq.delete(ownerKey);
	}

	private ensureOwner(ownerKey: string) {
		const existing = this.runtimes.get(ownerKey);
		if (existing) return existing;
		const next = new Map<string, TerminalRuntime>();
		this.runtimes.set(ownerKey, next);
		return next;
	}

	private findRuntime(tabId: string) {
		for (const tabs of this.runtimes.values()) {
			const runtime = tabs.get(tabId);
			if (runtime) return { tabs, runtime };
		}
		return undefined;
	}

	private snapshot(runtime: TerminalRuntime): TerminalTab {
		return {
			...runtime.tab,
			buffer: runtime.buffer,
			// 前台进程名：渲染层在「关闭确认=running」时据此判断是否有任务在跑。
			// node-pty 的 process 在 shell 空闲时就是 shell 自己的名字，非默认 shell 即视为有进程。
			frontProcess: runtime.pty.process,
		};
	}

	private appendBuffer(runtime: TerminalRuntime, data: string) {
		// Renderer 会在切换项目/agent 时卸载 TerminalDock；主进程保留有限回放，
		// 切回来才能重建 xterm scrollback，同时用字符上限避免长期终端占用过多内存。
		runtime.buffer = `${runtime.buffer}${data}`;
		if (runtime.buffer.length > MAX_TERMINAL_REPLAY_BUFFER) {
			runtime.buffer = runtime.buffer.slice(-MAX_TERMINAL_REPLAY_BUFFER);
		}
	}

	private displayShell(shell: TerminalShell) {
		if (shell === "pwsh") return "pwsh";
		if (shell === "powershell") return "Windows PowerShell";
		if (shell === "cmd") return "cmd";
		if (shell === "zsh") return "zsh";
		if (shell === "bash") return "bash";
		if (shell === "fish") return "fish";
		if (shell === "git-bash") return "Git Bash";
		if (shell === "wsl") return "WSL";
		return "shell";
	}
}
