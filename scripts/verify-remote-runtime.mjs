/**
 * 真机端到端运行时验收（Phase 4 P4.2 的 Agent 通路）：`docs/remote-phase4-plan.md` §7「P4.2 最小端到端会话」
 * 那条验收 —— 「prompt → 至少一个 assistant 事件 → abort → restart 后历史仍在」+「runner 回收后 ps 无残留
 * pi 进程组」—— 在**真实主机**上跑一遍。
 *
 * 为什么必须有这个脚本：冻结 runner 只在远端存在，进程组与 lease 是**远端事实**，单测里的替身证明不了；
 * 而「远端 pi 真的能起来并回一个模型答案」这件事，仓库里到今天为止没有任何证据（计划 §6.1 第 1 条）。
 *
 * 流程与输出（每步一行、机器可读；失败一律打印稳定码本身并 exit 1）：
 *
 *   HOST_HANDSHAKE_OK   共享 pin 模块（`./remoteVerifyPinnedHost.mjs`）打印：只有与用户**独立核验**过的
 *                       指纹逐字节相等才建 pin，脚本自己不另开信任路径。
 *   NODE_OK             登录 shell PATH 里挑出可用 node（≥22.3 版本门在解析器内部）。
 *   BOOTSTRAP_FINALIZED 部署 helper+runner 的同一份内容寻址 bundle（写远端 `~/.pideck/remote-host`）。
 *   RUNNER_PATH         `deployedRunnerPath(result)`：远端 `runner.mjs` 的绝对路径（不自己拼路径）。
 *   PI_OK               远端 pi 定位与版本分类（用**同一个**已解析 node 探测）。
 *   RUNTIME_READY       `createSshPiRuntimeLauncher().launch(plan)` 返回：runner 的 ready 帧已确认。
 *
 * 除上面这些契约行（以及后面的 PROMPT_SENT…RUNTIME_E2E_OK）之外，本脚本另外打这几条**证据行**
 * （`LEASE_OK` / `GROUP_LIVE` / `SESSION_FILE` / `GROUP_RELEASED` / `LEASE_REMOVED`）：runner 的 lease 必须
 * 已经落盘（ready 的前提），它给出本次运行的进程组；「组在停之前确有成员」是「停之后无残留」这句话的
 * **正对照**，没有它，空断言恒真。
 *
 *   LEASE_OK            `<leasePath> pid=<n> pgid=<n> runtime=<primary|restart>`
 *   GROUP_LIVE          `pgid=<n> groups=<n> runtime=<…>`
 *
 *   SESSION_FILE        pi 自己报的会话文件（必须落在远端 `~/.pi/agent/sessions/` 之下）。
 *   PROMPT_SENT         pi 接受 prompt（`{type:"prompt",message}` 响应 success）。
 *   ASSISTANT_EVENT     第一个带**非空内容**的 assistant 事件（正文/思考的 delta 或分段终态，取事件名）。
 *                       只证明「模型真的回东西」；顶层 message_start/message_end/agent_end 单独出现只能证明
 *                       RPC 通路活着（模型报错时同样会有 message_end），空正文的 text_start 也不算证据
 *                       ⇒ 判 `ASSISTANT_EVENT_UNCONFIRMED`（宁可如实失败，不把空回复/报错写成「收到事件」）。
 *   ABORT_OK            `{type:"abort"}` 响应成功。
 *   RUNTIME_STOPPED     会话停止（ssh 结束 ⇒ runner 回收进程组）。
 *   GROUP_RELEASED      只按**本次 lease 的 pgid** 判定该进程组已无成员（按 pgid 判定才不会误伤用户自己
 *                       的 pi 进程；判定与「远端 pi 路径 + --mode rpc」无关，因此不受其它会话影响）。
 *   LEASE_REMOVED       lease 文件已删除（runner 只在确认整组回收之后才删）。
 *   RESTART_OK          带 `--session <file>` 重新拉起：pi 报回同一会话文件，且该文件里仍有历史。
 *                       `history=<message 条目数>`（≥2：用户 + 助手），`lines=<JSONL 行数>` 带上元条目供人读。
 *   CLEANUP_OK          本次会话文件已删除并断言已删；bundle 内容寻址，保留。
 *   RUNTIME_E2E_OK      全部通过（exit 0）。
 *
 * 成本与边界：
 * - 只发一条「只回复 pong」的 prompt ⇒ **消耗一次真实模型调用**（不问工具、不改远端文件）。
 * - 总预算 5 分钟；每条远端命令都走 pinned ssh（客户端自带 30s 超时与 256 KiB 输出上限），回收等待按
 *   runner 自己的宽限（SIGTERM 5s + SIGKILL 确认 2s）留余量。
 * - 远端只出现三类有界**只读**短命令（`cat <lease>`、`ps -eo pgid= | sort -n -u`、`grep -c … <sessionFile>;
 *   wc -l < <sessionFile>`）与一条清理命令（`rm -f <sessionFile>; test ! -e <sessionFile>`）；不碰 pi 的凭据，
 *   不开第二条通道。
 * - pin、profile 与全部脚本状态建在 `mkdtemp` 的一次性目录里，结束时删除；**绝不触碰生产 userData**。
 *   远端只留下内容寻址的 bundle（与其它运行共享，保留），本次 pi 会话文件在脚本结束时删除并断言已删。
 *
 * 用法：node scripts/verify-remote-runtime.mjs <IPv4> <user> <independently-verified-ED25519-SHA256-fingerprint>
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";
import { pinVerifiedHost } from "./remoteVerifyPinnedHost.mjs";

const { resolveVerifiedSshClient } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");
const { quotePosixArgument, REMOTE_BOOTSTRAP_DEPLOY_ROOT_SEGMENTS } = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");
const { buildPinnedSshInvocation } = loadTsCommonJs("src/main/remote/SshVerifiedConnection.ts");
const { bootstrapPinnedHost, resolveRemoteNodeExecutable } = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts");
const { createSshProcessLauncher } = loadTsCommonJs("src/main/remote/SshProcessLauncher.ts");
const { classifyRemotePiVersion, resolveRemotePiExecutable } = loadTsCommonJs("src/main/remote/RemotePiDiscovery.ts");
const { deployedRunnerPath } = loadTsCommonJs("src/main/remote/RemoteBootstrapDeployment.ts");
const { REMOTE_RUNNER_LEASE_DIRECTORY_SEGMENTS, REMOTE_RUNNER_LEASE_VERSION } = loadTsCommonJs("src/main/remote/RemoteRunnerContract.ts");
const { buildRemotePiRuntimePlan } = loadTsCommonJs("src/main/pi/piRemoteRuntimePlan.ts");
const { createSshPiRuntimeLauncher } = loadTsCommonJs("src/main/remote/SshPiRuntimeLauncher.ts");
const { PiRpcClient } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");

const USAGE = "Usage: node scripts/verify-remote-runtime.mjs <IPv4> <user> <independently-verified-ED25519-SHA256-fingerprint>";

/** 稳定码形状：产品的 `diagnosticCodeFromError` 只承认「消息**就是**码」，本脚本沿用同一判据。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]*$/;
/** 参数校验与既有真机脚本逐字同款（`verify-remote-host.mjs` / `verify-remote-pi.mjs`）。 */
const HOST_INPUT = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const USER_INPUT = /^[a-z_][a-z0-9_-]*$/;
const FINGERPRINT_INPUT = /^SHA256:[A-Za-z0-9+/]{43}$/;

