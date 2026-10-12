import type { ProjectLocator } from "../../shared/types";
import { buildSessionOriginKey } from "../../shared/sessionIdentity";
import { appendSessionForkSuffix } from "./sessionForkTitle";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { SessionCatalog } from "./SessionCatalog";
import type { SessionRuntimeBinding, SessionRuntimeCoordinator } from "./SessionRuntimeCoordinator";

export type AgentSessionReplacementResult = {
	cancelled?: boolean;
	[key: string]: unknown;
};

type ReplacementDependencies = {
	agentManager: Pick<AgentManager, "list" | "rename">;
	sessionCatalog: Pick<SessionCatalog, "get" | "getLocator" | "ensureRuntimeTarget" | "update">;
	sessionRuntimeCoordinator: Pick<SessionRuntimeCoordinator, "getRuntimeBinding" | "replaceBoundRuntime">;
	appLogger: Pick<AppLogger, "warn">;
	forkedSuffix: () => string;
	resolveProjectLocator: (projectId: string) => ProjectLocator | undefined;
	onDetached: (binding: SessionRuntimeBinding) => void;
	onAttached: (binding: SessionRuntimeBinding) => void;
	onRestored: (binding: SessionRuntimeBinding) => void;
};

/** Keep RPC payload fields without asserting an untrusted cancellation value's type. */
function replacementResult(value: unknown): AgentSessionReplacementResult {
	const result: AgentSessionReplacementResult = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return result;
	for (const [key, field] of Object.entries(value)) {
		if (key === "cancelled") {
			if (typeof field === "boolean") result.cancelled = field;
		} else result[key] = field;
	}
	return result;
}

/** Single owner for RPC replacement, catalog identity and observer ordering (local + SSH). */
export function createAgentSessionReplacer(deps: ReplacementDependencies) {
	const { agentManager, sessionCatalog, sessionRuntimeCoordinator, appLogger } = deps;
	return async (agentId: string, replace: () => Promise<unknown>, options?: { markForked?: boolean }): Promise<AgentSessionReplacementResult & { targetSessionId?: string }> => {
		const originBinding = sessionRuntimeCoordinator.getRuntimeBinding(agentId);
		const originEntry = originBinding ? sessionCatalog.get(originBinding.sessionId) : undefined;
		const originLocator = originEntry ? sessionCatalog.getLocator(originEntry.id) : undefined;
		const originKey =
			originLocator?.kind !== "ssh" && originEntry?.filePath ? buildSessionOriginKey({ source: originEntry.source, environment: originEntry.environment, filePath: originEntry.filePath, wslDistro: originEntry.wslDistro, wslUser: originEntry.wslUser, importedSourceId: originEntry.importedSourceId }) : undefined;
		return sessionRuntimeCoordinator.replaceBoundRuntime({
			agentId,
			replace: async () => replacementResult(await replace()),
			resolveTargetSessionId: async (result) => {
				const tab = agentManager.list().find((candidate) => candidate.id === agentId);
				if (!tab?.sessionPath) throw new Error(`Replacement runtime has no session path: ${agentId}`);
				// The remote port registered THIS RPC's get_state path. Never pass it to
				// ensureRuntimeTarget's local path resolver or attach it onto the origin.
				const remoteTargetId = originLocator?.kind === "ssh" && typeof result.targetSessionId === "string" ? result.targetSessionId : undefined;
				if (originLocator?.kind === "ssh") {
					const target = remoteTargetId ? sessionCatalog.get(remoteTargetId) : undefined;
					const locator = target?.locator;
					if (!target || target.id === originEntry?.id || target.projectId !== tab.projectId || locator?.kind !== "ssh" || locator.hostId !== originLocator.hostId || locator.remotePath !== tab.sessionPath) {
						throw new Error("REMOTE_SESSION_LOCATOR_UNRESOLVED");
					}
				}
				// Persist (fork) via pi's official rename RPC, as for local sessions.
				// Failure is non-fatal; retain the original title and only log identities.
				let title = tab.title;
				if (options?.markForked) {
					const forkedTitle = appendSessionForkSuffix(title, deps.forkedSuffix());
					if (forkedTitle !== title) {
						try {
							await agentManager.rename(agentId, forkedTitle);
							title = forkedTitle;
						} catch {
							void appLogger.warn("session", "Fork session suffix rename failed", { agentId, sessionId: originEntry?.id, code: "SESSION_FORK_SUFFIX_RENAME_FAILED" });
						}
					}
				}
				if (remoteTargetId) {
					const locator = sessionCatalog.getLocator(remoteTargetId);
					const project = deps.resolveProjectLocator(tab.projectId);
					// rename also refreshes get_state; reject identity drift before binding.
					if (locator?.kind !== "ssh" || locator.remotePath !== tab.sessionPath || project?.kind !== "ssh" || project.hostId !== locator.hostId) throw new Error("REMOTE_SESSION_LOCATOR_UNRESOLVED");
					await sessionCatalog.update(remoteTargetId, { title, forked: options?.markForked });
					return remoteTargetId;
				}
				const environment = tab.sessionEnvironment ?? originEntry?.environment ?? "native";
				const target = await sessionCatalog.ensureRuntimeTarget({
					projectId: tab.projectId,
					title,
					source: tab.sessionSource ?? originEntry?.source ?? "pi",
					environment,
					filePath: tab.sessionPath,
					wslDistro: tab.wslDistro ?? (environment === "wsl" ? originEntry?.wslDistro : undefined),
					wslUser: tab.wslUser ?? (environment === "wsl" ? originEntry?.wslUser : undefined),
					importedSourceId: tab.importedSourceId ?? originEntry?.importedSourceId,
					piSessionId: tab.sessionId,
					forked: options?.markForked,
				});
				return target.id;
			},
			canRestoreOrigin: () => {
				const tab = agentManager.list().find((candidate) => candidate.id === agentId);
				if (!tab?.sessionPath) return false;
				if (originLocator?.kind === "ssh") {
					// A failed state read clears the path; a changed file cannot be rebound
					// to the old record. Host + remotePath is the SSH identity, not originKey.
					const current = originEntry ? sessionCatalog.getLocator(originEntry.id) : undefined;
					const project = deps.resolveProjectLocator(tab.projectId);
					return project?.kind === "ssh" && project.hostId === originLocator.hostId && current?.kind === "ssh" && current.hostId === originLocator.hostId && current.remotePath === originLocator.remotePath && tab.projectId === originEntry?.projectId && tab.sessionPath === originLocator.remotePath;
				}
				return Boolean(originKey) && buildSessionOriginKey({ source: tab.sessionSource ?? "pi", environment: tab.sessionEnvironment ?? "native", filePath: tab.sessionPath, wslDistro: tab.wslDistro, wslUser: tab.wslUser, importedSourceId: tab.importedSourceId }) === originKey;
			},
			onDetached: deps.onDetached,
			onAttached: deps.onAttached,
			onRestored: deps.onRestored,
		});
	};
}
