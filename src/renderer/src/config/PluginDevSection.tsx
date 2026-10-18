/**
 * 扩展页「插件开发」小节：插件 = pi 扩展（TS 单文件）。
 * 提供两个动作——生成 AI 开发指南（双语 Markdown 落盘扩展目录）、复制内置 demo
 * 插件（三层能力起步模板）；状态行显示目录与就位徽标。目录常驻展示，
 * 让用户直接把路径粘给 AI。
 */
import { useCallback, useEffect, useState } from "react";
import { getI18nLocale, t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { Button } from "../components/ui-shadcn/button";
import { Badge } from "../components/ui-shadcn/badge";
import { BookOpenText, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

type PluginDevStatus = { userExtensionsDir: string; demoInstalled: boolean; guideInstalled: boolean };

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function PluginDevSection() {
	const [status, setStatus] = useState<PluginDevStatus | null>(null);
	const [busy, setBusy] = useState<"guide" | "demo" | null>(null);

	const refresh = useCallback(async () => {
		try {
			setStatus(await desktopApi.pluginDev.status());
		} catch {
			// 状态读取失败不阻塞动作按钮，仅隐藏目录行
			setStatus(null);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const handleWriteGuide = async () => {
		if (busy) return;
		setBusy("guide");
		try {
			await desktopApi.pluginDev.writeGuide(getI18nLocale() === "en-US" ? "en-US" : "zh-CN");
			toast(t("config.pluginDevGuideWritten"));
			await refresh();
		} catch (e) {
			toast.error(t("config.pluginDevFailed", { error: formatError(e) }));
		} finally {
			setBusy(null);
		}
	};

	const handleCopyDemo = async () => {
		if (busy) return;
		setBusy("demo");
		try {
			const result = await desktopApi.pluginDev.copyDemo();
			toast(t(result.status === "copied" ? "config.pluginDevCopiedToast" : "config.pluginDevExistsToast"));
			await refresh();
		} catch (e) {
			toast.error(t("config.pluginDevFailed", { error: formatError(e) }));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="config-section">
			<h3 className="mb-2 text-sm font-semibold tracking-tight text-foreground">{t("config.pluginDevTitle")}</h3>
			<p className="mb-3 max-w-[68ch] text-control text-muted-foreground">{t("config.pluginDevDesc")}</p>
			{status && status.userExtensionsDir && (
				<div className="mb-3 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
					<span className="shrink-0">{t("config.pluginDevDirLabel")}</span>
					<code className="min-w-0 break-all rounded bg-bg-hover px-1.5 py-0.5 font-mono text-caption text-foreground">{status.userExtensionsDir}</code>
					{status.demoInstalled && <Badge variant="secondary">{t("config.pluginDevDemoInstalled")}</Badge>}
					{status.guideInstalled && <Badge variant="secondary">{t("config.pluginDevGuideInstalled")}</Badge>}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-1.5">
				<Button variant="outline" size="sm" onClick={() => void handleWriteGuide()} disabled={busy !== null}>
					{busy === "guide" ? <Loader2 size={14} strokeWidth={1.8} className="mr-1.5 animate-pideck-spin" aria-hidden="true" /> : <BookOpenText size={14} strokeWidth={1.8} className="mr-1.5" aria-hidden="true" />}
					{busy === "guide" ? t("common.loading") : t("config.pluginDevWriteGuide")}
				</Button>
				<Button variant="outline" size="sm" onClick={() => void handleCopyDemo()} disabled={busy !== null}>
					{busy === "demo" ? <Loader2 size={14} strokeWidth={1.8} className="mr-1.5 animate-pideck-spin" aria-hidden="true" /> : <Copy size={14} strokeWidth={1.8} className="mr-1.5" aria-hidden="true" />}
					{t("config.pluginDevCopyDemo")}
				</Button>
			</div>
			<small className="mt-2 block text-caption text-muted-foreground">{t("config.pluginDevHint")}</small>
		</div>
	);
}