const TOTAL_BUDGET_MS = 5 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const PROMPT_ACCEPT_TIMEOUT_MS = 120_000;
const ASSISTANT_EVENT_TIMEOUT_MS = 120_000;
const ABORT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 60_000;
/** 回收预算：runner 的宽限是 5s + 2s 确认（`RemoteRunnerContract`），这里留足余量后必须**如实失败**。 */
const RECLAIM_TIMEOUT_MS = 60_000;
const RECLAIM_POLL_MS = 1_000;

/** 回收探针里区分「lease 还在」与「lease 已删」的标记（退出码由最后的 echo 决定，恒为 0）。 */
const LEASE_PRESENT_MARKER = "PIDECK_LEASE_PRESENT";
const LEASE_ABSENT_MARKER = "PIDECK_LEASE_ABSENT";

/**
 * 远端 cwd（P4.2 的最小远端会话只需要一个存在的、没有项目级 pi 资源的目录）：
 * - 必须是远端绝对 POSIX 路径（`buildRemotePiRuntimePlan` 的形状门），且必须存在（runner 用它当 spawn cwd）；
 * - **不能是远端 HOME**：`$HOME/.pi` 就在 HOME 下，而 pi 会把「含 `.pi/settings.json`/`extensions`/`skills`
 *   的目录及其祖先」当成需要信任决策的项目；真机 `defaultProjectTrust: "ask"` 且 RPC 无 UI ⇒ 会被判为
 *   不信任，测到的东西就不是目标行为了；
 * - `/tmp` 在真机上已存在、且没有 `.pi/settings.json`、`.pi/extensions`、`.pi/skills`、`/.agents/skills`
 *   这些信任资源，因此 pi 直接按「干净项目」放行，脚本不需要额外的 mkdir/清理写入。
 */
