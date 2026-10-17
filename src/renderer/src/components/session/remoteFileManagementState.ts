import type { TranslationKey } from "../../i18n/rendererCopy.zh-CN";

/**
 * 远端文件管理 UI 状态机（纯 reducer，无 React）。
 *
 * 冻结契约（docs/remote-file-management-plan.md §10.3）：
 * idle → creating|renaming|deleting|restoring|pruning → idle|failed|unknown；
 * 单飞（任一写操作在途即 busy，其余写按钮禁用）；成功只触发显式刷新；未知结果保留提示直到显式刷新。
 * 这里只放「事实」与「稳定码」，文案由 t() 映射（remoteFileEntryErrorText），便于离开 React 单测。
 */
export type RemoteFileOperation = "create-file" | "create-directory" | "rename" | "delete" | "restore" | "prune";
export type RemoteFileManagementPhase = "idle" | "busy" | "unknown" | "failed";

export type RemoteFileManagementState = {
	phase: RemoteFileManagementPhase;
	operation: RemoteFileOperation | null;
	/** failed/unknown 时的稳定码；成功/空闲为 null。 */
	code: string | null;
};

export type RemoteFileManagementEvent = { type: "begin"; operation: RemoteFileOperation } | { type: "succeeded" } | { type: "failed"; code: string } | { type: "unknown"; code: string } | { type: "reset" };

export const REMOTE_FILE_ENTRY_UNKNOWN_CODE = "REMOTE_FILE_RESULT_UNCONFIRMED";

export function initialRemoteFileManagementState(): RemoteFileManagementState {
	return { phase: "idle", operation: null, code: null };
}

export function reduceRemoteFileManagement(state: RemoteFileManagementState, event: RemoteFileManagementEvent): RemoteFileManagementState {
	if (event.type === "reset") return initialRemoteFileManagementState();
	if (event.type === "begin") {
		// 单飞：已有写操作在途时忽略第二个 begin（UI 也会禁用按钮；这里守住状态机本身）。
		if (state.phase === "busy") return state;
		return { phase: "busy", operation: event.operation, code: null };
	}
	if (state.phase !== "busy") return state;
	if (event.type === "succeeded") return initialRemoteFileManagementState();
	if (event.type === "failed") return { phase: "failed", operation: state.operation, code: event.code };
	return { phase: "unknown", operation: state.operation, code: REMOTE_FILE_ENTRY_UNKNOWN_CODE };
}

/** 稳定码 → 文案 key；未知码落到带 {code} 的 failure（绝不静默）。 */
export function remoteFileEntryErrorKey(code: string | null): TranslationKey {
	switch (code) {
		case "REMOTE_FILE_TARGET_EXISTS":
		case "REMOTE_PROJECT_TARGET_EXISTS":
			return "remoteFileEntry.targetExists";
		case "REMOTE_FILE_NAME_INVALID":
			return "remoteFileEntry.nameInvalid";
		case "REMOTE_FILE_PARENT_NOT_FOUND":
		case "REMOTE_PROJECT_PARENT_NOT_FOUND":
			return "remoteFileEntry.parentMissing";
		case "REMOTE_FILE_PARENT_NOT_DIRECTORY":
			return "remoteFileEntry.parentNotDirectory";
		case "REMOTE_FILE_ENTRY_UNSUPPORTED":
			return "remoteFileEntry.unsupportedEntry";
		case "REMOTE_FILE_PROTECTED_PATH":
			return "remoteFileEntry.protectedPath";
		case "REMOTE_FILE_MOVE_INTO_SELF":
			return "remoteFileEntry.moveIntoSelf";
		case "REMOTE_FILE_RENAME_UNSUPPORTED":
			return "remoteFileEntry.renameUnsupported";
		case "REMOTE_FILE_TRASH_UNAVAILABLE":
			return "remoteFileEntry.trashUnavailable";
		case "REMOTE_FILE_TRASH_ENTRY_NOT_FOUND":
			return "remoteFileEntry.trashNotFound";
		case "REMOTE_FILE_TRASH_ENTRY_INVALID":
			return "remoteFileEntry.trashInvalid";
		case "REMOTE_FILE_ENTRY_LIMIT":
			return "remoteFileEntry.entryLimit";
		case "REMOTE_FILE_BUSY":
			return "remoteFileEntry.busy";
		case "REMOTE_FILE_CHANGED":
			return "remoteFileEntry.changed";
		case "REMOTE_FILE_PERMISSION_DENIED":
			return "remoteFileEntry.permission";
		case "REMOTE_FILE_PLATFORM_UNSUPPORTED":
			return "remoteFileEntry.platform";
		case "REMOTE_FILE_RESULT_UNCONFIRMED":
			return "remoteFileEntry.unknown";
		case "REMOTE_PROJECT_CREATE_UNCONFIRMED":
			return "sidebar.remoteEnroll.createUnconfirmed";
		case "REMOTE_PROJECT_CREATE_FAILED":
			return "sidebar.remoteEnroll.createFailed";
		case "REMOTE_PROJECT_PARENT_NOT_FOUND":
			return "sidebar.remoteEnroll.parentMissing";
		case "REMOTE_PROJECT_TARGET_EXISTS":
			return "sidebar.remoteEnroll.createExists";
		case "SSH_HOST_NOT_READY":
		case "SSH_HOST_DISCONNECTED":
		case "REMOTE_CONNECTION_SERVICE_UNAVAILABLE":
			return "remoteFile.connection";
		default:
			return "remoteFileEntry.failure";
	}
}

/**
 * 失败后是否保留弹框输入（便于改名/改路径重试）。
 * 目标已存在/条目已变化/名字非法都保留；受保护路径关闭（继续改也改不出合法路径）。
 */
export function remoteFileEntryKeepsInput(code: string | null): boolean {
	return code === "REMOTE_FILE_TARGET_EXISTS" || code === "REMOTE_FILE_CHANGED" || code === "REMOTE_FILE_NAME_INVALID" || code === "REMOTE_FILE_PARENT_NOT_FOUND" || code === "REMOTE_FILE_PARENT_NOT_DIRECTORY";
}

export function remoteFileEntryIsUnknown(code: string | null): boolean {
	return code === REMOTE_FILE_ENTRY_UNKNOWN_CODE || code === "REMOTE_PROJECT_CREATE_UNCONFIRMED";
}

/** 成功提示的 key（按操作与条目类型）。 */
export function remoteFileEntrySuccessKey(operation: RemoteFileOperation): TranslationKey {
	if (operation === "rename") return "remoteFileEntry.renamed";
	if (operation === "delete") return "remoteFileEntry.deleted";
	if (operation === "restore") return "remoteTrash.restored";
	if (operation === "prune") return "remoteTrash.removed";
	return "remoteFileEntry.created";
}
