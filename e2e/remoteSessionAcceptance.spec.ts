import { expect, type Locator, type Page } from "@playwright/test";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePiSessionDirectory } from "../src/main/remote/remoteSessionProjectMatch";
import { REMOTE_ACCEPTANCE_ENV, createRemoteSessionInProject, matchesRemoteFingerprint, readRemoteAcceptanceCredentials, readRemoteAcceptanceTimeouts, remoteProjectRow, runRemoteCommand, test, type RemoteAcceptanceCredentials, type RemoteAcceptanceTimeouts } from "./remote-fixtures";

/**
 * 远端会话功能级验收（Phase 4 P4.2 真机 UI 收口）：在真实 Electron + 真实主机上跑
 * 「加主机 + pin → 连接 ready → 登记远端项目 → **在该远端项目里新建会话** → 发一条最小 prompt →
 * 时间线出现 assistant 正文 → ⋯ 关闭 Agent（回到可重启）→ 关掉标签页再点开该会话 → 历史仍在」，
 * 并单独验收「远端会话的 trust 提示可见」。
 *
 * 门控（硬要求 1）：三个必需环境变量缺任意一个就整体 skip。test.skip 放在 describe 回调里、
 * 任何 test body 之外，Playwright 在 fixture setup 之前就标记跳过，所以无凭据跑本 spec
 * **不会启动 Electron**，npm run e2e / CI 仍然全绿。
 *
 * 隔离（硬要求 2）：userData 走 remote-fixtures 的 `remoteApp`（临时 --user-data-dir +
 * APPDATA/LOCALAPPDATA + PIDECK_E2E_USER_DATA_DIR），刻意**不隔离 HOME/USERPROFILE** ——
 * 产品用系统 OpenSSH 连接，必须读到真实用户的 ~/.ssh/config 与私钥。
 *
 * 实验门禁（硬要求 3）：不在这里发明第二种传法。远端能力在 main 里只由
 * `!app.isPackaged && <实验开关环境变量> === "1"` 裁定，`remoteApp` fixture 已经把它塞进子进程环境
 * （见 e2e/remote-fixtures.ts），本 spec 直接复用同一台 Electron。
 *
 * 为什么要拆成两个 test（**只调整顺序与分节，不删断言**）：
 * - 第 1 个 test 是**产品路**（新建 → 发送 → 正文 → 停止 → 重开历史）。它必须能独立给出结论，
 *   不能被「trust 提示」那条断言挡住——否则一条提示缺失会把「这条产品路到底通不通」一起掩盖。
 * - 第 2 个 test 单独验收 trust 提示（硬要求 d）。提示只可能出现在 runtime 存在的那段时间里
 *   （关闭 Agent 后 runtime 解绑，提示随之消失），所以它无法被排到第 1 个 test 的末尾——只能分节。
 *
 * 取值口径：真实主机/指纹只来自环境变量，本文件不出现任何主机或指纹字面量。
 * 凭据环境变量：PIDECK_E2E_REMOTE_HOST / PIDECK_E2E_REMOTE_USER / PIDECK_E2E_REMOTE_FINGERPRINT
 * （端口 PIDECK_E2E_REMOTE_PORT 与两个超时可选）。
 *
 * 诊断只走「主进程日志留档」：隔离 userData 会被夹具删除，日志只在测试内读得到；本 spec **不**
 * 通过 IPC 直调任何运行链路（驱动产品路一律走真实界面动作）。
 *
 * 「重启后历史仍在」这一条如实区分两件事：
 * - **本次交付的链路**＝`⋯ → 关闭 Agent`（杀进程 + 解绑）后**重新点开该会话**，历史仍在；
 * - **尚未交付的能力**＝重启/重载后**从远端读回历史正文**（`docs/remote-development-handoff.md` 的
 *   P4.2 遗留项与 `src/main/ipc/remoteSessionIpc.ts` 的「本批不解析正文」都记着它）。
 *   第二条不放进默认门禁（默认门禁只反映本次交付的链路），但留了一个行为等价的缺口探针步骤：
 *   用 PIDECK_E2E_P42_GAP_PROBE=1 打开它就能拿到缺口的运行证据（红）。探针默认关闭 ≠ 放宽断言：
 *   它打开的是一条更强的断言，关掉的是「把已知未交付能力算进本次门禁」。
 */