const REMOTE_CWD = "/tmp";
const PROMPT_TEXT = "只回复 pong";
/** pi 的会话文件根（远端 HOME 下）：清理前必须确认 pi 报的文件确实落在这里。 */
const SESSION_ROOT_SEGMENTS = [".pi", "agent", "sessions"];

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 稳定码 + 关键上下文：上下文一律以独立 `key=value` 尾巴打印，绝不拼进码里。 */
function stableFailure(code, fields = []) {
	const error = new Error(code);
	error.fields = fields;
	return error;
}

/** 上下文一律单行、有界——远端回显可能带换行与超长文本。 */
function boundedField(value, limit = 200) {
	return String(value).replace(/[\s]+/g, " ").trim().slice(0, limit);
}

/** 产品稳定码的失败细节挂在错误属性上（`nodePath`/`piPath`/`observedVersion`/`probed`），非消息内。 */
function errorFields(error) {
	const fields = [];
	if (typeof error?.nodePath === "string") fields.push(`nodePath=${boundedField(error.nodePath)}`);
	if (typeof error?.piPath === "string") fields.push(`piPath=${boundedField(error.piPath)}`);
	if (typeof error?.observedVersion === "string") fields.push(`observedVersion=${boundedField(error.observedVersion)}`);
	if (Number.isSafeInteger(error?.probed)) fields.push(`probed=${error.probed}`);
	for (const field of Array.isArray(error?.fields) ? error.fields : []) fields.push(field);
	return fields;
}

/**
 * 稳定码失败：打印码本身（首 token 必须是码）与细节，exit 1。
 * 非稳定码（脚本自身的 bug）原样抛出：不伪造成稳定结论，栈比一句码有用。
 */
function reportFailure(error) {
	const code = typeof error?.message === "string" && STABLE_CODE.test(error.message) ? error.message : "";
	if (code === "") throw error;
	process.exitCode = 1;
	console.error(code, ...errorFields(error));
	if (code === "SMOKE_INPUT_INVALID") console.error(USAGE);
}

/** finally 里的失败不能盖掉主错误，但同样必须被看见。 */
function reportSecondaryFailure(error) {
	const code = typeof error?.message === "string" && STABLE_CODE.test(error.message) ? error.message : "RUNTIME_CLEANUP_FAILED";
	process.exitCode = 1;
	console.error(code, ...errorFields(error));
}

