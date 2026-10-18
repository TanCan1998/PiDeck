/**
 * CUA 审批请求的 FIFO 队列纯策略。
 *
 * 背景（修复前行为）：`useCuaApproval` 只保存一个 pendingRequest，新请求直接
 * 覆盖旧请求，被覆盖的请求在主进程只剩 30s 超时兜底，用户界面根本见不到它。
 * 队列化保证每个审批都被逐一呈现、逐一应答（FIFO 呈现队首，响应后出队）。
 *
 * 抽成纯函数以便 node 单测（AGENTS.md：纯策略可单测，禁止只活在 JSX/hook 里）。
 */

/** 队列容量上限：超出时丢弃最旧请求（主进程 30s 超时会兜底拒绝它）。 */
export const MAX_PENDING_APPROVALS = 32;

/** 入队：追加到队尾；超出容量时丢弃最旧的请求（它被主进程 30s 超时兜底拒绝）。 */
export function enqueueApproval<T>(queue: readonly T[], item: T, maxLength = MAX_PENDING_APPROVALS): T[] {
	const next = [...queue, item];
	if (next.length <= maxLength) return next;
	return next.slice(next.length - maxLength);
}

/** 当前应呈现的请求（队首）。 */
export function peekApproval<T>(queue: readonly T[]): T | undefined {
	return queue[0];
}

/** 出队：移除队首（响应/取消后调用）。 */
export function dequeueApproval<T>(queue: readonly T[]): T[] {
	return queue.slice(1);
}