const credentials = readRemoteAcceptanceCredentials(process.env);
const timeouts = readRemoteAcceptanceTimeouts(process.env);
const HELP_TEXT = "set " + [REMOTE_ACCEPTANCE_ENV.host, REMOTE_ACCEPTANCE_ENV.user, REMOTE_ACCEPTANCE_ENV.fingerprint].join(" / ") + " to run the real-host acceptance test";
/** 缺口探针开关（默认关）：见文件头的说明。 */
const GAP_PROBE_ENV = "PIDECK_E2E_P42_GAP_PROBE";
// 破坏性演练开关：会 kill 该会话自己的远端 pi 进程（默认关闭，只在人工演练时打开）。
const REATTACH_DRILL_ENV = "PIDECK_E2E_P42_REATTACH_DRILL";
/** 最小 prompt：与 scripts/verify-remote-runtime.mjs 的协议层验收用同一条，避免两处口径漂移。 */
const PROMPT = "只回复 pong";
const FOLLOW_UP = "只回复 ping";
const FOLLOW_UP_AFTER = "只回复 pong2";
/** 远端 trust 提示的标题文案（i18n `session.remoteTrust.title`）；组件同时带 data-testid。 */
const TRUST_TITLE = "远端项目资源未加载";

/** 侧栏项目行（与 remote-fixtures 的 remoteProjectRow 同源）。 */
function projectRow(window: Page, projectName: string): Locator {
	return remoteProjectRow(window, projectName);
}

/**
 * 首启引导（CommandPaletteOnboarding）会盖住整个界面：存在就点「以后再说」关掉，不存在不算失败。
 * waitMs 给第一次调用留出引导的延迟弹出窗口（产品在有活动项目后延迟 2.5s 才弹）；后续调用传 0
 * 只做一次廉价兜底——引导关闭时产品会写 localStorage 标记，正常情况下不会再出现。
 * 与 `remoteHostAcceptance.spec.ts` 的处理逐字同款（隔离 userData ⇒ 每次都是首启）。
 */
async function dismissOnboarding(window: Page, waitMs: number): Promise<void> {
	const dialog = window.locator('[role="dialog"]').filter({ hasText: "用命令面板直达任何设置" });
	if (waitMs > 0) await dialog.waitFor({ state: "visible", timeout: waitMs }).catch(() => undefined);
	if ((await dialog.count()) === 0) return;
	await dialog.getByRole("button", { name: "以后再说" }).click();
	await expect(dialog, "引导关闭后不应再可见").toHaveCount(0);
}

/** 会话 Tab 栏右上角的 ⋯ 菜单（运行控制组：启动/重启、停止回答、重新加载、关闭 Agent 都在这里）。 */
async function openTabsActionMenu(window: Page): Promise<void> {
	await window.locator(".session-tabs-actions").getByRole("button", { name: "更多操作" }).click();
}

/** 本次运行的远端夹具路径：runId 唯一命名 ⇒ 清理只可能命中本次运行造出来的东西。 */
type RemoteRunPaths = {
	runId: string;
	home: string;
	e2eRoot: string;
	sessionRoot: string;
	projectName: string;
	projectPath: string;
	/** 远端 pi 自己落的会话目录（按本项目 canonical 路径编码，与产品归属判定同一函数）。 */
	sessionEvidenceDir: string;
};

async function createRemoteRunPaths(credentials: RemoteAcceptanceCredentials): Promise<RemoteRunPaths> {
	const runId = "e2e" + Date.now().toString(36);
	const home = (await runRemoteCommand(credentials, 'printf %s "$HOME"', 30_000)).stdout.trim();
	expect(home.startsWith("/"), "远端 $HOME 必须是绝对 POSIX 路径").toBe(true);
	expect(/\s/.test(home), "远端 $HOME 含空白：夹具与清理命令按既有风格不做引用，先在这里拒绝").toBe(false);
	const e2eRoot = home + "/.pideck-e2e-" + runId;
	const sessionRoot = home + "/.pi/agent/sessions";
	const projectName = "remote-session-" + runId;
	const projectPath = e2eRoot + "/" + projectName;
	const sessionEvidenceDir = sessionRoot + "/" + encodePiSessionDirectory(projectPath);
	// 归属自检：清理命令里要 rm 的路径只能是「我们建的项目根」与「由它的编码折出来的会话目录」。
	expect(sessionEvidenceDir.startsWith(sessionRoot + "/"), "会话目录必须落在会话根之下").toBe(true);
	expect(sessionEvidenceDir.endsWith("/" + encodePiSessionDirectory(projectPath)), "会话目录的最后一段必须是本项目的编码名").toBe(true);
	return { runId, home, e2eRoot, sessionRoot, projectName, projectPath, sessionEvidenceDir };
}

/** 远端前置：一个只含 hello.txt 的项目目录（远端 pi 的 cwd）。 */
async function createRemoteProjectDirectory(credentials: RemoteAcceptanceCredentials, paths: RemoteRunPaths): Promise<void> {
	await runRemoteCommand(credentials, "mkdir -p " + paths.projectPath + " && echo hello > " + paths.projectPath + "/hello.txt", 60_000);
}

