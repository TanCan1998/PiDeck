# PiDeck SSH Remote Development — Independent Security Review, Round 2

> Status: **report only** (shared task `task-12`). No source file was modified and no commit was made by this
> lane; the only file written is this report. This is an **independent re-audit of the remote surface at the
> current HEAD**, not a summary of the release ledger: every claim is marked `[verified]`, `[inferred]` or
> `[cannot-verify]` and carries a `file:line` anchor, and doc/code disagreements are reported as findings.
>
> Audited by an AI agent lane (security-audit). This is **still not an independent human reviewer**; see §6.
> No real SSH host, packaged application, macOS client, Playwright/e2e, or full `npm test` was used — only
> targeted read-only `node --test` batches (exact commands in §8).

## 0. Snapshot and delta since round 1

| Item | Value |
| --- | --- |
| Repository | `F:\PiDeck-remote` |
| Branch | `feat/remote-development` |
| HEAD | `2da2be007` (`docs(remote): record the night batch and the remote v1 release-gate ledger`) |
| Baseline of round 1 | `11f68b27d`; report: `docs/remote-security-review.md` |
| Working tree at review start | clean except `M docs/remote-release-gate-status.md` (owned by another lane/Lead; **not modified by this review**). **Concurrent lane note:** while this report was being written, another lane began landing an uncommitted “remote session delete” feature (new `RemoteSessionDelete.ts`, `RemoteArchivedSessionDelete.ts`, renderer hook/state, `sessionDeleteCodes.ts`, tests, and edits to `index.ts`, `sessionIpc.ts`, `SessionCatalog.ts`, `preload/index.ts`, i18n and shared IPC/types). That feature is **outside this round’s scope and was not reviewed**; the reviewed code was read against the HEAD snapshot before those writes. Cited files the other lane touches (`src/main/index.ts`, `src/preload/index.ts`, i18n copy, plan/ledger docs) may have shifted by a few lines — the anchor symbols/keys in the citations still locate them. |
| Line numbers | all line numbers below are the HEAD snapshot; the tree was otherwise unmodified during review |

Delta commits audited (in order): `3546f03bb` (git.compare + refs polling), `eb4ff5260` (git.init),
`098aa097a` (nested repository discovery + read scope), `1606fc042` (repo-scoped writes + token binding),
`0b9de7357` (file management v1 + create empty remote project), `a431605e0` (F2/F4/F5/F6 remediation),
`836327e6b` (terminal ticket + fixed runner), `2da2be007` (docs/ledger).

Scope of this round (task-12 wording): (1) remote file management v1, (2) terminal ticket + fixed runner,
(3) F2 bundle maintenance, (4) the `hostRouteDigest` relaxation for ordinary reads, (5) F4/F5/F6 fixes and
whether F1 still holds, (6) new stable error codes and renderer→remote path/command authority. The
Git-side delta commits (compare/init/repos/scoped writes) were additionally spot-checked because they landed
after round 1 (§3.7, §8).

## 1. Verdict

**No critical, high, or medium severity vulnerability was found at HEAD 2da2be007.** All six substantive
findings from round 1 are addressed in code and tests:

- **F1 (medium) — fixed.** Remote Git network verbs now carry the 600 s sync budget instead of the 30 s read
  budget, on both ends (main per-method timeout, helper per-method admission, frame ceiling raised to 600 s).
- **F2 (low) — fixed, with a documented residual.** A host-side bundle retention sweep now runs after a
  confirmed activation and is non-fatal; multi-client protection is an age heuristic, not the connection
  registry/lease the plan specifies (residual, accepted by the remediation doc).
- **F3 (low) — implemented for project terminals.** `terminal.prepare` one-shot ticket plus the frozen
  `terminal-runner.mjs` handshake replaced the nonce-marker minimal loop. Two lifecycle deviations and the
  still-absent agent-target ticket variant are reported (R2-2 / §6).
- **F4 (low) — fixed.** `~`/relative `identityFile` is now normalized to a local absolute path, with a
  dedicated stable code.
- **F5 (low) — fixed.** Post-commit receipt loss now has its own stable code, coordinator passthrough and
  dedicated zh-CN/en-US copy (“outcome unconfirmed, reload, no automatic retry”).
