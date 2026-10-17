/**
 * Shared contract for the target-routed Pi config backend (Phase 5, plan §6.4.1).
 *
 * The local surface keeps its existing DTOs; this module adds only the pieces both the main process and a
 * later renderer batch need to name a target and branch on stable codes. No secret value ever travels in
 * these types: a remote snapshot carries secret positions as configured/missing plus a path list.
 */

/** Which allowlisted agent file a request names. Never a path, never auth.json. */
export const PI_CONFIG_FILES = ["models", "settings"] as const;
export type PiConfigFileKey = (typeof PI_CONFIG_FILES)[number];

/**
 * Where a config read/write should run. local is the default when the option is absent; ssh is usable only
 * for a host the host store has verified and the connection service has ready (the main backend enforces it).
 */
export type PiConfigTarget = { kind: "local" } | { kind: "ssh"; hostId: string };

/** The closed set of stable codes the remote backend and its IPC surface may answer with. */
export const REMOTE_CONFIG_CODES = {
	/** target object shape/hostId shape is not a target this build accepts. */
	targetInvalid: "REMOTE_CONFIG_TARGET_INVALID",
	/** the ssh host is known but not connected/ready (or the connection was disposed). */
	hostNotReady: "REMOTE_CONFIG_HOST_NOT_READY",
	/** the remote feature switch is off / the backend or transport port was not assembled. */
	unavailable: "REMOTE_CONFIG_UNAVAILABLE",
	/** the deployed helper has no config scope (METHOD_NOT_FOUND from an older build). */
	unsupported: "REMOTE_CONFIG_UNSUPPORTED",
	/** malformed file content, unsupported path shape, or a helper reply that failed re-validation. */
	fileInvalid: "REMOTE_CONFIG_FILE_INVALID",
	/** expectedVersion did not match the current bytes; the caller must re-read before writing. */
	versionConflict: "REMOTE_CONFIG_VERSION_CONFLICT",
	/** the write may or may not have landed and its receipt was not trustworthy; never retried. */
	resultUnconfirmed: "REMOTE_CONFIG_RESULT_UNCONFIRMED",
	/** provider connection test / model catalog fetch / usage query is explicitly deferred for remote targets. */
	providerOperationUnsupported: "REMOTE_CONFIG_PROVIDER_OPERATION_UNSUPPORTED",
} as const;
export type RemoteConfigCode = (typeof REMOTE_CONFIG_CODES)[keyof typeof REMOTE_CONFIG_CODES];
/** Stable-code set helper: main only returns a code that is in this closed vocabulary. */
export const REMOTE_CONFIG_CODE_SET: ReadonlySet<string> = new Set(Object.values(REMOTE_CONFIG_CODES));

/** One redacted secret position; nothing else about the value crosses the process boundary. */
export type RemotePiConfigSecretEntry = { path: string; status: "configured" | "missing" };

/**
 * One sanitized remote file snapshot. version/sha256 are the sha256 hex of the raw bytes the helper read
 * (missing files use the canonical empty document's bytes), so a write can be guarded by expectedVersion.
 */
export type RemotePiConfigSnapshot = {
	kind: "remote";
	hostId: string;
	file: PiConfigFileKey;
	version: string;
	sha256: string;
	data: Record<string, unknown>;
	secrets: readonly RemotePiConfigSecretEntry[];
};

/** Read options: absent target means local (compatibility); ssh must name a host id. */
export type PiConfigReadOptions = { target?: PiConfigTarget };

/**
 * Write options for the existing save IPC. local ignores expectedVersion/patch (existing body-only callers
 * keep working); ssh requires both: patch is the RFC 7396 merge patch and expectedVersion is the version the
 * renderer last read.
 */
export type PiConfigWriteOptions = PiConfigReadOptions & { expectedVersion?: string; patch?: Record<string, unknown> };

/** Successful remote write receipt: a new version the caller can use for the next patch. */
export type RemotePiConfigWriteReceipt = { kind: "remote"; hostId: string; file: PiConfigFileKey; version: string; sha256: string };

/**
 * Renderer-facing result shapes (Batch B). The existing local DTOs stay exactly as they were; a remote
 * answer carries an extra optional `remote` snapshot so no-argument callers keep compiling untouched.
 */
export type RemotePiConfigReadResult = { remote?: RemotePiConfigSnapshot };
export type RemotePiConfigSaveResult = { remote?: RemotePiConfigWriteReceipt };

/** true only for a remote snapshot produced by the target-routed backend (never inferred from local data). */
export function isRemotePiConfigSnapshot(value: unknown): value is RemotePiConfigSnapshot {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "remote";
}

/** true only for a remote write receipt (main returns {valid:true, remote:<receipt>}). */
export function isRemotePiConfigWriteReceipt(value: unknown): value is RemotePiConfigWriteReceipt {
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "remote" && typeof (value as { version?: unknown }).version === "string";
}

/** Extract the stable REMOTE_CONFIG_* code from a rejected IPC call (Electron prefixes its message). */
export function remotePiConfigCodeFromError(error: unknown): string | undefined {
	const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message?: unknown }).message ?? "") : String(error ?? "");
	const match = /(REMOTE_CONFIG_[A-Z_]+)/.exec(message);
	return match?.[1];
}
