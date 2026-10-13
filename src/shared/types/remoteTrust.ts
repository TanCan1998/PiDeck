/**
 * 远端项目 trust 的共享契约（P4.4b）。
 *
 * 语义边界（见 `docs/remote-trust-plan.md` §2 / §3.0）：trust 的判定对象是
 * `(hostId, endpoint 身份摘要, 规范项目根)`，三样材料里**只有 hostId 与规范项目根**能出现在渲染层——
 * endpoint 身份来自 pin 的密码学事实（`SshHostPinStore`），**不得**以任何形式（指纹、known_hosts 摘要、
 * 甚至派生摘要）回传渲染层。所以这里刻意分成两类：
 *
 * - `RemoteProjectTrustRecord`：主进程持有的**持久化**记录（写进桌面 settings.json 的 `remoteProjectTrust`
 *   段，随配置备份）；带 `endpointDigest`，用来检测「同 host + 同根但 endpoint 变了」。
 * - `RemoteProjectTrustEntry`：渲染层看到的**展示/操作**形态；只有 host label、项目根、决策、状态，
 *   没有任何 endpoint 材料。渲染层操作一律按 `(hostId, canonicalRoot)` 寻址，而不是按 trust key——
 *   key 里含 endpoint 摘要，天然就不该出主进程。
 */

/** trust 决策：approve=信任（让远端 pi 加载项目 `.pi` 资源）；deny=明确拒绝。 */
export type RemoteProjectTrustDecision = "approve" | "deny";

/**
 * 一条持久化的 trust 决策记录（主进程侧）。
 *
 * `trustKey` 是 `RemoteTrustKey.remoteTrustKey()` 的产物（`hostId::endpointDigest::canonicalRoot`），
 * 也是本段的存储身份：三样材料任一变化都会换 key，因此「换了机器/指纹/用户/端口」永远不会命中旧决策。
 * `hostId` / `canonicalRoot` / `endpointDigest` 与 key 冗余存储是有意的：同 host + 同根但摘要不同
 * 时，才能报出「决策已作废（endpoint 已变更）」而不是悄悄变成「未决策」。
 */
export type RemoteProjectTrustRecord = {
	readonly trustKey: string;
	readonly hostId: string;
	/** 规范远端项目根（`canonicalRemoteRoot` 的产物，与 trust key 里的那一份逐字相同）。 */
	readonly canonicalRoot: string;
	/** endpoint 身份摘要（sha256 截断）；用于「同 host+同根但 endpoint 变了」的作废判定。主进程独占。 */
	readonly endpointDigest: string;
	readonly decision: RemoteProjectTrustDecision;
	/** 决策时间（ISO 8601），审计用。 */
	readonly decidedAt: string;
};

/**
 * 渲染层可见的一条 trust 条目。
 *
 * `status` 的两种取值是「这条决策**现在**还算不算数」：`stale` = 决策时的那组 endpoint 材料与当前
 * 已确认的 endpoint 不一致（换机 / 指纹变 / 用户或端口变）⇒ 决策作废，下一次 spawn 不会带任何 flag，
 * 界面必须写明原因而不是悄悄展示成「已信任」。
 */
export type RemoteProjectTrustEntry = {
	readonly hostId: string;
	/** 主机显示名（label 可改，仅用于展示；trust 身份里没有它）。 */
	readonly hostLabel: string;
	readonly canonicalRoot: string;
	readonly decision: RemoteProjectTrustDecision;
	readonly decidedAt: string;
	readonly status: "active" | "stale";
	/** 作废原因；active 时不带。 */
	readonly staleReason?: "endpoint-changed";
};

/** 远端 trust 清单（设置页 + 会话提示条共用）。 */
export type RemoteProjectTrustListResult = { ok: true; entries: RemoteProjectTrustEntry[] } | { ok: false; code: string };

/** 记录一条决策（信任 / 拒绝）。`remoteRoot` 由主进程规范化为规范项目根。 */
export type RemoteProjectTrustSetInput = {
	readonly hostId: string;
	readonly remoteRoot: string;
	readonly decision: RemoteProjectTrustDecision;
};

export type RemoteProjectTrustSetResult = { ok: true; entry: RemoteProjectTrustEntry } | { ok: false; code: string };

/** 撤销：按 `(hostId, 规范项目根)` 删除该项目的决策（含已作废的那条）。 */
export type RemoteProjectTrustClearResult = { ok: true; removed: boolean } | { ok: false; code: string };
