import { useAtomValue } from "jotai";
import { useCallback, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronRight, FileText, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui-shadcn/collapsible";
import { FileTreeIndentGuides } from "./FileTreeIndentGuides";
import { getFileIconSeti, getFileIconColor, getFileTypeLabel } from "../../fileIcons";
import { activeEditorFileAtom } from "../../atoms/app-ui-atoms";
import { writeFileNodeDragPayload } from "../app/AppUtils";
import { t } from "../../i18n";
import { fileTreeGitStatusClass, fileTreeGitStatusLabelKey, type FileTreeGitStatus } from "../../utils/fileTreeGitStatus";
import type { FileTreeNode } from "../../../../shared/types";

/**
 * 文件树行（含递归子树）：文件/目录行的图标、缩进、吸顶、拖放与 Git 状态着色。
 * 从 WorkspaceSurface 整块迁出（该文件已超体量红线）：迁出时行为零变化，
 * 面板只负责工具行/排序/搜索与把查表函数透传进来。
 */

function fileIconElement(name: string, isDirectory: boolean, isExpanded: boolean) {
	if (isDirectory) {
		return isExpanded ? <FolderOpen size={18} aria-hidden="true" /> : <Folder size={18} aria-hidden="true" />;
	}
	try {
		const { svg, colorName } = getFileIconSeti(name);
		const color = getFileIconColor(colorName);
		// SVG 只来自仓库内附带许可证的只读 Seti 数据快照，不接收文件内容或用户输入。
		// 尺寸由 .file-node-seti-icon → --file-type-icon-size（24px）承担，与目录行共存于同一 24px 图标槽。
		return <span aria-hidden="true" className="file-node-seti-icon" style={{ color }} dangerouslySetInnerHTML={{ __html: svg }} />;
	} catch {
		return <FileText size={16} aria-hidden="true" />;
	}
}

/* 行高与工具行高度各为 28px：目录吸顶在固定工具行下面，不与操作按钮重叠。 */
const FILE_ROW_HEIGHT_PX = 28;
const FILE_TOOLBAR_HEIGHT_PX = 28;
/* 最外层最多三行吸顶；缩进只放在行内，所有层的行盒都覆盖完整面板宽度。 */
const FILE_STICKY_MAX_LEVELS = 3;

export function FileNode(props: {
	node: FileTreeNode;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onOpenFile?: (path: string) => void;
	/** 单击默认预览；第二参 permanent = 双击常驻 */
	onViewFile?: (path: string, openMode?: "preview" | "permanent") => void;
	depth?: number;
	/** 拖入文件（仅目录节点使用） */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	/** 内部拖拽移动文件/目录 */
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
	dragOverDir?: string | null;
	onDragOverDirChange?: (path: string | null) => void;
	/** Git 状态查表（IDEA 风格行名着色）：untracked/modified/added/conflict；缺省（非 git 项目/未加载）不上色 */
	gitStatusOf?: (path: string) => FileTreeGitStatus | undefined;
}) {
	const { node, expandedDirs, onToggleDirectory, depth = 0 } = props;
	const expanded = expandedDirs.has(node.path);
	/* 当前活跃编辑器文件高亮：单击预览即点亮，双击常驻、切换 tab 同步跟随（activeEditorFileAtom 由 useFileEditor 写入）。
	   树行跨六层 props 链，订阅 atom 而非透传。 */
	const activeEditorFile = useAtomValue(activeEditorFileAtom);
	const isActiveFile = node.type === "file" && node.path === activeEditorFile;
	// Git 着色查表：文件行取自身状态，目录行取子树聚合状态（构建见 fileTreeGitStatus.ts）。
	const gitStatus = props.gitStatusOf?.(node.path);
	// 活跃编辑器行的选中高亮优先：不叠加着色类，避免 git 色压掉选中态。
	const gitStatusClass = isActiveFile ? undefined : fileTreeGitStatusClass(gitStatus);
	// 文字替代通道：颜色是唯一信号时色弱用户无从判断，title / aria-label 里带上状态名。
	const gitStatusLabelKey = fileTreeGitStatusLabelKey(gitStatus);
	const gitStatusLabel = gitStatusLabelKey ? t(gitStatusLabelKey) : "";
	const typeLabel = node.type === "file" ? getFileTypeLabel(node.name) : "";
	// 对应 VS Code defaultIndent + depth × indent；外层不缩进，全宽背景保持不变。
	const rowStyle: CSSProperties = {
		paddingLeft: `calc(var(--space-2) + ${depth * 8}px)`,
		paddingRight: "var(--space-2)",
	};
	const menu = (event: ReactMouseEvent) => {
		event.preventDefault();
		props.onFileContextMenu(node, event.clientX, event.clientY);
	};
	// 内部拖拽移动：dataTransfer 携带源路径，目录行是落点；OS 文件拖入则是复制
	// effectAllowed=copyMove：目录落点显式选 move（内部移动），composer 落点选 copy（插入 @ 引用）
	const handleDragStart = useCallback(
		(event: React.DragEvent) => {
			event.dataTransfer.effectAllowed = "copyMove";
			writeFileNodeDragPayload(event.dataTransfer, node);
		},
		[node],
	);
	const handleDragOver = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer.dropEffect = "move";
			props.onDragOverDirChange?.(node.path);
		},
		[node.path, props.onDragOverDirChange],
	);
	const handleDragLeave = useCallback(() => {
		props.onDragOverDirChange?.(null);
	}, [props.onDragOverDirChange]);
	const handleDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			props.onDragOverDirChange?.(null);
			// 内部拖拽移动：优先检查 pi-file-path
			const sourcePath = event.dataTransfer.getData("text/pi-file-path");
			if (sourcePath) {
				if (sourcePath !== node.path && props.onMoveFiles) {
					props.onMoveFiles([sourcePath], node.path);
				}
				return;
			}
			// 外部 OS 文件拖入：复制到目标目录
			if (event.dataTransfer.files.length > 0 && props.onDropFiles) {
				props.onDropFiles(node.path, event.dataTransfer.files);
			}
		},
		[node.path, props.onDropFiles, props.onMoveFiles, props.onDragOverDirChange],
	);
	const isDragOver = props.dragOverDir === node.path;
	/* 树行用原生 button，不用 shadcn Button：后者基类强制子 SVG size-4，
	   会压掉 Seti --file-type-icon-size 与 lucide size，靠 ! 反压是补丁。
	   2027-01：hover 高亮加与侧栏行同款的过渡动画（transition-[background-color,
	   border-color,box-shadow] duration-200），移入文件列表时背景平滑渐变而非瞬切。 */
	/* 按下底色显式收口到 hover 同一档（active:bg-muted）：legacy `.file-node-row:active` 已删，
	   否则键盘/触摸激活会落在 bg-active 面上——该面上状态色对比度不达 AA（themeContrast 契约）。 */
	const fileRowButtonClass =
		"file-node-row flex h-[28px] min-h-0 w-full items-center justify-start gap-1.5 rounded-sm border-0 bg-transparent py-0 text-left text-body font-normal text-foreground transition-[background-color,border-color,box-shadow] duration-base hover:bg-muted active:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset relative";
	if (node.type === "file")
		return (
			<div className="file-node">
				<button
					type="button"
					className={cn("file", fileRowButtonClass, isActiveFile && "bg-accent text-accent-foreground hover:bg-accent active:bg-accent")}
					style={rowStyle}
					title={gitStatusLabel ? `${node.relativePath}\n${typeLabel} · ${gitStatusLabel}` : `${node.relativePath}\n${typeLabel}`}
					aria-label={gitStatusLabel ? `${node.name} · ${gitStatusLabel}` : undefined}
					draggable
					onDragStart={handleDragStart}
					onClick={() => props.onViewFile?.(node.path)}
					onDoubleClick={(event) => {
						event.preventDefault();
						props.onViewFile?.(node.path, "permanent");
					}}
					onContextMenu={menu}
				>
					<FileTreeIndentGuides depth={depth} />
					{/* 文件也保留 16px twistie 槽位，确保与同级目录的图标和名称对齐。 */}
					<span data-file-tree-twistie="" aria-hidden="true" className="h-full w-4 shrink-0" />
					<span className="file-node-icon">{fileIconElement(node.name, false, false)}</span>
					<span className={cn("file-node-name", gitStatusClass)}>{node.name}</span>
					<span className="file-node-type-label">{typeLabel}</span>
				</button>
			</div>
		);
	/* 吸顶沿用原行的事件与内容；全宽不透明背景负责遮住滚动内容。
	   z-10 避免子树覆盖行，底部阴影只由几何 hook 标在真正吸顶的最后一行。
	   注意：行必须是块级 flex（不是 inline-flex）——行内级盒会让 .file-node 容器多出
	   行盒空隙（实测行距 33px > 行高 28px），相邻两行的引导线之间就裂出 5px 缝，
	   吸顶行之间也会露出滚动内容。 */
	const stickyRow = depth < FILE_STICKY_MAX_LEVELS;
	return (
		<div className="file-node">
			<Collapsible open={expanded} onOpenChange={() => onToggleDirectory(node.path)}>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className={cn("directory group", fileRowButtonClass, "rounded-none", stickyRow && "sticky z-10 bg-background data-[file-sticky-last=true]:shadow-sm", isDragOver && "bg-muted ring-1 ring-border")}
						data-file-sticky-level={stickyRow ? depth : undefined}
						style={stickyRow ? { ...rowStyle, top: `${FILE_TOOLBAR_HEIGHT_PX + depth * FILE_ROW_HEIGHT_PX}px` } : rowStyle}
						title={gitStatusLabel ? `${node.relativePath}\n${gitStatusLabel}` : node.relativePath}
						aria-label={gitStatusLabel ? `${node.name} · ${gitStatusLabel}` : undefined}
						draggable
						onDragStart={handleDragStart}
						onDragOver={handleDragOver}
						onDragLeave={handleDragLeave}
						onDrop={handleDrop}
						onContextMenu={menu}
					>
						<FileTreeIndentGuides depth={depth} />
						{/* 对应 VS Code 的 16px twistie 与 3px 视觉偏移；占位宽度不随展开状态改变。 */}
						<span data-file-tree-twistie="" aria-hidden="true" className="inline-flex h-full w-4 shrink-0 translate-x-[3px] items-center justify-center">
							<ChevronRight
								className={cn(
									"file-node-chevron size-3.5 shrink-0 transition-transform",
									/* 受控 Collapsible 的 data-state 时序不可靠，显式跟随 expanded。 */
									expanded ? "rotate-90" : "rotate-0",
								)}
								aria-hidden="true"
							/>
						</span>
						<span className="file-node-icon">{fileIconElement(node.name, true, expanded)}</span>
						<span className={cn("file-node-name", gitStatusClass)}>{node.name}</span>
					</button>
				</CollapsibleTrigger>
				{/* overflow-clip 取代默认的 overflow-hidden：hidden 会让本层变成「不滚动的 scrollport」，
				   深层目录行的 sticky 只相对它生效（等于不挂顶）；clip 同样按 padding box 裁剪、
				   高度动画观感不变，但不建立滚动容器，挂顶仍相对抽屉滚动层（.files-panel）。 */}
				<CollapsibleContent className="overflow-clip">
					{/* 懒加载占位与加载失败态：二者互斥，都不会再盖住文件名。
					 - 占位独立成行（不是行内绝对定位），children 到位后整行消失；
					 - hasChildren=false 表示目录 listing 已失败或目录为空，不展示占位。
					 展开态的 chevron 修正：expanded 且子项未加载时 data-[state=open] 不生效
					 （Collapsible 由 open 受控，这里直接按 expanded 旋转）。 */}
					{expanded && node.hasChildren !== false && !node.children && (
						<div className="file-children flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
							<LoaderCircle size={12} className="animate-pideck-spin shrink-0" aria-hidden="true" />
							<span>{t("drawer.lazyLoading")}</span>
						</div>
					)}
					{node.children && node.children.length > 0 && (
						<div className="file-children">
							{node.children.map((child) => (
								<FileNode
									key={child.path}
									node={child}
									expandedDirs={expandedDirs}
									onToggleDirectory={onToggleDirectory}
									onFileContextMenu={props.onFileContextMenu}
									onOpenFile={props.onOpenFile}
									onViewFile={props.onViewFile}
									onDropFiles={props.onDropFiles}
									onMoveFiles={props.onMoveFiles}
									dragOverDir={props.dragOverDir}
									onDragOverDirChange={props.onDragOverDirChange}
									gitStatusOf={props.gitStatusOf}
									depth={depth + 1}
								/>
							))}
						</div>
					)}
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
