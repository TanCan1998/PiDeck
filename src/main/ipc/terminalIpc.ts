import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SessionCommandError, TerminalAgentTarget, TerminalShell, TerminalTarget } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { RemoteTerminalSessionManager } from "../terminal/RemoteTerminalSessionManager";
import { isRemoteProject } from "../../shared/projectLocation";
import type { WebContents } from "electron";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function parseTerminalTarget(value: unknown): TerminalTarget {
	if (!isRecord(value) || typeof value.kind !== "string") throw new Error("INVALID_TERMINAL_TARGET");
	if (value.kind === "project") {
		if (!hasOnlyKeys(value, ["kind", "projectId"]) || typeof value.projectId !== "string" || !value.projectId.trim() || value.projectId.length > 256) {
			throw new Error("INVALID_TERMINAL_TARGET");
		}
		return { kind: "project", projectId: value.projectId };
	}
	if (value.kind === "agent") {
		const { sessionId, agentId, runtimeGeneration } = value;
		if (
			!hasOnlyKeys(value, ["kind", "sessionId", "agentId", "runtimeGeneration"]) ||
			typeof sessionId !== "string" ||
			!sessionId.trim() ||
			sessionId.length > 256 ||
			typeof agentId !== "string" ||
			!agentId.trim() ||
			agentId.length > 256 ||
			typeof runtimeGeneration !== "number" ||
			!Number.isSafeInteger(runtimeGeneration) ||
			runtimeGeneration < 1
		) {
			throw new Error("INVALID_TERMINAL_TARGET");
		}
		const target: TerminalAgentTarget = { kind: "agent", sessionId, agentId, runtimeGeneration };
		return target;
	}
	throw new Error("INVALID_TERMINAL_TARGET");
}

function parseTerminalShell(value: unknown): TerminalShell | undefined {
	if (value === undefined) return undefined;
	if (value === "pwsh" || value === "powershell" || value === "cmd" || value === "zsh" || value === "bash" || value === "fish" || value === "sh" || value === "git-bash" || value === "wsl") {
		return value;
	}
	throw new Error("INVALID_TERMINAL_SHELL");
}

function parseTerminalTabId(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error("INVALID_TERMINAL_TAB_ID");
	return value;
}

function parseTerminalInput(value: unknown): string {
	if (typeof value !== "string") throw new Error("INVALID_TERMINAL_INPUT");
	return value;
}

function parseTerminalDimension(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error("INVALID_TERMINAL_SIZE");
	return value;
}

export type TerminalIpcDeps = {
	appLogger: Pick<AppLogger, "info">;
	projectStore: ProjectStore;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	terminalManager: TerminalSessionManager;
	remoteTerminalManager?: RemoteTerminalSessionManager;
	projectIdForSession?: (sessionId: string) => string | undefined;
	toSessionCommandIpcError: (error: SessionCommandError) => Error;
};

