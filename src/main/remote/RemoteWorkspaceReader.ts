/**
 * Main-process driver for the read-only workspace batch (`fs.stat`, `fs.list`, `fs.read`; plan §7.1 / phase 3).
 *
 * Why this module is the only place those results are read: a helper's answer is remote data. Everything a
 * caller builds a path, an editor buffer or a tree row out of has to be *proved* to match
 * RemoteHelperContract first, so this file turns raw results into validated values and refuses them
 * otherwise. Nothing here spawns a process, touches a filesystem or knows what SSH is: a narrow port (one
 * `request`, an optional `cancel`) carries the frames, so the same logic runs against a live connection, a
 * recorded transcript or a unit-test transport.
 *
 * Invariants, all of them fail-closed:
 * - Every outcome carries a stable code (`RemoteWorkspaceError.code`). A remote `message`, an errno or a
 *   path can never travel: a transport failure is relayed only when it *is* a stable code, and the helper's
 *   own error text is dropped on purpose.
 * - Result shapes are validated exactly — a missing field, an extra field and a mistyped field are all
 *   protocol violations, because a peer that answers something else is not the peer this code was written
 *   against. Results are rebuilt field by field instead of being handed through.
 * - A read is bound to one description of the entry: the size from the sizing `fs.stat` bounds the chunk
 *   requests, every chunk has to reproduce its own declared length, the assembled total has to reproduce
 *   that size, and the entry is described once more at the end. A file that moved in between is refused as
 *   `REMOTE_WORKSPACE_FILE_CHANGED` rather than returned as a coherent-looking mixture of two versions.
 * - Cancellation never hangs and never lies: an abort settles as `REQUEST_CANCELLED`, no further frame is
 *   written afterwards, and a withdraw the helper declines is reported as *not* having taken effect.
 */

import {
	REMOTE_HELPER_MAX_CHUNK_BYTES,
	REMOTE_HELPER_MAX_HOST_ID_LENGTH,
	REMOTE_HELPER_MAX_LIST_ENTRIES,
	REMOTE_HELPER_MAX_PATH_LENGTH,
	REMOTE_HELPER_METHOD_FS_LIST,
	REMOTE_HELPER_METHOD_FS_READ,
	REMOTE_HELPER_METHOD_FS_STAT,
	type RemoteHelperListEntry,
	type RemoteHelperListResult,
	type RemoteHelperPathKind,
	type RemoteHelperStatResult,
} from "./RemoteHelperContract";

/**
 * Stable codes this reader adds to the contract's vocabulary. Everything else it can settle with is either a
 * contract code (`PROTOCOL_INVALID` for a shape violation, `RESULT_TOO_LARGE` for a bounded result that is
 * refused instead of truncated, `NOT_A_FILE` for a read target that is not a regular file,
 * `REQUEST_CANCELLED` for an aborted call) or a code the transport/helper produced itself.
 */
export const REMOTE_WORKSPACE_READER_CODES = {
	/** The entry moved between the sizing stat and the chunks: no single version of it was read. */
	fileChanged: "REMOTE_WORKSPACE_FILE_CHANGED",
	/** A transport failed without a stable code of its own; free text is collapsed instead of relayed. */
	requestFailed: "REMOTE_WORKSPACE_REQUEST_FAILED",
	/** The reader was wired without a usable port. Thrown at construction, like the other remote modules. */
	optionsInvalid: "REMOTE_WORKSPACE_READER_OPTIONS_INVALID",
} as const;

/** Codes that only ever reach the diagnostic stream: they describe a cancellation, never a call's outcome. */
export const REMOTE_WORKSPACE_DIAGNOSTIC_CODES = {
	/** A withdraw was sent for the request this reader walked away from. */
	cancelRequested: "REMOTE_WORKSPACE_CANCEL_REQUESTED",
	/** The withdraw did not take effect (`already-settled`), so the remote work may still be running. */
	cancelRefused: "REMOTE_WORKSPACE_CANCEL_REFUSED",
	/** The withdraw itself failed; the abandoned request keeps whatever outcome it will produce. */
	cancelFailed: "REMOTE_WORKSPACE_CANCEL_FAILED",
} as const;

/**
 * Local ceiling for one `readFile`, in bytes. The remote side has no equivalent bound: `fs.read` streams
 * whatever it is asked for, one contract-sized chunk at a time, so *this* is the only place a whole file can
 * be bounded. 16 MiB is what a desktop file surface can hold as a single in-memory buffer without becoming
 * the reason the main process runs out of memory (the session reader's byte watermark is the same order of
 * magnitude), and the ceiling is a stated local policy refusal — `RESULT_TOO_LARGE`, the contract's own code
 * for "a bounded result that is refused instead of truncated" — never a silent truncation.
 */
export const REMOTE_WORKSPACE_MAX_READ_BYTES = 16 * 1024 * 1024;

/**
 * Chunk budget for one read: the smallest count that can carry the byte ceiling, derived from the contract's
 * chunk size so it is not a second magic number. It is a backstop `RESULT_TOO_LARGE`: the "a chunk that came
 * up short has to be final" rule already makes every non-final chunk carry a full requested range, so with a
 * truthful helper this cap is never reached — a remote that keeps answering is stopped here instead of being
 * streamed forever.
 */
export const REMOTE_WORKSPACE_MAX_READ_CHUNKS = Math.ceil(REMOTE_WORKSPACE_MAX_READ_BYTES / REMOTE_HELPER_MAX_CHUNK_BYTES);

/**
 * Local ceiling for one `readHead`, in bytes (G3，冻结设计第 6/7 条：单次 head ≤ 64 KiB）。
 *
 * `readHead` 存在的理由是**不要为了拿一段前缀而整文件读**：远端会话 JSONL 可能几百 MB，
 * 而按需标题/头部解析只需要最前面的有界窗口。它是硬上限而不是默认值——请求超过它一律
 * `RESULT_TOO_LARGE` 拒绝（与 `readFile` 的体量上限同一语义：有界结果被拒绝，绝不悄悄截断）。
 */
