/**
 * 远端 pi 探测稳定码 → main 进程文案键（P4.1 i18n 接线）。
 *
 * 为什么单独一个小模块：探测在 `RemotePiDiscovery` 里抛错，码随异常 message 跨层流动（跨 IPC 时只剩
 * message/debugDetails），所以「认码」只能基于字符串包含关系；把映射集中在这里，避免在错误处理里散落
 * if/else，也让测试能直接钉住「每个码都有可读文案」这条契约。
 */
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { REMOTE_PI_DISCOVERY_CODES, REMOTE_PI_NODE_PATH_INVALID, REMOTE_PI_NOT_FOUND, REMOTE_PI_PATH_INVALID, REMOTE_PI_SHELL_PATH_UNREADABLE, REMOTE_PI_TOO_OLD, REMOTE_PI_VERSION_UNREADABLE, REMOTE_PI_VERSION_UNVERIFIED } from "./RemotePiDiscovery";

const COPY_KEY_BY_CODE: Record<(typeof REMOTE_PI_DISCOVERY_CODES)[number], MainProcessTranslationKey> = {
	[REMOTE_PI_PATH_INVALID]: "remote.piPathInvalid",
	[REMOTE_PI_NODE_PATH_INVALID]: "remote.piNodePathInvalid",
	[REMOTE_PI_SHELL_PATH_UNREADABLE]: "remote.piShellPathUnreadable",
	[REMOTE_PI_NOT_FOUND]: "remote.piNotFound",
	[REMOTE_PI_TOO_OLD]: "remote.piTooOld",
	[REMOTE_PI_VERSION_UNREADABLE]: "remote.piVersionUnreadable",
	[REMOTE_PI_VERSION_UNVERIFIED]: "remote.piVersionUnverified",
};

/** 从异常消息里认出探测码；认不出返回 undefined（调用方回落到通用启动失败文案）。 */
export function remotePiDiscoveryCopyKey(message: string): MainProcessTranslationKey | undefined {
	for (const code of REMOTE_PI_DISCOVERY_CODES) {
		if (message.includes(code)) return COPY_KEY_BY_CODE[code];
	}
	return undefined;
}
