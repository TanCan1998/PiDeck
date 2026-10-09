/**
 * 远端会话列表与登记的纯状态机（渲染层 H2）。
 *
 * 为什么单独成模块：列表的核心规则是「代次 + 三态 + 响应收窄」，与 React 无关，必须能离开组件单测——
 * 尤其是**迟到结果作废**（切主机、重扫之后，旧请求的结果绝不能覆盖新主机的列表）。
 * 代次复用 `remoteRequestGate`：与远端目录读取、搜索面板同一个闸门语义，不另立一套。
 *
 * 扫描失败是**稳定码拒绝**，不是截断：主进程在越过硬上限时整体拒绝，因此界面必须能给「被上限拒绝」
 * 一句实话，而不是像搜索那样呈现 truncated（两者是不同的契约，不能混）。
 *
 * IPC 返回也是外部数据：逐字段收窄，任何读不懂的形状都算「请求失败」，绝不降级成「没有会话」。
 */

import { createRequestGate } from "./remoteRequestGate";

/** 渲染层可安全使用的远端会话元数据（不含任何正文）。 */
export type RemoteSessionEntryView = {
	remoteSessionId: string;
	remotePath: string;
	name: string;
	size: number;
	mtimeMs: number;
};

export type RemoteSessionScanOutcome = { kind: "ok"; entries: RemoteSessionEntryView[] } | { kind: "failed"; code: string } | { kind: "rejected" };

/** idle=没扫过；scanning=在途；empty=扫描成功但远端没有会话；entries=有结果；error=失败/读不懂。 */
export type RemoteSessionListPhase = "idle" | "scanning" | "empty" | "entries" | "error";

export type RemoteSessionListState = {
	phase: RemoteSessionListPhase;
	/** 本代次的 hostId（结果只属于它）。 */
	hostId: string | null;
	entries: RemoteSessionEntryView[];
	/** 稳定错误码；IPC reject（没有码可报）时为 null。 */
	errorCode: string | null;
	scannedAt: number | null;
};

export type RemoteSessionRegisterOutcome = { kind: "ok"; sessionId: string; created: boolean; remoteSessionId: string } | { kind: "failed"; code: string } | { kind: "rejected" };

/** 一个码就是一个码，绝不是自由文本（与主进程同一判据）。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 512;

/**
 * 扫描的硬上限码（主进程 REMOTE_SESSION_CODES 里的三个）。
 * 它们是**整体拒绝**：列表不完整就没有列表，界面必须单独提示「超过上限」而不是普通失败。
 */
export const REMOTE_SESSION_LIMIT_CODES: ReadonlySet<string> = new Set(["REMOTE_SESSION_DIR_LIMIT_EXCEEDED", "REMOTE_SESSION_FILE_LIMIT_EXCEEDED", "REMOTE_SESSION_BUDGET_EXCEEDED"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** remoteSessionId 必须是相对会话根的 POSIX .jsonl 路径（与主进程同判据，跨边界重复校验）。 */
function isRemoteSessionId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) return false;
	if (CONTROL_CHARS.test(value) || value.includes("\\") || value.startsWith("/")) return false;
	const segments = value.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || segment === "." || segment === "..") return false;
	}
	const last = segments[segments.length - 1] ?? "";
	return last.length > ".jsonl".length && last.toLowerCase().endsWith(".jsonl");
}

/** remotePath 是远端相对路径：不要求 .jsonl 后缀（下一增量可能带别名），但仍不许绝对/越界。 */
function isSafeRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
	if (CONTROL_CHARS.test(value) || value.includes("\\") || value.startsWith("/")) return false;
	return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isTitleName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH && !CONTROL_CHARS.test(value) && !value.includes("/") && !value.includes("\\");
}

/** 逐字段重建一条远端会话元数据；多出来的字段一律丢弃（渲染层不需要，也不该带进来）。 */
function readEntryView(value: unknown): RemoteSessionEntryView | undefined {
	if (!isRecord(value)) return undefined;
	const remoteSessionId = value.remoteSessionId;
	if (!isRemoteSessionId(remoteSessionId)) return undefined;
	const remotePath = value.remotePath;
	if (!isSafeRelativePath(remotePath)) return undefined;
	const name = value.name;
	if (!isTitleName(name)) return undefined;
	if (!isCount(value.size)) return undefined;
	if (!isTime(value.mtimeMs)) return undefined;
	return { remoteSessionId, remotePath, name, size: value.size, mtimeMs: value.mtimeMs };
}

/**
 * 把扫描返回收窄成一次终态。任何读不懂的形状都是 `rejected`（请求失败），而不是「空列表」——
 * 把畸形响应当成「远端没有会话」是这里最危险的一种谎。
 * 重复身份也判畸形：React key 与后续登记目标都会含糊。
 */
export function readScanResponse(raw: unknown): RemoteSessionScanOutcome {
	if (!isRecord(raw)) return { kind: "rejected" };
	if (raw.ok === false) return typeof raw.code === "string" && STABLE_CODE.test(raw.code) ? { kind: "failed", code: raw.code } : { kind: "rejected" };
	if (raw.ok !== true) return { kind: "rejected" };
	if (!Array.isArray(raw.entries)) return { kind: "rejected" };
	const entries: RemoteSessionEntryView[] = [];
	const seen = new Set<string>();
	for (const value of raw.entries) {
		const entry = readEntryView(value);
		if (entry === undefined) return { kind: "rejected" };
		if (seen.has(entry.remoteSessionId)) return { kind: "rejected" };
		seen.add(entry.remoteSessionId);
		entries.push(entry);
	}
	return { kind: "ok", entries };
}