export function registerTerminalIpc({ appLogger, projectStore, sessionRuntimeCoordinator, terminalManager, remoteTerminalManager, projectIdForSession, toSessionCommandIpcError }: TerminalIpcDeps): void {
	const senders = new Set<number>();
	const remoteSender = (sender: WebContents): number => {
		if (sender.isDestroyed()) throw new Error("REMOTE_TERMINAL_CLOSED");
		if (!senders.has(sender.id)) {
			senders.add(sender.id);
			sender.once("destroyed", () => {
				remoteTerminalManager?.releaseSender(sender.id);
				senders.delete(sender.id);
			});
		}
		return sender.id;
	};
	const remoteProjectId = (target: TerminalTarget): string | undefined => {
		const projectId = target.kind === "project" ? target.projectId : projectIdForSession?.(target.sessionId);
		const project = projectId ? projectStore.get(projectId) : undefined;
		if (!project || !isRemoteProject(project)) return undefined;
		if (target.kind !== "project") throw new Error("REMOTE_TERMINAL_PROJECT_TARGET_REQUIRED");
		if (!remoteTerminalManager) throw new Error("REMOTE_FEATURE_DISABLED");
		return project.id;
	};
	const requireTerminalTarget = (value: unknown): TerminalTarget => {
		const target = parseTerminalTarget(value);
		if (target.kind === "project") {
			const project = projectStore.get(target.projectId);
			if (!project) throw new Error("PROJECT_NOT_FOUND");
			if (project.kind === "chat") throw new Error("TERMINAL_PROJECT_UNSUPPORTED");
			return target;
		}
		const validated = sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) throw toSessionCommandIpcError(validated.error);
		return target;
	};

	ipcMain.handle(ipcChannels.terminalList, (event, rawTarget: unknown) => {
		const target = requireTerminalTarget(rawTarget);
		const remoteId = remoteProjectId(target);
		if (remoteId && remoteTerminalManager) return remoteTerminalManager.list(remoteSender(event.sender), remoteId);
		return terminalManager.list(target);
	});
	ipcMain.handle(ipcChannels.terminalEnsure, (event, rawTarget: unknown) => {
		const target = requireTerminalTarget(rawTarget);
		const remoteId = remoteProjectId(target);
		if (remoteId && remoteTerminalManager) return remoteTerminalManager.ensure(remoteSender(event.sender), remoteId);
		return terminalManager.ensure(target);
	});
	ipcMain.handle(ipcChannels.terminalCreate, async (event, rawTarget: unknown, rawShell?: unknown) => {
		const target = requireTerminalTarget(rawTarget);
		const shell = parseTerminalShell(rawShell);
		const remoteId = remoteProjectId(target);
		const result = remoteId && remoteTerminalManager ? await remoteTerminalManager.create(remoteSender(event.sender), remoteId, shell) : await terminalManager.create(target, shell);
		void appLogger.info("terminal", "Terminal created", {
			kind: target.kind,
			projectId: target.kind === "project" ? target.projectId : undefined,
			sessionId: target.kind === "agent" ? target.sessionId : undefined,
			agentId: target.kind === "agent" ? target.agentId : undefined,
			tabId: result.id,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.terminalInput, (event, rawTabId: unknown, rawData: unknown) => {
		const id = parseTerminalTabId(rawTabId),
			data = parseTerminalInput(rawData);
		if (remoteTerminalManager?.has(id)) {
			// Budget the remote transport only; native paste behavior remains unchanged.
			if (data.length > 16 * 1024) throw new Error("INVALID_TERMINAL_INPUT");
			return remoteTerminalManager.input(remoteSender(event.sender), id, data);
		}
		terminalManager.input(id, data);
	});
	ipcMain.handle(ipcChannels.terminalResize, (event, rawTabId: unknown, rawCols: unknown, rawRows: unknown) => {
		const id = parseTerminalTabId(rawTabId),
			cols = parseTerminalDimension(rawCols),
			rows = parseTerminalDimension(rawRows);
		if (remoteTerminalManager?.has(id)) return remoteTerminalManager.resize(remoteSender(event.sender), id, cols, rows);
		terminalManager.resize(id, cols, rows);
	});
	ipcMain.handle(ipcChannels.terminalAcknowledge, (event, rawTabId: unknown, sequence: unknown) => {
		const id = parseTerminalTabId(rawTabId);
		if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error("INVALID_TERMINAL_SEQUENCE");
		if (remoteTerminalManager?.has(id)) remoteTerminalManager.ack(remoteSender(event.sender), id, sequence);
	});
	ipcMain.handle(ipcChannels.terminalClose, (event, rawTabId: unknown) => {
		const tabId = parseTerminalTabId(rawTabId);
		if (remoteTerminalManager?.has(tabId)) remoteTerminalManager.close(remoteSender(event.sender), tabId);
		else terminalManager.close(tabId);
		void appLogger.info("terminal", "Terminal closed", { tabId });
	});
	// shell 候选列表（供「选择 Shell」下拉）：只读平台探测结果，无入参可校验
	ipcMain.handle(ipcChannels.terminalShells, () => terminalManager.listShells());
}
