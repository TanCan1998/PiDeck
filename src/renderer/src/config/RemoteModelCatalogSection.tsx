import { AlertTriangle, Boxes, RefreshCw } from "lucide-react";
import { useReducer } from "react";
import { REMOTE_MODEL_PROBE_CODES } from "../../../shared/types/remoteModel";
import { REMOTE_CONFIG_CODES } from "../../../shared/piConfig";
import { Button } from "../components/ui-shadcn/button";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { formatModelTokenCount, groupRemoteModelsByProvider, initialRemoteModelCatalogState, reduceRemoteModelCatalog, remoteModelProbeErrorKey } from "./remoteModelCatalogModel";

/**
 * Remote provider model catalog v1 action (Phase 5 row 819), shown only in the remote models panel.
 *
 * The button triggers ONE bounded host probe: main resolves the host's remote projects and a live remote pi
 * runtime, then returns the masked catalog. The per-provider synthetic HTTP probe and usage query stay
 * disabled by v1 contract; the copy says so instead of implying a provider connection was tested directly.
 */
export function RemoteModelCatalogSection(props: { hostId: string }) {
	const [state, dispatch] = useReducer(reduceRemoteModelCatalog, initialRemoteModelCatalogState);
	const loading = state.phase === "loading";
	const groups = state.phase === "ready" ? groupRemoteModelsByProvider(state.models) : [];

	const runProbe = async () => {
		if (loading) return;
		dispatch({ type: "started" });
		try {
			const result = await desktopApi.probeRemoteModels(props.hostId);
			dispatch({ type: "succeeded", result });
		} catch {
			// The IPC contract normally returns structured codes; a transport rejection is presented as unavailable.
			dispatch({ type: "failed", code: REMOTE_MODEL_PROBE_CODES.unavailable });
		}
	};

	return (
		<div className="flex shrink-0 flex-col gap-2 rounded-md border border-border-subtle bg-bg-panel px-3 py-2" data-testid="remote-model-catalog" data-phase={state.phase}>
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex min-w-0 flex-col">
					<span className="text-micro font-medium text-muted-foreground">{t("remoteModel.title")}</span>
					<span className="text-micro text-muted-foreground">{t("remoteModel.probeHint")}</span>
				</div>
				<Button type="button" variant="outline" size="sm" className="ml-auto h-8 gap-1.5" disabled={loading} onClick={() => void runProbe()} data-testid="remote-model-probe">
					<RefreshCw className={"size-3.5 " + (loading ? "animate-spin" : "")} aria-hidden="true" />
					{loading ? t("remoteModel.probing") : t("remoteModel.probeAction")}
				</Button>
			</div>

			{loading ? (
				<div className="py-2 text-center text-micro text-muted-foreground" data-testid="remote-model-probe-loading">
					{t("remoteModel.probing")}
				</div>
			) : null}

			{state.phase === "error" ? (
				<div className="flex flex-col gap-1 rounded-sm border border-danger/20 bg-danger-soft px-2.5 py-2" data-testid="remote-model-probe-error" data-code={state.code}>
					<div className="flex items-center gap-1.5 text-micro text-danger">
						<AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
						<span>{t(remoteModelProbeErrorKey(state.code ?? REMOTE_MODEL_PROBE_CODES.unavailable))}</span>
					</div>
					{state.code ? <code className="w-fit font-mono text-micro text-muted-foreground">{t("remoteConfig.errorCode", { code: state.code })}</code> : null}
				</div>
			) : null}

			{state.phase === "empty" ? (
				<div className="flex flex-col gap-1 text-micro text-muted-foreground" data-testid="remote-model-probe-empty" data-code={state.code}>
					<span className="flex items-center gap-1.5">
						<Boxes className="size-3.5 shrink-0" aria-hidden="true" />
						{t("remoteModel.empty")}
					</span>
					{state.code ? <code className="w-fit font-mono">{t("remoteConfig.errorCode", { code: state.code })}</code> : null}
				</div>
			) : null}

			{state.phase === "ready" ? (
				<div className="flex flex-col gap-2" data-testid="remote-model-providers">
					<span className="text-micro text-muted-foreground" data-testid="remote-model-probe-summary">
						{t("remoteModel.readySummary", { count: state.count, providers: groups.length })}
					</span>
					{groups.map((group) => (
						<section key={group.provider} className="flex flex-col gap-1" data-testid="remote-model-provider" data-provider={group.provider}>
							<div className="flex items-baseline gap-1.5">
								<span className="text-micro font-medium text-foreground/90">{group.provider}</span>
								<span className="text-micro text-muted-foreground" data-testid="remote-model-provider-count">
									{t("remoteModel.providerCount", { count: group.models.length })}
								</span>
							</div>
							<ul className="grid gap-0.5">
								{group.models.map((model) => (
									<li key={model.provider + "\u0000" + model.id} className="flex flex-wrap items-baseline gap-1.5 text-micro" data-testid="remote-model-entry" data-provider={model.provider} data-model-id={model.id}>
										<span className="font-medium text-foreground/90">{model.name ?? model.id}</span>
										{model.name && model.name !== model.id ? <code className="font-mono text-muted-foreground">{model.id}</code> : null}
										{model.contextWindow !== undefined ? <span className="text-muted-foreground">{t("remoteModel.contextWindow", { tokens: formatModelTokenCount(model.contextWindow) })}</span> : null}
										{model.maxTokens !== undefined ? <span className="text-muted-foreground">{t("remoteModel.maxTokens", { tokens: formatModelTokenCount(model.maxTokens) })}</span> : null}
										{model.reasoning ? <span className="rounded-sm bg-bg-input px-1 text-muted-foreground">{t("remoteModel.reasoning")}</span> : null}
										{model.images || model.input?.includes("image") ? <span className="rounded-sm bg-bg-input px-1 text-muted-foreground">{t("remoteModel.vision")}</span> : null}
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			) : null}

			<div className="flex flex-col gap-1 border-t border-border-subtle pt-1.5" data-testid="remote-model-deferred">
				<span className="text-micro text-muted-foreground">{t("remoteModel.deferredNote")}</span>
				<code className="w-fit font-mono text-micro text-muted-foreground">{REMOTE_CONFIG_CODES.providerOperationUnsupported}</code>
			</div>
		</div>
	);
}
