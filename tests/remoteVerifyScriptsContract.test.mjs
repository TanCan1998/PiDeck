import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 真机验证脚本的源码契约。
 *
 * 背景（交接文档遗留项）：脚本原先用 `ssh-keyscan` 取候选 host key，等于给「主机身份」开了
 * **第二条信任路径**，而产品设计明确要求候选来自产品自己的已认证握手
 * （`querySshDraftRoute` → `verifyDraftSshHost`）。keyscan 还有附带的平台坑：二进制位置得按客户端
 * 安装位置猜（Windows 上 System32 的 keyscan 对 Ubuntu OpenSSH_8.9p1 的 sntrup761x25519 KEX 协商失败，
 * 当时靠回退到 Git for Windows 的较新 OpenSSH 绕过）。
 *
 * 这里锁三件事，都只有源码级断言才能守住：
 * 1. keyscan 不得回来（含它的旧稳定码 `KEYSCAN_*`）；
 * 2. 指纹比对不得被删掉——脚本是给人跑的真机验收工具，少掉 `fingerprintSshHostKey` 的逐字节断言
 *    就退化成「连上了就算通过」；
 * 3. **信任路径只有一份实现**：这段「取候选 → 比对独立指纹 → 建 pin」现在住在
 *    `scripts/remoteVerifyPinnedHost.mjs`，各脚本只能经它进入，不得自己再抄一份
 *    （第三份拷贝正是漂移的起点：漏掉比对的脚本照样会「握手成功」）。
 *
 * 集合里每一份都必须逐个过同款断言：新增真机脚本要把名字加进 `scriptNames`，而不是另写一份更松的守卫
 * ——只覆盖一部分脚本的守卫，漏掉的那个脚本就是唯一可以退化的那个。（`verify-remote-runtime.mjs`
 * 部署 bundle 并起远端 pi，它是这批里唯一会写远端文件的脚本，更不允许有自己的信任路径。）
 * 用例不依赖真实主机、不执行脚本（真机部分由人工在宿主终端跑）。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_MODULE = "scripts/remoteVerifyPinnedHost.mjs";
const scriptNames = ["scripts/verify-remote-host.mjs", "scripts/verify-remote-connection-service.mjs", "scripts/verify-remote-pi.mjs", "scripts/verify-remote-runtime.mjs", "scripts/verify-remote-history.mjs"];

// 空白/连字符容忍：注释或字符串里写成 "ssh-keyscan" / "ssh - keyscan" / "sshkeyscan" 都算命中。
// 定位代码块一律用正则，不硬编码缩进（改一次格式化不该让契约测试整组失败）。
const KEYSCAN_BINARY = /ssh[\s_-]*keyscan/i;
const KEYSCAN_CODE = /KEYSCAN_[A-Z_]+/;

function scriptSource(name) {
	return readFileSync(join(repoRoot, name), "utf8");
}

/**
 * 去掉注释后只剩可执行代码。
 *
 * 必须这么做：脚本注释里**应该**提到 keyscan（记录「为什么不再需要它」），断言关键词整体不存在会直接
 * 和注释要求冲突；要禁掉的是真的去调它，不是提到它。字符串字面量保留——路径类字面量同样能构成调用。
 */
function stripComments(source) {
	let code = "";
	let inBlockComment = false;
	let quote = null;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];
		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote !== null) {
			code += char;
			if (char === "\\") {
				code += next ?? "";
				index += 1;
			} else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			code += char;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlockComment = true;
			index += 1;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") index += 1;
			code += "\n";
			continue;
		}
		code += char;
	}
	return code;
}