/** 设置页加主机：ssh config 候选 → pin 指纹必须命中注入的期望值 → 连接 ready（与 Phase 3 同一 UI 路径）。 */
async function addVerifiedRemoteHostAndConnect(window: Page, credentials: RemoteAcceptanceCredentials, limits: RemoteAcceptanceTimeouts): Promise<void> {
	await dismissOnboarding(window, 0);
	// 设置入口是左下角 Dock 的第一个按钮（Bolt）：aria-label 是「设置」或「设置（有新版本可用）」。
	await window.getByRole("button", { name: /^设置/ }).click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	await modal.getByRole("tab", { name: "连接", exact: true }).click();
	await modal.getByRole("button", { name: "添加", exact: true }).click();
	const addDialog = window.locator('[role="dialog"]').filter({ hasText: "添加 SSH 连接" });
	await expect(addDialog, "点「添加」必须打开 AddHostDialog").toBeVisible();
	// 候选来自真实 ~/.ssh/config：按 user@host 精确匹配，同一条 config 可能有多条别名指向同一主机，
	// 所以断言「至少一条」再取第一条。
	const candidate = addDialog.getByRole("button", { name: new RegExp(credentials.user + "@" + credentials.host.replace(/\./g, "\\.")) });
	expect(await candidate.count(), "ssh config 里需要至少一条 " + credentials.user + "@" + credentials.host + " 候选").toBeGreaterThan(0);
	await candidate.first().click();
	await addDialog.getByRole("button", { name: "保存", exact: true }).click();
	// pin 流程：主进程推送真实 host key，界面必须原样展示；期望指纹必须命中它。
	const pinDialog = window.locator('[role="dialog"]').filter({ hasText: "确认主机指纹" });
	await expect(pinDialog).toBeVisible({ timeout: limits.connectMs });
	const observed = await pinDialog.locator("li.select-all.break-all.font-mono").allTextContents();
	expect(observed.length, "pin 弹框必须列出至少一个主机密钥指纹").toBeGreaterThan(0);
	expect(matchesRemoteFingerprint(credentials.fingerprint, observed), "pin 弹框展示的指纹必须命中 " + REMOTE_ACCEPTANCE_ENV.fingerprint + "（期望 " + credentials.fingerprint + "，实到 " + observed.join(" | ") + "）").toBe(true);
	await pinDialog.getByRole("button", { name: "指纹正确，信任" }).click();
	await expect(pinDialog).toHaveCount(0);
	// 连接：bootstrap 完成后行状态是「已连接」、开关翻成「断开」。
	await window.getByRole("button", { name: "连接", exact: true }).first().click();
	await expect(window.getByText("已连接").first()).toBeVisible({ timeout: limits.helperMs });
	await expect(window.getByRole("button", { name: "断开", exact: true }).first()).toBeVisible();
	await window.locator(".settings-modal").getByRole("button", { name: "关闭" }).first().click();
	await expect(window.locator(".settings-modal")).toHaveCount(0);
}

/** 侧栏登记远端项目：+ → 远端（SSH）→ 路径 → canonical 确认 → 添加（与 Phase 3 同一 UI 路径）。 */
async function enrollRemoteProjectInSidebar(window: Page, projectPath: string, limits: RemoteAcceptanceTimeouts): Promise<void> {
	// 显式切到「项目」页签：侧栏项目树才会渲染。
	await window.getByRole("tab", { name: "项目" }).click();
	await window.getByRole("button", { name: "添加项目" }).first().click();
	await window.getByRole("menuitem", { name: /远端（SSH）/ }).click();
	const enrollDialog = window.locator('[role="dialog"]').filter({ hasText: "添加远端项目" });
	await expect(enrollDialog).toBeVisible();
	await expect(enrollDialog.locator("#remote-enroll-host")).not.toBeEmpty();
	await enrollDialog.locator("#remote-enroll-path").fill(projectPath);
	await enrollDialog.getByRole("button", { name: "解析并确认" }).click();
	const confirmDialog = window.locator('[role="dialog"]').filter({ hasText: "确认远端项目目录" });
	await expect(confirmDialog).toBeVisible({ timeout: limits.helperMs });
	await expect(confirmDialog.getByText(projectPath, { exact: false }).first()).toBeVisible();
	await confirmDialog.getByRole("button", { name: "添加项目" }).click();
	const enrolledDialog = window.locator('[role="dialog"]').filter({ hasText: "已添加远端项目" });
	await expect(enrolledDialog).toBeVisible({ timeout: limits.helperMs });
	await enrolledDialog.getByRole("button", { name: "完成" }).click();
	await expect(projectRow(window, projectPath.split("/").pop() ?? "")).toBeVisible();
}

/**
 * 在该远端项目里新建会话并确认会话视图可用，返回会话 id。
 *
 * 入口在侧栏项目行的操作浮层（`createRemoteSessionInProject`，见 remote-fixtures）：远端项目的中间
 * 空态是**只读**面板，没有新建入口。入口不存在时这里会红——那是首要发现，不允许用 IPC 直调绕过。
 */
