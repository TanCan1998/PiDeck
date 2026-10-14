import { lazy, Suspense, useState } from "react";
import { ArrowLeft, LoaderCircle, RefreshCw } from "lucide-react";
import type { RemoteProject } from "../../../../shared/types/project";
import type { GitResourceGroupType } from "../../../../shared/types/git";
import { useRemoteGitView } from "../../hooks/useRemoteGitView";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { FileTree } from "../app/git/GitResourceTree";
import { RemoteGitTrustGate } from "./RemoteGitTrustGate";

const FileDiffViewer = lazy(() => import("../app/FileDiffViewer").then((module) => ({ default: module.FileDiffViewer })));
const GROUPS: GitResourceGroupType[] = ["merge", "index", "workingTree", "untracked"];
const GROUP_LABELS = { merge: "remoteGit.merge", index: "remoteGit.index", workingTree: "remoteGit.workingTree", untracked: "remoteGit.untracked" } as const;
const refuseFallbackRead = async (): Promise<string> => {
	throw new Error("GIT_RESOURCE_CHANGED");
};

/** Only stable categories are rendered; invoke wrappers, remote paths and raw stderr are never user-facing. */
export function remoteGitErrorMessage(code: string): string {
	if (code === "GIT_TRUST_REQUIRED") return t("remoteGit.trustRequired");
	if (code === "GIT_NOT_REPOSITORY") return t("remoteGit.notRepository");
	if (code === "GIT_NOT_FOUND" || code === "GIT_VERSION_UNSUPPORTED") return t("remoteGit.gitUnavailable");
	if (code === "GIT_UNSUPPORTED_REPOSITORY" || code === "GIT_CONFIG_UNSUPPORTED" || code === "GIT_PLATFORM_UNSUPPORTED" || code === "UNSUPPORTED_CAPABILITY") return t("remoteGit.unsupported");
	if (code === "GIT_NOT_TEXT" || code === "NOT_A_FILE") return t("remoteGit.notText");
	if (code === "RESULT_TOO_LARGE") return t("remoteGit.tooLarge");
	if (code === "GIT_RESOURCE_CHANGED" || code === "GIT_TARGET_CHANGED") return t("remoteGit.changed");
	if (code === "PERMISSION_DENIED") return t("remoteGit.permission");
	if (code.startsWith("SSH_") || code === "REMOTE_CONNECTION_LOST" || code === "REMOTE_FEATURE_DISABLED") return t("remoteGit.connection");
	if (code === "REQUEST_TIMEOUT" || code === "TOO_MANY_REQUESTS") return t("remoteGit.timeout");
	return t("remoteGit.failed");
}

/** Reuses SCM rows and the existing diff renderer without native graph/watch/write/background-sync APIs. */
export function RemoteGitPanel({ project }: { project: RemoteProject }) {
	const { state, refresh, openDiff, closeDiff } = useRemoteGitView(project);
	const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
	const snapshot = state.snapshot;
	const viewingDiff = state.diffLoading || state.diff !== undefined || state.diffErrorCode !== undefined;
	return (
		<div data-testid="remote-git-panel" data-project-id={project.id} className="flex min-h-0 flex-1 flex-col overflow-hidden text-sm text-text-primary">
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
				{viewingDiff ? (
					<Button variant="ghost" size="icon-sm" onClick={closeDiff} disabled={state.diffLoading} aria-label={t("remoteGit.back")}>
						<ArrowLeft size={14} />
					</Button>
				) : null}
				<span className="min-w-0 flex-1 truncate font-medium">{t("remoteGit.title")}</span>
				<Button variant="ghost" size="icon-sm" onClick={refresh} disabled={state.loading || state.diffLoading} aria-label={t("remoteGit.refresh")}>
					<RefreshCw size={14} />
				</Button>
			</div>
			<p className="shrink-0 border-b border-border px-3 py-2 text-xs text-text-secondary">{t("remoteGit.readOnly")}</p>
			{state.loading || state.diffLoading ? (
				<div role="status" className="flex items-center gap-2 p-3 text-text-secondary">
					<LoaderCircle size={14} className="animate-spin" />
					{t("remoteGit.loading")}
				</div>
			) : null}
			{state.errorCode ? (
				<p role="alert" className="p-3 text-danger">
					{remoteGitErrorMessage(state.errorCode)}
				</p>
			) : null}
			{state.errorCode === "GIT_TRUST_REQUIRED" ? <RemoteGitTrustGate project={project} onApproved={refresh} /> : null}
			{state.diffErrorCode ? (
				<p role="alert" className="p-3 text-danger">
					{remoteGitErrorMessage(state.diffErrorCode)}
				</p>
			) : null}
			{state.diff && !state.diffLoading ? (
				<>
					{state.diffGroup === "merge" ? <p className="shrink-0 px-3 py-2 text-xs text-text-secondary">{t("remoteGit.conflictBaseline")}</p> : null}
					<div data-testid="remote-git-diff" className="flex min-h-0 flex-1 flex-col overflow-hidden">
						<Suspense fallback={<p className="p-3">{t("remoteGit.loading")}</p>}>
							<FileDiffViewer
								key={JSON.stringify([state.diff.target, state.diffGroup])}
								filePath={state.diff.displayPath}
								fileTarget={state.diff.target}
								mode="diff"
								displayMode="drawer"
								originalContent={state.diff.originalContent}
								modifiedContent={state.diff.modifiedContent}
								readContent={refuseFallbackRead}
								onClose={closeDiff}
							/>
						</Suspense>
					</div>
				</>
			) : snapshot && !viewingDiff ? (
				<div className="min-h-0 flex-1 overflow-y-auto py-2">
					<p data-testid="remote-git-branch" className="px-3 pb-2 text-xs text-text-secondary">
						{snapshot.branch ?? t("remoteGit.detached")}
						{snapshot.head === null ? ` · ${t("remoteGit.unborn")}` : ""}
					</p>
					{GROUPS.every((group) => snapshot.groups[group].length === 0) ? <p className="px-3 text-text-secondary">{t("remoteGit.clean")}</p> : null}
					{GROUPS.map((group) =>
						snapshot.groups[group].length ? (
							<section key={group} data-testid={`remote-git-${group}`} className="pb-2">
								<h3 className="px-3 py-1 text-xs font-medium text-text-secondary">
									{t(GROUP_LABELS[group])} ({snapshot.groups[group].length})
								</h3>
								<FileTree
									readOnly
									resources={snapshot.groups[group]}
									groupType={group}
									mutating={false}
									collapsedDirs={collapsedDirs}
									onToggleDir={(directory) =>
										setCollapsedDirs((current) => {
											const next = new Set(current);
											if (next.has(directory)) next.delete(directory);
											else next.add(directory);
											return next;
										})
									}
									onOpenWorkspaceFileDiff={openDiff}
								/>
							</section>
						) : null,
					)}
				</div>
			) : null}
		</div>
	);
}
