/**
 * 远端项目 trust 的判定与记录（P4.4b，纯函数）。
 *
 * 为什么单独一个纯模块：这是本批唯一会改变「远端项目 `.pi` 资源是否执行」的判定，材料来自三层
 * （主机档案 / pin 的密码学事实 / 项目根），任何一个环节各写一遍就会出现「按 A 存、按 B 查」的静默失效。
 * 这里只做三件事，全部可单测：
 *
 * 1. **判定**：`evaluateRemoteProjectTrust` 把 (hostId, 规范项目根, 当前 endpoint 身份) 折成四态之一
 *    —— approve / deny / stale（同 host+同根但 endpoint 变了 ⇒ 决策作废且能说出原因）/ undecided。
 * 2. **落盘形态**：`readRemoteProjectTrustRecord` / `normalizeRemoteProjectTrustRecords` 严格解码
 *    持久化条目（磁盘 JSON 不可信：字段畸形、key 与零件不自洽一律丢弃），旧配置缺这一段 ⇒ 空表。
 * 3. **迁移**：写入（同一 host+根替换旧的作废条目）、撤销、主机退役清理、按主机目录对账。
 *
 * 与 `RemoteTrustKey` 的关系：key 是存储身份（三材料任一变化即换 key），本模块只消费它，不再另算一套。
 * 边界：**未决策（含材料缺失、stale）一律返回 undefined**，调用方据此不传任何 flag——这是「零行为变更」
 * 的落点，也是安全底线（禁止默认 approve）。
 */
import type { RemoteProjectTrustDecision, RemoteProjectTrustEntry, RemoteProjectTrustRecord } from "../../shared/types/remoteTrust";
import { canonicalRemoteRoot, remoteEndpointDigest, remoteEndpointIdentity, remoteTrustKey, type RemoteEndpointIdentityInput } from "./RemoteTrustKey";

/** 本模块可能抛出的稳定码（消息即码：调用方/测试按字符串判定，绝不按措辞）。 */
export const REMOTE_PROJECT_TRUST_CODES = [
	/** 持久化条目畸形（只在内部解码路径使用；对外一律表现为「该条目被丢弃」）。 */
	"REMOTE_PROJECT_TRUST_ENTRY_INVALID",
	/** hostId 非法（不是远端域的 UUID 值域）。 */
	"REMOTE_PROJECT_TRUST_HOST_INVALID",
	/** 项目根无法规范成无歧义绝对远端根（相对路径 / 含引号 / 控制字符）。 */
	"REMOTE_PROJECT_TRUST_ROOT_INVALID",
	/** 决策不是 approve/deny。 */
	"REMOTE_PROJECT_TRUST_DECISION_INVALID",
	/** 拿不到可核验的 endpoint（主机未验证 / pin 事实读不出）⇒ 不能记录决策也不能判定。 */
	"REMOTE_PROJECT_TRUST_ENDPOINT_UNVERIFIED",
] as const;

export type RemoteProjectTrustCode = (typeof REMOTE_PROJECT_TRUST_CODES)[number];

const REMOTE_PROJECT_TRUST_CODE_SET: ReadonlySet<string> = new Set(REMOTE_PROJECT_TRUST_CODES);

export function isRemoteProjectTrustCode(code: string): code is RemoteProjectTrustCode {
	return REMOTE_PROJECT_TRUST_CODE_SET.has(code);
}

/** 主机 id 的闭集判据，与远端各域（hosts / projects / sessions / trust）逐字相同。 */
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** `RemoteTrustKey.remoteEndpointDigest` 的形状（sha256 前 32 位 hex）。 */
const ENDPOINT_DIGEST = /^[a-f0-9]{32}$/;
/**
 * 条目数上限：只防手工改坏 / 极端场景下的无限膨胀（正常用法是「每台主机几个项目」）。
 * 超出时保留**最新**的若干条（写入按时间追加，见 `writeRemoteProjectTrustDecision`）。
 */
export const REMOTE_PROJECT_TRUST_MAX_ENTRIES = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解码一条持久化记录；任何不自洽的形态返回 undefined（调用方丢弃该条，绝不猜）。
 *
 * 判据里包含「key 必须由 hostId + endpointDigest + 规范项目根重新拼出来」：手工编辑过的配置即使三个
 * 零件各自合法，也拼不出一个能命中的 key——这样「改配置硬塞一条信任」不会生效，只会被当作垃圾丢弃。
 */
