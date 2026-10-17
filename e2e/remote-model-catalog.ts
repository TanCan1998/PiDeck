import { expect, type Page } from "@playwright/test";
import { type RemoteAcceptanceCredentials } from "./remote-fixtures";

/**
 * Authored-only e2e step for the remote provider model catalog v1 (Phase 5 row 819).
 *
 * Precondition: the surrounding product-road acceptance test already has a connected host and a LIVE remote
 * agent (the model probe deliberately requires a running remote pi). The step drives the real UI:
 * Settings → 配置管理 → 模型 → ssh target → 拉取远端模型目录（测试连接）and expects a non-empty provider list
 * that came from the host runtime. No fake provider is injected and no local fallback is acceptable here.
 *
 * Not executed by this lane (no real-machine e2e).
 */
export async function verifyRemoteModelCatalog(input: { window: Page; credentials: RemoteAcceptanceCredentials; timeoutMs: number }): Promise<void> {
	const { window, credentials, timeoutMs } = input;
	await window.getByRole("button", { name: /^设置/ }).click();
	const settings = window.locator(".settings-modal");
	await expect(settings).toBeVisible();
	await settings.getByRole("tab", { name: "配置管理", exact: true }).click();
	const layout = settings.locator(".config-layout");
	await expect(layout).toBeVisible();
	await layout.getByRole("tab", { name: "模型", exact: true }).click();

	// Select the verified ssh host in the existing config target selector.
	const selector = layout.getByTestId("config-target-selector");
	await expect(selector).toBeVisible({ timeout: timeoutMs });
	await selector.click();
	// The option accessible name is "<host label> <ssh host>"; the label is user-chosen, so anchor on the address.
	const hostOption = window.getByRole("option").filter({ hasText: new RegExp(credentials.host.replace(/\./g, "\\.")) });
	await expect(hostOption.first(), "目标选择器必须列出已连接的主机").toBeVisible({ timeout: 30_000 });
	await hostOption.first().click();

	const catalog = layout.getByTestId("remote-model-catalog");
	await expect(catalog).toBeVisible({ timeout: timeoutMs });
	// The models panel must offer the real catalog action, not the old disabled provider-test/fetch entries.
	await expect(catalog.getByTestId("remote-model-probe")).toContainText("拉取远端模型目录");
	await catalog.getByTestId("remote-model-probe").click();

	// One host request: must end in a non-empty provider-grouped list (the product-road test's live agent has a
	// working model). A stable-code error would mean the probe did not reach the runtime.
	await expect(catalog.getByTestId("remote-model-providers")).toBeVisible({ timeout: timeoutMs });
	await expect(catalog.getByTestId("remote-model-providers").getByTestId("remote-model-provider").first()).toBeVisible();
	const providerCount = await catalog.getByTestId("remote-model-providers").getByTestId("remote-model-provider").count();
	expect(providerCount, "远端模型目录必须至少包含一个 provider").toBeGreaterThan(0);
	const entryCount = await catalog.getByTestId("remote-model-providers").getByTestId("remote-model-entry").count();
	expect(entryCount, "远端模型目录必须至少包含一个模型条目").toBeGreaterThan(0);
	await expect(catalog.getByTestId("remote-model-probe-error")).toHaveCount(0);
	await expect(catalog.getByTestId("remote-model-probe-empty")).toHaveCount(0);

	await settings.getByRole("button", { name: "关闭" }).first().click();
	await expect(settings).toHaveCount(0);
}
