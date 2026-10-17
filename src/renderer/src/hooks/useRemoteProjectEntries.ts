import { useCallback, useReducer, useRef, useState } from "react";
import { useStore } from "jotai";
import type { RemoteEntryKind } from "../../../shared/types/remoteFiles";
import { remoteFileDraftsAtom } from "../atoms/remote-file-atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { applyRemoteFileMutation } from "../utils/remoteFileDrafts";
import { initialRemoteFileManagementState, reduceRemoteFileManagement, remoteFileEntryErrorKey, remoteFileEntryIsUnknown, remoteFileEntrySuccessKey, REMOTE_FILE_ENTRY_UNKNOWN_CODE, type RemoteFileOperation } from "../components/session/remoteFileManagementState";

export type RemoteFileOutcome = { kind: "success" | "failed" | "unknown"; text: string; code: string | null; operation: RemoteFileOperation } | null;

/** 写命令的统一结果形状：成功分支可带附加字段，失败分支只有稳定码。 */
type MutationResult = { ok: true; [key: string]: unknown } | { ok: false; code: string };

function keptCodes(result: { ok: true; [key: string]: unknown }): string[] {
	const kept = result.kept;
	if (!Array.isArray(kept)) return [];
	const codes: string[] = [];
	for (const item of kept) {
		if (typeof item === "object" && item !== null && "code" in item && typeof item.code === "string") codes.push(item.code);
	}
	return codes;
}

/**
 * 远端文件管理的命令与状态接线（UI 只转发事件）。
 *
 * 冻结义务（§10.3/§10.4）：
 * - 写操作单飞：状态机 busy 时不再发第二个请求；
 * - 成功只做「显式刷新当前目录」并给成功消息，不自动开关其它弹框；
 * - 已知失败给稳定码文案；未知结果（RESULT_UNCONFIRMED）保留提示到用户显式刷新，且不自动重放；
 * - rename/delete 成功后只回收**干净**草稿，脏草稿保留并标 stale（§5.7）。
 */
export function useRemoteProjectEntries(options: { projectId: string; reload: () => Promise<void> }) {
	const [state, dispatch] = useReducer(reduceRemoteFileManagement, initialRemoteFileManagementState());
	const [outcome, setOutcome] = useState<RemoteFileOutcome>(null);
	const store = useStore();
	// 单飞判断读最新状态：命令闭包不能依赖过期渲染值。
	const phaseRef = useRef(state.phase);
	phaseRef.current = state.phase;
	const { projectId, reload } = options;
	const reloadRef = useRef(reload);
	reloadRef.current = reload;

	const execute = useCallback(async (operation: RemoteFileOperation, work: () => Promise<MutationResult>, successText?: (result: { ok: true; [key: string]: unknown }) => string): Promise<MutationResult> => {
		if (phaseRef.current === "busy") return { ok: false, code: "REMOTE_FILE_BUSY" };
		setOutcome(null);
		dispatch({ type: "begin", operation });
		let result: MutationResult;
		try {
			result = await work();
		} catch {
			// IPC reject 不是业务结论：按「未获确认」呈现，绝不谎报成功或未执行。
			result = { ok: false, code: "REMOTE_FILE_COMMAND_FAILED" };
		}
		if (result.ok) {
			dispatch({ type: "succeeded" });
			setOutcome({ kind: "success", text: successText ? successText(result) : t(remoteFileEntrySuccessKey(operation)), code: null, operation });
			try {
				await reloadRef.current();
			} catch {
				// 刷新失败不影响「操作已成功」这个事实；目录事实保持旧值，由用户显式刷新核对。
			}
		} else {
			const unknown = remoteFileEntryIsUnknown(result.code);
			dispatch(unknown ? { type: "unknown", code: result.code } : { type: "failed", code: result.code });
			setOutcome({ kind: unknown ? "unknown" : "failed", text: t(remoteFileEntryErrorKey(result.code), { code: result.code }), code: result.code, operation });
		}
		return result;
	}, []);

	const createEntry = useCallback(
		(parentRelativePath: string, kind: RemoteEntryKind, name: string) =>
			execute(kind === "file" ? "create-file" : "create-directory", () => (kind === "file" ? desktopApi.remoteHosts.createProjectFile(projectId, parentRelativePath, name) : desktopApi.remoteHosts.createProjectDirectory(projectId, parentRelativePath, name))),
		[execute, projectId],
	);

	const renameEntry = useCallback(
		(source: string, target: string) =>
			execute("rename", async () => {
				const stat = await desktopApi.remoteHosts.statProjectEntry(projectId, source);
				if (!stat.ok) return stat;
				const result = await desktopApi.remoteHosts.renameProjectEntry(projectId, source, target, stat.version);
				if (result.ok) store.set(remoteFileDraftsAtom, (held) => applyRemoteFileMutation(held, projectId, source));
				return result;
			}),
		[execute, projectId, store],
	);

	const deleteEntry = useCallback(
		(path: string) =>
			execute("delete", async () => {
				const stat = await desktopApi.remoteHosts.statProjectEntry(projectId, path);
				if (!stat.ok) return stat;
				const result = await desktopApi.remoteHosts.deleteProjectEntry(projectId, path, stat.version);
				if (result.ok) store.set(remoteFileDraftsAtom, (held) => applyRemoteFileMutation(held, projectId, path));
				return result;
			}),
		[execute, projectId, store],
	);

	const restoreTrash = useCallback(
		(trashId: string) =>
			execute(
				"restore",
				() => desktopApi.remoteHosts.restoreProjectTrash(projectId, trashId),
				(result) => (typeof result.relativePath === "string" ? t("remoteTrash.restored", { name: result.relativePath }) : t("remoteFileEntry.renamed")),
			),
		[execute, projectId],
	);

	const pruneTrash = useCallback(
		(trashIds: string[]) =>
			execute(
				"prune",
				() => desktopApi.remoteHosts.pruneProjectTrash(projectId, trashIds),
				(result) => {
					const codes = keptCodes(result);
					if (codes.length > 0) return t("remoteTrash.kept", { count: codes.length, code: codes[0] });
					return t("remoteTrash.removed", { count: trashIds.length });
				},
			),
		[execute, projectId],
	);

	return { state, outcome, busy: state.phase === "busy", createEntry, renameEntry, deleteEntry, restoreTrash, pruneTrash, clearOutcome: () => setOutcome(null), unknownCode: REMOTE_FILE_ENTRY_UNKNOWN_CODE };
}
export type RemoteProjectEntries = ReturnType<typeof useRemoteProjectEntries>;
