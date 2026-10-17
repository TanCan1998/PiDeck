import { rm } from "node:fs/promises";
import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

const project = makeSeedProject("ThinkingHistory");
const quotedCode = "- > ~~~xml\n  > <thinking>引用代码示例\n  > ~~~\n\n引用代码后正常结论";
const indentedCode = "    <thinking>缩进代码示例\n\n缩进代码后正常结论";

/** 种子 JSONL 只落临时项目；经过真实历史读取、分组和 FinalAnswer，不启动模型。 */
const entries = [
	{ type: "session", version: 3, id: "thinking-history", cwd: project.path, timestamp: "2026-01-01T00:00:00.000Z" },
	{ type: "session_info", id: "title", parentId: null, name: "ThinkingHistoryRegression" },
	{ type: "message", id: "u1", parentId: "title", message: { role: "user", content: [{ type: "text", text: "ThinkingHistoryRegression" }] } },
	{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "<thinking>diagnostic-placeholder" }] } },
	{ type: "message", id: "a2", parentId: "a1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: quotedCode }] } },
	{ type: "message", id: "u2", parentId: "a2", message: { role: "user", content: [{ type: "text", text: "继续检查缩进代码" }] } },
	{ type: "message", id: "a3", parentId: "u2", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: indentedCode }] } },
];

test.use({ seedProjects: [project], seedSessionFiles: [{ projectPath: project.path, entries }] });

test.afterAll(async () => {
	await rm(project.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("Electron history keeps code and conclusions after reload without exposing marked thinking", async ({ window }, testInfo) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await window.getByRole("tab", { name: /^(项目|Projects)$/ }).click();
	await window.getByRole("button", { name: "展开", exact: true }).click();
	const sessionRow = window.locator(".conversation", { hasText: "ThinkingHistoryRegression" }).first();
	await expect(sessionRow).toBeVisible({ timeout: 30_000 });
	await sessionRow.click();
	const answers = window.locator("[data-final-answer]");
	await expect(answers).toHaveCount(2, { timeout: 30_000 });
	await expect(answers.nth(0)).toContainText("引用代码后正常结论");
	await expect(answers.nth(0).locator("blockquote code")).toContainText("<thinking>引用代码示例");
	await expect(answers.nth(1)).toContainText("缩进代码后正常结论");
	await expect(answers.nth(1).locator("code")).toContainText("<thinking>缩进代码示例");
	await expect(window.locator(".message-timeline")).not.toContainText("diagnostic-placeholder");
	await window.screenshot({ path: testInfo.outputPath("thinking-history-electron.png") });
	await window.reload();
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await sessionRow.click();
	await expect(answers).toHaveCount(2, { timeout: 30_000 });
	await expect(answers.nth(0)).toContainText("引用代码后正常结论");
	await expect(answers.nth(1)).toContainText("缩进代码后正常结论");
	await expect(answers.nth(1).locator("code")).toContainText("<thinking>缩进代码示例");
	await window.screenshot({ path: testInfo.outputPath("thinking-history-reloaded.png") });

	// 只在隔离窗口拦截 Clipboard API 记录复制结果，不写系统剪贴板。
	await window.evaluate(() => {
		Object.defineProperty(navigator.clipboard, "writeText", {
			configurable: true,
			value: async (text: string) => {
				document.documentElement.dataset.fixtureCopy = text;
			},
		});
	});
	await window.getByRole("button", { name: "多选分享", exact: true }).last().click();
	const share = window.getByRole("dialog", { name: "多选分享" });
	await expect(share).toBeVisible();
	await share.getByRole("button", { name: "分享为文本", exact: true }).click();
	await expect(share).not.toBeVisible();
	const copied = await window.locator("html").getAttribute("data-fixture-copy");
	expect(copied).toContain("引用代码后正常结论");
	expect(copied).toContain("缩进代码后正常结论");
	expect(copied).not.toContain("diagnostic-placeholder");
});