test(`${SHARED_MODULE} takes its host-key candidate from the product handshake, not ssh-keyscan`, () => {
	const code = stripComments(scriptSource(SHARED_MODULE));
	assert.doesNotMatch(code, KEYSCAN_BINARY, `no ssh-keyscan invocation may remain in ${SHARED_MODULE}`);
	assert.doesNotMatch(code, KEYSCAN_CODE, `the old keyscan failure codes must be gone from ${SHARED_MODULE}`);
	// 候选必须来自产品自己的两个入口：解析路由 → 已认证握手。
	assert.match(code, /querySshDraftRoute\s*\(/, `${SHARED_MODULE} must resolve the draft route through the product helper`);
	assert.match(code, /verifyDraftSshHost\s*\(/, `${SHARED_MODULE} must observe the candidate through the product's authenticated handshake`);
});

test(`${SHARED_MODULE} still fails closed on the independently verified fingerprint`, () => {
	const code = stripComments(scriptSource(SHARED_MODULE));
	// 用户传入的独立指纹是唯一信任来源：必须自己重算指纹并逐字节比对，不能只信候选自报字段。
	assert.match(code, /fingerprintSshHostKey\s*\(/, `${SHARED_MODULE} must recompute the observed fingerprint from the candidate bytes`);
	assert.match(code, /HOST_FINGERPRINT_MISMATCH/, `${SHARED_MODULE} must keep a fail-closed mismatch code`);
	// 重算结果必须真的参与比较（否则调用只是摆设）。
	assert.match(code, /observedFingerprint\s*!==\s*\w+/, `${SHARED_MODULE} must compare the recomputed fingerprint, not merely compute it`);
	// 候选交回产品的 offer 也必须复核指纹：pin 阶段是第二道 fail-closed 门，不能只留脚本自己那道。
	assert.match(code, /HOST_OFFER_MISMATCH/, `${SHARED_MODULE} must keep the offer-stage fingerprint check`);
});

test("every verify script reaches the verified pin through the shared module instead of its own copy", () => {
	assert.ok(scriptNames.includes("scripts/verify-remote-runtime.mjs"), "the P4.2 runtime acceptance script must be covered by these guards");
	for (const name of scriptNames) {
		const code = stripComments(scriptSource(name));
		// keyscan 不得回来（含它的旧稳定码）——这条与改动前逐字一致。
		assert.doesNotMatch(code, KEYSCAN_BINARY, `no ssh-keyscan invocation may remain in ${name}`);
		assert.doesNotMatch(code, KEYSCAN_CODE, `the old keyscan failure codes must be gone from ${name}`);
		// 必须真的走共享模块，而不只是 import 一行。
		assert.match(code, /from\s+["']\.\/remoteVerifyPinnedHost\.mjs["']/, `${name} must import the shared verified-pin module`);
		assert.match(code, /pinVerifiedHost\s*\(/, `${name} must build its pin through the shared module`);
		// 不得自己造第二条信任路径：握手、指纹重算、比对码、以及那条路径的模块都只允许出现在共享模块里。
		assert.doesNotMatch(code, /SshHostVerifier/, `${name} must not import the host-verifier modules directly`);
		assert.doesNotMatch(code, /querySshDraftRoute\s*\(/, `${name} must not resolve the draft route itself`);
		assert.doesNotMatch(code, /verifyDraftSshHost\s*\(/, `${name} must not run its own authenticated handshake`);
		assert.doesNotMatch(code, /fingerprintSshHostKey\s*\(/, `${name} must not recompute the fingerprint itself`);
		assert.doesNotMatch(code, /HOST_FINGERPRINT_MISMATCH/, `${name} must not handle the mismatch locally`);
	}
});

test("the verify scripts keep using the cross-platform SSH client entry point", () => {
	// 平台判断只允许留在 `resolveVerifiedSshClient` 里：脚本自己分支过一次，就产生过
	// 「Linux 加主机失败 / Windows 抛 SSH_CLIENT_SCRIPT_SHIM」这一类平台缺口。
	for (const name of scriptNames) {
		const code = stripComments(scriptSource(name));
		assert.match(code, /resolveVerifiedSshClient\s*\(/, `${name} must resolve the client through the shared entry point`);
		assert.doesNotMatch(code, /createSshClientRuntime\s*\(/, `${name} must not build a second, platform-branching client of its own`);
	}
	// 共享模块只消费调用方传来的 client，同样不得自己造客户端。
	assert.doesNotMatch(stripComments(scriptSource(SHARED_MODULE)), /createSshClientRuntime\s*\(/, `${SHARED_MODULE} must take the caller's client instead of building its own`);
});
