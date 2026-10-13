/**
 * pi RPC 的启动参数与小工具（Phase 4 P4.2）。
 *
 * 为什么单独放一个模块：远端运行时（`SshPiRuntimeLauncher` 那条路）**不能**复用 `PiProcess.start()`
 * 里那套本地准备（命令定位、WSL 转换、扩展/技能/提示词白名单、安全快照路径、trust flag）——那些都带
 * 本机路径与本机语义。但两边跑的是同一个 pi、同一套 RPC，**基础参数必须逐字一致**，否则「本机好用、
 * 远端行为不一样」这种漂移极难查。所以把基础参数抽成这里唯一的一份，本地与远端都从这里取。
 *
 * 远端本轮只带基础参数 + 远端项目 trust 决策（P4.4b）：资源白名单/安全快照属 P4.4 的其余部分，
 * 那时也只在这里扩，不在两个调用点各写一份。
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
	/**
	 * 远端项目 trust 的决策（P4.4b），词表与本机 `PiProcess.start(sessionPath, trustOverride)` 逐字相同。
	 *
	 * **未决策时不要传这个字段**：`undefined` 表示「PiDeck 不表态」，参数里一个 trust flag 都不出现，
	 * 远端行为与历史版本逐字一致（远端项目 `.pi` 资源是否加载仍由远端自己的 `defaultProjectTrust` 决定）。
	 * 只有解析到了明确决策（approve / deny）才传值——禁止任何形式的默认 approve。
	 * 决策来源见 `RemoteProjectTrustService`（key = hostId + endpoint 身份摘要 + 规范项目根）。
	 */
	readonly trust?: PiTrustOverride;
};

/**
 * trust 覆盖值（本机与远端同一套词汇）：approve=信任项目本地文件，no-approve=忽略项目本地文件。
 * 与 pi CLI 的 `--approve/--no-approve` 一一对应，映射只写在这里一处。
 */
export type PiTrustOverride = "approve" | "no-approve";

/**
 * 远端 pi 的参数：基础参数 + 远端专用的少量项。
 *
 * 这里**不做**路径合法性之外的任何解释：`sessionFile` 必须是一条绝对 POSIX 路径（形状检查与仓库其它
 * 远端路径门同款），否则抛稳定码 —— 一个本机 Windows 路径（`C:\…`）或相对路径出现在远端命令行里都是
 * 静默错误，必须当场拒绝。
 *
 * `trust` 是唯一会改变远端项目 `.pi` 资源是否执行的参数：未传 = 一个 flag 都不加（零行为变更），
 * 传了才追加对应的 flag。flag 字面量只允许出现在这个映射里（远端 launcher / plan 构造点不得自己拼，
 * 见 `tests/remoteTrustFlagContract.test.mjs`）。
 */
export function buildRemotePiArgs(input: RemotePiArgsInput = {}): string[] {
	const args = basePiRpcArgs(input.settings);
	if (input.sessionFile !== undefined) {
		assertRemoteAbsolutePath(input.sessionFile);
		args.push("--session", input.sessionFile);
	}
	if (input.trust !== undefined) args.push(input.trust === "approve" ? "--approve" : "--no-approve");
	return args;
}

/** 远端绝对 POSIX 路径的形状门（与 `requireAbsoluteToolPath` / `resolveRemoteBrowseRoot` 同立场）。 */
export function assertRemoteAbsolutePath(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error("REMOTE_RUNTIME_PATH_INVALID");
	if (!value.startsWith("/") || value.endsWith("/")) throw new Error("REMOTE_RUNTIME_PATH_INVALID");
	if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("REMOTE_RUNTIME_PATH_INVALID");
	if (value.split("/").some((segment) => segment === "." || segment === "..")) throw new Error("REMOTE_RUNTIME_PATH_INVALID");
}
