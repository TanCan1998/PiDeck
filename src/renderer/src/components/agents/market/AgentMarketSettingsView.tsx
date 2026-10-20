import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { agentMarketSettingsAtom, agentProfilesAtom } from "../../../atoms/agent-atoms";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Label } from "../../ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Switch } from "../../ui-shadcn/switch";
import { resolveDefaultSelectionAgent } from "../agentMarketFilters";
import { useAgentMarketActions } from "./useAgentMarketActions";

interface AgentMarketSettingsViewProps {
	onBack: () => void;
}

/**
 * 划词工具设置：开关 + 默认智能体 + 保存。
 *
 * 表单状态只在挂载时从快照取初值（编辑中不被后台刷新的快照覆盖），保存成功由
 * useAgentMarketActions 重拉快照 + toast，市场卡片上的「划词默认」角标随快照更新。
 * Select 的值始终解析成具体智能体 id：契约里 null 的语义就是「回退内置翻译智能体」，
 * 这里把回退目标直接显示出来，用户不会看到「未设置」的模糊态。
 */
export function AgentMarketSettingsView({ onBack }: AgentMarketSettingsViewProps) {
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const actions = useAgentMarketActions();
	const defaultAgent = resolveDefaultSelectionAgent(agents, settings);
	const [enabled, setEnabled] = useState(settings.selectionToolEnabled);
	const [agentId, setAgentId] = useState(defaultAgent?.id ?? "");
	const [saving, setSaving] = useState(false);

	// 快照可能晚于本视图到达（首次打开就点设置）：默认智能体解析出来后补齐选中值。
	useEffect(() => {
		if (!agentId && defaultAgent) setAgentId(defaultAgent.id);
	}, [agentId, defaultAgent]);

	const handleSave = async () => {
		setSaving(true);
		try {
			await actions.saveSettings({ selectionToolEnabled: enabled, selectionToolAgentId: agentId ? agentId : null });
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<div className="mx-auto flex max-w-[560px] flex-col gap-4">
					<div className="flex flex-col gap-4 rounded-xl border border-border/50 bg-bg-panel/40 p-4">
						<div className="flex items-start justify-between gap-4">
							<div className="min-w-0">
								<Label htmlFor="agent-market-selection-enabled" className="text-sm font-medium">
									{t("agentMarket.settingsEnabled")}
								</Label>
								<p className="mt-1 text-xs leading-snug text-muted-foreground">{t("agentMarket.settingsEnabledHint")}</p>
							</div>
							<Switch id="agent-market-selection-enabled" checked={enabled} onCheckedChange={setEnabled} />
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-market-selection-agent" className="text-xs font-medium">
								{t("agentMarket.settingsDefaultAgent")}
							</Label>
							<Select value={agentId} onValueChange={setAgentId} disabled={agents.length === 0}>
								<SelectTrigger id="agent-market-selection-agent" size="sm" className="w-full text-xs">
									<SelectValue placeholder={t("agentMarket.settingsDefaultAgent")} />
								</SelectTrigger>
								<SelectContent>
									{agents.map((agent) => (
										<SelectItem key={agent.id} value={agent.id} className="text-xs">
											{agent.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-micro leading-snug text-muted-foreground">{t("agentMarket.settingsDefaultAgentHint")}</p>
						</div>
					</div>
				</div>
			</div>

			<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/40 px-5 py-3">
				<Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={onBack} disabled={saving}>
					{t("common.cancel")}
				</Button>
				<Button type="button" size="sm" className="h-8 text-xs" loading={saving} onClick={() => void handleSave()}>
					{t("common.save")}
				</Button>
			</footer>
		</div>
	);
}
