import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteTextOpenResult, RemoteTextSaveResult } from "../../shared/types/remoteFiles";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { createRemoteProjectFileService } from "../remote/RemoteProjectFileService";
import { validateRemoteProjectTextPath, REMOTE_PROJECT_TEXT_MAX_BYTES } from "../remote/RemoteProjectFileCommands";
import { isRemoteProjectTrashPath } from "../remote/RemoteProjectEntryCommands";

/** 编辑IPC独立于只读项目handler；locator只从main读取，整次I/O受既有单主机操作锁保护。 */
export function registerRemoteProjectFileIpc(input: { enabled: boolean; service: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>; locator: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined }): void {
	const files = createRemoteProjectFileService({
		locator: input.locator,
		withProject: async (target, work) => {
			const service = await input.service();
			if (!service) throw new Error("REMOTE_CONNECTION_SERVICE_UNAVAILABLE");
			const result = await service.withProjectSession(target.hostId, target.remotePath, (session) => work(session));
			if (!result.ok) throw new Error(result.code);
			return result.value;
		},
	});
	const senders = new Set<number>();
	function validate(sender: Electron.WebContents, projectId: unknown, relative: unknown): { senderId: number; projectId: string; relative: string } {
		if (!Number.isSafeInteger(sender.id) || sender.id < 1 || sender.isDestroyed() || typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) throw new Error("REMOTE_FILE_INPUT_INVALID");
		const path = validateRemoteProjectTextPath(relative);
		// 回收站是文件面的保留命名空间：文本读/写对第一段 .pideck-trash 一律拒绝（§4.3）。
		if (isRemoteProjectTrashPath(path)) throw new Error("REMOTE_FILE_PROTECTED_PATH");
		if (!senders.has(sender.id)) {
			senders.add(sender.id);
			sender.once("destroyed", () => {
				files.releaseSender(sender.id);
				senders.delete(sender.id);
			});
		}
		return { senderId: sender.id, projectId, relative: path };
	}
	function code(error: unknown): string {
		return error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message) ? error.message : "REMOTE_FILE_COMMAND_FAILED";
	}
	ipcMain.handle(ipcChannels.remoteProjectTextOpen, async (event, projectId: unknown, relative: unknown): Promise<RemoteTextOpenResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			const valid = validate(event.sender, projectId, relative);
			return { ok: true, document: await files.open(valid.senderId, valid.projectId, valid.relative) };
		} catch (error) {
			return { ok: false, code: code(error) };
		}
	});
	ipcMain.handle(ipcChannels.remoteProjectTextSave, async (event, projectId: unknown, relative: unknown, content: unknown, version: unknown): Promise<RemoteTextSaveResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			const valid = validate(event.sender, projectId, relative);
			if (typeof content !== "string" || typeof version !== "string" || !/^[a-f0-9]{32}$/.test(version)) throw new Error("REMOTE_FILE_INPUT_INVALID");
			if (content.length > REMOTE_PROJECT_TEXT_MAX_BYTES || Buffer.byteLength(content, "utf8") > REMOTE_PROJECT_TEXT_MAX_BYTES) throw new Error("REMOTE_FILE_TOO_LARGE");
			return { ok: true, ...(await files.save(valid.senderId, valid.projectId, valid.relative, content, version)) };
		} catch (error) {
			return { ok: false, code: code(error) };
		}
	});
}
