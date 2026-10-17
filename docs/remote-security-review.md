# PiDeck SSH Remote Development — Independent Security Review (G6)

> Status: **report only** (shared task `task-2`, G6). No source file was modified and no commit was made.
> This document is an **adversarial, evidence-backed review of the code as shipped on this branch**, not a
> restatement of the plan docs. Every claim below is marked `[verified]`, `[inferred]` or `[cannot-verify]`
> and carries a `file:line` anchor. Where a doc claim and the code disagree, the code (or an executed probe)
> is the evidence, and the disagreement is reported.
>
> Audited by an AI agent lane (security-audit). This is **not** an independent human security review; see
> §7 for that follow-up. No real host, packaged build, or cross-platform client was available in this
> session; no Playwright/e2e test and no full `npm test` was run (both were forbidden by the task).
> **Remediation status:** F2/F4/F5/F6 have main-side fixes + targeted tests in the follow-up batch — see
> [remote-security-remediation.md](remote-security-remediation.md). This report's findings remain the
> unmodified snapshot at `11f68b27d`.

## 0. Review snapshot (read this before trusting line numbers)

| Item | Value |
| --- | --- |
| Repository | `F:\PiDeck-remote` |
| Branch | `feat/remote-development` |
| HEAD commit | `11f68b27d` (`test(remote): cover the conflicted pull on a real host too`) |
| Working tree | **not clean** during the review (concurrent teammate lane writing G5b) |
| Dirty files observed | `docs/remote-git-plan.md`, `src/main/remote/RemoteGitReadSource.ts`, `src/main/remote/RemoteHelperContract.ts`, `src/main/remote/RemoteHelperEntry.ts`, `src/main/git/RemoteGitService.ts`, `src/shared/ipc.ts`, `src/shared/types/git.ts` (`git diff --stat`: 7 files, +154/−5). The in-flight change adds `git.compare` and helper build 1.16.0. |

Consequences:

- Findings and test results describe **HEAD 11f68b27d + that uncommitted lane state**. They are not a review
  of the final Phase 5 commit.
- Line numbers in the four concurrently-edited source files
  (`RemoteGitReadSource.ts`, `RemoteHelperContract.ts`, `RemoteHelperEntry.ts`, `RemoteGitService.ts`)
  drift as that lane keeps editing. For those files the citation includes a stable anchor string
  (symbol / literal) so it can be re-located with grep. All other cited files were unchanged.
- Re-run this review on a clean tree at the Phase 5 release candidate (§7).

Legend used throughout: **[verified]** = read the code and, where useful, ran the existing targeted test or a
read-only probe; **[inferred]** = follows from code/docs/tests but was not directly reproduced here;
**[cannot-verify]** = needs a real host, packaged build, or another platform/client.

## 1. Verdict

**No critical or high-severity vulnerability was found in the reviewed remote surface.** The SSH/helper/Git
architecture is markedly fail-closed: strict pinned SSH argv, authenticated host-key enrollment with a
main-owned confirmation broker, per-sender one-shot capabilities, bounded framing/concurrency, content-addressed
helper deployment with activation-time byte verification, main-owned mutation tokens for remote Git writes, and
bounded/atomic remote file writes. The strongest parts are the SSH identity chain and the remote Git write path.

What is **not** true is that the surface is ready to be claimed as Remote v1: **the Phase 5 security gate of
`docs/remote-development-plan.md` §12 is not met** (§6 below). Several gate items are unimplemented by design
(terminal one-shot ticket, remote create-project/file rename/delete, remote config backend) or unverified
(cross-platform client smoke, packaged build, helper upgrade/downgrade and power-loss recovery, independent
reviewer).

The only medium-severity defect found is a **remote Git sync deadline bug** (F1): network verbs inherit the
30-second read deadline while a 600-second budget exists but is dead code, so a slow `fetch`/`push`/`pull`
fails, and `push`/`pull` are then reported as “result unconfirmed”. The rest are low/info: a missing host-side
cleanup/sweep for deployed helper bundles and staging directories (F2), the explicitly-unimplemented terminal
launch ticket (F3), an unexpanded `IdentityFile ~/...` path that breaks the “add host from SSH config”
candidate flow (F4), receipt-loss ambiguity for remote session-history writes shown as “try again” (F5), a
defense-in-depth gap in absolute session-path validation (F6), and four threat-model/ops observations (F7–F10).

Severity counts: **critical 0, high 0, medium 1, low 5, info 4.**

## 2. Method and evidence base

### 2.1 What was reviewed

Scope (a)–(h) of the task maps to these files (all under `src/main/` unless noted):

| Scope | Main files read |
| --- | --- |
| (a) SSH identity chain vs remote-Git credential chain | `remote/SshCommandBuilder.ts`, `remote/SshClientRuntime.ts`, `remote/SshHostVerifier.ts`, `remote/SshRouteDigest.ts`, `remote/SshVerifiedConnection.ts`, `remote/SshProcessLauncher.ts`, `remote/RemoteHelperCommand.ts`, `remote/RemoteGitReadSource.ts`, `remote/RemoteGitSyncSource.ts` |
| (b) host pin/trust/revision, helper downgrade/negotiation | `remote/SshHostPinStore.ts`, `security/PendingConfirmationBroker.ts`, `remote/RemoteHostStore.ts`, `remote/RemoteHostStoreCodec.ts`, `remote/RemoteHostPaths.ts`, `remote/RemoteTrustKey.ts`, `remote/RemoteProjectTrustService.ts`, `remote/RemoteProjectTrustHostFacts.ts`, `remote/SshConnectionAttempt.ts`, `remote/SshConnectionManager.ts`, `pi/remoteRuntimePort.ts`, `pi/piRemoteRuntimePlan.ts`, `pi/piRpcArgs.ts` |
| (c) helper NDJSON protocol + bundle deployment | `remote/RemoteHelperContract.ts`, `remote/RemoteControlClient.ts`, `remote/RemoteBootstrapContract.ts`, `remote/RemoteBootstrapSession.ts`, `remote/RemoteBootstrapTransfer.ts`, `remote/RemoteBootstrapUpload.ts`, `remote/RemoteBootstrapDeployment.ts`, `remote/RemoteHelperEntry.ts`, `remote/RemoteRunnerEntry.ts`, `remote/RemoteRunnerContract.ts` |
| (d) main IPC boundary | `ipc/remoteHostIpc.ts`, `ipc/remoteProjectIpc.ts`, `ipc/remoteProjectFileIpc.ts`, `ipc/remoteSessionIpc.ts`, `ipc/remoteGitReadIpc.ts`, `git/RemoteGitService.ts`, `git/RemoteGitMutationTokens.ts`, `preload/index.ts` (remote API surface) |
| (e) remote Git writes/sync side effects | `git/RemoteGitService.ts`, `ipc/gitIpc.ts` (remote routing/negative controls), `git/GitBackend.ts`, `remote/RemoteGitWriteSource.ts` (selective), `remote/RemoteGitSyncSource.ts` |
| (f) session-history write guard + remote text-file write | `remote/RemoteSessionWriteGuard.ts`, `remote/RemoteSessionHistoryWriter.ts` (code paths 55–100, 185–260, 675–824), `remote/RemoteSessionHistoryReader.ts` (path validation/resolution), `remote/RemoteProjectFileService.ts`, `remote/RemoteProjectFileCommands.ts`, `sessions/SessionRuntimeCoordinator.ts` (remote mutation branch), `renderer/src/utils/sessionCommands.ts` (error surface) |
| (g) terminal minimal loop | `terminal/RemoteTerminalSessionManager.ts`, `terminal/createRemoteTerminalManager.ts`, `remote/RemoteTerminalCommand.ts`, `ipc/terminalIpc.ts`, `remote/RemoteHostConnectionService.ts` (`withTerminalInvocation`) |
| (h) logging/error redaction | `remote/SshConnectionDiagnostics.ts`, `remote/RemoteHostConnectionTypes.ts` (contract types), `remote/SshConnectionManager.ts`, `remote/SshProcessLauncher.ts`, `AgentManager.ts` (log statement), `pi/piRpcArgs.ts` |