/** 有界等待：超时按稳定码失败，绝不让任一步无限挂住整个脚本。 */
async function withDeadline(promise, timeoutMs, code) {
	void Promise.resolve(promise).catch(() => undefined); // 主流程可能已经离开：不要变成未处理拒绝
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(stableFailure(code, [`timeoutMs=${timeoutMs}`])), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** 一条 pinned、有界的远端命令（`ssh-batch` 档：无 stdin，字节与时长上限都由 ssh 客户端兜住）。 */
async function runPinnedCommand(context, remoteCommand) {
	const invocation = await buildPinnedSshInvocation(context.directory, context.hostId, "ssh-batch", { client: context.client, remoteCommand });
	return context.client.run(invocation.executable, invocation.args);
}

/** `<home>/.pideck/remote-host` ⇒ `<home>`：deployRoot 是远端自己按 HOME 解析出来的，不再单独探 HOME。 */
function remoteHomeFromDeployRoot(deployRoot) {
	const suffix = `/${REMOTE_BOOTSTRAP_DEPLOY_ROOT_SEGMENTS.join("/")}`;
	if (typeof deployRoot !== "string" || !deployRoot.startsWith("/") || deployRoot.length <= suffix.length || !deployRoot.endsWith(suffix)) throw stableFailure("RUNTIME_DEPLOY_ROOT_INVALID", [`deployRoot=${boundedField(deployRoot)}`]);
	return deployRoot.slice(0, -suffix.length);
}

/** lease 路径规则与冻结 runner 同源（`REMOTE_RUNNER_LEASE_DIRECTORY_SEGMENTS` + nonce 文件名）。 */
function runnerLeasePath(home, nonce) {
	return [home, ...REMOTE_RUNNER_LEASE_DIRECTORY_SEGMENTS, `${nonce}.json`].join("/");
}

/**
 * 读 runner 的 lease：`ready` 的前提就是 lease 已经持久化，所以这里**必须**读得到，且 nonce 必须是本次的。
 *
 * 字段按冻结 runner 的形状核对（`RemoteRunnerContract` 的 lease 布局：`{v,nonce,pid,pgid,startedAt,
 * command,args}`；`pgid === pid` 由 `detached: true` 保证）。之所以从 lease 取进程组而不是从 ready 帧取：
 * 启动器把 ready 帧消费在内部（`SshPiRuntimeLauncher`），而 lease 正是产品为「之后的对账」留下的那份证据。
 */
async function readRunnerLease(context, nonce, leasePath) {
	const result = await runPinnedCommand(context, `cat ${quotePosixArgument(leasePath)}`);
	if (result.exitCode !== 0) throw stableFailure("RUNNER_LEASE_MISSING", [`leasePath=${leasePath}`, `exitCode=${result.exitCode}`]);
	let lease;
	try {
		lease = JSON.parse(result.stdout);
	} catch {
		throw stableFailure("RUNNER_LEASE_UNREADABLE", [`leasePath=${leasePath}`, `bytes=${Buffer.byteLength(result.stdout, "utf8")}`]);
	}
	if (lease === null || typeof lease !== "object" || lease.v !== REMOTE_RUNNER_LEASE_VERSION || lease.nonce !== nonce || !Number.isSafeInteger(lease.pid) || lease.pid < 2 || lease.pgid !== lease.pid || typeof lease.startedAt !== "string")
		throw stableFailure("RUNNER_LEASE_INVALID", [`leasePath=${leasePath}`, `observed=${boundedField(result.stdout, 120)}`]);
	return { pid: lease.pid, pgid: lease.pgid };
}

/**
 * 一条有界只读命令回答两个问题：这台主机上现存的进程组（按 pgid 去重）与本次 lease 是否还在。
 *
 * 判定只按**本次 lease 的 pgid**：用户自己的 pi 进程在别的进程组里，因此不会被误算成残留。
 * 「组列表非空」是这条命令自证可用的正对照（任何活着的会话都至少有一个进程组，包括跑这条命令的 ssh）。
 */
async function probeGroupsAndLease(context, leasePath) {
	const command = `ps -eo pgid= | sort -n -u; test -e ${quotePosixArgument(leasePath)} && echo ${LEASE_PRESENT_MARKER} || echo ${LEASE_ABSENT_MARKER}`;
	const result = await runPinnedCommand(context, command);
	if (result.exitCode !== 0) throw stableFailure("REMOTE_PROCESS_PROBE_FAILED", [`exitCode=${result.exitCode}`, `stderr=${boundedField(result.stderr ?? "")}`]);
	const groups = new Set();
	let leasePresent;
	for (const rawLine of String(result.stdout).split("\n")) {
		const line = rawLine.trim();
		if (line === LEASE_PRESENT_MARKER) {
			leasePresent = true;
			continue;
		}
		if (line === LEASE_ABSENT_MARKER) {
			leasePresent = false;
			continue;
		}
		const value = Number(line);
		if (line !== "" && Number.isSafeInteger(value) && value > 0) groups.add(value);
	}
	if (leasePresent === undefined || groups.size === 0) throw stableFailure("REMOTE_PROCESS_PROBE_UNREADABLE", [`bytes=${Buffer.byteLength(String(result.stdout), "utf8")}`, `leaseMarked=${leasePresent !== undefined}`]);
	return { groups, leasePresent };
}

/** 停之前：组里确实有成员（否则「无残留」是恒真的空断言）。 */
async function assertGroupLive(context, leasePath, pgid, label) {
	const { groups, leasePresent } = await probeGroupsAndLease(context, leasePath);
	if (!groups.has(pgid)) throw stableFailure("RUNNER_GROUP_NOT_LIVE", [`pgid=${pgid}`, `runtime=${label}`, `groups=${groups.size}`]);
	if (!leasePresent) throw stableFailure("RUNNER_LEASE_MISSING", [`leasePath=${leasePath}`, `runtime=${label}`]);
	console.log("GROUP_LIVE", `pgid=${pgid}`, `groups=${groups.size}`, `runtime=${label}`);
}

/** 停之后：有界轮询到「整组消失」且「lease 已删」都成立；确认不了 ⇒ 如实失败（绝不放过）。 */
async function assertGroupReclaimed(context, leasePath, pgid, label) {
	const deadlineAt = Date.now() + RECLAIM_TIMEOUT_MS;
	for (;;) {
		const { groups, leasePresent } = await probeGroupsAndLease(context, leasePath);
		if (!groups.has(pgid) && !leasePresent) break;
		if (Date.now() >= deadlineAt) throw stableFailure("RUNNER_RECLAIM_UNCONFIRMED", [`pgid=${pgid}`, `runtime=${label}`, `groupPresent=${groups.has(pgid)}`, `leasePresent=${leasePresent}`, `waitedMs=${RECLAIM_TIMEOUT_MS}`]);
		await sleep(RECLAIM_POLL_MS);
	}
	console.log("GROUP_RELEASED", `pgid=${pgid}`, `runtime=${label}`);
	console.log("LEASE_REMOVED", leasePath, `runtime=${label}`);
}

/**
 * 等第一个带非空内容的 assistant 事件。
 *
 * 帧形状照抄 `AgentManager.handlePiEvent` / `handleAssistantMessageEvent`：顶层 `message_start`/`message_end`
 * 的 `message.role === "assistant"`，以及 `message_update` 的 `assistantMessageEvent.type`
 * （`text_delta` / `thinking_delta` / `text_end` / `thinking_end` / `done` / `error`）。
 *
 * 判据是**非空内容**，不是事件名：`text_start` 这类分段开始事件在正文为空时同样会出现，一个只有骨架的空
 * 回复不该被写成「收到 assistant 事件」。所以 delta 必须带非空 `delta`，分段终态与助手消息 `message_end`
 * 必须带非空正文；助手消息报错（缺认证/模型拒绝）判 `ASSISTANT_EVENT_ERROR`（与 AgentManager 读 agent_end
 * 时同款判据：`stopReason === "error"` 或正文里有 `type:"error"` 块）。
 */
const CONTENT_DELTA_TYPES = new Set(["text_delta", "thinking_delta"]);
const CONTENT_SEGMENT_END_TYPES = new Set(["text_end", "thinking_end"]);

/** 一次 assistant 事件里能看到的正文/思考文本：delta 事件看 `delta`，分段/消息终态看 `content`。 */
function assistantEventText(inner, event) {
	if (typeof inner?.delta === "string") return inner.delta;
	const content = inner?.content ?? event?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (typeof block !== "object" || block === null) return "";
			if (typeof block.text === "string") return block.text;
			return typeof block.thinking === "string" ? block.thinking : "";
		})
		.join("");
}

