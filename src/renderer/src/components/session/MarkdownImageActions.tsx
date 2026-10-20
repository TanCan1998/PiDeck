import { Check, Copy, Download } from "lucide-react";
import { useCallback, useState } from "react";
import { t } from "../../i18n";
import { writeClipboardImage } from "../../utils/clipboard";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";

/**
 * Markdown 正文图片的「复制 / 保存」动作（按 `src` 取字节，不依赖 ImageContent）。
 *
 * 来历（2026-10-20）：改造前正文图片由 streamdown 内置组件渲染，右下角 hover 就有下载
 * 按钮；换成 `MarkdownImage` 后这个能力被静默丢掉了（用户反馈「我的图还能下载吗」）。
 * 现在按同一套语义补回，并放到更稳的位置：预览浮层工具条 + 大图 hover。
 *
 * 取字节走 `fetch(src)`：本地图是 `pideck-file://`（scheme 已在 CSP `connect-src` 放行），
 * 远程图受 CORS 限制，失败时只能提示（不静默吞掉）。不把 base64 常驻内存：只在动作发生时
 * 取一次 blob。
 */

function downloadExtension(mimeType: string): string {
	if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
	if (mimeType.includes("webp")) return "webp";
	if (mimeType.includes("gif")) return "gif";
	if (mimeType.includes("svg")) return "svg";
	if (mimeType.includes("avif")) return "avif";
	if (mimeType.includes("bmp")) return "bmp";
	return "png";
}

/** 文件名取 alt（去掉非法字符）→ 兜底 pideck-image；扩展名按真实 MIME 而不是 URL 后缀。 */
function downloadName(alt: string, mimeType: string): string {
	const base = alt
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
		.trim()
		.slice(0, 40);
	return `${base || "pideck-image"}.${downloadExtension(mimeType)}`;
}

async function loadImageBlob(src: string): Promise<Blob> {
	const response = await fetch(src);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.blob();
}

/** 复制/保存的共用逻辑：一次取 blob，两条动作都基于它。 */
function useMarkdownImageActions(src: string, alt: string) {
	const [copied, setCopied] = useState(false);

	const copy = useCallback(async () => {
		try {
			const blob = await loadImageBlob(src);
			const ok = await writeClipboardImage(blob);
			if (!ok) throw new Error("Clipboard write rejected");
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			showNotice(t("imagegen.copyFailed"), 2000, "error");
		}
	}, [src]);

	const save = useCallback(async () => {
		try {
			const blob = await loadImageBlob(src);
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = downloadName(alt, blob.type);
			link.click();
			// 下载由 Chromium 接管后立即释放，不常驻内存
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch {
			showNotice(t("imagegen.saveFailed"), 2000, "error");
		}
	}, [src, alt]);

	return { copied, copy, save };
}

/** 预览浮层底部工具条：复制 + 保存（与附件图的 ImageActionButtons 同规格）。 */
export function MarkdownImageToolbar(props: { src: string; alt: string }) {
	const { copied, copy, save } = useMarkdownImageActions(props.src, props.alt);
	return (
		<div className="flex items-center overflow-hidden rounded-md border border-border/70 bg-background/85 shadow-sm backdrop-blur-sm">
			<Button variant="ghost" size="icon-sm" className="size-7 rounded-none text-muted-foreground hover:bg-muted hover:text-foreground" type="button" onClick={() => void copy()} title={t("imagegen.copy")} aria-label={t("imagegen.copy")}>
				{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
			</Button>
			<Button variant="ghost" size="icon-sm" className="size-7 rounded-none border-l border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground" type="button" onClick={() => void save()} title={t("imagegen.save")} aria-label={t("imagegen.save")}>
				<Download size={14} aria-hidden="true" />
			</Button>
		</div>
	);
}

/** 大图 hover 角标：与改造前的 streamdown 行为对齐（不弹浮层也能直接存）。 */
export function MarkdownImageHoverSave(props: { src: string; alt: string }) {
	const { save } = useMarkdownImageActions(props.src, props.alt);
	return (
		<button
			type="button"
			className="absolute right-2 top-2 flex size-8 cursor-pointer items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur-sm transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
			onClick={() => void save()}
			title={t("imagegen.save")}
			aria-label={t("imagegen.save")}
		>
			<Download size={14} aria-hidden="true" />
		</button>
	);
}