Docs read for boundaries and claims: `AGENTS.md`, `docs/remote-development-plan.md`
(§5.2, §6.5.1, §6.5.2, §7, §8, §12 Phase 0/2/5, §13), `docs/remote-git-plan.md`
(§3, §5.1–§5.16.1, §6), `docs/remote-development-handoff.md` (write surface, P4.5c, terminal slice),
`docs/remote-write-plan.md`, `docs/remote-trust-plan.md` (referenced), `docs/remote-phase4-plan.md` (referenced).

### 2.2 Tests actually run (targeted, read-only)

All commands were `node --test --test-concurrency=2 <files>` from the repository root, on the Windows review
host, against the dirty tree described in §0. No full `npm test`, no e2e, no network/real host.

| Batch | Files | Result | Notes |
| --- | --- | --- | --- |
| A | `sshCommandBuilder`, `sshVerifiedConnection`, `sshHostPinStore`, `sshHelperCapabilityGate`, `remoteControlClient`, `remoteGitTrustGate`, `remoteIpcRouteOrder`, `remoteTerminalCommand`, `remoteBootstrapContract` | **162 tests: 159 pass, 1 fail, 2 skip** | The failure is `tests/remoteTerminalCommand.test.mjs:9`: it spawns `/bin/sh` and requires a canonical POSIX path; on Windows it dies with `REMOTE_BROWSE_ROOT_UNRESOLVED`. Environment limitation, not a product regression. |
| B | `remoteHelperEntry`, `remoteBootstrapDeployment`, `remoteBootstrapSession`, `remoteGitSync`, `remoteGitWrite`, `remoteSessionWriteGuard`, `remoteProjectFileService`, `remoteHostStore`, `remoteGitMutationTokens`, `remoteSessionHistoryWrite` | **170 tests: 91 pass, 1 fail, 78 skip** | Failure is `tests/remoteProjectFileService.test.mjs:13` (`REMOTE_FILE_PATH_INVALID`): fixture passes Windows `process.execPath` and `/bin/sh`; the production command builder correctly requires a canonical POSIX node path (Linux-remote-only feature). 78 skips are the POSIX-only write-guard checks (uid/gid/mode/symlink/real-command semantics) — **cannot-verify on this host**. |
| C | `remoteTrustKey`, `remoteProjectTrustStore`, `remoteTrustFlagArgs`, `remoteHostRetireTrustCleanup` | **25 pass, 0 fail** | Confirms trust-key material requirements, endpoint-change invalidation, “undecided ⇒ no flag”, retire cleanup. |

Two read-only probes were also executed with `node --input-type=module -e` (no files written):

1. `RemoteHostStoreCodec.decodeRemoteHostSnapshot` with `identityFile` values:
   `~/.ssh/id_ed25519` → `REMOTE_HOST_STORE_INVALID`; `.ssh/id_ed25519` → `REMOTE_HOST_STORE_INVALID`;
   `/home/u/.ssh/id_ed25519` → accepted. (Evidence for F4.)
2. `validateRemoteSessionHistoryPath` with `/home/u/.pi/agent/sessions/../../../etc/passwd` → returned
   unchanged (accepted), same for `.../sessions/../x.jsonl`. (Evidence for F6.)

### 2.3 Threat model the code assumes (from `docs/remote-development-plan.md` §8.1, lines 550–555)

These assumptions are necessary for the “no high severity” verdict and are **not enforced by OS isolation**:

1. The local Electron main process, the local OpenSSH client and the chosen remote Unix account are trusted.
2. Remote pi, helper, runner, Git and the terminal all run as the **same remote Unix account**; that account
   could already read/write whatever those components can. Root/sha/owner checks are routing, misuse and
   integrity-drift protection, **not** an OS sandbox against a malicious same-account process.
3. A same-account malicious process can forge symlink TOCTOU, rewrite deployed artifacts, or forge leases.
4. Renderer input, network data, remote project content, protocol frames and command output are untrusted and
   are validated at the boundary (this is implemented and verified extensively below).
5. First host-key contact is explicit TOFU with user-verified fingerprint display; afterwards strict pinning.
6. No credentials are copied from local to remote; remote Git/pi use the remote account's own identity chain
   (verified by design; real-host behavior cannot be verified here).

If assumption (2) or (3) is ever weakened (e.g. running untrusted workloads, multi-tenant host), this review's
verdict does not carry over — see §7.

## 3. Scope-by-scope assessment (claims, evidence, status)

### (a) SSH identity chain vs. remote-Git credential chain separation — strong, no finding for injection

- **[verified]** Pinned SSH argv is built as an array (never a shell string) with the full strict set:
  `UserKnownHostsFile=<pin>`, `GlobalKnownHostsFile=NUL|/dev/null`, `HostKeyAlias=<pinAlias>`,
  `StrictHostKeyChecking=yes`, `HostKeyAlgorithms=ssh-ed25519`, `KnownHostsCommand=none`,
  `VerifyHostKeyDNS=no`, `UpdateHostKeys=no`, `CheckHostIP=no`, `ControlMaster=no`,
  `ControlPath=none`, `ForwardAgent=no`, `ForwardX11=no`, `ClearAllForwardings=yes`,
  `PermitLocalCommand=no`, `RemoteCommand=none`, `BatchMode=yes`, `NumberOfPasswordPrompts=0`,
  `SendEnv=-*`, bounded `ConnectTimeout`/`ConnectionAttempts=1`, keepalives; `-i` + `IdentitiesOnly=yes`
  only when a profile has an identity file — `SshCommandBuilder.ts:79–142` **[verified by
  `tests/sshCommandBuilder.test.mjs`, batch A]**.
- **[verified]** Before every use the effective client config is re-queried with `ssh -G` and asserted to be
  exactly the strict set; alias retargeting, jump changes, forwarded env, pin/profile revision changes and a
  pending rebind journal all block the invocation — `SshVerifiedConnection.ts:53–106, 129–171`,
  `SshRouteDigest.ts:20–62`; `sshVerifiedConnection.test.mjs` passes (batch A).
- **[verified]** Host key enrollment is authenticated-first, fingerprint parsed from the authenticated
  known_hosts line (single `ssh-ed25519`, alias-bound), and published only after a main-owned,
  sender-bound user confirmation; the pin file is written with O_EXCL-style hard-link publication and
  `0600` — `SshHostVerifier.ts:29–70, 149–186`; `SshHostPinStore.ts:143–202, 264–289`;
  `PendingConfirmationBroker.ts:37–73`; tests `sshHostPinStore`, `sshHostVerifier` pass (batch A).
- **[verified]** OpenSSH client resolution never goes through PATH; it validates regular-file/executable
  (rejects shims and symlinks), and its environment is a strict allowlist that removes `PI_*`, model keys,
  `NODE_OPTIONS`, `ELECTRON_*`, generic proxies and `SSH_ASKPASS` — `SshClientRuntime.ts:41–71, 73–94,
  141–165, 177–234, 261–270`.
- **[verified]** Remote Git uses the **remote account's own** identity chain: the helper sanitizes the Git child
  env by dropping every inherited `GIT_*` variable (plus `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`,
  `PAGER`, `LESS`) and only re-adds `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`,
  `GIT_EXTERNAL_DIFF=""`; it never injects `GIT_SSH`/`GIT_SSH_COMMAND`/`GIT_ASKPASS` — `RemoteGitReadSource.ts`
  anchor `function environment()` (current lines 69–73); spawn is `shell:false, detached:true` with fixed
  argv (anchor `cp.spawn(ctx.executable`, current line ~153); network verbs are explicit code, documented
  and implemented without credential/config writes — `RemoteGitSyncSource.ts:5–17, 24–29, 69–145`
  **[verified by `remoteGitSync.test.mjs`, batch B (pass)]**.
