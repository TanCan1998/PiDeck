/** 去展示边界空白，但保留承载 Markdown 缩进代码语义的首行空格和 tab。 */
export function trimMarkdownWhitespace(text: string): string {
	const result = text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
	return /^(?: {4}| {0,3}\t)/.test(result) ? result : result.trimStart();
}
