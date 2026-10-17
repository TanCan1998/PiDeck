import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RotateCcw, Trash2 } from "lucide-react";
import type { RemoteTrashEntry } from "../../../../shared/types/remoteFiles";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { remoteFileEntryErrorKey } from "./remoteFileManagementState";

export type RemoteTrashOutcome = { kind: "success" | "failed" | "unknown"; text: string } | null;

/**
 * 回收站折叠区（§6.7/§10.2/§10.4）：展开即手动加载、无轮询；列表只来自 main 严格重验后的条目。
 *
 * reloadToken 由面板在 delete/restore/prune 成功后递增——成功只做显式刷新，不自动轮询。
 * 还原/清空走面板注入的同一套写命令（与目录操作共享单飞状态），本组件不直接发写 IPC。
 */
export function RemoteTrashPanel(props: { projectId: string; open: boolean; reloadToken: number; busy: boolean; outcome: RemoteTrashOutcome; onRestore: (id: string) => void; onRequestPrune: (ids: string[], count: number) => void }) {
	const [entries, setEntries] = useState<RemoteTrashEntry[]>([]);
	const [truncated, setTruncated] = useState(false);
	const [loading, setLoading] = useState(false);
	const [errorCode, setErrorCode] = useState<string | null>(null);
	const load = useCallback(async () => {
		setLoading(true);
		setErrorCode(null);
		try {
			const result = await desktopApi.remoteHosts.listProjectTrash(props.projectId);
			if (result.ok) {
				setEntries(result.entries);
				setTruncated(result.truncated);
			} else {
				setErrorCode(result.code);
			}
		} catch {
			setErrorCode("REMOTE_FILE_COMMAND_FAILED");
		} finally {
			setLoading(false);
		}
	}, [props.projectId]);
	useEffect(() => {
		// 展开或写操作成功后显式重载；收起状态不请求。
		if (props.open) void load();
	}, [props.open, props.reloadToken, load]);
	if (!props.open) return null;
	const now = Date.now();
	const visible = entries;
	return (
		<section data-testid="remote-trash" className="flex shrink-0 flex-col gap-1 border-t border-border pt-2">
			<div className="flex items-center gap-2">
				<strong className="text-label font-semibold">{t("remoteTrash.title")}</strong>
				{loading ? <Loader2 className="size-3.5 animate-pideck-spin" aria-label={t("remoteTrash.title")} /> : null}
				<Button
					type="button"
					size="sm"
					variant="ghost"
					data-testid="remote-trash-prune"
					disabled={props.busy || loading || visible.length === 0}
					onClick={() =>
						props.onRequestPrune(
							visible.map((entry) => entry.id),
							visible.length,
						)
					}
				>
					<Trash2 className="size-3.5" />
					{t("remoteTrash.prune")}
				</Button>
			</div>
			{errorCode !== null ? <p className="text-label text-destructive">{t(remoteFileEntryErrorKey(errorCode), { code: errorCode })}</p> : null}
			{!loading && errorCode === null && visible.length === 0 ? <p className="text-label text-muted-foreground">{t("remoteTrash.empty")}</p> : null}
			{truncated ? (
				<p data-testid="remote-trash-truncated" className="flex items-start gap-1 text-label text-muted-foreground">
					<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
					{t("remoteTrash.truncated", { count: visible.length })}
				</p>
			) : null}
			<ul className="flex flex-col gap-0.5">
				{visible.map((entry) => {
					const expired = entry.expiresAt !== "" && Date.parse(entry.expiresAt) < now;
					const stateLabel = entry.state === "invalid" ? t("remoteTrash.invalidEntry") : entry.state === "payload-missing" ? t("remoteTrash.payloadMissing") : entry.state === "payload-changed" ? t("remoteTrash.payloadChanged") : null;
					return (
						<li key={entry.id} data-testid="remote-trash-row" className="flex shrink-0 items-center gap-2 rounded px-1 py-0.5 text-label">
							<span className="min-w-0 flex-1 truncate font-mono">{entry.originalPath === "" ? entry.id : entry.originalPath}</span>
							{entry.bytes !== undefined ? <span className="shrink-0 text-muted-foreground">{entry.bytes} B</span> : null}
							{entry.deletedAt !== "" ? <span className="shrink-0 text-muted-foreground">{t("remoteTrash.deletedAt", { time: new Date(entry.deletedAt).toLocaleString() })}</span> : null}
							{stateLabel !== null ? <span className="shrink-0 text-muted-foreground">{stateLabel}</span> : null}
							{expired ? (
								<span data-testid="remote-trash-expired" className="shrink-0 text-muted-foreground">
									{t("remoteFileEntry.expired")}
								</span>
							) : null}
							<Button type="button" size="sm" variant="ghost" data-testid="remote-trash-restore" disabled={props.busy || entry.state !== "intact"} onClick={() => props.onRestore(entry.id)}>
								<RotateCcw className="size-3.5" />
								{t("remoteTrash.restore")}
							</Button>
						</li>
					);
				})}
			</ul>
			<p className="text-label text-muted-foreground">{t("remoteTrash.gitNote")}</p>
			<p data-testid="remote-trash-outcome" aria-live="polite" className="min-h-5 truncate text-label text-muted-foreground">
				{props.outcome?.text ?? ""}
			</p>
		</section>
	);
}
