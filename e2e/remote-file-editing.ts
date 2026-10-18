import { expect, type Page, type TestInfo } from "@playwright/test";
import { runRemoteCommand, remoteProjectRow, type RemoteAcceptanceCredentials } from "./remote-fixtures";
import { historyEntries } from "./remoteHistoryAssertions";

const INITIAL = "module.exports = { value: 1 };\n";
export const REMOTE_EDITED_CODE = "module.exports = { value: 2 };\n// 中文保存验收 'quotes' \\backslash\n";
const EXTERNAL = "module.exports = { value: 3 };\n// external change\n";
const DRAFT = "module.exports = { value: 4 };\n// unsaved draft\n";

/** 只初始化本次专用项目；Agent随后用test.cjs验收UI保存后的代码，禁止访问用户原始文件。 */
export async function initializeRemoteCodeFixture(credentials: RemoteAcceptanceCredentials, projectPath: string): Promise<void> {
	// pi自身由已验证nvm Node启动，但bash的PATH可能仍是系统Node；此测试不需要新API。
	const testCode = "const assert = require('assert');\nassert.strictEqual(require('./calc.cjs').value, 2);\nconsole.log('REMOTE_FILE_TEST_OK');\n";
	for (const [name, content] of [
		["calc.cjs", INITIAL],
		["test.cjs", testCode],
		["crlf.txt", "\ufefffirst\r\nsecond\r\n"],
	])
		await runRemoteCommand(credentials, "umask 077; printf '%s' '" + Buffer.from(content).toString("base64") + "' | base64 -d > '" + projectPath + "/" + name + "'", 60_000);
}

async function replaceEditor(window: Page, content: string): Promise<void> {
	const editor = window.getByRole("region", { name: "远端文件编辑器" }).locator(".cm-content");
	await expect(editor).toBeVisible();
	await editor.click();
	await window.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
	await window.keyboard.insertText(content);
}

