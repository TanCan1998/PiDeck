import type { IPty } from "node-pty";
import { loadNodePty } from "./nodePtyRuntime";
import { existsSync } from "node:fs";
import type { TerminalShell } from "../../shared/types/terminal";
import { toWindowsHostPath, toWslLinuxPath } from "../wsl/WslPaths";
import { getWslExe } from "../wsl/wslExe";

export type TerminalShellCandidate = {
	shell: TerminalShell;
	command: string;
	args: string[];
};

export type TerminalWslSettings = {
	wslEnabled?: boolean;
	wslDistro?: string;
	wslUser?: string;
};

/** Platform shell detection; kept byte-for-byte as it behaved inside the local manager. */
export function getTerminalShellCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): TerminalShellCandidate[] {
	if (platform === "win32") {
		const candidates: TerminalShellCandidate[] = [
			{ shell: "pwsh", command: "pwsh.exe", args: [] },
			{ shell: "powershell", command: "powershell.exe", args: [] },
			{ shell: "cmd", command: "cmd.exe", args: [] },
		];
		// 检测 Git Bash（常见安装路径）
		const gitBashPaths = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];
		for (const p of gitBashPaths) {
			if (existsSync(p)) {
				candidates.push({ shell: "git-bash", command: p, args: ["--login", "-i"] });
				break;
			}
		}
		// 检测 WSL：getWslExe 只做 existsSync / PATH 回退，禁止同步 `where wsl.exe`（最多卡 3 秒）。
		const wslExe = getWslExe();
		if (wslExe.command === "wsl" || existsSync(wslExe.command)) {
			candidates.push({ shell: "wsl", command: wslExe.command, args: [] });
		}
		return dedupeShellCandidates(candidates);
	}

	if (platform === "darwin") {
		const userShell = normalizePosixShell(env.SHELL);
		const candidates: TerminalShellCandidate[] = [];
		if (userShell) candidates.push(userShell);
		// macOS GUI 应用拿到的进程环境通常不是用户登录 shell 环境；
		// 用登录 shell 启动可以让 zsh/bash 初始化 TTY 与用户 PATH，行为更接近 Terminal.app。
		candidates.push({ shell: "zsh", command: "/bin/zsh", args: ["-l"] }, { shell: "bash", command: "/bin/bash", args: ["-l"] }, { shell: "sh", command: "/bin/sh", args: [] });
		return dedupeShellCandidates(candidates);
	}

	const userShell = normalizePosixShell(env.SHELL);
	const candidates: TerminalShellCandidate[] = [];
	if (userShell) candidates.push(userShell);
	candidates.push({ shell: "bash", command: "bash", args: [] }, { shell: "sh", command: "sh", args: [] });
	return dedupeShellCandidates(candidates);
}

function normalizePosixShell(shellPath: string | undefined): TerminalShellCandidate | null {
	if (!shellPath) return null;
	const name = shellPath.split(/[\\/]/).pop();
	if (name === "zsh") return { shell: "zsh", command: shellPath, args: ["-l"] };
	if (name === "bash") return { shell: "bash", command: shellPath, args: ["-l"] };
	if (name === "fish") return { shell: "fish", command: shellPath, args: ["-l"] };
	if (name === "sh") return { shell: "sh", command: shellPath, args: [] };
	return { shell: "sh", command: shellPath, args: [] };
}

function dedupeShellCandidates(candidates: TerminalShellCandidate[]) {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = `${candidate.command}\0${candidate.args.join("\0")}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Local/WSL half of the launcher split: it preserves the exact local shell candidates, UTF-8 locale injection,
 * WSL cwd conversion and node-pty options the manager used before the remote ticket/runner work. The manager only
 * asks it to spawn and keeps all tab/replay/input/resize/close ownership.
 */
export class LocalTerminalSessionLauncher {
	constructor(
		private readonly getSettings: () => TerminalWslSettings = () => ({}),
		private readonly log: (message: string) => void = () => undefined,
	) {}

	candidates(): TerminalShellCandidate[] {
		const candidates = getTerminalShellCandidates(process.platform, process.env);
		const settings = this.getSettings();
		if (process.platform !== "win32" || !settings.wslEnabled || !settings.wslDistro || !settings.wslUser) {
			return candidates;
		}
		const wslExe = getWslExe();
		return [
			{
				shell: "wsl" as const,
				command: wslExe.command,
				args: ["-d", settings.wslDistro, "-u", settings.wslUser],
			},
			...candidates.filter((candidate) => candidate.shell !== "wsl"),
		];
	}

	spawn(input: { cwd: string; preferredShell?: TerminalShell }): { shell: TerminalShell; pty: IPty } {
		// Native module is loaded here, BEFORE the per-candidate try: a missing/incompatible node-pty must
		// surface as NodePtyUnavailableError instead of being masked by the last candidate shell error.
		const nodePty = loadNodePty();
		const candidates = this.candidates();
		// 如果有首选 shell，先在候选列表中查找匹配项
		const ordered = input.preferredShell ? [...candidates.filter((c) => c.shell === input.preferredShell), ...candidates.filter((c) => c.shell !== input.preferredShell)] : candidates;
		this.log(`spawnShell: preferred=${input.preferredShell}, ordered=${ordered.map((c) => c.shell).join(", ")}`);
		let lastError: unknown;
		for (const candidate of ordered) {
			try {
				// macOS GUI 应用（Electron）不继承登录 shell 的环境变量，
				// LANG/LC_CTYPE 可能为空或 C，导致 shell 内 UTF-8 输出乱码。
				// 显式注入 UTF-8 locale，让 shell 知道应以 UTF-8 解释字节流。
				const env = { ...process.env };
				if (!env.LANG) env.LANG = "en_US.UTF-8";
				if (!env.LC_ALL) env.LC_ALL = "en_US.UTF-8";
				const wsl = candidate.shell === "wsl" ? this.getSettings() : undefined;
				let args = candidate.args;
				let spawnCwd = input.cwd;
				// WSL 终端：--cd 用 Linux 路径，PTY 的 cwd 仍必须是 Windows 主机路径。
				if (wsl?.wslEnabled && wsl.wslDistro && wsl.wslUser) {
					try {
						args = [...args, "--cd", toWslLinuxPath(input.cwd, { distro: wsl.wslDistro })];
						spawnCwd = toWindowsHostPath(input.cwd, { distro: wsl.wslDistro });
					} catch (error) {
						this.log(`Failed to convert WSL terminal cwd: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				const terminal = nodePty.spawn(candidate.command, args, {
					name: "xterm-256color",
					cols: 80,
					rows: 24,
					cwd: spawnCwd,
					env,
				});
				return { shell: candidate.shell, pty: terminal };
			} catch (error) {
				lastError = error;
				this.log(`Failed to spawn ${candidate.shell} (${candidate.command}): ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw lastError instanceof Error ? lastError : new Error("No supported shell found");
	}
}
