import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** The same uncommitted work the discard fixture uses: one tracked edit and one untracked file. */
export async function initializeRemoteGitRecoveryFixture(credentials: RemoteAcceptanceCredentials, root: string) {
	await runRemoteCommand(
		credentials,
		[
			"set -eu",
			"umask 077",
			"mkdir -p " + quote(root),
			"cd " + quote(root),
			"git init -q",
			"git config user.name PiDeck-E2E",
			"git config user.email pideck-e2e@example.invalid",
			"printf 'RECOVERY_BASE\\n' > tracked.txt",
			"git add -- .",
			"git commit -qm baseline",
			"printf 'WORK I WANT BACK\\r\\nSECOND LINE\\r\\n' > tracked.txt",
		].join("; "),
		30_000,
	);
}

/** G4b: the recovery store is visible, restorable byte for byte, and only an explicit action deletes a snapshot. */
export async function verifyRemoteGitRecovery(input: { window: Page; credentials: RemoteAcceptanceCredentials; root: string; timeoutMs: number; testInfo: TestInfo }) {
	const { window, credentials, root, timeoutMs, testInfo } = input;
	const panel = window.getByTestId("remote-git-panel");
	const command = async (script: string) => (await runRemoteCommand(credentials, "set -eu; cd " + quote(root) + "; " + script, 60_000)).stdout;
	const git = (script: string) => command("git --no-optional-locks " + script);
	const refNames = async () => (await git("for-each-ref --format='%(refname)' refs/pideck")).trim().split("\n").filter(Boolean);
	const openRecovery = async () => {
		const header = panel.getByRole("button", { name: "恢复", exact: true });
		if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
	};
	const discardButton = async (name: string) => {
		const row = panel
			.getByTestId(/^remote-git-(workingTree|untracked)$/)
			.locator(".git-resource-row")
			.filter({ has: window.locator(".git-resource-name", { hasText: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }) });
		await expect(row).toBeVisible({ timeout: timeoutMs });
		await row.hover();
		await row
			.getByRole("button", { name: "回滚更改", exact: true })
			.click({ timeout: 10_000 })
			.catch(async (error: unknown) => {
				if ((await panel.getByTestId("remote-git-discard-confirm-bar").count()) === 0) throw error;
			});
		await expect(panel.getByTestId("remote-git-discard-confirm-bar")).toBeVisible({ timeout: timeoutMs });
		await panel.getByTestId("remote-git-discard-confirm").click();
	};
	const recoveryRow = (path: string) => panel.getByTestId("remote-git-recovery-row").filter({ hasText: path });
	/** The panel's own words when an outcome does not appear: a stable code beats a bare timeout. */
	const expectOutcome = async (text: string) => {
		await panel
			.getByTestId("remote-git-recovery-outcome")
			.filter({ hasText: text })
			.waitFor({ timeout: timeoutMs })
			.catch(async (error) => {
				const alerts = await panel.getByRole("alert").allInnerTexts();
				throw new Error(`no "${text}" outcome; panel alerts: ${JSON.stringify(alerts)} (${String(error).split("\n")[0]})`);
			});
	};

	await test.step("信任项目并制造一个快照", async () => {
		await remoteProjectRow(window, root.split("/").pop() ?? "")
			.locator(".conversation-title")
			.first()
			.click();
		await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
		await window.getByTestId("drawer-rail-git").click();
		await expect(panel).toBeVisible();
		await expect(panel.getByRole("alert")).toContainText("尚未明确授权", { timeout: timeoutMs });
		await panel.getByRole("button", { name: "信任此项目及其 .pi 资源", exact: true }).click();
		await expect(panel.getByTestId("remote-git-workingTree")).toContainText("tracked.txt", { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-recovery-row")).toHaveCount(0, { timeout: timeoutMs });
		await discardButton("tracked.txt");
		await expect(panel.getByTestId("remote-git-recovery-note")).toBeVisible({ timeout: timeoutMs });
		expect(await command("cat tracked.txt")).toBe("RECOVERY_BASE\n");
		expect(await refNames()).toHaveLength(1);
	});

	await test.step("展开恢复区：快照就在那里，大小与路径都看得见", async () => {
		// A refresh drops the facts of the previous generation, so the listing is loaded by expanding the section.
		await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
		await expect(panel.getByTestId("remote-git-workingTree")).toHaveCount(0, { timeout: timeoutMs });
		await openRecovery();
		await expect(recoveryRow("tracked.txt")).toBeVisible({ timeout: timeoutMs });
		await expect(recoveryRow("tracked.txt")).toContainText("KiB");
		await expect(panel.getByTestId("remote-git-recovery-row")).toHaveCount(1);
	});

	await test.step("一键还原：字节逐字回来，快照仍然留着", async () => {
		await recoveryRow("tracked.txt").getByTestId("remote-git-recovery-restore").click();
		await expectOutcome("已还原");
		await expect.poll(async () => command("cat tracked.txt"), { timeout: timeoutMs }).toBe("WORK I WANT BACK\r\nSECOND LINE\r\n");
		expect((await git("status --porcelain=v1")).trim()).toBe("M tracked.txt");
		expect(await refNames()).toHaveLength(1);
	});

	await test.step("删除快照需要确认；取消不动，确认后原生 ref 消失", async () => {
		await recoveryRow("tracked.txt").getByTestId("remote-git-recovery-drop").click();
		await expect(panel.getByTestId("remote-git-recovery-drop-confirm-bar")).toBeVisible({ timeout: timeoutMs });
		await panel.getByTestId("remote-git-recovery-drop-cancel").click();
		await expect(panel.getByTestId("remote-git-recovery-drop-confirm-bar")).toHaveCount(0);
		expect(await refNames()).toHaveLength(1);
		await recoveryRow("tracked.txt").getByTestId("remote-git-recovery-drop").click();
		await panel.getByTestId("remote-git-recovery-drop-confirm").click();
		// The repository is the witness: if the ref is gone the drop happened and only the panel's message is missing.
		const dropped = await expect
			.poll(refNames, { timeout: 15000 })
			.toEqual([])
			.then(() => true)
			.catch(() => false);
		if (!dropped) {
			const alerts = await panel.getByRole("alert").allInnerTexts();
			throw new Error(`the drop never reached the repository; refs=${JSON.stringify(await refNames())} alerts=${JSON.stringify(alerts)}`);
		}
		await expectOutcome("已删除");
		await expect.poll(refNames, { timeout: timeoutMs }).toEqual([]);
		await expect(panel.getByTestId("remote-git-recovery-row")).toHaveCount(0, { timeout: timeoutMs });
		// The restored bytes are the user's again, and the dropped snapshot was not the only copy of anything committed.
		expect(await command("cat tracked.txt")).toBe("WORK I WANT BACK\r\nSECOND LINE\r\n");
		expect(await command("find .git -maxdepth 1 -name 'index.lock' -o -maxdepth 1 -name 'pideck-index-*' | wc -l")).toBe("0\n");
	});

	await testInfo.attach("remote-git-recovery-oracles", { body: Buffer.from(JSON.stringify({ head: await git("rev-parse HEAD"), refs: await refNames() }, null, 2)), contentType: "application/json" });
}
