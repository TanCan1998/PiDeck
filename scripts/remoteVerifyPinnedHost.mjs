/**
 * 真机验证脚本共享的「已核验 pin」建立流程（`verify-remote-host.mjs` /
 * `verify-remote-connection-service.mjs` / `verify-remote-pi.mjs` 三处同源）。
 *
 * 三个脚本都要先做同一件事：用产品的握手路径取主机身份 → 与用户**独立核验**过的指纹逐字节比对 →
 * 把候选交回产品的 offer/answer 走完 pin → 拿到可用的 hostId。这段逻辑原先在两个脚本里各写一份，
 * 第三份拷贝就是漂移的起点——任何一处漏掉比对，那个脚本立刻退化成「连上了就算通过」，而它恰恰是
 * 给人看的真机验收工具。所以信任路径只保留这一份实现。
 *
 * `client` 由调用方传入：平台判断（Windows 自带 OpenSSH / POSIX 已验证发现）只允许留在产品的
 * `resolveVerifiedSshClient` 里，本模块不再造第二个客户端。pin 与 store 一律建在调用方给的
 * **一次性临时目录**里，绝不触碰 PiDeck 的 userData。
 */

import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";

const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { fingerprintSshHostKey, querySshDraftRoute, verifyDraftSshHost } = loadTsCommonJs("src/main/remote/SshHostVerifier.ts");

/**
 * 取候选 host key——走**产品自己的握手路径**，不是另一个工具的旁路。
 *
 * `querySshDraftRoute` 先用产品将要使用的同一个客户端把草稿路由解析成 `SshResolvedRoute`
 * （`ssh -G`，无网络 I/O）；`verifyDraftSshHost` 再按产品那份加固过的 argv 认证一次，把首见 host key
 * 写进一次性 known_hosts，返回 `SshDraftHostCandidate`。候选因此与 PiDeck 真正连接时看到的是同一客户端、
 * 同一路由、同一套选项——这正是不需要第二个工具的原因。
 *
 * 为什么不再用 `ssh-keyscan`（此前用它取候选）：那是一条**第二信任路径**，产品设计明文禁止用它替代
 * 已认证握手。它还得按客户端安装位置猜二进制——Windows 上 System32 的 keyscan 对 Ubuntu OpenSSH_8.9p1 的
 * `sntrup761x25519-sha512@openssh.com` KEX 协商失败（choose_kex），当时靠回退到 Git for Windows 自带的
 * 较新 OpenSSH 绕过。而它的输出最终只喂给下面这条逐字节断言：候选与断言同源时，额外工具不增加强度，
 * 只多一个漂移点。
 *
 * 用户传入的独立核验指纹仍是**唯一信任来源**：观测值必须与它逐字节相等，否则 fail-closed。
 */
async function observeDraftHost(route, pinAlias, client, expectedFingerprint) {
	const resolved = await querySshDraftRoute(route, pinAlias, { client });
	const candidate = await verifyDraftSshHost(route, pinAlias, { client });
	// 候选端点必须与解析出的路由一致，否则 pin 保存的元数据属于另一条路由。
	if (candidate.hostName !== resolved.hostName || candidate.user !== resolved.user || candidate.port !== resolved.port) throw new Error("HOST_ROUTE_MISMATCH");
	// 不抄 candidate.hostKeyFingerprints：从候选落盘的 known_hosts 字节重算一遍，自报字段不作数。
	const bytes = Buffer.from(candidate.knownHostsBase64, "base64");
	const observedFingerprint = fingerprintSshHostKey(bytes, pinAlias);
	if (candidate.hostKeyFingerprints.length !== 1 || candidate.hostKeyFingerprints[0] !== expectedFingerprint || observedFingerprint !== expectedFingerprint) throw new Error("HOST_FINGERPRINT_MISMATCH");
	return { bytes, candidate };
}

/**
 * 用独立核验过的指纹在 `directory` 里建一个已 pin 的主机，返回 `{ hostId, pinStore }`。
 *
 * `label` 只落进这个一次性 store（不进 userData），调用方按脚本语义取名即可。
 *
 * `HOST_HANDSHAKE_OK` 由本函数打印，是三个脚本共用的**稳定输出行**（真机报告按它 grep 本次握手
 * 看到的端点/路由摘要/指纹）：改这一行等于改三份真机验收记录的字段，不要为了「共享模块不该打印」
 * 而把它挪回各脚本——那正是三份拷贝开始漂移的地方。
 */
export async function pinVerifiedHost({ directory, client, host, user, fingerprint, label }) {
	const pinStore = new SshHostPinStore(directory, { client });
	try {
		const store = await RemoteHostStore.open(directory, { pinStore });
		const profile = await store.createDraft({ label, sshHost: host, user, port: 22, connectTimeoutMs: 10_000 }, 0);
		const alias = `pideck-${profile.id}`;
		const observed = await observeDraftHost({ sshHost: host, user, port: 22 }, alias, client, fingerprint);
		console.log("HOST_HANDSHAKE_OK", "HOST", `${observed.candidate.hostName}:${observed.candidate.port}`, "USER", observed.candidate.user, "DIGEST", observed.candidate.routeDigest.slice(0, 12), "FP", observed.candidate.hostKeyFingerprints[0]);
		// 把候选字节作为预核验值交回产品：offer/answer 会用 StrictHostKeyChecking=yes 重认证并断言字节相等，
		// 因此「独立指纹」不只是脚本的断言，也进了产品自己的 fail-closed 路径。
		const offer = await store.offerPin(profile.id, 1, 1, { knownHostsBytes: observed.bytes, fingerprint });
		if (offer.hostKeyFingerprints.length !== 1 || offer.hostKeyFingerprints[0] !== fingerprint) throw new Error("HOST_OFFER_MISMATCH");
		await store.confirmPin({ requestId: offer.requestId, hostId: profile.id, senderId: 1, choice: "approve" }, 1);
		return { hostId: profile.id, pinStore };
	} catch (error) {
		// 半途失败时 pinStore 不会回到调用方手里，必须在这里释放（临时目录随后会被删，但目录锁/句柄
		// 该在本函数自己的生命周期内收口）。
		pinStore.dispose();
		throw error;
	}
}
