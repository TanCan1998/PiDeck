import type { ArchivedPiSession } from "../../../shared/types";

/** 路由归档恢复身份：SSH 只传 catalog ID，本机只传本机归档路径，绝不相互回退。 */
export function restoreArchivedPiSession(
	item: ArchivedPiSession,
	ports: {
		unarchiveRemoteRecord: (sessionId: string) => Promise<boolean>;
		unarchiveRecord: (archivedPath: string) => Promise<boolean>;
	},
): Promise<boolean> {
	if (item.archivedRemoteSessionId) return ports.unarchiveRemoteRecord(item.archivedRemoteSessionId);
	return ports.unarchiveRecord(item.summary.filePath);
}
