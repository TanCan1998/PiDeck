/**
 * 时间线消息右键菜单视图。
 *
 * 坐标菜单模式（与 FileContextMenu / MarkdownLink 的文件链接菜单同款）：Radix DropdownMenu +
 * 钉在右键坐标上的不可见 fixed Trigger；视口碰撞翻转、焦点圈定、ESC 关闭全由 Radix 负责。
 * 只做呈现：菜单项显隐由 state 里有无内容决定，动作回抛给 useMessageContextMenu 的 controller。
 */
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui-shadcn/dropdown-menu";
import { t } from "../../../i18n";
import type { MessageContextMenuCopyKind, MessageContextMenuState } from "../../../hooks/useMessageContextMenu";

export function MessageContextMenu(props: { state: MessageContextMenuState | null; onCopy: (kind: MessageContextMenuCopyKind) => void; onSelectAll: () => void; onClose: () => void }) {
	const state = props.state;
	if (!state) return null;
	const hasSelection = state.selectionText.length > 0;
	const hasMessage = state.messageText.length > 0;
	const hasLiveText = state.liveText.length > 0;
	const hasCopy = hasSelection || hasMessage || hasLiveText;
	return (
		<DropdownMenu
			// 坐标变化即重挂：同一会话内二次右键要按新坐标重新定位，复用旧锚点会把菜单留在上一处。
			key={`${state.x}:${state.y}`}
			open
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
		>
			{/* 不可见 Trigger 钉在右键坐标上：Radix dropdown-menu 没有 Anchor 部件，
			    受控 open 下仍按 Trigger 矩形定位（官方推荐的坐标菜单模式）。 */}
			<DropdownMenuTrigger
				aria-hidden
				tabIndex={-1}
				style={{
					position: "fixed",
					left: state.x,
					top: state.y,
					width: 0,
					height: 0,
					padding: 0,
					border: 0,
					background: "transparent",
					pointerEvents: "none",
				}}
			/>
			{/* onCloseAutoFocus preventDefault：关闭时不把焦点抢回不可见 Trigger——
			    复制完用户往往还要继续划选 / 滚动，焦点跳走会顺手收掉选区。 */}
			<DropdownMenuContent align="start" side="bottom" className="min-w-40" onCloseAutoFocus={(event) => event.preventDefault()}>
				{hasSelection && <DropdownMenuItem onSelect={() => props.onCopy("selection")}>{t("common.copy")}</DropdownMenuItem>}
				{hasSelection && (hasMessage || hasLiveText) && <DropdownMenuSeparator />}
				{hasMessage && (
					<>
						<DropdownMenuItem onSelect={() => props.onCopy("messageText")}>{t("copy.asText")}</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => props.onCopy("messageMarkdown")}>{t("copy.asMarkdown")}</DropdownMenuItem>
					</>
				)}
				{/* live 流式正文只有 DOM 文本（无原始 markdown），只给「复制为文本」一项回退 */}
				{hasLiveText && <DropdownMenuItem onSelect={() => props.onCopy("liveText")}>{t("copy.asText")}</DropdownMenuItem>}
				{state.canSelectAll && hasCopy && <DropdownMenuSeparator />}
				{state.canSelectAll && <DropdownMenuItem onSelect={props.onSelectAll}>{t("common.selectAll")}</DropdownMenuItem>}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
