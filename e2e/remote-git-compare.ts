import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * G5b read-only closeout through the real panel, on the G3a history fixture: compare the v1.0 tag with the
 * checked-out branch, check every row against native Git, open one file's two sides, then prove the visible
 * refs area polls (a tag created natively shows up without clicking refresh) while HEAD/index/refs/remote-tracking
 * refs stay untouched.
 *
 * Collapsed-area quiescence is not asserted here because the UI cannot observe the absence of a helper read
 * without instrumenting the main process; that rule is covered deterministically by tests/remoteGitRefsPolling.test.mjs
 * (fake timer + gate). This spec proves the visible behavior and the read-only witness.
 */
export async function verifyRemoteGitCompare(input: { window: Page; credentials: RemoteAcceptanceCredentials; root: string; timeoutMs: number; testInfo: TestInfo }) {
	const { window, credentials, root, timeoutMs, testInfo } = input;
	const panel = window.getByTestId("remote-git-panel");
	const command = async (script: string) => (await runRemoteCommand(credentials, "set -eu; cd " + quote(root) + "; " + script, 60_000)).stdout;
	const git = (script: string) => command("git --no-optional-locks " + script);
	const branch = (await git("symbolic-ref --short HEAD")).trim();
	const baseOid = (await git("rev-parse v1.0^{commit}")).trim();
	const headOid = (await git("rev-parse HEAD")).trim();
	const diffLines = (await git("diff --name-status v1.0 HEAD"))
		.trim()
		.split("\n")
		.map((line) => line.split("\t"));
	const oldSide = await git("show v1.0:tracked.txt");
	const newSide = await git("show HEAD:tracked.txt");
	/**
	 * Compare, refs polling and the per-file read must not write: index, HEAD, worktree and remote-tracking refs
	 * stay byte-identical. Local heads/tags are checked separately because this spec creates tags natively to
	 * observe the poll; only those exact additions may appear there.
	 */
	const witness = async () => ({
		index: await command("sha256sum .git/index; stat -c '%i %s %Y %Z' .git/index"),
		tracking: await git("for-each-ref --format='%(refname) %(objectname)' refs/remotes"),
		head: await git("rev-parse HEAD; git symbolic-ref HEAD"),
		files: await command("find . -path './.git' -prune -o -type f -exec sha256sum {} + | sort"),
	});
	const refsNow = () => git("for-each-ref --format='%(refname) %(objectname)' refs/heads refs/tags");
	const before = await witness();
	const refsBefore = await refsNow();

	await test.step("打开 Git 面板与引用区（手动展开，无写入口）", async () => {
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
		await expect(trust.or(panel.getByTestId("remote-git-branch"))).toBeVisible({ timeout: timeoutMs });
		if (await trust.isVisible().catch(() => false)) await trust.click();
		await expect(panel.getByTestId("remote-git-branch")).toContainText(branch, { timeout: timeoutMs });
		await panel.getByRole("button", { name: "引用", exact: true }).click();
		await expect(panel.getByTestId("remote-git-ref-row")).toHaveCount(4, { timeout: timeoutMs });
		// Visible-area polling is stated in the panel; it is not a button and has no toggle.
		await expect(panel.getByTestId("remote-git-refs-auto")).toContainText("15");
	});

	await test.step("对比 v1.0 与当前分支：行与原生 git diff 一致，rename 保留来源", async () => {
		await expect(panel.getByTestId("remote-git-compare")).toBeVisible();
		await panel.getByRole("button", { name: "分支对比", exact: true }).click();
		await panel.getByTestId("remote-git-compare-base").click();
		await window.getByRole("option", { name: /v1\.0/ }).click();
		await panel.getByTestId("remote-git-compare-head").click();
		await window.getByRole("option", { name: new RegExp("分支 " + branch.replace(/[.*+?^$()|[\]\\]/g, "\\$&")) }).click();
		await panel.getByTestId("remote-git-compare-run").click();
		const rows = panel.getByTestId("remote-git-compare-file");
		await expect(rows).toHaveCount(diffLines.length, { timeout: timeoutMs });
		for (const [status, ...paths] of diffLines) {
			const path = paths[paths.length - 1];
			const row = rows.filter({ hasText: path });
			await expect(row).toHaveAttribute("data-status", status);
			await expect(row).toHaveAttribute("data-path", path);
			if (paths.length === 2) await expect(row).toHaveAttribute("data-old-path", paths[0]);
		}
		const rename = rows.filter({ hasText: "renamed.txt" });
		await expect(rename).toHaveAttribute("data-old-path", "old.txt");
	});

	await test.step("逐文件两侧内容复用两版本 diff", async () => {
		await panel.getByTestId("remote-git-compare-file").filter({ hasText: "tracked.txt" }).click();
		const diff = panel.getByTestId("remote-git-diff");
		await expect(diff).toBeVisible({ timeout: timeoutMs });
		const diffText = () =>
			diff.evaluate((element) => {
				const text = (node: Node): string =>
					Array.from(node.childNodes)
						.map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? "") : text(child) + (child instanceof Element && child.shadowRoot ? text(child.shadowRoot) : "")))
						.join(" ");
				return text(element);
			});
		await expect.poll(diffText, { timeout: timeoutMs }).toContain(oldSide.trim());
		await expect.poll(diffText, { timeout: timeoutMs }).toContain(newSide.trim());
		await panel.getByRole("button", { name: "返回远端变更列表", exact: true }).click();
		// Opening a file replaces the panel body, so the compare section remounts collapsed (its expand state is
		// local UI state). Re-expanding is the same user gesture as before; the compare fact is still in the
		// controller, so the rows come back without a second compare run.
		await panel.getByRole("button", { name: "分支对比", exact: true }).click();
		await expect(panel.getByTestId("remote-git-compare-file").filter({ hasText: "tracked.txt" })).toBeVisible();
	});

	await test.step("引用区可见时轮询：原生新建 tag 不点刷新也会出现，且不 fetch", async () => {
		await command("git tag pideck-poll-tag HEAD");
		const pollTimeout = Math.max(timeoutMs, 45_000);
		await expect(panel.getByTestId("remote-git-ref-row")).toHaveCount(5, { timeout: pollTimeout });
		await expect(panel.getByTestId("remote-git-ref-row").filter({ hasText: "pideck-poll-tag" })).toBeVisible();
		expect(await witness()).toEqual(before);
		// The only ref change is the tag this spec created natively; PiDeck moved nothing.
		const refsAfterPolling = await refsNow();
		for (const line of refsBefore.split("\n").filter(Boolean)) expect(refsAfterPolling).toContain(line);
		const polledTagLine = (await git("for-each-ref --format='%(refname) %(objectname)' refs/tags/pideck-poll-tag")).trim();
		expect(refsAfterPolling.split("\n").filter((line) => line && !refsBefore.includes(line))).toEqual([polledTagLine]);
	});

	await test.step("收起后不再轮询：原生再建 tag 不会出现在缓存列表里，显式刷新才重取", async () => {
		await panel.getByRole("button", { name: "引用", exact: true }).click();
		await expect(panel.getByTestId("remote-git-ref-row")).toHaveCount(0);
		await command("git tag pideck-poll-tag-2 HEAD");
		await new Promise((accept) => setTimeout(accept, 32_000));
		// Re-expanding shows the facts cached before the collapse: had a background poll run while collapsed,
		// the second tag would already be there. This is the observable form of "no work when collapsed".
		await panel.getByRole("button", { name: "引用", exact: true }).click();
		await expect(panel.getByTestId("remote-git-ref-row")).toHaveCount(5, { timeout: 5_000 });
		await expect(panel.getByTestId("remote-git-ref-row").filter({ hasText: "pideck-poll-tag-2" })).toHaveCount(0);
		expect(await witness()).toEqual(before);
		// The explicit refresh is still the way to rebuild the facts (and is a read only).
		await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
		await expect(panel.getByTestId("remote-git-ref-row")).toHaveCount(6, { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-ref-row").filter({ hasText: "pideck-poll-tag-2" })).toBeVisible();
		expect(await witness()).toEqual(before);
	});

	await testInfo.attach("remote-git-compare-oracles", {
		body: Buffer.from(JSON.stringify({ branch, baseOid, headOid, diffLines, oldSide, newSide, before }, null, 2)),
		contentType: "application/json",
	});
}
