import type { RemoteWorkspaceEntry } from "../../../../shared/types/remoteHost";

/**
 * 远端目录条目排序：目录在前、文件在后，同类按名字。
 *
 * 与本地文件树读法一致；抽成纯函数是为了让「顺序」这条规则可以离开 React 单测。
 */
export function sortRemoteEntries(entries: readonly RemoteWorkspaceEntry[]): RemoteWorkspaceEntry[] {
	return [...entries].sort((first, second) => (first.kind === second.kind ? first.name.localeCompare(second.name) : first.kind === "directory" ? -1 : 1));
}