export function readRemoteProjectTrustRecord(raw: unknown): RemoteProjectTrustRecord | undefined {
	if (!isRecord(raw)) return undefined;
	const { trustKey, hostId, canonicalRoot, endpointDigest, decision, decidedAt } = raw;
	if (typeof trustKey !== "string" || typeof hostId !== "string" || typeof canonicalRoot !== "string" || typeof endpointDigest !== "string") return undefined;
	if (decision !== "approve" && decision !== "deny") return undefined;
	if (typeof decidedAt !== "string" || Number.isNaN(Date.parse(decidedAt))) return undefined;
	if (!HOST_ID.test(hostId) || !ENDPOINT_DIGEST.test(endpointDigest)) return undefined;
	if (canonicalRemoteRoot(canonicalRoot) !== canonicalRoot) return undefined;
	if (trustKey !== `${hostId}::${endpointDigest}::${canonicalRoot}`) return undefined;
	return { trustKey, hostId, canonicalRoot, endpointDigest, decision, decidedAt };
}

/**
 * 归一化持久化条目表：非数组 ⇒ 空表（旧文件缺该段自然兼容），畸形条目逐条丢弃，按 key 去重（先到者胜）。
 * 不做任何迁移：这一段的出现晚于所有现存配置，缺它就是「未决策过」。
 */
export function normalizeRemoteProjectTrustRecords(raw: unknown): RemoteProjectTrustRecord[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const records: RemoteProjectTrustRecord[] = [];
	for (const entry of raw) {
		const record = readRemoteProjectTrustRecord(entry);
		if (record === undefined || seen.has(record.trustKey)) continue;
		seen.add(record.trustKey);
		records.push(record);
		if (records.length >= REMOTE_PROJECT_TRUST_MAX_ENTRIES) break;
	}
	return records;
}

/**
 * 一条 (主机, 项目根) 的当前判定。
 *
 * `stale` 是独立状态而不是「未决策」：同 host + 同根但 endpoint 摘要不同，说明换机 / 指纹变 / 用户或
 * 端口变 ⇒ 旧决策**必须**作废（fail-closed，不自动继承、不自动重信任），且界面要写明原因。
 * 材料缺失（无 endpoint 事实 / 路径不可规范 / hostId 非法）一律折叠成 `undecided`：
 * 「无法判定」与「用户没决策」对行为的要求完全一样——一个 flag 都不加。
 */
export type RemoteProjectTrustEvaluation =
	| { readonly state: "undecided" }
	| { readonly state: "approve"; readonly record: RemoteProjectTrustRecord }
	| { readonly state: "deny"; readonly record: RemoteProjectTrustRecord }
	| { readonly state: "stale"; readonly reason: "endpoint-changed"; readonly record: RemoteProjectTrustRecord };

export function evaluateRemoteProjectTrust(input: { readonly records: readonly RemoteProjectTrustRecord[]; readonly hostId: string; readonly remoteRoot: string | undefined; readonly endpointIdentity: RemoteEndpointIdentityInput | undefined }): RemoteProjectTrustEvaluation {
	const root = canonicalRemoteRoot(input.remoteRoot);
	const digest = remoteEndpointDigest(remoteEndpointIdentity(input.endpointIdentity));
	if (!root || digest === undefined) return { state: "undecided" };
	const key = remoteTrustKey({ hostId: input.hostId, endpointIdentity: remoteEndpointIdentity(input.endpointIdentity), remoteRoot: root });
	if (key === undefined) return { state: "undecided" };
	const exact = input.records.find((record) => record.trustKey === key);
	if (exact !== undefined) return { state: exact.decision, record: exact };
	const stale = input.records.find((record) => record.hostId === input.hostId && record.canonicalRoot === root && record.endpointDigest !== digest);
	if (stale !== undefined) return { state: "stale", reason: "endpoint-changed", record: stale };
	return { state: "undecided" };
}

/**
 * 判定 → 传给远端 pi 的 trust 覆盖值（与本机 `PiProcess.start(sessionPath, trustOverride)` 同一套词汇）。
 *
 * **只有 approve/deny 才返回值**：undecided（未决策 / 材料缺失）与 stale（endpoint 变更作废）都返回
 * undefined ⇒ 调用方一个 flag 都不加，远端行为与今天完全一致。
 */
export function remoteProjectTrustOverride(evaluation: RemoteProjectTrustEvaluation): "approve" | "no-approve" | undefined {
	if (evaluation.state === "approve") return "approve";
	if (evaluation.state === "deny") return "no-approve";
	return undefined;
}

/**
 * 记录一条决策，返回新的条目表（不改原数组）。
 *
 * 同一 (hostId, 规范项目根) 只保留一条：换 endpoint 后重新决策必须**覆盖**那条已作废的条目，
 * 否则清单里会同时出现「已作废」与「已信任」两行，而真正生效的是新 key 那条——用户看到的是自相矛盾的状态。
 * 拿不到可核验的 endpoint 时抛 `REMOTE_PROJECT_TRUST_ENDPOINT_UNVERIFIED`：没有密码学事实就没有
 * trust key，写进去的条目永远不会被命中（等于假装存下了决策）。
 */
