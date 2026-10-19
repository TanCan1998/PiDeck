import { memo, useCallback, useMemo, useState } from "react";
import { localImageUrl } from "../../../../shared/localImage";
import { t } from "../../i18n";
import { useFileLinkBaseDir } from "./FileLinkBase";
import { ImageLightbox } from "./ImageLightbox";
import { resolveMarkdownImageSrc } from "./markdownImageSrc";

/**
 * Markdown 正文图片的唯一渲染入口（`MarkdownStream` 的 `img` 组件）。
 *
 * 三条硬约束：
 * 1. 解析不出可加载 URL 时渲染 alt 原文，**绝不产出空 src 的白图**——失败要能被看见。
 * 2. 加载失败降级成「失败文案 · alt 或原路径」：图没了，但用户知道它在说什么、指着哪个路径。
 * 3. 懒加载 + 限高：长截图不再占满整条时间线；小图仍按原尺寸排，多张小图天然并排。
 *
 * 相对路径的基准取本站会话的 cwd（`useFileLinkBaseDir`，与文件链接同一份上下文），
 * 不在渲染层猜项目根——猜错会静默打开另一份工作区里的同名图片。
 *
 * 本地图统一走 `pideck-file://`（主进程白名单里的只读协议），不用 `file://`：
 * dev 下页源是 http，`file://` 子资源会被 Chromium 直接拒绝。
 */
export const MarkdownImage = memo(function MarkdownImage(props: { destination: string; alt: string }) {
	const baseDir = useFileLinkBaseDir();
	const src = useMemo(() => resolveMarkdownImageSrc(props.destination, { baseDir, toLocalUrl: localImageUrl }), [props.destination, baseDir]);
	const [failedFor, setFailedFor] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	const label = props.alt || props.destination;
	// 失败态绑定到具体的 src，而不是一个布尔：流式过程中半截路径会先打出 404，
	// 完整路径到达后必须能自己恢复。用布尔时失败会永久粘住（dsh 的 `key={src}` 同一个道理）。
	const failed = failedFor !== null && failedFor === src;

	if (src === undefined) return <span className="text-text-tertiary">{label}</span>;
	if (failed) {
		return (
			<span className="text-text-tertiary">
				{t("markdown.imageLoadFailed")}
				{label ? ` · ${label}` : ""} {/* 重试把失败态清掉 → img 重新挂载 → 重新请求。文件被创建/改好之后不用刷新会话 */}
				<button type="button" className="underline underline-offset-2 hover:text-text-secondary" onClick={() => setFailedFor(null)}>
					{t("markdown.imageRetry")}
				</button>
			</span>
		);
	}
	const openLabel = props.alt ? `${t("markdown.imageOpen")}: ${props.alt}` : t("markdown.imageOpen");
	return (
		<>
			<img
				className="inline-block max-h-[420px] w-auto max-w-full cursor-zoom-in align-bottom rounded-sm object-contain"
				src={src}
				alt={props.alt}
				title={openLabel}
				role="button"
				tabIndex={0}
				loading="lazy"
				decoding="async"
				referrerPolicy="no-referrer"
				onClick={() => setOpen(true)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						setOpen(true);
					}
				}}
				onError={() => setFailedFor(src)}
			/>
			{open ? <ImageLightbox src={src} alt={props.alt || t("app.imagePreviewAlt")} onClose={close} /> : null}
		</>
	);
});