- **[verified]** Remote Git never returns remote URLs or credentials to the renderer: `git.syncFacts`
  returns remote **names** only, and main re-validates them against a closed name regex
  (`RemoteGitSyncSource.ts:24–28`; `RemoteGitService.ts` anchor `remoteGitSyncRemote`; renderer type
  `RemoteGitSyncFactsView` has `remotes: string[]`).
- **[inferred]** `ssh -G` can execute user-configured `Match exec` / `ProxyCommand` / DNS lookups; the code
  acknowledges this (`SshVerifiedConnection.ts:128` comment). A hostile *local* SSH config is outside the
  threat model, but “preflight is not offline” is a real property; admin-fixed jump chains are required for
  stronger guarantees (plan §8.3 line 269).
- **[cannot-verify]** Actual real-host authentication, agent availability, jump-host policy, and whether the
  remote Git verbs use the expected remote identity (no real host in this session).

### (b) Host pin/trust/revision and helper downgrade/version negotiation — strong

- **[verified]** Profile store is a strictly versioned envelope with revision CAS, immutable verified endpoint,
  draft-only in-place edits, tombstoned referenced profiles, durable retired ids, and a strict codec that
  re-validates every field (including absolute `identityFile`, ed25519 fingerprint shape, host/route via
  `buildSshConfigQueryArgs`) — `RemoteHostStoreCodec.ts:24–134`, `RemoteHostStore.ts` `mutate`/`createDraft`/
  `offerPin`/`confirmPin` (lines ~297–470); `remoteHostStore.test.mjs` passes (batch B).
- **[verified]** Every helper/agent/bootstrap/scp/terminal invocation goes through
  `buildPinnedSshInvocation`, which re-reads the ready profile + pin, re-queries the route, asserts the strict
  config, then re-reads the store revision and pin before returning argv; a pending rebind journal or lock
  blocks it — `SshVerifiedConnection.ts:37–47, 129–171`.
- **[verified]** Trust material requires cryptographic facts and a canonical absolute remote root; any missing
  material ⇒ no decision; trust key = `hostId::sha256(endpoint facts)::canonicalRoot`, so the same path on two
  hosts and a re-installed host do not share trust — `RemoteTrustKey.ts:30–44, 53–94`;
  `RemoteProjectTrustService.ts:52–113`; tests `remoteTrustKey` etc. (batch C: 25/25 pass, including
  “endpoint change invalidates old decision” and “undecided ⇒ no flag”).
- **[verified]** Trust is passed to remote pi only as `--approve` or `--no-approve`, mapped in exactly one place,
  and an undecided/denied/unreadable decision adds no flag (no implicit approve) — `piRpcArgs.ts:36–50, 69`;
  `piRemoteRuntimePlan.ts:14, 62`; batch C passes those regressions.
- **[verified]** Version negotiation: the handshake rejects a helper whose `protocolVersion` is not 1 with a
  fatal `SSH_HELPER_PROTOCOL_MISMATCH`; required capabilities `fs.stat`/`fs.list`/`fs.read` missing ⇒ fatal
  `SSH_HELPER_CAPABILITY_MISSING`; the canonical root reported by `hello` must equal the requested root
  (absent==absent for host-only sessions) — `SshConnectionAttempt.ts:220–269`; fatal classification
  `SshConnectionManager.ts:252–293`. Git methods are additionally gated per call by re-reading `hello` and
  requiring `capabilities.includes(method)`, so an older helper without Git write/network methods cannot be
  silently used — `RemoteGitService.ts` anchor `hello.protocolVersion !== REMOTE_HELPER_PROTOCOL_VERSION`
  (current line 458); test `remoteGitService.test.mjs:86` covers it (file not in the batches run here — see §7).
- **[verified]** There is no code path that launches an older/other helper bundle: the remote command is built
  from the **current process's** frozen bundle hash (`RemoteBootstrapDeployment.frozenHelperBundleManifest`
  and `ensureHeld`), and the bootstrap entry refuses to overwrite an already active directory whose bytes/modes
  differ (`BOOTSTRAP_ACTIVE_CONFLICT`), re-verifying it read-only instead — `RemoteBootstrapDeployment.ts:36–52`,
  `RemoteBootstrapContract.ts` frozen entry (`activeMatches`), `RemoteHostConnectionService.ts:317–347`.
- **[inferred]** “Downgrade” in the sense of a *newer* app connecting to an *already-deployed older* helper cannot
  happen through PiDeck, because PiDeck only ever launches its own content-addressed bundle; a foreign helper on
  the account is never executed. No explicit test named “downgrade”; the negative cases (protocol mismatch,
  capability missing) are the tested proxies.
- **[cannot-verify]** Real host pin files / known_hosts handling; production process/environment.

### (c) Helper NDJSON protocol and bundle deployment — strong protocol, deployment hygiene gap (F2/F9)

- **[verified]** Frame handling is bounded and fenced: 8 MiB frame ceiling, strict identity echo
  (v/hostId/generation/id), closed stable-code vocabulary, 128 pending-request local cap, exactly-once
  settlement, local deadline + bounded early re-arm, cancel with “already-settled/commit-started” semantics
  (never fakes rollback), stale generation/wrong host/duplicate/unknown id dropped with redacted diagnostics —
  `RemoteControlClient.ts:206–233, 328–334, 407–493, 536–584`; `remoteControlClient.test.mjs` passes
  (batch A, including the “declined cancel keeps the real result” case).
- **[verified]** Helper-side bounds exist in the frozen body and contract constants: 4 in-flight + 64 queued,
  per-method output caps, `fs.searchNames` 512/20000/12 limits, 4096-entry list refusal, bounded text chunks,
  8 MiB frame cap, errors as stable codes — `RemoteHelperContract.ts:14–37, 54–101, 251–310, 314–338, 401–431`;
  helper body anchor `MAX_CONCURRENT = 4` / `activeDeadline = Math.min(activeDeadline, Date.now() + 30000)`
  (`RemoteHelperEntry.ts:117` in the snapshot tree; build/sha are pinned at lines 108/123 and are recomputed by
  `remoteHelperEntry.test.mjs`, batch B pass).
- **[verified]** Bundle manifest is content-addressed, strict-decoded (unknown fields, dup/case-collision names,
  unsafe segments, size overruns all refused) and compared set-wise against remote observations; the remote
  entry re-verifies every staged file (regular, non-symlink, owner, forced declared mode, exact bytes, sha256),
  fsyncs, and makes the single `rename` the only commit point; an abort after the commit point is answered
  `aborted/requested` without deleting what was activated — `RemoteBootstrapContract.ts:210–347`;
  `RemoteBootstrapDeployment.ts:101–127`; `RemoteBootstrapUpload.ts:92–140, 186–211, 227–255`
  **[verified by `remoteBootstrapContract`, `remoteBootstrapDeployment`, `remoteBootstrapSession` tests, batch B
  pass]**.
- **[verified]** Deploy lock is O_EXCL + holder identity (pid + process start identity + nonce), taken before
  the staging dir is created; staging is `0700`, files `0600`/`0700`; the scp target is the bootstrap-reported
  staging identity only, never a renderer/project path; SFTP vs legacy scp formatting is chosen from the
  *actual* pinned client version and legacy paths are POSIX-quoted — `RemoteBootstrapContract.ts` frozen entry,
  `RemoteBootstrapUpload.ts:45–75, 227–255`.
- **Gap F2:** no remote-side retention/cleanup/sweep implementation exists. Plan §4.2 (lines 184, 186) requires
  reachability-based retention (active/rollback/lease), ≤2 unreferenced snapshots and ≤7 days, staging
  cleanup after 1 h, artifact 24 h TTL, terminal-ticket TTL; none of that is implemented or tested; the frozen
  entry cleans only its own failure/EOF paths. Details and remediation in F2.
