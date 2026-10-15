import assert from "node:assert/strict";
import { constants, readFileSync } from "node:fs";
import { win32 } from "node:path";
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

/** Model Windows path/filesystem contracts explicitly; Linux CI must not require a real System32 tree. */
function windowsResolver(missingScp = false) {
	const opened = [],
		closed = [];
	const ssh = "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
		scp = "C:\\Windows\\System32\\OpenSSH\\scp.exe";
	const exists = (path) => {
		if ((path !== ssh && path !== scp) || (missingScp && path === scp)) throw new Error("ENOENT");
	};
	const loaded = loadTsCommonJs("src/main/remote/SshClientRuntime.ts", {
		stubs: {
			"node:path": win32,
			"node:fs": {
				constants,
				lstatSync: (path) => {
					exists(path);
					return { isFile: () => true, isSymbolicLink: () => false };
				},
				openSync: (path) => {
					exists(path);
					opened.push(path);
					return opened.length;
				},
				closeSync: (fd) => closed.push(fd),
			},
		},
	});
	return { resolve: loaded.resolveVerifiedSshClient, opened, closed, ssh, scp };
}

test("Windows resolver selects and validates its own OpenSSH pair (simulated Windows filesystem, not native execution)", async () => {
	assert.equal(typeof resolveVerifiedSshClient, "function", "resolveVerifiedSshClient must exist as the single platform decision");
	const f = windowsResolver();
	const client = await f.resolve({ platform: "win32", env: { SystemRoot: "C:\\Windows", PATH: "C:\\untrusted-path" } });
	assert.equal(client.sshPath, f.ssh);
	assert.equal(client.scpPath, f.scp);
	assert.equal(typeof client.run, "function");
	assert.deepEqual(f.opened, [f.ssh, f.scp]);
	assert.deepEqual(f.closed, [1, 2]);
});

test("Windows resolver simulation refuses a missing SCP sibling without falling back to PATH", async () => {
	const f = windowsResolver(true);
	await assert.rejects(f.resolve({ platform: "win32", env: { SystemRoot: "C:\\Windows", PATH: "C:\\untrusted-path" } }), /SSH_CLIENT_MISSING/);
	assert.deepEqual(f.opened, [f.ssh]);
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
