import { Cloud, Monitor } from "lucide-react";
import type { PiConfigTarget } from "../../../shared/piConfig";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../components/ui-shadcn/select";
import { t } from "../i18n";

/** One verified remote host the target selector may offer (never disabled/unverified hosts). */
export type PiConfigTargetHost = { id: string; label: string; sshHost: string };

/**
 * Local vs verified-ssh target selector for the models/settings configuration surfaces (Batch B).
 * It only shapes the target value; the owner (ConfigModal/remote panel) decides whether a dirty remote draft
 * needs an explicit discard confirmation before the value changes.
 */
export function PiConfigTargetSelector(props: { target: PiConfigTarget; hosts: PiConfigTargetHost[]; disabled?: boolean; onChange: (target: PiConfigTarget) => void }) {
	const value = props.target.kind === "ssh" ? "ssh:" + props.target.hostId : "local";
	const target = props.target;
	const selectedHost = target.kind === "ssh" ? props.hosts.find((host) => host.id === target.hostId) : undefined;
	const remote = target.kind === "ssh";
	return (
		<div className="config-target-bar flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2" data-testid="config-target-bar">
			<span className="text-micro font-medium text-muted-foreground">{t("config.target.label")}</span>
			<Select
				value={value}
				disabled={props.disabled}
				onValueChange={(next) => {
					if (next === "local") {
						props.onChange({ kind: "local" });
						return;
					}
					if (next.startsWith("ssh:")) props.onChange({ kind: "ssh", hostId: next.slice(4) });
				}}
			>
				<SelectTrigger className="h-8 w-auto min-w-[10rem] max-w-full gap-1.5 px-2.5 text-control" data-testid="config-target-selector" aria-label={t("config.target.label")}>
					<span className="flex min-w-0 items-center gap-1.5">
						{remote ? <Cloud className="size-3.5 shrink-0" aria-hidden="true" /> : <Monitor className="size-3.5 shrink-0" aria-hidden="true" />}
						<span className="truncate">{remote ? (selectedHost?.label ?? t("config.target.unknownHost")) : t("config.target.local")}</span>
					</span>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="local" data-testid="config-target-local">
						<span className="flex items-center gap-1.5">
							<Monitor className="size-3.5" aria-hidden="true" />
							{t("config.target.local")}
						</span>
					</SelectItem>
					{props.hosts.map((host) => (
						<SelectItem key={host.id} value={"ssh:" + host.id} data-testid={"config-target-ssh-" + host.id}>
							<span className="flex min-w-0 items-center gap-1.5">
								<Cloud className="size-3.5 shrink-0" aria-hidden="true" />
								<span className="truncate">{host.label}</span>
								<span className="truncate font-mono text-micro text-muted-foreground">{host.sshHost}</span>
							</span>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{remote ? (
				<span className="ml-auto flex items-center gap-1.5 text-micro text-muted-foreground" data-testid="config-target-remote-hint">
					<Cloud className="size-3.5" aria-hidden="true" />
					{t("config.target.remoteHint")}
				</span>
			) : null}
			{!remote && props.hosts.length === 0 ? <span className="text-micro text-muted-foreground">{t("config.target.noHosts")}</span> : null}
		</div>
	);
}
