import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import test from "node:test";

/**
 * 控件高度契约（P0 UI 收敛，2027-10）：
 *
 * 设置页与配置管理页曾经各写各的高度（h-7 / h-8 / h-9 / h-10 混用），
 * 同一屏里输入框、下拉、开关参差不齐。收敛后只允许两档：
 * - default = 36px（h-9）：设置行、对话框、卡片表单；
 * - sm = 32px（h-8）：表格行内编辑、卡片内联字段。
 *
 * 调用处禁止再写临时高度，必须走 `size` prop；本测试扫描页面源码兜底，
 * 新增页面照抄旧写法会在这里红。
 */

const CONTROL_PAGES = ["src/renderer/src/components/app/settings", "src/renderer/src/config", "src/renderer/src/components/config", "src/renderer/src/components/automation"];

/** 允许保留自定义高度的例外：输入条/底栏 chip 是另一套紧凑 chrome，不属表单控件。 */
const ALLOWED_CUSTOM_HEIGHT = [/composer-bar-btn/, /prompt-input\.tsx/, /GitRepoSwitcher\.tsx/];

test("Input 与 SelectTrigger 共享 default/sm 两档高度", () => {
	const input = readFileSync("src/renderer/src/components/ui-shadcn/input.tsx", "utf8");
	const select = readFileSync("src/renderer/src/components/ui-shadcn/select.tsx", "utf8");

	assert.match(input, /size\?:\s*"default"\s*\|\s*"sm"/);
	assert.match(input, /data-size=\{size\}/);
	assert.match(input, /data-\[size=default\]:h-9[\s\S]*?data-\[size=sm\]:h-8/);
	// 基线不再写死 h-9，否则 size="sm" 会被 tailwind-merge 之外的优先级压住
	assert.doesNotMatch(input, /className=\{cn\(\s*\n?\s*"h-9/);

	assert.match(select, /data-\[size=default\]:h-9[\s\S]*?data-\[size=sm\]:h-8/);
});

test("设置/配置/自动化页面不再直接写控件高度", () => {
	const offenders = [];
	for (const dir of CONTROL_PAGES) {
		for (const file of globSync(`${dir}/**/*.tsx`, { cwd: process.cwd() })) {
			if (ALLOWED_CUSTOM_HEIGHT.some((pattern) => pattern.test(file))) continue;
			const source = readFileSync(file, "utf8");
			const matcher = /<(Input|SelectTrigger|Textarea)\b[^>]*?className="[^"]*\bh-(?:7|10)\b/g;
			for (const hit of source.matchAll(matcher)) {
				offenders.push(`${file}: ${hit[0].slice(0, 80)}`);
			}
		}
	}
	assert.deepEqual(offenders, [], `表单控件高度必须走 size prop（default=36 / sm=32）：\n${offenders.join("\n")}`);
});
