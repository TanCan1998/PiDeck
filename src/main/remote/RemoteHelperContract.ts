/**
 * Shared vocabulary for the remote helper protocol (plan §7) and the bootstrap contract (§168).
 * Types and limits only — parsing, framing and validation live in the modules that own them, so this
 * file stays the single place both sides agree on.
 *
 * The read-only workspace batch (`fs.stat`, `fs.list`, `fs.read`, `fs.searchNames`) is declared here in the same spirit:
 * the method name, the exact result fields and every bound are literals in this file, and the frozen
 * helper body — which cannot import anything — repeats those literals under test (§7.1). A result shape
 * that is not stated here is not part of the protocol, and a bound that is not stated here is not
 * enforced on both sides.
 */

/** Wire protocol version. A helper with a different version must not be used (structured refusal). */
export const REMOTE_HELPER_PROTOCOL_VERSION = 1;

/** One NDJSON frame, UTF-8 encoded. Anything larger is a protocol error, never a truncation. */
export const REMOTE_HELPER_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Field bounds both sides enforce. A mismatch turns a rejection into a silent timeout. */
export const REMOTE_HELPER_MAX_HOST_ID_LENGTH = 64;
export const REMOTE_HELPER_MAX_ID_LENGTH = 128;
export const REMOTE_HELPER_MAX_METHOD_LENGTH = 64;
export const REMOTE_HELPER_MAX_ECHO_TEXT_LENGTH = 4096;
/** Ceiling for the assembled remote command: the producer must not emit what the argv boundary refuses. */
export const REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH = 8192;
/**
 * File bodies travel in chunks; the base64 form still has to fit the frame limit. One chunk is 1 MiB of
 * bytes, which base64-encodes to at most `4 * ceil(1048576 / 3) = 1398104` characters: with the frame
 * fields and a 128 character request id the worst-case `fs.read` line is under 1.4 MB, so the chunk
 * ceiling sits an order of magnitude below REMOTE_HELPER_MAX_FRAME_BYTES and the frame cap stays what it
 * is — a fatal ingest bound, not the limit a normal answer is sized against.
 */
export const REMOTE_HELPER_MAX_CHUNK_BYTES = 1024 * 1024;
/** Bounded concurrency: long transfers must not head-of-line block short requests. */
export const REMOTE_HELPER_MAX_CONCURRENT_REQUESTS = 4;
export const REMOTE_HELPER_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Stable helper error codes. Free text never travels as a code (diagnostics stay redacted).
 *
 * The filesystem half of the list is a closed set on purpose: one code per condition the caller can act
 * on, and `IO_ERROR` for every errno nobody predicted, so a raw platform code or message is never
 * relayed. `PATH_OUTSIDE_ROOT` is a refusal before the operation (nothing outside the root is opened) and
 * is also the answer of every filesystem method in a host-only session, which is a helper started without
 * a `--root` at all: that is a legal state, not a misconfiguration, because probing and the handshake need
 * no file access. `RESULT_TOO_LARGE` is a bounded result that is refused instead of truncated, `ROOT_INVALID`
 * is the fatal startup answer of a helper whose `--root` argument is present but unusable (empty, relative,
 * `/`, not a directory or unreadable), and `NOT_A_FILE` covers both a directory and a non-regular entry
 * handed to `fs.read`. `QUERY_INVALID` is `fs.searchNames`' own refusal for a search term that is absent,
 * empty, longer than REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH or carrying a control byte: the term is checked
 * before any filesystem access, the way a path is, so an unusable query never becomes a partial walk.
 */
