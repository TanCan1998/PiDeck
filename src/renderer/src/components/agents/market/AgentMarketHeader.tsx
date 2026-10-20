import { Bot, Plus, Search, Settings2, X } from "lucide-react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";

interface AgentMarketHeaderProps {
	query: string;
	onQueryChange: (query: string) => void;
	onCreate: () => void;
	onOpenSettings: () => void;
	onClose: () => void;
}

/**
 * 市场主视图头部：标题 + 说明 + 搜索 + 新建/设置/关闭。
 * 关闭按钮放在头部内（Dialog 的默认关闭钮被 showCloseButton={false} 关掉），与其他工作台弹框一致。
 */
export function AgentMarketHeader({ query, onQueryChange, onCreate, onOpenSettings, onClose }: AgentMarketHeaderProps) {
	return (
		<header className="flex shrink-0 flex-col gap-3 border-b border-border/40 px-5 py-3">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
							<Bot className="size-4" aria-hidden="true" />
						</span>
						<h1 className="truncate text-base font-semibold text-foreground">{t("agentMarket.title")}</h1>
					</div>
					<p className="mt-1 truncate text-xs text-muted-foreground">{t("agentMarket.subtitle")}</p>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Button type="button" size="sm" className="h-8 gap-1.5 text-xs" onClick={onCreate}>
						<Plus className="size-3.5" aria-hidden="true" />
						{t("agentMarket.create")}
					</Button>
					<Button type="button" variant="ghost" size="icon-sm" className="size-8 text-muted-foreground" title={t("agentMarket.settingsTitle")} aria-label={t("agentMarket.settingsTitle")} onClick={onOpenSettings}>
						<Settings2 className="size-4" aria-hidden="true" />
					</Button>
					<Button type="button" variant="ghost" size="icon-sm" className="size-8 text-muted-foreground" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}>
						<X className="size-4" aria-hidden="true" />
					</Button>
				</div>
			</div>
			<div className="relative">
				<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<Input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={t("agentMarket.searchPlaceholder")} aria-label={t("agentMarket.searchPlaceholder")} size="sm" className="pl-7 text-xs" />
			</div>
		</header>
	);
}
