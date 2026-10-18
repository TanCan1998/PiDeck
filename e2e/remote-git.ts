import { expect, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { remoteProjectRow, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

/** Separate local Git negative control: the remote UI must leave its index and worktree untouched. */
export async function createLocalGitReadControl() {
	const directory = await mkdtemp(join(tmpdir(), "pideck-git-g1-local-control-"));
	const exec = promisify(execFile);
	try {
		await exec("git", ["init", "-q", directory], { timeout: 10_000 });
		await writeFile(join(directory, "tracked.txt"), "LOCAL_CONTROL\n");
		await exec("git", ["-C", directory, "add", "--", "tracked.txt"], { timeout: 10_000 });
		const snapshot = async () => {
			const index = await readFile(join(directory, ".git", "index"));
			const facts = await stat(join(directory, ".git", "index"));
			return { index: index.toString("base64"), file: await readFile(join(directory, "tracked.txt"), "utf8"), ino: facts.ino, mode: facts.mode, mtimeMs: facts.mtimeMs, ctimeMs: facts.ctimeMs };
		};
		const before = await snapshot();
		return { verify: async () => expect(await snapshot()).toEqual(before), dispose: () => rm(directory, { recursive: true, force: true }) };
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

function quote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}
/** Only this run's newly created repositories are initialized; no user repository or Git settings are modified. */
export async function initializeRemoteGitFixture(credentials: RemoteAcceptanceCredentials, root: string, neighbor: string): Promise<void> {
	for (const [path, label] of [
		[root, "ONE"],
		[neighbor, "TWO"],
	]) {
		await runRemoteCommand(
			credentials,
			[
				"set -eu",
				"umask 077",
				"mkdir -p " + quote(path),
				"cd " + quote(path),
				"git init -q",
				"git config user.name PiDeck-E2E",
				"git config user.email pideck-e2e@example.invalid",
				"printf '" + label + "_BASE\\n' > tracked.txt",
				"printf 'rename base\\n' > old.txt",
				"printf 'delete base\\n' > deleted.txt",
				"git add -- .",
				"git commit -qm baseline",
				"printf '" + label + "_INDEX\\n' > tracked.txt",
				"git add -- tracked.txt",
				"printf '" + label + "_WORK\\n' > tracked.txt",
				"git mv -- old.txt renamed.txt",
				"git rm -q -- deleted.txt",
				"printf '" + label + "_NEW\\n' > untracked.txt",
				"printf '\\000binary' > binary.dat",
			].join("; "),
			30_000,
		);
	}
}
/** Independent Git CLI/blob/file oracle, plus hashes and metadata of every fixture file; no optional index refresh. */
async function evidence(credentials: RemoteAcceptanceCredentials, path: string) {
	const prefix = "set -eu; cd " + quote(path) + "; ";
	const disk = (await runRemoteCommand(credentials, prefix + "find . -type f -exec sha256sum {} + | sort; find . -printf '%y %m %s %i %T@ %C@ %p\\n' | sort", 60_000)).stdout;
	const status = (await runRemoteCommand(credentials, prefix + "GIT_OPTIONAL_LOCKS=0 git status --porcelain=v1 -z --untracked-files=all | base64 -w0", 60_000)).stdout;
	const blobs = (await runRemoteCommand(credentials, prefix + "git --no-optional-locks show HEAD:tracked.txt; git --no-optional-locks show :tracked.txt; cat tracked.txt untracked.txt", 60_000)).stdout;
	return { disk, status, blobs };
}

/** Real UI path, no IPC calls or model output: trust → SCM groups → on-demand diff → isolation/disconnect. */
export async function verifyRemoteGitRead(input: { window: Page; credentials: RemoteAcceptanceCredentials; root: string; neighbor: string; timeoutMs: number; testInfo: TestInfo }) {
	const { window, credentials, root, neighbor, timeoutMs, testInfo } = input;
	const before = [await evidence(credentials, root), await evidence(credentials, neighbor)];
	const panel = window.getByTestId("remote-git-panel");
	const select = async (path: string) =>
		remoteProjectRow(window, path.split("/").pop() ?? "")
			.locator(".conversation-title")
			.first()
			.click();
	await select(root);
	await window.locator(".header-drawer-toggle").first().click();
	await window.getByTestId("drawer-rail-git").click();
	await expect(panel).toBeVisible();
	await expect(panel.getByRole("alert")).toContainText("尚未明确授权", { timeout: timeoutMs });
	await panel.getByRole("button", { name: "信任此项目及其 .pi 资源", exact: true }).click();
	await expect(panel.getByTestId("remote-git-index")).toContainText("tracked.txt", { timeout: timeoutMs });
	await expect(panel.getByTestId("remote-git-index")).toContainText("renamed.txt");
	await expect(panel.getByTestId("remote-git-index")).toContainText("deleted.txt");
	await expect(panel.getByTestId("remote-git-workingTree")).toContainText("tracked.txt");
	await expect(panel.getByTestId("remote-git-untracked")).toContainText("untracked.txt");
	// Commit is implemented as of G2b, but it must never be a one-click action: the button stays disabled until a
	// message is typed, and the still-unimplemented or dangerous actions remain absent.
	await expect(panel.getByRole("button", { name: /^(丢弃|初始化|全部暂存|强制|amend)/ })).toHaveCount(0);
	// G5a: the sync bar is part of the panel, and a push asks for confirmation instead of firing on one click.
	await expect(panel.getByTestId("remote-git-sync-fetch")).toBeVisible();
	await expect(panel.getByTestId("remote-git-sync-push")).toBeVisible();
	await expect(panel.getByTestId("remote-git-sync-pull")).toBeVisible();
	await expect(panel.getByRole("button", { name: "提交已暂存的改动", exact: true })).toBeDisabled();
	const diff = async (group: string, name: string, old: string, next: string) => {
		await panel
			.getByTestId("remote-git-" + group)
			.getByRole("button", { name: /Git 差异/ })
			.filter({ hasText: name })
			.click();
		await expect(panel.getByTestId("remote-git-diff")).toBeVisible({ timeout: timeoutMs });
		// The existing diff viewer renders in a worker/shadow tree. Its accessible text may be virtualized;
		// the DOM's visible textContent oracle below includes nested shadow roots, not a mocked preview.
		await expect
			.poll(
				async () =>
					panel.getByTestId("remote-git-diff").evaluate((element) => {
						const text = (node: Node): string =>
							Array.from(node.childNodes)
								.map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? "") : text(child) + (child instanceof Element && child.shadowRoot ? text(child.shadowRoot) : "")))
								.join(" ");
						return text(element);
					}),
				{ timeout: timeoutMs },
			)
			.toContain(next || old);
		if (old && next)
			await expect
				.poll(
					async () =>
						panel.getByTestId("remote-git-diff").evaluate((element) => {
							const text = (node: Node): string =>
								Array.from(node.childNodes)
									.map((child) => (child.nodeType === Node.TEXT_NODE ? (child.textContent ?? "") : text(child) + (child instanceof Element && child.shadowRoot ? text(child.shadowRoot) : "")))
									.join(" ");
							return text(element);
						}),
					{ timeout: timeoutMs },
				)
				.toContain(old);
		await panel.getByRole("button", { name: "返回远端变更列表", exact: true }).click();
	};
	await diff("index", "tracked.txt", "ONE_BASE", "ONE_INDEX");
	await diff("workingTree", "tracked.txt", "ONE_INDEX", "ONE_WORK");
	await diff("untracked", "untracked.txt", "", "ONE_NEW");
	await panel
		.getByTestId("remote-git-untracked")
		.getByRole("button", { name: /Git 差异/ })
		.filter({ hasText: "binary.dat" })
		.click();
	await expect(panel.getByRole("alert")).toContainText("无法预览", { timeout: timeoutMs });
	await panel.getByRole("button", { name: "返回远端变更列表", exact: true }).click();

	await select(neighbor);
	// Drawer selection is per project. The new project's default is closed; wait for that restored
	// chrome before reopening, rather than clicking the old panel during its close animation.
	await window.getByRole("button", { name: "打开右侧边栏", exact: true }).click();
	await window.getByTestId("drawer-rail-git").click();
	await expect(panel).toHaveAttribute("data-project-id", (await remoteProjectRow(window, neighbor.split("/").pop() ?? "").getAttribute("data-sidebar-removal-id")) ?? "");
	await expect(panel.getByRole("alert")).toContainText("尚未明确授权", { timeout: timeoutMs });
	await panel.getByRole("button", { name: "信任此项目及其 .pi 资源", exact: true }).click();
	await expect(panel.getByTestId("remote-git-workingTree")).toContainText("tracked.txt", { timeout: timeoutMs });
	await diff("workingTree", "tracked.txt", "TWO_INDEX", "TWO_WORK");
	await select(root);
	await expect(panel).toHaveAttribute("data-project-id", (await remoteProjectRow(window, root.split("/").pop() ?? "").getAttribute("data-sidebar-removal-id")) ?? "");
	await expect(panel.getByTestId("remote-git-workingTree")).toContainText("tracked.txt", { timeout: timeoutMs });
	await diff("workingTree", "tracked.txt", "ONE_INDEX", "ONE_WORK");

	await window.getByRole("button", { name: /^设置/ }).click();
	const modal = window.locator(".settings-modal");
	await modal.getByRole("tab", { name: "连接", exact: true }).click();
	// ConnectionsTab's existing local state resets on remount; match the terminal acceptance path:
	// explicitly establish the visible connected state, then test the actual disconnect (not a stale label).
	if (await modal.getByRole("button", { name: "连接", exact: true }).count()) {
		await modal.getByRole("button", { name: "连接", exact: true }).first().click();
		await expect(modal.getByText("已连接").first()).toBeVisible({ timeout: timeoutMs });
	}
	await modal.getByRole("button", { name: "断开", exact: true }).first().click();
	await expect(modal.getByRole("button", { name: "连接", exact: true }).first()).toBeVisible({ timeout: timeoutMs });
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await expect(panel.getByRole("alert")).toContainText("连接或快照已失效", { timeout: timeoutMs });
	await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
	await expect(panel.getByRole("alert")).toContainText("连接或快照已失效", { timeout: timeoutMs });
	await expect(panel.getByTestId("remote-git-workingTree")).toHaveCount(0);
	await window.getByRole("button", { name: /^设置/ }).click();
	await modal.getByRole("tab", { name: "连接", exact: true }).click();
	await expect(modal.getByText("已断开连接").first()).toBeVisible();
	await modal.getByRole("button", { name: "连接", exact: true }).first().click();
	await expect(modal.getByText("已连接").first()).toBeVisible({ timeout: timeoutMs });
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await expect(panel.getByTestId("remote-git-workingTree")).toHaveCount(0); // explicit reconnect alone never replays a read
	await panel.getByRole("button", { name: "刷新远端 Git", exact: true }).click();
	await expect(panel.getByTestId("remote-git-workingTree")).toContainText("tracked.txt", { timeout: timeoutMs });
	const after = [await evidence(credentials, root), await evidence(credentials, neighbor)];
	expect(after).toEqual(before);
	await testInfo.attach("remote-git-independent-read-only-oracles", { body: Buffer.from(JSON.stringify({ before, after }, null, 2)), contentType: "application/json" });
}
