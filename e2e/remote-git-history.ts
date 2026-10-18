import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}
const FILLERS = 53;

/**
 * Only a newly allocated run-owned directory is initialized: one baseline commit, one rename+edit commit whose
 * message keeps a `#` line byte-exact, a local branch behind HEAD, a lightweight and an annotated tag, and
 * enough empty commits that the first 50-row page is followed by a real second page.
 */
export async function initializeRemoteGitHistoryFixture(credentials: RemoteAcceptanceCredentials, root: string) {
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
			"printf 'HIST_BASE\\n' > tracked.txt",
			"printf 'rename base\\n' > old.txt",
			"git add -- .",
			"git commit -qm baseline",
			"git tag v1.0",
			"printf 'HIST_NEXT\\n' > tracked.txt",
			"git add -- tracked.txt",
			"git mv -- old.txt renamed.txt",
			"git commit -qm $'second subject\\n\\nbody line with # hash kept\\n'",
			"git tag -a -m annotated v2.0",
			"git branch feature/x HEAD",
			"for i in $(seq 1 " + FILLERS + '); do git commit --allow-empty -qm "filler $i"; done',
		].join("; "),
		60_000,
	);
}

/** Read-only history and refs through the real panel, checked against independent native Git reads. */
export async function verifyRemoteGitHistory(input: { window: Page; credentials: RemoteAcceptanceCredentials; root: string; timeoutMs: number; testInfo: TestInfo }) {
	const { window, credentials, root, timeoutMs, testInfo } = input;
	const panel = window.getByTestId("remote-git-panel");
	const command = async (path: string, script: string) => (await runRemoteCommand(credentials, "set -eu; cd " + quote(path) + "; " + script, 60_000)).stdout;
	const git = (script: string) => command(root, "git --no-optional-locks " + script);
	/** Nothing in this batch may write: index bytes and metadata, refs, HEAD and worktree stay exactly as they were. */
	const witness = async () => ({
		index: await command(root, "sha256sum .git/index; stat -c '%i %s %Y %Z' .git/index"),
		refs: await git("for-each-ref --format='%(refname) %(objectname)' refs/heads refs/tags"),
		head: await git("rev-parse HEAD; git symbolic-ref HEAD"),
		files: await command(root, "find . -path './.git' -prune -o -type f -exec sha256sum {} + | sort"),
	});
	const log = (await git("log --format='%H %s'")).trim().split("\n");
	const headOid = (await git("rev-parse HEAD")).trim();
	const secondOid = (await git("rev-parse v2.0^{commit}")).trim();
	const baseOid = (await git("rev-parse v2.0^{commit}~1")).trim();
	// %B appends a format newline; cat-file's raw message after the header is what the helper must return byte-exact.
	const message = await command(root, "git --no-optional-locks cat-file commit " + secondOid + " | sed '1,/^$/d'");
	const branch = (await git("symbolic-ref --short HEAD")).trim();
	const peeled = (await git("rev-parse v2.0^{commit}")).trim();
	const lightweight = (await git("rev-parse v1.0")).trim();
	const oldSide = await git("show " + baseOid + ":tracked.txt");
	const newSide = await git("show " + secondOid + ":tracked.txt");
	expect(log.length).toBe(2 + FILLERS);
	expect(log[0]).toBe(headOid + " filler " + FILLERS);
	expect(message).toBe("second subject\n\nbody line with # hash kept\n");
	const before = await witness();

	await test.step("打开历史与引用区（手动展开，不轮询）", async () => {
		await remoteProjectRow(window, root.split("/").pop() ?? "")
			.locator(".conversation-title")
			.first()
			.click();
		await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
		await window.getByTestId("drawer-rail-git").click();
		await expect(panel).toBeVisible();
		await expect(panel.getByRole("alert")).toContainText("尚未明确授权", { timeout: timeoutMs });
		await panel.getByRole("button", { name: "信任此项目及其 .pi 资源", exact: true }).click();
		await expect(panel.getByTestId("remote-git-branch")).toContainText(branch, { timeout: timeoutMs });
		// Collapsed by default: no history flight happens until the section is opened by hand.
		await expect(panel.getByTestId("remote-git-history-row")).toHaveCount(0);
		await panel.getByRole("button", { name: "提交历史", exact: true }).click();
		await expect(panel.getByTestId("remote-git-history")).toContainText("只读", { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-history-row")).toHaveCount(50, { timeout: timeoutMs });
		const first = panel.getByTestId("remote-git-history-row").first();
		await expect(first).toHaveAttribute("data-oid", headOid);
		await expect(first).toContainText("filler " + FILLERS);
		await expect(first).toContainText("PiDeck-E2E");
	});

	await test.step("加载更多：第二页与原生 Git 逐行一致", async () => {
		await panel.getByTestId("remote-git-history-more").click();
		await expect(panel.getByTestId("remote-git-history-row")).toHaveCount(2 + FILLERS, { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-history-more")).toHaveCount(0);
		const rows = panel.getByTestId("remote-git-history-row");
		for (const [index, line] of log.entries()) {
			const row = rows.nth(index);
			await expect(row).toHaveAttribute("data-oid", line.slice(0, 40));
			await expect(row).toContainText(line.slice(41));
		}
	});

	await test.step("提交详情：消息逐字、文件列表与 rename 来源", async () => {
		await panel.getByTestId("remote-git-history-row").filter({ hasText: "second subject" }).click();
		const detail = panel.getByTestId("remote-git-commit-detail");
		await expect(detail).toBeVisible({ timeout: timeoutMs });
		await expect(detail).toContainText(secondOid);
		await expect(detail).toContainText("pideck-e2e@example.invalid");
		const detailText = () =>
			detail.evaluate((element) => {
				const text = (node: Node): string =>
					Array.from(node.childNodes)
						.map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? "") : text(child) + (child instanceof Element && child.shadowRoot ? text(child.shadowRoot) : "")))
						.join(" ");
				return text(element);
			});
		// cat-file 的消息逐字节进 DOM：`#` 行原样保留，不经过任何注释剥离。
		await expect.poll(detailText, { timeout: timeoutMs }).toContain(message);
		await expect(detail.getByTestId("remote-git-commit-file").filter({ hasText: "renamed.txt" })).toContainText("R100");
		await expect(detail.getByTestId("remote-git-commit-file").filter({ hasText: "renamed.txt" })).toContainText("old.txt");
		await expect(detail.getByTestId("remote-git-commit-file").filter({ hasText: "tracked.txt" })).toContainText("M");
	});

	await test.step("两版本单文件差异：两侧与 git show 一致", async () => {
		await panel.getByTestId("remote-git-commit-file").filter({ hasText: "tracked.txt" }).click();
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
		await expect(panel.getByTestId("remote-git-history-row")).toHaveCount(2 + FILLERS);
	});

	await test.step("引用：本地分支与 tag，含 annotated 的 peeled 提交", async () => {
		await expect(panel.getByTestId("remote-git-ref-row")).toHaveCount(0);
		await panel.getByRole("button", { name: "引用", exact: true }).click();
		const rows = panel.getByTestId("remote-git-ref-row");
		await expect(rows).toHaveCount(4, { timeout: timeoutMs });
		await expect(rows.filter({ hasText: branch })).toContainText("分支");
		await expect(rows.filter({ hasText: "feature/x" })).toContainText("分支");
		await expect(rows.filter({ hasText: "v1.0" })).toContainText(lightweight.slice(0, 8));
		await expect(rows.filter({ hasText: "v2.0" })).toContainText(peeled.slice(0, 8));
		// 历史本身仍无写入口；G3b 只开放「新建分支」与逐行「切换」，其余危险控件仍然不存在。
		await expect(panel.getByTestId("remote-git-create-branch")).toBeVisible();
		await expect(panel.getByTestId("remote-git-switch-branch").first()).toBeVisible();
		await expect(panel.getByRole("button", { name: /^(丢弃|全部暂存|初始化|检出|删除分支|重命名|打标签|强制)/ })).toHaveCount(0);
	});

	await test.step("手动刷新重建事实，仓库字节不变", async () => {
		await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
		await expect(panel.getByTestId("remote-git-history-row")).toHaveCount(50, { timeout: timeoutMs });
		await expect(panel.getByTestId("remote-git-history-more")).toBeVisible();
		await expect(panel.getByTestId("remote-git-commit-detail")).toHaveCount(0);
		await expect(panel.getByTestId("remote-git-ref-row")).toHaveCount(4, { timeout: timeoutMs });
		const after = await witness();
		expect(after).toEqual(before);
	});

	await testInfo.attach("remote-git-history-oracles", {
		body: Buffer.from(JSON.stringify({ log, headOid, secondOid, baseOid, message, branch, peeled, lightweight, oldSide, newSide, before }, null, 2)),
		contentType: "application/json",
	});
}