- **F6 (low) — fixed.** The session-history path authority now rejects non-canonical absolute paths.
- F7/F8/F9/F10 are **unchanged info-level observations** (no sender-frame allowlist; remote pi argv logged;
  inlined helper vs. plan's resources+manifest gate; no per-launch bundle re-hash).

Round-2 findings: **two low-severity findings** (plus three info-level observations recorded in §5.2). They are narrower than the remediation batch:
(R2-1) the project trash `.pideck-trash` is **not** hidden from `remote:project-list` / `remote:project-search`
even though the frozen plan and the release ledger say it is, and only read/edit paths block it; (R2-2) the
terminal ticket lifecycle deviates from the frozen plan (TTL 120 s vs. “≤60 s”, sweep only on mint, orphan
`.claim-*` never swept, main-side TTL constant unused); (O1) the runner does not independently re-verify the
ticket's `hostId`/`routeDigest`/`projectId` fields; (O2) the runner-selected login shell is decoded but then
discarded by the tab manager.

The terminal ticket/gate item can now be considered code-complete for project terminals; the release ledger's
claims for file management/terminal rely on e2e runs this review did not reproduce (§6).

## 2. Evidence base

Targeted read-only `node --test --test-concurrency=2 …` batches on the Windows review host against HEAD
2da2be007. **0 failures in all batches.**

| Batch | Files | Result |
| --- | --- | --- |
| A — file management + security lows | `remoteProjectEntryCommands`, `remoteProjectEntryIpc`, `remoteProjectEntryService`, `remoteProjectEntryState`, `remoteProjectEnrollCreate`, `remoteBundleMaintenance`, `remoteHostIdentityFile`, `remoteHostIpc`, `remoteSessionHistoryRead`, `remoteSessionHistoryWrite`, `remoteSessionWriteGuardUi`, `remoteBootstrapSession`, `remoteProjectFileIpc`, `remoteProjectIpc`, `sessionRuntimeCoordinator` | **261 tests: 241 pass, 0 fail, 20 skipped** |
| B — terminal ticket/runner | `remoteTerminalPrepare`, `remoteTerminalRunner`, `remoteTerminalLauncher`, `remoteTerminalAdapter`, `remoteTerminalCommand`, `remoteTerminal`, `remoteHelperEntry`, `terminalShell` | **86 tests: 72 pass, 0 fail, 14 skipped** |
| C — Git delta | `remoteGitCompare`, `remoteGitCompareIpc`, `remoteGitCompareView`, `remoteGitInit`, `remoteGitInitIpc`, `remoteGitInitView`, `remoteGitRefsPolling`, `remoteGitRepos`, `remoteGitRepoScopeView`, `remoteGitScopedWrite`, `remoteGitService`, `remoteGitSync`, `remoteGitReadIpc` | **129 tests: 81 pass, 0 fail, 48 skipped** |
| D — F2 alone | `remoteBundleMaintenance` (real child process, fake HOME) | **12 pass, 0 fail, 0 skip** |
| E — F4 alone | `remoteHostIdentityFile` | **5 pass, 0 fail, 0 skip** |

Totals: **493 tests run, 411 pass, 0 fail, 82 skipped**. All skips are POSIX/Linux-only checks: real
`/bin/sh`/`stty` writes, uid/gid/mode semantics, real PTY runner consumption, real Git repositories and
network-free sync fixtures. They are exactly the evidence this Windows host cannot produce; see §6.

## 3. Assessment of the new/changed surfaces

### 3.1 Remote file management v1 (create/rename/move/delete+trash, empty-trash, create-project)

**Command/path authority — [verified].** There is no new helper op. Every file-management operation is a
main-built, fixed Node standard-library script executed over the existing pinned SSH short-command channel:
the shared `BOUNDARY_SCRIPT` (canonical-root re-check, per-level non-symlink parent walk, `/proc/self/fd`
parent anchoring) is reused rather than copied — `RemoteProjectFileCommands.ts:16–39`;
`RemoteProjectEntryCommands.ts:303–313`. Inputs are validated twice (IPC + builder): project-relative POSIX
paths with no absolute prefix, backslash, control bytes or `.`/`..` segments; single-segment names ≤255 UTF-8
bytes with reserved names and the `.pideck-tmp` suffix refused; rename/delete sources and targets additionally
protected (`RemoteProjectEntryCommands.ts:45–108`). All argv tokens go through `quotePosixArgument`
(`RemoteProjectEntryCommands.ts:326–333`), the JSON parameter payload is a quoted literal, and the command is
refused above 8192 chars. The scripts are length-budgeted (5120; restore/prune 6100 by recorded exception —
`RemoteProjectEntryCommands.ts:29–36`). **[verified]** by the POSIX-executed command tests (batch A/D) plus the
Windows-executed validation/budget tests.

**Renderer authority — [verified].** The renderer sends only `projectId`, project-relative paths/names and
opaque tokens (`src/shared/types/remoteFiles.ts:6–59`; preload `src/preload/index.ts:278–292`). Host id,
absolute remote path, revision, manifest and trash id are main-owned. The service re-reads the locator at call
time and keeps a value snapshot for the token
(`RemoteProjectEntryService.ts:96–103,124–141`); the session host revision is compared after the project lock
(`:322–347`); the entry revision is re-checked with a fresh stat immediately before rename/delete
(`:260–269,314–349`). The delete command re-checks the same identity inside the script before renaming the
payload into the trash (`RemoteProjectEntryCommands.ts:185–214`). **[verified]** by
`remoteProjectEntryService.test.mjs` / `remoteProjectEntryIpc.test.mjs` / `remoteProjectEntryCommands.test.mjs`
(batch A; the real POSIX script cases were among the 20 skips).

**One-shot grants and unknown results — [verified].** `RemoteFileMutationTokens` is main-only, memory-only,
bounded 128 entries / 30 min, bound to sender + project + relative path + host/root snapshot + kind + entry
revision, consumed before the first await, and a mismatched token is not burned by another window
(`RemoteFileMutationTokens.ts:36–57`; `RemoteProjectEntryService.ts:314–349`). A sender has at most one
file-management write in flight (`:105–118`). Post-dispatch ambiguity is separated: send/transport/marker loss
after a write maps to `REMOTE_FILE_RESULT_UNCONFIRMED` while a pure read maps to `REMOTE_FILE_COMMAND_FAILED`
(`:127–157`), and creation/rename/delete additionally re-validate the echoed relative path/kind
(`:282–349`). Trash ids are main-generated and revalidated at every boundary
(`RemoteProjectEntryCommands.ts:68–71`; `remoteProjectEntryIpc.ts:7–10,128–147`).

**Trash semantics — [verified].** Delete writes a strict manifest (0600, ≤8 KiB) into a per-entry 0700
directory before renaming the payload, using fd-anchored no-follow opens; an unavailable/cross-device/occupied
trash never falls back to unlink (`RemoteProjectEntryCommands.ts:181–215,278`). List is read-only and bounded
(≤256 entries, output trimmed with `truncated`), states are main-revalidated
(`RemoteProjectEntryService.ts:179–238,351–359`); restore requires an intact payload and a free target
(`RemoteProjectEntryCommands.ts:255–280`); prune is capped at 32 ids per call and its recursive delete is
bounded (≤20 000 entries / depth 32) before any removal (`:282–301`). There is intentionally no automatic TTL
deletion; `expiresAt` is display-only (`src/shared/types/remoteFiles.ts:42–55`).

**Create empty remote project — [verified].** Enroll `mode=create` uses a separate broker/pending table/push
channel, a fixed pinned probe (parent canonical + directory + leaf absent), a second identical probe after
approval, one non-recursive `mkdir`, a canonical re-resolve of the created path, then the durable ProjectStore
write. Renderer only supplies `hostId + absolute candidate path`; the command has only quoted literals and no
user text becomes a shell word (`RemoteProjectCreateCommands.ts:22–85`;
`remoteProjectCreateIpc.ts:20–118`; `remoteProjectIpc.ts:135–163`). Reserved leaf names (".git", ".pi",
".pideck-trash", "*.pideck-tmp") and a root-level target are refused (`RemoteProjectCreateCommands.ts:22–41`).
No project trust is required because this is a directory creation, not project code execution — consistent
with “add existing directory”. **[verified]** by `remoteProjectEnrollCreate.test.mjs` (batch A).

**Read-surface hiding of the trash — gap, finding R2-1.** Read/edit/stat of `.pideck-trash` is refused
(`remoteProjectIpc.ts:274`; `remoteProjectFileIpc.ts:24–26`; `RemoteProjectEntryService.ts:272–279`) and writes
into it are protected, but `remote:project-list` and `remote:project-search` return trash entries unchanged:
the list handler maps every reader entry without filtering (`remoteProjectIpc.ts:248–266`) and the search
handler maps every match without filtering (`:302–327`); the reader itself has no such filter
(`RemoteWorkspaceReader.ts:236–257,833`; no trash references under `src/main/remote/RemoteWorkspaceReader.ts`).
The renderer has no compensating filter either (no `.pideck-trash` reference under `src/renderer` except i18n).
This contradicts the frozen plan (§4.3/§5.6: “只读列表/搜索隐藏” — `docs/remote-file-management-plan.md:81,
245–246,397,877`; test expectation `:784`) and the release ledger (`docs/remote-release-gate-status.md:23`:
“.pideck-trash 对读面隐藏”). Impact is bounded: content reads are blocked, so what is exposed is the trash
directory itself, its entry ids and the names `payload`/`entry.json`, not deleted content or the manifest.
See R2-1.


### 3.2 Terminal ticket and fixed runner

**Helper mint — [verified].** `terminal.prepare` is a capability and a dispatch branch of the frozen helper
1.20.1 (`RemoteHelperContract.ts:305–334`; dispatch anchor in `RemoteHelperEntry.ts` frozen body). The helper
requires exactly four params (`kind: "project", projectId, hostId, routeDigest`), re-checks its own canonical
`ROOT`, derives deploy root + bundle hash from its own deployed path, sweeps bounded stale ticket/temp entries,
then atomically publishes a ticket: temp file 0600 + fsync → hard-link to `<ref>` (create-only) → unlink temp →
directory fsync; the reply is only the opaque 32-hex ref. Ticket content is v1 + kind/projectId/hostId/
routeDigest/cwd(=helper ROOT)/bundleSha256/ticketRef/expiresAt
(`RemoteHelperContract.ts:460–488`; frozen-body anchors: `readPrivateTicketDirectory`, `sweepTerminalTickets`,
`mintTerminalTicket` in `src/main/remote/RemoteHelperEntry.ts`).

**Runner consume — [verified by skipped-on-Windows tests; reviewed statically].** The frozen
`terminal-runner.mjs` (build 1.0.1, sha pinned) captures/validates termios with absolute-resolved `stty`,
disables echo, writes a CRLF-terminated READY frame, reads one ≤1024-char newline-terminated base64url init
frame, atomically claims the ticket (`rename` out of the shared name, then no-follow open, strict schema,
expiry/bundle/cwd checks), restores termios on every path, and starts the absolute executable `$SHELL`
(single-arg login argv0, `shell:false`, ticket cwd) while forwarding signals
(`RemoteTerminalRunnerEntry.ts:28–85`). Replay answers `ALREADY_CONSUMED`; wrong bundle `BUNDLE_MISMATCH`;
moved cwd `CWD_CHANGED`; every failure is one bounded ERROR frame plus non-zero exit.

**Main launcher — [verified].** `SshTerminalSessionLauncher.start` requires a 64-hex `hostRouteDigest` from
the live session before any helper request, mints the ticket over that same session, derives the runner path
from the confirmed `deployRoot/bundleSha256`, builds the command as “trusted node + active-bundle runner”
only, spawns inside the pinned `ssh -tt` invocation after a pre-spawn authority re-read, and runs a bounded
READY→init→START handshake that tolerates ConPTY stripping RS/US but keeping CRLF, split chunks, and ConPTY
noise; bytes after START are delivered exactly once and handshake bytes are stripped
(`SshTerminalSessionLauncher.ts:77–232`; `RemoteTerminalCommand.ts:1–19`;
`RemoteBootstrapDeployment.ts:80–89`; the runner is a bundle artifact: `RemoteHelperEntry.ts:183–189`;
`RemoteBootstrapDeployment.ts:37–52`). The manager keeps tab/replay/input/resize/close ownership and refuses
renderer-selected shells other than `"sh"`; the local/WSL half was moved verbatim into
`LocalTerminalSessionLauncher` (`TerminalSessionLauncher.ts:85–149`) with the local manager behaviour
unchanged (`TerminalSessionManager.ts:1–120`). **[verified]** by batch B (72 pass; the real-PTY ticket cases
are the 14 POSIX skips).

**Residual deviations — R2-2 / O1.**

### 3.3 F2 — host-side bundle/staging/lock retention

**[verified by batch D (12/12) and reviewed statically].** A fixed inline Node script, executed over the same
pinned short-command channel after a **confirmed** activation, implements the plan's deploy-root retention:
active bundle never deleted; the newest non-active snapshot is the rollback and never deleted; further
unreferenced snapshots kept ≤2 / ≤7 days; unreferenced snapshots younger than 1 h never deleted (multi-client
age heuristic); `.staging-*` removed only with no live deploy lock and mtime >1 h; a dead-holder lock is
removed and the sweep continues; a live-holder lock skips everything; owner/mode/type/liveness failures count
as `unverifiable` and delete nothing; a deploy root that is not exactly `$HOME/.pideck/remote-host` (canonical,
0700, owner) is skipped entirely (`RemoteBundleMaintenance.ts:36–48,99–224,239–249,255–288,297–310`). The
caller treats every sweep failure as non-fatal and logs `hostId` + stable code only
(`RemoteBootstrapSession.ts:195–219`; invocation only after `runPreparedBootstrap` returns,
`:236–239`).

Residual (documented in the remediation doc, reproduced here): plan §4.2 asks for active connection
registration + leases; this is approximated by “active sha + newest rollback + ≤2/≤7 d + 1 h age”
(`RemoteBundleMaintenance.ts:17–19,43–48`). Worst case: another PiDeck instance long-connected to a bundle
that is >7 days old and pushed out of the retained set can have that bundle deleted under it (its running
helper keeps its loaded modules but later lazy imports can fail; next bootstrap self-heals). There is also no
periodic sweep while the app stays running (sweep only follows a real bootstrap), and the 24 h artifact TTL
outside the deploy root is not covered. See `docs/remote-security-remediation.md:97–109`.

### 3.4 `hostRouteDigest` relaxation in `withProjectSession` — assessed, no ticket path found

The session object handed to project operations now carries `hostRouteDigest`, read together with the store
revision from the pin-confirmed endpoint (`RemoteHostConnectionService.ts:273–281`). When the store cannot
name a verified route (not ready, disabled, missing/malformed `verifiedEndpoint`), the digest is the empty
string (`:493–505`); ordinary reads continue, and the terminal launcher refuses before minting because it
requires 64 hex (`SshTerminalSessionLauncher.ts:80–88`). Assessed explicitly for cross-host/cross-project
ticket paths:

- Every establish first compares the held session's store revision with the current revision and discards the
  held session on any change (`RemoteHostConnectionService.ts:332–339` within `ensureHeld`, and `:425–434` in
  `establishProjectSession`); a non-null route whose revision differs from the held revision also fails closed
  (`:496–497`). So “empty digest” does not let a stale-route session survive a rebind/disable; it only avoids
  making ordinary reads depend on re-reading the route facts.
- The mint and the spawn use **the same session object**: the launcher calls `session.request(terminal.prepare)`
  and then `session.withTerminalInvocation` on it; `withTerminalInvocation` re-builds the pinned invocation
  (re-reading pin/route/profile from the same `userDataDir`) and re-asserts the manager identity and revision
  before spawning (`SshTerminalSessionLauncher.ts:82–97`; `RemoteHostConnectionService.ts:516–528`). A route
  change between mint and spawn makes `buildPinnedSshInvocation`/`assertBound` fail before the PTY exists.
- Project binding: the ticket's `cwd` is the helper's canonical `ROOT`, i.e. the project root the helper
  session was established for; the renderer supplies only `projectId` and main resolves host/root from the
  ProjectStore (`terminalIpc.ts:96–103`; `createRemoteTerminalManager.ts` wiring). No path lets renderer text
  become cwd/shell/ticket/argv.

**Conclusion: the relaxation opens no cross-host or cross-project ticket path that I could find.** It only
means “the terminal surface is unavailable while the route facts are unreadable” while reads remain
independent of the ticket surface, which matches the code comment at
`RemoteHostConnectionService.ts:493–495`. One residual (O1): the runner itself does not re-verify the
`hostId`/`routeDigest`/`projectId` fields against expected values (it cannot — it has none), so the binding is
by main's construction, not by an independent check.


### 3.5 F4 / F5 / F6 fixes and F1 status

- **F4 — [verified].** `normalizeRemoteHostIdentityFile` expands `~`/`~/…` against the **local** account HOME
  (correct: it is a local OpenSSH `-i` reference), normalizes, strips trailing separators, and returns
  `undefined` for `~user`, relative, control-byte, over-long or empty values
  (`RemoteHostIdentityFile.ts:35–52`). `remoteHostIpc.readAddInput` calls it before `createDraft` and returns
  the dedicated `REMOTE_HOST_IDENTITY_FILE_INVALID` (`remoteHostIpc.ts:138–146`), so the opaque
  `REMOTE_HOST_STORE_INVALID` failure is gone. Batch A/E tests pass; the store codec still enforces
  `isAbsolute` on load (`RemoteHostStoreCodec.ts:70`).
- **F5 — [verified].** The writer now has a dedicated `REMOTE_SESSION_HISTORY_WRITER_RESULT_UNCONFIRMED`
  (`RemoteSessionHistoryWriter.ts:84–99`): transport throw, non-zero exit and untrusted marker/JSON after the
  commit command all map to it, while guard-reported pre-rename codes and pre-commit chunk failures keep their
  old meaning (`:769–811`). The coordinator keeps the code in `debugDetails` (`SessionRuntimeCoordinator.ts:
  2036–2045`) and the renderer maps it to `sessionCommand.remoteWriteUnconfirmed` with the required
  “reload to check, no automatic retry” copy in both languages
  (`src/renderer/src/utils/sessionCommands.ts:26–27`; `rendererCopy.zh-CN.ts:205`;
  `rendererCopy.en-US.ts:206`). The remediation doc's “renderer half not applied” caveat is stale at this HEAD
  — the patch landed later; the code above is the applied form. **[verified]** by `remoteSessionHistoryWrite`
  (batch A) and the renderer/copy guards.
- **F6 — [verified].** The path authority rejects non-canonical absolute paths (empty/duplicate segments, `.`,
  `..`, trailing slash) before any command construction, in the single implementation shared by session
  history read/write/archive (`RemoteSessionHistoryReader.ts:120–145`; writer/guard reuse it). Batch A passes,
  including the previously-missed `…/sessions/../../../etc/passwd` probe.
- **F1 — fixed and still holds.** Main selects `REMOTE_GIT_SYNC_TIMEOUT_MS` (600 s) for `git.fetch`,
  `git.push` and `git.pull` and the read timeout for everything else (`RemoteGitService.ts:506`); the contract
  frame ceiling was raised to 600 s with the explicit dependency documented
  (`RemoteHelperContract.ts:37–43,218–219`); the frozen helper admits only the three network verbs with the
  600 s budget and clamps the frame deadline to the same ceiling (frozen-body anchors
  `const budget = method === "git.fetch" … ? 600000 : 30000;` and `readDeadline` in `RemoteHelperEntry.ts`).
  Batch C includes “network verbs carry the sync budget while every other Git method keeps the read budget”
  and the read-budget cases; all pass.

### 3.6 New stable error codes and renderer→remote authority

- **[verified] No renderer input becomes a remote path or command authority on the new surfaces.** Entry
  operations accept project-relative paths/names + opaque tokens; create-project accepts a hostId + absolute
  candidate path but main re-probes/canonicalizes it and only one fixed `mkdir` is executed; terminal accepts
  a project id only. All remote command strings are assembled in main from validated tokens with
  `quotePosixArgument`; see §3.1/§3.2 and `RemoteProjectEntryCommands.ts:326–333`,
  `RemoteProjectCreateCommands.ts:47–60`.
- **[verified] Codes are closed sets.** File-management has a single registry `REMOTE_FILE_ENTRY_CODES`
  (`RemoteProjectEntryService.ts:33–67`), used both to filter helper-script codes and by the IPC layer; the
  renderer maps the actionable codes to specific copy and falls back to a “failure ({code})” message for
  unknown ones (`remoteFileManagementState.ts:43–96`). Create-project codes are mapped in the enroll dialog
  (`RemoteProjectEnrollDialog.tsx:15–18`). The terminal runner's error vocabulary is a closed list
  (`RemoteHelperContract.ts:512–525`).
- **Observation O3 (minor):** the entry IPC fallback folds any code outside `REMOTE_FILE_ENTRY_CODES` into
  `REMOTE_FILE_COMMAND_FAILED` (`remoteProjectEntryIpc.ts:47–49`), so a root-drift/needs-attention failure
  from `withProjectSession` (e.g. `SSH_PROJECT_ROOT_CHANGED`, not in the entry set) loses its actionable code
  for file-management operations; the operation still fails closed with zero remote write. Compare the project
  read path, which maps root drift explicitly (`remoteProjectIpc.ts:302–327` handlers return the service code).

### 3.7 Git delta spot-check (compare/init/repos/scoped writes)

**[verified at code/test level, real-repo cases skipped on this host].** Repository scope is a validated
project-relative POSIX path, never an absolute/local path (`RemoteGitService.ts:199–…`, IPC validation in
`remoteGitReadIpc.ts:76–103,140–146,149–349`); every scope mints grants bound to its own repository and a
cross-scope grant is refused before host work (batch C test names); `git.init` is root-only, token-less by
design, runs through the same sender/trust/pressure boundary and is marked as a write so a lost reply becomes
`GIT_WRITE_RESULT_UNCONFIRMED` (`remoteGitReadIpc.ts:325–340`); `git.repos` is a bounded read with no token
(`:140–146`). The frozen helper repeats the same scope rules (`RemoteHelperContract.ts:152–161`). Batch C
passes 81/81 non-skipped tests; the 48 skipped are the real Git/repository cases.

## 4. Round-1 findings status (F1–F10)

| ID | Round-1 severity | Status at HEAD 2da2be007 | Evidence |
| --- | --- | --- | --- |
| F1 | medium | **Fixed** | Main per-method budget `RemoteGitService.ts:506`; 600 s contract ceiling `RemoteHelperContract.ts:37–43`; helper per-method 600 s + deadline clamp (frozen `RemoteHelperEntry.ts`); batch C sync-budget test passes. |
| F2 | low | **Fixed with residual** | Host sweep `RemoteBundleMaintenance.ts:36–310`; wired after confirmed activation, non-fatal `RemoteBootstrapSession.ts:210–239`; batch D 12/12. Residual multi-client/lease + no periodic sweep (§3.3). |
| F3 | low | **Implemented (project terminals)** | `terminal.prepare` + frozen `terminal-runner.mjs`; main launcher/manager/deployment (§3.2). Residuals R2-2/O1; agent-target ticket variant still absent (ledger notes it too). Real-host independent run not repeated here. |
| F4 | low | **Fixed** | `RemoteHostIdentityFile.ts:35–52`; `remoteHostIpc.ts:138–146`; batch A/E pass. |
| F5 | low | **Fixed end-to-end (main + renderer + i18n)** | Writer codes `RemoteSessionHistoryWriter.ts:84–99,769–811`; coordinator `SessionRuntimeCoordinator.ts:2036–2045`; renderer `sessionCommands.ts:26–27`, copy zh/en lines 205/206; batch A pass. |
| F6 | low | **Fixed** | `RemoteSessionHistoryReader.ts:120–145`; batch A passes canonical matrix. |
| F7 | info | **Unchanged** | 0 matches for `senderFrame|validateSender|assertTrustedSender|isTrustedSender` in `src/main`; identity remains `event.sender.id`. |
| F8 | info | **Unchanged** | `AgentManager.ts:1658` still logs `args: plan.args.join(" ")` (remote session path + trust flag) to the local app log. |
| F9 | info | **Unchanged** | Helper/runner/terminal-runner remain TypeScript string constants with in-code sha pins (`RemoteHelperEntry.ts:183–189`); no `resources/remote-host/` tree, no `generate-remote-host-manifest` / `check:remote-host-manifest` script (plan `docs/remote-development-plan.md:177–181` still says otherwise). |
| F10 | info | **Unchanged** | `ensureHeld` reuses the held bootstrap by store revision without re-hashing the deployed helper (`RemoteHostConnectionService.ts:332–362`); per-launch bytes are only proven at bootstrap/activation. Acceptable under the same-account threat model; unchanged. |

## 5. Round-2 findings and observations

### 5.1 Findings

| ID | Severity | Area | Finding | Preconditions / impact | Evidence | Suggested fix |
| --- | --- | --- | --- | --- | --- | --- |
| **R2-1** | **low** | file management / read-surface contract | `.pideck-trash` is **not hidden from `remote:project-list` or `remote:project-search`**. Read/edit/text-open/stat and all writes are blocked or protected, but list returns the trash directory as an ordinary entry and search can return trash descendants (`payload`, `entry.json`, entry ids). The frozen plan and the release ledger claim list/search hiding; no test covers it. | Any remote project where the user deleted something; a normal file-tree expand or name search. Exposes trash presence/ids and file names inside the trash (not deleted content, not the manifest). No content read is possible through these channels. | Plan: `docs/remote-file-management-plan.md:81,245–246,397,877`, test expectation `:784`; ledger claim `docs/remote-release-gate-status.md:23`; code: `remoteProjectIpc.ts:248–266` (list maps all entries), `:302–327` (search maps all matches), only `:274` blocks reads; `RemoteProjectEntryService.ts:272–279` blocks stat; `remoteProjectFileIpc.ts:24–26` blocks text; no filter in `RemoteWorkspaceReader.ts` list/search; renderer has no filter. | In `remoteProjectIpc`'s list handler drop the root-level `.pideck-trash` entry, and in search drop entries whose first path segment is `.pideck-trash`; add the two tests the plan asked for. Keep the explicit trash channels as the only way to see the trash. |
| **R2-2** | **low** | terminal ticket lifecycle vs frozen plan | Three deviations from the frozen plan/contract: (a) ticket TTL is **120 s**, while plan §4.2 says an unconsumed ticket's TTL “must not exceed 60 s”; (b) expired/malformed ticket and temp cleanup runs **only on mint**, not “at helper startup and periodic sweep”; (c) the runner renames a ticket to `.claim-<ref>-<pid>` and unlinks it, but a crash between rename and unlink leaves a `.claim-*` file that the bounded sweep **never matches** (it only removes `.new-<hex>` temps and `<ref>` tickets), so orphan claims persist. Additionally the main-side `REMOTE_TERMINAL_TICKET_TTL_MS` constant is unused and not equality-pinned to the helper's literal. | Same remote account (ticket files 0600 in a 0700 directory); a terminal runner killed/power lost mid-consumption. Longer-than-planned ticket validity and unbounded orphan-claim accumulation on hosts where terminals are used rarely. No current path mints a ticket for another host/project (see §3.4). | Plan: `docs/remote-development-plan.md:184`; contract `RemoteHelperContract.ts:468–477`; helper frozen anchors `const TERMINAL_TICKET_TTL = 120000` and `sweepTerminalTickets` (called only inside `mintTerminalTicket`); runner `RemoteTerminalRunnerEntry.ts:70,57`; test `tests/remoteTerminalPrepare.test.mjs:110` uses the contract constant only as an upper bound. | Either align the helper TTL to ≤60 s or amend plan §4.2 explicitly with the rationale; sweep at helper startup (and periodically while serving) in addition to mint; include the `.claim-<hex>-<pid>` shape in the bounded sweep; pin the contract TTL constant to the helper literal in a test. |

### 5.2 Observations (not vulnerabilities)

- **O1 — ticket fields are not independently re-verified.** The runner re-checks schema, expiry, its own
  bundle hash and the canonical directory of the ticket `cwd`, but has no expected `hostId`/`routeDigest`/
  `projectId` to compare against (`RemoteTerminalRunnerEntry.ts:72`). Correct today because main mints and
  consumes through the same verified session object and the helper forces `cwd = ROOT` (its canonical project
  root); recorded so it is not mistaken for an independent cross-host binding.
- **O2 — the runner-selected login shell is recorded then discarded.** The START frame carries the selected
  shell and the launcher returns it (`SshTerminalSessionLauncher.ts:130–140,213–219`; test
  `tests/remoteTerminalLauncher.test.mjs:95` asserts it), but `RemoteTerminalSessionManager` keeps the tab's
  `shell: "sh"` and never uses `resource.shell` (`RemoteTerminalSessionManager.ts:98–142`). Cosmetic/parity
  only; the plan says the UI should show the probed shell label.
- **O3 — root-drift code folding in file management.** See §3.6: `SSH_PROJECT_ROOT_CHANGED` /
  `SSH_PROJECT_ROOT_UNRESOLVED` are not in `REMOTE_FILE_ENTRY_CODES`, so those failures surface as
  `REMOTE_FILE_COMMAND_FAILED` (still fail-closed, zero remote write). Worth a dedicated code/mapping if the
  UI is expected to route users to “needs attention”.


## 6. Residual risks, unknowns and follow-up

**Cannot verify on this host / in this review (explicit):**

1. **No real SSH host.** All new surfaces were verified by code reading plus targeted unit/integration tests
   with fakes or local processes. The one-shot ticket/runner real-PTY cases (14) and the real Git repository
   cases (48) are POSIX-only and were skipped on this Windows host; a Linux run of
   `tests/remoteTerminalRunner.test.mjs`, `tests/remoteTerminalPrepare.test.mjs` and the skipped Git files is
   required. The release ledger's e2e claims (file management 54.1 s, terminal 1.8 m, 12 gates) were produced by
   the Lead's serial runs and were **not** reproduced or re-checked here.
2. **Packaged build** (`npm run pack`) and packaged-app behaviour are unverified by this lane; the production
   gate `!app.isPackaged && PIDECK_REMOTE_EXPERIMENTAL=="1"` (`src/main/index.ts:2357` region (symbol `remoteExperimentEnabled`)) still makes the
   packaged app remote-less by default. Inlined frozen sources (helper/runner/terminal-runner) must be
   re-checked after bundling; no `extraResources` remote-host entry exists because the artifacts are strings.
3. **macOS client** has no evidence anywhere; Windows client evidence exists only through the Lead's runs
   (the ConPTY framing fix is unit-simulated here, not re-run on a real Windows node-pty PTY).
4. **Power-loss/half-write recovery** remains partially covered: activation/finalize failure paths and the F2
   sweep have tests, but no real power-loss test and no explicit “upgrade then downgrade” matrix test.
5. **F2 multi-client residual**: a long-lived other PiDeck instance connected to a bundle older than 7 days and
   outside the retained set could have that bundle swept; no connection-registry/lease surface exists yet
   (documented in `docs/remote-security-remediation.md:97–109`).
6. **Independent human reviewer** is still missing; this report and the round-1 report are AI-agent reviews.
   The Phase 5 gate (“完成安全审查”) should not be signed off on these alone.
7. **Ledger wording**: `docs/remote-release-gate-status.md:23` states the trash is hidden from read surfaces;
   for list/search that is not true at this HEAD (R2-1). The Lead owns that file; this report does not modify
   it. Adjusting the wording (or fixing the filter) before release evidence is quoted externally is advisable.
8. **agent-target remote terminals** are not supported (project-only ticket kind); this matches the
   implementation notes but is still called out in the plan's full target model.

**Specifically not re-verified here (accepting round-1 status):** F7 (no sender-frame allowlist), F8 (remote pi
argv logging), F9 (inlined helper vs. plan layout), F10 (no per-launch bundle re-hash) are unchanged and remain
documented info-level items, not blockers by themselves.

Other residual observations from the round-1 report that remain true and were not re-audited in depth: the
same-account threat model (helper/runner/bundle integrity is not an OS sandbox), `ssh -G` not being offline,
multi-window confirmation TTLs, and the absence of a global sender-frame allowlist (F7). None of the new
surfaces changed those assumptions.

## 7. Non-goals

- No source changes, no commits, no edits outside this report; the release ledger/handoff/plan/Git plan were
  read only.
- No real-host SSH, no Playwright/e2e, no full `npm test`, no `npm run pack`/build, no app restart, no network.
- Not a dependency/CVE/supply-chain audit; not a cryptographic review of SSH/sha256 beyond code checks.
- Not a review of local/WSL behaviour or non-remote IPC (except local terminal parity as a negative control).
- Not a fuzzing or penetration test; protocol/script behaviour was assessed from source, contracts and tests.
- Not a re-audit of every Git/delta surface added since round 1; those were spot-checked at code/test level
  (§3.7) and are covered by the existing targeted tests listed in §8.

## 8. Evidence appendix

Targeted batches (exact, read-only, Windows host, HEAD 2da2be007; all exit 0):

    node --test --test-concurrency=2 tests/remoteProjectEntryCommands.test.mjs tests/remoteProjectEntryIpc.test.mjs tests/remoteProjectEntryService.test.mjs tests/remoteProjectEntryState.test.mjs tests/remoteProjectEnrollCreate.test.mjs tests/remoteBundleMaintenance.test.mjs tests/remoteHostIdentityFile.test.mjs tests/remoteHostIpc.test.mjs tests/remoteSessionHistoryRead.test.mjs tests/remoteSessionHistoryWrite.test.mjs tests/remoteSessionWriteGuardUi.test.mjs tests/remoteBootstrapSession.test.mjs tests/remoteProjectFileIpc.test.mjs tests/remoteProjectIpc.test.mjs tests/sessionRuntimeCoordinator.test.mjs
    → tests 261, pass 241, fail 0, skipped 20

    node --test --test-concurrency=2 tests/remoteTerminalPrepare.test.mjs tests/remoteTerminalRunner.test.mjs tests/remoteTerminalLauncher.test.mjs tests/remoteTerminalAdapter.test.mjs tests/remoteTerminalCommand.test.mjs tests/remoteTerminal.test.mjs tests/remoteHelperEntry.test.mjs tests/terminalShell.test.mjs
    → tests 86, pass 72, fail 0, skipped 14

    node --test --test-concurrency=2 tests/remoteGitCompare.test.mjs tests/remoteGitCompareIpc.test.mjs tests/remoteGitCompareView.test.mjs tests/remoteGitInit.test.mjs tests/remoteGitInitIpc.test.mjs tests/remoteGitInitView.test.mjs tests/remoteGitRefsPolling.test.mjs tests/remoteGitRepos.test.mjs tests/remoteGitRepoScopeView.test.mjs tests/remoteGitScopedWrite.test.mjs tests/remoteGitService.test.mjs tests/remoteGitSync.test.mjs tests/remoteGitReadIpc.test.mjs
    → tests 129, pass 81, fail 0, skipped 48

    node --test tests/remoteBundleMaintenance.test.mjs  → 12 pass, 0 fail, 0 skip
    node --test tests/remoteHostIdentityFile.test.mjs  → 5 pass, 0 fail, 0 skip

Skipped coverage (POSIX/Linux-only, cannot verify here): file-management real scripts (uid/gid/mode,
symlink/O_NOFOLLOW, real `/bin/sh`), session write-guard real commands, terminal real PTY/ticket
consumption/termios, real Git repositories and sync fixtures. These are the items a Linux run must cover.

Snapshot commands: `git rev-parse HEAD` = 2da2be0076145d16a4e472c115493806926ac30e. `git status --porcelain`
at review start showed only ` M docs/remote-release-gate-status.md`; at report-write time it additionally
shows another lane’s uncommitted remote-session-delete work (see the concurrent lane note in §0) — none of it
is in this report’s scope, and the reviewed-file citations do not depend on it except for the few line-number
caveats noted there. Grep findings used as absence evidence: no `.pideck-trash`
filter anywhere under `src/main` outside the entry/read/write modules; no sender-frame allowlist under
`src/main` (0 matches); no `generate-remote-host-manifest`/`check:remote-host-manifest` in `scripts/` or npm
scripts; `sweepTerminalTickets(` appears only as its own definition and inside `mintTerminalTicket` in the
frozen helper body.

### 8.1 Recommended next steps (ordered, smallest first)

1. Fix R2-1 (two filters + two tests) or correct the ledger wording; it is user-visible and cheap.
2. Decide R2-2 as either a code change (TTL ≤60 s, startup sweep, claim-file sweep) or an explicit plan
   amendment; do not leave the plan and implementation silently divergent.
3. Run the 82 POSIX-only skipped tests on Linux (and ideally the Lead's real-host e2e again) before quoting
   ledger evidence externally.
4. Have an independent human reviewer re-audit F1–F6 fixes plus R2-1/R2-2 on a clean tree at the release
   candidate; the “security review completed” gate should cite that, not this AI lane.
