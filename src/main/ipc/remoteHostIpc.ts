import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { ipcMain, type WebContents } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type {
	RemoteHostAddInput,
	RemoteHostAddResult,
	RemoteHostConfigScanResult,
	RemoteHostConnectResult,
	RemoteHostDiagnosticEntry,
	RemoteHostDiagnosticsResult,
	RemoteHostDisconnectResult,
	RemoteHostListResult,
	RemoteHostPinAnswerResult,
	RemoteHostPinRequest,
	RemoteHostRepairAnswerResult,
	RemoteHostRepairDiagnosisResult,
	RemoteHostRepairFinding,
	RemoteHostRepairRequest,
	RemoteHostRepairRunResult,
	RemoteHostRepairSummary,
	RemoteProjectEnrollAnswerResult,
	RemoteProjectEnrollRequest,
	RemoteProjectEnrollResult,
	RemoteProjectListResult,
	RemoteProjectReadResult,
} from "../../shared/types/remoteHost";
import type { RemoteHostCatalogView } from "../remote/RemoteHostCatalogView";
import { RemoteHostRepair, type HostRepairAction } from "../remote/RemoteHostRepair";
import { createRemoteWorkspaceReader, type RemoteWorkspacePort } from "../remote/RemoteWorkspaceReader";
import { resolveRemoteBrowseRoot } from "../remote/RemoteBrowseRoot";
import { PendingConfirmationBroker } from "../security/PendingConfirmationBroker";
import type { RemoteHostConnectionService, RemoteProjectSession } from "../remote/RemoteHostConnectionService";
import { parseSshConfig } from "../remote/SshConfigCandidates";
import { RemoteHostStore } from "../remote/RemoteHostStore";
import { SshHostPinStore } from "../remote/SshHostPinStore";

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPAIR_REASON = /^REMOTE_HOST_[A-Z0-9_]{1,64}$/;
const REPAIR_CLASSIFICATIONS: ReadonlySet<string> = new Set(["orphan-pin", "anchor-invalid", "lock", "snapshot", "write-uncertain", "unknown"]);
// Diagnostics are re-validated at this boundary rather than trusted: the service already builds them
// from enumerable values, but the renderer must never be the place a path or command could appear.
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const DIAGNOSTIC_STATES: ReadonlySet<string> = new Set(["disconnected", "connecting", "probing", "bootstrapping", "ready", "degraded", "reconnecting", "offline", "needs-attention"]);
const DIAGNOSTIC_PHASES: ReadonlySet<string> = new Set(["openssh", "authenticate", "platform", "node", "helper", "pi"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Bounded per request: a host with a long history must not turn one IPC call into an unbounded payload. */
const MAX_DIAGNOSTIC_ENTRIES = 200;
/** ssh config is a small text file; anything larger is not the file we mean to read. */
const MAX_SSH_CONFIG_BYTES = 1024 * 1024;
/** Repair actions the UI may request. Anything else is refused before it can reach the repair module. */
const REPAIR_ACTIONS: ReadonlySet<string> = new Set(["complete-activation-from-pin", "discard-orphan-pin", "clear-stale-lock", "forget-trust-anchor"]);

/** Host label is user-facing text shown in the sidebar; keep it bounded and free of control bytes. */
const MAX_LABEL = 128;
const HOST_NAME = /^[A-Za-z0-9._:[\]-]+$/;
const SAFE_USER = /^[A-Za-z0-9._@-]+$/;

/** Expose only stable codes and valid ids; no repair commands, pin paths or trust metadata cross IPC. */
function repairSummary(view: RemoteHostCatalogView): RemoteHostRepairSummary[] {
	return view.findings.map((finding) => ({
		reason: REPAIR_REASON.test(finding.reason) ? finding.reason : "REMOTE_HOST_DIAGNOSTIC_UNKNOWN",
		classification: REPAIR_CLASSIFICATIONS.has(finding.classification) ? finding.classification : "unknown",
		hostIds: finding.hostIds.filter((id) => HOST_ID.test(id)).slice(0, 2000),
	}));
}

/** Re-validate a service diagnostic before it reaches the renderer; anything unreadable is dropped. */
function diagnosticEntry(value: unknown): RemoteHostDiagnosticEntry | null {
	if (typeof value !== "object" || value === null) return null;
	const entry = value as { state?: unknown; phase?: unknown; code?: unknown; at?: unknown; exitCode?: unknown };
	if (typeof entry.state !== "string" || !DIAGNOSTIC_STATES.has(entry.state)) return null;
	if (typeof entry.phase !== "string" || !DIAGNOSTIC_PHASES.has(entry.phase)) return null;
	if (typeof entry.code !== "string" || !DIAGNOSTIC_CODE.test(entry.code)) return null;
	if (typeof entry.at !== "string" || !ISO.test(entry.at)) return null;
	const exitCode = entry.exitCode;
	if (exitCode !== undefined && (!Number.isSafeInteger(exitCode) || (exitCode as number) < -1 || (exitCode as number) > 255)) return null;
	return { state: entry.state as RemoteHostDiagnosticEntry["state"], phase: entry.phase as RemoteHostDiagnosticEntry["phase"], code: entry.code, at: entry.at, ...(exitCode === undefined ? {} : { exitCode: exitCode as number }) };
}

/**
 * Read `~/.ssh/config` for the add-host picker.
 *
 * Missing file is not an error: plenty of users have no config and will type the host by hand. Anything
 * else (permissions, a directory in its place, a huge file) is reported as a stable code so the UI can
 * fall back to manual entry and say why.
 */
async function scanSshConfig(): Promise<RemoteHostConfigScanResult> {
	const currentUser = safeCurrentUser();
	const path = join(homedir(), ".ssh", "config");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return { ok: true, candidates: [], skipped: [], user: currentUser };
		return { ok: false, code: "REMOTE_HOST_CONFIG_UNREADABLE" };
	}
	if (text.length > MAX_SSH_CONFIG_BYTES) return { ok: false, code: "REMOTE_HOST_CONFIG_TOO_LARGE" };
	const parsed = parseSshConfig(text);
	return { ok: true, candidates: parsed.candidates, skipped: parsed.skipped, user: currentUser };
}

/** The login user, used only as the displayed default when a config entry omits `User`. */
function safeCurrentUser(): string {
	try {
		return userInfo().username;
	} catch {
		return "";
	}
}

/**
 * Validate a manual add. Every field becomes part of SSH argv or a known_hosts alias, so it is checked
 * here rather than trusted: the renderer's form is a convenience, not a guarantee.
 */
function readAddInput(value: unknown): { label: string; hostName: string; user?: string; port?: number; identityFile?: string } | null {
	if (typeof value !== "object" || value === null) return null;
	const input = value as Record<string, unknown>;
	const label = typeof input.label === "string" ? input.label.trim() : "";
	const hostName = typeof input.hostName === "string" ? input.hostName.trim() : "";
	if (label.length === 0 || label.length > MAX_LABEL || /[\x00-\x1f\x7f]/.test(label)) return null;
	if (hostName.length === 0 || hostName.length > 1024 || !HOST_NAME.test(hostName)) return null;
	const user = typeof input.user === "string" ? input.user.trim() : "";
	if (user.length > 0 && (user.length > 256 || !SAFE_USER.test(user))) return null;
	const rawPort = input.port;
	let port: number | undefined;
	if (rawPort !== undefined && rawPort !== null && rawPort !== "") {
		const parsed = typeof rawPort === "number" ? rawPort : Number(rawPort);
		// A bad port is rejected rather than defaulted: silently using 22 would connect somewhere else.
		if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) return null;
		port = parsed;
	}
	const identityFile = typeof input.identityFile === "string" && input.identityFile.trim().length > 0 ? input.identityFile.trim() : undefined;
	if (identityFile !== undefined && (identityFile.length > 4096 || /[\x00-\x1f\x7f]/.test(identityFile))) return null;
	// `null` and "absent" both mean "use the default"; the store models absence as undefined, so collapse here
	// rather than letting a null reach it and be written as a literal.
	return { label, hostName, ...(user.length > 0 ? { user } : {}), ...(port === undefined ? {} : { port }), ...(identityFile === undefined ? {} : { identityFile }) };
}

