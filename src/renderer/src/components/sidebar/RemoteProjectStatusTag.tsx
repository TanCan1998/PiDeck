import { useAtomValue } from "jotai";
import { AlertTriangle } from "lucide-react";
import { remoteProjectRootStatusAtom } from "../../atoms/remote-sessions-atoms";
import { t } from "../../i18n";

/**
 * 远端项目行的「需处理」标签（设计 (i) 的呈现端）。
 *
 * 只读 atom，不自己发查询：查询由 useRemoteProjectRootStatuses 随项目清单批量完成并带代次闸门。
 * status=ok / unavailable（含未接线、读不懂）都不渲染任何东西——这条提示的唯一目的是把**需要用户
 * 处理**的项目显式呈现出来，不能变成噪音。
 */
export function RemoteProjectStatusTag(props: { projectId: string }) {
	const statuses = useAtomValue(remoteProjectRootStatusAtom);
	const status = statuses[props.projectId];
	if (status?.status !== "needs-attention") return null;
	// 有稳定码就给码作为排查 hint；没有就只说「需处理」。
	const hint = status.code === null ? t("sidebar.remoteProject.needsAttentionHint") : t("sidebar.remoteProject.needsAttentionHintCode", { code: status.code });
	return (
		<span data-testid="remote-project-needs-attention" className="flex shrink-0 items-center gap-0.5 rounded bg-warning/15 px-1 text-[10px] font-medium leading-4 text-warning" title={hint}>
			<AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
			{t("sidebar.remoteProject.needsAttention")}
		</span>
	);
}
