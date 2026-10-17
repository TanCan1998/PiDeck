import assert from "node:assert/strict";
import { join, normalize } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Add-host `identityFile` 的本机路径规范化（security review F4）。
 *
 * 判据只依赖注入的 homeDir 与当前平台 path 模块，不读真实 HOME、不碰文件系统（测试数据也不需要真实私钥）：
 * 展开语义属于「main 保存前规范化」，与私钥内容/存在性无关（不存在时连接诊断按计划明确失败）。
 */

const { normalizeRemoteHostIdentityFile, REMOTE_HOST_IDENTITY_FILE_INVALID } = loadTsCommonJs("src/main/remote/RemoteHostIdentityFile.ts");

const POSIX = process.platform !== "win32";
const HOME = POSIX ? "/home/tester" : "C:\\Users\\tester";

test("expands ~ and ~/... against the local account home, never the remote one", () => {
	assert.equal(normalizeRemoteHostIdentityFile("~", HOME), normalize(HOME));
	assert.equal(normalizeRemoteHostIdentityFile("~/.ssh/id_ed25519", HOME), join(HOME, ".ssh/id_ed25519"));
	assert.equal(normalizeRemoteHostIdentityFile("~/", HOME), normalize(HOME));
	// OpenSSH 的 SSH config 常见形态：带引号的值在解析层已去掉引号，这里只处理真正到达 IPC 的字符串。
	assert.equal(normalizeRemoteHostIdentityFile("  ~/.ssh/id_rsa  ", HOME), join(HOME, ".ssh/id_rsa"));
});

test("keeps absolute local paths and canonicalizes them without changing their target", () => {
	const absolute = join(HOME, ".ssh", "id_ed25519");
	assert.equal(normalizeRemoteHostIdentityFile(absolute, HOME), absolute);
	// 冗余分隔符/尾斜杠/当前目录段被规范化（与 store codec 的 isAbsolute 判据对齐）。
	assert.equal(normalizeRemoteHostIdentityFile(`${HOME}//.ssh/./id_ed25519/`, HOME), absolute);
	// `..` 由 path.normalize 归约：这是本机文件路径，不承担远端/项目目录的逃逸判据。
	assert.equal(normalizeRemoteHostIdentityFile("~/.ssh/../keys/id", HOME), join(HOME, "keys/id"));
});

test("rejects forms that cannot be a stable local absolute path instead of guessing", () => {
	for (const bad of [
		// `~user` 需要解析别的用户的 home（本模块不做 NSS 查询，也不该猜）。
		"~root/.ssh/id_ed25519",
		"~deploy/id",
		// 相对路径：OpenSSH 按进程 cwd 解析，跨重启持久化后语义不成立。
		".ssh/id_ed25519",
		"id_ed25519",
		"../keys/id",
		// 空值/控制字节/超长：绝不把这类值带进 store。
		"",
		"   ",
		"~/.ssh/id\u0000_ed25519",
		"~/.ssh/id\n_ed25519",
		`~/${"x".repeat(4090)}`,
	]) {
		assert.equal(normalizeRemoteHostIdentityFile(bad, HOME), undefined, `expected rejection: ${JSON.stringify(bad)}`);
	}
	// 非字符串输入同样拒绝（IPC 边界拿到的 value 是 unknown）。
	for (const bad of [null, undefined, 42, {}, []]) assert.equal(normalizeRemoteHostIdentityFile(bad, HOME), undefined);
});

test("a home directory that cannot anchor an absolute path is refused rather than half-expanded", () => {
	// 注入坏 home：`~` 展开会得到相对路径/空串时，宁可拒绝也不返回「看起来展开了」的结果。
	for (const badHome of ["", "relative/home", "~/home", "C:/Users/tester/\u0000"]) assert.equal(normalizeRemoteHostIdentityFile("~/.ssh/id", badHome), undefined, JSON.stringify(badHome));
});

test("the stable code is a bare diagnostic code (renderer/IPC contract convention)", () => {
	assert.equal(REMOTE_HOST_IDENTITY_FILE_INVALID, "REMOTE_HOST_IDENTITY_FILE_INVALID");
	assert.match(REMOTE_HOST_IDENTITY_FILE_INVALID, /^[A-Z][A-Z0-9_]{2,63}$/);
});
