import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Run-owned project root that genuinely is not a repository: the fixture only creates files, never Git metadata.
 * Creating it after the shared project directory keeps the normal enrollment path (canonical root, trust) identical.
 */
export async function initializeRemoteGitInitFixture(credentials: RemoteAcceptanceCredentials, root: string): Promise<void> {
	await runRemoteCommand(
		credentials,
		["set -eu", "umask 077", "test ! -e " + quote(root + "/.git"), "printf 'INIT_HELLO\\n' > " + quote(root + "/hello.txt"), "printf 'INIT_KEEP\\n' > " + quote(root + "/keep.txt"), "mkdir -p " + quote(root + "/sub"), "printf 'INIT_NESTED\\n' > " + quote(root + "/sub/nested.txt")].join("; "),
		30_000,
	);
}

/**
 * G5c real UI path: a confirmed non-repository offers one explicit, inline-confirmed init action; the write is
 * proven by native Git afterwards (the exact remote .git of the project root, HEAD equals the reported branch,
 * existing files untouched and now untracked), and the init entry disappears once the facts are a repository.
 * Cancel is part of the contract: it must leave no .git. Precondition refusals (existing repository, gitfile,
 * symlink, parent repository) cannot be constructed through this product path and are covered deterministically
 * by tests/remoteGitInit.test.mjs against the deployed helper; this spec does not fake them.
 */
export async function verifyRemoteGitInit(input: { window: Page; credentials: RemoteAcceptanceCredentials; root: string; timeoutMs: number; testInfo: TestInfo }): Promise<void> {
	const { window, credentials, root, timeoutMs, testInfo } = input;
	const panel = window.getByTestId("remote-git-panel");
	const command = async (script: string) => (await runRemoteCommand(credentials, "cd " + quote(root) + "; " + script, 60_000)).stdout;
	const commandTrimmed = async (script: string) => (await command(script)).trim();
	const filesSha = async () => commandTrimmed("sha256sum hello.txt keep.txt sub/nested.txt");
	const noGit = async () => commandTrimmed("if test -e .git; then echo GIT_PRESENT; else echo NO_GIT; fi");
	let branch = "";
	const before = await filesSha();
	expect(await noGit(), "the project directory must start without a .git entry").toBe("NO_GIT");

	await test.step("非仓库根：面板说明不会自动初始化，并给出显式入口", async () => {
		await remoteProjectRow(window, root.split("/").pop() ?? "")
			.locator(".conversation-title")
			.first()
			.click();
		await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
		await window.getByTestId("drawer-rail-git").click();
		await expect(panel).toBeVisible();
		const trust = panel.getByRole("button", { name: "信任此项目及其 .pi 资源", exact: true });
		// The trust gate can render after the panel's first read: wait for the gate or the settled state before
		// sampling it, otherwise a one-shot isVisible() silently skips the click and the panel stays gated.
		await expect(trust.or(panel.getByTestId("remote-git-not-repository"))).toBeVisible({ timeout: timeoutMs });
		if (await trust.isVisible().catch(() => false)) await trust.click();
		const notRepository = panel.getByTestId("remote-git-not-repository");
		await expect(notRepository).toContainText("不是普通 Git 仓库", { timeout: timeoutMs });
		// The copy stays honest: no automatic initialization and no parent discovery, now with the explicit action.
		await expect(notRepository).toContainText("不会自动初始化");
		await expect(notRepository).toContainText("不会搜索父目录");
		await expect(panel.getByTestId("remote-git-init")).toBeVisible({ timeout: timeoutMs });
		// Opening the panel is a read: it must not have created anything.
		expect(await noGit()).toBe("NO_GIT");
	});

	await test.step("取消初始化：不创建 .git，入口仍在", async () => {
		await panel.getByTestId("remote-git-init").click();
		await expect(panel.getByTestId("remote-git-init-confirm")).toBeVisible();
		// The explain-before-commit copy lives in the confirm row, not in the outcome line.
		await expect(panel.getByText("确认在项目根创建 .git")).toBeVisible();
		await panel.getByTestId("remote-git-init-cancel").click();
		await expect(panel.getByTestId("remote-git-init-confirm")).toHaveCount(0);
		await expect(panel.getByTestId("remote-git-init")).toBeVisible();
		expect(await noGit(), "cancel must not create the repository").toBe("NO_GIT");
	});

	await test.step("确认初始化：原生 .git 出现且就是项目根自己的仓库", async () => {
		await panel.getByTestId("remote-git-init").click();
		await panel.getByTestId("remote-git-init-confirm").click();
		// The success report is a fresh snapshot: the branch row replaces the init error.
		await expect(panel.getByTestId("remote-git-branch")).toBeVisible({ timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-untracked")).toContainText("hello.txt", { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-init-outcome")).toContainText("已初始化仓库", { timeout: timeoutMs });
		// Native oracle: a real directory at the root, and the repository is exactly that root - not a parent.
		expect(await commandTrimmed("if test -d .git && test ! -L .git; then echo GIT_DIR; else echo NOT_GIT_DIR; fi")).toBe("GIT_DIR");
		expect(await commandTrimmed("GIT_OPTIONAL_LOCKS=0 git rev-parse --git-dir")).toBe(".git");
		branch = await commandTrimmed("GIT_OPTIONAL_LOCKS=0 git symbolic-ref --short HEAD");
		expect(branch.length, "the created repository must report a branch").toBeGreaterThan(0);
		expect(await commandTrimmed("GIT_OPTIONAL_LOCKS=0 git symbolic-ref HEAD")).toBe("refs/heads/" + branch);
		await expect(panel.getByTestId("remote-git-branch")).toContainText(branch);
		expect(await commandTrimmed("if test -e .git/index.lock; then echo LOCKED; else echo NO_LOCK; fi")).toBe("NO_LOCK");
		// Existing files were not rewritten; they are the untracked changes the panel now lists.
		expect(await filesSha(), "init must not touch the user's existing files").toBe(before);
		const status = (await commandTrimmed("GIT_OPTIONAL_LOCKS=0 git status --porcelain=v1 --untracked-files=all")).split("\n").filter(Boolean).sort();
		expect(status).toEqual(["?? hello.txt", "?? keep.txt", "?? sub/nested.txt"]);
		// The tree renders the display name; the full project-relative path is the row's accessible name.
		for (const name of ["hello.txt", "keep.txt", "nested.txt"]) await expect(panel.getByTestId("remote-git-untracked")).toContainText(name);
		await expect(panel.getByTestId("remote-git-untracked").getByRole("button", { name: "查看 sub/nested.txt 的 Git 差异" })).toBeVisible();
		// The explicit init entry disappears once the fact is a repository.
		await expect(panel.getByTestId("remote-git-init")).toHaveCount(0);
		await expect(panel.getByTestId("remote-git-not-repository")).toHaveCount(0);
	});

	await test.step("重新打开抽屉不复活初始化入口", async () => {
		await window.getByRole("button", { name: "关闭右侧边栏", exact: true }).click();
		await expect(panel).toHaveCount(0);
		await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
		// The header toggle intentionally opens Files; navigate back to Git explicitly.
		await window.getByTestId("drawer-rail-git").click();
		await expect(panel).toBeVisible({ timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-branch")).toContainText(branch, { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-init")).toHaveCount(0);
		await expect(panel.getByTestId("remote-git-not-repository")).toHaveCount(0);
		expect(await filesSha()).toBe(before);
	});

	await testInfo.attach("remote-git-init-oracles", {
		body: Buffer.from(JSON.stringify({ branch, before, after: await filesSha(), gitDir: ".git" }, null, 2)),
		contentType: "application/json",
	});
}