export function writeRemoteProjectTrustDecision(input: {
	readonly records: readonly RemoteProjectTrustRecord[];
	readonly hostId: string;
	readonly remoteRoot: string | undefined;
	readonly endpointIdentity: RemoteEndpointIdentityInput | undefined;
	readonly decision: RemoteProjectTrustDecision;
	readonly decidedAt: string;
}): RemoteProjectTrustRecord[] {
	if (!HOST_ID.test(input.hostId)) throw new Error("REMOTE_PROJECT_TRUST_HOST_INVALID");
	const root = canonicalRemoteRoot(input.remoteRoot);
	if (root === undefined) throw new Error("REMOTE_PROJECT_TRUST_ROOT_INVALID");
	if (input.decision !== "approve" && input.decision !== "deny") throw new Error("REMOTE_PROJECT_TRUST_DECISION_INVALID");
	const identity = remoteEndpointIdentity(input.endpointIdentity);
	const key = remoteTrustKey({ hostId: input.hostId, endpointIdentity: identity, remoteRoot: root });
	const digest = remoteEndpointDigest(identity);
	if (key === undefined || digest === undefined) throw new Error("REMOTE_PROJECT_TRUST_ENDPOINT_UNVERIFIED");
	const kept = input.records.filter((record) => !(record.hostId === input.hostId && record.canonicalRoot === root));
	const next = [...kept, { trustKey: key, hostId: input.hostId, canonicalRoot: root, endpointDigest: digest, decision: input.decision, decidedAt: input.decidedAt } satisfies RemoteProjectTrustRecord];
	// 超限时丢最旧的（写入追加在末尾，切片保留最后 N 条）。
	return next.length > REMOTE_PROJECT_TRUST_MAX_ENTRIES ? next.slice(-REMOTE_PROJECT_TRUST_MAX_ENTRIES) : next;
}

/** 撤销：按 (hostId, 规范项目根) 删除决策（active 与 stale 一并删除，撤销不该留下一个作废残留）。 */
export function removeRemoteProjectTrust(input: { readonly records: readonly RemoteProjectTrustRecord[]; readonly hostId: string; readonly remoteRoot: string | undefined }): { records: RemoteProjectTrustRecord[]; removed: boolean } {
	const root = canonicalRemoteRoot(input.remoteRoot);
	if (root === undefined) return { records: [...input.records], removed: false };
	const records = input.records.filter((record) => !(record.hostId === input.hostId && record.canonicalRoot === root));
	return { records, removed: records.length !== input.records.length };
}

/** 主机退役清理：该 host 的所有决策条目一次性删除（id 永不复用，残留条目永远不可能再命中）。 */
export function forgetRemoteProjectTrustHost(records: readonly RemoteProjectTrustRecord[], hostId: string): { records: RemoteProjectTrustRecord[]; changed: boolean } {
	const kept = records.filter((record) => record.hostId !== hostId);
	return { records: kept, changed: kept.length !== records.length };
}

/**
 * 按主机目录对账：丢掉「已退役」或「目录里根本没有」的条目。
 *
 * 只允许在目录**可信**（`complete`，即主机 store 处于 ready）时调用：needs-repair 下的 profiles 可能是
 * 回退/不完整视图，拿它当「主机没了」会删掉仍然存在的主机的决策——宁可留下垃圾，也不能误删用户意图。
 * 与 pin 清理同一立场（`pruneRetiredPins`：删不掉就下次再试）。
 */
export function reconcileRemoteProjectTrustHosts(records: readonly RemoteProjectTrustRecord[], hosts: { readonly live: ReadonlySet<string>; readonly retired: ReadonlySet<string> }): { records: RemoteProjectTrustRecord[]; changed: boolean } {
	const kept = records.filter((record) => !hosts.retired.has(record.hostId) && hosts.live.has(record.hostId));
	return { records: kept, changed: kept.length !== records.length };
}

/**
 * 持久化记录 → 渲染层可见的条目。
 *
 * `status` 由「记录的 endpoint 摘要 == 该主机**当前**可核验的 endpoint 摘要」决定；拿不到可核验的
 * endpoint 一律按 stale 处理（fail-closed：与决策时的材料无法对齐的决策不得展示成有效）。
 */
export function remoteProjectTrustEntryView(input: { readonly record: RemoteProjectTrustRecord; readonly hostLabel: string; readonly endpointIdentity: RemoteEndpointIdentityInput | undefined }): RemoteProjectTrustEntry {
	const digest = remoteEndpointDigest(remoteEndpointIdentity(input.endpointIdentity));
	const active = digest !== undefined && digest === input.record.endpointDigest;
	return {
		hostId: input.record.hostId,
		hostLabel: input.hostLabel,
		canonicalRoot: input.record.canonicalRoot,
		decision: input.record.decision,
		decidedAt: input.record.decidedAt,
		status: active ? "active" : "stale",
		...(active ? {} : { staleReason: "endpoint-changed" as const }),
	};
}
