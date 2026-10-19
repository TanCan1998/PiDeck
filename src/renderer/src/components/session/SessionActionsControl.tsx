import { ChevronDown, LoaderCircle, Play, Power, RefreshCw, Square } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { canRunSessionAction } from "../../utils/sessionCommands";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { SessionMenuItems, type SessionMenuModel, type SessionMenuRunControl } from "./SessionActionsMenu";

/**
 * 会话操作控制钮：原 Tab 栏「⋯」菜单的唯一入口 + pi 会话的运行/重载快捷钮。
 *
 * 为什么长这样（多轮用户反馈收敛的结果）：
 * - 常驻可见：hover 才出现等于右键菜单，不是快捷入口；
 * - 小体量：28px 高（与头部常规图标齐平），两个动作图标 + 一个下拉箭头，不是带边框的一排按钮；
 * - 功能收口：原来 Tab 栏右上角的「⋯」全部菜单项搬进这个「⋯」，Tab 栏不再有第二个菜单钮；
 * - 只对 pi 显示运行/重载快捷钮（DSH 共享 host、ACP 外部 CLI 没有会话级进程语义），
 *   但「⋯」对所有后端保留，否则 DSH/ACP 会丢掉重命名/导出/工具开关等入口。
 *
 * 视觉上无外框、无底色、无阴影；hover 只有一个小圆角反馈块。
 */
export function SessionActionsControl(props: { runControl?: SessionMenuRunControl; menu?: SessionMenuModel; className?: string }) {
	const { runControl, menu } = props;
	const capabilities = runControl?.capabilities;
	// pi 才有会话级运行控制与热重载（reloadMode=resources）；其它后端只留「⋯」。
	const isPiRuntime = Boolean(capabilities) && (runControl?.reloadMode ?? "none") === "resources";
	// 既没有运行控制也没有任何会话操作时整组不渲染（引导页/空态）。
	if (!menu && !runControl) return null;

	const primaryAction = capabilities?.canAbort ? "abort" : capabilities?.primaryAction;
	const primaryLabel = runControl?.isStopping ? t("app.closing") : runControl?.isRestarting ? t("app.restarting") : capabilities?.canAbort ? t("menu.stopAnswer") : capabilities?.primaryAction === "start" ? t("tabs.startAgent") : t("app.restart");
	const primaryDisabled = !capabilities || primaryAction === "abort" ? !capabilities?.canAbort || Boolean(runControl?.isStopping) : !canRunSessionAction(capabilities, capabilities.primaryAction) || Boolean(runControl?.isRestarting) || Boolean(runControl?.isStopping);
	const pending = Boolean(runControl?.isRestarting || runControl?.isReloading || capabilities?.pending);
	const reloadDisabled = !capabilities || !canRunSessionAction(capabilities, "reloadResources") || Boolean(runControl?.isReloading) || Boolean(runControl?.isStopping);
	const reloadLabel = runControl?.isReloading ? t("app.reloading") : t("menu.reloadResources");
	const primaryIcon = pending ? (
		<LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" />
	) : capabilities?.canAbort ? (
		<Square className="size-3" fill="currentColor" strokeWidth={0} aria-hidden="true" />
	) : capabilities?.primaryAction === "start" ? (
		<Play className="size-4" aria-hidden="true" />
	) : (
		// 重启用电源符号而不是旋转箭头：旋转箭头与旁边「重载」的 RefreshCw 在 14px 下几乎一样，
		// 两个并排会分不清（用户反馈「重启、重载 logo 重复」）。
		<Power className="size-4" aria-hidden="true" />
	);

	return (
		<div role="group" aria-label={t("runControl.toolbar")} className={cn("inline-flex shrink-0 items-center", props.className)}>
			{/*
       必须显式顶掉 legacy `.chat-header-actions button` 的 `min-width:60px`、面板底色、
       1px 边框与 `padding:0 var(--space-2)`（foundation.css）：那套规则会给头部每个按钮
       撑出 60px 白块 + hover 描边，直接把迷你控件放大成一块。utilities 层高于 legacy 层，
       只要把冲突属性写成工具类就能压住（同 header-drawer-toggle 的豁免思路）。
      */}
			{isPiRuntime && capabilities && primaryAction ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="h-7 w-7 min-w-0 rounded-md rounded-r-none border-0 bg-transparent px-0 text-foreground/80 hover:bg-accent hover:text-foreground"
					disabled={primaryDisabled}
					title={primaryLabel}
					aria-label={primaryLabel}
					onClick={() => runControl?.onAction(primaryAction)}
				>
					{primaryIcon}
				</Button>
			) : null}
			{isPiRuntime ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="h-7 w-7 min-w-0 rounded-none border-0 bg-transparent px-0 text-muted-foreground hover:bg-accent hover:text-foreground"
					disabled={reloadDisabled}
					title={t("menu.reloadResourcesHint")}
					aria-label={reloadLabel}
					onClick={() => runControl?.onAction("reloadResources")}
				>
					{runControl?.isReloading ? <LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
				</Button>
			) : null}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className={cn("h-7 min-w-0 border-0 bg-transparent px-0 text-muted-foreground hover:bg-accent hover:text-foreground", isPiRuntime ? "w-5 rounded-md rounded-l-none" : "w-7 rounded-md")}
						aria-label={t("runControl.moreActions")}
						title={t("runControl.moreActions")}
					>
						{/* 下拉箭头（不是省略号）：一眼看出这是个菜单，与前面两个动作钮区分开。 */}
						<ChevronDown className="size-4" aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
					<SessionMenuItems runControl={runControl} menu={menu} />
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