/**
 * Remote host IPC: listing, the connection switch, and adding a host.
 *
 * `enabled` gates every channel: with the experiment off the renderer cannot even learn that a host
 * exists, so there is nothing for a disabled build to leak. Only `connect` launches SSH.
 *
 * `service` is optional so the read-only catalog stays usable without a connection service.
 */
export function registerRemoteHostIpc(input: {
	enabled: boolean;
	list: () => Promise<RemoteHostCatalogView>;
	service?: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>;
	userDataDir: string;
	/**
	 * 远端项目登记端口（Phase 3 第二段）。
	 *
	 * 只开一个狭窄入口：`enroll` 把已确认的 canonical root 写进项目库并返回 stable projectId；
	 * `locator` 按 projectId 取回 `{ hostId, remotePath }`。主进程持有校验后的 canonical 值，
	 * 远端路径不经由渲染层或本机 fs。未提供时（旧装配/正式包）登记与按项目读取都返回稳定码。
	 */
	projects?: {
		enroll: (input: { hostId: string; canonicalRemotePath: string }) => Promise<{ projectId: string }>;
		locator: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined;
	};
	registerCleanup?: (cleanup: () => Promise<void>) => void;
}): void {
	const guard = <T>(fallback: () => T): T | undefined => (input.enabled ? undefined : fallback());

	/**
	 * Long-lived pin store + host store pair, shared by the add and answer channels.
	 *
	 * These cannot be per-call: the fingerprint confirmation lives in the pin store's in-memory broker,
	 * so a store created for `remote:add` and disposed when that call returns loses the pending request
	 * before the user can answer it. Answering then failed with SSH_HOST_CONFIRMATION_INVALID even from
	 * the window that was shown the fingerprint. One instance for the process fixes that, and disposal
	 * moves to app quit alongside the other long-lived services.
	 */
	let stores: Promise<{ store: Awaited<ReturnType<typeof RemoteHostStore.open>>; pinStore: SshHostPinStore }> | undefined;
	const openStores = () => {
		stores ??= (async () => {
			const pinStore = new SshHostPinStore(input.userDataDir);
			const store = await RemoteHostStore.open(input.userDataDir, { pinStore });
			return { store, pinStore };
		})();
		// A failed open must not be cached: a store stuck in needs-repair can be fixed by hand, and the
		// next attempt should re-read rather than reuse the failure.
		stores.catch(() => {
			stores = undefined;
		});
		return stores;
	};
	/** Release the shared stores; called from the quit path so the broker's timers do not outlive the app. */
	const disposeStores = async (): Promise<void> => {
		const current = stores;
		stores = undefined;
		if (current === undefined) return;
		try {
			(await current).pinStore.dispose();
		} catch {
			// Nothing to clean up if the open itself failed.
		}
	};
	input.registerCleanup?.(disposeStores);

	/**
	 * Resolve the connection service, turning a discovery failure into a stable code.
	 *
	 * Building the service can fail on purpose: the SSH client is probed before it is trusted, and a
	 * missing or incapable client is a reportable condition rather than a crash. Letting that rejection
	 * escape produced an unhandled "Error invoking remote method" in the renderer, so every caller goes
	 * through here instead of awaiting the factory directly.
	 */
	const resolveService = async (): Promise<{ service: RemoteHostConnectionService } | { code: string }> => {
		try {
			const service = await input.service?.();
			return service === undefined ? { code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" } : { service };
		} catch (error) {
			return { code: codeOf(error, "REMOTE_CONNECTION_SERVICE_UNAVAILABLE") };
		}
	};

	ipcMain.handle(ipcChannels.remoteHostsList, async (): Promise<RemoteHostListResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			const view = await input.list();
			const snapshot = view.snapshot;
			return {
				ok: true,
				status: snapshot.status,
				hosts: snapshot.profiles.map(({ id, label, sshHost, verifiedEndpoint, disabledAt }) => ({ id, label, sshHost, verified: verifiedEndpoint !== undefined, disabled: disabledAt !== undefined })),
				...(snapshot.status === "needs-repair" ? { repair: repairSummary(view) } : {}),
			};
		} catch {
			return { ok: false, code: "REMOTE_HOST_LIST_UNAVAILABLE" };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostConnect, async (_event, hostId: unknown): Promise<RemoteHostConnectResult> => {
		// Renderer input is never trusted: validate at the boundary before any process can start.
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, hostId: typeof hostId === "string" ? hostId : "", code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		const resolved = await resolveService();
		if ("code" in resolved) return { ok: false, hostId, code: resolved.code };
		try {
			// The service already converts every failure into a stable code; it never throws here.
			const result = await resolved.service.connect(hostId);
			// Reduce the machine snapshot to the state the UI actually renders: generation, attempts and the
			// latched flag are main-internal and would invite the renderer to reason about fencing it cannot
			// observe. Diagnostics carry the detail the UI is allowed to show.
			return result.ok ? { ok: true, hostId: result.hostId, state: result.state.state } : { ok: false, hostId: result.hostId, code: result.code };
		} catch {
			return { ok: false, hostId, code: "REMOTE_CONNECTION_FAILED" };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostDisconnect, async (_event, hostId: unknown): Promise<RemoteHostDisconnectResult> => {
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, hostId: typeof hostId === "string" ? hostId : "", code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		const resolved = await resolveService();
		if ("code" in resolved) return { ok: false, hostId, code: resolved.code };
		try {
			await resolved.service.disconnect(hostId, "shutdown");
			return { ok: true, hostId };
		} catch {
			return { ok: false, hostId, code: "REMOTE_CONNECTION_FAILED" };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostDiagnostics, async (_event, hostId: unknown): Promise<RemoteHostDiagnosticsResult> => {
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, hostId: typeof hostId === "string" ? hostId : "", code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		const resolved = await resolveService();
		if ("code" in resolved) return { ok: false, hostId, code: resolved.code };
		try {
			const entries = resolved.service
				.listDiagnostics(hostId)
				.slice(-MAX_DIAGNOSTIC_ENTRIES)
				.map(diagnosticEntry)
				.filter((entry): entry is RemoteHostDiagnosticEntry => entry !== null);
			return { ok: true, hostId, entries };
		} catch {
			return { ok: false, hostId, code: "REMOTE_CONNECTION_FAILED" };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostScanConfig, async (): Promise<RemoteHostConfigScanResult> => {
		const disabled = guard<RemoteHostConfigScanResult>(() => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }));
		if (disabled !== undefined) return disabled;
		try {
			return await scanSshConfig();
		} catch {
			return { ok: false, code: "REMOTE_HOST_CONFIG_UNREADABLE" };
		}
	});

	/**
	 * Add a host: create the draft, then publish a fingerprint confirmation for the user to answer.
	 *
	 * The pin offer is started from *this* handler using the caller's `webContents.id` as the broker's
	 * sender binding, never a renderer-supplied id. The draft is created first so the offer has a subject;
	 * if the offer then fails, the draft is left in place rather than deleted, because a partially written
	 * store is worse than an unverified draft the user can retry or retire.
	 */
	ipcMain.handle(ipcChannels.remoteHostAdd, async (event, value: unknown): Promise<RemoteHostAddResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const parsed = readAddInput(value);
		if (parsed === null) return { ok: false, code: "REMOTE_HOST_ADD_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_HOST_ADD_INVALID" };
		try {
			const { store } = await openStores();
			const revision = store.getSnapshot().revision;
			const profile = await store.createDraft(
				{ label: parsed.label, sshHost: parsed.hostName, connectTimeoutMs: 10_000, ...(parsed.user === undefined ? {} : { user: parsed.user }), ...(parsed.port === undefined ? {} : { port: parsed.port }), ...(parsed.identityFile === undefined ? {} : { identityFile: parsed.identityFile }) },
				revision,
			);
			// `createDraft` is a CAS write, so the revision it committed under is already stale here.
			// `offerPin` validates against the *current* revision, so it has to be re-read after the write;
			// passing the pre-write value always fails as REMOTE_HOST_REVISION_CONFLICT. Same discipline the
			// connection service follows: read the revision after a write, never before one.
			const currentRevision = store.getSnapshot().revision;
			let offer: Awaited<ReturnType<typeof store.offerPin>>;
			try {
				offer = await store.offerPin(profile.id, senderId, currentRevision);
			} catch (error) {
				// The offer is where the real host verification happens (reachability, key mismatch), so it
				// is the step that actually fails in practice. The draft was created moments ago and holds no
				// trust anchor, so roll it back: leaving it behind is what produced a growing list of
				// unremovable "unverified" rows, one per failed attempt.
				await rollbackDraft(store, profile.id);
				throw error;
			}
			// Push the confirmation to the window that asked, so the dialog cannot be answered by another.
			if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.remoteHostPinRequest, pinRequestFrom(offer));
			return { ok: true, hostId: profile.id, status: "pending" };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_ADD_FAILED") };
		}
	});

	/**
	 * Answer a fingerprint confirmation.
	 *
	 * The `senderId` binding is what makes this safe: the broker only accepts an answer from the window
	 * that was shown the fingerprint, and the answer carries just a `choice` — the endpoint itself is
	 * main-owned payload the renderer never sees or supplies.
	 */
	ipcMain.handle(ipcChannels.remoteHostAnswerPin, async (event, requestId: unknown, hostId: unknown, choice: unknown): Promise<RemoteHostPinAnswerResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return { ok: false, code: "REMOTE_HOST_PIN_ANSWER_INVALID" };
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, code: "REMOTE_HOST_PIN_ANSWER_INVALID" };
		if (choice !== "approve" && choice !== "deny") return { ok: false, code: "REMOTE_HOST_PIN_ANSWER_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_HOST_PIN_ANSWER_INVALID" };
		try {
			// Must be the same pin store the offer was made in: the pending request lives in its broker.
			const { store } = await openStores();
			const revision = store.getSnapshot().revision;
			const confirmed = await store.confirmPin({ requestId, hostId, senderId, choice }, revision);
			// `null` means the user denied: the pin is not saved and the draft stays unverified, which is a
			// deliberate outcome rather than a failure.
			return { ok: true, hostId, approved: confirmed !== null };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_PIN_ANSWER_FAILED") };
		}
	});

	/**
	 * Repair confirmation state.
	 *
	 * The broker validates requestId + sender, but it does not hand the caller's own binding back on
	 * lookup, so the subject and the revision the user actually approved live here — the same pattern
	 * `SshHostPinStore` uses for the fingerprint flow. `onRemoved` keeps both in step when a request
	 * expires or is cancelled, so a stale entry cannot be answered later.
	 */
	const repairPending = new Map<string, { subjectId: string; digest: string; revision: number }>();
	const repairBroker = new PendingConfirmationBroker<{ action: HostRepairAction; hostId?: string }>({
		onRemoved: (requestId) => {
			repairPending.delete(requestId);
		},
	});
	const repairAction = "remote:host-repair";
	const repairDigest = (action: string, hostId: string | undefined, revision: number): string =>
		createHash("sha256")
			.update(JSON.stringify(["pideck-repair-v1", action, hostId ?? null, revision]), "utf8")
			.digest("hex");

	/** Build a write-capable repair facade over the shared stores. */
	const openRepair = async () => {
		const { store, pinStore } = await openStores();
		return {
			repair: new RemoteHostRepair({
				userDataDir: input.userDataDir,
				store,
				pins: {
					readPin: (hostId, endpoint) => pinStore.readPin(hostId, endpoint),
					deletePin: (hostId) => pinStore.deletePin(hostId),
					// The pin store keeps its verifier private; this is the re-authentication the A1 path needs.
					verifyRoute: (route, pinAlias) => pinStore.reverifyRoute(route, pinAlias),
				},
			}),
			store,
		};
	};

	ipcMain.handle(ipcChannels.remoteHostRepairDiagnose, async (): Promise<RemoteHostRepairDiagnosisResult> => {
		const disabled = guard<RemoteHostRepairDiagnosisResult>(() => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }));
		if (disabled !== undefined) return disabled;
		try {
			const { repair, store } = await openRepair();
			// A healthy store has nothing to diagnose: report an empty list rather than an error.
			if (store.getSnapshot().status === "ready") return { ok: true, findings: [] };
			const findings = await repair.diagnose();
			return { ok: true, findings: findings.map(findingFrom) };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_REPAIR_UNAVAILABLE") };
		}
	});

	/**
	 * Ask to run a repair. Validates, then publishes a confirmation instead of running: repairing writes
	 * the store or deletes a trust anchor, so it needs the user's explicit approval first.
	 */
	ipcMain.handle(ipcChannels.remoteHostRepairRun, async (event, action: unknown, hostIdValue: unknown): Promise<RemoteHostRepairRunResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (typeof action !== "string" || !REPAIR_ACTIONS.has(action)) return { ok: false, code: "REMOTE_HOST_REPAIR_ACTION_INVALID" };
		// Lock repair is host-independent by nature; every other action names exactly one host.
		let hostId: string | undefined;
		if (action !== "clear-stale-lock") {
			if (typeof hostIdValue !== "string" || !HOST_ID.test(hostIdValue)) return { ok: false, code: "REMOTE_HOST_REPAIR_ACTION_INVALID" };
			hostId = hostIdValue;
		}
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_HOST_REPAIR_ACTION_INVALID" };
		try {
			const { repair, store } = await openRepair();
			const snapshot = store.getSnapshot();
			// Only actions the diagnosis actually authorised may be requested: the UI must not be able to
			// invent one, and a stale button must not run something the current state no longer allows.
			const findings = snapshot.status === "ready" ? [] : await repair.diagnose();
			const allowed = findings.some((finding) => finding.actions.includes(action as HostRepairAction) && (hostId === undefined || finding.hostIds.length === 0 || finding.hostIds.includes(hostId)));
			if (!allowed) return { ok: false, code: "HOST_REPAIR_NOT_APPLICABLE" };
			const requested = action as HostRepairAction;
			const subjectId = hostId ?? "lock";
			const digest = repairDigest(requested, hostId, snapshot.revision);
			const label = hostId === undefined ? "" : String(store.getProfile(hostId)?.label ?? "");
			const { requestId, expiresAt } = repairBroker.begin({ senderId, action: repairAction, subjectId, stateDigest: digest, payload: { action: requested, ...(hostId === undefined ? {} : { hostId }) } });
			repairPending.set(requestId, { subjectId, digest, revision: snapshot.revision });
			if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.remoteHostRepairConfirm, { requestId, expiresAt, action: requested, ...(hostId === undefined ? {} : { hostId }), label } satisfies RemoteHostRepairRequest);
			return { ok: true, status: "pending" };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_REPAIR_FAILED") };
		}
	});

	/**
	 * Answer a repair confirmation and, when approved, run it.
	 *
	 * `broker.answer` returns the payload only when the requestId and sender still match, so a replayed,
	 * expired or foreign answer runs nothing. The revision passed to each action is the one the user
	 * approved — the repair module re-checks it under the store lock, so a state change in between is
	 * refused rather than applied to a state nobody looked at.
	 */
	ipcMain.handle(ipcChannels.remoteHostRepairAnswer, async (event, requestId: unknown, choice: unknown): Promise<RemoteHostRepairAnswerResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return { ok: false, code: "REMOTE_HOST_REPAIR_ANSWER_INVALID" };
		if (choice !== "approve" && choice !== "deny") return { ok: false, code: "REMOTE_HOST_REPAIR_ANSWER_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_HOST_REPAIR_ANSWER_INVALID" };
		try {
			const offered = repairPending.get(requestId);
			if (offered === undefined) return { ok: false, code: "HOST_REPAIR_CONFIRMATION_REQUIRED" };
			const { repair } = await openRepair();
			const payload = repairBroker.answer({ requestId, senderId, action: repairAction, subjectId: offered.subjectId, stateDigest: offered.digest, choice });
			if (payload === null) return { ok: true, ran: false };
			const confirmation = { requestId, senderId };
			switch (payload.action) {
				case "complete-activation-from-pin":
					await repair.completeActivationFromPin(payload.hostId as string, offered.revision, confirmation);
					break;
				case "discard-orphan-pin":
					await repair.discardOrphanPin(payload.hostId as string, confirmation);
					break;
				case "forget-trust-anchor":
					await repair.forgetTrustAnchor(payload.hostId as string, offered.revision, confirmation);
					break;
				case "clear-stale-lock":
					await repair.clearStaleHostLock(process.pid, confirmation);
					break;
				default:
					return { ok: false, code: "REMOTE_HOST_REPAIR_ACTION_INVALID" };
			}
			return { ok: true, ran: true };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_REPAIR_FAILED") };
		}
	});
	/**
	 * 设置页那套临时「浏览已确认 root」的入口曾在这里：五条 `remote:workspace-*` 通道只凭内存里的
	 * confirmed root 就放行读取，从不重新对齐 live helper 会话。删除它是必要的，但从来不是充分的——
	 * 项目之间的并发串根修在 `RemoteHostConnectionService.withProjectSession`，边界现在在那里。
	 * 它用到的只读构件（RemoteWorkspaceReader、canonical root resolver、helper）全部保留，
	 * 各自的测试也照旧运行。
	 */

	/**
	 * Validate a path the renderer named. Relative to the confirmed root by construction: an absolute path,
	 * a traversal segment, a control byte or a backslash is refused here, so the helper only ever sees a
	 * value that stays inside the boundary regardless of what the UI sent.
	 *
	 * The empty string is this layer's spelling of "the root". The reader spells it `"."` instead (it
	 * refuses an empty path outright), so the two are translated by `readerPath` — the UI should not have to
	 * know which convention the transport chose.
	 */
	const readRelativePath = (value: unknown): string | undefined => {
		if (typeof value !== "string" || value.length > 4096) return undefined;
		if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
		if (value.startsWith("/")) return undefined;
		if (value === "") return "";
		const segments = value.split("/");
		if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
		return value;
	};

	/** This layer's empty string means the root; the reader's own spelling of that is `"."`. */
	const readerPath = (relative: string): string => (relative === "" ? "." : relative);

	/**
	 * Remote project enrollment (Phase 3 第二段).
	 *
	 * A separate decision from browsing a root: this writes a **persistent project** (`ProjectStore`). It
	 * therefore has its own broker action, its own pending table and its own confirmation push channel, so
	 * a project-enrollment prompt can never arrive in the workspace panel or vice versa. The renderer submits
	 * only `{ hostId, candidatePath }`; the canonical value is resolved here and stays here.
	 */
	const enrollBroker = new PendingConfirmationBroker<{ hostId: string; canonicalPath: string }>({
		onRemoved: (requestId) => {
			enrollOffers.delete(requestId);
		},
	});
	const enrollOffers = new Map<string, { subjectId: string; digest: string }>();
	const enrollAction = "remote:project-enroll";
	const enrollDigest = (hostId: string, canonicalPath: string): string =>
		createHash("sha256")
			.update(JSON.stringify(["pideck-project-enroll-v1", hostId, canonicalPath]), "utf8")
			.digest("hex");

	ipcMain.handle(ipcChannels.remoteProjectEnroll, async (event, hostIdValue: unknown, pathValue: unknown): Promise<RemoteProjectEnrollResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (input.projects === undefined) return { ok: false, code: "REMOTE_PROJECT_ENROLL_UNAVAILABLE" };
		if (typeof hostIdValue !== "string" || !HOST_ID.test(hostIdValue)) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		if (typeof pathValue !== "string") return { ok: false, code: "REMOTE_BROWSE_ROOT_INVALID" };
		const resolvedService = await resolveService();
		if ("code" in resolvedService) return { ok: false, code: resolvedService.code };
		try {
			// Same pinned probe the workspace panel uses: the canonical value shown here is the one that will be
			// confined to, and a symlink that the handshake would reject can never be confirmed in the first place.
			const resolved = await resolveRemoteBrowseRoot({ userDataDir: input.userDataDir, hostId: hostIdValue, client: resolvedService.service.client, userPath: pathValue });
			const digest = enrollDigest(hostIdValue, resolved.canonicalPath);
			const { requestId, expiresAt } = enrollBroker.begin({ senderId, action: enrollAction, subjectId: hostIdValue, stateDigest: digest, payload: { hostId: hostIdValue, canonicalPath: resolved.canonicalPath } });
			enrollOffers.set(requestId, { subjectId: hostIdValue, digest });
			if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.remoteProjectEnrollConfirm, { requestId, expiresAt, hostId: hostIdValue, label: pathValue, requestedPath: pathValue, canonicalPath: resolved.canonicalPath } satisfies RemoteProjectEnrollRequest);
			return { ok: true, status: "pending", hostId: hostIdValue, canonicalPath: resolved.canonicalPath };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_TARGET_INVALID") };
		}
	});

	ipcMain.handle(ipcChannels.remoteProjectAnswer, async (event, requestId: unknown, choice: unknown): Promise<RemoteProjectEnrollAnswerResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (input.projects === undefined) return { ok: false, code: "REMOTE_PROJECT_ENROLL_UNAVAILABLE" };
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		if (choice !== "approve" && choice !== "deny") return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		const offered = enrollOffers.get(requestId);
		if (offered === undefined) return { ok: false, code: "REMOTE_PROJECT_ENROLL_CONFIRMATION_REQUIRED" };
		try {
			const payload = enrollBroker.answer({ requestId, senderId, action: enrollAction, subjectId: offered.subjectId, stateDigest: offered.digest, choice });
			if (payload === null) return { ok: true, enrolled: false };
			// The confirmation window is real time, and the world moves inside it: the directory can be deleted,
			// or a symlink along it can be re-pointed at something else. Writing the value the user was *shown*
			// is therefore not enough on its own — that value has to still resolve to itself right now, or the
			// user would be confirming a boundary that no longer exists (or no longer means what it did).
			//
			// Re-probing also re-runs the pinned preflight, so a host that was disabled or retired while the
			// prompt was open fails here instead of being enrolled. Nothing is persisted unless this passes,
			// and the broker already consumed the request, so the user re-enrolls rather than getting a
			// half-written record.
			const resolvedService = await resolveService();
			if ("code" in resolvedService) return { ok: false, code: resolvedService.code };
			try {
				const rechecked = await resolveRemoteBrowseRoot({ userDataDir: input.userDataDir, hostId: payload.hostId, client: resolvedService.service.client, userPath: payload.canonicalPath });
				if (rechecked.canonicalPath !== payload.canonicalPath) return { ok: false, code: "REMOTE_PROJECT_ROOT_CHANGED" };
			} catch (error) {
				return { ok: false, code: codeOf(error, "REMOTE_PROJECT_ROOT_UNRESOLVED") };
			}
			// Write the durable record only now, with the main-held canonical value. The renderer cannot supply
			// the path, the id or an "already confirmed" flag.
			const { projectId } = await input.projects.enroll({ hostId: payload.hostId, canonicalRemotePath: payload.canonicalPath });
			return { ok: true, enrolled: true, projectId };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_TARGET_INVALID") };
		}
	});

	/**
	 * Resolve a project's ssh locator into the host/root pair a read needs.
	 *
	 * Deliberately performs no session work and returns no reader: switching the root, establishing the
	 * session and the whole listing/file read happen together inside `withProjectSession`. Handing back a
	 * reader here is exactly the shape that let a second project's root switch land in the middle of a
	 * multi-chunk read. Every failure is a stable code; a non-ssh project is refused rather than guessed at.
	 */
	const projectReadTarget = async (projectId: unknown): Promise<{ hostId: string; remotePath: string; service: RemoteHostConnectionService } | { code: string }> => {
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) return { code: "REMOTE_PROJECT_TARGET_INVALID" };
		if (input.projects === undefined) return { code: "REMOTE_PROJECT_ENROLL_UNAVAILABLE" };
		const locator = input.projects.locator(projectId);
		if (locator === undefined) return { code: "REMOTE_PROJECT_NOT_FOUND" };
		if (locator.kind !== "ssh") return { code: "UNSUPPORTED_PROJECT_LOCATION" };
		const resolvedService = await resolveService();
		if ("code" in resolvedService) return { code: resolvedService.code };
		return { hostId: locator.hostId, remotePath: locator.remotePath, service: resolvedService.service };
	};

	/**
	 * Bind the reader's transport to one already-pinned session.
	 *
	 * The host id is re-checked rather than ignored: the reader names a host in its diagnostics, and a port
	 * that silently served another host would make those diagnostics lie.
	 */
	const sessionPort = (session: RemoteProjectSession, hostId: string): RemoteWorkspacePort => ({
		request: (requestHostId, method, params, options) => (requestHostId === hostId ? session.request(method, params, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
		cancel: (requestHostId, requestId, options) => (requestHostId === hostId ? session.cancel(requestId, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
	});

	ipcMain.handle(ipcChannels.remoteProjectList, async (_event, projectIdValue: unknown, pathValue: unknown): Promise<RemoteProjectListResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const relative = readRelativePath(pathValue);
		if (relative === undefined) return { ok: false, code: "REMOTE_PROJECT_PATH_INVALID" };
		const target = await projectReadTarget(projectIdValue);
		if ("code" in target) return { ok: false, code: target.code };
		try {
			// The whole listing runs inside the host's operation boundary: a switch for another project queues
			// behind it instead of re-pointing the session halfway through.
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				return reader.list(target.hostId, readerPath(relative));
			});
			if (!outcome.ok) return { ok: false, code: outcome.code };
			return { ok: true, entries: outcome.value.entries.map((entry) => ({ name: entry.name, kind: entry.kind, ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }) })) };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_READ_FAILED") };
		}
	});

	ipcMain.handle(ipcChannels.remoteProjectRead, async (_event, projectIdValue: unknown, pathValue: unknown): Promise<RemoteProjectReadResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		// The read of the root itself is not a file; an empty path is a valid listing target but never a read.
		const relative = readRelativePath(pathValue);
		if (relative === undefined || relative === "") return { ok: false, code: "REMOTE_PROJECT_PATH_INVALID" };
		const target = await projectReadTarget(projectIdValue);
		if ("code" in target) return { ok: false, code: target.code };
		try {
			// The sizing stat, every chunk and the closing stat all happen under one host operation, so no
			// other project can switch the root between two chunks of this file.
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				return reader.readFile(target.hostId, relative);
			});
			if (!outcome.ok) return { ok: false, code: outcome.code };
			const file = outcome.value;
			return { ok: true, contentBase64: Buffer.from(file.content).toString("base64"), bytes: file.bytes, mtimeMs: file.mtimeMs };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_READ_FAILED") };
		}
	});
}