- **Gap F9:** the plan's on-disk helper layout (`resources/remote-host/` + generated manifest +
  `check:remote-host-manifest` build gate — plan lines 177–181) is not what shipped: helper/runner bodies are
  TypeScript string constants with hard-coded sha256 pins, and the manifest is computed at runtime
  (`RemoteHelperEntry.ts:117–141`, `RemoteBootstrapDeployment.ts:36–38`). Integrity properties still hold
  (activation re-checks bytes; sha constants are test-verified), but there is no packaging gate script and no
  on-disk artifact to inspect. See F9.
- **[cannot-verify]** A real bootstrap/finalize on a host; packaged build behavior.

### (d) Main IPC boundary — sender-scoped capabilities are real; no origin/frame allowlist (F7)

- **[verified]** Every remote channel is gated by `enabled` and validates input at the boundary; unknown fields
  are rejected for target-shaped inputs (e.g. Git file target accepts only `projectId`/`relativePath` and must
  match the call's `projectId`) — `ipc/remoteGitReadIpc.ts:68–87, 128–235`; `ipc/remoteProjectFileIpc.ts:21–55`;
  `ipc/remoteSessionIpc.ts:99–148`; `ipc/remoteHostIpc.ts:112–134`.
- **[verified]** One-shot main-owned capabilities: host fingerprint confirmation (broker bound to
  `webContents.id`, action, subject, state digest, TTL; re-authentication + digest equality before writing the
  pin), repair confirmation, project-enrollment confirmation (with a **second** canonical re-probe before
  persisting), Git mutation tokens (32-hex random, sender+project+kind+expectation bound, 128 entries/15 min,
  consumed before the first await), remote text-file version tokens (128/30 min, sender+project+path+host/root
  snapshot+host revision+file identity), terminal tab ids minted in main — `SshHostPinStore.ts:143–202`,
  `PendingConfirmationBroker.ts:37–73`, `ipc/remoteHostIpc.ts:282–344`, `ipc/remoteProjectIpc.ts:122–193`,
  `git/RemoteGitMutationTokens.ts:9–43`, `remote/RemoteProjectFileService.ts:8–41, 106–136`,
  `terminal/RemoteTerminalSessionManager.ts:99–137` **[verified by batch A `remoteIpcRouteOrder` /
  `sshHostPinStore` and batch B `remoteGitMutationTokens`]**.
- **[verified]** Cross-project/cross-host isolation: Git target is re-read from the store and compared at every
  await boundary and to the token expectation (`RemoteGitService.ts` anchor `assertCurrent` and
  `expected.target` checks, plus the `hostRevision` check); file-service tokens snapshot host/path/host revision
  and compare; terminal runtime stores host/root and re-reads the project locator immediately before native
  spawn and before each input/resize — `RemoteGitService.ts:326–369, 399–405, 412–416`;
  `RemoteProjectFileService.ts:106–136`; `RemoteTerminalSessionManager.ts:164–185`;
  `createRemoteTerminalManager.ts:20–44`.
- **[verified]** Secret/URL redaction at this boundary: diagnostics are rebuilt from enumerable
  state/phase/code values and dropped when invalid (`SshConnectionDiagnostics.ts:30–51`, re-validated in
  `remoteHostIpc.ts:63–74`); error messages cross IPC only as a stable code (every `codeOf` helper); pin
  request projection deliberately omits `routeDigest`/`knownHostsSha256`/pin path
  (`remoteHostIpc.ts:510–512` vs `RemoteHostPinRequest` type `shared/types/remoteHost.ts:85–93`);
  Git sync facts carry remote names only.
- **Gap F7:** there is no `senderFrame`/origin allowlist on any IPC handler (repo-wide grep for
  `senderFrame|validateSender|assertTrustedSender|isTrustedSender` in `src/main` → 0 matches). Identity is
  `event.sender.id` only (`remoteHostIpc.ts:505–508`), which is what the one-shot capabilities bind to. The
  browser-panel webview has no preload and cannot call `ipcRenderer`, so the practical exposure is “compromised
  renderer”, which already has the app's full privileged IPC. Info-level, app-wide, not remote-specific. See F7.
- **[cannot-verify]** Real two-window/dual-instance IPC behavior (no e2e).

### (e) Remote Git write/sync side effects and unknown-result semantics — safe direction, deadline bug (F1)

- **[verified]** Stage/unstage/commit/branch/discard/recovery/sync are all main-gated by main-owned
  expectations and native Git CAS primitives: index writes use the official .git/index.lock + private shadow
  index and publish only validated path-scoped changes; commit uses `write-tree` + `commit-tree` +
  `update-ref <new> <old>` (native ref CAS); hooks/signing/filters refuse rather than being bypassed; branch
  action names are validated by `check-ref-format --branch` plus local rules; discard snapshots bytes behind
  `refs/pideck/recovery/*` before touching the worktree; sync verbs never force, never set upstream, never
  choose a merge strategy — helper source metadata in `RemoteHelperEntry.ts:57–89` and
  `RemoteGitWriteSource.ts:9–30`, `RemoteGitSyncSource.ts:5–17, 88–145`; targeted helper tests
  `remoteGitWrite`/`remoteGitSync` pass (batch B; recovery was not in the batch — see §7).
- **[verified]** No local Git fallback for SSH projects: only the two existing read channels route to the remote
  backend (`gitIpc.ts:573–603`), every other local Git handler goes through `requireGitCwd` →
  `GitBackendRouter.forProject` → `isLocalProject` and throws `UNSUPPORTED_PROJECT_LOCATION`
  (`gitIpc.ts:260–315, 299–302`; `GitBackend.ts:67–86`); remote writes/recovery/sync have dedicated
  `git:remote-*` channels and handlers (`shared/ipc.ts:461–478`; `remoteGitReadIpc.ts:94–268`). UI-level
  “does remote UI ever call the local channels” was **not** trace-verified (inferred from the docs' source-level
  guards); see §6 item 3 / §7.
- **[verified]** Unknown-result semantics are conservative: once a write frame was dispatched, a later
  timeout/cancel/connection-lost/target-change/command-failure is mapped to `GIT_WRITE_RESULT_UNCONFIRMED`
  (`RemoteGitService.ts` anchor `dispatchedWrite` mapping, current line 471), renderer keeps the warning across
  later failures and only clears it after a successful readback of repository facts
  (`renderer/src/utils/remoteGitViewState.ts:141–175, 522–523`; copy `rendererCopy.zh-CN.ts:19,86`); no
  automatic retry/refresh-on-write exists in the service.
- **Defect F1 (medium):** every helper request uses the **30 s** read timeout, including `git.fetch`,
  `git.push`, `git.pull`, while a 600 s sync budget is defined but unused; the frozen helper additionally clamps
  Git jobs to 30 s. Details/remediation in F1.
- **[cannot-verify]** Real network verbs; real hook/signing refusal on a host; real 30 s boundary behavior.

### (f) Remote session-history write guard and remote text-file write — strong, two low gaps (F5, F6)

- **[verified]** Session-history rewrite path: main gates on “no live runtime / not activating” **before**
  sending anything (`SessionRuntimeCoordinator.ts:1987–1991, 2006–2027`); remote path resolution is shared with
  the read side; content is bounded at 256 KiB and read back chunk-by-chunk with exact-length checks; the
  rewrite is computed locally with the same JSONL rules, uploaded to a same-directory `.<name>.<nonce>.pideck-tmp`
  created under `umask 077` + `set -C` (noclobber), then a fixed Node guard re-verifies upload mode
  (`0600`), size, digest, uid/gid, source identity (mode/size/dev/ino/uid/gid/mtimeNs/ctimeNs/SHA-256), restores
  the source mode without chown, `renameSync`s atomically, and re-checks the replacement —
  `RemoteSessionHistoryWriter.ts:185–231, 675–824`; `RemoteSessionWriteGuard.ts:30–93, 105–146, 149–178`;
  tests `remoteSessionWriteGuard` / `remoteSessionHistoryWrite` (batch B: mock-exec semantic tests pass; the
  real POSIX command tests were **78 skipped on Windows**).
- **[verified]** Remote text-file save path: Linux-only fixed Node command anchored on a per-command
  `/proc/self/fd` parent-directory fd, per-level non-symlink checks, O_NOFOLLOW leaf open, canonical-root
  re-check per command, upload to same-directory `0600` temp with O_EXCL first chunk / O_APPEND continuation,
  identity/size/digest re-check, uid/gid match, mode restore, fsync, rename, and post-rename read-back
  verification; main keeps an opaque version token bound to sender/project/path/host/root/host-revision/file
  identity, 128 entries/30 min, consumed before any await — `RemoteProjectFileCommands.ts:11–127`;
  `RemoteProjectFileService.ts:29–143`; `ipc/remoteProjectFileIpc.ts:21–55`. Real-command tests
  **failed here for Windows-environment reasons** (batch B), so those semantics are cannot-verify on this host.
- **[inferred]** TOCTOU between the final identity check and `rename` remains (non-kernel CAS, non-cooperative
  writers), as the docs state (`remote-write-plan.md:49`); no ACL/xattr copying, hard links to the old inode do
  not follow. This is an accepted, documented boundary of the same-account threat model.
- **Gap F5:** after a rename that succeeded, a lost stdout/exit path can produce a “command failed” whose code
  comment claims the target was untouched, and the UI shows generic “operation failed, retry”. See F5.
- **Gap F6:** absolute `remotePath` values are not checked for canonical form (`.`/`..`/empty segments) although
  the docs call the check canonical; the production writers happen to reject those, so this is
  defense-in-depth only. See F6.

### (g) Terminal minimal loop — fixed command/no injection; one-shot ticket explicitly absent (F3)

- **[verified]** The renderer can name only a project id (or an agent target, rejected for remote); main resolves
  the project's SSH locator; remote terminals are keyed by `(senderId, projectId)`; shell selection is
  restricted to `"sh"` and no cwd/shell/argv from the renderer is accepted — `ipc/terminalIpc.ts:83–133`;
  `terminal/RemoteTerminalSessionManager.ts:99–137`.
- **[verified]** Remote command is a fixed template: `cd -- '<verified root>' && [ "$(pwd -P)" = '<root>' ] &&
  [ -x /bin/sh ] || exit 73; PATH='<node dir>':"$PATH"; export PATH; ENV=; export ENV; printf '<nonce marker>';
  exec /bin/sh -i`; both paths are validated canonical POSIX and single-quoted; no user text and no executable
  code is interpolated — `remote/RemoteTerminalCommand.ts:8–17`.
- **[verified]** Lifecycle/ownership: PTY spawn occurs inside `withTerminalInvocation` after a pinned invocation
  and an identity assertion; project authority is re-read immediately before the native spawn; each tab has a
  nonce marker handshake with a 30 s deadline and 32 KiB cap, output is packetized (≤32 KiB, one in-flight,
  256 KiB queue, replay buffer 128 Ki chars), per-tab/window/project quotas, and cleanup is paired
  (`abort` → listener disposal → `terminal.kill()`; `finish` idempotent) — `RemoteTerminalSessionManager.ts:
  63–72, 139–162, 187–309, 311–332`; `createRemoteTerminalManager.ts:16–47`;
  `RemoteHostConnectionService.ts:493–505, 90–91`; `terminalIpc.ts:117–168`.
- **Gap F3:** the one-shot `terminal.prepare` launch ticket + `terminal-runner.mjs` design of plan §6.5.2
  (`docs/remote-development-plan.md:484–493`) is explicitly **not implemented** (§6.5.1 line 480 says so), and
  the Phase 5 gate (line 786 / line 789) requires “ticket 不可伪造/重放/跨 project”. The shipped minimal loop
  therefore cannot satisfy that gate wording; current guards are main-minted tab ids + owner binding + nonce
  marker + locator re-reads. See F3.

### (h) Logging/error redaction — strong by construction, one argv log (F8)

- **[verified]** Connection diagnostics accept only enumerable state/phase/stable-code/exit-code values and
  reject anything else, so commands, identity paths, ProxyCommand text and response bodies cannot reach the
  history or the log line; `diagnosticCodeFromError` collapses free text — `SshConnectionDiagnostics.ts:30–51,
  74–79`; the IPC layer re-validates diagnostics (`remoteHostIpc.ts:63–74`).
- **[verified]** Launcher/control-client errors are stable codes only and deliberately do not attach the
  original error (which may carry path/argv/env) — `SshProcessLauncher.ts:43–60, 126–134, 388–402`;
  `RemoteControlClient.ts:168–171, 235–244, 268–280`.
- **[verified]** Remote read/write modules log identity/counts only (e.g. `{ sessionId, hostId, operation }`),
  never remote paths, command lines or bodies — `SessionRuntimeCoordinator.ts:1955`;
  `RemoteSessionHistoryReader.ts:374`; `RemoteSessionHtmlExport.ts:141, 188`.
- **Gap F8 (info):** one main-process log statement writes the **full remote pi argv** (including the remote
  session file path and trust flag) to the local application log — `AgentManager.ts:1658`
  (`args: plan.args.join(" ")`), where args are built from remote facts
  (`piRemoteRuntimePlan.ts:62`; `piRpcArgs.ts:65–67` adds `--session <remotePath>`, `piRpcArgs.ts:69` adds the
  trust flag). Local-only log; contradicts the “logs carry no paths” discipline (`remote-write-plan.md:41`;
  plan §8.3 line 569). See F8.

## 4. Findings

Severity is assigned to the *remote security surface as shipped*; “preconditions” are how a real user would hit
it. Status is at HEAD 11f68b27d (+ §0 dirty state); none of these is fixed by this review.

| ID | Severity | Area | Finding | Preconditions | Evidence (file:line) | Suggested fix |
| --- | --- | --- | --- | --- | --- | --- |
| **F1** | **medium** | (e) Git sync / unknown-result | All helper requests, including `git.fetch/push/pull`, use the 30 s read timeout. The dedicated 600 s sync budget is defined but referenced nowhere in `src/` or `tests/`. The frozen helper additionally clamps Git jobs to `Date.now()+30000`. Slow network verbs therefore fail; `push`/`pull` failures are reported as “result unconfirmed”. | Large repo / slow or high-latency link / busy remote; fetch/push/pull > 30 s. | `RemoteHelperContract.ts:128` (`REMOTE_GIT_READ_TIMEOUT_MS = 30_000`), `:178` (`REMOTE_GIT_SYNC_TIMEOUT_MS = 600_000`, dead); `RemoteGitService.ts:443` sends the read timeout for every method; frozen helper anchor `activeDeadline = Math.min(activeDeadline, Date.now() + 30000)` in `handleGit` (`RemoteHelperEntry.ts:117` snapshot); `RemoteGitService.ts:471` maps timeout/disconnect to `GIT_WRITE_RESULT_UNCONFIRMED` after a dispatched write. | Choose timeout per method (sync verbs = `REMOTE_GIT_SYNC_TIMEOUT_MS`, clamped by the contract), raise/remove the helper's Git-job 30 s clamp to the frame budget, and add a test asserting the frame `timeoutMs` for each sync method. Requires a helper build/sha bump. |
| **F2** | low | (c) bundle deployment / resource exhaustion | No host-side cleanup/sweep exists for deployed helper bundles (`bundles/<sha>`), leftover `.staging-<nonce>` directories, or (crash) deploy locks. Plan §4.2 requires reachability retention (active/rollback/lease), ≤2 unreferenced snapshots and ≤7 days, staging >1 h cleanup, 24 h artifact TTL. The frozen entry only cleans up on its own failure/EOF paths. | Repeated app/helper versions on one host; or a bootstrap killed by local crash/power loss (staging and possibly `.deploy.lock` remain; the lock is only recovered by the next run's holder-liveness check). | `docs/remote-development-plan.md:184,186`; repository-wide grep in `src/`+`scripts/` finds no bundle/staging cleanup implementation; only the entry's in-process `cleanup()` (`RemoteBootstrapContract.ts` frozen body); no cleanup method in `REMOTE_HELPER_CAPABILITIES` (`RemoteHelperContract.ts:251–276`). | Implement §4.2 reachability cleanup and a bounded sweep (e.g. a frozen maintenance op run on connect, with active/rollback/lease rules and fail-closed skip on unverifiable state); add fake-clock fixtures. |
| **F3** | low | (g) terminal gate | The one-shot `terminal.prepare` launch ticket / `terminal-runner.mjs` design is **not implemented**; the Phase 5 gate (“ticket 不可伪造/重放/跨 project”) cannot pass with the current minimal loop. Current protection is main-minted tab ids + sender/project ownership + nonce handshake + locator re-reads, not a replay-proof ticket. | Any Phase 5 release attempt; a stale/replayed terminal launch would not be refused by a ticket (the PTY is created only from main-owned state today, so this is gate accounting, not a demonstrated exploit). | `docs/remote-development-plan.md:480` (explicit “本轮未实现 … terminal.prepare / 一次性 launch ticket”); gate lines 786/789; code: `RemoteTerminalCommand.ts:8–17`, `createRemoteTerminalManager.ts:16–47`, `RemoteHostConnectionService.ts:493–505`. | Implement §6.5.2 ticket/runner before Remote v1, or formally amend the Phase 5 gate with explicit user sign-off that the minimal slice is the v1 scope. |
| **F4** | low | (a) identity chain (functional) | An explicit `IdentityFile ~/.ssh/...` from the SSH-config candidate list is passed to `remote:host-add` unchanged; main never expands `~` or canonicalizes it, and the host-store codec requires `isAbsolute`. Adding such a host fails with the opaque `REMOTE_HOST_STORE_INVALID` (verified by probe), blocking a very common config shape. Plan §5.2 requires main to expand `~` to a local absolute path. | SSH config block contains `IdentityFile ~/.ssh/id_*` (or a relative value) and the user picks that candidate. Manual add without an identity file is a workaround. | `SshConfigCandidates.ts:163–165`; `AddHostDialog.tsx:84`; `remoteHostIpc.ts:129–130`; `RemoteHostStoreCodec.ts:70`; probe: `~/.ssh/id_ed25519` ⇒ `REMOTE_HOST_STORE_INVALID`; plan: `docs/remote-development-plan.md:261`. | Expand `~`/normalize to an absolute local path in main before `createDraft`, and distinguish “invalid path” with a specific stable code; add a candidate-add regression test. |
| **F5** | low | (f)/(h) receipt-loss ambiguity | A session-history rewrite whose commit `rename` succeeded but whose stdout/exit was lost can surface as `REMOTE_SESSION_HISTORY_WRITER_COMMAND_FAILED`/TRANSPORT_FAILED and the renderer shows generic “session operation failed, try again” (`sessionCommand.commandFailed`). There is no “result unconfirmed / may already have applied / reload, no auto retry” copy for this surface (unlike remote Git and remote text-file save). The writer's code comment “non-zero exit ⇒ target file was not modified” is not guaranteed after the rename. | SSH drops/times out after the guard script's `renameSync` but before/while its result line is delivered; the user then retries manually. | `RemoteSessionHistoryWriter.ts:83–87` (comment), `:759–770` (commit invocation; non-zero ⇒ commandFailed); `RemoteSessionWriteGuard.ts:67–84` (rename at line 79 then the marker/result written at line 90); `SessionRuntimeCoordinator.ts:2036–2041` (only fileTooLarge/messageNotFound mapped); `renderer/src/utils/sessionCommands.ts:12–31`; copy `src/shared/i18n/mainProcessCopy.ts:45` vs `rendererCopy.zh-CN.ts:19,86,128`. | Add a dedicated unconfirmed code for post-commit transport/marker failures and an i18n “outcome unconfirmed, reload, no auto retry” message; correct the comment; test the lost-stdout-after-rename path. |
| **F6** | low | (f) defense-in-depth | `validateRemoteSessionHistoryPath` (used by session history read/write/archive) accepts absolute paths with `.`/`..`/empty segments even though its docs call the check canonical. Production catalog writers do reject such locators, so this is not reachable from the normal UI; it weakens the “single path authority” claim and would matter if a future writer is added or the local catalog is corrupted. | Tampered local userData catalog (same local account) with an absolute `remotePath` containing `..`, or a future writer that forgets the check. | `RemoteSessionHistoryReader.ts:128–133`; probe accepted `/home/u/.pi/agent/sessions/../../../etc/passwd`; writer-side protections: `remoteRuntimePort.ts:202–216, 282–283`, `RemoteSessionScanner.ts:270–280`; plan §8.5 line 589. | Reject `.`/`..`/empty segments and require an already-canonical absolute form in `validateRemoteSessionHistoryPath`, plus a targeted test; keep upstream checks. |
| **F7** | info | (d) IPC boundary | No IPC handler validates that the caller is the main window's top frame; identity is `webContents.id` only. Remote one-shot capabilities bind to that id, so cross-window replay is blocked, but a compromised renderer is not (it already has the app's other privileged IPC). App-wide pattern, not remote-specific. | Renderer compromise (the app's broader IPC is the real boundary). Browser-panel webview has no preload and cannot reach `ipcRenderer`. | repo-wide grep `senderFrame|validateSender|assertTrustedSender|isTrustedSender` in `src/main` → 0 matches; `remoteHostIpc.ts:505–508`; per-handler checks e.g. `remoteGitReadIpc.ts:71–72`, `remoteProjectFileIpc.ts:21–22`. | If hardening: one central `assertMainWindowSender(event)` for all `ipcMain.handle` registrations (app-wide decision, not just remote). Report as assumption otherwise. |
| **F8** | info | (h) logging | Local application log contains the full remote pi argv (remote session file path, trust flag), contradicting the “logs carry no paths” discipline. Local-only; not a secret, but it is personal/remote path data and weakens the redaction story. | Any remote session launch with `--session` (resume/restart) at info log level. | `AgentManager.ts:1658`; args construction `piRemoteRuntimePlan.ts:62`; `piRpcArgs.ts:65–67,69`; discipline: `docs/remote-write-plan.md:41`, plan §8.3 line 569. | Log stable identity + flag names/booleans only (e.g. `{ agentId, hostId, hasSession: true, trust: "approve" }`); keep the remote-path diagnostic behind an explicit debug setting if needed. |
| **F9** | info | (c) deployment layout | The shipped helper layout deviates from the plan: bodies are TS string constants + hard-coded sha pins, and the manifest is computed at runtime, instead of `resources/remote-host/` + generated manifest + `check:remote-host-manifest` build gate. Integrity properties are preserved and test-verified, but there is no on-disk artifact to inspect and no packaging gate. | Release/packaging review; an auditor expecting files from the plan. | `RemoteHelperEntry.ts:117–141` (snapshot; version/sha literals); `RemoteBootstrapDeployment.ts:36–38`; plan `docs/remote-development-plan.md:177–181`; no `generate-remote-host-manifest` script in `scripts/` and no `check:remote-host-manifest` npm script. | Either amend the plan to the inlined-constant design and document the sha bump discipline as the gate (tests already enforce it), or add the planned generator/check for auditability. |
| **F10** | info | (c) integrity / threat model | Helper/runner bytes are verified during bootstrap/activation, but within one app process a held bootstrap is reused by store revision and the helper is launched by path without re-hashing; a remote drift between bootstrap and a later launch (or a same-account writer) is only detected if a new bootstrap runs. Acceptable under the stated same-account threat model; documented here so it is not mistaken for a sandbox. | Same-account process modifies the deployed bundle after activation, or accidental on-disk corruption while the app keeps the session. | `RemoteHostConnectionService.ts:317–347` (reuse by revision), `SshConnectionAttempt.ts:272–286` (command built from held hash, no re-hash), frozen entry `activeMatches` re-verified only when a bootstrap/finalize runs (`RemoteBootstrapContract.ts` frozen body). | No code change required under the current threat model; if this becomes a security boundary, re-run activation verification per connection or ship a signed/immutable bundle with a stronger isolation story. |

## 5. What is solid (evidence-backed, not padding)

Short list of properties a reviewer can rely on, all **[verified]**:

1. **No secret leakage into SSH argv or remote command strings.** SSH argv is an array; remote commands are
   either `String.raw`-frozen templates with POSIX quoting + single-quote rejection for paths, or pass through
   NDJSON after the authenticated connection — `SshCommandBuilder.ts:79–142`, `RemoteHelperCommand.ts:64–108`,
   `SshVerifiedConnection.ts:173–187`.
2. **Host identity pinning cannot be silently downgraded.** The strict config is re-derived and asserted for
   every invocation; unknown route changes, pin/profile revision drift, malformed pins (non-ed25519, bad shape)
   and a pending rebind all fail closed; no fallback to `-o StrictHostKeyChecking=no` exists in the code
   (`SshVerifiedConnection.ts:53–106, 129–171`, `SshHostPinStore.ts:204–215`).
3. **Remote Git is not reachable from a local repo fallback.** Every local Git handler rejects non-local
   projects, and remote operations have their own channels; disabled capabilities are refused rather than
   returning empty success (`GitBackend.ts:67–86`, `gitIpc.ts:260–315, 573–603`, `RemoteGitService.ts`).
4. **Write capabilities are main-owned, sender-scoped, single-use, and bounded.** Git tokens, file-version
   tokens, pin/repair/enroll confirmations; all validate sender and consume before the first await.
5. **Remote file writes are bounded, identity-checked, and atomically renamed**, with fail-closed handling of
   oversize/invalid UTF-8/symlink/parent escape/uid-gid mismatch; the residual non-CAS race is explicitly
   documented.
6. **Frames, outputs, files, concurrency and request tables are bounded on both ends**, with stable codes and
   exactly-once settlement; cancel cannot fake a rollback.
7. **Diagnostics are a closed vocabulary**, not free text; error paths collapse to stable codes.

## 6. Phase 5 security-gate checklist (`docs/remote-development-plan.md` §12 Phase 5)

The Phase 5 gate is `docs/remote-development-plan.md:789` (bullets at 784–787). Verdict up front:
**NOT MET.** Individual items below. Status vocabulary: Met / Partial / Not met / Not verified.

| # | Gate item (plan line) | Status | Evidence / gap |
| --- | --- | --- | --- |
| 1 | All writes restricted to project root (:789) | **Partial** | [verified] Remote text-file write enforces canonical project root + per-command parent-fd anchoring (`RemoteProjectFileCommands.ts:18–40,62–88`); Git writes run only inside the confirmed repo root (`RemoteGitService.ts` target checks). [inferred/documented] Terminal shell starts in the project root but is an interactive account shell, explicitly not a chroot (§6.5.1 line 475); session-history writes target the session store, not the project root, by design. |
| 2 | commit/branch/ref/path parameters free of shell/option injection (:789) | **Met (code level)** | [verified] Fixed argv arrays, `shell:false`, path/name validators, literal pathspecs/`--`, branch via `check-ref-format --branch` + local rules; tests in batch A/B (Git/helper tests) pass. [cannot-verify] real host. |
| 3 | Every supported existing Git IPC hits the remote backend; disabled items return `UNSUPPORTED_CAPABILITY` and the UI does not trigger them (:789) | **Partial** | [verified] Only `gitStatus`/`gitWorkspaceFileDiff` route to remote; all other *existing* local Git IPC fail closed for SSH projects but with `UNSUPPORTED_PROJECT_LOCATION` (not `UNSUPPORTED_CAPABILITY`) — `gitIpc.ts:573–603`, `GitBackend.ts:67–86`. Remote history/refs/compare/branch/discard/recovery/sync use new `git:remote-*` channels. [inferred, not traced] renderer never calls local Git channels for an SSH project; docs claim source-level guards. Needs UI tracing/e2e. |
| 4 | Terminal ticket unforgeable/replay-proof/cross-project (:786, :789) | **Not met** | No `terminal.prepare` ticket/runner; plan §6.5.1 line 480 states it is not implemented; §6.5.2 lines 484–493 is future design. Current guards: main-minted tab id + sender/project ownership + nonce handshake + locator re-reads (F3). |
| 5 | Handshake bytes not leaked to shell; resize reaches remote; close leaves no local ssh and does not affect other tabs/agents; remote foreground shell收敛; docs/UI do not promise daemonized-job cleanup (:789) | **Partial / not verified here** | [verified] Code: fixed command/marker, packetized output with ack, per-tab cleanup, no host-level pkill; docs explicitly disclaim daemonized cleanup (§6.5.1 line 479). [cannot-verify] real-host resize/shell convergence; only the external handoff evidence (Linux client→Linux host) exists; this review ran no e2e. |
| 6 | Git output size and timeout limits (:789) | **Partial** | Sizes/timeouts exist (1 MiB status, 256 KiB text, 16 MiB index, 30 s/600 s constants; launcher/helper caps). **F1**: network verbs are effectively capped at 30 s end-to-end and the 600 s constant is dead. |
| 7 | Phase 0–5 full capability-parity table passes (:789; table §13 lines 809–827) | **Not met** | Missing “must” items at minimum: remote create-project (:784), remote file rename/delete (:784), remote config backend / provider test / model fetch (§13 rows 818–819), remote session delete with confirmation (row 810 vs. P4.5b “delete archived/remote delete not done”), and the terminal ticket parity. Worktree/cherry-pick/reset are correctly disabled; DSH/imagegen correctly excluded. |
| 8 | Security review completed (:789) | **In progress** | This document — but it is an AI agent lane, not the “independent reviewer” the handoff requires (§7). Findings F1/F2/F4/F5 need product-level decisions. |
| 9 | Windows/macOS local → Linux remote smoke (:789; §14.2) | **Not met / not verified** | [cannot-verify] no host/Electron this session. Docs: Windows→Linux has Phase 3 evidence; terminal and Git have Linux-client→Linux-host evidence only; macOS client has none. |
| 10 | `npm run pack` resource check (:789) | **Not run / cannot-verify** | Not executed (no build/pack this session). Note: helper/runner are embedded strings, so `extraResources` has no remote-host entry (`package.json:166–…`); packaging would need to prove the frozen string shas survive bundling. The production gate `!app.isPackaged && PIDECK_REMOTE_EXPERIMENTAL=="1"` (`main/index.ts:2355`) means a packaged build does not expose remote at all today — that is a gate safety, but it also means “Remote v1 release” cannot be evaluated until the gate is lifted. |
| 11 | Helper upgrade/downgrade + power-loss/half-write recovery tests (:789) | **Partial** | [verified] Version/capability mismatch refusal and fatal classification (`SshConnectionAttempt.ts:232–269`, `SshConnectionManager.ts:252–293`; tests in batch A), activation byte/mode re-verification, abort/EOF cleanup, pre-commit failure paths (`RemoteBootstrapDeployment.ts:101–127`; batch B). [not met] host-side retention/sweep (F2); no real power-loss/half-write host test; no explicit upgrade-then-downgrade matrix test. |
| 12 | Phase 5 bullet: create empty project directory + `git init` (:784) | **Not met** | Only “add existing remote directory” exists (`remoteProjectIpc.ts:114–193`); no remote create/mkdir/init channel (grep: no create-project remote implementation). |
| 13 | Phase 5 bullet: remote file atomic write, rename, delete (:784) | **Partial** | Atomic write of an existing text file is delivered (`RemoteProjectFileService.ts`); remote rename/delete/create are not implemented (the separate file-write-contract lane is designing them). |
| 14 | Release communication aligns with §13 capability totals (lines 805–829) | **Not met** | Because items 7/12/13 are incomplete, the “Remote v1” release condition in §13 (line 829) cannot be asserted. |

## 7. Needs follow-up (explicit)

**Real host / real network**
1. Reproduce F1: a >30 s `git.fetch`/`push` against a slow/large remote; confirm helper and main both abort at
   ~30 s and that `push`/`pull` surface `GIT_WRITE_RESULT_UNCONFIRMED`. Verify the fix with a real host and a
   helper rebuild.
2. Reproduce F4 on a real SSH-config host with `IdentityFile ~/.ssh/...`; confirm `remote:host-add` returns
   `REMOTE_HOST_STORE_INVALID` today.
3. Exercise F2: connect repeatedly across helper versions and simulated crash/lock leftovers; verify bundle
   accumulation and that no sweep exists (or that the fix works).
4. Real-host terminal and Git evidence currently in the handoff is Linux-client→Linux-host; macOS client and
   Windows-client terminal/Git are unverified. A Phase 5 claim requires those smokes.
5. Re-run the POSIX-only tests skipped on Windows (`tests/remoteSessionWriteGuard.test.mjs` — 78 skips;
   `tests/remoteProjectFileService.test.mjs`; `tests/remoteTerminalCommand.test.mjs`) on a Linux host; two of
   these fail on Windows only because they assume `/bin/sh` and canonical POSIX fixture paths, but that means the
   real-command write-guard semantics were **not** validated by this review.

**Packaged build**
6. Run `npm run pack` (and a packaged app on the dev-gate expression) and verify: frozen helper/runner source
   strings and their sha256 constants survive the production build; the activation check still passes; no
   remote-host `extraResources` are required; remote is unreachable when `app.isPackaged` is true.
7. Audit the packaged main bundle for accidental path/secret logging (F8 class) and confirm diagnostic redaction
   in the built artifact.

**Independent reviewer / threat model**
8. The Phase 5 gate asks for a security review. This document is an AI agent lane review; it should be followed
   by an independent human reviewer (or an explicitly accepted equivalent) before “Remote v1”. That reviewer
   should re-audit F1–F6 and sign off on the same-account threat model in §2.3.
9. Decide and record whether the threat model really excludes a malicious same-account process. If not, the
   current root-confinement design (lexical + realpath checks, no `openat2`/immutable helper identity) does not
   meet the bar; see plan §8.1 line 553.
10. Re-run this review on a **clean tree at the Phase 5 release candidate**. The current snapshot is dirty due
    to a concurrent lane (G5b adds `git.compare` / helper 1.16.0), and line numbers in four files will drift.

**UI/product decisions**
11. Trace the renderer to prove no remote project ever invokes local Git IPC channels (gate item 3).
12. Decide whether F5's receipt-loss ambiguity needs a dedicated unconfirmed message (recommended; it mirrors the
    Git and text-file surfaces) and whether F4 should block on product copy.
13. Implement or formally waive F2/F3 (host cleanup, terminal ticket) with the Lead/user; both are Phase 5 gate
    items today.
14. Verify F10 (bundle re-verification policy) is an accepted risk in the release notes/threat model.

## 8. Non-goals

- **No source changes and no commits** (report-only lane); no fix was attempted for any finding.
- **No real-machine e2e**, no Playwright, no full `npm test`, no `npm run pack`/`build`, no network calls.
- Not a dependency/CVE/supply-chain audit of Electron, OpenSSH, Node, pi or the packaged runtime.
- Not a review of local/WSL file, Git, terminal or session behavior (only as a negative control to prove SSH does
  not fall back to local).
- Not a review of non-remote IPC (except where it is the remote trust boundary): e.g. config/backup/extension
  IPC, pi auth, webview policy, imagegen.
- Not a review of password/passphrase/AskPass/keyboard-interactive authentication (Phase 6; not implemented)
  or of SSH agent forwarding (disabled by argv and not exercised).
- Not a fuzzing/penetration test; the helper protocol was assessed by reading the frozen sources, the contract
  and the existing tests, not by mutating live traffic.
- Not a verification of the docs' evidence claims that require a real host (the handoff's e2e logs were not
  re-run or independently checked).
