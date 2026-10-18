import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Only a newly allocated run-owned directory is initialized: one committed baseline plus uncommitted work. */
export async function initializeRemoteGitDiscardFixture(credentials: RemoteAcceptanceCredentials, root: string) {
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
			"printf 'DISCARD_BASE\\n' > tracked.txt",
			"printf 'keep me\\n' > keep.txt",
			"git add -- .",
			"git commit -qm baseline",
			// The uncommitted work the user is about to throw away, and a file with nothing to lose.
			"printf 'MY UNCOMMITTED WORK\\n' > tracked.txt",
			"printf 'note to delete\\r\\nsecond line\\r\\n' > scratch.txt",
		].join("; "),
		30_000,
	);
}

/** The real panel's recoverable destructive path: confirm, cancel, discard, delete, and the bytes that came back. */
export async function verifyRemoteGitDiscard(input: { window: Page; credentials: RemoteAcceptanceCredentials; root: string; timeoutMs: number; testInfo: TestInfo }) {
	const { window, credentials, root, timeoutMs, testInfo } = input;
	const panel = window.getByTestId("remote-git-panel");
	const command = async (script: string) => (await runRemoteCommand(credentials, "set -eu; cd " + quote(root) + "; " + script, 60_000)).stdout;
	const git = (script: string) => command("git --no-optional-locks " + script);
	// Branches and tags only: the recovery refs this test creates are expected, and are checked separately.
	const refs = () => git("for-each-ref --format='%(refname) %(objectname)' refs/heads refs/tags");
	const before = { head: await git("rev-parse HEAD"), refs: await refs(), keep: await command("cat keep.txt") };
	const recoveryRefs = async () => (await git("for-each-ref --format='%(refname)' refs/pideck")).trim().split("\n").filter(Boolean);
	const openConfirm = async (name: string) => {
		const row = panel
			.getByTestId(/^remote-git-(workingTree|untracked)$/)
			.locator(".git-resource-row")
			.filter({ has: window.locator(".git-resource-name", { hasText: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }) });
		await expect(row).toBeVisible({ timeout: timeoutMs });
		await row.hover();
		await row.getByRole("button", { name: "回滚更改", exact: true }).click();
		await expect(panel.getByTestId("remote-git-discard-confirm-bar")).toBeVisible({ timeout: timeoutMs });
	};

	await test.step("信任项目并看到可回滚的行", async () => {
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
		await expect(panel.getByTestId("remote-git-untracked")).toContainText("scratch.txt", { timeout: timeoutMs });
		await expect(panel.getByRole("button", { name: /^(全部暂存|初始化|强制|amend)/ })).toHaveCount(0);
	});

	await test.step("取消确认不会动任何东西", async () => {
		await openConfirm("tracked.txt");
		await panel.getByTestId("remote-git-discard-cancel").click();
		await expect(panel.getByTestId("remote-git-discard-confirm-bar")).toHaveCount(0);
		await expect.poll(async () => command("cat tracked.txt"), { timeout: timeoutMs }).toBe("MY UNCOMMITTED WORK\n");
		expect(await recoveryRefs()).toEqual([]);
	});

	await test.step("丢弃工作区改动：先备份到恢复引用，工作区回到已提交版本", async () => {
		const refsBeforeDiscard = await recoveryRefs();
		await openConfirm("tracked.txt");
		await panel.getByTestId("remote-git-discard-confirm").click();
		await expect(panel.getByTestId("remote-git-recovery-note")).toBeVisible({ timeout: timeoutMs });
		const note = await panel.getByTestId("remote-git-recovery-note").innerText();
		const ref = /refs\/pideck\/recovery\/[A-Za-z0-9._-]+/.exec(note)?.[0];
		expect(ref, `the panel must name the recovery ref, got: ${note}`).toBeTruthy();
		// The panel's own evidence: the backup holds the bytes that were thrown away, byte for byte.
		expect(await git(`show ${ref}:tracked.txt`)).toBe("MY UNCOMMITTED WORK\n");
		await expect.poll(async () => command("cat tracked.txt"), { timeout: timeoutMs }).toBe("DISCARD_BASE\n");
		expect(await recoveryRefs()).toEqual(refsBeforeDiscard.concat(String(ref)));
		expect(await command("cat keep.txt")).toBe("keep me\n");
	});

	await test.step("删除未跟踪文件同样先备份，字节逐字可取回", async () => {
		const firstRef = (await recoveryRefs())[0];
		await openConfirm("scratch.txt");
		await panel.getByTestId("remote-git-discard-confirm").click();
		// The note from the first discard is still on screen, so wait for the second recovery ref to exist
		// natively before reading the note again: the note must name *this* action's ref, not the previous one.
		await expect.poll(async () => (await recoveryRefs()).length, { timeout: timeoutMs }).toBe(2);
		const ref = (await recoveryRefs()).find((entry) => entry !== firstRef);
		expect(ref).toBeTruthy();
		await expect.poll(async () => panel.getByTestId("remote-git-recovery-note").innerText(), { timeout: timeoutMs }).toContain(String(ref));
		expect(await git(`show ${ref}:scratch.txt`)).toBe("note to delete\r\nsecond line\r\n");
		await expect.poll(async () => (await command("test -e scratch.txt && echo present || echo absent")).trim(), { timeout: timeoutMs }).toBe("absent");
		expect((await git("status --porcelain=v1 --untracked-files=all")).includes("scratch.txt")).toBe(false);
	});

	await test.step("仓库事实：HEAD 与既有 ref 未动，只有两个恢复引用和清理干净", async () => {
		await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
		await expect(panel.getByTestId("remote-git-workingTree")).toHaveCount(0, { timeout: timeoutMs });
		expect(await git("rev-parse HEAD")).toBe(before.head);
		expect(await refs()).toBe(before.refs);
		expect((await git("status --porcelain=v1 --untracked-files=all")).trim()).toBe("");
		expect(await recoveryRefs()).toHaveLength(2);
		expect(await command("find .git -maxdepth 1 -name 'index.lock' -o -maxdepth 1 -name 'pideck-index-*' | wc -l")).toBe("0\n");
	});

	await testInfo.attach("remote-git-discard-oracles", { body: Buffer.from(JSON.stringify({ before, recovery: await recoveryRefs() }, null, 2)), contentType: "application/json" });
}
