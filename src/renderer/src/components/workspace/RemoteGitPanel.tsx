import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft, LoaderCircle, RefreshCw } from "lucide-react";
import type { RemoteProject } from "../../../../shared/types/project";
import type { GitResourceGroupType } from "../../../../shared/types/git";
import { useRemoteGitView } from "../../hooks/useRemoteGitView";
import { t } from "../../i18n";
import { relativeTimeParts } from "../../utils/providerUsageDisplay";
import { validRemoteGitBranchName } from "../../utils/remoteGitViewState";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { FileTree } from "../app/git/GitResourceTree";
import { RemoteGitTrustGate } from "./RemoteGitTrustGate";

const FileDiffViewer = lazy(() => import("../app/FileDiffViewer").then((module) => ({ default: module.FileDiffViewer })));
const GROUPS: GitResourceGroupType[] = ["merge", "index", "workingTree", "untracked"];
const GROUP_LABELS = { merge: "remoteGit.merge", index: "remoteGit.index", workingTree: "remoteGit.workingTree", untracked: "remoteGit.untracked" } as const;
const refuseFallbackRead = async (): Promise<string> => {
	throw new Error("GIT_RESOURCE_CHANGED");
};
/** History rows carry the author and a relative time; the same vocabulary the usage panel already uses. */
function historyTime(seconds: number): string {
	const parts = relativeTimeParts(seconds * 1000);
	return t(parts.key, parts.params);
}

