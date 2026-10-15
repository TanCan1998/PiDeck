import { expect, type Page, type TestInfo } from "@playwright/test";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Only a newly allocated run-owned directory is initialized; no user/global Git config is changed. */
export async function initializeRemoteUnbornGitFixture(credentials: RemoteAcceptanceCredentials, root: string) {
	await runRemoteCommand(credentials, "set -eu; umask 077; mkdir -p " + quote(root) + "; cd " + quote(root) + "; git init -q; printf 'UNBORN_NEW\\n' > new.txt; printf 'KEEP_STAGED\\n' > keep.txt; git add -- keep.txt", 20_000);
}

/** Real UI writes checked against independent native Git/index and untouched worktree facts. */
export async function verifyRemoteGitIndex(input: { window: Page; credentials: RemoteAcceptanceCredentials; root: string; unborn: string; timeoutMs: number; testInfo: TestInfo }) {
	const { window, credentials, root, unborn, timeoutMs, testInfo } = input;
	const panel = window.getByTestId("remote-git-panel");
	const command = async (path: string, script: string) => (await runRemoteCommand(credentials, "set -eu; cd " + quote(path) + "; " + script, 20_000)).stdout;
	const worktree = (path: string) => command(path, "find . -path './.git' -prune -o -type f -exec sha256sum {} + | sort; find . -path './.git' -prune -o -type f -printf '%m %s %i %T@ %C@ %p\\n' | sort");
	const head = await command(root, "git --no-optional-locks rev-parse HEAD");
	const filesBefore = await worktree(root),
		unbornBefore = await worktree(unborn);
	const unrelatedBefore = await command(root, "git --no-optional-locks ls-files --stage -- two.txt renamed.txt deleted.txt");
	const witnesses: Record<string, string> = { filesBefore, unbornBefore, unrelatedBefore, head };
	const row = (group: string, name: string) =>
		panel
			.getByTestId("remote-git-" + group)
			.locator(".git-resource-row")
			.filter({ has: window.locator(".git-resource-name", { hasText: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$") }) });
	const action = async (group: string, name: string, label: "暂存" | "取消暂存") => {
		await expect(row(group, name)).toBeVisible({ timeout: timeoutMs });
		await row(group, name).hover();
		await row(group, name).getByRole("button", { name: label, exact: true }).click();
	};
	const refresh = async (path: string) => {
		await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
		await expect(row("workingTree", path)).toBeVisible({ timeout: timeoutMs });
	};
	const selectAndAuthorize = async (path: string) => {
		await remoteProjectRow(window, path.split("/").pop() ?? "")
			.locator(".project-draggable")
			.click();
		await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
		await window.getByTestId("drawer-rail-git").click();
		await expect(panel.getByRole("alert")).toContainText("尚未明确授权", { timeout: timeoutMs });
		await panel.getByRole("button", { name: "信任此项目及其 .pi 资源", exact: true }).click();
	};
	await selectAndAuthorize(root);
	await expect(row("workingTree", "tracked.txt")).toBeVisible({ timeout: timeoutMs });
	await expect(panel.getByRole("button", { name: /^(丢弃|提交|推送|拉取|全部暂存|初始化)/ })).toHaveCount(0);
	await action("workingTree", "tracked.txt", "暂存");
	await expect(panel.getByTestId("remote-git-workingTree")).toHaveCount(0, { timeout: timeoutMs });
	witnesses.staged = await command(root, "git --no-optional-locks show :tracked.txt");
	expect(witnesses.staged).toBe("ONE_WORK\n");
	await row("index", "tracked.txt")
		.getByRole("button", { name: /Git 差异/ })
		.click();
	await expect(panel.getByTestId("remote-git-diff")).toBeVisible({ timeout: timeoutMs });
	const diffText = () =>
		panel.getByTestId("remote-git-diff").evaluate((element) => {
			const text = (node: Node): string =>
				Array.from(node.childNodes)
					.map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? "") : text(child) + (child instanceof Element && child.shadowRoot ? text(child.shadowRoot) : "")))
					.join(" ");
			return text(element);
		});
	await expect.poll(diffText, { timeout: timeoutMs }).toContain("ONE_BASE");
	await expect.poll(diffText, { timeout: timeoutMs }).toContain("ONE_WORK");
	await panel.getByRole("button", { name: "返回远端变更列表", exact: true }).click();
	expect(await command(root, "git --no-optional-locks ls-files --stage -- two.txt renamed.txt deleted.txt")).toBe(unrelatedBefore);
	await action("index", "tracked.txt", "取消暂存");
	await expect(row("workingTree", "tracked.txt")).toBeVisible({ timeout: timeoutMs });
	expect(await command(root, "git --no-optional-locks show :tracked.txt")).toBe("ONE_BASE\n");
	expect(await command(root, "git --no-optional-locks ls-files --stage -- two.txt renamed.txt deleted.txt")).toBe(unrelatedBefore);

	await action("untracked", "untracked.txt", "暂存");
	await expect(row("index", "untracked.txt")).toBeVisible({ timeout: timeoutMs });
	expect(await command(root, "git --no-optional-locks show :untracked.txt")).toBe("ONE_NEW\n");
	await action("index", "untracked.txt", "取消暂存");
	await expect(row("untracked", "untracked.txt")).toBeVisible({ timeout: timeoutMs });
	expect(await command(root, "git --no-optional-locks ls-files -- untracked.txt")).toBe("");
	await action("index", "renamed.txt", "取消暂存");
	await expect(row("untracked", "renamed.txt")).toBeVisible({ timeout: timeoutMs });
	expect(await command(root, "git --no-optional-locks show :old.txt")).toBe("rename base\n");
	expect(await command(root, "git --no-optional-locks ls-files -- renamed.txt")).toBe("");

	// External index mutation invalidates the capability; the click must not clobber the external state.
	await command(root, "git add -- untracked.txt");
	const externalIndex = await command(root, "sha256sum .git/index");
	await action("workingTree", "tracked.txt", "暂存");
	await expect(panel.getByRole("alert")).toContainText("已变化", { timeout: timeoutMs });
	expect(await command(root, "sha256sum .git/index")).toBe(externalIndex);
	await refresh("tracked.txt");

	// Effective hooks/signing/official locks are refusal gates, not execution/bypass opportunities.
	for (const gate of ["lock", "hook", "signing"]) {
		const before = await command(root, "sha256sum .git/index");
		if (gate === "lock") await command(root, "printf 'OTHER_WRITER\\n' > .git/index.lock");
		if (gate === "hook") await command(root, "mkdir -p .git/hooks; printf '#!/bin/sh\\nprintf executed > .git/pideck-hook-ran\\n' > .git/hooks/post-index-change; chmod 700 .git/hooks/post-index-change");
		if (gate === "signing") await command(root, "git config commit.gpgSign true");
		await action("workingTree", "tracked.txt", "暂存");
		await expect(panel.getByRole("alert")).toContainText(gate === "lock" ? "锁定" : "暂不支持受控暂存", { timeout: timeoutMs });
		expect(await command(root, "sha256sum .git/index")).toBe(before);
		if (gate === "lock") {
			expect(await command(root, "cat .git/index.lock")).toBe("OTHER_WRITER\n");
			await command(root, "rm -- .git/index.lock");
		}
		if (gate === "hook") await command(root, "test ! -e .git/pideck-hook-ran; rm -- .git/hooks/post-index-change");
		if (gate === "signing") await command(root, "git config --unset commit.gpgSign");
		await refresh("tracked.txt");
	}
	await action("workingTree", "tracked.txt", "暂存");
	await expect(row("index", "tracked.txt")).toBeVisible({ timeout: timeoutMs });
	await expect(row("workingTree", "tracked.txt")).toHaveCount(0, { timeout: timeoutMs });
	expect(await command(root, "git --no-optional-locks show :tracked.txt")).toBe("ONE_WORK\n");
	expect(await command(root, "git --no-optional-locks rev-parse HEAD")).toBe(head);
	witnesses.filesAfter = await worktree(root);
	expect(witnesses.filesAfter).toBe(filesBefore);
	witnesses.finalStatus = await command(root, "GIT_OPTIONAL_LOCKS=0 git status --porcelain=v1");
	expect(await command(root, "test ! -e .git/index.lock; find .git -maxdepth 1 -name 'pideck-index-*' -print")).toBe("");

	await selectAndAuthorize(unborn);
	await expect(row("untracked", "new.txt")).toBeVisible({ timeout: timeoutMs });
	const keep = await command(unborn, "git --no-optional-locks rev-parse :keep.txt");
	await action("untracked", "new.txt", "暂存");
	await expect(row("index", "new.txt")).toBeVisible({ timeout: timeoutMs });
	expect(await command(unborn, "git --no-optional-locks show :new.txt")).toBe("UNBORN_NEW\n");
	await action("index", "new.txt", "取消暂存");
	await expect(row("untracked", "new.txt")).toBeVisible({ timeout: timeoutMs });
	expect(await command(unborn, "git --no-optional-locks ls-files")).toBe("keep.txt\n");
	expect(await command(unborn, "git --no-optional-locks rev-parse :keep.txt")).toBe(keep);
	witnesses.unbornAfter = await worktree(unborn);
	expect(witnesses.unbornAfter).toBe(unbornBefore);
	expect(await command(unborn, "test ! -e .git/index.lock; find .git -maxdepth 1 -name 'pideck-index-*' -print")).toBe("");
	await testInfo.attach("remote-git-index-independent-oracles", { body: Buffer.from(JSON.stringify(witnesses, null, 2)), contentType: "application/json" });
}