export const REMOTE_HELPER_ERROR_CODES = [
	"METHOD_NOT_FOUND",
	"REQUEST_CANCELLED",
	"REQUEST_TIMEOUT",
	"RESULT_TOO_LARGE",
	"PATH_OUTSIDE_ROOT",
	"PATH_NOT_FOUND",
	"NOT_A_DIRECTORY",
	"NOT_A_FILE",
	"QUERY_INVALID",
	"PERMISSION_DENIED",
	"IO_ERROR",
	"ROOT_INVALID",
	"PROTOCOL_INVALID",
	"HELPER_INTERNAL",
	"REMOTE_CONNECTION_LOST",
	"TOO_MANY_REQUESTS",
	"GIT_NOT_FOUND",
	"GIT_VERSION_UNSUPPORTED",
	"GIT_NOT_REPOSITORY",
	"GIT_UNSUPPORTED_REPOSITORY",
	"GIT_PLATFORM_UNSUPPORTED",
	"GIT_CONFIG_UNSUPPORTED",
	"GIT_COMMAND_FAILED",
	"GIT_RESULT_INVALID",
	"GIT_RESOURCE_CHANGED",
	"GIT_NOT_TEXT",
	"GIT_INDEX_LOCKED",
	"GIT_WRITE_UNSUPPORTED",
	"GIT_WRITE_RESULT_UNCONFIRMED",
	"GIT_COMMIT_NOTHING_STAGED",
	"GIT_COMMIT_MESSAGE_EMPTY",
	"GIT_COMMIT_IDENTITY_REQUIRED",
	"GIT_COMMIT_HEAD_CHANGED",
	"GIT_OBJECT_NOT_FOUND",
	"GIT_REF_EXISTS",
	"GIT_REF_NOT_FOUND",
	"GIT_SWITCH_CONFLICT",
	"GIT_RESTORE_CONFLICT",
	"GIT_RECOVERY_ENTRY_NOT_FOUND",
] as const;
export type RemoteHelperErrorCode = (typeof REMOTE_HELPER_ERROR_CODES)[number];

/** `hello` and `cancel` are mandatory; only optional behaviour is negotiated through capabilities. */
export const REMOTE_HELPER_METHOD_HELLO = "hello";
export const REMOTE_HELPER_METHOD_ECHO = "echo";
export const REMOTE_HELPER_METHOD_CANCEL = "cancel";
/** Read-only workspace methods: the first batch of helpers that actually touches the remote filesystem. */
export const REMOTE_HELPER_METHOD_FS_STAT = "fs.stat";
export const REMOTE_HELPER_METHOD_FS_LIST = "fs.list";
export const REMOTE_HELPER_METHOD_FS_READ = "fs.read";
/**
 * `fs.list`'s recursive cousin: one bounded walk below a request path, answering the entries whose
 * basename contains a query. It is the one read-only method that is not a single filesystem call, so it
 * holds a concurrency slot and can be cancelled while it runs (the other three run inline in dispatch).
 */
export const REMOTE_HELPER_METHOD_FS_SEARCH_NAMES = "fs.searchNames";
/** Optional read-only Git methods; they share the helper concurrency/cancellation lifecycle. */
export const REMOTE_HELPER_METHOD_GIT_STATUS = "git.status";
export const REMOTE_HELPER_METHOD_GIT_WORKSPACE_DIFF = "git.workspaceDiff";
export const REMOTE_GIT_STATUS_MAX_BYTES = 1024 * 1024;
export const REMOTE_GIT_MAX_RESOURCES = 4096;
export const REMOTE_GIT_TEXT_MAX_BYTES = 256 * 1024;
export const REMOTE_GIT_STDERR_MAX_BYTES = 64 * 1024;
export const REMOTE_GIT_INDEX_MAX_BYTES = 16 * 1024 * 1024;
export const REMOTE_GIT_METADATA_MAX_ENTRIES = 20_000;
export const REMOTE_GIT_METADATA_MAX_DEPTH = 32;
export const REMOTE_GIT_READ_TIMEOUT_MS = 30_000;

export type RemoteGitStatusResult = { status: string; head: string | null; branch: string | null; revision?: string };

/**
 * Read-only history batch (G3a): log, one commit's detail, local refs and one file's two sides between
 * two revisions. Every list is bounded and refused rather than truncated, and no method touches the network,
 * the index or the working tree. Refs are returned as opaque OIDs: nothing here interprets a branch name.
 */
export const REMOTE_GIT_LOG_MAX_COUNT = 100;
/** One page's default when the caller omits `maxCount`; still a literal on both sides. */
export const REMOTE_GIT_LOG_DEFAULT_COUNT = 50;
export const REMOTE_GIT_LOG_MAX_SKIP = 100_000;
export const REMOTE_GIT_REF_MAX_COUNT = 512;
export const REMOTE_GIT_REF_MAX_NAME_BYTES = 1024;
export const REMOTE_GIT_COMMIT_MAX_FILES = 512;
/** The detail message read back from history; distinct from the 4 KiB commit input bound on purpose. */
export const REMOTE_GIT_DETAIL_MESSAGE_MAX_BYTES = 64 * 1024;
export const REMOTE_GIT_IDENTITY_MAX_BYTES = 320;
export const REMOTE_GIT_SUBJECT_MAX_BYTES = 1024;
export const REMOTE_GIT_LOG_MAX_PARENTS = 8;
/**
 * G3b branch write face: a name that `git check-ref-format --branch` accepts, minus `@` (which that command
 * happens to allow) and any control character. Branch names travel as names, never as full refs or object ids.
 */