/** Only stable categories are rendered; invoke wrappers, remote paths and raw stderr are never user-facing. */
export function remoteGitErrorMessage(code: string): string {
	if (code === "GIT_INDEX_LOCKED") return t("remoteGit.indexLocked");
	if (code === "GIT_COMMIT_NOTHING_STAGED") return t("remoteGit.nothingStaged");
	if (code === "GIT_COMMIT_MESSAGE_EMPTY") return t("remoteGit.messageEmpty");
	if (code === "GIT_COMMIT_IDENTITY_REQUIRED") return t("remoteGit.identityRequired");
	if (code === "GIT_COMMIT_HEAD_CHANGED") return t("remoteGit.headChanged");
	if (code === "GIT_REF_EXISTS") return t("remoteGit.refExists");
	if (code === "GIT_REF_NOT_FOUND") return t("remoteGit.refNotFound");
	if (code === "GIT_SWITCH_CONFLICT") return t("remoteGit.switchConflict");
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
	const { state, refresh, openDiff, closeDiff, mutate, commit, loadHistory, loadMoreHistory, openCommitDetail, loadRefs, openHistoryFileDiff, createBranch, switchBranch } = useRemoteGitView(project);
	const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
	const [message, setMessage] = useState("");
	const [historyOpen, setHistoryOpen] = useState(false);
	const [refsOpen, setRefsOpen] = useState(false);
	const [newBranch, setNewBranch] = useState("");
	const confirmedCommits = state.confirmedCommits ?? 0;
	// A confirmed commit clears the box; a refusal or an unknown result keeps the text so nothing is retyped.
	useEffect(() => {
		if (confirmedCommits > 0) setMessage("");
	}, [confirmedCommits]);
	const snapshot = state.snapshot;
	// A const capture keeps the narrowed commit detail inside file-row closures.
	const detail = state.detail;
	const viewingDiff = state.diffLoading || state.diff !== undefined || state.diffErrorCode !== undefined;
	const busy = state.loading || state.diffLoading || state.mutating;
	const messageBytes = new TextEncoder().encode(message).length;
	const canCommit = snapshot?.commitToken !== undefined && !busy && message.trim().length > 0 && messageBytes <= 4096;
	const canCreateBranch = snapshot?.branchToken !== undefined && !busy && validRemoteGitBranchName(newBranch);
	const canSwitchBranch = snapshot?.switchToken !== undefined && !busy;
	// Expanding a section is the user action that loads it; an error stays until the header is clicked again.
	useEffect(() => {
		if (historyOpen && snapshot !== undefined && state.history === undefined && !state.historyLoading && state.historyErrorCode === undefined && !state.loading && !state.mutating) loadHistory();
	}, [historyOpen, snapshot, state.history, state.historyLoading, state.historyErrorCode, state.loading, state.mutating, loadHistory]);
	useEffect(() => {
		if (refsOpen && snapshot !== undefined && state.refs === undefined && !state.refsLoading && state.refsErrorCode === undefined && !state.loading && !state.mutating) loadRefs();
	}, [refsOpen, snapshot, state.refs, state.refsLoading, state.refsErrorCode, state.loading, state.mutating, loadRefs]);
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
					{/* G3a: history and refs are read-only sections; there is no checkout, branch, tag or push control anywhere below. */}
					<section data-testid="remote-git-history" className="pb-2">
						<button type="button" className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium text-text-secondary" aria-expanded={historyOpen} onClick={() => (historyOpen ? (state.historyErrorCode ? loadHistory() : setHistoryOpen(false)) : setHistoryOpen(true))}>
							{t("remoteGit.historyTitle")}
						</button>
						{historyOpen ? (
							<>
								<p className="px-3 pb-1 text-xs text-text-secondary">{t("remoteGit.historyReadOnly")}</p>
								{state.historyLoading ? <p className="px-3 text-xs text-text-secondary">{t("remoteGit.loading")}</p> : null}
								{state.historyErrorCode ? (
									<p role="alert" className="px-3 text-xs text-danger">
										{remoteGitErrorMessage(state.historyErrorCode)}
									</p>
								) : null}
								{state.history
									? state.history.commits.map((commit) => (
											<button
												key={commit.oid}
												type="button"
												data-testid="remote-git-history-row"
												data-oid={commit.oid}
												aria-current={state.detailOid === commit.oid || undefined}
												className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-surface-secondary"
												onClick={() => openCommitDetail(commit.oid)}
											>
												<span className="font-mono text-text-secondary">{commit.oid.slice(0, 8)}</span>
												<span className="min-w-0 flex-1 truncate">{commit.subject}</span>
												<span className="shrink-0 text-text-secondary">
													{commit.authorName} · {historyTime(commit.authorTimeSec)}
												</span>
											</button>
										))
									: null}
								{state.history?.hasMore ? (
									<Button type="button" variant="ghost" size="sm" data-testid="remote-git-history-more" disabled={!!state.historyMoreLoading} onClick={() => loadMoreHistory()}>
										{t("remoteGit.historyMore")}
									</Button>
								) : null}
								{state.detailOid ? (
									<div data-testid="remote-git-commit-detail" className="mx-3 my-1 rounded border border-border p-2">
										{state.detailLoading ? <p className="text-xs text-text-secondary">{t("remoteGit.loading")}</p> : null}
										{state.detailErrorCode ? (
											<p role="alert" className="text-xs text-danger">
												{remoteGitErrorMessage(state.detailErrorCode)}
											</p>
										) : null}
										{detail ? (
											<>
												<p className="font-mono text-xs text-text-secondary">{detail.oid}</p>
												<p className="whitespace-pre-wrap break-words text-xs">{detail.message}</p>
												<p className="text-xs text-text-secondary">
													{detail.authorName} &lt;{detail.authorEmail}&gt; · {historyTime(detail.authorTimeSec)}
												</p>
												<h4 className="pt-1 text-xs font-medium text-text-secondary">{t("remoteGit.detailFiles")}</h4>
												{detail.files.map((file) => (
													<button
														key={`${file.status}:${file.path}`}
														type="button"
														data-testid="remote-git-commit-file"
														className="flex w-full items-center gap-2 px-1 py-0.5 text-left text-xs hover:bg-surface-secondary"
														onClick={() => openHistoryFileDiff(detail.parents[0] ?? null, detail.oid, { projectId: project.id, relativePath: file.path })}
													>
														<span className="font-mono text-text-secondary">{file.status}</span>
														<span className="min-w-0 flex-1 truncate">{file.path}</span>
														{file.oldPath ? <span className="shrink-0 text-text-secondary">← {file.oldPath}</span> : null}
													</button>
												))}
											</>
										) : null}
									</div>
								) : null}
							</>
						) : null}
					</section>
					<section data-testid="remote-git-refs" className="pb-2">
						<button type="button" className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium text-text-secondary" aria-expanded={refsOpen} onClick={() => (refsOpen ? (state.refsErrorCode ? loadRefs() : setRefsOpen(false)) : setRefsOpen(true))}>
							{t("remoteGit.refsTitle")}
						</button>
						{refsOpen ? (
							<>
								<div className="flex items-center gap-2 px-3 pb-1">
									<Input data-testid="remote-git-branch-name" aria-label={t("remoteGit.branchName")} placeholder={t("remoteGit.branchNamePlaceholder")} value={newBranch} disabled={busy || snapshot?.branchToken === undefined} onChange={(event) => setNewBranch(event.target.value)} />
									<Button type="button" size="sm" data-testid="remote-git-create-branch" disabled={!canCreateBranch} onClick={() => createBranch(newBranch)}>
										{t("remoteGit.createBranch")}
									</Button>
								</div>
								{state.refsLoading ? <p className="px-3 text-xs text-text-secondary">{t("remoteGit.loading")}</p> : null}
								{state.refsErrorCode ? (
									<p role="alert" className="px-3 text-xs text-danger">
										{remoteGitErrorMessage(state.refsErrorCode)}
									</p>
								) : null}
								{state.refs
									? state.refs.refs.map((ref) => (
											<div key={ref.fullName} data-testid="remote-git-ref-row" className="flex items-center gap-2 px-3 py-0.5 text-xs">
												<span className="text-text-secondary">{t(ref.kind === "branch" ? "remoteGit.refBranch" : "remoteGit.refTag")}</span>
												<span className="min-w-0 flex-1 truncate font-mono">{ref.name}</span>
												<span className="font-mono text-text-secondary">{ref.oid.slice(0, 8)}</span>
												{/* Switching only ever names an existing branch; the current one has nothing to do. */}
												{ref.kind === "branch" && ref.name !== snapshot?.branch ? (
													<Button type="button" variant="ghost" size="sm" data-testid="remote-git-switch-branch" aria-label={`${t("remoteGit.switchBranch")} ${ref.name}`} disabled={!canSwitchBranch} onClick={() => switchBranch(ref.name)}>
														{t("remoteGit.switchBranch")}
													</Button>
												) : null}
											</div>
										))
									: null}
							</>
						) : null}
					</section>
				</div>
			) : null}
		</div>
	);
}
