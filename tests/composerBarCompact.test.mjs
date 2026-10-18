/**
 * 底栏图标紧凑度契约（2026-10 用户反馈：+ / 盾牌 / 快捷消息之间像隔着两条「空列」）。
 *
 * 成因：每个图标按钮 size-7（28px）包着 15px 图标 → 左右各 6.5px 透明内边距；再叠父级 gap-0.5（2px）
 * 与竖线 mx-0.5（4px），视觉上就成了两条空列。
 * 修法：会话级控制组内部 gap-0、竖线 mx-0，图标按钮统一 size-6（24px，仍满足最小点按尺寸）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const security = readFileSync("src/renderer/src/components/session/SecurityLevelMenu.tsx", "utf8");
const dshPermission = readFileSync("src/renderer/src/components/session/DshPermissionMenu.tsx", "utf8");
const quickMessages = readFileSync("src/renderer/src/components/session/QuickMessageMenu.tsx", "utf8");

test("会话级控制组内部不叠间距：gap-0；底栏不再摆竖线分界", () => {
	assert.match(composer, /<div className="flex shrink-0 items-center gap-0">/, "会话级控制组必须 gap-0");
	// 竖线分界整体移除（2026-10 用户反馈「回到最初的样子，没有也行」）：
	// 历史那条线因 Separator 竖向 h-full 被压掉一直是不可见的 1px 空列，修好后露出来反而多余。
	// 契约：不再 import 也不再渲染竖向 Separator，左区只靠间距分组。
	assert.doesNotMatch(composer, /ui-shadcn\/separator/);
	assert.doesNotMatch(composer, /<Separator orientation="vertical"/);
});

test("图标按钮统一 size-6（24px）：+ / 安全等级 / DSH 权限 / 快捷消息", () => {
	assert.match(composer, /composer-bar-btn icon size-6 rounded-md/);
	assert.match(security, /composer-bar-btn security size-6 rounded-md/, "pi 安全等级触发按钮");
	assert.match(dshPermission, /composer-bar-btn security dsh size-6 rounded-md/, "DSH 权限触发按钮");
	assert.match(quickMessages, /composer-bar-btn quick-messages icon size-6 rounded-md/, "快捷消息触发按钮");
	// 回归：不要再出现 28px 的透明内边距（空列的直接来源）
	assert.doesNotMatch(security, /security size-7/);
	assert.doesNotMatch(dshPermission, /security dsh size-7/);
	assert.doesNotMatch(quickMessages, /quick-messages icon size-7/);
});
