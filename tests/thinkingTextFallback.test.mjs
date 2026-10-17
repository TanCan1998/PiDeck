import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { parser } from "@lezer/markdown";

const { cleanAnswerText } = loadTsCommonJs("src/renderer/src/components/session/timeline/answerText.ts");
const { stripThinkingTags } = loadTsCommonJs("src/renderer/src/components/session/TimelineFormat.ts");

const cleaners = [cleanAnswerText, stripThinkingTags];

for (const clean of cleaners) {
	const label = clean.name;
	test(`${label}: 未闭合思考隐藏到本条消息结尾，正常正文仍可见`, () => {
		assert.equal(clean("<thinking>诊断占位内容"), "");
		assert.equal(clean("正常回复\n<THINKING>诊断占位内容\n第二行"), "正常回复");
		assert.equal(clean("<thinking>占位一</thinking>正常回复<thinking>占位二"), "正常回复");
	});

	test(`${label}: 流式追加与结束态采用同一边界，闭合后恢复后续正文`, () => {
		for (const text of ["<thinking>", "<thinking>占位一", "<thinking>占位一\n占位二", "<thinking>占位一\n占位二</thinking>"]) {
			assert.equal(clean(text), "");
		}
		assert.equal(clean("<thinking>诊断占位内容</thinking>\n正常回复"), "正常回复");
	});

	test(`${label}: 代码示例中的 thinking 字面量不是思考标记`, () => {
		for (const text of [
			"使用 `<thinking>` 字面量排查问题，正常回复不能丢失。",
			"使用 ``<thinking>示例</thinking>`` 字面量。",
			"```xml\n<thinking>示例\n```\n正常回复",
			"~~~~xml\n<thinking>示例\n~~~~~\n正常回复",
			"```xml\n<thinking>尚未闭合的代码块",
			"缩进代码：\n\n    <thinking>缩进代码示例\n\n正常回复",
			"转义标记 \\<thinking> 不是思考块。",
		]) {
			assert.equal(clean(text), text);
		}
	});

	test(`${label}: 引用块和嵌套容器中的代码围栏不吞后续结论`, () => {
		for (const text of [
			"> ~~~xml\n> <thinking>代码示例\n> ~~~\n\n正常结论不能丢失",
			"> ```xml\n> <thinking>代码示例\n> ```\n\n正常结论不能丢失",
			"> > ~~~~xml\n> > <thinking>代码示例\n> > ~~~~~\n\n正常结论不能丢失",
			"- 示例：\n\n  ~~~xml\n  <thinking>代码示例\n  ~~~\n\n正常结论不能丢失",
			"> ```xml\n> <thinking>尚未闭合的引用代码\n\n正常结论不能丢失",
		]) {
			assert.equal(clean(text), text);
		}
	});

	test(`${label}: 缩进代码保留首行缩进，重复清理结果不变`, () => {
		for (const text of ["    <thinking>代码示例\n\n正常结论不能丢失", "\t<thinking>代码示例\n\n正常结论不能丢失", " \t<thinking>代码示例\n\n正常结论不能丢失", "   \t<thinking>代码示例\n\n正常结论不能丢失", "\n\n    <thinking>代码示例\n\n正常结论不能丢失"]) {
			const expected = text.replace(/^\n+/, "");
			assert.equal(clean(text), expected);
			assert.equal(clean(clean(text)), expected);
		}
	});

	test(`${label}: 不同段落的反引号不能把真实思考误当行内代码`, () => {
		assert.equal(clean("段落中未配对的 ` 字符。\n\n<thinking>诊断占位内容</thinking>\n\n另一段落的 ` 字符，正常结论。"), "段落中未配对的 ` 字符。\n\n\n\n另一段落的 ` 字符，正常结论。");
	});

	test(`${label}: 思考里出现代码不会改变闭合后的正文状态`, () => {
		assert.equal(clean("<thinking>占位 `x`\n~~~xml\n示例</thinking>\n正常结论"), "正常结论");
	});

	test(`${label}: 代码围栏结束后的真实思考仍被隐藏`, () => {
		const code = "> ~~~xml\n> <thinking>代码示例\n> ~~~";
		assert.equal(clean(`${code}\n\n<thinking>诊断占位内容`), code);
	});

	test(`${label}: 围栏字符、容器和缩进组合重复清理后仍保留代码与结论`, () => {
		for (const marker of ["~~~", "```", "~~~~", "````"]) {
			for (const prefix of ["", "> ", "> > ", "- ", "1. "]) {
				for (const indent of ["", " ", "  ", "   "]) {
					const continuation = /[-\d]/.test(prefix) ? " ".repeat(prefix.length) : prefix;
					const text = `${indent}${prefix}${marker}xml\n${indent}${continuation}<thinking>代码示例\n${indent}${continuation}${marker}\n\n正常结论`;
					const result = clean(text);
					assert.ok(result.includes("<thinking>代码示例"), text);
					assert.ok(result.endsWith("正常结论"), text);
					assert.equal(clean(result), result, text);
				}
			}
		}
	});

	test(`${label}: 交错嵌套容器由 CommonMark 判断，不能吞掉代码后的结论`, () => {
		for (const text of ["- > ~~~xml\n  > <thinking>代码示例\n  > ~~~\n\n正常结论不能丢失", "> - > ~~~xml\n>   > <thinking>代码示例\n>   > ~~~\n\n正常结论不能丢失"]) {
			assert.equal(clean(text), text);
		}
	});

	test(`${label}: 退出列表围栏或标题分段后不再把真实思考当代码`, () => {
		assert.equal(clean("- ~~~xml\n  code\n\n<thinking>诊断占位内容"), "- ~~~xml\n  code");
		assert.equal(clean("未配对 `\n# 标题\n<thinking>诊断占位内容</thinking>\n尾部 ` 正常结论"), "未配对 `\n# 标题\n\n尾部 ` 正常结论");
	});

	test(`${label}: 思考闭合后的代码独立判断，不继承思考内部 Markdown 状态`, () => {
		const code = "```xml\n<thinking>代码示例\n```\n正常结论";
		assert.equal(clean(`<thinking>\n诊断占位内容\n</thinking>\n${code}`), code);
		assert.equal(clean("<thinking>占位\n```\n</thinking>\n正常回复\n<thinking>占位二"), "正常回复");
	});

	test(`${label}: 长正文和未配对反引号不会改变思考边界`, () => {
		const body = "正文 ` 后续文字 ".repeat(4000);
		assert.equal(clean(`${body}\n\n<thinking>诊断占位内容`), body.trimEnd());
	});

	test(`${label}: 链接目标和标题里的标签字面量不是思考起点`, () => {
		for (const text of ['[说明](https://example.invalid/docs "<thinking>")\n\n正常结论应保留。', "[说明](https://example.invalid/<thinking>)\n\n正常结论应保留。", '![图片](https://example.invalid/a.png "<thinking>")\n\n正常结论应保留。']) {
			assert.equal(clean(text), text);
		}
	});

	test(`${label}: HTML 注释、属性和 pre 里的标签字面量不吞正文`, () => {
		for (const text of ["<!-- 标签示例 <thinking> -->\n\n正常结论应保留。", '<span title="<thinking>">正常文字</span>\n\n正常结论应保留。', "<pre>\n<thinking>代码示例\n</pre>\n\n正常结论应保留。"]) {
			assert.equal(clean(text), text);
		}
	});

	test(`${label}: 多行思考紧邻 pre 后仍保留代码和正常结论`, () => {
		const html = "<pre>\n<thinking>代码示例\n</pre>\n\n正常结论应保留。";
		assert.equal(clean(`<thinking>\n占位\n</thinking>\n${html}`), html);
	});

	test(`${label}: 相邻多行思考块仍可以合并清理`, () => {
		assert.equal(clean("<thinking>\n占位一\n</thinking>\n<thinking>\n占位二\n</thinking>\n正常结论"), "正常结论");
	});

	test(`${label}: 语法字面量后的真实思考仍被隐藏`, () => {
		const prefix = '[说明](https://example.invalid/docs "<thinking>")\n\n正常回复';
		assert.equal(clean(`${prefix}\n<thinking>诊断占位内容`), prefix);
	});

	test(`${label}: 长正文多块思考不重扫长前缀，所有正常片段保持顺序`, () => {
		const prefix = "普通正文 ".repeat(6000);
		const text = prefix + Array.from({ length: 50 }, (_, i) => `<thinking>占位${i}</thinking>片段${i}\n`).join("");
		const expected = (prefix + Array.from({ length: 50 }, (_, i) => `片段${i}\n`).join("")).trimEnd();
		assert.equal(clean(text), expected);
	});

	test(`${label}: 不按语言猜测思考，不影响无标记回复或扩展标签`, () => {
		for (const text of ["正常中文回复", "Checking accuracy and requirements", "Let's do note and plan.", "<thinking-extra>正常内容", "<think>其他协议</think>", "正常结论 &lt;thinking&gt; 示例"]) {
			assert.equal(clean(text), text);
		}
	});
}

