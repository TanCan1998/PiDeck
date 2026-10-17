/**
 * PiConfigRouter (plan §6.4.1, Batch A): the single decision point behind the existing models/settings config
 * IPC. An absent/local target keeps today's ConfigManager path byte-for-byte; an ssh target routes only to the
 * RemotePiConfigBackend and never touches ConfigManager (so a remote failure cannot read local files or keys).
 *
 * Provider connection tests, model catalog fetches and usage queries are NOT routed here: they are explicitly
 * deferred for remote targets, so their handlers call rejectRemotePiConfigTarget and answer the stable
 * PROVIDER_OPERATION_UNSUPPORTED code without any network or helper request.
 */

import { REMOTE_CONFIG_CODES } from "../../shared/piConfig";
import type { ConfigFileReadResult } from "../../shared/types";
import type { ConfigValidationResult, PiModelsFile, PiSettings } from "./ConfigManager";
import { readPiConfigReadOptions, readPiConfigTarget, readPiConfigWriteOptions } from "./piConfigTarget";
import type { RemotePiConfigBackend } from "./RemotePiConfigBackend";

export type PiConfigLocalPorts = {
	getModelsConfig: () => Promise<ConfigFileReadResult<{ providers: Record<string, unknown> }>>;
	getSettingsConfig: () => Promise<ConfigFileReadResult<Record<string, unknown>>>;
	saveModelsConfig: (data: PiModelsFile) => Promise<ConfigValidationResult>;
	saveSettingsConfig: (settings: PiSettings) => Promise<ConfigValidationResult>;
};

export type PiConfigRouterPorts = {
	local: PiConfigLocalPorts;
	remote?: RemotePiConfigBackend;
};

export type PiConfigReadRoute<T> = { kind: "local"; value: T } | import("../../shared/piConfig").RemotePiConfigSnapshot;
export type PiConfigWriteRoute = { kind: "local"; value: ConfigValidationResult } | import("../../shared/piConfig").RemotePiConfigWriteReceipt;

function stable(code: string): Error {
	return new Error(code);
}

/**
 * Reject a remote target for the explicitly deferred provider operations (testProvider/fetchModels/usage).
 * Absent/local target stays allowed; anything ssh-shaped gets the documented stable code before any I/O.
 */
export function rejectRemotePiConfigTarget(value: unknown): void {
	const target = readPiConfigTarget(value);
	if (target.kind === "ssh") throw stable(REMOTE_CONFIG_CODES.providerOperationUnsupported);
}

export function createPiConfigRouter(ports: PiConfigRouterPorts) {
	function remoteBackend(): RemotePiConfigBackend {
		if (ports.remote === undefined) throw stable(REMOTE_CONFIG_CODES.unavailable);
		return ports.remote;
	}
	function remoteHostOf(options: unknown, requireWrite: boolean): { hostId: string; expectedVersion?: string; patch?: Record<string, unknown> } | undefined {
		const parsed = requireWrite ? readPiConfigWriteOptions(options) : readPiConfigReadOptions(options);
		if (parsed.target === undefined || parsed.target.kind === "local") return undefined;
		return {
			hostId: parsed.target.hostId,
			...(requireWrite ? { expectedVersion: (parsed as { expectedVersion?: string }).expectedVersion, patch: (parsed as { patch?: Record<string, unknown> }).patch } : {}),
		};
	}

	return {
		async readModels(options?: unknown): Promise<PiConfigReadRoute<ConfigFileReadResult<{ providers: Record<string, unknown> }>>> {
			const remote = remoteHostOf(options, false);
			if (remote === undefined) return { kind: "local", value: await ports.local.getModelsConfig() };
			return await remoteBackend().read({ hostId: remote.hostId, file: "models" });
		},
		async readSettings(options?: unknown): Promise<PiConfigReadRoute<ConfigFileReadResult<Record<string, unknown>>>> {
			const remote = remoteHostOf(options, false);
			if (remote === undefined) return { kind: "local", value: await ports.local.getSettingsConfig() };
			return await remoteBackend().read({ hostId: remote.hostId, file: "settings" });
		},
		async saveModels(data: PiModelsFile, options?: unknown): Promise<PiConfigWriteRoute> {
			const remote = remoteHostOf(options, true);
			if (remote === undefined) return { kind: "local", value: await ports.local.saveModelsConfig(data) };
			if (remote.expectedVersion === undefined || remote.patch === undefined) throw stable(REMOTE_CONFIG_CODES.versionConflict);
			return await remoteBackend().patch({ hostId: remote.hostId, file: "models", expectedVersion: remote.expectedVersion, patch: remote.patch });
		},
		async saveSettings(data: PiSettings, options?: unknown): Promise<PiConfigWriteRoute> {
			const remote = remoteHostOf(options, true);
			if (remote === undefined) return { kind: "local", value: await ports.local.saveSettingsConfig(data) };
			if (remote.expectedVersion === undefined || remote.patch === undefined) throw stable(REMOTE_CONFIG_CODES.versionConflict);
			return await remoteBackend().patch({ hostId: remote.hostId, file: "settings", expectedVersion: remote.expectedVersion, patch: remote.patch });
		},
	};
}

export type PiConfigRouter = ReturnType<typeof createPiConfigRouter>;