/** `content` = 成功；`error`/`terminal` = 失败；`none` = 继续等（分段开始、无关事件、RPC response 帧）。 */
function classifyAssistantEvent(event) {
	if (typeof event !== "object" || event === null) return { kind: "none" };
	const inner = typeof event.assistantMessageEvent === "object" && event.assistantMessageEvent !== null ? event.assistantMessageEvent : undefined;
	const innerType = inner !== undefined && typeof inner.type === "string" ? inner.type : undefined;
	const type = typeof event.type === "string" ? event.type : "";
	if (innerType === "error" || type === "error") return { kind: "error", detail: boundedField(JSON.stringify(inner ?? event)) };
	const message = typeof event.message === "object" && event.message !== null ? event.message : undefined;
	const role = message !== undefined && typeof message.role === "string" ? message.role : undefined;
	const text = assistantEventText(inner, event);
	if (innerType !== undefined && (CONTENT_DELTA_TYPES.has(innerType) || CONTENT_SEGMENT_END_TYPES.has(innerType))) {
		if (text.length > 0) return { kind: "content", type: innerType };
		return { kind: "none" };
	}
	if (innerType === "done") {
		if (text.length > 0) return { kind: "content", type: innerType };
		return { kind: "terminal", detail: "detail=done-without-content" };
	}
	if (type === "message_end" && role === "assistant") {
		const hasErrorBlock = Array.isArray(message.content) && message.content.some((block) => typeof block === "object" && block !== null && block.type === "error");
		const stopReason = typeof message.stopReason === "string" ? message.stopReason : "unknown";
		if (hasErrorBlock || stopReason === "error") return { kind: "error", detail: `stopReason=${stopReason}` };
		if (text.length > 0) return { kind: "content", type: "message_end" };
		return { kind: "terminal", detail: `stopReason=${stopReason}` };
	}
	return { kind: "none" };
}

