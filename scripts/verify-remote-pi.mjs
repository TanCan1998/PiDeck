/**
 * 真实主机验证：远端 pi 定位与版本兼容矩阵（Phase 4 P4.1，`docs/remote-phase4-plan.md` §7）。
 *
 * 验证对象是 `RemotePiDiscovery` 的两个真机前提，它们都无法在本地证实：
 * 1. **登录 shell PATH 里能挑出 pi 候选**——非交互式 SSH 不加载 shell 初始化，真机 `serve` 上
 *    非交互 PATH 里**根本没有 pi**，只有 `~/.nvm/versions/node/v24.11.0/bin/pi` 在登录 shell 里可见。
 * 2. **pi 的版本命令必须用已解析的 node 当解释器**——`pi` 是 `#!/usr/bin/env node` shim，裸执行会落到
 *    非交互 PATH 的系统 node（真机 v12.22.9）上，在第一句 `SyntaxError: Unexpected token '?'` 就死。
 *    所以本脚本先跑 `resolveRemoteNodeExecutable` 拿到 nodePath，再把它喂给 `resolveRemotePiExecutable`，
 *    与 P4.2 的远端启动（`'<node>' '<pi>' --mode rpc …`）同形。
 *
 * **只读**：远端只跑登录 shell PATH 探测与 `'<node>' '<pi>' --version` 两类命令，不部署 helper、
 * 不调用 bootstrap、不写远端任何文件。pin 与 store 建在 `mkdtemp` 出来的一次性临时目录，绝不触碰
 * PiDeck 的 userData；退出时删除（pin 建立的理由见 `./remoteVerifyPinnedHost.mjs`）。
 *
 * 输出（沿用既有真机脚本的 FIELD 风格，机器可读、可 grep）：
 *   SSH_CLIENT <path>
 *   OPENSSH <version>
 *   NODE_OK <nodePath> <nodeVersion> probed=<n>
 *   PI_OK <piPath> <version> class=<supported|above-verified> probed=<n> [warning=REMOTE_PI_VERSION_UNVERIFIED]
 *   PI_PROBE_OK
 *
 * 失败：`PI_PROBE_FAILED <产品稳定码> piPath=… observedVersion=… probed=…`（node 侧同形，前缀
 * `NODE_PROBE_FAILED`；传输/信任/参数类失败只打印码本身）。稳定码必须单独成 token——自由文本一律作为
 * 独立 `key=value` 尾巴，绝不拼进码里；exit 1。
 *
 * 用法：node scripts/verify-remote-pi.mjs <IPv4> <user> <ED25519-SHA256-fingerprint>
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";
import { pinVerifiedHost } from "./remoteVerifyPinnedHost.mjs";

const { resolveVerifiedSshClient } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");
const { buildPinnedSshInvocation } = loadTsCommonJs("src/main/remote/SshVerifiedConnection.ts");
const { resolveRemoteNodeExecutable } = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts");
const { classifyRemotePiVersion, resolveRemotePiExecutable } = loadTsCommonJs("src/main/remote/RemotePiDiscovery.ts");

/** 稳定码形状：产品的 `diagnosticCodeFromError` 只承认「消息**就是**码」，本脚本沿用同一判据。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]*$/;

/** 细节字段：产品刻意不把它们拼进错误消息，脚本按 `key=value` 单独打印。 */
function failureDetails(error) {
	const details = [];
	if (typeof error?.nodePath === "string") details.push(`nodePath=${error.nodePath}`);
	if (typeof error?.piPath === "string") details.push(`piPath=${error.piPath}`);
	if (typeof error?.observedVersion === "string") details.push(`observedVersion=${error.observedVersion}`);
	if (Number.isSafeInteger(error?.probed)) details.push(`probed=${error.probed}`);
	return details;
}

/** 稳定码失败按域加前缀打印；非稳定码原样抛出（不伪造成稳定结论），两种情况都是 exit 1。 */
function reportFailure(error) {
	const code = typeof error?.message === "string" && STABLE_CODE.test(error.message) ? error.message : "";
	if (code === "") throw error;
	process.exitCode = 1;
	if (code.startsWith("REMOTE_PI_")) console.error("PI_PROBE_FAILED", code, ...failureDetails(error));
	else if (code.startsWith("REMOTE_NODE_")) console.error("NODE_PROBE_FAILED", code, ...failureDetails(error));
	else console.error(code);
}

async function main(host, user, fingerprint) {
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || !/^[a-z_][a-z0-9_-]*$/.test(user) || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error("SMOKE_INPUT_INVALID");
	const directory = await mkdtemp(join(tmpdir(), "pideck-pi-e2e-"));
	// 平台判断只留在 `resolveVerifiedSshClient` 里（Windows 走自带 OpenSSH，POSIX 走已验证发现）。
	const client = await resolveVerifiedSshClient();
	let pinStore;
	try {
		const pinned = await pinVerifiedHost({ directory, client, host, user, fingerprint, label: "pi-smoke" });
		pinStore = pinned.pinStore;
		// 便宜的一次 invocation：只为报告本次所用的客户端与版本（版本门与严格路由已在 pin 阶段跑过）。
		const routeInvocation = await buildPinnedSshInvocation(directory, pinned.hostId, "ssh-batch", { client });
		console.log("SSH_CLIENT", routeInvocation.executable);
		console.log("OPENSSH", routeInvocation.openSshVersion);
		// 解释器先解析：pi 的探测命令是 `'<node>' '<pi>' --version`，没有 nodePath 就没有正确的探测。
		const node = await resolveRemoteNodeExecutable({ userDataDir: directory, hostId: pinned.hostId, client, sentinel: randomBytes(16).toString("hex") });
		console.log("NODE_OK", node.nodePath, node.version, `probed=${node.probed}`);
		const pi = await resolveRemotePiExecutable({ userDataDir: directory, hostId: pinned.hostId, client, sentinel: randomBytes(16).toString("hex"), nodePath: node.nodePath });
		const fields = ["PI_OK", pi.piPath, pi.version, `class=${classifyRemotePiVersion(pi.versionParsed)}`, `probed=${pi.probed}`];
		// 高于已核验窗口是放行而不是失败，标记随 observation 一起回传，脚本原样透出。
		if (pi.warning !== undefined) fields.push(`warning=${pi.warning}`);
		console.log(...fields);
		console.log("PI_PROBE_OK");
	} finally {
		pinStore?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

const [host, user, fingerprint] = process.argv.slice(2);
if (process.argv.length !== 5) throw new Error("Usage: node scripts/verify-remote-pi.mjs <IPv4> <user> <independently-verified-ED25519-SHA256-fingerprint>");
try {
	await main(host, user, fingerprint);
} catch (error) {
	reportFailure(error);
}
