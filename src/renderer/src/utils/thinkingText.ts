import { parser } from "@lezer/markdown";
import { trimMarkdownWhitespace } from "../../../shared/markdownWhitespace.ts";

// 只展开通用 HTML block，才能逐个识别相邻的多行思考块；原生 HTML 上下文仍由完整树校验。
const TAG_PARSER = parser.configure({ remove: ["HTMLBlock"] });
type Range = { from: number; to: number };

/**
 * 只隐藏独立的 <thinking> 语法标记，不把链接、HTML 属性、注释或代码里的字面量当协议。
 * 原文不改，按源坐标收集删除区间；正常多块共用语法树，不为每个块重解析全文。
 * 解析工作量最多 3 倍输入长度。异常思考内的 Markdown 污染上下文时可有界修复，
 * 额度耗尽则保留无法确认的文本——这是展示兜底，不是安全过滤器，不能猜测后误删正文。
 */
export function stripThinkingTags(text: string): string {
	const removed: Range[] = [];
	let tagTree: ReturnType<typeof parser.parse> | undefined;
	let htmlTree: ReturnType<typeof parser.parse> | undefined;
	let treeRevision = -1;
	let parseBudget = text.length * 3;

	/** 排除已确认思考内容，Lezer 的 ranges 保持原始源坐标，也不让其围栏污染后续正文。 */
	function parseVisible() {
		if (parseBudget < text.length) return undefined;
		parseBudget -= text.length;
		const ranges: Range[] = [];
		let from = 0;
		for (const range of removed) {
			ranges.push({ from, to: range.from });
			from = range.to;
		}
		ranges.push({ from, to: text.length });
		treeRevision = removed.length;
		return TAG_PARSER.parse(text, [], ranges);
	}

	/** 必须命中完整 HTMLTag，而非仅靠排除少数代码节点；保留 pre 等原生 HTML 区域。 */
	function isOpeningTag(at: number): boolean {
		if (at === 0) return true;
		tagTree ??= parseVisible();
		if (!tagTree) return false;
		let node = tagTree.resolveInner(at, 1);
		if ((node.name !== "HTMLTag" || node.from !== at || node.to !== at + 10) && treeRevision < removed.length) {
			const repaired = parseVisible();
			if (!repaired) return false;
			tagTree = repaired;
			node = tagTree.resolveInner(at, 1);
		}
		if (node.name !== "HTMLTag" || node.from !== at || node.to !== at + 10) return false;
		if (!htmlTree) {
			if (parseBudget < text.length) return false;
			parseBudget -= text.length;
			htmlTree = parser.parse(text);
		}
		let html = htmlTree.resolveInner(at, 1);
		while (html.parent && html.name !== "HTMLBlock") html = html.parent;
		if (html.name !== "HTMLBlock") return true;
		if (text.slice(html.from, html.from + 10).toLowerCase() !== "<thinking>") return false;
		// 多行 thinking 会让原生 HTMLBlock 吞掉紧邻的后续块。只允许空白相邻的标记；
		// 中间若出现 pre 等可见 HTML，无法确认时保留，不能借前一块权限删除后面的代码。
		return html.from === at || (removed.length > 0 && text.slice(removed[removed.length - 1].to, at).trim() === "");
	}

	const opening = /<thinking>/gi;
	const closing = /<\/thinking>/gi;
	let match: RegExpExecArray | null;
	while ((match = opening.exec(text))) {
		if (!isOpeningTag(match.index)) continue;
		closing.lastIndex = opening.lastIndex;
		const to = closing.exec(text) ? closing.lastIndex : text.length;
		removed.push({ from: match.index, to });
		opening.lastIndex = to;
	}
	const visible: string[] = [];
	let from = 0;
	for (const range of removed) {
		visible.push(text.slice(from, range.from));
		from = range.to;
	}
	visible.push(text.slice(from));
	return trimMarkdownWhitespace(visible.join(""));
}
