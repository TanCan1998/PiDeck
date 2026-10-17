/**
 * 「永久删除远端归档会话」的稳定码闭集（Remote Session data delete，Phase 5）。
 *
 * 为什么放在 shared：main 抛/返回它，renderer 要按码选文案（尤其是 RESULT_UNCONFIRMED 必须与
 * 普通失败分开：不能自动刷新掉、也不能重试），测试也要逐字断言；复制多份字面量迟早漂移。
 * 约定：这些码只描述**本操作**的失败原因，不是远端连接层码；连接层自己的稳定码（SSH_*）原样透传。
 */
export const REMOTE_SESSION_DELETE_CODES = {
	/** 装配没提供远端删除端口（远端实验开关关闭 / 旧装配）：fail closed，绝不落回本机路径分支。 */
	unavailable: "REMOTE_SESSION_DELETE_UNAVAILABLE",
	/** 会话有运行实例（运行中/正在启动）：先停 Agent，零远端命令。 */
	busy: "REMOTE_SESSION_DELETE_BUSY",
	/** 本机归档索引里没有这条会话（可能已被删除/恢复）：不猜身份、不发命令。 */
	entryNotFound: "REMOTE_SESSION_DELETE_ENTRY_NOT_FOUND",
	/** 会话仍在 catalog 的活记录里（不是归档条目）：拒绝，避免把「删除归档」误用到活动会话。 */
	notArchived: "REMOTE_SESSION_DELETE_NOT_ARCHIVED",
	/** 单次确认缺失/过期/被重放/来自别的窗口：重新发起删除请求。 */
	confirmationRequired: "REMOTE_SESSION_DELETE_CONFIRMATION_REQUIRED",
	/** 远端命令返回「文件已不在归档路径」：确定没删任何东西（但仍让用户核对列表）。 */
	fileMissing: "REMOTE_SESSION_DELETE_FILE_MISSING",
	/** 删除前的身份复核发现文件变了：确定没有 unlink，让用户重载后重试。 */
	fileChanged: "REMOTE_SESSION_DELETE_FILE_CHANGED",
	/** 构造参数/Node 路径/命令超上界：绝不拼进命令。 */
	optionsInvalid: "REMOTE_SESSION_DELETE_OPTIONS_INVALID",
	/** 远端路径不可用（非法/越界/非归档区形状）：绝不拼进命令。 */
	pathInvalid: "REMOTE_SESSION_DELETE_PATH_INVALID",
	/** hostId 不可用/远端 Node 路径不可用：不发命令。 */
	hostIdInvalid: "REMOTE_SESSION_DELETE_HOST_ID_INVALID",
	nodePathInvalid: "REMOTE_SESSION_DELETE_NODE_PATH_INVALID",
	/** 传输层失败（ssh 起不来/超时）且没拿到任何命令回执：没执行，可安全重试。 */
	transportFailed: "REMOTE_SESSION_DELETE_TRANSPORT_FAILED",
	/** 远端命令确定失败（脚本明确报告、unlink 未发生）。 */
	commandFailed: "REMOTE_SESSION_DELETE_COMMAND_FAILED",
	/**
	 * 回执丢失/输出不可信（连接断、stdout 无标记、JSON 撕裂）：远端**可能已经删除**。
	 * 绝不重试、绝不自动刷新掉；UI 保留「结果未确认，请刷新归档列表核对」。
	 */
	resultUnconfirmed: "REMOTE_SESSION_DELETE_RESULT_UNCONFIRMED",
} as const;

export type RemoteSessionDeleteCode = (typeof REMOTE_SESSION_DELETE_CODES)[keyof typeof REMOTE_SESSION_DELETE_CODES];

/** 码值集合：main 只允许把闭集里的码当「确定结论」向上返回（其余一律折叠成 commandFailed）。 */
export const REMOTE_SESSION_DELETE_CODE_SET: ReadonlySet<string> = new Set(Object.values(REMOTE_SESSION_DELETE_CODES));