export const REMOTE_WORKSPACE_MAX_HEAD_BYTES = 64 * 1024;

/**
 * `readHead` 的分块预算：由契约分块大小推导，因此不是第二个魔数。
 * 64 KiB 上限小于一个契约分块（1 MiB），所以正常情况下恒为 1 次 `fs.read`；
 * 这个上界的作用是：即使将来把 `REMOTE_WORKSPACE_MAX_HEAD_BYTES` 调大，也不会退化成无限循环。
 */
export const REMOTE_WORKSPACE_MAX_HEAD_CHUNKS = Math.ceil(REMOTE_WORKSPACE_MAX_HEAD_BYTES / REMOTE_HELPER_MAX_CHUNK_BYTES);

/**
 * 单次 `readWindow` 的本地字节上限（I1：尾窗口与头窗口同级）。
 *
 * 头窗口的 64 KiB 是「前缀」的界；pi 的权威会话名用 `/name` **追加在文件尾**，只看前缀就会漏掉它。
 * 尾窗口解决这个问题，但它必须是**有界的一段**而不是「再读多一点」：这个常量就是那段的上界，
 * 请求超过它一律 `RESULT_TOO_LARGE`（拒绝，不 clamp，与 readHead 同语义）。
 */
export const REMOTE_WORKSPACE_MAX_WINDOW_BYTES = 64 * 1024;

/** `readWindow` 的分块预算：由窗口上限与契约分块大小推导，防止对端一直答下去。 */
export const REMOTE_WORKSPACE_MAX_WINDOW_CHUNKS = Math.ceil(REMOTE_WORKSPACE_MAX_WINDOW_BYTES / REMOTE_HELPER_MAX_CHUNK_BYTES);

/** Options the reader passes to the transport for one helper request. */
export type RemoteWorkspacePortRequestOptions = {
	/** Local deadline, forwarded like `SshConnectionManager.request`'s option. */
	timeoutMs?: number;
	/**
	 * Reports the helper request id the transport minted for the frame it just wrote (`req-N`). The real
	 * control client mints its ids itself and only exposes cancellation *by id*, so this report is the only
	 * way a withdraw can ever name the request; a transport that cannot report one simply serves reads.
	 */
	onRequestId?: (requestId: string) => void;
};

/**
 * The narrow dependency the reader needs: one way to start a helper request on a ready host, and — when the
 * transport can cancel at all — one way to withdraw it by the id it reported.
 *
 * The `request` member is exactly `SshConnectionManager.request`'s shape, so a manager-backed adapter is
 * `{ request: (hostId, method, params, options) => manager.request(hostId, method, params, options), cancel:
 * (hostId, requestId, options) => manager.cancel(hostId, requestId, options) }`: the manager reports the id of
 * the frame it wrote through `options.onRequestId` and withdraws by that same id, which is what makes a
 * cancelled read name a real request instead of only abandoning it locally. A transport that cannot report an
 * id is still usable — every read works with cancellation reduced to a local abandonment — and one that cannot
 * cancel at all simply leaves `cancel` out. Both members are plain functions: an adapter must not rely on
 * `this`.
 */
export type RemoteWorkspacePort = {
	request: (hostId: string, method: string, params?: unknown, options?: RemoteWorkspacePortRequestOptions) => Promise<unknown>;
	cancel?: (hostId: string, requestId: string, options?: { timeoutMs?: number }) => Promise<unknown>;
};

/** Per-call options of `stat`, `list` and `readFile`. */
export type RemoteWorkspaceCallOptions = {
	/**
	 * Local deadline for each helper request, forwarded like `SshConnectionManager.request`'s option. A
	 * nonsensical value is dropped instead of being sent: the transport's default is a better answer than a
	 * deadline nobody can honour.
	 */
	timeoutMs?: number;
	/**
	 * Abandons the call: its promise settles with `REQUEST_CANCELLED`, no helper request is started after the
	 * signal fired, and a request that is already in flight is withdrawn best effort (`already-settled` means
	 * that withdraw did not take effect; it is never read as a rollback).
	 */
	signal?: AbortSignal;
};

/** One validated read: the bytes, the size they reproduce and the mtime of the version that was read. */
export type RemoteWorkspaceFile = {
	/** Reassembled bytes: exactly `bytes` long, never more than the local read ceiling. */
	content: Uint8Array;
	/** Size the sizing `fs.stat` declared, reproduced byte for byte by the chunks. */
	bytes: number;
	/** Modification time of the version that was read, from the same sizing `fs.stat`. */
	mtimeMs: number;
};

/**
 * One bounded head read (G3 冻结设计第 6 条）：文件最前面的一段前缀，加上它是谁的描述。
 *
 * 与 `RemoteWorkspaceFile` 的区别是语义而非形状：`readFile` 拿到的是一份**完整版本**，
 * `readHead` 拿到的只是一段**前缀**（`truncated` 说明后面还有没有字节），调用方不得把它当整份内容用。
 */
export type RemoteWorkspaceHead = {
	/** 前缀字节：长度恒等于 `bytes`，且不超过请求的 `maxBytes` 与远端文件大小。 */
	content: Uint8Array;
	/** 本次真正返回的字节数（`content.length`）。 */
	bytes: number;
	/** true = 远端文件还有更多字节没读（size > maxBytes）；false = 已经读到文件尾。 */
	truncated: boolean;
	/** 远端文件完整大小（读取前那次 `fs.stat` 的 `bytes`），用来判断 head 是否截断。 */
	size: number;
	/** 修改时间，来自同一次 `fs.stat`。 */
	mtimeMs: number;
};

/**
 * One bounded window read (I1): 从文件某个 offset 起的有界一段，加上它是谁的描述。
 *
 * 与 `readHead` 的区别只有起点：`readHead` 是 `offset = 0` 的特例；两者共享同一条纪律——
 * 一次 sizing `fs.stat` 决定请求范围（或由调用方给出刚拿到的 size），只请求 `min(offset+maxBytes, size)-offset`
 * 字节，绝不整文件读。`truncated = true` 表示这段之后还有字节（`offset + bytes < size`）。
 */
