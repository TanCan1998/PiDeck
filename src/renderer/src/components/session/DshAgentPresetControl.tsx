/**
 * DSH agent 预设（会话「模式」）控制 —— 会话头左上角胶囊，草稿期可选、激活后只读。
 *
 * 与权限预设不同，agent preset 决定会话的工具与提示，host 在会话创建时
 * 一次性组合（运行中会话一律 agent-preset-locked）。所以同一个胶囊按会话状态
 * 呈现两种形态（对齐 dsh-web 的 new-session chip + session-header label 合并到
 * 会话头一处）：
 * - 草稿（未激活，无 runtime）：可点击，弹出目录选择器，选择写会话记录预选，
 *   激活新建 host 会话时随 sessions.create 应用；
 * - 已激活：只读 Badge，展示 host 会话 header 回写的实际 preset（创建即固定）。
 *
 * 取值优先级：会话记录回写的实际 preset > host 目录 isDefault（部署默认）；
 * 目录未装配（空 roster）或两者皆无时不渲染。
 */
import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { dshAgentPresetsAtom, dshDefaultPresetId, type DshAgentPresetIdentity, sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily, upsertSessionAtom } from "../../atoms";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent } from "../ui-shadcn/dialog";
import { CommandItem } from "../ui-shadcn/command";
import { CommandPickerPanel } from "../ui-shadcn/command-picker";
import { AgentPresetLogo } from "./SessionSourceBadge";
import { presetDisplayDescription, presetDisplayName } from "../../config/dshPresetDisplay";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

/**
 * 触发一次目录加载（幂等合并）：已缓存（含确认空名单）直接返回；失败不落缓存
 *（保持 null），调用方可重试。放组件模块而不是 atoms：desktopApi 顶层依赖
 * window，atoms/index.ts 会被 Node 测试加载，不能引入（见 dsh-atoms.ts 注释）。
 * 模块级 promise 合并多组件并发首拉；完成后重置，下次调用可再拉。
 */
let presetsLoadPromise: Promise<DshAgentPresetIdentity[] | null> | null = null;
function loadDshAgentPresets(): Promise<DshAgentPresetIdentity[] | null> {
	const store = getDefaultStore();
	const cached = store.get(dshAgentPresetsAtom);
	if (cached) return Promise.resolve(cached);
	if (presetsLoadPromise) return presetsLoadPromise;
	presetsLoadPromise = desktopApi.sessions
		.listDshAgentPresets()
		.then((list) => {
			store.set(dshAgentPresetsAtom, list);
			return list;
		})
		.catch(() => {
			// host 首次启动可能数秒、或 DSH 环境未就绪：失败不缓存，保留重试机会
			return null;
		})
		.finally(() => {
			presetsLoadPromise = null;
		});
	return presetsLoadPromise;
}

