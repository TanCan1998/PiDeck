import { Bot, Check, ChevronDown } from "lucide-react";
import type { AgentProfile } from "../../../../shared/types/agentProfile";
import { t } from "../../i18n";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";

export type AgentInvokeAgentPickerProps = {
	agents: readonly AgentProfile[];
	selected: AgentProfile | null;
	onSelect: (agentId: string) => void;
};

/**
 * 调用面板头部的智能体选择器：DropdownMenu 直接铺 agentProfilesAtom 的展示顺序
 * （内置翻译在前，其余按创建时间倒序），不另做搜索——列表通常只有个位数。
 * 触发按钮自身带 aria-label，空列表时禁用并显示「选择智能体」。
 */
export function AgentInvokeAgentPicker({ agents, selected, onSelect }: AgentInvokeAgentPickerProps) {
	const disabled = agents.length === 0;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					aria-label={t("agentInvoke.selectAgent")}
					title={t("agentInvoke.selectAgent")}
					className="inline-flex h-7 max-w-[220px] min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border-subtle bg-transparent px-2 text-xs text-foreground transition-colors hover:bg-accent-soft disabled:pointer-events-none disabled:opacity-50"
				>
					{selected?.icon ? (
						<span className="text-sm leading-none" aria-hidden="true">
							{selected.icon}
						</span>
					) : (
						<Bot size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
					)}
					<span className="min-w-0 truncate">{selected?.name ?? t("agentInvoke.selectAgent")}</span>
					<ChevronDown size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={6} data-selection-tool-ui className="max-h-[min(320px,50vh)] w-[260px] overflow-y-auto">
				<DropdownMenuLabel>{t("agentInvoke.agentLabel")}</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{agents.map((agent) => (
					<DropdownMenuItem key={agent.id} onSelect={() => onSelect(agent.id)}>
						{agent.icon ? (
							<span className="w-4 shrink-0 text-center text-sm leading-none" aria-hidden="true">
								{agent.icon}
							</span>
						) : (
							<Bot size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						)}
						<span className="min-w-0 flex-1 truncate">{agent.name}</span>
						{agent.id === selected?.id ? <Check size={13} className="shrink-0 text-primary" aria-hidden="true" /> : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
