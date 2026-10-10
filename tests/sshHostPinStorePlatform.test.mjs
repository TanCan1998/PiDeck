import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Windows 上「添加 SSH 主机」必炸（SSH_CLIENT_UNSUPPORTED_PLATFORM）的回归锁定。
 *
 * 真机 e2e 抓到：保存主机时报 添加失败：SSH_CLIENT_UNSUPPORTED_PLATFORM，pin 弹框永不出现 ⇒ Windows
 * 用户没有远端功能入口。根因是 SshHostPinStore 的懒解析回退直接调 resolvePosixSshClient()，而它在
 * win32 必抛；更早的历史是反方向（裸调 createSshClientRuntime() 炸 Linux）。平台判断现在只允许存在
 * 于 resolveVerifiedSshClient()。
 */
const { resolveVerifiedSshClient } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");

test("windows resolves its own OpenSSH client instead of throwing", async () => {
	assert.equal(typeof resolveVerifiedSshClient, "function", "resolveVerifiedSshClient must exist as the single platform decision");
	const client = await resolveVerifiedSshClient({ platform: "win32" });
	assert.match(client.sshPath, /ssh\.exe$/i, "win32 必须解析到 ssh.exe");
	assert.equal(typeof client.run, "function");
});

test("posix still goes through the verified discovery, not a bare runtime", async () => {
	await assert.rejects(() => resolveVerifiedSshClient({ platform: "linux", candidates: ["/nonexistent/ssh"] }), /SSH_CLIENT_MISSING/);
	await assert.rejects(() => resolveVerifiedSshClient({ platform: "darwin", candidates: ["/nonexistent/ssh"] }), /SSH_CLIENT_MISSING/);
});

test("the pin store no longer hard-codes the POSIX-only resolver", () => {
	const source = readFileSync("src/main/remote/SshHostPinStore.ts", "utf8");
	assert.doesNotMatch(source, /resolvePosixSshClient/, "pin store 不得再直接调 POSIX-only 解析器");
	assert.match(source, /resolveVerifiedSshClient/);
});