function awaitAssistantEvent(client, runtime, timeoutMs) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let offExit = () => {};
		const finish = (outcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.off("event", onEvent);
			offExit();
			if (outcome.ok) resolve(outcome.type);
			else reject(outcome.error);
		};
		const timer = setTimeout(() => finish({ ok: false, error: stableFailure("ASSISTANT_EVENT_TIMEOUT", [`timeoutMs=${timeoutMs}`]) }), timeoutMs);
		const onEvent = (event) => {
			const classified = classifyAssistantEvent(event);
			if (classified.kind === "content") finish({ ok: true, type: classified.type });
			else if (classified.kind === "error") finish({ ok: false, error: stableFailure("ASSISTANT_EVENT_ERROR", [classified.detail]) });
			else if (classified.kind === "terminal") finish({ ok: false, error: stableFailure("ASSISTANT_EVENT_UNCONFIRMED", [classified.detail, "reason=no-content"]) });
		};
		client.on("event", onEvent);
		// 进程先死（例如 runner 拒收 / pi 启动即退出）时立刻失败，不要干等模型超时。
		offExit = runtime.onExit((exit) => finish({ ok: false, error: stableFailure("ASSISTANT_EVENT_UNCONFIRMED", [`reason=process-exited`, `exitCode=${exit.code ?? "none"}`, `signal=${exit.signal ?? "none"}`]) }));
	});
}

/** RPC 请求：pi 明确拒绝（success:false）与响应没到（超时/管道断）都按稳定码失败，错误文本作为上下文。 */
async function requestOk(client, command, timeoutMs, code) {
	let response;
	try {
		response = await client.request(command, timeoutMs);
	} catch (error) {
		throw stableFailure(code, [`rpc=${String(command.type)}`, `error=${boundedField(error?.message ?? error)}`]);
	}
	if (response?.success !== true) throw stableFailure(code, [`rpc=${String(command.type)}`, `piError=${boundedField(response?.error ?? "none")}`]);
	return response;
}

/** pi 自己报的会话文件必须落在远端 `~/.pi/agent/sessions/` 之下、且是 `.jsonl`，否则清理这一步会误删别人的文件。 */
function requireOwnedSessionFile(value, home) {
	const prefix = `${home}/${SESSION_ROOT_SEGMENTS.join("/")}/`;
	const segments = typeof value === "string" && value.startsWith(prefix) ? value.slice(prefix.length).split("/") : [];
	if (typeof value !== "string" || value.length === 0 || value.length > 4096 || !value.startsWith(prefix) || !value.endsWith(".jsonl") || /[\u0000-\u001f\u007f]/.test(value) || segments.some((segment) => segment === "" || segment === "." || segment === ".."))
		throw stableFailure("RUNTIME_SESSION_FILE_INVALID", [`sessionFile=${boundedField(value, 300)}`, `expectedRoot=${prefix}`]);
	return value;
}

/**
 * 一条有界只读命令取两个数：真实的 **message 条目数**（重启用它断言「历史还在」）与 JSONL 行数（含
 * `session` 头、`model_change` 之类的元条目，仅作报告用）。
 *
 * 为什么以 message 条目为准而不是行数：行数最小的合法文件也可能只有元条目，那样「历史还在」会被一个空会话
 * 满足。判据落在 pi 写进磁盘的那一行上（`"type":"message"`，真机 0.85.1 实测一次往返是 2 条 message +
 * 3 条元条目），而且与 PiDeck 自己的解析无关——会话文件是 pi 的格式，PiDeck 不替代它。
 */
async function readSessionHistory(context, sessionFile) {
	const quoted = quotePosixArgument(sessionFile);
	const result = await runPinnedCommand(context, `grep -c -E '"type"[[:space:]]*:[[:space:]]*"message"' ${quoted}; wc -l < ${quoted}`);
	const numbers = String(result.stdout)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => Number(line));
	if (result.exitCode !== 0 || numbers.length !== 2 || numbers.some((value) => !Number.isSafeInteger(value) || value < 0))
		throw stableFailure("SESSION_FILE_UNREADABLE", [`sessionFile=${sessionFile}`, `exitCode=${result.exitCode}`, `observed=${boundedField(result.stdout, 60)}`, `stderr=${boundedField(result.stderr ?? "")}`]);
	return { messages: numbers[0], lines: numbers[1] };
}

/** 删除本次会话文件并**在同一条命令里断言已删**：删不掉必须是看得见的失败，不是一句提示。 */
async function deleteSessionFile(context, sessionFile) {
	const quoted = quotePosixArgument(sessionFile);
	const result = await runPinnedCommand(context, `rm -f ${quoted}; test ! -e ${quoted}`);
	if (result.exitCode !== 0) throw stableFailure("CLEANUP_SESSION_DELETE_FAILED", [`sessionFile=${sessionFile}`, `exitCode=${result.exitCode}`, `stderr=${boundedField(result.stderr ?? "")}`]);
}

/** 停运行时并把状态清空；`stop()` 本身不 reject，超时按稳定码失败。 */
async function stopRuntime(state, timeoutMs) {
	const handle = state.runtime;
	state.runtime = null;
	await withDeadline(handle.stop("shutdown"), timeoutMs, "RUNTIME_STOP_TIMEOUT");
}

