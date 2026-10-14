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