export const REMOTE_GIT_BRANCH_NAME_MAX_BYTES = 1024;
/**
 * G4a recoverable discard: before a working-tree change is thrown away or an untracked file is removed, its raw
 * bytes go into the repository's own object store behind a `refs/pideck/recovery/<stamp>` ref. A snapshot larger
 * than this bound is refused instead of being copied, and nothing prunes these refs automatically: the user deletes
 * one with `git update-ref -d <ref>` when they no longer need it.
 */
export const REMOTE_GIT_DISCARD_MAX_BYTES = 8 * 1024 * 1024;
/** Listing bound for the recovery namespace: past it the list is labelled truncated instead of refused. */
export const REMOTE_GIT_RECOVERY_MAX_ENTRIES = 64;
export const REMOTE_HELPER_METHOD_GIT_RECOVERY_LIST = "git.recoveryList";
export const REMOTE_HELPER_METHOD_GIT_RECOVERY_RESTORE = "git.recoveryRestore";
export const REMOTE_HELPER_METHOD_GIT_RECOVERY_DROP = "git.recoveryDrop";
/** One snapshot as the panel sees it: where it came from, how big it is and when it was taken. */
export type RemoteGitRecoveryEntry = { ref: string; oid: string; path: string; bytes: number; at: number };
export type RemoteGitRecoveryListResult = { entries: readonly RemoteGitRecoveryEntry[]; truncated: boolean };
export type RemoteGitRecoveryRestoreParams = { ref: string; oid: string; path: string };
export type RemoteGitRecoveryRestoreResult = { applied: true; path: string; bytes: number };
export type RemoteGitRecoveryDropParams = { ref: string; oid: string };
export type RemoteGitRecoveryDropResult = { applied: true };
export const REMOTE_GIT_RECOVERY_REF_PREFIX = "refs/pideck/recovery/";
/** Fixed author identity of a recovery commit: PiDeck's own journal entry, never the user's Git configuration. */
export const REMOTE_GIT_RECOVERY_IDENTITY = { name: "PiDeck recovery", email: "pideck-recovery@localhost" } as const;
export const REMOTE_HELPER_METHOD_GIT_DISCARD = "git.discard";
export type RemoteGitDiscardParams = { path: string; group: "workingTree" | "untracked"; expectedRevision: string };
/**
 * `mode` says what happened to the file: restored to the staged version, or removed from the working tree.
 * `recoveryRef` is null only when the discarded change itself was the deletion of the file (a " D" resource):
 * there are no bytes to preserve, and restoring reads the already durable staged version.
 */
export type RemoteGitDiscardResult = { applied: true; recoveryRef: string | null; path: string; mode: "restored" | "removed" };
export const REMOTE_HELPER_METHOD_GIT_CREATE_BRANCH = "git.createBranch";
export const REMOTE_HELPER_METHOD_GIT_SWITCH_BRANCH = "git.switchBranch";
/** `expectedHead: null` means the repository is unborn; the branch is created at the confirmed HEAD otherwise. */
export type RemoteGitCreateBranchParams = { name: string; expectedHead: string | null };
export type RemoteGitCreateBranchResult = { applied: true; branch: string };
/** Switching only ever names an existing local branch; a conflicting worktree is refused, never forced. */
export type RemoteGitSwitchBranchParams = { name: string; expectedHead: string | null };
export type RemoteGitSwitchBranchResult = { applied: true; branch: string; head: string | null };

