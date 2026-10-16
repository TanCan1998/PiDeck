import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_FILE_TREE_GIT_STATUS, buildFileTreeGitStatusMap, dropNestedRepoUntrackedPlaceholders, fileTreeGitKey, mergeGitResourceGroups, type FileTreeGitStatus } from "../../utils/fileTreeGitStatus";
import type { GitResourceGroups } from "../../../../shared/types";

/**
 * 文件树 Git 着色状态域（IDEA 风格：modified 蓝 / added 绿 / untracked 红 / conflict 琥珀）。
 * 数据复用 GitPanel 同一 `git:status` IPC；非 git 项目 / git 未安装时静默退化为无着色
 * （文件树不是 git 面板，不该弹错误提示）。
 * 多仓项目与 Git 抽屉同语义：项目内每个仓库都取一次状态后合并——只取项目根会把
 * 「根目录不是仓库、子目录才是」的项目整盘弄成无着色，文件树又覆盖整个项目。
 * 刷新时机由调用方驱动：面板挂载与切项目（本 hook 自带）、刷新按钮、文件树内容变化后的防抖
 * 重拉（FilesPanel 内）。agent 改文件不会自动重扫文件树，着色与树同节奏陈旧、同按钮刷新。
 */
export function useFileTreeGitStatus(options: { projectId?: string; projectRoot?: string }) {
	const [statusMap, setStatusMap] = useState<ReadonlyMap<string, FileTreeGitStatus>>(EMPTY_FILE_TREE_GIT_STATUS);
	// 代次防竞态：切项目后迟到的旧请求不能覆盖新项目的着色（同 files:list 的防竞态思路）。
	const requestSeqRef = useRef(0);
	// projectId/projectRoot 走 ref：refresh 保持恒定引用，调用方 effect 不因它重跑。
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const refresh = useCallback(async () => {
		const { projectId, projectRoot } = optionsRef.current;
		if (!projectId) {
			setStatusMap(EMPTY_FILE_TREE_GIT_STATUS);
			requestSeqRef.current += 1;
			return;
		}
		const seq = ++requestSeqRef.current;
		try {
			// 根仓的 repo.path 就是项目根，传给 git:status 与缺省 scope 等价。
			const repos = await window.piDesktop.git.listRepos(projectId);
			// 嵌套仓目录会被外层仓整个报成未跟踪（git 不递归进另一个仓库），
			// 这些占位项按嵌套仓自己的状态处理（见 dropNestedRepoUntrackedPlaceholders）。
			const nestedRepoRoots = repos.filter((repo) => repo.relativePath !== "").map((repo) => repo.path);
			const groupsList = (
				await Promise.all(
					repos.map(async (repo) => {
						try {
							return dropNestedRepoUntrackedPlaceholders(await window.piDesktop.git.status(projectId, repo.path), nestedRepoRoots);
						} catch {
							// 单个仓库失败（仓刚被删 / 权限变化）不能让整盘着色归零：跳过它，其余照常上色。
							return null;
						}
					}),
				)
			).filter((groups): groups is GitResourceGroups => groups !== null);
			if (seq !== requestSeqRef.current) return; // 迟到的旧请求：静默丢弃
			setStatusMap(buildFileTreeGitStatusMap(mergeGitResourceGroups(groupsList), projectRoot));
		} catch {
			// 非 git 项目 / 发现仓库失败：着色整体退场。保留旧表反而会误导（项目可能刚被拆分）。
			if (seq === requestSeqRef.current) setStatusMap(EMPTY_FILE_TREE_GIT_STATUS);
		}
	}, []);

	// 挂载与项目切换即时拉取；projectRoot 不单独触发（换仓库根时 projectId 必先变）。
	useEffect(() => {
		void refresh();
	}, [refresh, options.projectId]);

	// 卸载作废在途请求，防止 setState 落到已卸载组件
	useEffect(
		() => () => {
			requestSeqRef.current += 1;
		},
		[],
	);

	/** 行级查询：树节点渲染时按路径 O(1) 查表（未命中 = 该行不上色）。 */
	const statusOf = useCallback((path: string): FileTreeGitStatus | undefined => statusMap.get(fileTreeGitKey(path)), [statusMap]);

	return { statusOf, refresh };
}
