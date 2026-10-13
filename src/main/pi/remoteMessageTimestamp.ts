import type { ChatMessage } from "../../shared/types";
import { stoppedMessageFingerprint } from "./stoppedMessageIdentity";

/**
 * 将 pi 原始事件时间绑定到唯一尚未认领的乐观用户消息。
 * SSH 两台机器时钟可能不同，不能拿 UI 的本机 Date.now() 去核对远端 JSONL 时间窗。
 * 只写身份 meta，不改 UI 时间/id；重复未认领消息不猜测，已认领/已投影消息不再次参与匹配。
 */
export function bindRemoteUserMessageTimestamp(messages: ChatMessage[], persisted: ChatMessage | undefined): number | undefined {
	if (!persisted || persisted.role !== "user" || !Number.isFinite(persisted.timestamp)) return undefined;
	const fingerprint = stoppedMessageFingerprint(persisted);
	const candidates = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === "user" && message.meta?.entryId === undefined && message.meta?.persistedTimestamp === undefined && stoppedMessageFingerprint(message) === fingerprint);
	if (candidates.length !== 1) return undefined;
	const { message, index } = candidates[0];
	message.meta = { ...message.meta, persistedTimestamp: persisted.timestamp };
	return index;
}
