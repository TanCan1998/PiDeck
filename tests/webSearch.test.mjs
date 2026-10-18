/**
 * Web 会话内搜索单测（第二批）：多 part 文本拼接、大小写不敏感、
 * 上下文截断、limit 上限、无命中返回空数组。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { searchWebMessages, webMessageText } = loadTsCommonJs("src/renderer/src/web/webSearch.ts");

function message(id, role, texts) {
	return { id, role, parts: texts.map((text) => ({ type: "text", text })) };
}

test("webMessageText: 拼接多个 text part", () => {
	assert.equal(webMessageText(message("m1", "user", ["hello ", "world"])), "hello \nworld");
});

test("searchWebMessages: 大小写不敏感命中并返回上下文片段", () => {
	const messages = [message("m1", "user", ["Fix the Authentication bug"]), message("m2", "assistant", ["all good"])];
	const hits = searchWebMessages(messages, "authentication");
	assert.equal(hits.length, 1);
	assert.equal(hits[0].id, "m1");
	assert.equal(hits[0].role, "user");
	assert.ok(hits[0].snippet.includes("Authentication"));
});

test("searchWebMessages: 命中多次只取第一处，长文本截断带省略号", () => {
	const long = `${"x".repeat(80)}NEEDLE${"y".repeat(80)}`;
	const hits = searchWebMessages([message("m1", "assistant", [long])], "needle", 5);
	assert.equal(hits.length, 1);
	assert.ok(hits[0].snippet.length < long.length);
	assert.ok(hits[0].snippet.includes("NEEDLE"));
});

test("searchWebMessages: limit 生效且顺序稳定（按消息序）", () => {
	const messages = [message("m1", "user", ["needle one"]), message("m2", "user", ["needle two"]), message("m3", "user", ["needle three"])];
	const hits = searchWebMessages(messages, "needle", 2);
	assert.equal(hits.length, 2);
	assert.deepEqual(Array.from(hits.map((hit) => hit.id)), ["m1", "m2"]);
});

test("searchWebMessages: 空查询或无命中返回空数组", () => {
	const messages = [message("m1", "user", ["hello"])];
	assert.deepEqual(Array.from(searchWebMessages(messages, "")), []);
	assert.deepEqual(Array.from(searchWebMessages(messages, "zzz")), []);
});
