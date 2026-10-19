import { LoaderCircle, Play, RefreshCw, RotateCw, Square } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { canRunSessionAction, type SessionRunControlView } from "../../utils/sessionCommands";
import { Button } from "../ui-shadcn/button";

/**
 * 会话头部运行工具条：停止回答 / 重启（或启动）/ 重载。
 *
 * 位置固定在会话身份行的右侧，不再浮在消息时间线上：会话标题行本来就是 chrome，
 * 不遮消息、不占额外行，分屏时也天然是每栏一份。
 *
 * 重载按后端分流：pi 是扩展/技能热重载；DSH 没有会话级 reload，入口映射为
 * 「重启 DSH Host」（共享 host，需确认）；ACP 不提供。
 */
export function SessionRunToolbar(props: { control: SessionRunControlView; className?: string }) {
	const { control } = props;
	const capabilities = control.capabilities;
	const primaryIsStart = capabilities.primaryAction === "start";
	const primaryDisabled = !canRunSessionAction(capabilities, capabilities.primaryAction) || Boolean(control.isRestarting) || Boolean(control.isStopping);
	const abortDisabled = !canRunSessionAction(capabilities, "abort") || Boolean(control.isStopping);
	const reloadMode = control.reloadMode ?? "none";
	const reloadAction = reloadMode === "dshHost" ? "reloadDshHost" : "reloadResources";
	const reloadLabel = reloadMode === "dshHost" ? t("menu.restartDshHost") : t("menu.reloadResources");
	const reloadHint = reloadMode === "dshHost" ? t("menu.restartDshHostHint") : t("menu.reloadResourcesHint");
	// DSH host 重启是 host 级操作：草稿/无 runtime 也能做（确认框是最终闸门），
	// 但过渡态仍挡住，避免与正在进行的启动/重启竞争。
	const reloadDisabled = reloadMode === "dshHost" ? Boolean(control.isReloading || control.isStopping || capabilities.pending) : !canRunSessionAction(capabilities, "reloadResources") || Boolean(control.isReloading) || Boolean(control.isStopping);
	const primaryLabel = control.isStopping ? t("app.closing") : control.isRestarting ? t("app.restarting") : primaryIsStart ? t("tabs.startAgent") : t("app.restart");

	return (
		<div role="toolbar" aria-label={t("runControl.toolbar")} className={cn("flex shrink-0 items-center gap-0.5 rounded-md border border-border-strong bg-bg-panel/95 p-0.5 shadow-sm", props.className)}>
			<Button type="button" variant="ghost" size="icon-sm" className={cn("size-7", !abortDisabled && "text-[var(--color-accent)]")} disabled={abortDisabled} title={t("menu.stopAnswer")} aria-label={t("menu.stopAnswer")} onClick={() => control.onAction("abort")}>
				<Square className="size-3" fill="currentColor" strokeWidth={0} aria-hidden="true" />
			</Button>
			<Button type="button" variant="ghost" size="icon-sm" className="size-7" disabled={primaryDisabled} title={primaryLabel} aria-label={primaryLabel} onClick={() => control.onAction(capabilities.primaryAction)}>
				{control.isRestarting || capabilities.pending ? <LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : primaryIsStart ? <Play className="size-3.5" aria-hidden="true" /> : <RotateCw className="size-3.5" aria-hidden="true" />}
			</Button>
			{reloadMode !== "none" ? (
				<Button type="button" variant="ghost" size="icon-sm" className="size-7" disabled={reloadDisabled} title={reloadHint} aria-label={reloadLabel} onClick={() => control.onAction(reloadAction)}>
					{control.isReloading ? <LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
				</Button>
			) : null}
		</div>
	);
}
