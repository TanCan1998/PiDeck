import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { plainTextCopySource } = loadTsCommonJs("src/renderer/src/components/session/timeline/messageCopyText.ts");

test("多选助手纯文本源隐藏未闭合思考，保留正常前文", () => {
	assert.equal(plainTextCopySource({ role: "assistant", text: "正常回复\n<thinking>诊断占位内容" }), "正常回复");
	assert.equal(plainTextCopySource({ role: "assistant", text: "<thinking>诊断占位内容" }), "");
});

test("多选复制保留用户原话中的思考标签，不修改消息对象", () => {
	const message = { role: "user", text: "请解释 <thinking> 这个标签" };
	assert.equal(plainTextCopySource(message), message.text);
	assert.equal(message.text, "请解释 <thinking> 这个标签");
});

test("多选助手纯文本源保留嵌套引用代码后的正常结论", () => {
	const text = "- > ~~~xml\n  > <thinking>代码示例\n  > ~~~\n\n正常结论";
	assert.equal(plainTextCopySource({ role: "assistant", text }), text);
});