- Not a cryptographic review of OpenSSH, sha256 usage or the host-key enrollment beyond the code-level checks.

## 9. Evidence appendix

### 9.1 Commands (exact) and results

    node --test --test-concurrency=2 tests/sshCommandBuilder.test.mjs tests/sshVerifiedConnection.test.mjs tests/sshHostPinStore.test.mjs tests/sshHelperCapabilityGate.test.mjs tests/remoteControlClient.test.mjs tests/remoteGitTrustGate.test.mjs tests/remoteIpcRouteOrder.test.mjs tests/remoteTerminalCommand.test.mjs tests/remoteBootstrapContract.test.mjs
    → tests 162, pass 159, fail 1 (remoteTerminalCommand — Windows/POSIX fixture), skipped 2

    node --test --test-concurrency=2 tests/remoteHelperEntry.test.mjs tests/remoteBootstrapDeployment.test.mjs tests/remoteBootstrapSession.test.mjs tests/remoteGitSync.test.mjs tests/remoteGitWrite.test.mjs tests/remoteSessionWriteGuard.test.mjs tests/remoteProjectFileService.test.mjs tests/remoteHostStore.test.mjs tests/remoteGitMutationTokens.test.mjs tests/remoteSessionHistoryWrite.test.mjs
    → tests 170, pass 91, fail 1 (remoteProjectFileService — Windows fixture), skipped 78 (POSIX-only write-guard checks)

    node --test --test-concurrency=2 tests/remoteTrustKey.test.mjs tests/remoteProjectTrustStore.test.mjs tests/remoteTrustFlagArgs.test.mjs tests/remoteHostRetireTrustCleanup.test.mjs
    → tests 25, pass 25, fail 0

    git status --porcelain / git diff --stat  (dirty tree, see §0)

    node --input-type=module -e '<codec probe>'   → identityFile '~/.ssh/...' / relative ⇒ REMOTE_HOST_STORE_INVALID; absolute ⇒ accepted
    node --input-type=module -e '<path probe>'    → '/home/u/.pi/agent/sessions/../../../etc/passwd' accepted by validateRemoteSessionHistoryPath

### 9.2 Grep anchors used for “absence” claims

- No cleanup/sweep: patterns `cleanup|sweep|prune|retain|staging` over `src/main/remote` + `scripts`
  return only in-process cleanup / scratch-dir cleanup / unrelated host-store pin cleanup; no bundle/staging
  retention code.
- No sender-frame guard: `senderFrame|validateSender|assertTrustedSender|isTrustedSender` over `src/main` → 0.
- No `REMOTE_GIT_SYNC_TIMEOUT_MS` consumer: only `RemoteHelperContract.ts:178` defines it; no `src/` or
  `tests/` reference.
- No remote-host manifest script: no `generate-remote-host-manifest` / `check:remote-host-manifest` in
  `scripts/` or npm scripts.

### 9.3 Review limitations (repeat, because it matters)

This review verified code and tests, not deployed behavior. Every “strong” property above is a property of the
source at the snapshot; the only runtime evidence available was the targeted test batches and two probes. The
Phase 5 ordering is therefore: fix/waive F1–F5, close the §6 gate items, run §7's real-host and packaged-build
checks, then have an independent reviewer sign the clean-tree candidate.
