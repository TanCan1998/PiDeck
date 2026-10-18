import { t } from "../i18n";

/** Remote terminal failures are translated stable codes, never raw SSH diagnostics or connection details. */
export function remoteTerminalErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (/SSH_HOST_DISCONNECTED|SSH_HOST_NOT_READY|REMOTE_CONNECTION_SERVICE_DISPOSED/.test(message)) return t("terminal.remoteDisconnected");
	if (/REMOTE_TERMINAL_(?:INPUT|OUTPUT)_LIMIT/.test(message)) return t("terminal.remoteBufferLimit");
	if (/REMOTE_TERMINAL_LIMIT/.test(message)) return t("terminal.remoteLimit");
	if (/SSH_PROJECT_ROOT_|REMOTE_TERMINAL_TARGET_CHANGED/.test(message)) return t("terminal.remoteTargetChanged");
	return t("terminal.remoteFailed");
}

/**
 * 是否是远端终端的稳定码（SSH_ 或 REMOTE_ 前缀，可能被 Electron 的
 * `Error invoking remote method ...` 前缀包住）：只有这类错误才该被翻译成远端文案，
 * 本机终端的失败要保持原始原因，不能被统一吞成「远端终端不可用」。
 */
export function isRemoteTerminalError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return /(?:^|[^A-Za-z0-9_])(?:SSH|REMOTE)_[A-Z0-9_]{1,100}/.test(message);
}