/** 真正点击编辑/保存/重载，不走IPC直调；SSH只作前置、外部冲突注入和独立文件佐证。 */
export async function verifyRemoteCodeEditing(input: { window: Page; credentials: RemoteAcceptanceCredentials; projectPath: string; testInfo: TestInfo; timeoutMs: number }): Promise<void> {
	const { window, credentials, projectPath, testInfo, timeoutMs } = input;
	const path = projectPath + "/calc.cjs";
	const read = async () => (await runRemoteCommand(credentials, "cat -- '" + path + "'", 60_000)).stdout;
	const mode = async () => (await runRemoteCommand(credentials, "stat -c '%a' -- '" + path + "'", 60_000)).stdout.trim();
	const region = window.getByRole("region", { name: "远端文件编辑器" });
	await window.getByRole("button", { name: "calc.cjs", exact: false }).click();
	await expect(region.locator(".cm-content")).toContainText("value: 1", { timeout: timeoutMs });
	await replaceEditor(window, REMOTE_EDITED_CODE);
	await expect(region.getByText("未保存草稿", { exact: true })).toBeVisible();
	// 持续编辑不应静默触发本机500ms autosave。
	await window.waitForTimeout(800);
	expect(await read()).toBe(INITIAL);
	await region.getByRole("button", { name: "保存远端文件", exact: true }).click();
	await expect(region.getByText("已保存", { exact: true })).toBeVisible({ timeout: timeoutMs });
	expect(await read()).toBe(REMOTE_EDITED_CODE);
	expect(await mode()).toBe("600");
	await region.getByRole("button", { name: "重新加载文件", exact: true }).click();
	await expect(region.locator(".cm-content")).toContainText("中文保存验收", { timeout: timeoutMs });
	await testInfo.attach("remote-code-after-save", { body: Buffer.from(await read()), contentType: "text/plain" });

	await runRemoteCommand(credentials, "printf '%s' '" + Buffer.from(EXTERNAL).toString("base64") + "' | base64 -d > '" + path + "'", 60_000);
	await replaceEditor(window, DRAFT);
	await region.getByRole("button", { name: "保存远端文件", exact: true }).click();
	await expect(region.getByRole("alert")).toContainText("已拒绝覆盖", { timeout: timeoutMs });
	expect(await read()).toBe(EXTERNAL);
	await expect(region.locator(".cm-content")).toContainText("unsaved draft");
	await expect(region.getByRole("button", { name: "保存远端文件", exact: true })).toBeDisabled();
	await window.getByRole("button", { name: "hello.txt", exact: false }).click();
	await expect(region.locator(".cm-content")).toContainText("hello", { timeout: timeoutMs });
	await window.getByRole("button", { name: "calc.cjs", exact: false }).click();
	await expect(region.locator(".cm-content")).toContainText("unsaved draft");
	await region.getByRole("button", { name: "重新加载文件", exact: true }).click();
	const confirm = window.getByRole("dialog").filter({ hasText: "重新加载远端文件" });
	await confirm.getByRole("button", { name: "保留草稿", exact: true }).click();
	await expect(region.locator(".cm-content")).toContainText("unsaved draft");
	await region.getByRole("button", { name: "重新加载文件", exact: true }).click();
	await confirm.getByRole("button", { name: "丢弃草稿并重新加载", exact: true }).click();
	await expect(region.locator(".cm-content")).toContainText("value: 3", { timeout: timeoutMs });
	await replaceEditor(window, REMOTE_EDITED_CODE);
	await region.getByRole("button", { name: "保存远端文件", exact: true }).click();
	await expect(region.getByText("已保存", { exact: true })).toBeVisible({ timeout: timeoutMs });
	expect(await read()).toBe(REMOTE_EDITED_CODE);
	expect(await mode()).toBe("600");
	await window.getByRole("button", { name: "crlf.txt", exact: false }).click();
	await expect(region.locator(".cm-content")).toContainText("second", { timeout: timeoutMs });
	await region.locator(".cm-content").click();
	await window.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
	await window.keyboard.insertText("// appended");
	await window.keyboard.press("Enter");
	await region.getByRole("button", { name: "保存远端文件", exact: true }).click();
	await expect(region.getByText("已保存", { exact: true })).toBeVisible({ timeout: timeoutMs });
	expect((await runRemoteCommand(credentials, "cat -- '" + projectPath + "/crlf.txt'", 60_000)).stdout).toBe("\ufefffirst\r\nsecond\r\n// appended\r\n");
	await window.getByRole("button", { name: "calc.cjs", exact: false }).click();
	await expect(region.locator(".cm-content")).toContainText("value: 2");
	console.log("[remote-file-acceptance] saveAndReload=true externalChangePreserved=true draftSurvivesNavigation=true mode600=true bomAndCrlfPreserved=true");
}

/** 双项目同名文件用不同正文作正对照；UI切换后不得沿用另一项目的保存目标。 */
export async function verifyRemoteCodeIsolation(window: Page, credentials: RemoteAcceptanceCredentials, projectPath: string, neighborPath: string, timeoutMs: number): Promise<void> {
	await remoteProjectRow(window, neighborPath.split("/").at(-1) ?? "")
		.locator(".conversation-title")
		.first()
		.click();
	await window.getByRole("button", { name: "calc.cjs", exact: false }).click();
	const region = window.getByRole("region", { name: "远端文件编辑器" });
	await expect(region.locator(".cm-content")).toContainText("value: 101", { timeout: timeoutMs });
	await replaceEditor(window, "module.exports = { value: 102 };\n");
	await region.getByRole("button", { name: "保存远端文件", exact: true }).click();
	await expect(region.getByText("已保存", { exact: true })).toBeVisible({ timeout: timeoutMs });
	expect((await runRemoteCommand(credentials, "cat -- '" + neighborPath + "/calc.cjs'", 60_000)).stdout).toBe("module.exports = { value: 102 };\n");
	expect((await runRemoteCommand(credentials, "cat -- '" + projectPath + "/calc.cjs'", 60_000)).stdout).toBe(REMOTE_EDITED_CODE);
	await remoteProjectRow(window, projectPath.split("/").at(-1) ?? "")
		.locator(".conversation-title")
		.first()
		.click();
	await window.getByRole("button", { name: "calc.cjs", exact: false }).click();
	await expect(region.locator(".cm-content")).toContainText("value: 2", { timeout: timeoutMs });
	console.log("[remote-file-acceptance] twoProjectSameNameIsolation=true");
}