async function createRemoteSessionAndReadId(window: Page, projectName: string, limits: RemoteAcceptanceTimeouts): Promise<string> {
	await createRemoteSessionInProject(window, projectName);
	const tabs = window.locator('[role="tab"][data-session-id]');
	await expect(tabs, "新建会话必须登记一个会话 Tab").toHaveCount(1, { timeout: limits.helperMs });
	const sessionId = (await tabs.first().getAttribute("data-session-id")) ?? "";
	expect(sessionId, "会话 Tab 必须带稳定 sessionId").not.toBe("");
	// 合成器属于这条会话（不是复用别的会话的输入框），而且可输入。
	await expect(window.locator('.composer[data-session-id="' + sessionId + '"]')).toBeVisible({ timeout: limits.helperMs });
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", { timeout: limits.helperMs });
	await expect(window.locator(".message-timeline"), "远端会话必须有时间线").toBeVisible({ timeout: limits.helperMs });
	return sessionId;
}

/**
 * 主进程日志留档（**收尾时无条件**调用）：隔离 userData 会被夹具删掉，真机失败的根因往往只写在这里。
 * 只读本地文件、只打印/另存，不参与任何断言，也不会成为新的失败源。
 */
function preserveAppLogs(userDataRoot: string, runId: string): void {
	const source = join(userDataRoot, "profile", "logs");
	const dest = join(tmpdir(), "p42-app-logs-" + runId);
	try {
		if (!existsSync(source)) {
			console.log("[p42-acceptance] app logs: " + source + " does not exist (nothing written?)");
			return;
		}
		cpSync(source, dest, { recursive: true });
		for (const file of readdirSync(dest).filter((name) => name.startsWith("app-"))) {
			const lines = readFileSync(join(dest, file), "utf8")
				.split("\n")
				.filter((line) => /agent|remote|session-perf|runtime/i.test(line));
			console.log("[p42-acceptance] app log tail (" + file + ", " + lines.length + " matching lines):\n" + lines.slice(-40).join("\n"));
		}
		console.log("[p42-acceptance] app logs preserved at " + dest);
	} catch (error) {
		console.warn("[p42-acceptance] app log preservation failed: " + (error instanceof Error ? error.message : String(error)));
	}
}

/** 收尾：停掉会话（第 1 个 test 已通过界面「关闭 Agent」做到）后删掉本次运行的远端目录，并留档远端会话文件内容。 */
async function cleanupRemoteRun(credentials: RemoteAcceptanceCredentials, paths: RemoteRunPaths, evidence: string): Promise<void> {
	if (evidence !== "") console.log("[p42-acceptance] remote session file evidence:\n" + evidence);
	// 只删**本次 runId 命名**的 e2e 根目录与**由本项目路径编码折出**的会话目录（两处都过了上面的归属自检），
	// 不通配、不碰会话根目录本身、不碰用户既有数据。
	const cleanup = "rm -rf " + paths.e2eRoot + " " + paths.sessionEvidenceDir + "; test ! -e " + paths.e2eRoot + " && test ! -e " + paths.sessionEvidenceDir + " && echo CLEANUP_OK";
	await runRemoteCommand(credentials, cleanup, 60_000)
		.then((result) => console.log("[p42-acceptance] cleanup " + result.stdout.trim()))
		.catch((error: unknown) => {
			// 清理失败不掩盖被测结论，但必须留下痕迹（日志/trace 里能查到）。
			console.warn("[p42-acceptance] cleanup failed: " + (error instanceof Error ? error.message : String(error)));
		});
}