async function main(host, user, fingerprint) {
	const startedAt = Date.now();
	const deadlineAt = startedAt + TOTAL_BUDGET_MS;
	/** 每一步的等待都不许超过总预算；预算耗尽即失败（否则「有界」只是每条命令各自有界）。 */
	const budget = (cap) => {
		const left = deadlineAt - Date.now();
		if (left <= 0) throw stableFailure("RUNTIME_E2E_TIMEOUT", [`budgetMs=${TOTAL_BUDGET_MS}`, `elapsedMs=${Date.now() - startedAt}`]);
		return Math.min(left, cap);
	};
	const sentinel = () => randomBytes(16).toString("hex");
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-runtime-e2e-"));
	// 平台判断只留在 `resolveVerifiedSshClient` 里（Windows 自带 OpenSSH / POSIX 已验证发现）。
	const client = await resolveVerifiedSshClient();
	const context = { client, directory, hostId: "", home: "" };
	const state = { pinStore: undefined, runtime: null, sessionFile: null, sessionDeleted: false, directoryRemoved: false };
	try {
		// 信任路径只有一份实现：候选 → 独立指纹逐字节比对 → pin 全在共享模块里。
		const pinned = await pinVerifiedHost({ directory, client, host, user, fingerprint, label: "runtime-smoke" });
		state.pinStore = pinned.pinStore;
		context.hostId = pinned.hostId;

		const node = await resolveRemoteNodeExecutable({ userDataDir: directory, hostId: context.hostId, client, sentinel: sentinel() });
		console.log("NODE_OK", node.nodePath, node.version, `probed=${node.probed}`);

		// 部署同一份内容寻址 bundle（helper + runner）：runner 的路径只能由部署结果拼出来。
		const bundle = await bootstrapPinnedHost({ userDataDir: directory, hostId: context.hostId, generation: 1, nonce: sentinel(), nodePath: node.nodePath, client, launcher: createSshProcessLauncher() });
		console.log("BOOTSTRAP_FINALIZED", bundle.bundleSha256);
		const runnerPath = deployedRunnerPath(bundle);
		console.log("RUNNER_PATH", runnerPath);
		// deployRoot 是远端自己按 HOME 解析的 `<home>/.pideck/remote-host`：HOME 与 lease/会话目录都从它推出。
		context.home = remoteHomeFromDeployRoot(bundle.deployRoot);

		const pi = await resolveRemotePiExecutable({ userDataDir: directory, hostId: context.hostId, client, sentinel: sentinel(), nodePath: node.nodePath });
		console.log("PI_OK", pi.piPath, pi.version, `class=${classifyRemotePiVersion(pi.versionParsed)}`, `probed=${pi.probed}`, ...(pi.warning === undefined ? [] : [`warning=${pi.warning}`]));

		const launcher = createSshPiRuntimeLauncher({ userDataDir: directory, client, launcher: createSshProcessLauncher(), handshakeTimeoutMs: budget(HANDSHAKE_TIMEOUT_MS) });

		// ---- 第一次运行：新会话 → prompt → assistant 事件 → abort → 停止 ----
		const primaryNonce = sentinel();
		const primaryLeasePath = runnerLeasePath(context.home, primaryNonce);
		const primaryPlan = buildRemotePiRuntimePlan({
			hostId: context.hostId,
			generation: 1,
			remoteCwd: REMOTE_CWD,
			nodePath: node.nodePath,
			piPath: pi.piPath,
			runnerPath,
			nonce: primaryNonce,
		});
		const runtime = await launcher.launch(primaryPlan);
		state.runtime = runtime;
		console.log("RUNTIME_READY");

		const lease = await readRunnerLease(context, primaryNonce, primaryLeasePath);
		console.log("LEASE_OK", primaryLeasePath, `pid=${lease.pid}`, `pgid=${lease.pgid}`, "runtime=primary");
		await assertGroupLive(context, primaryLeasePath, lease.pgid, "primary");

		const rpc = new PiRpcClient(runtime.stdin, runtime.stdout);
		const stateResponse = await requestOk(rpc, { type: "get_state" }, budget(RPC_TIMEOUT_MS), "RUNTIME_STATE_RPC_FAILED");
		const sessionFile = requireOwnedSessionFile(stateResponse.data?.sessionFile, context.home);
		state.sessionFile = sessionFile;
		console.log("SESSION_FILE", sessionFile);

		// 监听先挂上：pi 的 prompt 响应（preflight）在「接受」时就回，assistant 事件随后流式到达。
		const assistantEvent = awaitAssistantEvent(rpc, runtime, budget(ASSISTANT_EVENT_TIMEOUT_MS));
		void assistantEvent.catch(() => undefined); // 主流程若在别处先失败，这里不许变成未处理拒绝
		await requestOk(rpc, { type: "prompt", message: PROMPT_TEXT }, budget(PROMPT_ACCEPT_TIMEOUT_MS), "PROMPT_REJECTED");
		console.log("PROMPT_SENT");
		console.log("ASSISTANT_EVENT", await assistantEvent);

		await requestOk(rpc, { type: "abort" }, budget(ABORT_TIMEOUT_MS), "ABORT_REJECTED");
		console.log("ABORT_OK");

		await stopRuntime(state, budget(STOP_TIMEOUT_MS));
		console.log("RUNTIME_STOPPED");
		await assertGroupReclaimed(context, primaryLeasePath, lease.pgid, "primary");

		// ---- 第二次运行：带 `--session` 重启，历史必须还在 ----
		const restartNonce = sentinel();
		const restartLeasePath = runnerLeasePath(context.home, restartNonce);
		const restartPlan = buildRemotePiRuntimePlan({
			hostId: context.hostId,
			generation: 2, // 重建同一个会话的运行时：generation 递增，与产品语义一致
			remoteCwd: REMOTE_CWD,
			nodePath: node.nodePath,
			piPath: pi.piPath,
			runnerPath,
			nonce: restartNonce,
			sessionFile,
		});
		const restarted = await launcher.launch(restartPlan);
		state.runtime = restarted;
		const restartLease = await readRunnerLease(context, restartNonce, restartLeasePath);
		console.log("LEASE_OK", restartLeasePath, `pid=${restartLease.pid}`, `pgid=${restartLease.pgid}`, "runtime=restart");
		await assertGroupLive(context, restartLeasePath, restartLease.pgid, "restart");

		const restartedRpc = new PiRpcClient(restarted.stdin, restarted.stdout);
		const restartedState = await requestOk(restartedRpc, { type: "get_state" }, budget(RPC_TIMEOUT_MS), "RESTART_STATE_RPC_FAILED");
		if (restartedState.data?.sessionFile !== sessionFile) throw stableFailure("RESTART_SESSION_MISMATCH", [`expected=${sessionFile}`, `observed=${boundedField(restartedState.data?.sessionFile ?? "none", 300)}`]);
		const history = await readSessionHistory(context, sessionFile);
		// 至少一条用户消息 + 一条助手消息：只数行数会被会话文件里的元条目蒙过去。
		if (history.messages < 2) throw stableFailure("RESTART_HISTORY_EMPTY", [`sessionFile=${sessionFile}`, `messages=${history.messages}`, `lines=${history.lines}`]);
		console.log("RESTART_OK", sessionFile, `history=${history.messages}`, `lines=${history.lines}`);

		await stopRuntime(state, budget(STOP_TIMEOUT_MS));
		await assertGroupReclaimed(context, restartLeasePath, restartLease.pgid, "restart");

		// ---- 清理：只删本次会话文件（bundle 内容寻址，保留） ----
		await deleteSessionFile(context, sessionFile);
		state.sessionDeleted = true;
		await rm(directory, { recursive: true, force: true });
		state.directoryRemoved = true;
		state.pinStore.dispose();
		state.pinStore = undefined;
		console.log("CLEANUP_OK");
		console.log("RUNTIME_E2E_OK");
	} finally {
		// 失败路径同样必须配对收口：先停运行时（否则远端 pi 还在写会话文件），再删会话文件，最后删本地临时目录。
		if (state.runtime !== null) {
			try {
				await stopRuntime(state, STOP_TIMEOUT_MS);
			} catch (error) {
				reportSecondaryFailure(error);
			}
		}
		if (state.sessionFile !== null && !state.sessionDeleted) {
			try {
				await deleteSessionFile(context, state.sessionFile);
				state.sessionDeleted = true;
			} catch (error) {
				reportSecondaryFailure(error);
			}
		}
		state.pinStore?.dispose();
		if (!state.directoryRemoved) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}

const [host, user, fingerprint] = process.argv.slice(2);
try {
	if (process.argv.length !== 5 || !HOST_INPUT.test(host ?? "") || !USER_INPUT.test(user ?? "") || !FINGERPRINT_INPUT.test(fingerprint ?? "")) throw stableFailure("SMOKE_INPUT_INVALID");
	await main(host, user, fingerprint);
} catch (error) {
	reportFailure(error);
}