/** One history row; `parents` is bounded and `subject` is the first line only. */
export type RemoteGitLogEntry = { oid: string; parents: readonly string[]; authorName: string; authorEmail: string; authorTimeSec: number; subject: string };
export type RemoteGitLogParams = { maxCount?: number; skip?: number };
export type RemoteGitLogResult = { commits: readonly RemoteGitLogEntry[]; hasMore: boolean };
/** The commit's full message and its changed files against its first parent (a root commit lists all files). */
export type RemoteGitCommitDetailParams = { oid: string };
export type RemoteGitCommitFile = { status: string; path: string; oldPath?: string };
export type RemoteGitCommitDetailResult = {
	oid: string;
	parents: readonly string[];
	authorName: string;
	authorEmail: string;
	authorTimeSec: number;
	committerName: string;
	committerEmail: string;
	committerTimeSec: number;
	subject: string;
	message: string;
	files: readonly RemoteGitCommitFile[];
};
export type RemoteGitRefsParams = Record<string, never>;
/** Local branches and tags only: remote-tracking refs would imply sync state this batch does not deliver. */
export type RemoteGitRefEntry = { fullName: string; name: string; oid: string; kind: "branch" | "tag" };
export type RemoteGitRefsResult = { head: string | null; branch: string | null; refs: readonly RemoteGitRefEntry[] };
/** `base: null` means the file has no other side (root commit, or a file added by this commit). */
export type RemoteGitRefFileDiffParams = { base: string | null; head: string; path: string };
export type RemoteGitRefFileDiffResult = { originalContent: string; modifiedContent: string };
/** Managed single-resource index mutations. The expectation is main-owned, never renderer authority. */
export type RemoteGitMutationParams = { path: string; group: "index" | "workingTree" | "untracked"; expectedRevision: string };
export type RemoteGitMutationResult = { applied: true };
/**
 * Managed commit: the tree comes from the verified index, the ref move is a native compare-and-swap.
 * `message` is sent verbatim (no Git comment stripping) and bounded by REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES.
 * `expectedRevision` is the same main-owned fingerprint the index mutations use, so the commit can only
 * ever contain what the user confirmed.
 */
export type RemoteGitCommitParams = { message: string; expectedRevision: string };
/** `head`/`tree` are the committed objects; both are read back from the repository after the CAS. */
export type RemoteGitCommitResult = { applied: true; head: string; tree: string };
export const REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES = 4096;
export type RemoteGitWorkspaceDiffParams = { group: "merge" | "index" | "workingTree" | "untracked"; path: string };
export type RemoteGitWorkspaceDiffResult = { originalContent: string; modifiedContent: string };

export const REMOTE_HELPER_CAPABILITIES = ["echo", "fs.stat", "fs.list", "fs.read", "fs.searchNames", "git.status", "git.workspaceDiff", "git.stage", "git.unstage", "git.commit", "git.log", "git.commitDetail", "git.refs", "git.refFileDiff", "git.createBranch", "git.switchBranch", "git.discard", "git.recoveryList", "git.recoveryRestore", "git.recoveryDrop"] as const;
export type RemoteHelperCapability = (typeof REMOTE_HELPER_CAPABILITIES)[number];
/**
 * Ceiling for one requested relative path. It is applied to the raw string before any filesystem access,
 * so an over-long path is a PROTOCOL_INVALID refusal rather than an ENAMETOOLONG round trip.
 */
export const REMOTE_HELPER_MAX_PATH_LENGTH = 4096;
/**
 * `fs.list` answers in one frame, so the entry count is capped instead of paged: past the cap the whole
 * call is refused with RESULT_TOO_LARGE, never truncated into a listing that silently looks complete.
 * 4096 entries of at most 255 byte names stay below the 8 MiB frame cap with room to spare.
 */
export const REMOTE_HELPER_MAX_LIST_ENTRIES = 4096;
/**
 * Hard ceilings for `fs.searchNames`, all of them enforced inside the frozen helper. At most 512 matches
 * are answered, at most 20000 directory entries are visited, and no entry deeper than 12 path segments
 * below the request path is reached (the request path itself is depth 0, a file directly inside it depth
 * 1). Reaching any of them stops the walk *at that entry* and answers `truncated: true`, so a bounded
 * answer is a deterministic prefix instead of a listing that quietly looks complete. The walk is
 * breadth first and visits each directory's entries in name order, so one directory is read (bounded by the
 * entry ceiling) before any of its entries is visited: that ceiling is also the work bound of a call. 512 entries of at
 * most 255 byte names stay far below the 8 MiB frame cap with room to spare.
 */
export const REMOTE_HELPER_MAX_SEARCH_MATCHES = 512;
export const REMOTE_HELPER_MAX_SEARCH_SCANNED = 20000;
export const REMOTE_HELPER_MAX_SEARCH_DEPTH = 12;
/** Query ceiling for `fs.searchNames`, counted in characters and checked before any filesystem access. */
export const REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH = 128;
/** Bounded concurrency plus a bounded waiting room: past both, a request is refused, never buffered. */
export const REMOTE_HELPER_MAX_QUEUED_REQUESTS = 64;
/**
 * Upper bound for the optional delay of `echo`. The delay exists so a connection self-test can hold a
 * few requests open and observe the concurrency bound instead of only the steady state.
 */
