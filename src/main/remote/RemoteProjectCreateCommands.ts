import { quotePosixArgument } from "./RemoteBootstrapContract";
import { assertProbePath } from "./RemoteBrowseRoot";
import { buildPinnedSshInvocation } from "./SshVerifiedConnection";
import type { SshClientRuntime } from "./SshClientRuntime";

/**
 * 创建空远端项目的固定命令（Phase 5 文件面；docs/remote-file-management-plan.md §7）。
 *
 * 创建发生在**任何项目根之外**，因此不能复用 withProjectSession：这里与 RemoteBrowseRoot 同源，
 * 走 pinned SSH 短命令（单引号字面量、shell:false 的 argv），不建 helper 会话、不写 ProjectStore。
 * 命令数保持 3：确认前探针（父 canonical + 父是目录 + 叶不存在）/ 确认后复核同一探针 / mkdir。
 */

export const REMOTE_PROJECT_CREATE_CODES = {
	invalidPath: "REMOTE_BROWSE_ROOT_INVALID",
	targetExists: "REMOTE_PROJECT_TARGET_EXISTS",
	parentMissing: "REMOTE_PROJECT_PARENT_NOT_FOUND",
	createFailed: "REMOTE_PROJECT_CREATE_FAILED",
	createUnconfirmed: "REMOTE_PROJECT_CREATE_UNCONFIRMED",
} as const;

/** 不允许被「新建空项目」顺手创建出来的保留名（.git/.pi 由 Git/信任面管理，回收站名由文件面管理）。 */
const RESERVED_LEAF_NAMES = new Set([".pideck-trash", ".git", ".pi"]);

export type RemoteProjectCreatePath = { path: string; parent: string; leaf: string };

/**
 * 绝对路径拆成 parent/leaf 并校验叶名。无法安全拆分时抛稳定码：
 * 路径本身非法交由 RemoteBrowseRoot.assertProbePath 的同一套判据；叶保留名/根级创建 ⇒ TARGET_INVALID。
 */
export function splitRemoteProjectCreatePath(value: unknown): RemoteProjectCreatePath {
	// 与登记「已有目录」复用同一套绝对路径判据（RemoteBrowseRoot.assertProbePath），不复制第二套路径语法。
	assertProbePath(value);
	const index = value.lastIndexOf("/");
	const parent = index === 0 ? "/" : value.slice(0, index);
	const leaf = value.slice(index + 1);
	if (parent === "/") throw new Error(REMOTE_PROJECT_CREATE_CODES.parentMissing);
	// 叶名是「新建的单层目录名」：保留名（.git/.pi/.pideck-trash）与正文保存临时后缀一律拒绝。
	if (Buffer.byteLength(leaf, "utf8") > 255 || RESERVED_LEAF_NAMES.has(leaf) || leaf.endsWith(".pideck-tmp")) throw new Error("REMOTE_PROJECT_TARGET_INVALID");
	return { path: value, parent, leaf };
}

/**
 * 探针命令：一次往返同时证明父目录仍是 canonical 目录、且叶（路径本身）尚不存在。
 * 退出码契约：3 父不可解析/不存在；4 父 canonical 与用户输入不一致；5 父不是目录；6 叶已存在。
 */
export function buildRemoteProjectCreateProbeCommand(value: RemoteProjectCreatePath): string {
	const parent = quotePosixArgument(value.parent);
	return `p=$(readlink -f -- ${parent}) || exit 3; [ -n "$p" ] || exit 3; [ "$p" = ${parent} ] || exit 4; [ -d "$p" ] || exit 5; { [ -e ${quotePosixArgument(value.path)} ] || [ -L ${quotePosixArgument(value.path)} ]; } && exit 6; exit 0`;
}

/**
 * mkdir 命令：只创建单层目录（无 -p、不覆盖、不改 mode 0777 & umask）。
 * 退出码契约：6 目标已存在（含并发创建）；3 父不存在/不是目录；8 父不可写；7 其它 create 失败。
 */
export function buildRemoteProjectCreateMkdirCommand(value: RemoteProjectCreatePath): string {
	const path = quotePosixArgument(value.path);
	const parent = quotePosixArgument(value.parent);
	return `mkdir -- ${path} 2>/dev/null; rc=$?; [ "$rc" -eq 0 ] && exit 0; if [ -e ${path} ] || [ -L ${path} ]; then exit 6; fi; p=$(readlink -f -- ${parent}) || exit 3; [ -d "$p" ] || exit 3; [ -w "$p" ] || exit 8; exit 7`;
}

/** pinned SSH 执行；调用方把抛出的传输异常解释成「未确认」而不是业务拒绝。 */
export async function runRemoteProjectCreateCommand(input: { userDataDir: string; hostId: string; client: SshClientRuntime; command: string }): Promise<{ exitCode: number; stdout: string }> {
	const invocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: input.command });
	return input.client.run(invocation.executable, invocation.args);
}

/** 探针退出码 → 稳定码；0 表示「父可创建、叶不存在」。 */
export function remoteProjectCreateProbeCode(exitCode: number): string | undefined {
	if (exitCode === 0) return undefined;
	if (exitCode === 3) return REMOTE_PROJECT_CREATE_CODES.parentMissing;
	if (exitCode === 4) return "REMOTE_PROJECT_ROOT_CHANGED";
	if (exitCode === 5) return REMOTE_PROJECT_CREATE_CODES.createFailed;
	if (exitCode === 6) return REMOTE_PROJECT_CREATE_CODES.targetExists;
	return "REMOTE_BROWSE_ROOT_PROBE_FAILED";
}

/** mkdir 退出码 → 稳定码。 */
export function remoteProjectCreateMkdirCode(exitCode: number): string {
	if (exitCode === 0) return "REMOTE_PROJECT_CREATE_OK";
	if (exitCode === 6) return REMOTE_PROJECT_CREATE_CODES.targetExists;
	if (exitCode === 3) return REMOTE_PROJECT_CREATE_CODES.parentMissing;
	if (exitCode === 8) return "REMOTE_FILE_PERMISSION_DENIED";
	return REMOTE_PROJECT_CREATE_CODES.createFailed;
}
