import { GitStatus, type GitResource, type GitResourceGroups } from "../../../shared/types";

/**
 * 文件树行的 Git 状态着色（IDEA 风格）：
 * - modified：已跟踪且有工作区改动（含暂存修改/重命名/类型变更/删除）→ 蓝（--color-info）
 * - added：已暂存的新文件（含 intent-to-add）→ 绿（--color-success）
 * - untracked：未纳入 git 管理 → 红（--color-danger；IDEA 同款 unversioned 语义，
 *   用户核心诉求：一眼看出哪些文件还没进 git）
 * - conflict：合并冲突 → 琥珀（--color-warning）
 * 与 Git 抽屉的 `--git-*` 色（SCM 只染状态字母、modified 走琥珀）是刻意分歧：
 * 文件树按用户要求沿用 IDEA 的行名语义，两处表面各用各的色语言。
 */
export type FileTreeGitStatus = "modified" | "added" | "untracked" | "conflict";

/** 文件行优先级：同一文件可同时进 index 与 workingTree（先暂存后又改），取信息量最大的状态。 */
const FILE_STATUS_RANK: Record<FileTreeGitStatus, number> = { conflict: 4, added: 3, modified: 2, untracked: 1 };

/** 目录行优先级：子树里有未跟踪文件时优先标红——「这个目录有东西没进 git」比「有已跟踪改动」更值得提醒。 */
const DIR_STATUS_RANK: Record<FileTreeGitStatus, number> = { conflict: 4, untracked: 3, added: 2, modified: 1 };

/** GitStatus → 文件树着色状态；返回 undefined 表示这一条不参与着色。 */
export function fileTreeGitStatusOf(status: GitStatus): FileTreeGitStatus | undefined {
	switch (status) {
		case GitStatus.UNTRACKED:
			return "untracked";
		case GitStatus.INDEX_ADDED:
		case GitStatus.INTENT_TO_ADD:
			return "added";
		case GitStatus.ADDED_BY_US:
		case GitStatus.ADDED_BY_THEM:
		case GitStatus.DELETED_BY_US:
		case GitStatus.DELETED_BY_THEM:
		case GitStatus.BOTH_ADDED:
		case GitStatus.BOTH_DELETED:
		case GitStatus.BOTH_MODIFIED:
			return "conflict";
		// 被忽略的文件既不是「没进管理」也不是「有改动」，显式不染色：默认 status 未带 --ignored
		// 拿不到 IGNORED，这里是护栏——将来打开该开关时不会落进 default 被当成已修改染成蓝色。
		case GitStatus.IGNORED:
			return undefined;
		default:
			return "modified";
	}
}

/**
 * 着色状态 → 行名文本色 utility（Tailwind + 语义 token，不写死色值）：
 * 暗色与各皮肤经 token 自动适配，对比度由主题色板守卫测试兜底。
 * 独立成纯函数的理由：状态与颜色的对应是产品规则，必须能离开 React 单测。
 */
export function fileTreeGitStatusClass(status: FileTreeGitStatus | undefined): string | undefined {
	switch (status) {
		case "modified":
			return "text-info";
		case "added":
			return "text-success";
		case "untracked":
			return "text-danger";
		case "conflict":
			return "text-warning";
		default:
			return undefined;
	}
}

/**
 * 着色状态 → 状态名 i18n key（行 title 与 aria-label 用）。
 * 颜色是唯一信号时色弱用户无从判断，必须有一条文字替代通道。
 */
export function fileTreeGitStatusLabelKey(status: FileTreeGitStatus | undefined): "drawer.gitStatus.modified" | "drawer.gitStatus.added" | "drawer.gitStatus.untracked" | "drawer.gitStatus.conflict" | undefined {
	switch (status) {
		case "modified":
			return "drawer.gitStatus.modified";
		case "added":
			return "drawer.gitStatus.added";
		case "untracked":
			return "drawer.gitStatus.untracked";
		case "conflict":
			return "drawer.gitStatus.conflict";
		default:
			return undefined;
	}
}