export const REMOTE_HELPER_MAX_ECHO_DELAY_MS = 5_000;

export type RemoteHelperHelloResult = RemoteHelperHandshake & { helperVersion: string; nodeVersion: string; pid: number };

export type RemoteHelperRequestFrame = {
	v: number;
	hostId: string;
	generation: number;
	id: string;
	method: string;
	timeoutMs?: number;
	params?: unknown;
};

export type RemoteHelperErrorBody = {
	code: string;
	message?: string;
	retryable?: boolean;
};

export type RemoteHelperResponseFrame = {
	v: number;
	hostId: string;
	generation: number;
	id: string;
	ok: boolean;
	result?: unknown;
	error?: RemoteHelperErrorBody;
};

/** Cancel is a first-class request: it carries its own id and names the target request. */
export type RemoteHelperCancelParams = { requestId: string };
export type RemoteHelperCancelResult = { cancelled: boolean; reason?: "already-settled" | "commit-started" };

/**
 * How an entry is classified by `fs.stat` and by every `fs.list` entry. `other` is everything that is not
 * a regular file or a directory — a symlink above all: both methods answer with lstat semantics, so a link
 * is never followed for the classification and its target's size is never reported as its own.
 */
export type RemoteHelperPathKind = "file" | "directory" | "other";

/**
 * `path` is a relative POSIX path inside the helper's root; an absolute path, a backslash, a drive
 * prefix, a percent-encoded separator or dot, and any `..` segment are refused as PATH_OUTSIDE_ROOT
 * before the filesystem is touched, and so is a path whose resolved form leaves the root (a symlink that
 * points outside included). `.` names the root itself.
 */
export type RemoteHelperStatParams = { path: string };
/** `bytes` is the entry's own size (the link's size for a symlink) and `mtimeMs` its modification time. */
export type RemoteHelperStatResult = { kind: RemoteHelperPathKind; bytes: number; mtimeMs: number };

export type RemoteHelperListParams = { path: string };
/** `bytes` is present for regular files only; a symlink is `other` and is never followed. */
export type RemoteHelperListEntry = { name: string; kind: RemoteHelperPathKind; bytes?: number };
/** Entries are sorted by name in code-unit order and capped by REMOTE_HELPER_MAX_LIST_ENTRIES. */
export type RemoteHelperListResult = { entries: readonly RemoteHelperListEntry[] };

/**
 * `path` names the directory to walk and is checked exactly as `fs.list` checks one. `query` is matched
 * against each entry's basename, case-insensitively, and directory names take part in the match.
 * `maxMatches` is optional and is *clamped* by the helper to 1..REMOTE_HELPER_MAX_SEARCH_MATCHES (absent
 * means that ceiling); a value that is not a safe integer is refused as PROTOCOL_INVALID.
 */
export type RemoteHelperSearchParams = { path: string; query: string; maxMatches?: number };
/**
 * `path` is the entry's relative POSIX path inside the root (never absolute, never the root itself),
 * `name` its basename and `kind` its own classification — a symlink is `other` and is never followed.
 * `bytes` is present for regular files only. Entries are sorted by `path` in code-unit order.
 */
export type RemoteHelperSearchEntry = { path: string; name: string; kind: RemoteHelperPathKind; bytes?: number };
/**
 * `scanned` counts every entry the walk visited, matching or not, so it is always at least
 * `entries.length` and never above REMOTE_HELPER_MAX_SEARCH_SCANNED; `truncated` says that one of the
 * three ceilings stopped the walk, which is the only case in which the answer is not the whole tree.
 */
export type RemoteHelperSearchResult = { entries: readonly RemoteHelperSearchEntry[]; scanned: number; truncated: boolean };

/**
 * `offset` and `bytes` are safe non-negative integers; `bytes` is at most REMOTE_HELPER_MAX_CHUNK_BYTES,
 * so exactly one frame is needed per chunk and a longer request is refused (PROTOCOL_INVALID) rather than
 * silently shortened.
 */
export type RemoteHelperReadParams = { path: string; offset: number; bytes: number };
/**
 * `chunk` is base64 of the bytes that were actually read, `bytes` their count (0 at or past EOF) and `eof`
 * the fact that this chunk reached the size observed while reading — a client reads until `eof` instead of
 * trusting a total from an earlier `fs.stat`, because the file may change between the two calls.
 */
