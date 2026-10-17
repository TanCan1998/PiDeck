import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * G5d fixture: a project root that is itself a repository, a nested repository under packages/nested, and a working
 * change in each. Every step is a normal native Git command, so the panel's answers can be compared with the same
 * Git; the nested repository gets its own branch name and a snapshot ref, which is the only thing that proves the
 * recovery RESTORE/DROP buttons are disabled in a nested scope while the listing itself is still a read.
 */
export async function initializeRemoteGitReposFixture(credentials: RemoteAcceptanceCredentials, root: string): Promise<void> {
	const script = [
		"set -eu",
		"umask 077",
		"cd " + quote(root),
		"test ! -e .git",
		"printf 'ROOT_TRACKED\\n' > tracked.txt",
		"git init -q",
		"git config user.name Fixture",
		"git config user.email fixture@example.invalid",
		"git add -A",
		"git commit -qm 'root baseline'",
		"mkdir -p packages/nested",
		"git -C packages/nested init -q",
		"git -C packages/nested config user.name Fixture",
		"git -C packages/nested config user.email fixture@example.invalid",
		"printf 'NESTED_BASE\\n' > packages/nested/nested.txt",
		"git -C packages/nested add -A",
		"git -C packages/nested commit -qm 'nested baseline'",
		// A distinct branch proves the scope switch really changes the repository the panel answers for.
		"git -C packages/nested checkout -q -b nested-work",
		// A snapshot ref in the nested repository: recoveryList must list it, restore/drop must stay disabled.
		"printf 'RECOVER\\n' > packages/nested/recovery-note.txt",
		"blob=$(git -C packages/nested hash-object -w --no-filters -- recovery-note.txt)",
		"tree=$(printf '100644 blob %s\\trecovery-note.txt\\n' $blob | git -C packages/nested mktree)",
		"commit=$(git -C packages/nested -c user.name=Fixture -c user.email=fixture@example.invalid commit-tree $tree -m 'discard: recovery-note.txt')",
		"git -C packages/nested update-ref refs/pideck/recovery/20261017120000-abcd1234 $commit",
		"rm packages/nested/recovery-note.txt",
		// Untracked changes on both sides: each scope must show its own file and never the other repository's.
		"printf 'ROOT_WORKING\\n' > root-change.txt",
		"printf 'NESTED_WORKING\\n' > packages/nested/nested-change.txt",
	].join("; ");
	await runRemoteCommand(credentials, script, 60_000);
}

/**
 * G5d real UI path: the selector lists both discovered repositories; choosing the nested one switches branch, status
 * and recovery facts to that repository (matched against native Git) while every write/branch/sync/recovery action and
 * the init entry stay disabled with the read-only note; choosing the root again re-enables them. Discovery and all
 * reads are witnessed byte-for-byte, because a scope switch must never write to either repository.
 */
