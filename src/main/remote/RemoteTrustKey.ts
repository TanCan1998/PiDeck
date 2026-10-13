/**
 * 远端 trust 的 key（P4.4a）。
 *
 * 为什么单独立模块：trust 的判定对象是「某个主机的某个远端项目根」，而三样材料分别来自不同层——hostId 来自主机档案、
 * endpoint 身份来自**已验证的 SSH endpoint**（pin），项目根来自项目 locator。key 一旦允许各处各拼一次，迟早出现
 * 「按 A 存、按 B 查」的静默失效（远端路径的相对/绝对双形态就是现成的坑）。集中定义 + 纯函数，可单测。
 *
 * 边界（P4.4a）：本模块**只计算身份**，不读配置、不改变任何传给远端 pi 的参数——「是否把 trust 传给 pi」属 P4.4b，
 * 需单独授权（那等于决定远端项目 `.pi` 资源是否被执行）。
 */
import { createHash } from "node:crypto";

/** 只取判定需要的字段：pin 的密码学事实 + 路由事实。刻意不要求具体类型，便于用测试替身直接驱动。 */
export type RemoteEndpointIdentityInput = {
	hostName?: string;
	user?: string;
	port?: number;
	pinAlias?: string;
	routeDigest?: string;
	knownHostsSha256?: string;
	hostKeyFingerprints?: readonly string[];
};

/**
 * endpoint 身份：pin 的**密码学事实**（route 摘要 / known_hosts 摘要 / 主机密钥指纹）+ 路由事实（hostName/user/port）。
 *
 * 缺任一密码学事实就返回 undefined ⇒ **没有可核验的 endpoint 就没有 trust 判定**（fail-closed）：绝不退化成
 * 「按主机名/用户猜一个身份」，否则指纹变了还能命中旧信任。指纹集合排序后参与，消除顺序差异。
 */
export function remoteEndpointIdentity(endpoint: RemoteEndpointIdentityInput | undefined): string | undefined {
	if (!endpoint) return undefined;
	const fingerprints = Array.isArray(endpoint.hostKeyFingerprints) ? [...endpoint.hostKeyFingerprints].sort() : [];
	const hasCryptoFact = Boolean(endpoint.routeDigest || endpoint.knownHostsSha256 || fingerprints.length > 0);
	if (!hasCryptoFact) return undefined;
	const parts = [
		endpoint.routeDigest ? `route:${endpoint.routeDigest}` : undefined,
		endpoint.knownHostsSha256 ? `known:${endpoint.knownHostsSha256}` : undefined,
		fingerprints.length > 0 ? `fp:${fingerprints.join(",")}` : undefined,
		endpoint.hostName ? `host:${endpoint.hostName.toLowerCase()}` : undefined,
		endpoint.user ? `user:${endpoint.user}` : undefined,
		typeof endpoint.port === "number" ? `port:${endpoint.port}` : undefined,
	].filter((part): part is string => typeof part === "string");
	return parts.length > 0 ? parts.join("|") : undefined;
}

/**
 * 规范远端项目根：必须**绝对**、去尾斜杠、折叠 `.`/`..`；含单引号/控制字符或相对路径一律拒绝。
 *
 * 为什么这么严：远端路径最终要进单引号字面量（见 SSH 读取侧），且**相对路径在远端 pi 与读取侧有多种解释**
 * （`SessionCatalog` 里 `remotePath` 就有「pi 上报的绝对路径」与「相对会话根」两种形态）。trust 判定的对象必须是
 * 无歧义的绝对项目根，否则会出现「同名相对路径在两个项目下被当成同一个 trust」。
 */
export function canonicalRemoteRoot(raw: string | undefined): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed.startsWith("/")) return undefined;
	if (trimmed.includes("'") || trimmed.includes("\n") || trimmed.includes("\0")) return undefined;
	const withoutTrailing = trimmed.replace(/\/+$/, "");
	const segments: string[] = [];
	for (const segment of withoutTrailing.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return "/" + segments.join("/");
}

/**
 * endpoint 身份摘要：`sha256(endpoint 身份)` 的前 32 位 hex。
 *
 * 为什么单独导出：trust key 只是它的一个消费者——持久化记录还要把摘要与 hostId / 项目根并列存下来，
 * 才能回答「同 host + 同根但 endpoint 变了」并说明「已作废」。摘要只允许留在主进程（见 shared/types/remoteTrust 的边界说明）。
 */
export function remoteEndpointDigest(endpointIdentity: string | undefined): string | undefined {
	if (!endpointIdentity) return undefined;
	return createHash("sha256").update(endpointIdentity, "utf8").digest("hex").slice(0, 32);
}

/**
 * trust key = `hostId::sha256(endpoint 身份)::规范项目根`。
 *
 * 任一材料缺失 ⇒ undefined（「不可判定」，调用方必须按未决策 / fail-closed 处理，不得当成"已信任"）。
 * endpoint 部分取摘要：它是 pin 的密码学事实（长串），摘要进配置文件更好读；hostId 与项目根保持明文便于排障。
 */
export function remoteTrustKey(input: { hostId: string | undefined; endpointIdentity: string | undefined; remoteRoot: string | undefined }): string | undefined {
	const hostId = typeof input.hostId === "string" ? input.hostId.trim() : "";
	const root = canonicalRemoteRoot(input.remoteRoot);
	const endpointDigest = remoteEndpointDigest(input.endpointIdentity);
	if (!hostId || !endpointDigest || !root) return undefined;
	return `${hostId}::${endpointDigest}::${root}`;
}
