/**
 * 设置 → 通用 tab 内的「划词工具」设置区（用户反馈：划词设置属于设置页，不属于智能体市场）。
 *
 * 数据自持（与 PromptEnhanceSettingsSection / VoiceTranscriptionSettingsSection 同模式）：
 * 不进 CommonTab 草稿，改一项即时写 agent-profiles.json 的市场设置并回写快照 atom，
 * AppBootstrap 的 useAgentProfileSync 也会在 changed 事件后重拉，浮钮与系统浮窗随之生效。
 *
 * 系统级划词快捷键展示只读：真正的键位在「快捷键」tab（shared/shortcuts 注册表唯一来源），
 * 这里只把当前生效值写出来，避免出现第二份可编辑的快捷键状态。
 */
import { useCallback, useEffect, useId, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { agentProfileSnapshotAtom, agentProfilesAtom, agentMarketSettingsAtom, openAgentMarketPageAtom } from "../../../atoms";
import { settingsOpenAtom } from "../../../atoms";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { formatAccelerator, resolveShortcutBindings } from "../../../../../shared/shortcuts";
import { BUILTIN_TRANSLATE_AGENT_ID, type AgentMarketSettings } from "../../../../../shared/types/agentProfile";
import { Button } from "../../ui-shadcn/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Switch } from "../../ui-shadcn/switch";
import { SettingRow } from "./SettingRows";
import { SettingsSection } from "./SettingsStorageTab";

/** Select 里用哨兵值表示「默认（内置翻译官）」，避免 nullable 值塞进 Radix Select。 */
const DEFAULT_AGENT_SENTINEL = "__default__";

export function SelectionToolSettingsSection() {
	const snapshot = useAtomValue(agentProfileSnapshotAtom);
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const setSnapshot = useSetAtom(agentProfileSnapshotAtom);
	const openMarketPage = useSetAtom(openAgentMarketPageAtom);
	const setSettingsOpen = useSetAtom(settingsOpenAtom);
	const enableId = useId();
	const systemId = useId();
	const [saving, setSaving] = useState(false);
	const [accelerator, setAccelerator] = useState("");

	// 快捷键只读展示：按键位存在 settings.json 的 shortcuts 覆盖里，挂载时取一次当前生效值。
	useEffect(() => {
		let cancelled = false;
		void desktopApi.settings
			.get()
			.then((appSettings) => {
				if (cancelled) return;
				// platform 只影响修饰键显示（Cmd/Ctrl）；渲染层用 UA 判定即可，与快捷键匹配无关。
				const platform = navigator.userAgent.includes("Macintosh") ? "darwin" : "linux";
				const bindings = resolveShortcutBindings(appSettings.shortcuts ?? {}, platform);
				setAccelerator(formatAccelerator(bindings.openSelectionTool, platform));
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	const persist = useCallback(
		async (patch: Partial<Pick<AgentMarketSettings, "selectionToolEnabled" | "systemSelectionEnabled" | "selectionToolAgentId">>) => {
			if (saving) return;
			setSaving(true);
			try {
				const saved = await desktopApi.agentProfiles.updateSettings(patch);
				// changed 事件会触发 refetch；这里先写回本地快照让开关/下拉立即响应。
				setSnapshot((current) => (current ? { ...current, settings: saved } : current));
			} catch {
				// 失败回读权威快照（UI 回到真实状态），并保留 toast 级别的可见反馈由调用方补。
				const fresh = await desktopApi.agentProfiles.getSnapshot().catch(() => null);
				if (fresh) setSnapshot(fresh);
			} finally {
				setSaving(false);
			}
		},
		[saving, setSnapshot],
	);

	const defaultAgentValue = settings.selectionToolAgentId ?? DEFAULT_AGENT_SENTINEL;
	const defaultAgentLabel = settings.selectionToolAgentId ? (agents.find((agent) => agent.id === settings.selectionToolAgentId)?.name ?? settings.selectionToolAgentId) : t("agentMarket.modelUnset");

	return (
		<SettingsSection id="settings-section-common-selection-tool" title={t("settings.selectionTool.title")} description={t("settings.selectionTool.description")}>
			<SettingRow title={<label htmlFor={enableId}>{t("settings.selectionTool.enabled")}</label>} description={t("settings.selectionTool.enabledHint")}>
				<Switch id={enableId} checked={settings.selectionToolEnabled} disabled={saving || !snapshot} onCheckedChange={(checked) => void persist({ selectionToolEnabled: checked })} />
			</SettingRow>

			<SettingRow title={<label htmlFor={systemId}>{t("settings.selectionTool.systemEnabled")}</label>} description={t("settings.selectionTool.systemEnabledHint")}>
				<Switch id={systemId} checked={settings.systemSelectionEnabled} disabled={saving || !snapshot} onCheckedChange={(checked) => void persist({ systemSelectionEnabled: checked })} />
			</SettingRow>

			<SettingRow title={<span>{t("settings.selectionTool.hotkeyLabel")}</span>} description={t("settings.selectionTool.hotkeyHint", { accelerator: accelerator || "" })}>
				<kbd className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground">{accelerator || "—"}</kbd>
			</SettingRow>

			<SettingRow title={<span>{t("settings.selectionTool.defaultAgent")}</span>} description={t("settings.selectionTool.defaultAgentHint")}>
				<Select value={defaultAgentValue} disabled={saving || agents.length === 0} onValueChange={(value) => void persist({ selectionToolAgentId: value === DEFAULT_AGENT_SENTINEL ? null : value })}>
					<SelectTrigger className="w-full" aria-label={t("settings.selectionTool.defaultAgent")}>
						<SelectValue placeholder={defaultAgentLabel} />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							<SelectItem value={DEFAULT_AGENT_SENTINEL}>{t("settings.selectionTool.defaultAgentAuto")}</SelectItem>
							{agents.map((agent) => (
								<SelectItem key={agent.id} value={agent.id}>
									{agent.icon ? `${agent.icon} ` : ""}
									{agent.name}
									{agent.id === BUILTIN_TRANSLATE_AGENT_ID ? ` (${t("agentMarket.builtinBadge")})` : ""}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			</SettingRow>

			<SettingRow title={<span>{t("settings.selectionTool.manageAgents")}</span>} description={t("agentMarket.subtitle")}>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						setSettingsOpen(false);
						openMarketPage();
					}}
				>
					{t("settings.selectionTool.manageAgents")}
				</Button>
			</SettingRow>
		</SettingsSection>
	);
}