export async function verifyRemoteGitRepos(input: { window: Page; credentials: RemoteAcceptanceCredentials; root: string; timeoutMs: number; testInfo: TestInfo }): Promise<void> {
	const { window, credentials, root, timeoutMs, testInfo } = input;
	const panel = window.getByTestId("remote-git-panel");
	const command = async (script: string) => (await runRemoteCommand(credentials, "set -eu; cd " + quote(root) + "; " + script, 60_000)).stdout;
	const commandTrimmed = async (script: string) => (await command(script)).trim();
	const git = (repo: string, script: string) => commandTrimmed("git -C " + quote(repo) + " --no-optional-locks " + script);
	const repoWitness = async (repo: string) => ({
		index: await commandTrimmed("if test -e " + quote(repo + "/.git/index") + "; then sha256sum " + quote(repo + "/.git/index") + " | cut -d' ' -f1; stat -c '%i:%s:%Y:%Z' " + quote(repo + "/.git/index") + "; else echo absent; fi"),
		head: await git(repo, "rev-parse HEAD"),
		branch: await git(repo, "symbolic-ref --short HEAD"),
		refs: await git(repo, "for-each-ref --format='%(refname) %(objectname)'"),
		worktree: await commandTrimmed("find " + quote(repo) + " -path " + quote(repo + "/.git") + " -prune -o -type f -print0 | sort -z | xargs -0 sha256sum"),
	});
	// Native oracles first, before the witness: a native status may refresh the index stat cache by design.
	const rootBranch = await git(".", "symbolic-ref --short HEAD");
	const nestedBranch = await git("packages/nested", "symbolic-ref --short HEAD");
	expect(rootBranch).not.toBe(nestedBranch);
	const rootStatus = (await git(".", "status --porcelain=v1 --untracked-files=all")).split("\n").filter(Boolean);
	const nestedStatus = (await git("packages/nested", "status --porcelain=v1 --untracked-files=all")).split("\n").filter(Boolean);
	expect(rootStatus.some((line) => line.includes("root-change.txt"))).toBe(true);
	expect(nestedStatus.some((line) => line.includes("nested-change.txt"))).toBe(true);
	const nestedRecoveryRef = (await git("packages/nested", "for-each-ref --format='%(refname)' refs/pideck/recovery")).split("\n").filter(Boolean);
	expect(nestedRecoveryRef).toEqual(["refs/pideck/recovery/20261017120000-abcd1234"]);
	const before = { root: await repoWitness("."), nested: await repoWitness("packages/nested") };

	await test.step("面板加载仓库列表：选择器同时列出项目根与嵌套仓库", async () => {
		await remoteProjectRow(window, root.split("/").pop() ?? "")
			.locator(".project-draggable")
			.click();
		await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
		await window.getByTestId("drawer-rail-git").click();
		await expect(panel).toBeVisible();
		const trust = panel.getByRole("button", { name: "信任此项目及其 .pi 资源", exact: true });
		if (await trust.isVisible().catch(() => false)) await trust.click();
		await expect(panel.getByTestId("remote-git-branch")).toContainText(rootBranch, { timeout: timeoutMs });
		const selector = panel.getByTestId("remote-git-repo-select");
		await expect(selector).toBeVisible({ timeout: timeoutMs });
		await selector.click();
		await expect(window.getByRole("option", { name: "项目根" })).toBeVisible();
		await expect(window.getByRole("option", { name: "packages/nested" })).toBeVisible();
		// Choosing the root keeps the panel on the root scope (and closes the list).
		await window.getByRole("option", { name: "项目根" }).click();
		await expect(panel.getByTestId("remote-git-repo-readonly-note")).toHaveCount(0);
	});

	await test.step("根 scope：显示根仓库的分支与自己的未跟踪改动，写控件可用", async () => {
		await expect(panel.getByTestId("remote-git-branch")).toContainText(rootBranch);
		await expect(panel.getByTestId("remote-git-untracked")).toContainText("root-change.txt", { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-untracked")).not.toContainText("nested-change.txt");
		await expect(panel.getByTestId("remote-git-commit-message")).toBeEnabled();
	});

	await test.step("切到嵌套 scope：分支/状态/恢复列表来自嵌套仓库，写控件全部禁用并显示只读说明", async () => {
		await panel.getByTestId("remote-git-repo-select").click();
		await window.getByRole("option", { name: "packages/nested" }).click();
		await expect(panel.getByTestId("remote-git-repo-readonly-note")).toBeVisible({ timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-branch")).toContainText(nestedBranch, { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-untracked")).toContainText("nested-change.txt", { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-untracked")).not.toContainText("root-change.txt");
		// Writes, branch actions and sync are root-only in this batch.
		await expect(panel.getByTestId("remote-git-commit-message")).toBeDisabled();
		await expect(panel.getByTestId("remote-git-sync-fetch")).toBeDisabled();
		await expect(panel.getByTestId("remote-git-sync-push")).toBeDisabled();
		await expect(panel.getByTestId("remote-git-sync-pull")).toBeDisabled();
		await panel.getByRole("button", { name: "引用", exact: true }).click();
		await expect(panel.getByTestId("remote-git-ref-row").first()).toBeVisible({ timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-branch-name")).toBeDisabled();
		await expect(panel.getByTestId("remote-git-create-branch")).toBeDisabled();
		for (const button of await panel.getByTestId("remote-git-switch-branch").all()) await expect(button).toBeDisabled();
		// Recovery LIST stays a read (the planted snapshot is listed), restore/drop are writes and stay disabled.
		await panel.getByRole("button", { name: "恢复", exact: true }).click();
		await expect(panel.getByTestId("remote-git-recovery-row").filter({ hasText: "recovery-note.txt" })).toBeVisible({ timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-recovery-restore")).toBeDisabled();
		await expect(panel.getByTestId("remote-git-recovery-drop")).toBeDisabled();
		// Init is root-only: a nested scope never offers it.
		await expect(panel.getByTestId("remote-git-init")).toHaveCount(0);
	});

	await test.step("切回根 scope：只读说明消失，根仓库状态与写控件恢复", async () => {
		await panel.getByTestId("remote-git-repo-select").click();
		await window.getByRole("option", { name: "项目根" }).click();
		await expect(panel.getByTestId("remote-git-repo-readonly-note")).toHaveCount(0);
		await expect(panel.getByTestId("remote-git-branch")).toContainText(rootBranch, { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-untracked")).toContainText("root-change.txt", { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-commit-message")).toBeEnabled();
	});

	await test.step("读取与 scope 切换全程零写入：两个仓库的 index/HEAD/refs/工作区见证不变", async () => {
		const after = { root: await repoWitness("."), nested: await repoWitness("packages/nested") };
		expect(after).toEqual(before);
		expect(await git("packages/nested", "for-each-ref --format='%(refname)' refs/pideck/recovery")).toBe(nestedRecoveryRef.join("\n"));
	});

	await testInfo.attach("remote-git-repos-oracles", {
		body: Buffer.from(JSON.stringify({ rootBranch, nestedBranch, rootStatus, nestedStatus, nestedRecoveryRef, before }, null, 2)),
		contentType: "application/json",
	});
}
