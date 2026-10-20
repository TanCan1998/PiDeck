import { expect, test } from "./mock-pi-fixture";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSeedProject } from "./open-session";

/**
 * Markdown 图片布局冒烟（2026-10，对话内图片渲染改造的机器守卫）。
 *
 * 为什么需要 e2e：这条链路的失败都发生在「单测看不到的中间层」——`mdast-util-to-hast`
 * 会把反斜杠编码成 %5C、streamdown 内部跑 `rehype-sanitize` 会剥掉非白名单属性、
 * Windows `app.getPath("temp")` 是 8.3 短名。三轮真机 smoke 才把它们逐个撞出来，
 * 所以这里用真实 Electron + 真实渲染管线断言**用户看得见的几何结果**：
 * 同段两张 → 两个 96×96 瓷砖且同一行；单图 → 高度 360 上限；点击 → 全屏预览可开可关。
 *
 * 布局规则照 dsh：单图 `max-width: min(100%, 640px)` + `max-height: 360px`，
 * 同段多图 96px 方块瓷砖（原始 64px 太小，按 PiDeck 观感放大）。
 */

const repoRoot = resolve(__dirname, "..");
const project = makeSeedProject("img-layout");
const imageDir = join(project.path, "img");
mkdirSync(imageDir, { recursive: true });
// 1254×1254 的正方图：单图规则下会被高度 360 约束成 360×360，瓷砖下被裁成 96×96
copyFileSync(join(repoRoot, "docs", "images", "88vip.png"), join(imageDir, "big.png"));

const now = Date.now();
const at = (offsetMs: number) => new Date(now - offsetMs).toISOString();

test.use({
	seedProjects: [project],
	seedSessionFiles: [
		{
			projectPath: project.path,
			entries: [
				{ type: "session", version: 3, id: "img-layout-h", parentId: null, name: "图片布局巡检", cwd: project.path, timestamp: at(60_000) },
				{ type: "message", id: "img-layout-1", parentId: "img-layout-h", timestamp: at(59_000), message: { role: "user", content: [{ type: "text", text: "图片布局巡检" }] } },
				{
					type: "message",
					id: "img-layout-2",
					parentId: "img-layout-1",
					timestamp: at(58_000),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "同段两张：\n\n![甲](img/big.png) ![乙](img/big.png)\n\n单图上限：\n\n![丙](img/big.png)" }],
					},
				},
			],
		},
	],
});

test("markdown 图片布局：同段多图并排瓷砖、单图限高、点击开预览", async ({ window }) => {
	test.setTimeout(60_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 打开种子项目下的历史会话（不启动 agent）
	await window.getByRole("tab", { name: "项目" }).click();
	await window.locator(".conversation", { hasText: "img-layout" }).first().click();
	const historyRow = window.locator(".conversation", { hasText: "图片布局巡检" }).first();
	await expect(historyRow).toBeVisible({ timeout: 20_000 });
	await historyRow.click();

	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("同段两张", { timeout: 20_000 });

	const images = timeline.locator("img");
	await expect(images).toHaveCount(3, { timeout: 15_000 });

	// 图片真的加载成功（白图/破图会 naturalWidth 为 0）
	for (const index of [0, 1, 2]) {
		await expect.poll(() => images.nth(index).evaluate((node) => (node as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
	}
	// 本地图必须走白名单协议，不许退回 file://
	await expect(images.nth(0)).toHaveAttribute("src", /^pideck-file:\/\//);

	// 同段两张：96×96 且同一行
	const first = await images.nth(0).boundingBox();
	const second = await images.nth(1).boundingBox();
	expect(first?.width).toBeCloseTo(96, 0);
	expect(first?.height).toBeCloseTo(96, 0);
	expect(second?.width).toBeCloseTo(96, 0);
	expect(second?.height).toBeCloseTo(96, 0);
	expect(Math.abs((first?.y ?? 0) - (second?.y ?? 0))).toBeLessThan(2);
	expect(second?.x ?? 0).toBeGreaterThan(first?.x ?? 0);

	// 单图：高度 360 上限（方图 → 360×360），宽度不超过 640
	const single = await images.nth(2).boundingBox();
	expect(single?.height).toBeCloseTo(360, 0);
	expect(single?.width).toBeCloseTo(360, 0);
	expect(single?.width ?? 0).toBeLessThanOrEqual(641);

	// 点击瓷砖 → 全屏预览；Esc 关闭（焦点管理见 modalKeyboardAccess 契约测试）
	await images.nth(0).click();
	const dialog = window.getByRole("dialog");
	await expect(dialog).toBeVisible({ timeout: 5_000 });
	await window.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0, { timeout: 5_000 });
});
