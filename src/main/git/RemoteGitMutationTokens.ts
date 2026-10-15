import { randomBytes } from "node:crypto";
import type { RemoteGitWriteExpectation } from "./RemoteGitService";

type Entry = { senderId: number; projectId: string; expires: number; expected: RemoteGitWriteExpectation };

/** Bounded, memory-only capabilities: a snapshot grants one index action to one window/project. */
export function createRemoteGitMutationTokens(now = Date.now) {
	const entries = new Map<string, Entry>();
	function revoke(senderId: number, projectId?: string) {
		for (const [token, entry] of entries) if (entry.senderId === senderId && (projectId === undefined || entry.projectId === projectId)) entries.delete(token);
	}
	return {
		revoke,
		issue(senderId: number, projectId: string, expected: RemoteGitWriteExpectation) {
			revoke(senderId, projectId);
			for (const [token, entry] of entries) if (entry.expires <= now()) entries.delete(token);
			while (entries.size >= 128) {
				const oldest = entries.keys().next().value;
				if (oldest !== undefined) entries.delete(oldest);
			}
			const token = randomBytes(16).toString("hex");
			entries.set(token, { senderId, projectId, expected, expires: now() + 15 * 60_000 });
			return token;
		},
		/** Consume synchronously before the caller's first await; another window cannot burn the owner's token. */
		take(senderId: number, projectId: string, token: unknown): RemoteGitWriteExpectation {
			const entry = typeof token === "string" && /^[0-9a-f]{32}$/.test(token) ? entries.get(token) : undefined;
			if (!entry || entry.senderId !== senderId || entry.projectId !== projectId) throw new Error("GIT_WRITE_SNAPSHOT_EXPIRED");
			entries.delete(String(token));
			if (entry.expires <= now()) throw new Error("GIT_WRITE_SNAPSHOT_EXPIRED");
			return entry.expected;
		},
		clear() {
			entries.clear();
		},
	};
}
