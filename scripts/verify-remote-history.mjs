/**
 * 真机只读验收：远端会话历史的**有界窗口读取**。
 *
 * 证明的事只有一件——「按 ssh locator 路由到远端、用 pinned SSH 读一个有界窗口、把完整 JSONL 行投影成
 * 消息」这条链在真实主机上跑得通。它是**只读**脚本：不写远端文件、不建会话、不碰 PiDeck 的 userData
 * （pin 与 host store 都建在一次性临时目录里，结束即删）。
 *
 * 输入**只从环境变量取**（主机/用户/指纹绝不写进仓库）：
 *
 *   PIDECK_E2E_REMOTE_HOST          主机名或 IP
 *   PIDECK_E2E_REMOTE_USER          登录用户
 *   PIDECK_E2E_REMOTE_FINGERPRINT   用户在服务器控制台**独立核验**过的 SHA256:… 指纹
 *   PIDECK_E2E_REMOTE_SESSION_PATH  要读的**远端会话文件绝对路径**（读取目标；不是凭据，也不进仓库）
 *
 * 可选：`PIDECK_E2E_REMOTE_WINDOW_BYTES` 调小窗口（只能 ≤ 产品上界，用于观察翻页）。
 *
 * 输出（每步一行、机器可读；失败打印稳定码本身并 exit 1）：
 *
 *   HOST_HANDSHAKE_OK              共享 pin 模块打印：指纹逐字节相等才建 pin（脚本不另开信任路径）
 *   REMOTE_HISTORY_BOUND           本次窗口上界（字节）与传输上界，证明「有界」是可读的常量
 *   REMOTE_HISTORY_PAGE            messages=<n> lines=<n> nextBefore=<offset|none>
 *   REMOTE_HISTORY_FIRST_LAST      首末消息时间戳（ISO；没有消息时打 none）
 *   REMOTE_HISTORY_PAGE_OK         整条链成功（脚本退出码 0）
 *
 * 注意：本脚本用**诊断投影**（只保留 role/text 长度/时间戳），不复用 AgentManager 的渲染投影——脚本
 * 里没有 AgentManager，且真机脚本不该把会话正文打到终端。
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";
import { pinVerifiedHost } from "./remoteVerifyPinnedHost.mjs";

const { resolveVerifiedSshClient } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");
const { buildPinnedSshInvocation } = loadTsCommonJs("src/main/remote/SshVerifiedConnection.ts");
const { createRemoteSessionHistoryReader, REMOTE_SESSION_HISTORY_WINDOW_BYTES, REMOTE_SESSION_HISTORY_TRANSPORT_BYTES } = loadTsCommonJs("src/main/remote/RemoteSessionHistoryReader.ts");

/** 诊断投影：只保留能进终端的字段（正文一律不外打）。 */
function diagnosticProject(rawMessages, activeEntryIds) {
	return rawMessages.map((message, index) => ({
		id: `verify-${index}`,
		role: typeof message?.role === "string" ? message.role : "unknown",
		textLength: typeof message?.content === "string" ? message.content.length : 0,
		timestamp: typeof message?.timestamp === "number" ? message.timestamp : 0,
		meta: { entryId: activeEntryIds?.[index] },
	}));
}

function isoOrNone(timestamp) {
	return typeof timestamp === "number" && timestamp > 0 ? new Date(timestamp).toISOString() : "none";
}

async function main() {
	const host = process.env.PIDECK_E2E_REMOTE_HOST;
	const user = process.env.PIDECK_E2E_REMOTE_USER;
	const fingerprint = process.env.PIDECK_E2E_REMOTE_FINGERPRINT;
	const sessionPath = process.env.PIDECK_E2E_REMOTE_SESSION_PATH;
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host ?? "") && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host ?? "")) throw new Error("SMOKE_INPUT_INVALID");
	if (!/^[a-z_][a-z0-9_-]*$/.test(user ?? "") || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint ?? "")) throw new Error("SMOKE_INPUT_INVALID");
	// 绝对 POSIX 路径且不含单引号：与产品侧的判据一致（放行单引号等于允许提前闭合命令里的字面量）。
	if (typeof sessionPath !== "string" || !sessionPath.startsWith("/") || /[\u0000-\u001f\u007f']/.test(sessionPath)) throw new Error("SMOKE_INPUT_INVALID");
	const windowBytes = process.env.PIDECK_E2E_REMOTE_WINDOW_BYTES === undefined ? REMOTE_SESSION_HISTORY_WINDOW_BYTES : Math.min(Number(process.env.PIDECK_E2E_REMOTE_WINDOW_BYTES), REMOTE_SESSION_HISTORY_WINDOW_BYTES);
	if (!Number.isSafeInteger(windowBytes) || windowBytes <= 0) throw new Error("SMOKE_INPUT_INVALID");

	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-history-"));
	let pinStore;
	try {
		// 平台判断只留在 `resolveVerifiedSshClient` 里（Windows 自带 OpenSSH / POSIX 已验证发现）。
		const client = await resolveVerifiedSshClient();
		const pinned = await pinVerifiedHost({ directory, client, host, user, fingerprint, label: "remote-history" });
		pinStore = pinned.pinStore;
		const hostId = pinned.hostId;
		const reader = createRemoteSessionHistoryReader({
			transport: {
				readRemoteWindow: async ({ hostId: targetHostId, remoteCommand }) => {
					const invocation = await buildPinnedSshInvocation(directory, targetHostId, "ssh-batch", { client, remoteCommand });
					const result = await client.run(invocation.executable, invocation.args);
					return { exitCode: result.exitCode, stdout: result.stdout };
				},
			},
			project: diagnosticProject,
			windowBytes,
		});
		console.log("REMOTE_HISTORY_BOUND", "WINDOW", String(windowBytes), "TRANSPORT", String(REMOTE_SESSION_HISTORY_TRANSPORT_BYTES));
		const page = await reader.readPage({ hostId, locator: { kind: "ssh", hostId, remotePath: sessionPath } });
		const timestamps = page.messages.map((message) => message.timestamp);
		console.log("REMOTE_HISTORY_PAGE", "MESSAGES", String(page.messages.length), "NEXT_BEFORE", page.nextBefore === null ? "none" : String(page.nextBefore), "NONCE", randomBytes(4).toString("hex"));
		console.log("REMOTE_HISTORY_FIRST_LAST", "FIRST", isoOrNone(timestamps[0]), "LAST", isoOrNone(timestamps.at(-1)));
		console.log("REMOTE_HISTORY_ROLES", page.messages.map((message) => message.role).join(",") || "none");
		if (page.messages.length === 0) {
			// 空页要么是空文件（合法），要么是窗口上界内没有完整行（需要调大窗口/人工确认）。
			console.error("REMOTE_HISTORY_EMPTY_WINDOW");
		}
		console.log("REMOTE_HISTORY_PAGE_OK");
	} finally {
		pinStore?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
