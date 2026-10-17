import { test, expect } from "@playwright/test";
import { build, preview, type PreviewServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let server: PreviewServer;
let baseUrl: string;
let cacheDir: string;

/** 在隔离端口挂载真实桌面/Web 正文出口，覆盖流式、落定和主题，不访问真实用户数据。 */
test.beforeAll(async () => {
	// 编译预算与页面断言分开；正文测试仍使用默认超时，不以冷启动成本放宽断言。
	test.setTimeout(180_000);
	cacheDir = await mkdtemp(join(tmpdir(), "pideck-thinking-fallback-vite-"));
	// 真实生产编译后再预览，避免开发依赖扫描/HMR 重启干扰流式和性能断言。
	await build({
		configFile: false,
		root: process.cwd(),
		logLevel: "warn",
		plugins: [tailwindcss()],
		esbuild: { jsx: "automatic" },
		resolve: { alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
		define: { __PIDECK_DEV_BUILD__: "false" },
		build: { outDir: cacheDir, emptyOutDir: true, minify: false, reportCompressedSize: false, rollupOptions: { input: resolve("e2e/fixtures/thinking-fallback.html") } },
	});
	server = await preview({ configFile: false, root: process.cwd(), build: { outDir: cacheDir }, preview: { host: "127.0.0.1", port: 0 } });
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server port");
	baseUrl = `http://127.0.0.1:${address.port}/e2e/fixtures/thinking-fallback.html`;
});

test.afterAll(async () => {
	if (server) await new Promise<void>((resolve, reject) => server.httpServer.close((error) => (error ? reject(error) : resolve())));
	if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

const outlets = ["desktop-live", "desktop-settled", "desktop-final", "web-answer"];

for (const theme of ["light", "dark"]) {
	test(`${theme}: unclosed thinking stays out of live and settled desktop/Web bodies`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: theme === "dark" ? 480 : 1280, height: 800 });
		// 首帧即带思考标记，避免把此前已经显示过的正常正文误当成泄漏。
		await page.goto(`${baseUrl}?${new URLSearchParams({ text: "<thinking>diagnostic-placeholder" })}`);
		await page.locator("html").evaluate((element, value) => {
			element.dataset.theme = value;
			element.classList.toggle("dark", value === "dark");
		}, theme);
		const source = page.getByRole("textbox", { name: "Fixture source" });
		await expect(source).toBeVisible();
		for (const id of outlets) {
			await expect(page.getByTestId(id)).toHaveText("");
		}
		for (const text of ["<thinking>diagnostic-placeholder\n第二行", "<thinking>diagnostic-placeholder</thinking>\n正常回复", "正常回复\n<thinking>diagnostic-placeholder"]) {
			await source.fill(text);
			for (const id of outlets) {
				const outlet = page.getByTestId(id);
				if (text.includes("正常回复")) await expect(outlet).toContainText("正常回复");
				await expect(outlet).not.toContainText("diagnostic-placeholder");
			}
		}
		await page.getByRole("button", { name: "Settle fixture" }).click();
		for (const id of outlets) {
			await expect(page.getByTestId(id)).toContainText("正常回复");
			await expect(page.getByTestId(id)).not.toContainText("diagnostic-placeholder");
		}
		// 真正的 FinalAnswer → AssistantText 在重新挂载后仍遵循同一清理边界。
		await page.getByRole("button", { name: "Remount fixture" }).click();
		await expect(page.getByTestId("desktop-final")).toHaveText("正常回复");
		// 截图中只保留正文出口；不把输入夹具里的占位文本误当成可见回复。
		await source.evaluate((element) => {
			element.style.display = "none";
		});
		await page.screenshot({ path: testInfo.outputPath(`thinking-fallback-${theme}.png`) });
	});
}

for (const [prefix, continuation] of [
	["> ", "> "],
	["- > ", "  > "],
	["> - > ", ">   > "],
]) {
	test(`${prefix}quoted tilde code and following conclusion survive settled rendering`, async ({ page }, testInfo) => {
		const text = `${prefix}~~~xml\n${continuation}<thinking>代码示例\n${continuation}~~~\n\n正常结论不能丢失`;
		await page.goto(`${baseUrl}?${new URLSearchParams({ text })}`);
		await page.getByRole("button", { name: "Settle fixture" }).click();
		for (const id of outlets) {
			const outlet = page.getByTestId(id);
			await expect(outlet).toContainText("正常结论不能丢失");
			await expect(outlet.locator("blockquote code")).toContainText("<thinking>代码示例");
		}
		await page.getByRole("button", { name: "Remount fixture" }).click();
		await expect(page.getByTestId("desktop-final")).toContainText("正常结论不能丢失");
		await page.screenshot({ path: testInfo.outputPath("quoted-code-final-answer.png") });
	});
}

test("thinking after an exited list fence is hidden", async ({ page }) => {
	await page.goto(`${baseUrl}?${new URLSearchParams({ text: "- ~~~xml\n  code\n\n<thinking>diagnostic-placeholder" })}`);
	await page.getByRole("button", { name: "Settle fixture" }).click();
	for (const id of outlets) {
		await expect(page.getByTestId(id).locator("code")).toContainText("code");
		await expect(page.getByTestId(id)).not.toContainText("diagnostic-placeholder");
	}
});

test("indented code stays readable after unchanged final-answer edit/save", async ({ page }, testInfo) => {
	const text = "    <thinking>代码示例\n\n正常结论不能丢失";
	await page.goto(`${baseUrl}?${new URLSearchParams({ text })}`);
	await page.getByRole("button", { name: "Settle fixture" }).click();
	await page.getByRole("button", { name: "Edit fixture" }).click();
	const final = page.getByTestId("desktop-final");
	await expect(final.getByRole("textbox")).toHaveValue(text);
	await final.getByRole("button", { name: /^(保存|Save)$/ }).click();
	await expect(final.getByRole("textbox")).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Fixture source" })).toHaveValue(text);
	for (const id of outlets) {
		await expect(page.getByTestId(id)).toContainText("正常结论不能丢失");
		await expect(page.getByTestId(id).locator("code")).toContainText("<thinking>代码示例");
	}
	await page.getByRole("button", { name: "Remount fixture" }).click();
	await expect(final.locator("code")).toContainText("<thinking>代码示例");
	await expect(final).toContainText("正常结论不能丢失");
	await page.screenshot({ path: testInfo.outputPath("edit-save-final-answer.png") });
});

for (const [label, text] of [
	["link title", '[说明](https://example.invalid/docs "<thinking>")\n\n正常结论应保留。'],
	["HTML comment", "<!-- 标签示例 <thinking> -->\n\n正常结论应保留。"],
	["HTML attribute", '<span title="<thinking>">正常文字</span>\n\n正常结论应保留。'],
	["pre block", "<pre>\n<thinking>代码示例\n</pre>\n\n正常结论应保留。"],
]) {
	test(`${label} literal keeps normal conclusion in real answer outlets`, async ({ page }) => {
		await page.goto(`${baseUrl}?${new URLSearchParams({ text })}`);
		await page.getByRole("button", { name: "Settle fixture" }).click();
		for (const id of outlets) await expect(page.getByTestId(id)).toContainText("正常结论应保留。");
		await page.getByRole("button", { name: "Remount fixture" }).click();
		await expect(page.getByTestId("desktop-final")).toContainText("正常结论应保留。");
	});
}

test("many thinking blocks keep browser work bounded and the final prose visible", async ({ page }, testInfo) => {
	await page.goto(baseUrl);
	await expect(page.getByRole("textbox", { name: "Fixture source" })).toBeVisible();
	const timing = await page.evaluate(() => {
		const clean: unknown = Reflect.get(window, "fixtureCleanThinking");
		if (typeof clean !== "function") throw new Error("Missing fixture cleaner");
		const prefix = "普通内容 ".repeat(6000);
		function median(blocks: number) {
			const text = prefix + "<thinking>占位</thinking>正常片段\n".repeat(blocks);
			const times: number[] = [];
			for (let i = 0; i < 6; i += 1) {
				const start = performance.now();
				const visible: unknown = clean(text);
				if (typeof visible !== "string" || visible.includes("<thinking>") || !visible.endsWith("正常片段")) throw new Error("Incorrect long-message output");
				if (i > 0) times.push(performance.now() - start);
			}
			return times.sort((a, b) => a - b)[2];
		}
		return { singleMs: median(1), fiftyMs: median(50) };
	});
	await testInfo.attach("thinking-browser-timing", { body: JSON.stringify(timing), contentType: "application/json" });
	// 宽裕的长任务回归门槛；精确解析工作量由单测的 3N 确定性门禁承担。
	expect(timing.fiftyMs).toBeLessThan(200);
	expect(timing.fiftyMs).toBeLessThan(timing.singleMs * 6 + 20);
});

test("literal tags in code samples remain readable", async ({ page }) => {
	await page.goto(`${baseUrl}?${new URLSearchParams({ text: "保留 `<thinking>` 字面量。\n\n```xml\n<thinking>代码示例\n```\n\n正常结论" })}`);
	await page.getByRole("button", { name: "Settle fixture" }).click();
	for (const id of outlets) {
		const outlet = page.getByTestId(id);
		await expect(outlet).toContainText("正常结论");
		await expect(outlet.locator("code").filter({ hasText: "<thinking>" }).first()).toBeVisible();
		await expect(outlet).toContainText("代码示例");
	}
});