/**
 * 着色查找表键：统一 POSIX 分隔符 + 去尾部斜杠，**保留大小写**。
 * 大小写敏感文件系统（Linux/BSD，以及 macOS 的敏感卷）上 `Foo.ts` 与 `foo.ts` 是两个不同文件，
 * 一律折叠会让一个文件的状态染到另一个干净文件上；Windows 这类大小写不敏感平台需要折叠时，
 * 由查表在精确匹配落空后另行兜底（见 buildFileTreeGitStatusLookup）。
 */
export function fileTreeGitKey(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 当前平台的文件系统是否大小写不敏感（Windows / macOS 默认如此）：
 * 只有这种平台才需要「git 索引拼写与磁盘大小写不一致」的兜底。
 * 用 UA 判定而不是主进程 platform 参数：渲染层拿 platform 要过一次异步 IPC，
 * 而判定失败只是退回精确匹配（保守：最多少上一次色，不会误染）。
 */
export function isCaseInsensitiveFileSystem(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Windows|Macintosh|Mac OS X/i.test(navigator.userAgent);
}

/** 行级查询：命中返回着色状态，未命中（干净文件 / 不在 git 里）返回 undefined。 */
export type FileTreeGitStatusLookup = (path: string) => FileTreeGitStatus | undefined;

/** 空查表：非 git 项目 / 加载失败时复用同一引用，避免渲染层无谓重建。 */
export const EMPTY_FILE_TREE_GIT_STATUS: FileTreeGitStatusLookup = () => undefined;

/**
 * 丢掉「嵌套仓库目录被外层仓报成未跟踪」的占位资源。
 * git 不递归进另一个仓库，只把该目录整个报成 untracked；而目录里的真实状态由嵌套仓自己的
 * status 提供（多仓项目已合并）。保留占位会得到「目录标红、内部文件各有各的颜色」的
 * 自相矛盾观感，红色还会顺着祖先目录一路传上去。
 * 只丢未跟踪占位：已跟踪的子模块 gitlink（M）是有效信息，必须保留。
 */
export function dropNestedRepoUntrackedPlaceholders(groups: GitResourceGroups, repoRoots: readonly string[]): GitResourceGroups {
	if (repoRoots.length === 0) return groups;
	const roots = new Set(repoRoots.map(fileTreeGitKey));
	const keep = (resources: GitResource[]) => resources.filter((resource) => !(fileTreeGitStatusOf(resource.status) === "untracked" && roots.has(fileTreeGitKey(resource.path))));
	return { merge: keep(groups.merge), index: keep(groups.index), workingTree: keep(groups.workingTree), untracked: keep(groups.untracked) };
}

/**
 * 合并多个仓库的状态分组（多仓项目：文件树覆盖整个项目，每个仓库的状态都要算）。
 * 直接按组合并资源，让 buildFileTreeGitStatusLookup 统一套用优先级规则——
 * 「根仓把嵌套仓目录当未跟踪」与「嵌套仓自己报的改动」因此会按同一套 rank 收敛，
 * 不需要在这里为目录/文件分别合并（合并时机比合并规则更适合放在一处）。
 */
export function mergeGitResourceGroups(groupsList: readonly GitResourceGroups[]): GitResourceGroups {
	const merged: GitResourceGroups = { merge: [], index: [], workingTree: [], untracked: [] };
	for (const groups of groupsList) {
		merged.merge.push(...groups.merge);
		merged.index.push(...groups.index);
		merged.workingTree.push(...groups.workingTree);
		merged.untracked.push(...groups.untracked);
	}
	return merged;
}

/**
 * 把 GitResourceGroups 折成「文件树路径 → 着色状态」查表：
 * - 资源自身路径按文件语义取状态（同路径多组并存按 FILE_STATUS_RANK 决胜，如先暂存后又改）；
 * - 祖先目录逐级向上聚合子树状态（DIR_STATUS_RANK 决胜）：子树里有未跟踪文件即标红，
 *   因为「这个目录有东西没进 git」比「有已跟踪改动」更值得提醒。
 * 前提是 git 资源路径与文件树节点路径同源（都从 ProjectStore 的项目路径出发）；
 * WSL 项目的 UNC 形态不一致时只会上色失败（静默退化），不会误染。
 * 删除/重命名资源按新路径标记：文件本身已不在树上，着色落在父目录（目录确有变更，语义成立）。
 *
 * `caseInsensitiveFs` 缺省时按当前平台判定；Windows/macOS 上精确匹配落空后再忽略大小写兜底，
 * 折叠键有歧义（两个仅大小写不同的路径并存）时宁可不染色。
 */
export function buildFileTreeGitStatusLookup(groups: GitResourceGroups, projectRoot?: string, options?: { caseInsensitiveFs?: boolean }): FileTreeGitStatusLookup {
	// 两张表分开收集再合并：同一路径可能既是某仓的资源、又是另一仓文件的祖先目录
	// （典型是根仓把嵌套仓目录报成「未跟踪」，而嵌套仓自己已跟踪了一堆文件）。
	// 两张表的优先级表数值不可比，混在一张表里比较会得出随插入顺序变化的结果。
	const fileStatus = new Map<string, FileTreeGitStatus>();
	const dirStatus = new Map<string, FileTreeGitStatus>();
	const put = (map: Map<string, FileTreeGitStatus>, key: string, status: FileTreeGitStatus, rank: Record<FileTreeGitStatus, number>) => {
		const prev = map.get(key);
		if (prev === undefined || rank[status] > rank[prev]) map.set(key, status);
	};
	const rootKey = projectRoot ? fileTreeGitKey(projectRoot) : "";
	for (const group of [groups.merge, groups.index, groups.workingTree, groups.untracked]) {
		for (const resource of group) {
			const status = fileTreeGitStatusOf(resource.status);
			if (status === undefined) continue; // IGNORED 等显式不染色的资源直接跳过
			const fileKey = fileTreeGitKey(resource.path);
			put(fileStatus, fileKey, status, FILE_STATUS_RANK);
			// 祖先目录聚合：截到最后一个 "/" 逐级上走；到项目根（项目根不是树节点）或盘符根即停。
			for (let dir = fileKey.slice(0, fileKey.lastIndexOf("/")); dir; dir = dir.slice(0, dir.lastIndexOf("/"))) {
				if (dir === rootKey) break;
				put(dirStatus, dir, status, DIR_STATUS_RANK);
			}
		}
	}
	// 目录聚合后写入：路径能同时出现在两张表里说明它下面挂着资源（文件不可能有子路径），
	// 按目录语义展示更贴近文件树里实际看到的内容——否则嵌套仓目录会整块标红，
	// 与其内部每个文件的真实状态自相矛盾。
	const exact = new Map<string, FileTreeGitStatus>(fileStatus);
	for (const [key, status] of dirStatus) exact.set(key, status);
	if (!(options?.caseInsensitiveFs ?? isCaseInsensitiveFileSystem())) return (path) => exact.get(fileTreeGitKey(path));
	// 折叠索引：null 表示该折叠键有歧义（两个仅大小写不同的路径同时存在），查询时按未命中处理。
	const folded = new Map<string, FileTreeGitStatus | null>();
	for (const [key, status] of exact) {
		const lower = key.toLowerCase();
		folded.set(lower, folded.has(lower) ? null : status);
	}
	return (path) => {
		const key = fileTreeGitKey(path);
		const hit = exact.get(key);
		if (hit !== undefined) return hit;
		return folded.get(key.toLowerCase()) ?? undefined;
	};
}
