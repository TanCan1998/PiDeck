import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, FileText, Folder, Link2, Loader2, Search, X } from "lucide-react";
import type { RemoteWorkspaceEntry } from "../../../../shared/types/remoteHost";
import { desktopApi } from "../../desktopApi";
import { useRemoteProjectSearch, REMOTE_SEARCH_UNWIRED_CODE } from "../../hooks/useRemoteProjectSearch";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { sortRemoteEntries } from "./remoteProjectEntries";
import { createRequestGate } from "./remoteRequestGate";
import { RemoteFileEditor } from "../workspace/RemoteFileEditor";
import type { RemoteSearchEntryView } from "./remoteProjectSearchState";

/** 主机未连接是最常见的失败，且与「路径有问题」完全不同：直接说怎么办，而不是只扔稳定码。 */
function isNotConnectedCode(code: string): boolean {
	return code === "SSH_HOST_NOT_READY" || code === "SSH_CONNECTION_FAILED";
}

/**
 * 远端项目目录浏览 + 文件名搜索 + 已有文本文件编辑。
 *
 * 与设置页的「远端工作区」不同：这个视图的根来自 \`ProjectStore\` 中该项目持有的 canonical
 * \`remotePath\`，因此**跨重启恢复**——它不依赖设置页那个临时的已确认 root。渲染层只给
 * \`projectId\` 与**相对路径**，主进程解析 host/root 并串行切换会话。
 *
 * 文件名搜索仍走只读helper；已有文本文件在独立编辑宿主中显式保存，不开放新建/删除/Git/终端。
 * 远端路径绝不进本地 fs/Git/终端。
 *
 * 请求代次：切项目、刷新、读文件都开启新一代。IPC 不能中途取消，但迟到的结果可以作废——
 * 旧代次的成功/失败/reject 一律丢弃，绝不能覆盖新项目的状态。搜索用的是同一个闸门（\`remoteRequestGate\`
 * 的语义由 \`useRemoteProjectSearch\` 持有），因此「新查询被旧结果覆盖」在状态机层面就不可能发生。
 *
 * 失败与空目录分开呈现：error 只在请求失败时出现，空目录提示只在**列出成功且为空**时出现，
 * 两者不同时出现。搜索同理：空结果、被截断、错误是三种不同呈现——**截断绝不假装完整**。
 */
