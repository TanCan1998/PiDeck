/**
 * 「同一段落里有多少张图」的读取口（纯函数）。
 *
 * 来源：`remarkMarkMultiImageParagraphs` 在 mdast 上给每个图片节点写
 * `data.hProperties["data-md-image-count"]`，经 `mdast-util-to-hast` 原样带到
 * hast 属性，最终由 streamdown 的 `img` 组件拿到（`ExtraProps.node.properties`）。
 *
 * 为什么要标在节点上：图片是逐节点渲染的，组件本身不知道「同一段还排着几张图」。
 * 而布局规则（照 dsh）：单图按内容尺寸展示（上限 640×360），同段多图缩成 64px 瓷砖
 * ——两种形态只能由节点自己带上下文，否则要么全大、要么全小。
 */
export function imageGroupCountOf(node: unknown): number {
	if (typeof node !== "object" || node === null) return 1;
	const properties = Reflect.get(node, "properties");
	if (typeof properties !== "object" || properties === null) return 1;
	const raw = Reflect.get(properties, "data-md-image-count");
	const count = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
	return Number.isFinite(count) && count > 1 ? Math.floor(count) : 1;
}
