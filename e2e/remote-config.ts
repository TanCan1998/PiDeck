import { expect, type Page } from "@playwright/test";
import { runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

/**
 * Batch B authored e2e: remote config target selector → sanitized read (version + secret statuses) → one
 * non-secret merge patch → disabled auth page copy.
 *
 * Safety on a real acceptance host: the remote models.json (or its absence) is backed up before the test and
 * restored byte-for-byte in finally. The patch only adds a unique top-level marker key; it never edits or
 * removes an existing user field. Auth-free, env-gated exactly like the surrounding acceptance spec (this
 * helper is only called from a test whose credentials are present).
 *
 * Authored-only: this lane does not run real-host e2e. The UI contract (testids/phase attributes) it relies on
 * is pinned by tests/remoteConfigRendererWiring.test.mjs.
 */
export async function verifyRemoteConfig(input: { window: Page; credentials: RemoteAcceptanceCredentials; runId: string; timeoutMs: number }): Promise<void> {
	const { window, credentials, timeoutMs } = input;
	const marker = "pideckE2eMarker" + input.runId.replace(/[^a-zA-Z0-9]/g, "");
	const backupFile = "$HOME/.pideck/e2e-config-backup-" + input.runId.replace(/[^a-zA-Z0-9]/g, "") + ".b64";
	const shaCommand = "sha256sum \"$HOME/.pi/agent/models.json\" 2>/dev/null | cut -d' ' -f1";
	const backupCommand = 'set -e; mkdir -p "$HOME/.pideck"; d="$HOME/.pi/agent"; ' + 'if [ -f "$d/models.json" ]; then base64 < "$d/models.json" > "' + backupFile + '"; echo PRESENT; else rm -f "' + backupFile + '"; echo MISSING; fi';

	const original = await runRemoteCommand(credentials, backupCommand + "; " + shaCommand, timeoutMs);
	const wasPresent = original.stdout.trim().split("\n")[0] === "PRESENT";
	const originalSha = original.stdout.trim().split("\n")[1] ?? "";

	const restoreCommand = wasPresent
		? 'set -e; d="$HOME/.pi/agent"; base64 -d < "' + backupFile + '" > "$d/models.json.tmp-restore"; mv "$d/models.json.tmp-restore" "$d/models.json"; rm -f "' + backupFile + '"; ' + shaCommand
		: 'rm -f "$HOME/.pi/agent/models.json" "' + backupFile + '"; test ! -e "$HOME/.pi/agent/models.json" && echo REMOVED';
	try {
		// Open Settings → 配置管理 → Pi 管理 → 模型. Host label is the ssh-config candidate label (user@host).
		await window.getByRole("button", { name: /^设置/ }).click();
		const settings = window.locator(".settings-modal");
		await expect(settings).toBeVisible();
		await settings.getByRole("tab", { name: "配置管理", exact: true }).click();
		const layout = settings.locator(".config-layout");
		await expect(layout).toBeVisible();
		await layout.getByRole("tab", { name: "模型", exact: true }).click();

		// Target selector: local is the default; pick the verified ssh host added by the acceptance setup.
		const selector = layout.getByTestId("config-target-selector");
		await expect(selector).toBeVisible({ timeout: timeoutMs });
		await selector.click();
		// The list item accessible name is "<host label> <ssh host>"; the label is user-chosen, so anchor on the address.
		const hostOption = window.getByRole("option").filter({ hasText: new RegExp(credentials.host.replace(/\./g, "\\.")) });
		await expect(hostOption.first(), "目标选择器必须列出已连接的主机").toBeVisible({ timeout: 30_000 });
		await hostOption.first().click();

		const panel = layout.getByTestId("remote-config-panel");
		await expect(panel).toHaveAttribute("data-file", "models", { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-config-version")).toBeVisible({ timeout: timeoutMs });
		const version = panel.getByTestId("remote-config-version");
		const versionBefore = await version.getAttribute("title");
		expect(versionBefore, "远端快照必须带完整 version（title 属性）").toMatch(/^[0-9a-f]{64}$/);
		expect(await panel.getByTestId("remote-config-sha256").getAttribute("title")).toBe(versionBefore);
		// Secret positions show status only; no plaintext value is rendered anywhere in the panel.
		for (const badge of await panel.getByTestId("remote-config-secret-badge").all()) {
			expect(["configured", "missing"]).toContain(await badge.getAttribute("data-status"));
		}
		// Model catalog action is real now; the per-provider synthetic probe / usage query stay visibly deferred.
		const catalog = panel.getByTestId("remote-model-catalog");
		await expect(catalog).toBeVisible({ timeout: timeoutMs });
		await expect(catalog.getByTestId("remote-model-probe")).toBeVisible();
		await expect(catalog.getByTestId("remote-model-deferred")).toBeVisible();

		// One explicit non-secret merge patch through the UI editor (only adds a unique marker key).
		await panel.getByTestId("remote-config-patch").locator(".cm-content").click();
		await window.keyboard.insertText(JSON.stringify({ [marker]: input.runId }));
		await expect(panel.getByTestId("remote-config-save")).toBeEnabled();
		await panel.getByTestId("remote-config-save").click();
		await expect(panel).toHaveAttribute("data-phase", "ready", { timeout: timeoutMs });
		await expect.poll(async () => await version.getAttribute("title"), { timeout: timeoutMs }).not.toBe(versionBefore);

		// First-party evidence on disk: the marker is really in the remote file.
		const check = await runRemoteCommand(credentials, "grep -F " + marker + ' "$HOME/.pi/agent/models.json" >/dev/null && echo MARKER_ON_REMOTE', 60_000);
		expect(check.stdout.trim()).toContain("MARKER_ON_REMOTE");

		// Disabled page copy: 认证 has no remote editor and reports the stable unsupported code.
		await layout.getByRole("tab", { name: "认证", exact: true }).click();
		await expect(layout.getByTestId("remote-config-unsupported-auth")).toBeVisible({ timeout: 30_000 });
		await expect(layout.getByTestId("remote-config-stable-code").first()).toHaveText("REMOTE_CONFIG_UNSUPPORTED");
	} finally {
		const restored = await runRemoteCommand(credentials, restoreCommand, timeoutMs);
		const restoredText = restored.stdout.trim();
		if (wasPresent) {
			expect(restoredText.split("\n")[0], "finally 必须把远端 models.json 还原成测试前的字节").toBe(originalSha);
		} else {
			expect(restoredText).toBe("REMOVED");
		}
		await window
			.locator(".settings-modal")
			.getByRole("button", { name: "关闭" })
			.click()
			.catch(() => undefined);
	}
}
