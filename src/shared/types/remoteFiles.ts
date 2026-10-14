/** 远端已有UTF-8文本文件的编辑契约；version是不透明的主进程快照令牌，不是渲染层自报摘要。 */
export type RemoteTextDocument = { content: string; version: string };
export type RemoteTextOpenResult = { ok: true; document: RemoteTextDocument } | { ok: false; code: string };
export type RemoteTextSaveResult = { ok: true; version: string } | { ok: false; code: string };
