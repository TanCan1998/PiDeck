import { randomBytes } from "node:crypto";
import type { RemoteEntryKind, RemoteEntryRevision } from "../../shared/types/remoteFiles";

/**
 * main-owned、内存-only 的 entry 一次性令牌表（文件管理 v1）。
 *
 * 与文本保存的令牌表**互相独立**（各自 30 分钟 / 128 条，互不驱逐），按
 * sender + projectId + 项目相对路径 + 主机/根值快照 + hostRevision + 条目身份 revision 绑定。
 * 抽成纯模块是为了让「跨窗口/跨项目/跨路径/跨代数/replay」这些规则可以离开 SSH 单测。
 */
export type RemoteFileMutationTokenEntry = {
	sender: number;
	projectId: string;
	relative: string;
	kind: RemoteEntryKind;
	hostId: string;
	remotePath: string;
	hostRevision: number;
	revision: RemoteEntryRevision;
	expires: number;
};

export type RemoteFileMutationTokenExpected = Pick<RemoteFileMutationTokenEntry, "sender" | "projectId" | "relative" | "hostId" | "remotePath">;

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 128;

/** 有界容量 + TTL + releaseSender；以先后到达顺序驱逐最旧条目（与文本面同一保守策略）。 */
export function createRemoteFileMutationTokens(ports: { now?: () => number } = {}) {
	const entries = new Map<string, RemoteFileMutationTokenEntry>();
	const now = ports.now ?? Date.now;
	function prune() {
		for (const [token, entry] of entries) if (entry.expires <= now()) entries.delete(token);
	}
	return {
		issue(entry: Omit<RemoteFileMutationTokenEntry, "expires">): string {
			prune();
			while (entries.size >= MAX_ENTRIES) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
			const token = randomBytes(16).toString("hex");
			entries.set(token, { ...entry, expires: now() + TTL_MS });
			return token;
		},
		/** 先比对再删除：不匹配的令牌不会被别的窗口/项目/路径烧掉。 */
		take(token: unknown, expected: RemoteFileMutationTokenExpected): RemoteFileMutationTokenEntry {
			prune();
			const entry = typeof token === "string" ? entries.get(token) : undefined;
			if (!entry || entry.sender !== expected.sender || entry.projectId !== expected.projectId || entry.relative !== expected.relative || entry.hostId !== expected.hostId || entry.remotePath !== expected.remotePath || entry.expires <= now()) throw new Error("REMOTE_FILE_VERSION_INVALID");
			entries.delete(token as string);
			return entry;
		},
		releaseSender(sender: number): void {
			for (const [token, entry] of entries) if (entry.sender === sender) entries.delete(token);
		},
		size(): number {
			prune();
			return entries.size;
		},
	};
}
export type RemoteFileMutationTokens = ReturnType<typeof createRemoteFileMutationTokens>;
