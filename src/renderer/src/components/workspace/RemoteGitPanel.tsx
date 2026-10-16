import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft, LoaderCircle, RefreshCw } from "lucide-react";
import type { RemoteProject } from "../../../../shared/types/project";
import type { GitResourceGroupType } from "../../../../shared/types/git";
import { useRemoteGitView } from "../../hooks/useRemoteGitView";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Textarea } from "../ui-shadcn/textarea";
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
	if (code === "GIT_INDEX_LOCKED") return t("remoteGit.indexLocked");
	if (code === "GIT_COMMIT_NOTHING_STAGED") return t("remoteGit.nothingStaged");
	if (code === "GIT_COMMIT_MESSAGE_EMPTY") return t("remoteGit.messageEmpty");
	if (code === "GIT_COMMIT_IDENTITY_REQUIRED") return t("remoteGit.identityRequired");
	if (code === "GIT_COMMIT_HEAD_CHANGED") return t("remoteGit.headChanged");
	if (code === "GIT_WRITE_UNSUPPORTED") return t("remoteGit.writeUnsupported");
	if (code === "GIT_WRITE_RESULT_UNCONFIRMED") return t("remoteGit.writeUnknown");
	if (code === "GIT_WRITE_SNAPSHOT_EXPIRED") return t("remoteGit.writeExpired");
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
	const { state, refresh, openDiff, closeDiff, mutate, commit } = useRemoteGitView(project);
	const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
	const [message, setMessage] = useState("");
	const confirmedCommits = state.confirmedCommits ?? 0;
	// A confirmed commit clears the box; a refusal or an unknown result keeps the text so nothing is retyped.
	useEffect(() => {
		if (confirmedCommits > 0) setMessage("");
	}, [confirmedCommits]);
	const snapshot = state.snapshot;
	const viewingDiff = state.diffLoading || state.diff !== undefined || state.diffErrorCode !== undefined;
	const busy = state.loading || state.diffLoading || state.mutating;
	const messageBytes = new TextEncoder().encode(message).length;
	const canCommit = snapshot?.commitToken !== undefined && !busy && message.trim().length > 0 && messageBytes <= 4096;
	return (
		<div data-testid="remote-git-panel" data-project-id={project.id} className="flex min-h-0 flex-1 flex-col overflow-hidden text-sm text-text-primary">
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
				{viewingDiff ? (
					<Button variant="ghost" size="icon-sm" onClick={closeDiff} disabled={state.diffLoading || state.mutating} aria-label={t("remoteGit.back")}>
						<ArrowLeft size={14} />
					</Button>
				) : null}
				<span className="min-w-0 flex-1 truncate font-medium">{t("remoteGit.title")}</span>
				<Button variant="ghost" size="icon-sm" onClick={refresh} disabled={state.loading || state.diffLoading || state.mutating} aria-label={t("remoteGit.refresh")}>
					<RefreshCw size={14} />
				</Button>
			</div>
			<p className="shrink-0 border-b border-border px-3 py-2 text-xs text-text-secondary">{t(snapshot?.mutationToken ? "remoteGit.managedIndex" : "remoteGit.readOnly")}</p>
			{snapshot && !viewingDiff ? (
				<div className="shrink-0 space-y-2 border-b border-border px-3 py-2">
					<Textarea data-testid="remote-git-commit-message" aria-label={t("remoteGit.commitMessage")} placeholder={t("remoteGit.commitPlaceholder")} value={message} rows={2} disabled={busy || snapshot.commitToken === undefined} onChange={(event) => setMessage(event.target.value)} />
					<div className="flex items-center gap-2">
						<Button type="button" size="sm" disabled={!canCommit} onClick={() => commit(message)}>
							{t("remoteGit.commitAction")}
						</Button>
						{messageBytes > 0 ? <span className="text-xs text-text-secondary">{messageBytes}/4096</span> : null}
					</div>
					<p className="text-xs text-text-secondary">{t("remoteGit.commitHint")}</p>
				</div>
			) : null}
			{state.loading || state.diffLoading || state.mutating ? (
				<div role="status" className="flex items-center gap-2 p-3 text-text-secondary">
					<LoaderCircle size={14} className="animate-spin" />
					{t(state.mutating ? (state.mutatingKind === "commit" ? "remoteGit.committing" : "remoteGit.writing") : "remoteGit.loading")}
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
									readOnly={!snapshot.mutationToken}
									indexActionsOnly
									stageFile={(target) => mutate("stage", group, target)}
									unstageFile={(target) => mutate("unstage", group, target)}
									resources={snapshot.groups[group]}
									groupType={group}
									mutating={!!state.mutating}
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
