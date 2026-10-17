import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 使用真实依赖图，纯函数新增共享 import 不应使测试加载器失效。 */
function loadDocActionsModule() {
	return loadTsCommonJs("src/main/feishu/docActions.ts");
}

test("detects Feishu doc intent from user message", () => {
	const { wantsFeishuDoc } = loadDocActionsModule();

	assert.equal(wantsFeishuDoc("普通聊天消息"), undefined);
	assert.equal(wantsFeishuDoc("帮我做飞书文档"), "Pi Agent 文档");
	assert.equal(wantsFeishuDoc("整理这些内容，标题叫 今日新闻，做飞书文档"), "今日新闻");
	assert.equal(wantsFeishuDoc("创建文档"), undefined);
	assert.ok(wantsFeishuDoc("写一个飞书文档总结本周工作"));
});

test("removes Feishu action markers before writing document body", () => {
	const { stripFeishuActionMarkers } = loadDocActionsModule();

	assert.equal(stripFeishuActionMarkers("正文\n[CREATE_DOC:今日新闻]\n[SEND_FILE:/tmp/a.md]"), "正文");
});

test("builds Feishu text children from assistant body", () => {
	const { buildFeishuTextChildren } = loadDocActionsModule();
	const children = buildFeishuTextChildren("第一段\n\n第二段\n[CREATE_DOC:测试]");

	assert.equal(children.length, 1);
	assert.equal(children[0].block_type, 2);
	assert.equal(children[0].text.elements[0].text_run.content, "第一段\n\n第二段");
});
