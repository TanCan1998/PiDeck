/**
 * bridgeServices 单测：宿主原生服务（gui.filePicker / gui.openPath）的
 * 参数校验（纯函数）与执行器（注入桩依赖）。
 *
 * 校验是安全边界（AGENTS.md「输入校验在边界」「路径安全」）——
 * 扩展侧数据不可信，非法形状必须在碰 Electron API 之前被拒掉。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseFilePickerArgs, parseOpenPathArgs, createBridgeServiceHandler } = loadTsCommonJs("src/main/pi/bridge/bridgeServices.ts");

/** 沙箱模块返回的对象是跨 realm 的（vm 不同 Object.prototype），deepStrictEqual 会因原型不同误报；用 JSON 比较。 */
function jsonEqual(actual, expected, message) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

// ── parseFilePickerArgs：形状与上限 ─────────────────────────────
test("filePicker 参数校验：合法形状全通过", () => {
	jsonEqual(parseFilePickerArgs(undefined), {});
	jsonEqual(parseFilePickerArgs(null), {});
	jsonEqual(parseFilePickerArgs({}), {});
	jsonEqual(parseFilePickerArgs({ title: "选文件", multiple: true, directory: false }), { title: "选文件", multiple: true, directory: false });
	jsonEqual(parseFilePickerArgs({ filters: [{ name: "TS", extensions: ["ts", "tsx"] }] }), { filters: [{ name: "TS", extensions: ["ts", "tsx"] }] });
});

test("filePicker 参数校验：非对象与非法字段拒绝", () => {
	assert.equal(parseFilePickerArgs("x"), null);
	assert.equal(parseFilePickerArgs(42), null);
	assert.equal(parseFilePickerArgs({ title: 123 }), null);
	assert.equal(parseFilePickerArgs({ multiple: "yes" }), null);
	assert.equal(parseFilePickerArgs({ directory: 1 }), null);
});

test("filePicker 参数校验：上限与扩展名字符集", () => {
	assert.equal(parseFilePickerArgs({ title: "x".repeat(201) }), null, "标题超 200 字符拒绝");
	assert.equal(parseFilePickerArgs({ filters: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, extensions: ["ts"] })) }), null, "过滤器超 10 个拒绝");
	assert.equal(parseFilePickerArgs({ filters: [{ name: "x".repeat(101), extensions: ["ts"] }] }), null, "过滤器名超 100 字符拒绝");
	assert.equal(parseFilePickerArgs({ filters: [{ name: "f", extensions: [] }] }), null, "空扩展名列表拒绝");
	assert.equal(parseFilePickerArgs({ filters: [{ name: "f", extensions: Array.from({ length: 21 }, () => "ts") }] }), null, "单过滤器扩展名超 20 个拒绝");
	assert.equal(parseFilePickerArgs({ filters: [{ name: "f", extensions: ["a b"] }] }), null, "扩展名带空格拒绝（只允许字母数字）");
	assert.equal(parseFilePickerArgs({ filters: [{ name: "f", extensions: ["x".repeat(17)] }] }), null, "扩展名超 16 字符拒绝");
	assert.equal(parseFilePickerArgs({ filters: [{ name: "f", extensions: ["png"] }] }).filters.length, 1, "合法过滤器通过");
});

// ── parseOpenPathArgs：只接受绝对本地路径 ───────────────────────
test("openPath 参数校验：绝对本地路径通过，其余拒绝", () => {
	for (const ok of ["C:\\Users\\demo\\file.txt", "C:/Users/demo", "\\\\server\\share\\doc.md", "/home/demo/file.txt"]) {
		jsonEqual(parseOpenPathArgs({ path: ok }), { path: ok }, `应放行: ${ok}`);
	}
	for (const bad of ["file.txt", "folder/file.txt", "https://example.com/x", "file:///C:/evil.txt", "", "C:\\x" + "y".repeat(2100), 42]) {
		assert.equal(parseOpenPathArgs({ path: bad }), null, `应拒绝: ${String(bad)}`);
	}
	assert.equal(parseOpenPathArgs(null), null);
	assert.equal(parseOpenPathArgs("nope"), null);
});

// ── createBridgeServiceHandler：执行器映射（桩依赖）────────────
function makeHandler(overrides = {}) {
	const calls = [];
	const deps = {
		showOpenDialog: async (options) => {
			calls.push({ kind: "dialog", options });
			return overrides.dialogResult ?? { canceled: false, filePaths: ["C:\\picked\\a.ts"] };
		},
		openPath: async (path) => {
			calls.push({ kind: "open", path });
			return overrides.openResult ?? "";
		},
		...overrides.deps,
	};
	return { handler: createBridgeServiceHandler(deps), calls };
}

test("filePicker 执行：目录/多选映射到 dialog properties", async () => {
	const { handler, calls } = makeHandler();
	const out = await handler("filePicker", { multiple: true, directory: true, title: "T", filters: [{ name: "TS", extensions: ["ts"] }] });
	jsonEqual(out, ["C:\\picked\\a.ts"]);
	assert.equal(calls.length, 1);
	assert.deepEqual([...calls[0].options.properties], ["openDirectory", "multiSelections"]);
	assert.equal(calls[0].options.title, "T");
});

test("filePicker 执行：默认单选文件；取消/空选返回 null", async () => {
	const a = makeHandler();
	const out = await a.handler("filePicker", undefined);
	jsonEqual([...a.calls[0].options.properties], ["openFile"], "默认 openFile");
	jsonEqual(out, ["C:\\picked\\a.ts"]);

	const b = makeHandler({ dialogResult: { canceled: true, filePaths: [] } });
	assert.equal(await b.handler("filePicker", {}), null, "取消 → null");

	const c = makeHandler({ dialogResult: { canceled: false, filePaths: [] } });
	assert.equal(await c.handler("filePicker", {}), null, "空选 → null");
});

test("filePicker 执行：非法参数抛错且不碰 dialog", async () => {
	const { handler, calls } = makeHandler();
	await assert.rejects(() => handler("filePicker", { title: 7 }), /invalid filePicker args/);
	assert.equal(calls.length, 0);
});

test("openPath 执行：成功映射 true，宿主报错映射 false", async () => {
	const ok = makeHandler();
	assert.equal(await ok.handler("openPath", { path: "C:\\picked\\a.ts" }), true);
	assert.equal(ok.calls.length, 1);

	const fail = makeHandler({ openResult: "ENOENT" });
	assert.equal(await fail.handler("openPath", { path: "C:\\gone.txt" }), false);
});

test("未知服务名抛错", async () => {
	const { handler } = makeHandler();
	await assert.rejects(() => handler("shellExec", {}), /unknown service/);
});
