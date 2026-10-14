import { useCallback, useEffect, useState } from "react";
import { useAtom, useStore } from "jotai";
import { desktopApi } from "../desktopApi";
import { remoteFileDraftsAtom } from "../atoms/remote-file-atoms";
import { beginRemoteFileLoad, editRemoteFileDraft, completeRemoteFileSave, remoteFileDraftDirty, remoteFileDraftKey, updateRemoteFileDraft } from "../utils/remoteFileDrafts";

/** 远端文本IO单一owner：显式保存，失败不重试，不把焦点项目当成异步请求的目标。 */
export function useRemoteFileDraft(projectId: string, path: string) {
	const [drafts, setDrafts] = useAtom(remoteFileDraftsAtom);
	const store = useStore();
	const key = remoteFileDraftKey(projectId, path);
	const draft = drafts.get(key);
	const [loadError, setLoadError] = useState<string>();
	const load = useCallback(
		async (reload = false) => {
			const current = store.get(remoteFileDraftsAtom);
			if (current.has(key) && !reload) return;
			let next: ReturnType<typeof beginRemoteFileLoad>;
			try {
				next = beginRemoteFileLoad(current, projectId, path, reload);
				setLoadError(undefined);
			} catch (error) {
				setLoadError(error instanceof Error ? error.message : "REMOTE_FILE_COMMAND_FAILED");
				return;
			}
			const generation = next.get(key)?.generation;
			if (generation === undefined) return;
			store.set(remoteFileDraftsAtom, next);
			try {
				const result = await desktopApi.remoteHosts.openProjectText(projectId, path);
				setDrafts((held) => updateRemoteFileDraft(held, key, generation, (entry) => (result.ok ? { ...entry, ...result.document, savedContent: result.document.content, phase: "ready", errorCode: undefined, blocked: false } : { ...entry, phase: "failed", errorCode: result.code, blocked: true })));
			} catch {
				setDrafts((held) => updateRemoteFileDraft(held, key, generation, (entry) => ({ ...entry, phase: "failed", errorCode: "REMOTE_FILE_COMMAND_FAILED", blocked: true })));
			}
		},
		[key, path, projectId, setDrafts, store],
	);
	useEffect(() => {
		void load();
	}, [load]);
	const change = useCallback(
		(content: string) => {
			setDrafts((held) => {
				const entry = held.get(key);
				return entry ? updateRemoteFileDraft(held, key, entry.generation, (value) => editRemoteFileDraft(value, content)) : held;
			});
		},
		[key, setDrafts],
	);
	const save = useCallback(async () => {
		const entry = store.get(remoteFileDraftsAtom).get(key);
		if (!entry || entry.phase !== "ready" || entry.blocked || !remoteFileDraftDirty(entry)) return;
		const { content, version, generation } = entry;
		store.set(remoteFileDraftsAtom, (held) => updateRemoteFileDraft(held, key, generation, (value) => ({ ...value, phase: "saving", errorCode: undefined })));
		try {
			const result = await desktopApi.remoteHosts.saveProjectText(projectId, path, content, version);
			setDrafts((held) => updateRemoteFileDraft(held, key, generation, (value) => (result.ok ? completeRemoteFileSave(value, content, result.version) : { ...value, phase: "ready", blocked: true, errorCode: result.code })));
		} catch {
			// 回执丢失可能已经提交：不谎报未写入，也不自动重试。草稿仍完整保留。
			setDrafts((held) => updateRemoteFileDraft(held, key, generation, (value) => ({ ...value, phase: "ready", blocked: true, errorCode: "REMOTE_FILE_COMMAND_FAILED" })));
		}
	}, [key, path, projectId, setDrafts, store]);
	return { draft, loadError, change, save, reload: () => load(true), dirty: draft ? remoteFileDraftDirty(draft) : false };
}