/** Project a diagnosis finding onto the renderer contract, dropping anything not on the allowlist. */
function findingFrom(finding: { reason: string; classification: string; hostIds: readonly string[]; actions: readonly string[] }): RemoteHostRepairFinding {
	return {
		reason: REPAIR_REASON.test(finding.reason) ? finding.reason : "REMOTE_HOST_DIAGNOSTIC_UNKNOWN",
		classification: REPAIR_CLASSIFICATIONS.has(finding.classification) ? (finding.classification as RemoteHostRepairFinding["classification"]) : "unknown",
		hostIds: finding.hostIds.filter((id) => HOST_ID.test(id)).slice(0, 2000),
		actions: finding.actions.filter((action) => REPAIR_ACTIONS.has(action)) as RemoteHostRepairFinding["actions"],
	};
}

/**
 * Best-effort rollback of a draft whose offer failed.
 *
 * Deliberately swallows its own failure: the caller is already reporting the offer error, and losing
 * that in favour of a cleanup error would hide the reason the add did not work. A draft that survives
 * a failed rollback is still visible and still unremovable, so this is a real (if unlikely) residue
 * rather than something to pretend about.
 */
async function rollbackDraft(store: { getSnapshot: () => { revision: number }; discardUnverifiedDraft: (hostId: string, revision: number) => Promise<string> }, hostId: string): Promise<void> {
	try {
		await store.discardUnverifiedDraft(hostId, store.getSnapshot().revision);
	} catch {
		// Residue is preferable to masking the original failure.
	}
}

/** The broker keys on a positive integer sender; `webContents.id` is exactly that. */
function senderIdOf(sender: WebContents): number | undefined {
	const id = sender?.id;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function pinRequestFrom(offer: { requestId: string; expiresAt: number; hostId: string; hostName: string; user: string; port: number; hostKeyFingerprints: string[] }): RemoteHostPinRequest {
	return { requestId: offer.requestId, expiresAt: offer.expiresAt, hostId: offer.hostId, hostName: offer.hostName, user: offer.user, port: offer.port, hostKeyFingerprints: [...offer.hostKeyFingerprints] };
}

/**
 * Map a thrown store/pin error to a stable code. Only messages that are already a bare code survive;
 * anything else collapses to the fallback so no path or command line can reach the renderer.
 */
function codeOf(error: unknown, fallback: string): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : fallback;
}
