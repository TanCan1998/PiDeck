/** 远端已有UTF-8文本文件的编辑契约；version是不透明的主进程快照令牌，不是渲染层自报摘要。 */
export type RemoteTextDocument = { content: string; version: string };
export type RemoteTextOpenResult = { ok: true; document: RemoteTextDocument } | { ok: false; code: string };
export type RemoteTextSaveResult = { ok: true; version: string } | { ok: false; code: string };

/**
 * 远端文件管理契约（Phase 5 文件面；冻结于 docs/remote-file-management-plan.md §3.3）。
 *
 * 渲染层只提交 projectId + **项目根相对 POSIX 路径** + create-only 的名字/不透明令牌；
 * 主机、绝对路径、摘要、回收站 manifest 全部由 main 持有。这里只声明跨进程形状，
 * 不声明任何本机路径语义（远端路径绝不能进本机 fs/Git/shell）。
 */
export type RemoteEntryKind = "file" | "directory";

/** entry 令牌的身份快照：比文本面的 revision 少了 SHA-256 与 256 KiB 限制（目录/大文件也要能改名/删除）。 */
export type RemoteEntryRevision = {
	mode: number;
	size: number;
	dev: string;
	ino: string;
	uid: string;
	gid: string;
	mtimeNs: string;
	ctimeNs: string;
};

export type RemoteEntryStat = { kind: RemoteEntryKind; bytes?: number; mtimeMs: number };

/** entry-stat 成功即签发不透明 entry 令牌（rename/delete 的一次性授权）。 */
export type RemoteEntryStatResult = { ok: true; stat: RemoteEntryStat; version: string } | { ok: false; code: string };

export type RemoteEntryCreateResult = { ok: true; relativePath: string; kind: RemoteEntryKind } | { ok: false; code: string };
export type RemoteEntryRenameResult = { ok: true; relativePath: string } | { ok: false; code: string };
export type RemoteEntryDeleteResult = { ok: true; trashId: string } | { ok: false; code: string };

/**
 * 回收站条目状态：只有 intact 可还原；其余只能被显式 prune（invalid 连 prune 都拒绝）。
 * 状态来自脚本对 manifest + payload 身份的重验，不是 UI 推断。
 */
export type RemoteTrashEntryState = "intact" | "payload-missing" | "payload-changed" | "invalid";

export type RemoteTrashEntry = {
	/** main 生成：YYYYMMDDTHHMMSSZ-<8hex>；同时是 .pideck-trash 下的目录名。 */
	id: string;
	/** 删除前的项目相对路径（来自 manifest，不是 renderer 自报）。invalid 条目为空串。 */
	originalPath: string;
	kind: RemoteEntryKind;
	/** 仅普通文件存在。 */
	bytes?: number;
	/** ISO 8601 UTC；invalid 条目可能退化为条目目录的 mtime。 */
	deletedAt: string;
	/** 仅作展示的 TTL 标签（默认 deletedAt + 30 天）；**不触发任何自动删除**。 */
	expiresAt: string;
	state: RemoteTrashEntryState;
};

export type RemoteTrashListResult = { ok: true; entries: RemoteTrashEntry[]; truncated: boolean } | { ok: false; code: string };
export type RemoteTrashRestoreResult = { ok: true; relativePath: string } | { ok: false; code: string };
export type RemoteTrashPruneResult = { ok: true; removed: string[]; kept: Array<{ id: string; code: string }> } | { ok: false; code: string };
