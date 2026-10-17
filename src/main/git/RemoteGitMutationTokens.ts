import { randomBytes } from "node:crypto";
import type { RemoteGitWriteExpectation } from "./RemoteGitService";

/** The closed set of actions a snapshot can authorize; one token authorizes exactly one kind. */
export type RemoteGitMutationKind = RemoteGitWriteExpectation["kind"];
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
			// A refresh replaces the grant of the same action kind only: one snapshot hands out both an index
			// grant and a commit grant, and issuing the second must not revoke the first.
			for (const [token, entry] of entries) if (entry.senderId === senderId && entry.projectId === projectId && entry.expected.kind === expected.kind) entries.delete(token);
			for (const [token, entry] of entries) if (entry.expires <= now()) entries.delete(token);
			while (entries.size >= 128) {
				const oldest = entries.keys().next().value;
				if (oldest !== undefined) entries.delete(oldest);
			}
			const token = randomBytes(16).toString("hex");
			entries.set(token, { senderId, projectId, expected, expires: now() + 15 * 60_000 });
			return token;
		},
		/**
		 * Consume synchronously before the caller's first await; another window cannot burn the owner's token.
		 * The repository scope is part of the grant identity (G5e): a token minted for one repository is unusable against
		 * another, exactly like a token minted for another window or project, and a mismatch never burns it. A wrong action
		 * kind stays a caller bug with its own code and also does not burn the token the user still owns.
		 */
		take(senderId: number, projectId: string, kind: RemoteGitMutationKind, repoPath: string, token: unknown): RemoteGitWriteExpectation {
			const entry = typeof token === "string" && /^[0-9a-f]{32}$/.test(token) ? entries.get(token) : undefined;
			if (!entry || entry.senderId !== senderId || entry.projectId !== projectId || entry.expected.repoPath !== repoPath) throw new Error("GIT_WRITE_SNAPSHOT_EXPIRED");
			// A token for the other action kind is a caller bug: refuse without burning the token the user still owns.
			if (entry.expected.kind !== kind) throw new Error("GIT_RESULT_INVALID");
			entries.delete(String(token));
			if (entry.expires <= now()) throw new Error("GIT_WRITE_SNAPSHOT_EXPIRED");
			return entry.expected;
		},
		clear() {
			entries.clear();
		},
	};
}