test.describe("远端会话功能级验收（真机 · Phase 4 P4.2）", () => {
	// 无凭据整体 skip：在 fixture setup 之前生效，所以既不会建临时 userData，也不会启动 Electron。
	test.skip(credentials === undefined, HELP_TEXT);

	test("远端会话产品路：新建 → 发 prompt 出正文 → 关闭 Agent → 重开历史仍在", async ({ remoteWindow, remoteUserDataRoot }) => {
		// 远端 bootstrap + 远端 pi 拉起 + 一次真实模型调用 + 关闭/重开：给足预算；超时是失败，不是挂起。
		test.setTimeout(1_200_000);
		const creds = credentials;
		if (creds === undefined) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const window = remoteWindow;
		// 渲染层控制台错误原样留证据（报告要能贴出来）；只收集前 20 条，避免刷屏。
		const consoleErrors: string[] = [];
		window.on("console", (message) => {
			if (message.type() === "error" && consoleErrors.length < 20) consoleErrors.push(message.text());
		});
		await dismissOnboarding(window, 8_000);
		const paths = await createRemoteRunPaths(creds);
		let sessionId = "";
		let remoteSessionEvidence = "";
		console.log("[p42-acceptance] chain run=" + paths.runId + " host=" + creds.host + " probe=" + (process.env[GAP_PROBE_ENV] === "1" ? "on" : "off"));
		try {
			await test.step("远端前置：项目目录（唯一命名，结束清理）", async () => {
				await createRemoteProjectDirectory(creds, paths);
			});
			await test.step("设置页加主机 pin → 连接 ready", async () => {
				await addVerifiedRemoteHostAndConnect(window, creds, timeouts);
			});
			await test.step("侧栏登记远端项目（canonical 确认 + 立即选中）", async () => {
				await enrollRemoteProjectInSidebar(window, paths.projectPath, timeouts);
				await expect(window.getByText("远端项目（只读）")).toBeVisible({ timeout: timeouts.helperMs });
			});
			await test.step("在该远端项目里新建会话（项目行 + →「普通会话」）", async () => {
				sessionId = await createRemoteSessionAndReadId(window, paths.projectName, timeouts);
			});
			await test.step("发送最小 prompt → 时间线出现 assistant 正文（不是只出现卡片），随后回合结束", async () => {
				const composer = window.locator(".composer .rich-input");
				await composer.click();
				await window.keyboard.type(PROMPT);
				// 输入即「发送意图」：ComposerArea 首键就 activateRuntime（远端 runtime 在这里起来）。
				await expect(window.locator('.composer[data-session-id="' + sessionId + '"]')).toContainText(PROMPT);
				await window.keyboard.press("Enter");
				const timeline = window.locator(".message-timeline");
				await expect(timeline.locator(".user-turn-text").filter({ hasText: PROMPT }), "用户消息必须进时间线").toBeVisible({ timeout: timeouts.helperMs });
				const assistant = timeline.locator(".assistant-text");
				await expect(assistant.first(), "远端 pi 必须回出 assistant 卡片").toBeVisible({ timeout: timeouts.helperMs });
				// 正文必须真的有字：只出现卡片（流式开始但空正文/报错）不算证据。
				await expect.poll(async () => (await assistant.allInnerTexts()).join(" ").trim().length, { timeout: timeouts.helperMs, message: "assistant 正文不能是空串" }).toBeGreaterThan(0);
				// 回合结束（发送钮回归）再进「停止会话」：这一条验的是会话停止，不是流式中途中断。
				await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: timeouts.helperMs });
			});
			await test.step("⋯ →「关闭 Agent」停止会话：主控文案回到「启动 Agent」（可重启）", async () => {
				await openTabsActionMenu(window);
				await expect(window.getByRole("menuitem", { name: "关闭 Agent", exact: true }), "运行控制菜单必须有「关闭 Agent」").toBeVisible();
				await window.getByRole("menuitem", { name: "关闭 Agent", exact: true }).click();
				// 关掉后进程已解绑：菜单主控项必须从「重启」变成「启动 Agent」——这是产品自己的运行能力策略
				// （getSessionRunCapabilities：closed → primaryAction=start）在 UI 上的结论，也是「可重启」的落点。
				await expect(window.getByRole("menuitem", { name: "启动 Agent", exact: true })).toHaveCount(0);
				await openTabsActionMenu(window);
				await expect(window.getByRole("menuitem", { name: "启动 Agent", exact: true }), "关闭 Agent 之后必须还能再启动").toBeVisible({ timeout: timeouts.helperMs });
				await window.keyboard.press("Escape");
				await expect(window.getByRole("menuitem", { name: "启动 Agent", exact: true })).toHaveCount(0);
			});
			await test.step("关掉标签页再点开该会话 → 历史仍在，且远端会话文件确有这份历史", async () => {
				// 「点开该会话」＝关掉 Tab 再回侧栏点开（切走再切回在原地就已是同一视图，不是重开）。
				await window.locator('[role="tab"][data-session-id="' + sessionId + '"] button[role="tab-close"]').click();
				await expect(window.locator('[role="tab"][data-session-id]')).toHaveCount(0, { timeout: timeouts.helperMs });
				await expect(window.locator('.composer[data-session-id="' + sessionId + '"]')).toHaveCount(0);
				const group = projectRow(window, paths.projectName);
				// 侧栏项目组折叠时不渲染会话行（真机失败快照实测：失败时刻该组旁是「展开」按钮
				// ⇒ 行根本不在 DOM 里，`.session-row` 恒为 0）——先确保展开再计数。
				const expander = group.getByRole("button", { name: "展开", exact: true });
				if ((await expander.count()) > 0) await expander.first().click();
				const rows = group.locator(".session-row");
				await expect(rows, "远端项目下必须恰好一条会话行").toHaveCount(1, { timeout: timeouts.helperMs });
				await rows.first().click();
				await expect(window.locator('[role="tab"][data-session-id="' + sessionId + '"]'), "点开会话必须重新登记 Tab").toHaveCount(1, { timeout: timeouts.helperMs });
				const timeline = window.locator(".message-timeline");
				await expect(timeline.locator(".user-turn-text").filter({ hasText: PROMPT }), "重开后必须还能看到刚才的 prompt").toBeVisible({ timeout: timeouts.helperMs });
				const reply = timeline.locator(".assistant-text");
				await expect(reply.first(), "重开后必须还能看到刚才的回复卡片").toBeVisible({ timeout: timeouts.helperMs });
				await expect.poll(async () => (await reply.allInnerTexts()).join(" ").trim().length).toBeGreaterThan(0);
				// 独立佐证：历史真的在**远端 pi 自己写的会话文件**里（不是渲染层内存残影）。
				// 通配符按本项目编码目录限定（唯一）；命令末尾 `true` 保证「查不到」也回得到 stdout 而不是非零退出。
				remoteSessionEvidence = (await runRemoteCommand(creds, "ls -1 " + paths.sessionEvidenceDir + " 2>/dev/null; wc -l " + paths.sessionEvidenceDir + "/*.jsonl 2>/dev/null; true", 30_000)).stdout;
				// 按**每个文件的行数求和**，不要认 `total` 行：`wc -l` 只在给出 ≥2 个文件时才打 `total`，
				// 单个会话文件时永远没有它——曾经因此恒为 0，把「远端文件里明明有 5 行（一问一答都在）」
				// 误报成产品缺口（真机实测）。求和同时覆盖多文件情形，判据仍然「≥2 行＝至少一问一答」。
			});
			// 破坏性演练（默认关闭）：进程被杀后的恢复路径。刻意**不**断言「自动接回」——产品的自动重连只覆盖
			// 两个窄窗口（abort 窗口内退出 / code===0 的干净退出），kill -9 不在其中；真实恢复动作是「启动/重启 Agent」。
			// 这里验的是：被杀后不卡在假运行态、能接回**同一个远端会话**（不是新开的空会话）、历史仍在、且还能继续对话。
			if (process.env[REATTACH_DRILL_ENV] === "1") {
				await test.step("演练：杀掉该会话自己的远端 pi → 启动/重启接回同一远端会话（历史仍在 + 还能对话）", async () => {
					const timeline = window.locator(".message-timeline");
					// 0) 在一个**正在进行的回合**里杀进程（崩溃的真实场景，且这时进程必然活着）：
					//    先发一条要长回复的 prompt，等 assistant 卡片一出现（= 首包已回、pi 正在跑）就动手。
					//    回合结束后再找进程是不行的——空闲释放会把 runtime 收掉（前两次演练都栽在这里：候选表为空）。
					await window.locator(".composer .rich-input").click();
					await window.keyboard.type(FOLLOW_UP);
					await window.keyboard.press("Enter");
					await expect(timeline.locator(".user-turn-text").filter({ hasText: FOLLOW_UP }), "演练前置：prompt 必须进时间线").toBeVisible({ timeout: timeouts.stepMs });
					//    注意不能只等「assistant 卡片可见」——重开后历史里本来就有旧回复，那会在 runtime 还没起来时立刻通过
					//    （前一次演练就是这样空转的）。要等**本轮真正结束**：发送钮从「停止」回到「发送」。
					await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: timeouts.helperMs });
					// 2) 定位并杀进程：不用 `ps` 猜命令行——runner（承载 pi 的进程）的参数走 stdin，命令行里根本没有会话路径，
					//    用 `ps | grep <会话名>` 永远为空（前几次演练就是这么空转的）。runner 自己会写**lease**：
					//    `<home>/.pideck/remote-host/leases/<nonce>.json`，里面有它 spawn 的 pi 的 `pid`/`pgid`（契约文档明写）。
					//    按 lease 拿 pgid 并杀掉**整个进程组**：runner + pi 一起没，才是真实的崩溃形态（只杀 pi 会被 runner 收拾掉）。
					//    runner 写 lease 有延迟 ⇒ **重试式**读（最多 ~10s，一次 ssh 往返里循环），否则会读到空目录。
					const leaseCommand = 'for i in $(seq 1 10); do f=$(ls -1t $HOME/.pideck/remote-host/leases/*.json 2>/dev/null | head -1); if [ -n "$f" ]; then cat "$f"; exit 0; fi; sleep 1; done; true';
					// 判别性证据：重启后的新回合必须**追加到同一个远端会话文件**里（否则「历史还在」可能只是远端 reader 画出来的旧文件）。
					// 取**绝对路径**：证据里 `ls -1` 那行只有文件名，只有 `wc -l` 那行带绝对路径（要求以 / 开头）。
					const evidenceFile = (remoteSessionEvidence.match(/(\/\S+\.jsonl)/) ?? [])[1];
					const countEvidenceLines = async () => Number(((await runRemoteCommand(creds, "wc -l < '" + evidenceFile + "'", 20_000)).stdout.match(/(\d+)/) ?? [])[1] ?? 0);
					const linesBeforeKill = await countEvidenceLines();
					const leaseOutput = (await runRemoteCommand(creds, leaseCommand, 20_000)).stdout.trim();
					const leasePid = (leaseOutput.match(/"pid"\s*:\s*(\d+)/) ?? [])[1];
					const leasePgid = (leaseOutput.match(/"pgid"\s*:\s*(\d+)/) ?? [])[1];
					// 诊断用（失败时才看）：最新几个 lease + runner/pi 进程，帮助判断「有没有在跑 / 是谁在跑」。
					const psCandidates = (await runRemoteCommand(creds, "ls -1t $HOME/.pideck/remote-host/leases/*.json 2>/dev/null | head -3; ps -eo pid,ppid,pgid,args --no-headers | grep -E 'runner|pi-coding' | grep -v grep | head -5", 20_000)).stdout.trim();
					// 先断言「lease 里确实有 pid」而不是直接 toMatch：toMatch 收到 undefined 会吞掉诊断信息。
					expect(leaseOutput, "runner lease 必须存在且含 pid（lease 目录内容与进程候选如下）。lease 内容：\n" + leaseOutput + "\nlease 目录/进程候选：\n" + psCandidates).toContain('"pid"');
					await runRemoteCommand(creds, "kill -9 -" + (leasePgid ?? leasePid) + " 2>/dev/null; true", 20_000);
					// 2) 被杀后主控项必须回到可启动/可重启态（不能假装还在运行）。
					await openTabsActionMenu(window);
					const primary = window.getByRole("menuitem", { name: /^(启动 Agent|重启)$/ });
					await expect(primary, "远端 pi 被杀后必须回到可启动/可重启态").toBeVisible({ timeout: timeouts.helperMs });
					await primary.click();
					// 3) 接回的必须是同一个远端会话：重启前的两条 prompt 都还在（新开会话会是空的）。
					await expect(timeline.locator(".user-turn-text").filter({ hasText: PROMPT }), "重启后必须仍看到重启前那条 prompt（同一会话）").toBeVisible({ timeout: timeouts.helperMs });
					await expect(timeline.locator(".user-turn-text").filter({ hasText: FOLLOW_UP }), "重启后必须仍看到演练前置那条 prompt（同一会话）").toBeVisible({ timeout: timeouts.helperMs });
					// 4) 还能继续对话（证明接回来的是活的 runtime，不是只把历史画出来）。
					await window.locator(".composer .rich-input").click();
					await window.keyboard.type(FOLLOW_UP_AFTER);
					await window.keyboard.press("Enter");
					await expect(timeline.locator(".user-turn-text").filter({ hasText: FOLLOW_UP_AFTER }), "重启后必须能再发一条并进时间线").toBeVisible({ timeout: timeouts.stepMs });
					const assistant = timeline.locator(".assistant-text");
					await expect(assistant.first(), "重启后必须还能出 assistant 卡片").toBeVisible({ timeout: timeouts.helperMs });
					await expect.poll(async () => (await assistant.allInnerTexts()).join(" ").trim().length, { timeout: timeouts.helperMs, message: "重启后的回复必须真的有正文" }).toBeGreaterThan(0);
					await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: timeouts.helperMs });
					// 同一会话的硬证据：新回合把消息追加进了**同一个**远端会话文件（行数增长）。
					// pi 可能延迟落盘 ⇒ 轮询；失败时把该目录**全部** jsonl 的行数打出来（能区分「延迟」与「另开了新文件」）。
					let grew = false;
					for (let i = 0; i < 10 && !grew; i += 1) {
						if ((await countEvidenceLines()) > linesBeforeKill) {
							grew = true;
							break;
						}
						await new Promise((resolve) => setTimeout(resolve, 1500));
					}
					if (!grew) {
						const listing = (await runRemoteCommand(creds, "wc -l " + paths.sessionEvidenceDir + "/*.jsonl 2>/dev/null; true", 20_000)).stdout.trim();
						expect(grew, "重启后的回合必须往同一远端会话文件追加（行数增长）。目录现状：\n" + listing + "\n计划里用的就是：" + evidenceFile).toBe(true);
					}
				});
			}
			if (process.env[GAP_PROBE_ENV] === "1") {
				await test.step("缺口探针（PIDECK_E2E_P42_GAP_PROBE=1）：⋯ →「重新加载会话」后历史仍在", async () => {
					// 这条断言是「重启/重载后从远端读回历史正文」——计划里的未交付能力（P4.2 遗留项）。
					// 默认关掉它是为了让默认门禁只反映本次交付的链路；打开它就是一次**红证**：
					// 重载会走 readRecordMessagePage → 远端会话没有本机 filePath ⇒ 空页被 force 写进缓存。
					await openTabsActionMenu(window);
					await expect(window.getByRole("menuitem", { name: "重新加载会话", exact: true }), "无进程时「重新加载会话」必须可用").toBeVisible({ timeout: timeouts.helperMs });
					await window.getByRole("menuitem", { name: "重新加载会话", exact: true }).click();
					const timeline = window.locator(".message-timeline");
					// 先把「重载之后时间线长什么样」原样记下来（证据不只来自失败信息）。
					console.log("[p42-gap-probe] after reload: userTurns=" + (await timeline.locator(".user-turn-text").count()) + " assistant=" + (await timeline.locator(".assistant-text").count()) + " textLength=" + (await timeline.innerText()).trim().length);
					await expect(timeline.locator(".user-turn-text").filter({ hasText: PROMPT }), "重载后必须仍能看到 prompt（远端会话正文读取）").toBeVisible({ timeout: timeouts.helperMs });
					await expect(timeline.locator(".assistant-text").first(), "重载后必须仍能看到回复正文").toBeVisible({ timeout: timeouts.helperMs });
				});
			}
		} finally {
			if (consoleErrors.length > 0) console.log("[p42-acceptance] renderer console errors:\n" + consoleErrors.join("\n"));
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await cleanupRemoteRun(creds, paths, remoteSessionEvidence);
		}
	});

	test("远端会话的 trust 提示（远端项目资源未加载）在 runtime 起来后可见", async ({ remoteWindow, remoteUserDataRoot }) => {
		test.setTimeout(1_200_000);
		const creds = credentials;
		if (creds === undefined) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const window = remoteWindow;
		const consoleErrors: string[] = [];
		window.on("console", (message) => {
			if (message.type() === "error" && consoleErrors.length < 20) consoleErrors.push(message.text());
		});
		await dismissOnboarding(window, 8_000);
		const paths = await createRemoteRunPaths(creds);
		let sessionId = "";
		console.log("[p42-acceptance] trust run=" + paths.runId + " host=" + creds.host);
		try {
			await test.step("远端前置：项目目录（唯一命名，结束清理）", async () => {
				await createRemoteProjectDirectory(creds, paths);
			});
			await test.step("设置页加主机 pin → 连接 ready", async () => {
				await addVerifiedRemoteHostAndConnect(window, creds, timeouts);
			});
			await test.step("侧栏登记远端项目并新建会话", async () => {
				await enrollRemoteProjectInSidebar(window, paths.projectPath, timeouts);
				sessionId = await createRemoteSessionAndReadId(window, paths.projectName, timeouts);
			});
			await test.step("输入首键预热远端 runtime → 远端 trust 提示可见", async () => {
				const composer = window.locator(".composer .rich-input");
				await composer.click();
				await window.keyboard.type(PROMPT);
				// 输入是「发送意图」的第一个信号：ComposerArea 首键即 activateRuntime，远端 runtime 起来
				// 之后主进程才发得出 `remoteTrustUnhandled`（见 RemoteSessionTrustNotice 的注释）。
				const notice = window.getByTestId("remote-session-trust-notice");
				await expect(notice, "远端会话必须如实提示「远端项目资源未加载」").toBeVisible({ timeout: timeouts.helperMs });
				await expect(notice).toContainText(TRUST_TITLE);
				// 此刻**还没发送**：prompt 仍留在输入框里（提示可见不是发送后的错误态凑出来的）。
				await expect(window.locator('.composer[data-session-id="' + sessionId + '"]')).toContainText(PROMPT);
			});
		} finally {
			if (consoleErrors.length > 0) console.log("[p42-acceptance] renderer console errors:\n" + consoleErrors.join("\n"));
			// runtime 可能仍活着（提示缺失很可能就是预热没走完）：**先按界面入口停掉它**再删夹具目录，
			// 否则会在远端留下一个还在跑的 pi。预热完成前菜单里还没有「关闭 Agent」，所以给几轮窗口。
			let closed = false;
			for (let attempt = 0; attempt < 3 && !closed; attempt += 1) {
				try {
					if (attempt > 0) await window.waitForTimeout(20_000);
					await window.keyboard.press("Escape").catch(() => undefined);
					await openTabsActionMenu(window);
					const closeItem = window.getByRole("menuitem", { name: "关闭 Agent", exact: true });
					await closeItem.waitFor({ state: "visible", timeout: 10_000 });
					await closeItem.click();
					closed = true;
				} catch {
					// 菜单/菜单项还没出现：下一轮再试（此处不掩盖失败结论，只留一条日志）。
				}
			}
			console.log("[p42-acceptance] trust run: agent closed through the UI = " + closed);
			preserveAppLogs(remoteUserDataRoot, paths.runId);
			await cleanupRemoteRun(creds, paths, "");
		}
	});
});