export type RemoteWorkspaceWindow = {
	/** 这一段字节：长度恒等于 `bytes`，且不超过请求的 `maxBytes`。 */
	content: Uint8Array;
	/** 本次真正返回的字节数（`content.length`）。 */
	bytes: number;
	/** 有效起点：请求的 offset 被 clamp 到文件尾之后的值（超过文件尾 ⇒ 空窗口）。 */
	offset: number;
	/** 远端文件完整大小（本次 stat 或调用方给出的 size）。 */
	size: number;
	/** true = 这一段之后还有字节没读（`offset + bytes < size`）。 */
	truncated: boolean;
};

/** `readWindow` 的入参：起点 + 本地上限，可选地给出调用方刚读到的 size。 */
export type RemoteWorkspaceWindowOptions = {
	/** 起点字节偏移；安全非负整数，超过文件尾时得到空窗口而不是错误。 */
	offset: number;
	/** 这一段最多读多少字节；正整数且不超过 `REMOTE_WORKSPACE_MAX_WINDOW_BYTES`，越界拒绝。 */
	maxBytes: number;
	/**
	 * 调用方刚刚在一次 `readHead`/`stat` 里拿到的文件大小。给出时本原语**跳过自己的 sizing stat**，
	 * 于是一次「头 + 尾」的标题解析只需要 1 次 stat；省略时本原语自己 stat 一次（独立使用也安全）。
	 */
	size?: number;
};

/** Redacted diagnostic record: closed-vocabulary identity plus one stable code, never content. */
export type RemoteWorkspaceReaderDiagnostic = {
	/** Validated helper host id; a bogus id is refused before anything is reported about it. */
	hostId: string;
	/** The contract method of the request that failed: a whole read reports `fs.stat` for its sizing step. */
	method: string;
	/** A code from the reader's or the contract's closed vocabulary — never free text. */
	code: string;
};

export type RemoteWorkspaceReaderOptions = {
	port: RemoteWorkspacePort;
	/** Observer side channel: a broken observer must never break a call, and only codes are reported. */
	onDiagnostic?: (entry: RemoteWorkspaceReaderDiagnostic) => void;
};

/** Read-only workspace access to one host; every failure carries a stable code. */
export type RemoteWorkspaceReader = {
	/** Classify one entry. lstat semantics: a symlink is `other`, its target's size is never reported. */
	stat(hostId: string, path: string, options?: RemoteWorkspaceCallOptions): Promise<RemoteHelperStatResult>;
	/** List one directory. Past the contract's entry cap the call is refused, never truncated. */
	list(hostId: string, path: string, options?: RemoteWorkspaceCallOptions): Promise<RemoteHelperListResult>;
	/** Read one regular file in contract-sized chunks, validated against a single description of the entry. */
	readFile(hostId: string, path: string, options?: RemoteWorkspaceCallOptions): Promise<RemoteWorkspaceFile>;
	/**
	 * Read at most `maxBytes` from the head of one regular file. Never reads the whole file:
	 * `maxBytes` must be a positive integer no larger than `REMOTE_WORKSPACE_MAX_HEAD_BYTES`
	 * (a larger value is refused as `RESULT_TOO_LARGE`, never clamped), and the request sent to the
	 * helper is bounded by both `maxBytes` and the size the sizing `fs.stat` declared.
	 */
	readHead(hostId: string, path: string, maxBytes: number, options?: RemoteWorkspaceCallOptions): Promise<RemoteWorkspaceHead>;
	/**
	 * Read a bounded window starting at `offset`. Same discipline as `readHead`: one sizing stat
	 * (unless the caller supplies `size`), requests only `min(offset+maxBytes, size)-offset` bytes,
	 * never the whole file. `offset` past the end answers an empty window.
	 */
	readWindow(hostId: string, path: string, window: RemoteWorkspaceWindowOptions, options?: RemoteWorkspaceCallOptions): Promise<RemoteWorkspaceWindow>;
};

/**
 * Structured reader failure. `message` is always the stable code and the helper's own text is never carried
 * over, so an error can be logged, shown or forwarded without a further redaction step.
 */
export class RemoteWorkspaceError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, retryable: boolean) {
		super(code);
		this.name = "RemoteWorkspaceError";
		this.code = code;
		this.retryable = retryable;
	}
}