/** 产品手动断开属于明确失败路径：不自动重连/保存，草稿保留；显式重连后再重载核对。 */
export async function verifyRemoteCodeDisconnect(window: Page, credentials: RemoteAcceptanceCredentials, projectPath: string, timeoutMs: number): Promise<void> {
	const region = window.getByRole("region", { name: "远端文件编辑器" });
	await replaceEditor(window, "module.exports = { value: 5 };\n// disconnected draft\n");
	await window.getByRole("button", { name: /^设置/ }).click();
	const settings = window.locator(".settings-modal");
	await settings.getByRole("tab", { name: "连接", exact: true }).click();
	// 切项目会重建helper；连接页只保留最近一次显式操作的状态。先明确连接，再测试用户断开。
	const connect = settings.getByRole("button", { name: "连接", exact: true }).first();
	if (await connect.isVisible()) await connect.click();
	await expect(settings.getByRole("button", { name: "断开", exact: true }).first()).toBeVisible({ timeout: timeoutMs });
	await settings.getByRole("button", { name: "断开", exact: true }).first().click();
	await expect(settings.getByRole("button", { name: "连接", exact: true }).first()).toBeVisible({ timeout: timeoutMs });
	await settings.getByRole("button", { name: "关闭" }).first().click();
	await region.getByRole("button", { name: "保存远端文件", exact: true }).click();
	await expect(region.getByRole("alert")).toContainText("远端连接不可用", { timeout: timeoutMs });
	await expect(region.locator(".cm-content")).toContainText("disconnected draft");
	expect((await runRemoteCommand(credentials, "cat -- '" + projectPath + "/calc.cjs'", 60_000)).stdout).toBe(REMOTE_EDITED_CODE);
	await window.getByRole("button", { name: /^设置/ }).click();
	await settings.getByRole("tab", { name: "连接", exact: true }).click();
	await settings.getByRole("button", { name: "连接", exact: true }).first().click();
	await expect(settings.getByText("已连接").first()).toBeVisible({ timeout: timeoutMs });
	await settings.getByRole("button", { name: "关闭" }).first().click();
	await region.getByRole("button", { name: "重新加载文件", exact: true }).click();
	await window.getByRole("dialog").filter({ hasText: "重新加载远端文件" }).getByRole("button", { name: "丢弃草稿并重新加载", exact: true }).click();
	await expect(region.locator(".cm-content")).toContainText("value: 2", { timeout: timeoutMs });
	console.log("[remote-file-acceptance] disconnectRetainsDraft=true noImplicitReconnectOrWrite=true explicitReconnectAndReload=true");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 独立读JSONL核对真实bash toolCall→toolResult，不能只凭模型口头说测试通过。 */
export function assertRemoteNodeTestExecuted(jsonl: string): void {
	const entries = historyEntries(jsonl);
	const calls = new Set<string>();
	for (const entry of entries) {
		const message = entry.message;
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (!isRecord(part) || part.type !== "toolCall" || part.name !== "bash" || typeof part.id !== "string") continue;
			const command = isRecord(part.arguments) ? part.arguments.command : undefined;
			if (typeof command === "string" && /(?:^|&&|\n)\s*(?:[\w~/.\-]+\/)?node\s+[^\n]*test\.cjs/.test(command)) calls.add(part.id);
		}
	}
	const success = entries.some((entry) => {
		const message = entry.message;
		if (!isRecord(message) || message.role !== "toolResult" || typeof message.toolCallId !== "string" || !calls.has(message.toolCallId) || message.isError !== false || !Array.isArray(message.content)) return false;
		return message.content.some((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim() === "REMOTE_FILE_TEST_OK");
	});
	expect(success, "必须在远端JSONL看到实际node test.cjs调用及成功toolResult").toBe(true);
}
