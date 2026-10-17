import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { ipcChannels } from "../../shared/ipc";
import { terminalOwnerKeyFor } from "../../shared/types/terminal";
import type { TerminalShell, TerminalTab, TerminalTarget } from "../../shared/types";
import { isLocalProject } from "../../shared/projectLocation";
import type { ProjectStore } from "../projects/ProjectStore";
import { LocalTerminalSessionLauncher, getTerminalShellCandidates, type TerminalWslSettings } from "./TerminalSessionLauncher";

export { getTerminalShellCandidates };

// 简单日志，不依赖 appLogger 以避免循环引用
const log = (msg: string) => {
	console.error(`[TerminalSessionManager] ${msg}`);
};

type TerminalRuntime = {
	tab: TerminalTab;
	pty: IPty;
	buffer: string;
};

type Emit = (channel: string, payload: unknown) => void;
const MAX_TERMINAL_REPLAY_BUFFER = 200_000;
export function isAgentOwnerKey(ownerKey: string): boolean {
	return ownerKey.startsWith("agent:");
}

export class TerminalSessionManager {
	private readonly runtimes = new Map<string, Map<string, TerminalRuntime>>();

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
			available: true,
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
		const runtimes = this.ensureOwner(ownerKey);
		const index = runtimes.size + 1;
		const id = randomUUID();
		const spawned = this.launcher.spawn({ cwd: resolvedCwd, preferredShell: shell });
		const tab: TerminalTab = {
			id,
			agentId: target.kind === "agent" ? target.agentId : "",
			ownerKey,
			title: `${this.displayShell(spawned.shell)} ${index}`,
			shell: spawned.shell,
			createdAt: Date.now(),
		};
		const runtime: TerminalRuntime = { tab, pty: spawned.pty, buffer: "" };
		runtimes.set(id, runtime);

		spawned.pty.onData((data) => {
			this.appendBuffer(runtime, data);
			this.emit(ipcChannels.terminalData, { tabId: id, data });
		});
		spawned.pty.onExit((event) => {
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
		const runtime = this.requireTab(tabId);
		if (runtime.tab.exited) return;
		runtime.pty.write(data);
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
		found.runtime.pty.kill();
		found.tabs.delete(tabId);
		if (found.tabs.size === 0) this.runtimes.delete(found.runtime.tab.ownerKey);
	}

	/** 关闭某个 agent 的全部终端（agent 退出/重启时调用） */
	closeAgent(agentId: string) {
		const tabs = this.runtimes.get(`agent:${agentId}`);
		if (!tabs) return;
		for (const runtime of tabs.values()) {
			runtime.pty.kill();
		}
		this.runtimes.delete(`agent:${agentId}`);
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
			runtime.pty.kill();
		}
		this.runtimes.delete(ownerKey);
	}

	private ensureOwner(ownerKey: string) {
		const existing = this.runtimes.get(ownerKey);
		if (existing) return existing;
		const next = new Map<string, TerminalRuntime>();
		this.runtimes.set(ownerKey, next);
		return next;
	}

	private requireTab(tabId: string) {
		const found = this.findRuntime(tabId);
		if (!found) throw new Error(`Terminal not found: ${tabId}`);
		return found.runtime;
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
