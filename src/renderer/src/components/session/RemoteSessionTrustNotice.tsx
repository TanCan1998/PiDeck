import { useAtomValue } from "jotai";
import { ShieldAlert } from "lucide-react";
import { sessionRemoteTrustUnhandledAtomFamily } from "../../atoms/session-selectors";
import { t } from "../../i18n";

/**
 * 远端会话的 trust 现状提示条（Phase 4 P4.2 收口第 1 项）。
 *
 * 为什么需要它：本地会话的 trust 由 PiDeck 处理（`AgentManager.ensureProjectTrust` +
 * `--approve/--no-approve`），远端会话没有这套——远端 pi 的项目资源是否加载由远端
 * `~/.pi/agent/settings.json` 的 `defaultProjectTrust` 决定，而 RPC 模式 `project_trust`
 * 事件 `hasUI=false`，项目目录里的 `.pi` 资源（扩展/技能/提示词/项目设置）因此不会被信任加载。
 * 完整远端 trust 语义（hostId + endpoint identity + canonical remote path 的统一 trust key）属 P4.4。
 *
 * 所以这里只做**如实告知**：安全默认一字不改（不传 trust flag、不写 `--approve`、不放宽任何边界）。
 * 提示常驻（不是一次性 toast、也不只在错误态出现），与 SessionBranchBar 同一层级挂在会话头下方；
 * 标记缺失（本地/WSL 会话，或旧 main 的旧 payload）时整体不渲染——不显示，也不报错。
 */
export function RemoteSessionTrustNotice(props: { sessionId: string }) {
	const remoteTrustUnhandled = useAtomValue(sessionRemoteTrustUnhandledAtomFamily(props.sessionId));
	if (!remoteTrustUnhandled) return null;
	return (
		<div role="status" data-testid="remote-session-trust-notice" className="flex min-w-0 items-start gap-2 border-b border-border-subtle bg-bg-panel px-3 py-1.5 text-caption">
			<ShieldAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
			{/* 标题与说明同一行：标题点明状态，说明给出「为什么不加载 + 边界没放宽」。 */}
			<span className="shrink-0 font-medium text-foreground">{t("session.remoteTrust.title")}</span>
			<span className="min-w-0 text-muted-foreground">{t("session.remoteTrust.hint")}</span>
		</div>
	);
}