/**
 * 把登记返回收窄成一次终态。
 * `expectedRemoteSessionId` 必须被原样回显：回显别的身份说明这次登记的归属含糊，
 * 宁可报读不懂，也绝不能拿一个不确定的 sessionId 去选中会话。
 */
export function readRegisterResponse(raw: unknown, expectedRemoteSessionId: string): RemoteSessionRegisterOutcome {
	if (!isRecord(raw)) return { kind: "rejected" };
	if (raw.ok === false) return typeof raw.code === "string" && STABLE_CODE.test(raw.code) ? { kind: "failed", code: raw.code } : { kind: "rejected" };
	if (raw.ok !== true) return { kind: "rejected" };
	const sessionId = raw.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > MAX_ID_LENGTH || CONTROL_CHARS.test(sessionId)) return { kind: "rejected" };
	if (typeof raw.created !== "boolean") return { kind: "rejected" };
	if (raw.remoteSessionId !== expectedRemoteSessionId) return { kind: "rejected" };
	return { kind: "ok", sessionId, created: raw.created, remoteSessionId: expectedRemoteSessionId };
}

/** 只带 locator 的最小结构（SessionRecord / SessionSummary 都结构上满足）。 */
export type RemoteSessionLocatorCarrier = {
	locator?: { kind?: string; hostId?: string; remoteSessionId?: string } | undefined;
};

/**
 * 从本地 catalog 记录里收集「已登记到本地」的远端会话身份（用于给列表打「已导入」标记）。
 * 只认同主机且带 remoteSessionId 的 ssh locator：其它形态即使有 hostId 也不能算这条会话。
 */
export function collectRegisteredRemoteSessionIds(sessions: readonly RemoteSessionLocatorCarrier[], hostId: string): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const session of sessions) {
		const locator = session.locator;
		if (locator?.kind !== "ssh" || locator.hostId !== hostId) continue;
		if (typeof locator.remoteSessionId === "string" && locator.remoteSessionId.length > 0) ids.add(locator.remoteSessionId);
	}
	return ids;
}

export function idleRemoteSessionListState(hostId: string | null = null): RemoteSessionListState {
	return { phase: "idle", hostId, entries: [], errorCode: null, scannedAt: null };
}

/** 快照可能是「上次挂载时还在 scanning」：挂载后没有在途请求，必须归一到 idle，否则会永远转圈。 */
function normalizeSnapshot(snapshot: RemoteSessionListState | undefined): RemoteSessionListState {
	if (snapshot === undefined || snapshot.phase === "scanning") return idleRemoteSessionListState(snapshot?.hostId ?? null);
	return { phase: snapshot.phase, hostId: snapshot.hostId, entries: [...snapshot.entries], errorCode: snapshot.errorCode, scannedAt: snapshot.scannedAt };
}

function settledState(hostId: string | null, outcome: RemoteSessionScanOutcome): RemoteSessionListState {
	if (outcome.kind === "failed") return { phase: "error", hostId, entries: [], errorCode: outcome.code, scannedAt: Date.now() };
	if (outcome.kind === "rejected") return { phase: "error", hostId, entries: [], errorCode: null, scannedAt: Date.now() };
	// 成功但为空是 empty，不是「还在加载」也不是「失败」。
	return { phase: outcome.entries.length === 0 ? "empty" : "entries", hostId, entries: outcome.entries, errorCode: null, scannedAt: Date.now() };
}

export type RemoteSessionListController = {
	/** 当前状态；每次变化换成新对象，可直接放进 atom 触发重渲染。 */
	getState(): RemoteSessionListState;
	/** 发起一次扫描：作废在途结果并进入 scanning，返回本次代次。 */
	start(hostId: string): number;
	/** 落地一次结果；非当前代次返回 false 且不改动任何状态（迟到结果不得覆盖新状态）。 */
	settle(generation: number, outcome: RemoteSessionScanOutcome): boolean;
	/** 用某个主机的缓存快照重置状态机（切主机/重新挂载）；同时作废在途结果。 */
	restore(snapshot: RemoteSessionListState | undefined): void;
	/** 作废在途结果并回到 idle。 */
	reset(): void;
};

export function createRemoteSessionListController(initial?: RemoteSessionListState): RemoteSessionListController {
	const gate = createRequestGate();
	let state = normalizeSnapshot(initial);
	return {
		getState: () => state,
		start(hostId) {
			const generation = gate.begin();
			state = { phase: "scanning", hostId, entries: [], errorCode: null, scannedAt: null };
			return generation;
		},
		settle(generation, outcome) {
			if (!gate.isCurrent(generation)) return false;
			state = settledState(state.hostId, outcome);
			return true;
		},
		restore(snapshot) {
			gate.invalidate();
			state = normalizeSnapshot(snapshot);
		},
		reset() {
			gate.invalidate();
			state = idleRemoteSessionListState(state.hostId);
		},
	};
}
