import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRequestGate } = loadTsCommonJs("src/renderer/src/components/session/remoteRequestGate.ts");
const { sortRemoteEntries } = loadTsCommonJs("src/renderer/src/components/session/remoteProjectEntries.ts");
const panel = readFileSync("src/renderer/src/components/session/RemoteProjectPanel.tsx", "utf8");

test("切项目/卸载后，旧代次的迟到结果一律作废", () => {
	const gate = createRequestGate();
	const first = gate.begin();
	assert.equal(gate.isCurrent(first), true);
	// 切项目 = 开启新一代：上一个项目在途的结果必须被丢弃。
	const second = gate.begin();
	assert.equal(gate.isCurrent(first), false);
	assert.equal(gate.isCurrent(second), true);
	// 卸载 = 作废全部在途结果。
	gate.invalidate();
	assert.equal(gate.isCurrent(second), false);
});

test("目录在前文件在后，同类按名字；不修改入参数组", () => {
	const input = [
		{ name: "b.txt", kind: "file" },
		{ name: "z-dir", kind: "directory" },
		{ name: "a.txt", kind: "file" },
		{ name: "a-dir", kind: "directory" },
		{ name: "link", kind: "other" },
	];
	const sorted = sortRemoteEntries(input);
	// 沙箱里返回的数组原型属于另一 realm，先展开到测试侧再比较。
	assert.deepEqual([...sorted.map((entry) => entry.name)], ["a-dir", "z-dir", "a.txt", "b.txt", "link"]);
	assert.deepEqual(
		input.map((entry) => entry.name),
		["b.txt", "z-dir", "a.txt", "a-dir", "link"],
	);
});

test("面板用代次闸门丢弃迟到结果，并在卸载时作废在途请求", () => {
	assert.match(panel, /createRequestGate/);
	assert.match(panel, /const gate = gateRef\.current;\s*\n\s*const generation = gate\.begin\(\);/);
	assert.match(panel, /if \(!gate\.isCurrent\(generation\)\) return;/);
	assert.match(panel, /gateRef\.current\.invalidate\(\)/);
});

test("失败与空目录分开呈现：error 只在失败时出现，空提示只在列出成功后出现", () => {
	// 旧实现共用一个 message：列出失败也可能同时显示「这个目录是空的」。
	assert.match(panel, /const \[error, setError\] = useState<string \| null>\(null\)/);
	assert.match(panel, /const \[listed, setListed\] = useState\(false\)/);
	assert.match(panel, /setListed\(false\);/, "a failed listing must not claim to have listed");
	assert.match(panel, /listed && error === null && entries\.length === 0/);
	assert.match(panel, /setError\(t\("project\.remote\.requestFailed"\)\)/, "an IPC reject must surface as a retryable failure, not as an empty directory");
});

test("主机未连接与路径错误分开说，消除失败后仍显示旧条目", () => {
	assert.match(panel, /isNotConnectedCode\(result\.code\) \? t\("project\.remote\.notConnectedHint"\)/);
	assert.match(panel, /setEntries\(\[\]\);/);
});

test("面板文案键在中英词典里都存在", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const keys = new Set();
	for (const match of panel.matchAll(/(?<![A-Za-z0-9_$])t\("([^"]+)"\)/g)) keys.add(match[1]);
	assert.ok(keys.size > 5);
	for (const key of keys) {
		assert.ok(zh.includes(`"${key}":`), `缺中文文案 ${key}`);
		assert.ok(en.includes(`"${key}":`), `缺英文文案 ${key}`);
	}
});
