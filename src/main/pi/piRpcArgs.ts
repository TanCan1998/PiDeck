/**
 * pi RPC 的启动参数与小工具（Phase 4 P4.2）。
 *
 * 为什么单独放一个模块：远端运行时（`SshPiRuntimeLauncher` 那条路）**不能**复用 `PiProcess.start()`
 * 里那套本地准备（命令定位、WSL 转换、扩展/技能/提示词白名单、安全快照路径、trust flag）——那些都带
 * 本机路径与本机语义。但两边跑的是同一个 pi、同一套 RPC，**基础参数必须逐字一致**，否则「本机好用、
 * 远端行为不一样」这种漂移极难查。所以把基础参数抽成这里唯一的一份，本地与远端都从这里取。
 *
 * 远端本轮（P4.2 最小闭环）只带基础参数：资源白名单/安全快照/trust 属 P4.4（远端 artifact 与统一
 * trust key），那时也只在这里扩，不在两个调用点各写一份。
 */

/** 基础参数只依赖这一个开关（与 `PiProcess` 的用法一致：缺省视为开启）。 */
export type PiRpcBaseArgsSettings = { readonly piRpcOffline?: boolean };

/**
 * 本地与远端共用的基础 RPC 参数。
 *
 * `--no-themes`：RPC 无 TUI，不需要主题发现/加载（少扫用户/项目/package themes，冷启动更快）。
 * `--offline`：桌面端模型列表来自本地 models.json，默认跳过 pi 启动期的模型目录网络刷新。
 */
export function basePiRpcArgs(settings?: PiRpcBaseArgsSettings): string[] {
	const args = ["--mode", "rpc", "--no-themes"];
	if (settings?.piRpcOffline !== false) args.push("--offline");
	return args;
}

export type RemotePiArgsInput = {
	readonly settings?: PiRpcBaseArgsSettings;
	/**
	 * 远端 pi 自己的会话文件（绝对 POSIX 路径）。只有「重开同一会话」时才带：远端 pi 在远端
	 * `~/.pi/agent/sessions/**` 下维护它的会话，本机不参与这个路径。
	 */
	readonly sessionFile?: string;
};

/**
 * 远端 pi 的参数：基础参数 + 远端专用的少量项。
 *
 * 这里**不做**路径合法性之外的任何解释：`sessionFile` 必须是一条绝对 POSIX 路径（形状检查与仓库其它
 * 远端路径门同款），否则抛稳定码 —— 一个本机 Windows 路径（`C:\…`）或相对路径出现在远端命令行里都是
 * 静默错误，必须当场拒绝。
 */
export function buildRemotePiArgs(input: RemotePiArgsInput = {}): string[] {
	const args = basePiRpcArgs(input.settings);
	if (input.sessionFile !== undefined) {
		assertRemoteAbsolutePath(input.sessionFile);
		args.push("--session", input.sessionFile);
	}
	return args;
}

/** 远端绝对 POSIX 路径的形状门（与 `requireAbsoluteToolPath` / `resolveRemoteBrowseRoot` 同立场）。 */
export function assertRemoteAbsolutePath(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error("REMOTE_RUNTIME_PATH_INVALID");
	if (!value.startsWith("/") || value.endsWith("/")) throw new Error("REMOTE_RUNTIME_PATH_INVALID");
	if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("REMOTE_RUNTIME_PATH_INVALID");
	if (value.split("/").some((segment) => segment === "." || segment === "..")) throw new Error("REMOTE_RUNTIME_PATH_INVALID");
}
