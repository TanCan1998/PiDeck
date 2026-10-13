/**
 * 远端 pi 运行时计划的构造（Phase 4 P4.2）。
 *
 * 这个模块的唯一职责：把「已经解析好的远端事实」组装成一个 `RemoteSshPiRuntimeLaunchPlan`，并在
 * 组装点把每一条形状都验掉。为什么要单独一步、而不是让调用方随手拼对象：
 *
 * 1. **远端 plan 里不允许出现本机路径**。这是 Phase 4 最容易犯、也最难发现的错误——本机路径在远端
 *    要么不存在、要么指向完全不同的东西，而 pi 通常不会因此报错，只会行为诡异。所有路径字段在构造点
 *    就按远端绝对 POSIX 形状校验（`/…`、有界、无控制字符、不含 `.`/`..` 段），Windows 形状与相对
 *    路径当场抛稳定码。
 * 2. **身份字段与别处同源**：`hostId` 用 shared 的 `PROJECT_HOST_ID_PATTERN`（与项目/会话 locator、
 *    引用扫描同一取值域），`nonce` 用与引导握手同一个形态（首字符字母数字、16..64）。
 * 3. **参数只来自 `piRpcArgs`**：远端与本地共享同一份基础参数，避免「同一个 pi 两套参数」的漂移。
 *    远端项目 trust 的 flag（`--approve/--no-approve`）同样只由 `buildRemotePiArgs` 追加：plan 构造点
 *    只把**已解析的决策**透传下去，自己不认任何 flag 字面量（见 tests/remoteTrustFlagContract.test.mjs）。
 */
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import { REMOTE_RUNNER_MAX_ARGV_LENGTH } from "../remote/RemoteRunnerContract";
import type { RemoteSshPiRuntimeLaunchPlan } from "./PiSpawnHandle";
import { assertRemoteAbsolutePath, buildRemotePiArgs, type PiRpcBaseArgsSettings, type PiTrustOverride } from "./piRpcArgs";

/** 与引导握手同一个 nonce 形态（首字符字母数字，16..64）。 */
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
/**
 * pi **自己**的参数个数上限。
 *
 * 与 runner 的 argv 上限**同源耦合**：runner 收到的是 `[解释器, pi 入口, ...pi 参数]`，所以可用
 * 槽位是 `REMOTE_RUNNER_MAX_ARGV_LENGTH - 2`。写死一个更大的数就会变成「计划构造成功、runner 拒收」
 * 这种最糟糕的失败形态（两边各自都“自洽”），因此这里直接从上限定导出，而不是另写一个常量。
 */
const MAX_REMOTE_ARGS = REMOTE_RUNNER_MAX_ARGV_LENGTH - 2;

export type RemotePiRuntimePlanInput = {
	readonly hostId: string;
	readonly generation: number;
	/** 远端项目根（canonical；本机路径在这里是错误输入）。 */
	readonly remoteCwd: string;
	/** P4.1 探测得到的远端解释器与 pi 入口。 */
	readonly nodePath: string;
	readonly piPath: string;
	/** 内容寻址部署包里 runner.mjs 的远端绝对路径。 */
	readonly runnerPath: string;
	readonly nonce: string;
	/** 「重开同一会话」时带上的远端会话文件；新会话不传。 */
	readonly sessionFile?: string;
	/**
	 * 远端项目 trust 决策（approve / no-approve）。**未决策时不要传**：缺省 = 参数里不出现任何 trust flag。
	 * 调用方（远端运行时端口）从 trust 决策表解析后透传给这里，构造点不做任何默认值。
	 */
	readonly trust?: PiTrustOverride;
	readonly settings?: PiRpcBaseArgsSettings;
};

export function buildRemotePiRuntimePlan(input: RemotePiRuntimePlanInput): RemoteSshPiRuntimeLaunchPlan {
	if (typeof input?.hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(input.hostId)) throw new Error("REMOTE_RUNTIME_HOST_ID_INVALID");
	if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error("REMOTE_RUNTIME_GENERATION_INVALID");
	if (typeof input.nonce !== "string" || !NONCE.test(input.nonce)) throw new Error("REMOTE_RUNTIME_NONCE_INVALID");
	assertRemoteAbsolutePath(input.remoteCwd);
	assertRemoteAbsolutePath(input.nodePath);
	assertRemoteAbsolutePath(input.piPath);
	assertRemoteAbsolutePath(input.runnerPath);
	const args = buildRemotePiArgs({ settings: input.settings, ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }), ...(input.trust === undefined ? {} : { trust: input.trust }) });
	if (args.length > MAX_REMOTE_ARGS) throw new Error("REMOTE_RUNTIME_ARGS_TOO_MANY");
	return {
		kind: "remote-ssh",
		hostId: input.hostId,
		generation: input.generation,
		nodePath: input.nodePath,
		piPath: input.piPath,
		runnerPath: input.runnerPath,
		cwd: input.remoteCwd,
		args,
		nonce: input.nonce,
	};
}