export function DshAgentPresetControl(props: { sessionId: string; disabled?: boolean }) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const presets = useAtomValue(dshAgentPresetsAtom);
	const upsertSession = useSetAtom(upsertSessionAtom);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		void loadDshAgentPresets();
	}, []);

	const hasRuntime = Boolean(runtime?.agentId);
	// 生效预设：会话记录回写/预选 > 部署默认（isDefault）；目录未就绪时不猜。
	const presetId = record?.agentPreset ?? (presets ? dshDefaultPresetId(presets) : undefined);
	const identity = presetId ? (presets ?? []).find((preset) => preset.id === presetId) : undefined;
	const label = identity ? presetDisplayName(identity, t) : presetId ? presetId : t("dshPreset.unset");
	const description = identity ? presetDisplayDescription(identity, t) : undefined;
	const tooltip = description ? `${label} — ${description}` : label;

	// 可选择项：剔除 broken（无法组合的预设选了也是白选，dsh-web picker 同规则）。
	const selectable = useMemo(() => (presets ?? []).filter((preset) => !preset.broken), [presets]);

	// 已激活：模式创建即固定，只读展示（不提供假开关）；record 无值时（极端情况）不渲染。
	if (hasRuntime) {
		if (!presetId) return null;
		return (
			<Badge variant="outline" aria-label={`${t("dshPreset.menuTitle")}: ${label}`} title={tooltip} data-agent-preset={presetId} className="h-5 shrink-0 gap-1 rounded-full px-2 text-micro font-semibold leading-none text-muted-foreground">
				<AgentPresetLogo className="size-3 shrink-0" />
				<span className="max-w-28 truncate">{label}</span>
			</Badge>
		);
	}
	// 目录已确认加载（非 null）但部署未装配预设：无从选择，也不渲染。
	if (presets !== null && selectable.length === 0) return null;
	// 目录加载中/失败（presets === null）：仍渲染可点胶囊，点击时兜底重载
	//（DSH host 首次启动可能数秒，首次请求失败后必须给用户重试入口）。

	const pick = async (chosenId: string) => {
		setSaving(true);
		try {
			const updated = await desktopApi.sessions.updateRecord(props.sessionId, { agentPreset: chosenId });
			upsertSession(updated);
			const chosen = selectable.find((preset) => preset.id === chosenId);
			showNotice(
				t("dshPreset.presetPendingNotice", {
					name: chosen ? presetDisplayName(chosen, t) : chosenId,
				}),
				3000,
			);
			setOpen(false);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setSaving(false);
		}
	};

	const openPicker = () => {
		// 目录未就绪（首次加载失败/host 启动慢）时先兜底重载；已缓存则秒回。
		// 重载完成后 atom 更新，弹层内容自动刷新。
		void loadDshAgentPresets();
		setOpen(true);
	};

	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-5 shrink-0 gap-1 rounded-full border border-border/60 bg-muted/40 px-2 text-micro font-semibold leading-none text-muted-foreground hover:bg-muted/70 hover:text-foreground"
				disabled={props.disabled || saving}
				aria-label={t("dshPreset.menuTitle")}
				title={`${t("dshPreset.menuTitle")}: ${label}`}
				onClick={openPicker}
			>
				<AgentPresetLogo className="size-3 shrink-0" />
				<span className="max-w-28 truncate">{label}</span>
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) setOpen(false);
				}}
			>
				<DialogContent showCloseButton={false} className="dsh-preset-picker flex max-h-[min(680px,calc(100vh-48px))] flex-col overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]">
					<CommandPickerPanel title={t("dshPreset.menuTitle")} hint={t("dshPreset.menuHint")} searchPlaceholder={t("app.commandPickerSearch")} emptyLabel={t("app.commandPickerEmpty")} value={presetId ?? ""} onClose={() => setOpen(false)}>
						{selectable.map((preset) => {
							const itemSelected = presetId === preset.id;
							const presetName = presetDisplayName(preset, t);
							const presetDesc = presetDisplayDescription(preset, t);
							return (
								<CommandItem key={preset.id} value={preset.id} data-picker-value={preset.id} onSelect={() => void pick(preset.id)} disabled={saving} className="min-h-9 items-center gap-2 rounded-md px-2.5 py-1">
									<span className={`grid size-6 shrink-0 place-items-center rounded-md ${itemSelected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
										<AgentPresetLogo className="size-3.5" />
									</span>
									{/* 名字保持短小固定（超长才截断）；描述吃满剩余宽度——能显示多少显示多少，
									    放不下的部分悬停（title）显示完整文案。 */}
									<div className="flex min-w-0 flex-1 items-center gap-2">
										<span className="max-w-28 shrink-0 truncate text-control font-semibold text-foreground" title={presetName}>
											{presetName}
										</span>
										{presetDesc ? (
											<span className="min-w-0 flex-1 truncate text-micro text-muted-foreground/75" title={presetDesc}>
												{presetDesc}
											</span>
										) : (
											<span className="shrink-0 font-mono text-micro text-muted-foreground/60" title={preset.id}>
												{preset.id}
											</span>
										)}
									</div>
									{itemSelected ? <Check size={15} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
								</CommandItem>
							);
						})}
					</CommandPickerPanel>
				</DialogContent>
			</Dialog>
		</>
	);
}
