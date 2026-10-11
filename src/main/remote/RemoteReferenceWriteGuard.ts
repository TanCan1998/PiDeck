/**
 * 引用写入门（INV-5 / INV-1 / INV-12 的写入侧一半，设计 §3.1 方案 A）。
 *
 * 两个引用 store（`projects.json` 的远端项目、`session-catalog.json` 的远端会话）在**写入一条
 * hostId 引用之前**必须先过这里。它回答两个问题，各自给出独立稳定码：
 *
 * 1. **现在有没有一个跨 store 事务在跑**：journal 文件存在，或 rebind tx 锁被一个活着的 owner 持有
 *    ⇒ 拒绝（`REMOTE_HOST_REFERENCE_REBIND_ACTIVE`）。此时"读 host 存在 → 写引用"的窗口正好开着，
 *    写下去就可能指向一个刚刚退役的主机。判定复用 tx 锁自己的 owner/回收规则：探测方式是**试着取锁**，
 *    拿得到就说明没有活 owner（顺手释放），拿不到才是被占用 —— 崩溃遗留的陈旧锁会被同一套 R6 规则
 *    回收，不会把引用写入永久锁死。
 * 2. **这个 hostId 现在还能解析到一个 profile 吗**：读**磁盘上**的 remote-hosts.json（主/备份按 revision
 *    选最新，与 RemoteHostStore.loadState 同规则，绝不看内存缓存）⇒ 不存在或已退役一律拒绝
 *    （`REMOTE_HOST_REFERENCE_HOST_UNRESOLVED`）。store 读不出来 ⇒ 无法证明，同样拒绝，但用另一个码
 *    （`REMOTE_HOST_REFERENCE_STORE_UNVERIFIED`）：前者要用户重新添加主机，后者要修复磁盘。
 *
 * 防不住什么（如实，不宣称事务安全闭环）：跨进程 TOCTOU 仍存在——本门在读完 host 文件后、引用落盘
 * 前，另一个进程仍可能提交退役。两个写者都读对方**磁盘**最新状态的这一事实把窗口压到"两次原子 rename
 * 之间"，但只有 journal + roll-forward（5b）能把结果收敛回来。旧版本 PiDeck 不认识本门，同样不受约束。
 */
import { readFile } from "node:fs/promises";
import { decodeRemoteHostSnapshot, type DecodedRemoteHostSnapshot } from "./RemoteHostStoreCodec";
import { acquireRebindTxLock, currentBootId, defaultIsProcessAlive } from "./HostRebindTxLock";
import { resolveRemoteHostPaths, type RemoteHostPaths } from "./RemoteHostPaths";

/** 事务在跑：等它收敛后重试即可（不是用户错误，也不是数据损坏）。 */
export const REMOTE_HOST_REFERENCE_REBIND_ACTIVE = "REMOTE_HOST_REFERENCE_REBIND_ACTIVE";
/** hostId 解析不到 profile（已退役 / 从未存在）：需要用户重新添加主机。 */
export const REMOTE_HOST_REFERENCE_HOST_UNRESOLVED = "REMOTE_HOST_REFERENCE_HOST_UNRESOLVED";
/** 主机目录读不出来（损坏 / 不可读）：无法证明，需要修复。 */
export const REMOTE_HOST_REFERENCE_STORE_UNVERIFIED = "REMOTE_HOST_REFERENCE_STORE_UNVERIFIED";

export const REMOTE_HOST_REFERENCE_WRITE_CODES = [REMOTE_HOST_REFERENCE_REBIND_ACTIVE, REMOTE_HOST_REFERENCE_HOST_UNRESOLVED, REMOTE_HOST_REFERENCE_STORE_UNVERIFIED] as const;

export type RemoteReferenceWriteGuard = {
	/** Resolves when a reference to `hostId` may be committed; throws one of the codes above otherwise. */
	assertHostReferenceWritable(hostId: string): Promise<void>;
	/**
	 * 删除/改写引用前的最低要求：现在没有跨 store 事务在跑（不检查具体 hostId）。
	 * 事务中途删掉一个正在被迁移的记录会让收敛侧只能报 `..._RECORD_MISSING`（需人工），
	 * 所以“退让拒绝”同样适用于删除路径（设计 §3.1 方案 A 的 advisory interlock）。
	 */
	assertRebindIdle(): Promise<void>;
};

