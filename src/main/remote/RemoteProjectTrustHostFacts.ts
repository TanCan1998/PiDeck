/**
 * 远端项目 trust 的材料来源：把**已确认的主机目录**读成 trust 判定需要的形状（P4.4b）。
 *
 * 边界（本批最重要的一条）：
 * - endpoint 身份只取**既有 pin 事实**——`openRemoteHostCatalogView` 读到的主机档案里的 `verifiedEndpoint`
 *   （激活时由 `SshHostPinStore.answer()` 发布、并在每次目录加载时用 `readPin` 复核过 pin 文件）。
 *   本模块**不新增**任何 SSH 通道、不自建 pin 读取、不绕过指纹校验。
 * - 「主机目录可读」与「目录可信」是两件事：`complete` 表示这份目录可以用来**删**条目（对账），
 *   只有 `ready` 才算。needs-repair 下的 profiles 可能是回退/不完整视图，拿它当「主机没了」会误删决策。
 * - 读不出来（文件损坏、权限、解析失败）一律返回 undefined：调用方据此 fail-closed（不清理、不传 flag），
 *   而不是把「读不出」当成「没有主机」。
 */
import type { RemoteEndpointIdentityInput } from "./RemoteTrustKey";
import { openRemoteHostCatalogView } from "./RemoteHostCatalogView";

/** 目录里一台主机对 trust 判定可见的事实。 */
export type RemoteProjectTrustHost = {
	readonly hostId: string;
	/** 显示名（label 可改；不参与 trust 身份）。 */
	readonly label: string;
	/** 已确认 endpoint 的 pin 事实；未验证 / 快照缺字段时为 undefined（不可判定）。 */
	readonly endpoint?: RemoteEndpointIdentityInput;
};

export type RemoteProjectTrustHostCatalog = {
	readonly hosts: readonly RemoteProjectTrustHost[];
	readonly retired: readonly string[];
	/** true 表示这份目录足以支撑「删条目」的对账；false（needs-repair）时调用方只读不删。 */
	readonly complete: boolean;
};

export type RemoteProjectTrustHostFactsPort = {
	/** 当前目录事实；读不出来返回 undefined（fail-closed，绝不返回空目录冒充「没有主机」）。 */
	catalog(): Promise<RemoteProjectTrustHostCatalog | undefined>;
};

/**
 * 只挑 trust 判定用到的字段：`verifiedEndpoint` 上若将来多出别的事实，也不会顺着这个类型悄悄流进 trust。
 * 缺任一字段由 `remoteEndpointIdentity` 自己判（密码学事实缺失 ⇒ 不可判定），这里不做第二套校验。
 */
function endpointIdentity(endpoint: { hostName: string; user: string; port: number; pinAlias: string; routeDigest: string; knownHostsSha256: string; hostKeyFingerprints: readonly string[] }): RemoteEndpointIdentityInput {
	return {
		hostName: endpoint.hostName,
		user: endpoint.user,
		port: endpoint.port,
		pinAlias: endpoint.pinAlias,
		routeDigest: endpoint.routeDigest,
		knownHostsSha256: endpoint.knownHostsSha256,
		hostKeyFingerprints: [...endpoint.hostKeyFingerprints],
	};
}

export function createRemoteProjectTrustHostFacts(input: { readonly userDataDir: string }): RemoteProjectTrustHostFactsPort {
	return {
		async catalog(): Promise<RemoteProjectTrustHostCatalog | undefined> {
			try {
				// 与 `remote:hosts-list` 同一个只读入口（同一份 pin 复核）：trust 不该有第二条读主机的路。
				// 这里刻意不注入主机退役钩子：退役时的清理由主机目录那条路触发（见 index.ts 装配），
				// 本读取只负责「把事实读出来」，「主机没了要删条目」由 list() 的可信对账兜底。
				const view = await openRemoteHostCatalogView(input.userDataDir);
				return {
					hosts: view.snapshot.profiles.map((profile) => ({
						hostId: profile.id,
						label: profile.label,
						...(profile.verifiedEndpoint === undefined ? {} : { endpoint: endpointIdentity(profile.verifiedEndpoint) }),
					})),
					retired: [...view.snapshot.retiredHostIds],
					complete: view.snapshot.status === "ready",
				};
			} catch {
				return undefined;
			}
		},
	};
}