/** Same shape the other remote modules enforce: a code is a code, never free text. */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** The helper refuses control bytes in a requested path, so they are not part of the path vocabulary here. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Canonical padded base64 only: a lenient decode would accept a malformed chunk that happens to fit. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Locally generated outcomes a retry can fix, mirroring the control client's own retry set. */
const RETRYABLE_CODES = new Set<string>(["REQUEST_TIMEOUT", "REMOTE_CONNECTION_LOST"]);
/** Contract field sets: an exact match is required, so an unknown extra field is as fatal as a missing one. */
const STAT_FIELDS = ["kind", "bytes", "mtimeMs"] as const;
const LIST_FIELDS = ["entries"] as const;
const ENTRY_FIELDS = ["name", "kind"] as const;
const ENTRY_FILE_FIELDS = ["name", "kind", "bytes"] as const;
const READ_FIELDS = ["chunk", "bytes", "eof"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Array.isArray` narrows to `any[]`; this keeps elements `unknown` until each one is validated. */
function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

/**
 * Duck-typed abort signal: the reader only needs these three members, and typing the guard is what keeps the
 * rest of the module free of casts while still refusing a caller that passes a non-signal.
 */
function isAbortSignalLike(value: unknown): value is AbortSignal {
	if (!isRecord(value)) return false;
	return typeof value.aborted === "boolean" && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

/** Exact field set: a missing field and an unexpected one are both protocol violations. */
function hasExactFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
	const keys = Object.keys(record);
	return keys.length === fields.length && fields.every((field) => Object.hasOwn(record, field));
}

/** A byte count or an offset: the contract only ever carries safe non-negative integers. */
function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readPathKind(value: unknown): RemoteHelperPathKind | undefined {
	if (value === "file" || value === "directory" || value === "other") return value;
	return undefined;
}

/**
 * A host id has to be usable as a diagnostic identity and as a transport key before anything is sent. An
 * invalid one is refused *without* being echoed: a caller's mistake here may well be a path or a credential.
 */
function readHostId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_HELPER_MAX_HOST_ID_LENGTH || CONTROL_CHARS.test(value)) return undefined;
	return value;
}

/**
 * The reader validates the *protocol shape* of a path (a non-empty string inside the contract's ceiling,
 * without control bytes) and nothing else. Containment is the helper's own rule, applied to its own root
 * before it touches the filesystem; a local copy of it would only be a second opinion that can drift from
 * the one that actually decides — and the reader does not know the root in the first place.
 */
function readRequestPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_HELPER_MAX_PATH_LENGTH || CONTROL_CHARS.test(value)) return undefined;
	return value;
}

/**
 * A directory entry name is one path segment. A listing is the one result a caller turns *back* into paths,
 * so a name that is not a single segment (empty, a dot segment, a separator, a control byte) is refused
 * instead of being joined onto a parent by a caller that trusts the protocol.
 */
function isEntryName(value: string): boolean {
	if (value.length === 0 || value === "." || value === "..") return false;
	if (value.includes("/") || value.includes("\\")) return false;
	return !CONTROL_CHARS.test(value);
}

function readStatResult(value: unknown): RemoteHelperStatResult | undefined {
	if (!isRecord(value) || !hasExactFields(value, STAT_FIELDS)) return undefined;
	const kind = readPathKind(value.kind);
	if (kind === undefined) return undefined;
	const bytes = value.bytes;
	if (!isCount(bytes)) return undefined;
	const mtimeMs = value.mtimeMs;
	if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return undefined;
	return { kind, bytes, mtimeMs };
}

function readListEntry(value: unknown): RemoteHelperListEntry | undefined {
	if (!isRecord(value)) return undefined;
	const name = value.name;
	if (typeof name !== "string" || !isEntryName(name)) return undefined;
	const kind = readPathKind(value.kind);
	if (kind === undefined) return undefined;
	// `bytes` travels for regular files only (a link stays `other` and its target is never followed), so a
	// size on a directory is as much a shape violation as a missing size on a file.
	if (kind === "file") {
		if (!hasExactFields(value, ENTRY_FILE_FIELDS)) return undefined;
		const bytes = value.bytes;
		if (!isCount(bytes)) return undefined;
		return { name, kind, bytes };
	}
	if (!hasExactFields(value, ENTRY_FIELDS)) return undefined;
	return { name, kind };
}

/** One validated chunk: the decoded bytes and the helper's own end-of-read statement. */
type ReadChunk = { readonly decoded: Buffer; readonly eof: boolean };

/**
 * Validate one `fs.read` answer against the request that produced it. `bytes` has to be the length of the
 * decoded chunk (a remote that says one thing and sends another is not answering this protocol), it can
 * never exceed what was asked for, and a chunk that came up short has to *say* it ended the file there —
 * the frozen helper's own rule is `eof = read < wanted || offset + read >= size`, so a short chunk that
 * claims more is coming is impossible for it and is refused here. That last rule also makes the loop
 * provably terminating: every chunk that is not the last one carries everything it was asked for.
 *
 * `eof` is otherwise *taken* rather than re-derived from the sizing stat: the helper computes it from the
 * size it observed when it opened the file, so a file that grew in between legitimately answers `eof:false`
 * on a full chunk. The read is held together by the sizing stat, the assembled length and the closing stat
 * instead (see `readFile`), which is also where a remote that contradicts itself is caught.
 */
function readChunkResult(value: unknown, wanted: number): ReadChunk | undefined {
	if (!isRecord(value) || !hasExactFields(value, READ_FIELDS)) return undefined;
	const chunk = value.chunk;
	if (typeof chunk !== "string" || !BASE64.test(chunk)) return undefined;
	const bytes = value.bytes;
	if (!isCount(bytes) || bytes > wanted || bytes > REMOTE_HELPER_MAX_CHUNK_BYTES) return undefined;
	const eof = value.eof;
	if (typeof eof !== "boolean") return undefined;
	const decoded = Buffer.from(chunk, "base64");
	if (decoded.length !== bytes) return undefined;
	if (bytes < wanted && eof === false) return undefined;
	return { decoded, eof };
}

/**
 * Normalize a transport failure. A stable code is relayed unchanged — the connection layer's own refusals
 * arrive as a bare `Error` whose *message* is the code (`SSH_CONNECTION_NOT_READY`), which is how
 * `SshConnectionManager` states them — while anything else collapses to the reader's generic code, so a
 * message that embeds a path, a command line or an errno can never travel. The helper's own error `message`
 * is dropped for the same reason.
 */
function readTransportFailure(error: unknown): { readonly code: string; readonly retryable: boolean } {
	if (isRecord(error)) {
		const code = error.code;
		if (typeof code === "string" && STABLE_CODE.test(code)) return { code, retryable: typeof error.retryable === "boolean" ? error.retryable : RETRYABLE_CODES.has(code) };
		const message = error.message;
		if (typeof message === "string" && STABLE_CODE.test(message)) return { code: message, retryable: RETRYABLE_CODES.has(message) };
	}
	return { code: REMOTE_WORKSPACE_READER_CODES.requestFailed, retryable: false };
}

/**
 * Local cancellation state for one call. The promise (`wait`) exists only when a signal does, so a caller
 * without one never pays for a race, and the listener is the only registered resource: `disposeCancellation`
 * is called from the `finally` of every public method.
 */
type Cancellation = {
	aborted: boolean;
	wait: Promise<void> | undefined;
	notify: (() => void) | undefined;
	listener: (() => void) | undefined;
	signal: AbortSignal | undefined;
};

function createCancellation(signal: AbortSignal | undefined): Cancellation {
	const state: Cancellation = { aborted: signal?.aborted === true, wait: undefined, notify: undefined, listener: undefined, signal };
	if (signal === undefined || state.aborted) return state;
	state.wait = new Promise<void>((resolve) => {
		state.notify = resolve;
	});
	state.listener = () => {
		state.aborted = true;
		state.notify?.();
	};
	signal.addEventListener("abort", state.listener, { once: true });
	return state;
}

function disposeCancellation(state: Cancellation): void {
	if (state.signal === undefined || state.listener === undefined) return;
	state.signal.removeEventListener("abort", state.listener);
	state.listener = undefined;
}

type CallOptionsRead = { readonly ok: true; readonly timeoutMs: number | undefined; readonly signal: AbortSignal | undefined } | { readonly ok: false };

/**
 * Read the caller's options. A nonsensical deadline is dropped (the transport's own default is a better
 * answer than an unhonourable one), while a value that is not an abort signal at all is refused: silently
 * ignoring a cancellation request would be the one failure mode the caller cannot see.
 */
function readCallOptions(value: unknown): CallOptionsRead {
	if (value === undefined) return { ok: true, timeoutMs: undefined, signal: undefined };
	if (!isRecord(value)) return { ok: false };
	const timeout = value.timeoutMs;
	const timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : undefined;
	const signal = value.signal;
	if (signal === undefined) return { ok: true, timeoutMs, signal: undefined };
	if (!isAbortSignalLike(signal)) return { ok: false };
	return { ok: true, timeoutMs, signal };
}

/** Structural check of the injected dependency, so a JS caller cannot wire the reader without a transport. */
function isRemoteWorkspacePort(value: unknown): value is RemoteWorkspacePort {
	if (!isRecord(value) || typeof value.request !== "function") return false;
	const cancel = value.cancel;
	return cancel === undefined || typeof cancel === "function";
}

function isRemoteWorkspaceReaderOptions(value: unknown): value is RemoteWorkspaceReaderOptions {
	if (!isRecord(value)) return false;
	if (!isRemoteWorkspacePort(value.port)) return false;
	const onDiagnostic = value.onDiagnostic;
	return onDiagnostic === undefined || typeof onDiagnostic === "function";
}

/** Diagnostic identity of one helper request: both fields are closed vocabulary, never user content. */
type CallSite = { readonly hostId: string; readonly method: string };

/** Everything one public method needs after its inputs were validated. */
type CallSetup = {
	readonly hostId: string;
	readonly path: string;
	readonly cancellation: Cancellation;
	readonly timeoutMs: number | undefined;
};

type SettledOutcome = { readonly kind: "value"; readonly value: unknown } | { readonly kind: "error"; readonly error: unknown };
type CallOutcome = SettledOutcome | { readonly kind: "cancelled" };

export function createRemoteWorkspaceReader(options: RemoteWorkspaceReaderOptions): RemoteWorkspaceReader {
	if (!isRemoteWorkspaceReaderOptions(options)) throw new Error(REMOTE_WORKSPACE_READER_CODES.optionsInvalid);
	const { request, cancel } = options.port;
	const onDiagnostic = options.onDiagnostic;

	/** Redacted, best-effort observability: a broken observer must never break a call or a settlement. */
	function diagnose(site: CallSite, code: string): void {
		if (onDiagnostic === undefined) return;
		// The stable-code invariant is enforced here rather than merely documented (the control client does the
		// same): a future call site must not be able to push free text into the diagnostic stream.
		if (!STABLE_CODE.test(code)) return;
		try {
			onDiagnostic({ hostId: site.hostId, method: site.method, code });
		} catch {
			// Diagnostics are an observer side channel; swallowing a broken observer keeps the protocol usable.
		}
	}

	/** Every refusal is reported exactly once, with the same stable code the caller receives. */
	function refuse(site: CallSite, code: string, retryable = false): RemoteWorkspaceError {
		diagnose(site, code);
		return new RemoteWorkspaceError(code, retryable);
	}

	/**
	 * Withdraw the helper request this reader walked away from. Two facts shape it:
	 *
	 * 1. It is best effort and deliberately *not* awaited. The helper's `cancel` only reaches work that has
	 *    not started, so an in-flight chunk keeps running remotely either way, and waiting for the cancel's
	 *    own answer could suspend the very promise that has to settle now.
	 * 2. Its answer is a diagnostic, never a rollback. `{cancelled:false, reason:"already-settled"}` means the
	 *    cancel did **not** take effect — the request had already started, already finished, or was never
	 *    queued, which is exactly what `RemoteControlClient.cancel` documents — so it says nothing about
	 *    whether the remote stopped. Reading it as a rolled-back write would be a lie the caller could act
	 *    on; the read is already settled as `REQUEST_CANCELLED`, and a late chunk answer is simply dropped by
	 *    the caller that no longer awaits it.
	 */
	function requestCancel(site: CallSite, requestId: string | undefined): void {
		// A transport that cannot name the request (or cannot cancel at all) leaves the abandonment local.
		if (requestId === undefined || cancel === undefined) return;
		diagnose(site, REMOTE_WORKSPACE_DIAGNOSTIC_CODES.cancelRequested);
		let answer: Promise<unknown>;
		try {
			answer = Promise.resolve(cancel(site.hostId, requestId));
		} catch {
			diagnose(site, REMOTE_WORKSPACE_DIAGNOSTIC_CODES.cancelFailed);
			return;
		}
		void answer.then(
			(value) => {
				// `cancelled:true` is the only answer that means the helper aborted the work; an unreadable
				// answer is treated like a refusal, because a withdraw that cannot be *shown* to have taken
				// effect must not be reported as one.
				if (!isRecord(value) || value.cancelled !== true) diagnose(site, REMOTE_WORKSPACE_DIAGNOSTIC_CODES.cancelRefused);
			},
			() => diagnose(site, REMOTE_WORKSPACE_DIAGNOSTIC_CODES.cancelFailed),
		);
	}

	/**
	 * One helper request. The abort state is checked *before* the request starts, so an abort guarantees that
	 * no further frame leaves this reader; the transport's id is captured while the frame is written, which is
	 * the only thing that makes a later withdraw nameable at all.
	 */
	async function callHelper(site: CallSite, params: unknown, cancellation: Cancellation, timeoutMs: number | undefined): Promise<unknown> {
		if (cancellation.aborted) throw refuse(site, "REQUEST_CANCELLED");
		let requestId: string | undefined;
		let started: Promise<unknown>;
		try {
			started = Promise.resolve(
				request(site.hostId, site.method, params, {
					...(timeoutMs === undefined ? {} : { timeoutMs }),
					onRequestId: (id) => {
						requestId = id;
					},
				}),
			);
		} catch (error) {
			// A transport that refuses synchronously is still one stable outcome, not a thrown surprise.
			started = Promise.reject(error);
		}
		const settled: Promise<SettledOutcome> = started.then(
			(value): SettledOutcome => ({ kind: "value", value }),
			(error: unknown): SettledOutcome => ({ kind: "error", error }),
		);
		const wait = cancellation.wait;
		let outcome: CallOutcome;
		if (wait === undefined) {
			outcome = await settled;
		} else {
			const aborted: Promise<CallOutcome> = wait.then((): CallOutcome => ({ kind: "cancelled" }));
			outcome = await Promise.race([settled, aborted]);
		}
		if (outcome.kind === "cancelled") {
			// The abandoned request keeps its own outcome (its frame is already on the wire); `settled` carries a
			// rejection handler, so a late refusal settles safely instead of becoming an unhandled rejection.
			requestCancel(site, requestId);
			throw refuse(site, "REQUEST_CANCELLED");
		}
		if (outcome.kind === "error") {
			const failure = readTransportFailure(outcome.error);
			throw refuse(site, failure.code, failure.retryable);
		}
		return outcome.value;
	}

	/**
	 * The diagnostic identity of one request. It is built per request rather than per call because a read
	 * sends both kinds: its sizing step fails as `fs.stat`, its chunks as `fs.read`, and a diagnostic that
	 * named the wrong one would send whoever reads it to the wrong method.
	 */
	function siteOf(setup: CallSetup, method: string): CallSite {
		return { hostId: setup.hostId, method };
	}

	/** `fs.stat` with the strict result check; the caller decides what the description means. */
	async function requestStat(setup: CallSetup): Promise<RemoteHelperStatResult> {
		const site = siteOf(setup, REMOTE_HELPER_METHOD_FS_STAT);
		const raw = await callHelper(site, { path: setup.path }, setup.cancellation, setup.timeoutMs);
		const stat = readStatResult(raw);
		if (stat === undefined) throw refuse(site, "PROTOCOL_INVALID");
		return stat;
	}

	/**
	 * `fs.list` answers in one frame, so the contract caps the entry count instead of paging it: past the cap
	 * the whole call is refused with `RESULT_TOO_LARGE`, exactly like the helper does, because a listing that
	 * silently stops at the cap looks complete.
	 */
	function readListResult(site: CallSite, value: unknown): RemoteHelperListResult {
		if (!isRecord(value) || !hasExactFields(value, LIST_FIELDS)) throw refuse(site, "PROTOCOL_INVALID");
		const entries = value.entries;
		if (!isUnknownArray(entries)) throw refuse(site, "PROTOCOL_INVALID");
		if (entries.length > REMOTE_HELPER_MAX_LIST_ENTRIES) throw refuse(site, "RESULT_TOO_LARGE");
		const validated: RemoteHelperListEntry[] = [];
		for (const entry of entries) {
			const read = readListEntry(entry);
			if (read === undefined) throw refuse(site, "PROTOCOL_INVALID");
			validated.push(read);
		}
		return { entries: validated };
	}

	/**
	 * Read one regular file under a single description of it.
	 *
	 * The order is the whole point: a helper's answer is not a snapshot, so the size that bounds the chunk
	 * requests is taken once, every chunk has to reproduce its own declared length, the assembled total has to
	 * reproduce that size, and the entry is described a second time at the end. A file that moved in between
	 * is refused as `REMOTE_WORKSPACE_FILE_CHANGED` instead of being returned as a coherent version of
	 * itself — a read that silently mixes two versions is worse than no read at all. The closing stat is sent
	 * for every read, including an empty one, because "nothing changed" is the one thing that makes the
	 * assembled bytes a version of the file rather than a collection of answers.
	 */
	async function readRegularFile(setup: CallSetup): Promise<RemoteWorkspaceFile> {
		const { path, cancellation, timeoutMs } = setup;
		const site = siteOf(setup, REMOTE_HELPER_METHOD_FS_READ);
		const before = await requestStat(setup);
		// A directory, a symlink or anything else that is not a regular file is refused before the first chunk:
		// the sizing `fs.stat` classifies with lstat semantics, so a link is `other` here, and the helper does
		// not resolve a link for a read either (its `fs.read` refuses any link in the path as `NOT_A_FILE`).
		// Nothing below follows one: a link's target is only read when the caller names the resolved path.
		if (before.kind !== "file") throw refuse(site, "NOT_A_FILE");
		if (before.bytes > REMOTE_WORKSPACE_MAX_READ_BYTES) throw refuse(site, "RESULT_TOO_LARGE");
		const total = before.bytes;
		// One allocation bounded by the local ceiling; `bytes <= wanted <= total - offset` is checked per chunk,
		// so the copy can never run past the end of it.
		const content = Buffer.alloc(total);
		let offset = 0;
		let chunks = 0;
		// A file with no bytes is already at its end: the helper answers `bytes: 0, eof: false` to a zero-byte
		// *request*, so a completed range is never requested at all (it would carry nothing and never end).
		let reachedEof = total === 0;
		while (!reachedEof && offset < total) {
			if (chunks >= REMOTE_WORKSPACE_MAX_READ_CHUNKS) throw refuse(site, "RESULT_TOO_LARGE");
			const wanted = Math.min(REMOTE_HELPER_MAX_CHUNK_BYTES, total - offset);
			const raw = await callHelper(site, { path, offset, bytes: wanted }, cancellation, timeoutMs);
			const chunk = readChunkResult(raw, wanted);
			if (chunk === undefined) throw refuse(site, "PROTOCOL_INVALID");
			chunk.decoded.copy(content, offset);
			offset += chunk.decoded.length;
			chunks += 1;
			reachedEof = chunk.eof;
		}
		// A failure of the closing stat is relayed as itself — a file deleted under the reader is
		// `PATH_NOT_FOUND`, which is more truthful than anything this module could invent for it.
		const after = await requestStat(setup);
		if (after.kind !== before.kind || after.bytes !== before.bytes || after.mtimeMs !== before.mtimeMs) throw refuse(site, REMOTE_WORKSPACE_READER_CODES.fileChanged);
		// The entry itself says it did not move, so a short or over-long answer can only be the remote
		// contradicting the size it declared: the chunks have to add up to that size, and the loop may only end
		// because the remote said so.
		if (offset !== total || !reachedEof) throw refuse(site, "PROTOCOL_INVALID");
		return { content, bytes: offset, mtimeMs: before.mtimeMs };
	}

	/**
	 * 读 `readHead` 的 `maxBytes`：非正整数（含 undefined/NaN/小数）是 `PROTOCOL_INVALID`，
	 * 超过本地 64 KiB 上限是 `RESULT_TOO_LARGE`。**拒绝而不是 clamp**：把 128 KiB 的请求悄悄截成 64 KiB
	 * 会让调用方以为自己拿到了一整段，而它其实只是被本地上限切过的一截。
	 */
	function readHeadLimit(value: unknown): { readonly ok: true; readonly maxBytes: number } | { readonly ok: false; readonly code: string } {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return { ok: false, code: "PROTOCOL_INVALID" };
		if (value > REMOTE_WORKSPACE_MAX_HEAD_BYTES) return { ok: false, code: "RESULT_TOO_LARGE" };
		return { ok: true, maxBytes: value };
	}

	/**
	 * 读 `readWindow` 的入参：offset 必须是非负安全整数，maxBytes 必须是 1..REMOTE_WORKSPACE_MAX_WINDOW_BYTES
	 * 的整数（越界 `RESULT_TOO_LARGE`），可选 size 必须是非负安全整数。非法值一律在发帧前拒绝。
	 */
	function readWindowSpec(value: unknown): { readonly ok: true; readonly offset: number; readonly maxBytes: number; readonly size: number | undefined } | { readonly ok: false; readonly code: string } {
		if (!isRecord(value)) return { ok: false, code: "PROTOCOL_INVALID" };
		const offset = value.offset;
		if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return { ok: false, code: "PROTOCOL_INVALID" };
		const maxBytes = value.maxBytes;
		if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return { ok: false, code: "PROTOCOL_INVALID" };
		if (maxBytes > REMOTE_WORKSPACE_MAX_WINDOW_BYTES) return { ok: false, code: "RESULT_TOO_LARGE" };
		const size = value.size;
		if (size === undefined) return { ok: true, offset, maxBytes, size: undefined };
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return { ok: false, code: "PROTOCOL_INVALID" };
		return { ok: true, offset, maxBytes, size };
	}

	/**
	 * 有界范围读取的共用内核（head 与 window 同一条纪律）：从 `offset` 起最多读 `wanted` 字节。
	 *
	 * 请求只落在 `[offset, offset + wanted)` 内，按契约分块大小切分并受 `chunksAllowed` 上界约束，
	 * 所以**任何情况下都不会整文件读**；`wanted = 0`（空文件 / 起点已在文件尾）不发任何读帧。
	 * 每个分块的形状由 `readChunkResult` 逐字段校验（含「短块必须声明到头」这一条）。
	 */
	async function readRangeChunks(setup: CallSetup, site: CallSite, offset: number, wanted: number, chunksAllowed: number): Promise<{ readonly content: Buffer; readonly bytes: number; readonly reachedEof: boolean }> {
		const { path, cancellation, timeoutMs } = setup;
		const content = Buffer.alloc(wanted);
		let read = 0;
		let chunks = 0;
		let reachedEof = wanted === 0;
		while (!reachedEof && read < wanted) {
			if (chunks >= chunksAllowed) throw refuse(site, "RESULT_TOO_LARGE");
			const ask = Math.min(REMOTE_HELPER_MAX_CHUNK_BYTES, wanted - read);
			const raw = await callHelper(site, { path, offset: offset + read, bytes: ask }, cancellation, timeoutMs);
			const chunk = readChunkResult(raw, ask);
			if (chunk === undefined) throw refuse(site, "PROTOCOL_INVALID");
			chunk.decoded.copy(content, read);
			read += chunk.decoded.length;
			chunks += 1;
			reachedEof = chunk.eof;
		}
		return { content, bytes: read, reachedEof };
	}

	/**
	 * 有界读取一个普通文件的前缀（G3 冻结设计第 6 条，I1 之后由 readRangeChunks 承载）。
	 *
	 * 只发 `min(size, maxBytes)` 这一个（正常情况下也正是唯一一个）`fs.read`：先 sizing `fs.stat`
	 * 拿到 kind/size，非普通文件在第一个字节之前就被拒（`NOT_A_FILE`），因此**任何情况下都不会整文件读**。
	 * 空文件不发读请求（helper 对零字节请求答 `bytes:0, eof:false`，发了也永远读不到 eof）。
	 *
	 * 这里**刻意不做收尾 stat**，与 `readFile` 的 commit point 不同：head 的语义是「前缀」，
	 * 一次 append 不会让已经拿到的前缀变成另一份内容；而活跃写入的会话 JSONL 几乎必然 mtime 变化，
	 * 用 `REMOTE_WORKSPACE_FILE_CHANGED` 拒绝会让「按需解析文件头」频繁失败。兜底改由尺寸自洽承担：
	 * 请求字节数由 sizing stat 决定，所以「拿到的字节数必须逐字等于它」且「eof 必须等于 size <= maxBytes」——
	 * 文件缩小、内容被换掉或对端答非所问都会在这里被拒（`PROTOCOL_INVALID`）。
	 */
	async function readHeadRegularFile(setup: CallSetup, maxBytes: number): Promise<RemoteWorkspaceHead> {
		const site = siteOf(setup, REMOTE_HELPER_METHOD_FS_READ);
		const before = await requestStat(setup);
		if (before.kind !== "file") throw refuse(site, "NOT_A_FILE");
		const total = before.bytes;
		const wantedTotal = Math.min(total, maxBytes);
		const range = await readRangeChunks(setup, site, 0, wantedTotal, REMOTE_WORKSPACE_MAX_HEAD_CHUNKS);
		if (range.bytes !== wantedTotal || range.reachedEof !== total <= maxBytes) throw refuse(site, "PROTOCOL_INVALID");
		return { content: range.content, bytes: range.bytes, truncated: total > maxBytes, size: total, mtimeMs: before.mtimeMs };
	}

	/**
	 * 有界读取一个普通文件的任意窗口（I1）。语义与 readHead 同级，只有起点不同。
	 *
	 * - `size` 未给：本原语自己发一次 sizing `fs.stat`（并据此拒绝非普通文件）。
	 * - `size` 已给：调用方刚在头读里 stat 过，直接复用它——于是「头 + 尾」的标题解析全程只有 1 次 stat。
	 *   代价是这一步不重新确认 kind：文件在两次窗口之间被换成目录/符号链接时，helper 的 `fs.read`
	 *   会以自己的 `NOT_A_FILE` 拒绝，仍然 fail closed。
	 * - `offset` 超过文件尾 ⇒ 空窗口（`bytes: 0`，不发读帧），因为「那里没有内容」就是真话。
	 * - **不校验 eof**：窗口期间文件可能被 append，helper 会如实答 `eof:false`，把它当矛盾会误报；
	 *   兜底改为「拿到的字节数必须逐字等于请求范围」——文件缩小或对端违约都会在这里被拒（`PROTOCOL_INVALID`）。
	 */
	async function readWindowRegularFile(setup: CallSetup, spec: { readonly offset: number; readonly maxBytes: number; readonly size: number | undefined }): Promise<RemoteWorkspaceWindow> {
		const site = siteOf(setup, REMOTE_HELPER_METHOD_FS_READ);
		let size: number;
		if (spec.size === undefined) {
			const before = await requestStat(setup);
			if (before.kind !== "file") throw refuse(site, "NOT_A_FILE");
			size = before.bytes;
		} else {
			size = spec.size;
		}
		const offset = Math.min(spec.offset, size);
		const wanted = Math.min(offset + spec.maxBytes, size) - offset;
		const range = await readRangeChunks(setup, site, offset, wanted, REMOTE_WORKSPACE_MAX_WINDOW_CHUNKS);
		if (range.bytes !== wanted) throw refuse(site, "PROTOCOL_INVALID");
		return { content: range.content, bytes: range.bytes, offset, size, truncated: offset + range.bytes < size };
	}

	/** Validate the call, keep the path it resolved to and register its cancellation listener. */
	function beginCall(hostId: unknown, path: unknown, options: unknown): CallSetup | undefined {
		const host = readHostId(hostId);
		const target = readRequestPath(path);
		const read = readCallOptions(options);
		if (host === undefined || target === undefined || !read.ok) return undefined;
		return { hostId: host, path: target, cancellation: createCancellation(read.signal), timeoutMs: read.timeoutMs };
	}

	return {
		async stat(hostId, path, options) {
			const setup = beginCall(hostId, path, options);
			// Nothing is reported for an invalid call: the values that failed validation are exactly the ones
			// that must not reach a diagnostic (a host id or a path a caller got wrong may be a secret).
			if (setup === undefined) throw new RemoteWorkspaceError("PROTOCOL_INVALID", false);
			try {
				return await requestStat(setup);
			} finally {
				disposeCancellation(setup.cancellation);
			}
		},
		async list(hostId, path, options) {
			const setup = beginCall(hostId, path, options);
			if (setup === undefined) throw new RemoteWorkspaceError("PROTOCOL_INVALID", false);
			try {
				const site = siteOf(setup, REMOTE_HELPER_METHOD_FS_LIST);
				const raw = await callHelper(site, { path: setup.path }, setup.cancellation, setup.timeoutMs);
				return readListResult(site, raw);
			} finally {
				disposeCancellation(setup.cancellation);
			}
		},
		async readFile(hostId, path, options) {
			const setup = beginCall(hostId, path, options);
			if (setup === undefined) throw new RemoteWorkspaceError("PROTOCOL_INVALID", false);
			try {
				return await readRegularFile(setup);
			} finally {
				disposeCancellation(setup.cancellation);
			}
		},
		async readHead(hostId, path, maxBytes, options) {
			// 上限校验先于 beginCall：非法调用不应该先注册一个取消监听再抛出去。
			const limit = readHeadLimit(maxBytes);
			if (!limit.ok) throw new RemoteWorkspaceError(limit.code, false);
			const setup = beginCall(hostId, path, options);
			if (setup === undefined) throw new RemoteWorkspaceError("PROTOCOL_INVALID", false);
			try {
				return await readHeadRegularFile(setup, limit.maxBytes);
			} finally {
				disposeCancellation(setup.cancellation);
			}
		},
		async readWindow(hostId, path, window, options) {
			const spec = readWindowSpec(window);
			if (!spec.ok) throw new RemoteWorkspaceError(spec.code, false);
			const setup = beginCall(hostId, path, options);
			if (setup === undefined) throw new RemoteWorkspaceError("PROTOCOL_INVALID", false);
			try {
				return await readWindowRegularFile(setup, { offset: spec.offset, maxBytes: spec.maxBytes, size: spec.size });
			} finally {
				disposeCancellation(setup.cancellation);
			}
		},
	};
}