export type RemoteHelperReadResult = { chunk: string; bytes: number; eof: boolean };

/** Staged-connection phases a bootstrap run walks through (plan §11.1 test-connection stages). */
export type RemoteHelperHandshake = {
	protocolVersion: number;
	platform: string;
	arch: string;
	home: string;
	/**
	 * The canonical directory the helper confined itself to, or null for a host-only session.
	 *
	 * Reported because main cannot otherwise prove that the `--root` it asked for is the one that took
	 * effect: the helper resolves symlinks once at startup, so a root that is itself a link (or points
	 * through one) would otherwise leave the confined boundary different from the path the user confirmed.
	 * With this the confirmation is checkable instead of assumed.
	 */
	root: string | null;
	capabilities: readonly string[];
};

/** Bootstrap manifest entry: one immutable file of the uploaded bundle (§168). */
export type RemoteBundleFile = { name: string; sha256: string; bytes: number };

export type RemoteBundleManifest = {
	schemaVersion: number;
	bundleSha256: string;
	files: readonly RemoteBundleFile[];
};

export const REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION = 1;
/** Deployment roots and per-file caps stay explicit so a manifest cannot smuggle an unbounded set. */
export const REMOTE_BUNDLE_MAX_FILES = 256;
export const REMOTE_BUNDLE_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const REMOTE_BUNDLE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Bootstrap staging-session frames (plan §168). The frozen entry caps an inbound line at 4096 bytes,
 * so the manifest travels as one small frame per file instead of a single document.
 */
export const REMOTE_BOOTSTRAP_PROTOCOL_VERSION = 1;
export const REMOTE_BOOTSTRAP_MAX_FRAME_BYTES = 4096;
/** Immutable, content-addressed activation target: `<deployRoot>/bundles/<bundleSha256>`. */
export const REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME = "bundles";
/** File modes the entry accepts: regular files 0600, executables 0700. */
export const REMOTE_BOOTSTRAP_FILE_MODES = ["0600", "0700"] as const;
export type RemoteBootstrapFileMode = (typeof REMOTE_BOOTSTRAP_FILE_MODES)[number];

export type RemoteBootstrapFinalizeBeginFrame = { v: 1; op: "finalize-begin"; files: number; bundleSha256: string };
export type RemoteBootstrapFinalizeFileFrame = { v: 1; op: "finalize-file"; name: string; sha256: string; bytes: number; mode: RemoteBootstrapFileMode };
export type RemoteBootstrapFinalizeCommitFrame = { v: 1; op: "finalize-commit" };
export type RemoteBootstrapAbortFrame = { v: 1; op: "abort" };
export type RemoteBootstrapInboundFrame = RemoteBootstrapFinalizeBeginFrame | RemoteBootstrapFinalizeFileFrame | RemoteBootstrapFinalizeCommitFrame | RemoteBootstrapAbortFrame;

export type RemoteBootstrapReadyFrame = { v: 1; op: "ready"; protocolVersion: number; bundleSha256: string; nonce: string; deployRoot: string; staging: string; stagingMode: "0700" };
export type RemoteBootstrapFinalizedFrame = { v: 1; op: "finalized"; active: string; files: number };
export type RemoteBootstrapAbortedFrame = { v: 1; op: "aborted"; reason: "requested" | "eof" };
export type RemoteBootstrapErrorFrame = { v: 1; op: "error"; code: string };
export type RemoteBootstrapResultFrame = RemoteBootstrapReadyFrame | RemoteBootstrapFinalizedFrame | RemoteBootstrapAbortedFrame | RemoteBootstrapErrorFrame;

export const REMOTE_BOOTSTRAP_FINALIZE_ERROR_CODES = ["BOOTSTRAP_INPUT_INVALID", "BOOTSTRAP_ENTRY_OP_UNSUPPORTED", "BOOTSTRAP_FINALIZE_INCOMPLETE", "BOOTSTRAP_FILE_MISMATCH", "BOOTSTRAP_MODE_INVALID", "BOOTSTRAP_ACTIVE_CONFLICT", "BOOTSTRAP_INTERNAL"] as const;
export type RemoteBootstrapFinalizeErrorCode = (typeof REMOTE_BOOTSTRAP_FINALIZE_ERROR_CODES)[number];
