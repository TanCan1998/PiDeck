import { LoaderCircle, Play, RefreshCw, RotateCw, Square } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { canRunSessionAction, type SessionRunControlView } from "../../utils/sessionCommands";
import { Button } from "../ui-shadcn/button";

/**
 * 会话区悬停运行工具条：停止回答 / 重启（或启动）/ 热重载。
 *
 * 为什么用悬停：用户明确不要常驻一排按钮；工具条只在鼠标进入时间线时出现，
 * 忙碌/重启/重载时强制可见以展示进度。不占常驻宽度，也不挤占消息列。
 * 主操作仍是 `⋯` 菜单（关闭 Agent、复制 ID、会话操作等低频项在那里）。
 */
export function SessionRunHoverToolbar(props: { control: SessionRunControlView; className?: string }) {
	const { control } = props;
	const capabilities = control.capabilities;
	const busy = Boolean(control.isStopping || control.isRestarting || control.isReloading || capabilities.pending);
	const primaryIsStart = capabilities.primaryAction === "start";
	const primaryDisabled = !canRunSessionAction(capabilities, capabilities.primaryAction) || Boolean(control.isRestarting) || Boolean(control.isStopping);
	const abortDisabled = !canRunSessionAction(capabilities, "abort") || Boolean(control.isStopping);
	const hotReloadDisabled = !control.supportsHotReload || !canRunSessionAction(capabilities, "reloadResources") || Boolean(control.isReloading) || Boolean(control.isStopping);
	const primaryLabel = control.isStopping ? t("app.closing") : control.isRestarting ? t("app.restarting") : primaryIsStart ? t("tabs.startAgent") : t("app.restart");

	return (
		<div
			className={cn(
				"pointer-events-none invisible opacity-0 transition-opacity duration-150 group-hover/timeline:pointer-events-auto group-hover/timeline:visible group-hover/timeline:opacity-100 group-focus-within/timeline:pointer-events-auto group-focus-within/timeline:visible group-focus-within/timeline:opacity-100",
				busy && "pointer-events-auto visible opacity-100",
				props.className,
			)}
		>
			<div role="toolbar" aria-label={t("runControl.toolbar")} className="flex items-center gap-0.5 rounded-lg border border-border-strong bg-bg-panel/95 p-0.5 shadow-md backdrop-blur-sm">
				<Button type="button" variant="ghost" size="icon-sm" className={cn("size-7", !abortDisabled && "text-[var(--color-accent)]")} disabled={abortDisabled} title={t("menu.stopAnswer")} aria-label={t("menu.stopAnswer")} onClick={() => control.onAction("abort")}>
					<Square className="size-3" fill="currentColor" strokeWidth={0} aria-hidden="true" />
				</Button>
				<Button type="button" variant="ghost" size="icon-sm" className="size-7" disabled={primaryDisabled} title={primaryLabel} aria-label={primaryLabel} onClick={() => control.onAction(capabilities.primaryAction)}>
					{control.isRestarting || capabilities.pending ? <LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : primaryIsStart ? <Play className="size-3.5" aria-hidden="true" /> : <RotateCw className="size-3.5" aria-hidden="true" />}
				</Button>
				{control.supportsHotReload ? (
					<Button type="button" variant="ghost" size="icon-sm" className="size-7" disabled={hotReloadDisabled} title={t("menu.reloadResourcesHint")} aria-label={t("menu.reloadResources")} onClick={() => control.onAction("reloadResources")}>
						{control.isReloading ? <LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
					</Button>
				) : null}
			</div>
		</div>
	);
}
