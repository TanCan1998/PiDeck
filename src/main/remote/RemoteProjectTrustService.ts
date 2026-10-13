/**
 * 远端项目 trust 的服务（P4.4b）：决策表 + 主机事实 → 四态、决策写入、撤销、退役清理。
 *
 * 装配位置在 `src/main/index.ts`：持久化端口指向 `SettingsStore` 的 `remoteProjectTrust` 段，
 * 主机事实端口指向 `openRemoteHostCatalogView`（已确认 pin 事实的唯一只读入口）。
 *
 * 两条硬要求在这里落地：
 * - **每次 spawn 重新解析**（`trustOverride()` 现读配置 + 现读主机目录）⇒ 撤销下一次 spawn 即生效，
 *   不要求重启应用，也不缓存上一轮决策。
 * - **未决策 = 不传 flag**：undecided / stale / 材料缺失 / 主机读不出来一律返回 undefined，
 *   远端行为与「PiDeck 完全不传 trust」逐字相同（见 `docs/remote-trust-plan.md` §3 决策 2）。
 *
 * 为什么服务层不自己读 pin：材料只能来自既有 pin 事实（`SshHostPinStore` 一系）。本模块只吃
 * `RemoteProjectTrustHostFactsPort` 给的 endpoint 身份，新增第二条 SSH/pin 读取通道属越界。
 */
import type { RemoteProjectTrustDecision, RemoteProjectTrustEntry, RemoteProjectTrustRecord } from "../../shared/types/remoteTrust";
import type { RemoteEndpointIdentityInput } from "./RemoteTrustKey";
import { evaluateRemoteProjectTrust, forgetRemoteProjectTrustHost, normalizeRemoteProjectTrustRecords, reconcileRemoteProjectTrustHosts, remoteProjectTrustEntryView, remoteProjectTrustOverride, removeRemoteProjectTrust, writeRemoteProjectTrustDecision } from "./RemoteProjectTrust";
import type { RemoteProjectTrustHostCatalog, RemoteProjectTrustHostFactsPort } from "./RemoteProjectTrustHostFacts";

/** 持久化端口：`read()` 返回配置里那一段的**原始值**（磁盘 JSON 不可信，解码在纯函数里做）。 */
export type RemoteProjectTrustSettingsPort = {
	read(): unknown;
	write(records: readonly RemoteProjectTrustRecord[]): Promise<void>;
};

export type RemoteProjectTrustService = {
	/**
	 * 这一次 spawn 应传的 trust 覆盖值（本机 `PiProcess.start` 的同一套词汇）；`undefined` = 一个 flag 都不加。
	 * 只回 approve/deny 两态；never throws（读配置/读主机失败一律按未决策处理——决策问题不得让会话起不来）。
	 */
	trustOverride(input: { readonly hostId: string; readonly remoteRoot: string }): Promise<"approve" | "no-approve" | undefined>;
	/** 渲染层清单：已解码条目 + 主机显示名 + 每条现在是否仍然有效。 */
	list(): Promise<RemoteProjectTrustEntry[]>;
	/** 记录一条决策（同一 host+根覆盖旧条目）；拿不到可核验 endpoint 时抛稳定码。 */
	decide(input: { readonly hostId: string; readonly remoteRoot: string; readonly decision: RemoteProjectTrustDecision }): Promise<RemoteProjectTrustEntry>;
	/** 撤销某 (host, 项目根) 的决策；返回是否真的删掉了东西。 */
	revoke(input: { readonly hostId: string; readonly remoteRoot: string }): Promise<boolean>;
	/** 主机退役清理（接在主机目录退役/pin 清理同一位置）。 */
	forgetHost(hostId: string): Promise<void>;
};

export function createRemoteProjectTrustService(input: {
	readonly settings: RemoteProjectTrustSettingsPort;
	readonly hostFacts: RemoteProjectTrustHostFactsPort;
	/** 注入时钟便于审计断言；缺省系统时间。 */
	readonly now?: () => number;
}): RemoteProjectTrustService {
	const now = input.now ?? (() => Date.now());

	/** 现读配置 + 现读主机目录；主机目录读不出来时返回空目录（=「这台主机的事实不存在」）。 */
	async function snapshot(): Promise<{ records: RemoteProjectTrustRecord[]; catalog: RemoteProjectTrustHostCatalog | undefined }> {
		const records = normalizeRemoteProjectTrustRecords(input.settings.read());
		let catalog: RemoteProjectTrustHostCatalog | undefined;
		try {
			catalog = await input.hostFacts.catalog();
		} catch {
			// 端口本身不该抛（实现里已折叠），这里是第二道防线：拿不到事实 = 不可判定。
			catalog = undefined;
		}
		return { records, catalog };
	}

	function endpointOf(catalog: RemoteProjectTrustHostCatalog | undefined, hostId: string): RemoteEndpointIdentityInput | undefined {
		return catalog?.hosts.find((host) => host.hostId === hostId)?.endpoint;
	}

	return {
		async trustOverride({ hostId, remoteRoot }) {
			const { records, catalog } = await snapshot();
			return remoteProjectTrustOverride(evaluateRemoteProjectTrust({ records, hostId, remoteRoot, endpointIdentity: endpointOf(catalog, hostId) }));
		},

		async list() {
			const { records, catalog } = await snapshot();
			// 对账只在目录可信时做（needs-repair 的 profiles 是回退视图，拿它删条目会误删仍存在主机的决策）。
			const live = new Set(catalog?.hosts.map((host) => host.hostId) ?? []);
			const reconciled = catalog?.complete ? reconcileRemoteProjectTrustHosts(records, { live, retired: new Set(catalog.retired) }) : { records, changed: false };
			if (reconciled.changed) await input.settings.write(reconciled.records);
			return reconciled.records.map((record) =>
				remoteProjectTrustEntryView({
					record,
					// 目录读不出来时只剩 hostId 可展示：不编造名字，也不因此隐藏这条已存在的决策。
					hostLabel: catalog?.hosts.find((host) => host.hostId === record.hostId)?.label ?? record.hostId,
					endpointIdentity: endpointOf(catalog, record.hostId),
				}),
			);
		},

		async decide({ hostId, remoteRoot, decision }) {
			const { records, catalog } = await snapshot();
			const decidedAt = new Date(now()).toISOString();
			const next = writeRemoteProjectTrustDecision({ records, hostId, remoteRoot, endpointIdentity: endpointOf(catalog, hostId), decision, decidedAt });
			await input.settings.write(next);
			const record = next[next.length - 1];
			return remoteProjectTrustEntryView({
				record,
				hostLabel: catalog?.hosts.find((host) => host.hostId === hostId)?.label ?? hostId,
				endpointIdentity: endpointOf(catalog, hostId),
			});
		},

		async revoke({ hostId, remoteRoot }) {
			// 撤销/清理只读写决策表本身，不需要主机事实（少一次目录读，也没有「材料缺失就不能撤销」这种怪事）。
			const result = removeRemoteProjectTrust({ records: normalizeRemoteProjectTrustRecords(input.settings.read()), hostId, remoteRoot });
			if (result.removed) await input.settings.write(result.records);
			return result.removed;
		},

		async forgetHost(hostId) {
			const result = forgetRemoteProjectTrustHost(normalizeRemoteProjectTrustRecords(input.settings.read()), hostId);
			if (result.changed) await input.settings.write(result.records);
		},
	};
}