export type RemoteReferenceWriteGuardOptions = {
	/** Same `<userData>` root the stores are opened with: the guard must read the file they write. */
	readonly userDataDir: string;
	readonly paths?: RemoteHostPaths;
	/** Injectable for tests; defaults to a real read of the host store's primary + backup. */
	readonly readHostSnapshot?: () => Promise<DecodedRemoteHostSnapshot | undefined>;
	readonly bootId?: string;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly now?: () => number;
};

const MAX_HOST_SNAPSHOT_BYTES = 8 * 1024 * 1024;

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

/** 单个文件读数：缺失/损坏都返回 undefined（"没有"与"读不出来"由调用方按两个文件合起来判定）。 */
async function readHostFile(filePath: string): Promise<DecodedRemoteHostSnapshot | undefined> {
	try {
		const text = await readFile(filePath, "utf8");
		if (text.length > MAX_HOST_SNAPSHOT_BYTES) return undefined;
		return decodeRemoteHostSnapshot(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/**
 * 与 RemoteHostStore.loadState 同一选择规则：两个都合法取 revision 高的；只有一个合法就用它；
 * 两个都不合法（含都缺失）返回 undefined。首次运行（两个文件都不存在）也确实没有 profile。
 */
async function readHostSnapshotFromDisk(paths: RemoteHostPaths): Promise<DecodedRemoteHostSnapshot | undefined> {
	const [primary, backup] = await Promise.all([readHostFile(paths.hostStoreFile), readHostFile(paths.hostStoreBackupFile)]);
	if (primary && backup) return backup.revision > primary.revision ? backup : primary;
	return primary ?? backup;
}

export function createRemoteReferenceWriteGuard(options: RemoteReferenceWriteGuardOptions): RemoteReferenceWriteGuard {
	const paths = options.paths ?? resolveRemoteHostPaths(options.userDataDir);
	const readHostSnapshot = options.readHostSnapshot ?? (() => readHostSnapshotFromDisk(paths));

	/** 事务探测：journal 文件存在，或 tx 锁被活着的 owner 持有。取锁失败即"有活 owner"。 */
	async function rebindTransactionOpen(): Promise<boolean> {
		try {
			await readFile(paths.rebindJournalFile, "utf8");
			return true;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") return true;
		}
		const lock = await acquireRebindTxLock({
			userDataDir: paths.rootDir,
			lockPath: paths.rebindJournalLockFile,
			// 必须用**真实**的 bootId/存活探测：用空 bootId 会把一个活着的 rebind 误判成陈旧并把它删掉
			// （那就等于替对方解锁，比不检查更糟）。
			bootId: options.bootId ?? currentBootId(),
			isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
			now: options.now ?? Date.now,
		});
		if (!lock) return true;
		await lock.release();
		return false;
	}

	return {
		async assertHostReferenceWritable(hostId: string): Promise<void> {
			if (await rebindTransactionOpen()) throw new Error(REMOTE_HOST_REFERENCE_REBIND_ACTIVE);
			let snapshot: DecodedRemoteHostSnapshot | undefined;
			try {
				snapshot = await readHostSnapshot();
			} catch {
				throw new Error(REMOTE_HOST_REFERENCE_STORE_UNVERIFIED);
			}
			if (!snapshot) throw new Error(REMOTE_HOST_REFERENCE_STORE_UNVERIFIED);
			if (!snapshot.profiles.some((profile) => profile.id === hostId)) throw new Error(REMOTE_HOST_REFERENCE_HOST_UNRESOLVED);
		},
		async assertRebindIdle(): Promise<void> {
			if (await rebindTransactionOpen()) throw new Error(REMOTE_HOST_REFERENCE_REBIND_ACTIVE);
		},
	};
}