export function RemoteProjectPanel(props: { projectId: string; projectName: string }) {
	const [entries, setEntries] = useState<RemoteWorkspaceEntry[]>([]);
	const [relative, setRelative] = useState<string[]>([]);
	const [file, setFile] = useState<{ projectId: string; path: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [listed, setListed] = useState(false);
	const [query, setQuery] = useState("");
	/** 请求代次闸门；组件卸载时作废所有在途结果。 */
	const gateRef = useRef(createRequestGate());
	/** 搜索状态机（自带代次闸门）；切项目由 hook 负责作废旧结果。 */
	const { state: search, run: runSearch, reset: resetSearch } = useRemoteProjectSearch(desktopApi, props.projectId);

	useEffect(
		() => () => {
			gateRef.current.invalidate();
		},
		[],
	);

	const searching = search.phase !== "idle";

	const loadDirectory = useCallback(
		async (segments: string[]) => {
			const gate = gateRef.current;
			const generation = gate.begin();
			setBusy(true);
			setError(null);
			let result: Awaited<ReturnType<typeof desktopApi.remoteHosts.listProject>>;
			try {
				result = await desktopApi.remoteHosts.listProject(props.projectId, segments.join("/"));
			} catch {
				// IPC reject：不是「目录不存在」，只能说请求失败并让用户重试/查连接。
				if (!gate.isCurrent(generation)) return;
				setListed(false);
				setEntries([]);
				setError(t("project.remote.requestFailed"));
				return;
			} finally {
				if (gate.isCurrent(generation)) setBusy(false);
			}
			if (!gate.isCurrent(generation)) return;
			if (!result.ok) {
				// 列出失败不能再声称「已列出」：否则空目录提示会和错误同时出现，互相矛盾。
				setListed(false);
				setEntries([]);
				setError(isNotConnectedCode(result.code) ? t("project.remote.notConnectedHint") : t("project.remote.listFailed", { code: result.code }));
				return;
			}
			setError(null);
			setListed(true);
			setRelative(segments);
			setFile(null);
			setEntries(sortRemoteEntries(result.entries));
		},
		[props.projectId],
	);

	const openFile = useCallback(
		(segments: string[]) => {
			gateRef.current.invalidate();
			setBusy(false);
			setError(null);
			setFile({ projectId: props.projectId, path: segments.join("/") });
		},
		[props.projectId],
	);

	// 切换项目时必须重读，且不能沿用上一个项目的目录状态。
	useEffect(() => {
		setRelative([]);
		setFile(null);
		setListed(false);
		setError(null);
		void loadDirectory([]);
	}, [loadDirectory]);

	/** 搜索失败文案：未接线 / 主机未连接 / 稳定码三种，分别给出用户能行动的说法。 */
	const searchFailedText = (code: string | null): string => {
		if (code === null) return t("project.remote.requestFailed");
		if (code === REMOTE_SEARCH_UNWIRED_CODE) return t("project.remote.searchUnwired");
		return isNotConnectedCode(code) ? t("project.remote.notConnectedHint") : t("project.remote.searchFailed", { code });
	};

	/** 点开一条搜索结果：远端 path 本来就是相对项目根的，直接拆段导航；搜索态随之清空。 */
	const openResult = useCallback(
		(entry: RemoteSearchEntryView) => {
			const segments = entry.path.split("/");
			resetSearch();
			setQuery("");
			void (entry.kind === "directory" ? loadDirectory(segments) : openFile(segments));
		},
		[loadDirectory, openFile, resetSearch],
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
			<div className="flex flex-wrap items-center gap-2 text-label">
				<span className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">{t("project.remote.badge")}</span>
				<strong className="text-body font-semibold text-foreground">{props.projectName}</strong>
				<span className="text-muted-foreground">{t("project.remote.title")}</span>
			</div>
			<nav className="flex flex-wrap items-center gap-1 text-label">
				<button type="button" className="underline" disabled={busy} onClick={() => void loadDirectory([])}>
					/
				</button>
				{relative.map((crumb, index) => (
					<span key={relative.slice(0, index + 1).join("/")} className="flex items-center gap-1">
						<button type="button" className="underline" disabled={busy} onClick={() => void loadDirectory(relative.slice(0, index + 1))}>
							{crumb}
						</button>
						{index < relative.length - 1 ? <span className="text-muted-foreground">/</span> : null}
					</span>
				))}
			</nav>
			<form
				className="flex items-center gap-1"
				onSubmit={(event) => {
					event.preventDefault();
					if (query.length > 0 && !busy) void runSearch(query);
				}}
			>
				<Input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={128} disabled={busy} placeholder={t("project.remote.searchPlaceholder")} aria-label={t("project.remote.searchPlaceholder")} className="h-8 min-w-0 flex-1 text-label" />
				<Button type="submit" variant="secondary" size="sm" disabled={busy || query.length === 0}>
					<Search className="size-3.5" />
					{t("project.remote.searchAction")}
				</Button>
				{searching ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						title={t("project.remote.searchClear")}
						aria-label={t("project.remote.searchClear")}
						onClick={() => {
							resetSearch();
							setQuery("");
						}}
					>
						<X className="size-3.5" />
					</Button>
				) : null}
			</form>
			{/* 失败提示独立于空目录提示：列出失败时绝不显示「这个目录是空的」；搜索态下由搜索自己报告错误。 */}
			{error !== null && !searching ? <p className="text-label text-muted-foreground">{error}</p> : null}
			{!searching ? (
				<ul className="flex flex-col gap-0.5">
					{listed && error === null && entries.length === 0 ? <li className="text-label text-muted-foreground">{t("project.remote.empty")}</li> : null}
					{entries.map((entry) => (
						<li key={entry.name} className="shrink-0">
							<button type="button" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-label hover:bg-muted/60" disabled={busy || entry.kind === "other"} onClick={() => void (entry.kind === "directory" ? loadDirectory([...relative, entry.name]) : openFile([...relative, entry.name]))}>
								{entry.kind === "directory" ? <Folder className="size-3.5 shrink-0" /> : entry.kind === "file" ? <FileText className="size-3.5 shrink-0" /> : <Link2 className="size-3.5 shrink-0" />}
								<span className="min-w-0 flex-1 truncate">{entry.name}</span>
								{entry.bytes !== undefined ? <span className="shrink-0 text-muted-foreground">{entry.bytes} B</span> : null}
								{/* 符号链接不跟随：helper 把它报为 other，这里如实禁用而不是假装能打开。 */}
								{entry.kind === "other" ? <span className="shrink-0 text-muted-foreground">{t("project.remote.linkNotFollowed")}</span> : null}
							</button>
						</li>
					))}
				</ul>
			) : (
				<div className="flex flex-col gap-1">
					{search.phase === "searching" ? (
						<p className="flex items-center gap-1 text-label text-muted-foreground">
							<Loader2 className="size-3.5 animate-pideck-spin" />
							{t("project.remote.searching")}
						</p>
					) : null}
					{search.phase === "error" ? <p className="text-label text-muted-foreground">{searchFailedText(search.errorCode)}</p> : null}
					{search.phase === "empty" ? <p className="text-label text-muted-foreground">{t("project.remote.searchEmpty")}</p> : null}
					{search.phase === "results" ? (
						<>
							<p className="text-label text-muted-foreground">{t("project.remote.searchSummary", { count: search.entries.length, scanned: search.scanned })}</p>
							{/* truncated 如实来自主进程：被截断就必须明说，绝不呈现成完整结果。 */}
							{search.truncated ? (
								<p className="flex items-start gap-1 text-label text-muted-foreground">
									<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
									{t("project.remote.searchTruncated")}
								</p>
							) : null}
							<ul className="flex flex-col gap-0.5">
								{search.entries.map((entry) => (
									<li key={entry.path} className="shrink-0">
										<button type="button" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-label hover:bg-muted/60" disabled={busy || entry.kind === "other"} onClick={() => openResult(entry)}>
											{entry.kind === "directory" ? <Folder className="size-3.5 shrink-0" /> : entry.kind === "file" ? <FileText className="size-3.5 shrink-0" /> : <Link2 className="size-3.5 shrink-0" />}
											<span className="min-w-0 flex-1 truncate">{entry.name}</span>
											<span className="min-w-0 max-w-[45%] truncate font-mono text-muted-foreground">{entry.path}</span>
											{entry.bytes !== undefined ? <span className="shrink-0 text-muted-foreground">{entry.bytes} B</span> : null}
											{entry.kind === "other" ? <span className="shrink-0 text-muted-foreground">{t("project.remote.linkNotFollowed")}</span> : null}
										</button>
									</li>
								))}
							</ul>
						</>
					) : null}
				</div>
			)}
			{file !== null && file.projectId === props.projectId ? <RemoteFileEditor key={JSON.stringify([file.projectId, file.path])} projectId={file.projectId} path={file.path} /> : null}
			<Button variant="ghost" size="sm" className="self-start" disabled={busy} onClick={() => void loadDirectory(relative)}>
				{t("common.refresh")}
			</Button>
		</div>
	);
}
