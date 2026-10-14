import { useCallback, useEffect, useRef, useState } from "react";
import type { GitBranchInfo } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { useAtomValue } from "jotai";
import { projectByIdAtomFamily } from "../atoms/project-atoms";
import { isLocalProject } from "../../../shared/projectLocation";

/** 分支信息轮询周期：与 App Git 抽屉同一节奏，外部终端/IDE 切分支 4s 内追平。 */
const GIT_INFO_POLL_MS = 4000;

type UsePaneGitInfoOptions = {
	/** 分支信息变化（轮询发现变更 / 切换成功或失败回读）时回写；App 只在 projectId 为聚焦项目时采纳。 */
	onChanged?: (projectId: string, info: GitBranchInfo) => void;
	/** 切换分支失败时给调用方的用户反馈；内部已回读最新分支兜底恢复显示。 */
	onSwitchError?: (error: unknown) => void;
};

/**
 * 按项目加载并轮询 Git 分支信息的栏级 hook。
 * 分屏各栏绑定各自会话的 projectId（worktree），分支展示与切换目标都不得跟随
 * App 聚焦项目——否则点击任一栏，所有栏的分支会一起切成该栏项目（历史缺陷）。
 * 状态为栏内 local state：栏间互不重渲染；无 projectId 时保持空态（chip 隐藏）。
 */
export function usePaneGitInfo(projectId: string | undefined, options?: UsePaneGitInfoOptions) {
	const project = useAtomValue(projectByIdAtomFamily(projectId ?? ""));
	const enabled = project !== undefined && isLocalProject(project);
	const [gitInfo, setGitInfo] = useState<GitBranchInfo>({ current: null, branches: [] });
	// 回调走 ref：轮询 effect 只依赖 projectId，回调身份变化不重启定时器。
	const onChangedRef = useRef(options?.onChanged);
	onChangedRef.current = options?.onChanged;
	const onSwitchErrorRef = useRef(options?.onSwitchError);
	onSwitchErrorRef.current = options?.onSwitchError;

	useEffect(() => {
		if (!projectId || !enabled) {
			setGitInfo({ current: null, branches: [] });
			return;
		}
		let stopped = false;
		const refresh = async () => {
			try {
				const next = await desktopApi.git.branches(projectId);
				if (stopped) return;
				// 只在真实变化时更新，避免 4s 轮询写相同对象引发本栏无谓重渲染。
				setGitInfo((current) => (current.current === next.current && current.branches.join("\n") === next.branches.join("\n") ? current : next));
			} catch {
				if (!stopped) setGitInfo({ current: null, branches: [] });
			}
		};
		// 项目身份切换后先清空旧分支再加载新项目，避免短暂显示上一个 worktree 的分支。
		setGitInfo({ current: null, branches: [] });
		void refresh();
		const timer = window.setInterval(() => {
			void refresh();
		}, GIT_INFO_POLL_MS);
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [projectId, enabled]);

	/** 切换分支：目标写死为本栏 projectId，绝不落到全局聚焦项目；成功/回读后通知 App 同步。 */
	const switchBranch = useCallback(
		async (branch: string) => {
			if (!enabled || !projectId || !branch || branch === gitInfo.current) return;
			try {
				const next = await desktopApi.git.checkout(projectId, branch);
				setGitInfo(next);
				onChangedRef.current?.(projectId, next);
			} catch (error) {
				// 失败（脏工作区/冲突被 git 拒绝等）时回读一次真实分支，恢复 chip 显示。
				const refreshed = await desktopApi.git.branches(projectId).catch(() => ({ current: null, branches: [] }));
				setGitInfo(refreshed);
				onChangedRef.current?.(projectId, refreshed);
				onSwitchErrorRef.current?.(error);
			}
		},
		[projectId, enabled, gitInfo.current],
	);

	return { gitInfo, switchBranch };
}
