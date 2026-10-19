import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { t } from "../../i18n";

/**
 * 图片全屏预览浮层（只认 `src` 字符串）。
 *
 * 从 `ImagePreviewModal`（只认 `ImageContent` 的 data/ref 形态）里抽出，供
 * Markdown 正文图片复用同一套关闭/Esc/动作条语义——否则会多出第二套浮层实现。
 * 历史消息、输入框附件的图仍经 `ImagePreviewModal` 进来，两者渲染的是同一个组件。
 *
 * 挂到 `document.body`：`image-preview-modal` 是 `position: absolute; inset: 0`
 * 的覆盖层，挂在时间线里会以最近的定位祖先为界（会话栏内），挂到 body 才等价于
 * 全窗口覆盖——与 App 级预览的实际观感一致。
 */
export function ImageLightbox(props: { src: string; alt: string; onClose: () => void; actions?: ReactNode }) {
	// 模态惯例：Escape 可关（右上角关闭钮可聚焦，但键盘用户不应被迫 Tab 寻找）
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") props.onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [props.onClose]);
	const content = (
		<div className="image-preview-modal" onClick={props.onClose}>
			<button className="image-preview-close" onClick={props.onClose} aria-label={t("app.imagePreviewClose")}>
				<X size={20} strokeWidth={2.4} />
			</button>
			<img src={props.src} alt={props.alt} onClick={(event) => event.stopPropagation()} />
			{props.actions ? (
				<div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2" onClick={(event) => event.stopPropagation()}>
					{props.actions}
				</div>
			) : null}
		</div>
	);
	return typeof document === "undefined" ? content : createPortal(content, document.body);
}
