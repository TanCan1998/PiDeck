/**
 * 删除项目 = 删 `projects.json` 记录 + 清 `session-catalog.json` 里指向它的引用（两段、两个文件、两次原子写）。
 *
 * 顺序固定为**先清引用、后删项目**：两个 store 没有共同提交点（没有跨文件事务），所以只能选一个安全顺序。
 * 反过来（先删项目）在第二段失败时会留下「catalog 仍引用一个已删项目」的悬空引用，而旧实现用
 * `.catch(() => 0)` 把失败变成「本来就没有会话」，调用方与用户都看不到（K1 §6.3 反例 3）。
 *
 * - 第一段失败：抛 `PROJECT_REMOVAL_SESSION_SWEEP_FAILED`，项目**不删**，磁盘零副作用，可原样重试；
 * - 第二段失败：引用已清（不再悬空）、项目仍在，同样抛出稳定码；重试同一调用即可收敛。
 *
 * 两段都不吞错：调用方若确实要 best-effort（启动期的孤儿清理），必须自己 catch 并留日志。
 * `childProjectIds` 是 worktree 子项目：项目记录由 `projects.remove` 一并移除，catalog 引用要自己列。
 */
export const PROJECT_REMOVAL_SESSION_SWEEP_FAILED = "PROJECT_REMOVAL_SESSION_SWEEP_FAILED";

export type ProjectRemovalPort = {
	readonly projects: { remove(id: string): Promise<void> };
	/** 未装配 catalog 时（纯项目场景）跳过第一段：没有引用可清。 */
	readonly sessions?: { removeByProjectId(projectId: string): Promise<number> };
};

export async function removeProjectWithSessions(port: ProjectRemovalPort, projectId: string, options: { readonly childProjectIds?: readonly string[] } = {}): Promise<void> {
	if (port.sessions) {
		for (const id of [projectId, ...(options.childProjectIds ?? [])]) {
			try {
				await port.sessions.removeByProjectId(id);
			} catch (error) {
				throw new Error(PROJECT_REMOVAL_SESSION_SWEEP_FAILED, { cause: error });
			}
		}
	}
	await port.projects.remove(projectId);
}
