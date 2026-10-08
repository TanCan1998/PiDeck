import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteWorkspaceEntry } from "../../../../shared/types/remoteHost";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { sortRemoteEntries } from "./remoteProjectEntries";
import { createRequestGate } from "./remoteRequestGate";

/** 主机未连接是最常见的失败，且与「路径有问题」完全不同：直接说怎么办，而不是只扔稳定码。 */
function isNotConnectedCode(code: string): boolean {
	return code === "SSH_HOST_NOT_READY" || code === "SSH_CONNECTION_FAILED";
}

/**
 * 远端项目只读浏览（Phase 3 第二段）。
 *
 * 与设置页的「远端工作区」不同：这个视图的根来自 `ProjectStore` 中该项目持有的 canonical
 * `remotePath`，因此**跨重启恢复**——它不依赖设置页那个临时的已确认 root。渲染层只给
 * `projectId` 与**相对路径**，主进程解析 host/root 并串行切换会话。
 *
 * 只读：不开放写入、搜索、Git、终端或 Agent。这些能力在远端项目上必须显式禁用，而不是
 * 悄悄落到本机实现（各本地 IPC 已按 locator 拒绝）。
 *
 * 请求代次：切项目、刷新、读文件都开启新一代。IPC 不能中途取消，但迟到的结果可以作废——
 * 旧代次的成功/失败/reject 一律丢弃，绝不能覆盖新项目的状态。loading 只在「本代次仍是
 * 当前代次」时结束，避免旧请求把新请求的 busy 提前清掉。
 *
 * 失败与空目录分开呈现：error 只在请求失败时出现，空目录提示只在**列出成功且为空**时出现，
 * 两者不同时出现（旧实现共用一个 message，失败也可能伴随空提示）。
 */
export function RemoteProjectPanel(props: { projectId: string; projectName: string }) {
	const [entries, setEntries] = useState<RemoteWorkspaceEntry[]>([]);
	const [relative, setRelative] = useState<string[]>([]);
	const [file, setFile] = useState<{ path: string; text: string; bytes: number } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [listed, setListed] = useState(false);
	/** 请求代次闸门；组件卸载时作废所有在途结果。 */
	const gateRef = useRef(createRequestGate());

	useEffect(
		() => () => {
			gateRef.current.invalidate();
		},
		[],
	);

	const relativePath = relative.join("/");

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
		async (segments: string[]) => {
			const gate = gateRef.current;
			const generation = gate.begin();
			setBusy(true);
			setError(null);
			let result: Awaited<ReturnType<typeof desktopApi.remoteHosts.readProjectFile>>;
			try {
				result = await desktopApi.remoteHosts.readProjectFile(props.projectId, segments.join("/"));
			} catch {
				if (gate.isCurrent(generation)) setError(t("project.remote.requestFailed"));
				return;
			} finally {
				if (gate.isCurrent(generation)) setBusy(false);
			}
			if (!gate.isCurrent(generation)) return;
			if (!result.ok) {
				setError(t("project.remote.readFailed", { code: result.code }));
				return;
			}
			// 只读文本预览：二进制在这里没有意义，直接说明而不是渲染乱码。
			const bytes = Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0));
			const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
			setError(null);
			setFile({ path: segments.join("/"), text: text.includes("\u0000") ? t("project.remote.binary") : text, bytes: result.bytes });
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
			{/* 失败提示独立于空目录提示：列出失败时绝不显示「这个目录是空的」。 */}
			{error !== null ? <p className="text-label text-muted-foreground">{error}</p> : null}
			<ul className="flex flex-col gap-0.5">
				{listed && error === null && entries.length === 0 ? <li className="text-label text-muted-foreground">{t("project.remote.empty")}</li> : null}
				{entries.map((entry) => (
					<li key={entry.name} className="shrink-0">
						<button type="button" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-label hover:bg-muted/60" disabled={busy || entry.kind === "other"} onClick={() => void (entry.kind === "directory" ? loadDirectory([...relative, entry.name]) : openFile([...relative, entry.name]))}>
							<span className="truncate">{entry.kind === "directory" ? "📁" : entry.kind === "file" ? "📄" : "🔗"}</span>
							<span className="min-w-0 flex-1 truncate">{entry.name}</span>
							{entry.bytes !== undefined ? <span className="shrink-0 text-muted-foreground">{entry.bytes} B</span> : null}
							{/* 符号链接不跟随：helper 把它报为 other，这里如实禁用而不是假装能打开。 */}
							{entry.kind === "other" ? <span className="shrink-0 text-muted-foreground">{t("project.remote.linkNotFollowed")}</span> : null}
						</button>
					</li>
				))}
			</ul>
			{file !== null ? (
				<div className="flex flex-col gap-1">
					<span className="font-mono text-label text-muted-foreground">
						{file.path === "" ? relativePath : file.path} · {file.bytes} B
					</span>
					<pre className="overflow-auto rounded bg-muted/40 p-2 text-label">{file.text.slice(0, 100_000)}</pre>
				</div>
			) : null}
			<Button variant="ghost" size="sm" className="self-start" disabled={busy} onClick={() => void loadDirectory(relative)}>
				{t("common.refresh")}
			</Button>
		</div>
	);
}
