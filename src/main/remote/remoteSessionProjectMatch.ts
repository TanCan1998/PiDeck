/**
 * 远端会话的**项目归属**判定：这条会话文件落在哪个项目的远端目录下。
 *
 * 为什么必须单独判定：扫描器发现的路径是相对**会话根**的（默认布局下形如 `<encoded-cwd>/<file>.jsonl`），
 * 而同一台主机上可以有多个 ssh 项目。按「该主机上列表里第一个 ssh 项目」归属会忽略会话目录，
 * 因此对标准布局按编码匹配，对无法判定的多项目情况拒绝猜测。
 * 注意：归属判定不负责侧栏刷新；目录读取接口和记录投影也必须支持 SSH 会话才能显示导入结果。
 *
 * 编码规则取自 pi 1.0.4 `dist/core/session-manager.js:286-295`：
 *   `"--" + resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--"`
 * 本地复刻它的唯一目的是与会话目录名对齐；一旦不一致，表现为「判不出归属」（fail-closed），而不是错归属。
 */
export function encodePiSessionDirectory(posixPath: string): string {
	return `--${posixPath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 会话路径的第一段（默认布局下就是 encoded-cwd）；自定义 sessionDir 是平铺的，没有这一段。 */
function firstSegment(remoteSessionId: string): string | undefined {
	const index = remoteSessionId.indexOf("/");
	if (index <= 0) return undefined;
	return remoteSessionId.slice(0, index);
}

export type RemoteSessionProjectCandidate = { readonly id: string; readonly remotePath: string };

/**
 * 判定会话属于哪个项目；**判不出来就返回 undefined**（调用方以既有稳定码 fail-closed），绝不猜。
 *
 * - 编码后唯一命中 ⇒ 该项目；
 * - 没命中但候选只有一个 ⇒ 用它（单项目场景维持旧行为，不因编码差异退化）；
 * - 其余（多候选判不出、多命中）⇒ undefined。
 */
export function matchRemoteSessionProject(candidates: readonly RemoteSessionProjectCandidate[], remoteSessionId: string): string | undefined {
	const segment = firstSegment(remoteSessionId);
	const matched = segment === undefined ? [] : candidates.filter((candidate) => encodePiSessionDirectory(candidate.remotePath) === segment);
	if (matched.length === 1) return matched[0].id;
	if (matched.length > 1) return undefined;
	return candidates.length === 1 ? candidates[0].id : undefined;
}
