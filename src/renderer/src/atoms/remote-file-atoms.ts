import { atom } from "jotai";
import type { RemoteFileDraft } from "../utils/remoteFileDrafts";

/** 草稿跨项目/会话挂载保留，正文不落盘；容量由remoteFileDrafts策略限制为5个文件。 */
export const remoteFileDraftsAtom = atom(new Map<string, RemoteFileDraft>());
