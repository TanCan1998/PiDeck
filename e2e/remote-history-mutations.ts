import { expect, type Page, type TestInfo } from "@playwright/test";
import { assertRemoteMutationMatchesLocal, effectiveHistoryMessages, freshRemoteTurn, historyEntries, historyMessages } from "./remoteHistoryAssertions";
import { runRemoteCommand, test, type RemoteAcceptanceCredentials } from "./remote-fixtures";

/** 仅操作当前 runId 的真实 pi 文件；所有写操作由真实界面触发，不直调 IPC 或手写远端结果。 */
export async function verifyRemoteHistoryMutations(input: { window: Page; credentials: RemoteAcceptanceCredentials; evidenceFile: string; evidenceDirectory: string; prompt: string; timeoutMs: number; testInfo: TestInfo }): Promise<void> {
	const { window, credentials, evidenceFile, evidenceDirectory, prompt, timeoutMs, testInfo } = input;
	expect(evidenceFile.startsWith(evidenceDirectory + "/") && /^[A-Za-z0-9_./:-]+$/.test(evidenceFile), "写面验收只能操作本次运行生成的文件").toBe(true);
	const timeline = window.locator(".message-timeline");
	const sessionId = await window.locator(".composer[data-session-id]").getAttribute("data-session-id");
	expect(sessionId).toBeTruthy();
	// 只读佐证也设产品同级上界；超限直接失败，不把截断字节伪装成完整 JSONL。
	const readRemote = async () => {
		const result = await runRemoteCommand(credentials, "[ \"$(wc -c < '" + evidenceFile + "')\" -le 262144 ] && base64 < '" + evidenceFile + "'", 20_000);
		return Buffer.from(result.stdout.replace(/\s/g, ""), "base64").toString("utf8");
	};
	const readMode = async () => (await runRemoteCommand(credentials, "stat -c '%a' -- '" + evidenceFile + "'", 20_000)).stdout.trim();
	// 只收紧本次测试文件；保护原始用户会话，也避免依赖远端默认 umask。
	await runRemoteCommand(credentials, "chmod 600 -- '" + evidenceFile + "'", 20_000);
	await expect.poll(readMode).toBe("600");
	const preserve = async (operation: string, before: string, after: string) => {
		await expect.poll(readMode, { message: "每种改写都必须保留0600权限" }).toBe("600");
		await testInfo.attach("remote-history-" + operation + "-before", { body: before, contentType: "application/x-ndjson" });
		await testInfo.attach("remote-history-" + operation + "-after", { body: after, contentType: "application/x-ndjson" });
	};
	const assertSameSession = async () => {
		await expect(window.locator(".composer[data-session-id]")).toHaveAttribute("data-session-id", sessionId ?? "");
	};
	// 编辑的是旧回复而不是 prompt：重发仍是最小 prompt，但旧回复拥有唯一标记，绝不能被当作新回复。
	// UTF-8 中文 + 换行 + >4096B，覆盖真实 UI 到分块写的边界，不把「英文短串成功」泛化成所有内容。
	const editedText = "远端编辑验收_BEGIN\n" + "中文分块边界 / quoted ' text \\ newline\n".repeat(100) + "远端编辑验收_END";
	let editedDocument = "";
	await test.step("远端编辑：真实 UI 保存多块中文回复，整份 JSONL 与本机编辑器逐字节一致", async () => {
		const before = await readRemote();
		const target = historyMessages(before, "assistant").at(-1);
		expect(target, "前置必须有可编辑的真实回复").toBeTruthy();
		if (!target) throw new Error("REMOTE_EDIT_TARGET_MISSING");
		expect(Buffer.byteLength(editedText, "utf8")).toBeGreaterThan(4096);
		const reply = timeline.locator(".turn-row").filter({ hasText: target.text });
		await expect(reply).toHaveCount(1);
		await reply.hover();
		await reply.getByTitle("编辑", { exact: true }).click();
		const editor = timeline.locator("textarea");
		await expect(editor).toBeVisible();
		await editor.fill(editedText);
		const startedAt = Date.now();
		await timeline.getByRole("button", { name: "保存", exact: true }).click();
		await expect(timeline.locator(".assistant-text")).toContainText("远端编辑验收_END", { timeout: timeoutMs });
		editedDocument = await readRemote();
		await preserve("edit", before, editedDocument);
		await assertRemoteMutationMatchesLocal({ before, after: editedDocument, operation: "edit", target, startedAt, newText: editedText });
		// 合并后的写面契约：编辑追加 context_edit，原文行仍是旧正文；断言必须读投影后的有效正文。
		expect(effectiveHistoryMessages(editedDocument, "assistant").find((message) => message.entryId === target.entryId)?.text).toBe(editedText);
		await expect(timeline.locator(".assistant-text")).toHaveCount(1);
		await expect(timeline.locator(".user-turn")).toHaveCount(1);
		await assertSameSession();
		console.log("[p45c-acceptance] edit: localByteParity=true bytes=" + Buffer.byteLength(editedDocument, "utf8"));
	});

	await test.step("远端并发冲突：上传期间外部追加必须保留，UI 提示重载且不自动覆盖", async () => {
		const before = editedDocument;
		// 合并后编辑只追加 context_edit：文件里 assistant 原文仍是旧正文，但时间线显示的是有效正文。
		// 冲突注入的目标必须取投影后的有效消息（entryId 相同、text 是编辑后的），否则 hover 找不到这条回复。
		const target = effectiveHistoryMessages(before, "assistant").at(-1);
		if (!target) throw new Error("REMOTE_CONFLICT_TARGET_MISSING");
		const lastId = historyEntries(before).at(-1)?.id;
		expect(typeof lastId).toBe("string");
		const externalLine = JSON.stringify({ type: "custom", id: "e2e-external-write", parentId: lastId, timestamp: new Date().toISOString(), customType: "pideck-e2e-write-conflict", data: { probe: true } }) + "\n";
		const expected = before + externalLine;
		const directory = evidenceFile.slice(0, evidenceFile.lastIndexOf("/"));
		const name = evidenceFile.slice(evidenceFile.lastIndexOf("/") + 1);
		// 一条有界远端观察命令：只在本次文件的临时上传已开始时追加，不用 sleep 猜提交时序。
		const watcherCommand =
			'i=0; while [ "$i" -lt 100 ]; do if find \'' +
			directory +
			"' -maxdepth 1 -name '." +
			name +
			".*.pideck-tmp' -print | grep -q .; then printf '%s' '" +
			Buffer.from(externalLine).toString("base64") +
			"' | base64 -d >> '" +
			evidenceFile +
			"'; printf 'REMOTE_WRITE_CONFLICT_INJECTED'; exit 0; fi; i=$((i+1)); sleep 0.2; done; exit 1";
		// 目标现在是编辑后的大段正文（context_edit 有效文本）；用稳定标记定位，避免 Markdown 换行归一导致整段不匹配。
		const reply = timeline.locator(".turn-row").filter({ hasText: "远端编辑验收_BEGIN" });
		await reply.hover();
		await reply.getByTitle("编辑", { exact: true }).click();
		// 足够多上传块让观察窗口确定可达，仍严格低于256KiB成本上界。
		await timeline.locator("textarea").fill("REMOTE_WRITE_SHOULD_NOT_APPEAR\n" + "x".repeat(192 * 1024));
		const injection = runRemoteCommand(credentials, watcherCommand, 35_000);
		const injected = await Promise.all([injection, timeline.getByRole("button", { name: "保存", exact: true }).click()]);
		expect(injected[0].stdout).toContain("REMOTE_WRITE_CONFLICT_INJECTED");
		await expect(window.getByText(/远端会话文件已被其他程序修改/)).toBeVisible({ timeout: timeoutMs });
		editedDocument = await readRemote();
		expect(editedDocument, "不允许把外部追加悄悄覆盖成自己的新回复").toBe(expected);
		expect(editedDocument).not.toContain("REMOTE_WRITE_SHOULD_NOT_APPEAR");
		await preserve("conflict", before, editedDocument);
		const leftovers = await runRemoteCommand(credentials, "find '" + directory + "' -maxdepth 1 -name '." + name + ".*.pideck-tmp' -exec stat -c '%a' -- {} +", 20_000);
		expect(leftovers.stdout.trim().split(/\s+/)).toEqual(["600"]);
		await window.locator(".session-tabs-actions").getByRole("button", { name: "更多操作" }).click();
		await window.getByRole("menuitem", { name: "重新加载会话", exact: true }).click();
		await expect(timeline.locator(".assistant-text")).toContainText("远端编辑验收_END", { timeout: timeoutMs });
		await assertSameSession();
		console.log("[p45c-acceptance] conflict: externalAppendPreserved=true reloadNotice=true privateResidual=true");
	});

	await test.step("远端重发：旧轮次全墓碑、新 entryId 真正追加到同一文件、UI 无重复", async () => {
		const before = editedDocument;
		const target = historyMessages(before, "user").find((message) => message.text === prompt);
		expect(target).toBeTruthy();
		if (!target) throw new Error("REMOTE_RESEND_TARGET_MISSING");
		const user = timeline.locator(".user-turn").filter({ hasText: prompt });
		await expect(user).toHaveCount(1);
		await user.hover();
		const startedAt = Date.now();
		await user.locator(".user-turn-actions").getByTitle("用同一条用户消息再次发送给 AI", { exact: true }).click();
		await expect(timeline.locator(".assistant-text").filter({ hasText: "远端编辑验收_BEGIN" }), "旧回复必须立即消失").toHaveCount(0, { timeout: timeoutMs });
		let after = "";
		await expect
			.poll(
				async () => {
					after = await readRemote();
					return freshRemoteTurn(before, after, prompt) !== undefined;
				},
				{ timeout: timeoutMs, intervals: [1500], message: "不能用旧回复/错误卡片冒充重发成功，必须在同一远端文件看到新 user + 新 assistant entryId" },
			)
			.toBe(true);
		await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: timeoutMs });
		after = await readRemote();
		await preserve("resend", before, after);
		await assertRemoteMutationMatchesLocal({ before, after, operation: "resend", target, startedAt });
		expect(historyMessages(after, "user").map((message) => message.text)).toEqual([prompt]);
		expect(historyMessages(after, "assistant")).toHaveLength(1);
		await expect(timeline.locator(".user-turn")).toHaveCount(1, { timeout: timeoutMs });
		await expect(timeline.locator(".assistant-text")).toHaveCount(1, { timeout: timeoutMs });
		await expect(timeline.locator(".assistant-text")).not.toHaveText("", { timeout: timeoutMs });
		await assertSameSession();
		console.log("[p45c-acceptance] resend: localByteParity=true newUserAndAssistantIds=true sameFile=true");
	});

	await test.step("远端连续删除：先删 user 并保留重挂回复，再删回复；文件与重载界面同步且无重复", async () => {
		let before = await readRemote();
		const target = historyMessages(before, "user").find((message) => message.text === prompt);
		// 回复已被编辑（context_edit）：UI 显示的是有效正文，删除目标同样取投影后的消息。
		const answer = effectiveHistoryMessages(before, "assistant").at(-1);
		expect(target).toBeTruthy();
		expect(answer).toBeTruthy();
		if (!target || !answer) throw new Error("REMOTE_DELETE_TARGET_MISSING");
		const user = timeline.locator(".user-turn").filter({ hasText: prompt });
		await user.hover();
		let startedAt = Date.now();
		await user.locator(".user-turn-actions").getByTitle("删除", { exact: true }).click();
		const dialog = window.getByRole("alertdialog");
		await expect(dialog).toBeVisible();
		// idle runtime 仍 live 时确认「先停止」；若 pi 已自动释放，则是「删除」。两者都须确认，不能跳过保护。
		await expect(dialog).toContainText(/先停止 Agent|删除后该消息将从会话中移除/);
		await dialog.getByRole("button", { name: /^(停止|删除)$/ }).click();
		let after = "";
		await expect
			.poll(
				async () => {
					after = await readRemote();
					// 删除 = 追加 context_edit(replacement:null) 把目标移出模型上下文（原文行保留）。
					return effectiveHistoryMessages(after, "user").some((message) => message.entryId === target.entryId);
				},
				{ timeout: 30_000, intervals: [500], message: "本次实时 user 确实在文件中：删除不得因临时 ID 未命中而谎报 no-op" },
			)
			.toBe(false);
		// 目标仍必须在文件里出现（追加了指向它的 context_edit），不能是「没写、只是看起来没了」。
		const removals = historyEntries(after).filter((entry) => entry.type === "context_edit" && entry.targetId === target.entryId);
		expect(removals.length, "删除必须追加指向目标条目的 context_edit").toBeGreaterThan(0);
		expect(
			removals.every((entry) => entry.replacement === null),
			"删除的 context_edit 必须是 replacement:null",
		).toBe(true);
		await preserve("delete-user", before, after);
		await assertRemoteMutationMatchesLocal({ before, after, operation: "delete", target, startedAt });
		await expect(timeline.locator(".user-turn")).toHaveCount(0, { timeout: timeoutMs });
		await expect(timeline.locator(".assistant-text")).toHaveCount(1, { timeout: timeoutMs });
		await expect(timeline.locator(".assistant-text")).toContainText(answer.text);
		expect(effectiveHistoryMessages(after, "assistant").map((message) => message.entryId)).toEqual([answer.entryId]);

		before = after;
		const remainingReply = timeline.locator(".turn-row").filter({ hasText: answer.text });
		await remainingReply.hover();
		startedAt = Date.now();
		await remainingReply.getByTitle("删除", { exact: true }).click();
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText("删除后该消息将从会话中移除");
		await dialog.getByRole("button", { name: "删除", exact: true }).click();
		await expect(timeline.locator(".assistant-text")).toHaveCount(0, { timeout: timeoutMs });
		after = await readRemote();
		await preserve("delete-assistant", before, after);
		await assertRemoteMutationMatchesLocal({ before, after, operation: "delete", target: answer, startedAt });
		expect(effectiveHistoryMessages(after, "user")).toHaveLength(0);
		expect(effectiveHistoryMessages(after, "assistant")).toHaveLength(0);
		await assertSameSession();

		await window.locator(".session-tabs-actions").getByRole("button", { name: "更多操作" }).click();
		await window.getByRole("menuitem", { name: "重新加载会话", exact: true }).click();
		await expect(timeline.locator(".user-turn")).toHaveCount(0);
		await expect(timeline.locator(".assistant-text")).toHaveCount(0);
		expect(await readRemote()).toBe(after);
		console.log("[p45c-acceptance] delete: userAndAssistantLocalByteParity=true reparentPreservedAnswer=true reloadEmpty=true");
	});
}
