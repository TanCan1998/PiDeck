import { REMOTE_MODEL_PROBE_CODES, type RemoteModelCatalogEntry, type RemoteModelProbeCode, type RemoteModelProbeResult } from "../../../shared/types/remoteModel";

/**
 * Batch v1 remote model catalog: pure state machine + grouping for the "fetch remote model catalog" action.
 *
 * The action is a single bounded host probe (main never retries); this module only decides how the renderer
 * presents an answer and never invents providers/models. Closed-code errors map to i18n keys, and an EMPTY
 * answer is a neutral empty state (not a red failure).
 */

export type RemoteModelProbeCopyKey = "remoteModel.errorTargetInvalid" | "remoteModel.errorNoProject" | "remoteModel.errorNoRuntime" | "remoteModel.errorUnavailable" | "remoteModel.errorFailed";

export type RemoteModelCatalogPhase = "idle" | "loading" | "ready" | "empty" | "error";

export type RemoteModelCatalogState = {
	phase: RemoteModelCatalogPhase;
	models: RemoteModelCatalogEntry[];
	providers: string[];
	count: number;
	code?: string;
	at?: number;
};

export const initialRemoteModelCatalogState: RemoteModelCatalogState = { phase: "idle", models: [], providers: [], count: 0 };

export type RemoteModelCatalogAction = { type: "started" } | { type: "succeeded"; result: RemoteModelProbeResult } | { type: "failed"; code: string } | { type: "reset" };

/** Validate the preload DTO shape; an unknown/malformed answer is a failed probe, never rendered as data. */
export function readRemoteModelProbeResult(value: unknown): RemoteModelProbeResult | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as { ok?: unknown; code?: unknown; hostId?: unknown; models?: unknown; providers?: unknown; count?: unknown; at?: unknown };
	if (candidate.ok === false) {
		if (typeof candidate.code !== "string" || !(Object.values(REMOTE_MODEL_PROBE_CODES) as string[]).includes(candidate.code)) return undefined;
		return { ok: false, code: candidate.code as RemoteModelProbeCode };
	}
	if (candidate.ok !== true) return undefined;
	if (typeof candidate.hostId !== "string" || typeof candidate.count !== "number" || typeof candidate.at !== "number") return undefined;
	if (!Array.isArray(candidate.models) || !Array.isArray(candidate.providers)) return undefined;
	const models: RemoteModelCatalogEntry[] = [];
	for (const raw of candidate.models) {
		if (typeof raw !== "object" || raw === null) return undefined;
		const entry = raw as Partial<RemoteModelCatalogEntry>;
		if (typeof entry.id !== "string" || typeof entry.provider !== "string") return undefined;
		models.push(raw as RemoteModelCatalogEntry);
	}
	if (!candidate.providers.every((provider) => typeof provider === "string")) return undefined;
	return { ok: true, hostId: candidate.hostId, models, providers: candidate.providers as string[], count: candidate.count, at: candidate.at };
}

function errorCodeKey(code: string): RemoteModelProbeCopyKey {
	switch (code) {
		case REMOTE_MODEL_PROBE_CODES.targetInvalid:
			return "remoteModel.errorTargetInvalid";
		case REMOTE_MODEL_PROBE_CODES.noProject:
			return "remoteModel.errorNoProject";
		case REMOTE_MODEL_PROBE_CODES.noRuntime:
			return "remoteModel.errorNoRuntime";
		case REMOTE_MODEL_PROBE_CODES.failed:
			return "remoteModel.errorFailed";
		default:
			return "remoteModel.errorUnavailable";
	}
}

/** Closed-code -> copy key for the red error state. EMPTY is handled by the neutral empty state, not here. */
export function remoteModelProbeErrorKey(code: string): RemoteModelProbeCopyKey {
	return errorCodeKey(code);
}

export function reduceRemoteModelCatalog(state: RemoteModelCatalogState, action: RemoteModelCatalogAction): RemoteModelCatalogState {
	switch (action.type) {
		case "started":
			if (state.phase === "loading") return state;
			return { phase: "loading", models: [], providers: [], count: 0 };
		case "succeeded": {
			const result = readRemoteModelProbeResult(action.result);
			if (result === undefined) return { ...state, phase: "error", models: [], providers: [], count: 0, code: REMOTE_MODEL_PROBE_CODES.unavailable };
			if (result.ok === false) {
				if (result.code === REMOTE_MODEL_PROBE_CODES.empty) return { phase: "empty", models: [], providers: [], count: 0, code: result.code };
				return { phase: "error", models: [], providers: [], count: 0, code: result.code };
			}
			const groups = groupRemoteModelsByProvider(result.models);
			return { phase: groups.length === 0 ? "empty" : "ready", models: result.models, providers: groups.map((group) => group.provider), count: result.count, at: result.at };
		}
		case "failed":
			return { phase: "error", models: [], providers: [], count: 0, code: action.code };
		case "reset":
			return initialRemoteModelCatalogState;
		default:
			return state;
	}
}

/** Provider-grouped, provider-sorted view; each group's models keep main's deterministic provider+id order. */
export function groupRemoteModelsByProvider(models: readonly RemoteModelCatalogEntry[]): Array<{ provider: string; models: RemoteModelCatalogEntry[] }> {
	const byProvider = new Map<string, RemoteModelCatalogEntry[]>();
	for (const model of models) {
		const group = byProvider.get(model.provider);
		if (group === undefined) byProvider.set(model.provider, [model]);
		else group.push(model);
	}
	return [...byProvider.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([provider, entries]) => ({ provider, models: entries }));
}

/** Token counts are display-only metadata; no locale-dependent formatting is needed for correctness. */
export function formatModelTokenCount(value: number): string {
	return String(Math.floor(value));
}
