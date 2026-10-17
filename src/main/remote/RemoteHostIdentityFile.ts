/**
 * Add-host `identityFile` normalization（security review F4）。
 *
 * 为什么需要它：`~/.ssh/config` 里 `IdentityFile ~/.ssh/id_*` 是最常见写法，扫描候选原样把它交给
 * `remote:host-add`；而 `identityFile` 在 host store 里必须是**本机绝对路径**（OpenSSH 的 `-i` 实参，
 * 由 `SshCommandBuilder` 以数组形式下发，不经过 shell），`~` 永远不会被展开。旧实现因此让最常见的
 * 配置形态以不透明的 `REMOTE_HOST_STORE_INVALID` 失败（审查探针已验证）。
 *
 * 语义边界（与 `docs/remote-development-plan.md` §5.2 line 261 一致）：
 * - 展开对象是**本机账号**的 HOME：这个文件是本地 OpenSSH 客户端要读的私钥引用，不是远端账号的文件。
 *   把它按远端 HOME 展开会把本机路径指向一个远端不存在的目录，语义也是错的。
 * - 只展开 `~` 与 `~/...`；`~user`（别的用户 home）与相对路径**拒绝**而不是猜：OpenSSH 对相对
 *   IdentityFile 的解析依赖进程 cwd，而这里要保存的是跨重启复用的持久值，猜出来的路径可能指向另一个文件。
 * - 结果用 `path.normalize` 规范化并必须仍是**本机平台**绝对路径——与 `RemoteHostStoreCodec` 持久化时
 *   的判据同源（那里对旧数据再做一次 `isAbsolute` 校验）。
 *
 * 纯函数、无文件系统访问：单测不依赖真实 HOME，也不需要读私钥。
 */
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

/** 身份文件路径无法规范化成可持久化的本机绝对路径（IPC 边界用它给出比 `REMOTE_HOST_STORE_INVALID` 更准的码）。 */
export const REMOTE_HOST_IDENTITY_FILE_INVALID = "REMOTE_HOST_IDENTITY_FILE_INVALID";

/** 与 `remoteHostIpc.readAddInput` 的字段上界一致：绝不把超长/控制字节的值带进 store。 */
const MAX_IDENTITY_FILE_LENGTH = 4096;
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;

/**
 * 把一个用户/配置提供的 `identityFile` 值规范化为可持久化的本机绝对路径。
 *
 * `homeDir` 可注入（测试用）；生产默认取本机 `homedir()`。无法规范化时返回 `undefined`，
 * 由调用方映射成稳定码，绝不返回「半展开」的字符串。
 */
export function normalizeRemoteHostIdentityFile(value: unknown, homeDir: string = homedir()): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_IDENTITY_FILE_LENGTH || CONTROL_BYTES.test(trimmed)) return undefined;
	if (typeof homeDir !== "string" || homeDir.length === 0 || !isAbsolute(homeDir) || CONTROL_BYTES.test(homeDir)) return undefined;
	let expanded: string;
	if (trimmed === "~") expanded = homeDir;
	else if (trimmed.startsWith("~/")) expanded = join(homeDir, trimmed.slice(2));
	// `~user` 与相对路径都不能可靠地变成跨重启稳定的本机绝对路径：拒绝，不猜。
	else if (trimmed.startsWith("~") || !isAbsolute(trimmed)) return undefined;
	else expanded = trimmed;
	const normalized = normalize(expanded);
	// `path.normalize` 会**保留**尾分隔符（Node 的既定语义），而 `-i` 实参与 store 值都不该带它：
	// 去掉后再过判据；只剩盘符/根（如 Windows `C:\`）时 isAbsolute 会失败，按不可用处理。
	const canonical = normalized.length > 1 && /[\\/]$/.test(normalized) ? normalized.replace(/[\\/]+$/, "") : normalized;
	// 展开后可能比原始值更长：持久化上界必须对**最终值**成立（与 store/IPC 的字段上界一致）。
	if (canonical.length === 0 || canonical.length > MAX_IDENTITY_FILE_LENGTH || !isAbsolute(canonical)) return undefined;
	return canonical;
}
