/**
 * 远端项目 trust 域的 IPC 注册（P4.4b）。
 *
 * 三条通道（清单 / 决策 / 撤销），与 hosts、projects 域一样只在这一个文件里注册，通道名集中在
 * `shared/ipc.ts`。为什么单开一个域而不是塞进 hosts 域：域边界本来就不同——hosts 域回答「连得上吗」，
 * 这里是「这个远端项目的 `.pi` 资源该不该执行」，且它的写入对象是桌面配置里的决策表。
 *
 * 边界（`docs/remote-trust-plan.md` §3.0）：
 * - 渲染层**只能**按 `(hostId, 项目根)` 寻址，**不能**看到 trust key、endpoint 摘要、指纹或 known_hosts
 *   摘要中的任何一种——key 与摘要都含 pin 的密码学事实，只留在主进程与配置里（返回类型
 *   `RemoteProjectTrustEntry` 结构上就装不下它们）。
 * - 入参不可信：hostId 必须是远端域的 UUID 值域，项目根必须是有界绝对 POSIX 形状，decision 必须是枚举值。
 *   规范化（折叠 `.`/`..`、去尾斜杠）由主进程做，渲染层给的字符串只是候选值。
 * - `enabled` 关掉（正式包 / 未开启实验）时每条通道都返回稳定码：渲染层连「有这条路」都不该知道。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteProjectTrustClearResult, RemoteProjectTrustDecision, RemoteProjectTrustListResult, RemoteProjectTrustSetResult } from "../../shared/types/remoteTrust";
import { isRemoteProjectTrustCode } from "../remote/RemoteProjectTrust";
import type { RemoteProjectTrustService } from "../remote/RemoteProjectTrustService";

/** host id 的闭集判据，与 hosts / projects / trust 三个域逐字相同。 */
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 与远端路径门同一个上限（`assertRemoteAbsolutePath` 的 4096）。 */
const MAX_REMOTE_ROOT_LENGTH = 4096;

/**
 * 远端项目根的形状门（渲染层入参）。
 *
 * 只做边界形状判定（绝对 POSIX、有界、无控制字节）；**规范化不在这里做**——它必须与 trust key 同源
 * （`canonicalRemoteRoot`），否则会出现「登记的根」与「判定的根」两个字符串。形状不合法的输入没有任何
 * 可规范化空间，直接以域内稳定码拒绝。
 */
function readRemoteRoot(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_ROOT_LENGTH) return undefined;
	if (!value.startsWith("/") || /[\x00-\x1f\x7f]/.test(value)) return undefined;
	return value;
}

function readDecision(value: unknown): RemoteProjectTrustDecision | undefined {
	return value === "approve" || value === "deny" ? value : undefined;
}

/** 把 service 抛出的域内稳定码转述出来；其它异常折叠成调用方给的兜底码（绝不让自由文本跨边界）。 */
function codeOf(error: unknown, fallback: string): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	if (typeof message === "string" && isRemoteProjectTrustCode(message)) return message;
	return fallback;
}

export function registerRemoteProjectTrustIpc(input: { enabled: boolean; trust?: () => RemoteProjectTrustService | undefined }): void {
	/** 解析 trust 服务；门禁关闭或未装配时返回 undefined。 */
	const resolveTrust = (): RemoteProjectTrustService | undefined => (input.enabled ? input.trust?.() : undefined);

	ipcMain.handle(ipcChannels.remoteTrustList, async (): Promise<RemoteProjectTrustListResult> => {
		const trust = resolveTrust();
		if (trust === undefined) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			return { ok: true, entries: await trust.list() };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_TRUST_UNAVAILABLE") };
		}
	});

	ipcMain.handle(ipcChannels.remoteTrustSet, async (_event, hostIdValue: unknown, remoteRootValue: unknown, decisionValue: unknown): Promise<RemoteProjectTrustSetResult> => {
		// 入参校验在边界第一行：hostId / 项目根 / 决策各自一个域内稳定码，不合并成一个「参数错」。
		if (typeof hostIdValue !== "string" || !HOST_ID.test(hostIdValue)) return { ok: false, code: "REMOTE_PROJECT_TRUST_HOST_INVALID" };
		const remoteRoot = readRemoteRoot(remoteRootValue);
		if (remoteRoot === undefined) return { ok: false, code: "REMOTE_PROJECT_TRUST_ROOT_INVALID" };
		const decision = readDecision(decisionValue);
		if (decision === undefined) return { ok: false, code: "REMOTE_PROJECT_TRUST_DECISION_INVALID" };
		const trust = resolveTrust();
		if (trust === undefined) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			return { ok: true, entry: await trust.decide({ hostId: hostIdValue, remoteRoot, decision }) };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_TRUST_UNAVAILABLE") };
		}
	});

	ipcMain.handle(ipcChannels.remoteTrustClear, async (_event, hostIdValue: unknown, remoteRootValue: unknown): Promise<RemoteProjectTrustClearResult> => {
		if (typeof hostIdValue !== "string" || !HOST_ID.test(hostIdValue)) return { ok: false, code: "REMOTE_PROJECT_TRUST_HOST_INVALID" };
		const remoteRoot = readRemoteRoot(remoteRootValue);
		if (remoteRoot === undefined) return { ok: false, code: "REMOTE_PROJECT_TRUST_ROOT_INVALID" };
		const trust = resolveTrust();
		if (trust === undefined) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			return { ok: true, removed: await trust.revoke({ hostId: hostIdValue, remoteRoot }) };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_TRUST_UNAVAILABLE") };
		}
	});
}