test("清理多块长消息的语法工作量有界，不随块数重解析全文", () => {
	let parsedChars = 0;
	const instrument = (source) => ({
		parse: (text, fragments, ranges) => {
			parsedChars += text.length;
			return source.parse(text, fragments, ranges);
		},
		configure: (options) => instrument(source.configure(options)),
	});
	const { stripThinkingTags: clean } = loadTsCommonJs("src/renderer/src/utils/thinkingText.ts", { stubs: { "@lezer/markdown": { parser: instrument(parser) } } });
	const prefix = "普通内容 ".repeat(6000);
	const text = prefix + "<thinking>占位</thinking>正常片段\n".repeat(50);
	assert.equal(clean(text), (prefix + "正常片段\n".repeat(50)).trimEnd());
	assert.ok(parsedChars <= text.length * 3, `语法解析累计 ${parsedChars} 字符，不应随 50 块反复扫描全文`);
	parsedChars = 0;
	assert.equal(clean("无标记普通正文".repeat(10000)), "无标记普通正文".repeat(10000));
	assert.equal(clean("<thinking>" + "占位".repeat(30000)), "");
	assert.equal(parsedChars, 0, "无标记或从首字符开始的思考不需要 Markdown 解析");

	parsedChars = 0;
	const malformed = "<thinking>占位\n```\n</thinking>\n正常回复\n".repeat(30) + "末尾正文";
	const visible = clean(malformed);
	assert.ok(visible.includes("正常回复"));
	assert.ok(visible.endsWith("末尾正文"), "无法在预算内确认的文本宁可保留，不能误删尾部正常内容");
	assert.ok(parsedChars <= malformed.length * 3, "多次语法污染修复同样必须受总工作量约束");
});
