import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { FileTreeNode } from "../../../../shared/types";

/** 文件树 owner 状态：节点树与「内容代次」同源，代次只在 nodes 真的换了时才推进。 */
type FileTreeContentState = { nodes: FileTreeNode[]; revision: number };

export type FileTreeContentStateHandle = {
	files: FileTreeNode[];
	/** 单调递增的内容代次：文件树内容真的变了才 +1（只换引用不算）。 */
	fileTreeContentRevision: number;
	setFiles: Dispatch<SetStateAction<FileTreeNode[]>>;
};

/**
 * 文件树 owner 状态：节点树 + 内容代次（文件抽屉按「内容真的变了」防抖重拉 Git 着色）。
 *
 * 为什么要有显式代次：调用方拿 `props.files` 的引用判断「内容变了」会被噪声骗到——
 * 重渲染产生的等价数组、以及遍历重建都会换引用；反过来展开/收起只改视图，本就不该算内容变化。
 * 判据收敛成一条：**setFiles 的更新函数返回同一引用 = 内容没变**（无变化的纯变换必须返回
 * current，见 fileTreeLazy 的 mergeFileTreeChildren / markFileTreeLoadFailed）；返回新树 =
 * 内容变了——懒加载新目录的 children 是新节点、需要着色，必须推进代次。
 * 代次与 nodes 放同一个 state：一次更新只产生一次渲染，且代次与内容永远同步（不会出现
 * 「节点换了、代次没换」的中间态）。updater 里只算新 state，不加额外副作用——同一份 updater
 * 被 StrictMode 跑两次得到的仍是同一结果。
 */
export function useFileTreeContentState(): FileTreeContentStateHandle {
	const [state, setState] = useState<FileTreeContentState>(() => ({ nodes: [], revision: 0 }));
	const setFiles = useCallback<Dispatch<SetStateAction<FileTreeNode[]>>>((next) => {
		setState((current) => {
			const resolved = typeof next === "function" ? next(current.nodes) : next;
			if (resolved === current.nodes) return current;
			return { nodes: resolved, revision: current.revision + 1 };
		});
	}, []);
	return { files: state.nodes, fileTreeContentRevision: state.revision, setFiles };
}
