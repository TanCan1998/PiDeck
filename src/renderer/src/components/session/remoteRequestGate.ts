/**
 * 异步请求代次闸门（远端面板用）。
 *
 * IPC 调用无法中途取消，但**结果可以作废**：切项目、刷新、组件卸载都会开启新一代，
 * 旧代次的成功/失败/reject 一律不得回写当前状态（否则旧项目的目录会盖到新项目上）。
 * 抽成纯函数是为了让「迟到结果被丢弃」这条规则能离开 React 单测。
 */
export function createRequestGate() {
	let current = 0;
	return {
		/** 发起请求前开启新一代，返回本代次编号。 */
		begin: () => ++current,
		/** 本代次是否仍有效；无效则丢弃结果（含错误）。 */
		isCurrent: (generation: number) => generation === current,
		/** 作废所有在途结果（组件卸载/切项目时调用）。 */
		invalidate: () => {
			current += 1;
		},
	};
}
