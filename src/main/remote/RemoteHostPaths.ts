/**
 * Single source of truth for the remote-host domain's on-disk layout.
 *
 * Why one resolver (`docs/remote-host-cross-store-design.md` §7.1 第 25 项): the store file, its
 * backup, its lock, the pin root and the rebind journal/tx lock used to be assembled independently in
 * five places. A drift between two of them means a lock that guards a different file than the one
 * being written — the exact failure the cross-process guarantees exist to prevent. Callers pass the
 * resolver's paths around instead of joining their own.
 *
 * Note: the names here are frozen by the existing store files. Do not rename without a migration.
 */
import { join } from "node:path";

export type RemoteHostPaths = {
	readonly rootDir: string;
	readonly hostStoreFile: string;
	readonly hostStoreBackupFile: string;
	readonly hostStoreLockFile: string;
	readonly pinRoot: string;
	readonly rebindJournalFile: string;
	readonly rebindJournalLockFile: string;
};

export function resolveRemoteHostPaths(userDataDir: string): RemoteHostPaths {
	const hostStoreFile = join(userDataDir, "remote-hosts.json");
	return {
		rootDir: userDataDir,
		hostStoreFile,
		hostStoreBackupFile: `${hostStoreFile}.bak`,
		hostStoreLockFile: `${hostStoreFile}.lock`,
		pinRoot: join(userDataDir, "ssh-host-keys"),
		rebindJournalFile: join(userDataDir, "remote-host-rebind.json"),
		rebindJournalLockFile: join(userDataDir, "remote-host-rebind.lock"),
	};
}
