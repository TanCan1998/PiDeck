# Remote Pi config backend — Independent Security Review Addendum (Batch A)

> Status: **report only** (shared task `task-16`). No source file was modified and no commit was made by this
> lane; the only file written is this addendum. Every claim is marked `[verified]`, `[inferred]` or
> `[cannot-verify]` and carries a `file:line` anchor. Frozen contract under review:
> `docs/remote-development-plan.md` §6.4.1 (lines 470–507).
>
> **Review subject:** the Batch A commit `0a0cc53b8` (`feat(remote): target-routed remote Pi config backend
> (Batch A: helper + main)`) — the new frozen helper scope, contract codes, shared types, main backend, router,
> systemIpc target handling and main assembly. The renderer Batch B is being implemented by another lane; see
> the scope note in §0. Audited by an AI agent lane, not an independent human reviewer; no real host, packaged
> build, Playwright/e2e, or full `npm test` was used.

## 0. Snapshot, scope boundary and concurrent lane

| Item | Value |
| --- | --- |
| Repository / branch | `F:\PiDeck-remote`, `feat/remote-development` |
| HEAD (review subject) | `0a0cc53b8` — clean working tree at review start |
| Batch A files (commit diff) | `src/main/config/PiConfigRouter.ts`, `src/main/config/RemotePiConfigBackend.ts`, `src/main/config/piConfigTarget.ts`, `src/main/remote/RemoteConfigSource.ts`, `src/main/remote/RemoteHelperContract.ts`, `src/main/remote/RemoteHelperEntry.ts`, `src/shared/piConfig.ts`, `src/main/ipc/systemIpc.ts`, `src/main/index.ts`, plus 5 test files (15 files, +1374/−16) |
| Frozen contract | `docs/remote-development-plan.md:470–507` (§6.4.1, “Batch A 只做 helper/shared/main + 后端测试”) |
| Workspace during review | **Another lane started Batch B uncommitted edits while this report was being written** — `src/shared/piConfig.ts`, `src/preload/index.ts`, `src/main/ipc/systemIpc.ts` (3 files, +46/−12) and a new `src/renderer/src/config/remoteConfigModel.ts`. Those edits are **not review subjects**; they were read only to assess reachability of this report's findings (they add the preload `options` passthrough and the renderer-facing DTO). Line anchors below are for HEAD `0a0cc53b8`; systemIpc/preload/shared line numbers drift with the Batch B edits — the cited symbols/Channels locate them. |

Batch B being out of scope is material: the Batch A main-side routing is already complete (an ssh target is
accepted by the four config IPC handlers), while the preload at HEAD still drops the options argument. The
uncommitted Batch B preload change is exactly what exposes target/patch to renderer code — which is the
precondition for finding **A1** below.

## 1. Verdict

**The Batch A architecture is sound and tightly bounded; no high-severity vulnerability was found in the
committed Batch A code itself.** The helper scope is a two-file allowlist with no path parameter, no auth.json
reachability, no-follow/large-file refusals, recursive secret redaction, RFC 7396 merge-patch with an
expectedVersion guard, atomic 0600 temp+fsync+rename+readback and a dedicated “result unconfirmed” code. Main
re-validates every helper reply (including recomputing the secret list and rejecting plaintext at a secret
position), maps responses into the eight-code closed set, never falls back to the local ConfigManager, and the
local target path is byte-for-byte the old one. The deferred provider test/model fetch/usage handlers reject an
ssh target before any network/key/helper work. The artifacts are correctly pinned (helper 1.21.0, six bundle
artifacts incl. `config.mjs`, manifest/entry sha constants covered by tests).

Two **medium** findings must be fixed before the Batch B renderer target selector ships, because Batch B's
preload passthrough makes both reachable from renderer code:

- **A1 — prototype pollution in the frozen config scope.** A merge patch containing an own `__proto__` key is
  merged into `Object.prototype` of the remote helper process. Verified with an executed probe against the
  actual frozen source (not just code reading). Impact is currently limited to the helper process (global
  state corruption/DoS; no demonstrated privilege escalation), but it is renderer-controlled input mutating a
  remote process's prototype chain, and it becomes reachable as soon as the Batch B options passthrough lands.
- **A2 — over-broad secret-key matching.** The shared regex is unanchored, so documented models.json fields such
  as `maxTokens` (and any key containing `token`/`secret`/… as a substring) are mistaken for secrets: reads
  replace their values with `"configured"`, and numeric patches to them are **silently ignored** while the UI
  gets a success receipt. Verified with an executed probe. This breaks remote models/settings editing of
  legitimate fields and mislabels data as secret; direction is fail-closed for disclosure but not for
  correctness.

Two **low** items: (A3) config requests are not serialized under the host operation lock as the frozen contract
requires — main calls the documented lock-free one-off `request` path; helper-side synchronous execution plus
the expectedVersion CAS prevent lost updates, but the host-lifecycle fence the contract asked for is absent;
(A4) invalid UTF-8 in a config file is silently accepted with U+FFFD replacement, although the contract lists
UTF-8 as a precondition — a corrupt file can be presented as valid and later rewritten.

Severity counts for this addendum: **critical 0, high 0, medium 2, low 2**, plus 7 info-level observations.
Release recommendation in §8: do not expose the remote config target to renderer code until A1 and A2 are
fixed (or A1 is at minimum blocked in main's patch validator); A3/A4 can be fixed cheaply or recorded as
explicit contract deviations.

## 2. Evidence base

### 2.1 Tests actually run (read-only, targeted)

    node --test --test-concurrency=2 tests/remoteConfigContract.test.mjs tests/remotePiConfigBackend.test.mjs tests/remotePiConfigRouting.test.mjs tests/remoteHelperConfig.test.mjs tests/remoteHelperEntry.test.mjs
    → tests 60, pass 55, fail 0, skipped 5

The 5 skips are **all** of `tests/remoteHelperConfig.test.mjs` — the real-helper POSIX child-process tests
(redaction, merge patch, atomic write, auth.json unreachable, symlink/oversize/malformed refusal, idempotence).
They are `{ skip: !POSIX }` (`tests/remoteHelperConfig.test.mjs:19,103`) and therefore **cannot be verified on
this Windows host**; they are the main evidence gap. The contract/backend/routing suites and
`remoteHelperEntry.test.mjs` (frozen-artifact pins, helper process behavior) pass on Windows.

### 2.2 Executed probes (read-only; frozen source evaluated in a sandbox, no app/host involved)

The frozen `REMOTE_CONFIG_SOURCE` was instantiated via `new Function` with an in-memory fs/path/crypto mock so
the actual shipped logic (not a paraphrase) could be exercised:

- **Probe 1 — over-redaction + silent write no-op.** Input file bytes
  `{"maxTokens":32000,"tokenizer":"x","theme":"dark"}` in the allowlisted settings file:
  read returned `data={"maxTokens":"configured","tokenizer":"configured","theme":"dark"}` and
  `secrets=[{path:"maxTokens",...},{path:"tokenizer",...}]`; a patch `{maxTokens:8192}` applied with the read
  version changed **nothing**: returned data still `configured`, version unchanged, disk still `32000`.
- **Probe 2 — prototype pollution.** A patch parsed as `{"__proto__":{"pideckPolluted":"yes"}}` left
  `({}).pideckPolluted === "yes"` and `Object.prototype.hasOwnProperty("pideckPolluted") === true` in the
  helper's realm.
- **Probe 3 — invalid UTF-8 tolerance.** Bytes `{"s":"\xff\xfe"}` were accepted; the snapshot returned
  `s = "\ufffd\ufffd"` (code points 65533,65533) instead of refusing the file.
- **Reachability chain probe.** `JSON.parse('{"__proto__":{...}}')` → `structuredClone` → `JSON.stringify`
  preserves the own `__proto__` property (it is transmitted as a normal own property), i.e. the Batch B
  preload/IPC path can deliver the same payload the helper probe accepted.

### 2.3 Static / contract checks

Frozen source and contract were compared literal-by-literal: helper codes, capability list, file allowlist,
bounds, secret pattern, method names, artifact list and helper build are pinned by
`tests/remoteConfigContract.test.mjs:19–78` (pass). The backend is proved not to import the local
ConfigManager/fs/child_process by `tests/remotePiConfigBackend.test.mjs:123–129` (pass). Greps confirmed the
frozen config artifact contains no `auth.json` literal and no `params.path` (`remoteHelperConfig` contract test
lines 42–46 asserts this too), and that the service-level `request` used by the main transport is the
documented lock-free one-off path (`RemoteHostConnectionService.ts:735–747`; `operationLock` is used only by the
project-session and connect paths, lines 229/573/607/679/704/774).


## 3. Assessment against the frozen contract (§6.4.1)

Status vocabulary: **Met** (verified in code/tests), **Partial** (implemented but a contract detail is not, or
only code-verified), **Not met**, **Cannot verify** (needs POSIX host / real helper process).

| Contract item (plan §6.4.1) | Status | Evidence / gap |
| --- | --- | --- |
| Scope: only `models.json`/`settings.json` read + explicit merge-patch write; remote target only a pinned/verified SSH host (:474) | **Met** | Helper allowlist `FILES` and enum check in `RemoteConfigSource.ts:27,38–43`; host id shape + backend transport `RemotePiConfigBackend.ts:34–36,158–165,168–180`; no project root/path crosses. [verified] |
| Deferred: provider test/model fetch/usage/auth/trust/MCP/raw/project config disabled with stable codes, **zero network/helper** (:475) | **Partial** | [verified] `configTestProvider`, `configFetchModels`, `configFetchUsage`, `configTestUsageProbe` each call `rejectRemotePiConfigTarget` as the first statement (HEAD `systemIpc.ts:1755,1870,1922,1979`; router `PiConfigRouter.ts:40–43`). Auth/trust/MCP/raw/tokendance/migration handlers have **no target parameter**, so main cannot see a remote target there — enforcement is Batch B UI-only (observation O3). |
| Local path behaviour unchanged (:476) | **Met (code/test level)** | Router local branch calls the same four ConfigManager methods with the original DTOs (`PiConfigRouter.ts:60–81`); preload at HEAD still invokes the four channels without options; routing test asserts exact local path + no remote call (`tests/remotePiConfigRouting.test.mjs:60–74`). Handler wiring diff keeps the old code path for local. [verified] |
| Shared target union; absent = local; hostId only host-store shape (:480–481) | **Met** | `shared/piConfig.ts:10–17,59–67`; `piConfigTarget.ts:19–30,33–37` rejects extra keys/deep shapes and never coerces invalid input to local. [verified by tests `remotePiConfigRouting.test.mjs:89–104`] |
| Read returns sanitized DTO, secret positions only `configured` / `missing`, no plaintext/raw bad text (:481,488) | **Met for known secret keys; over-broad in practice** | [verified] recursive sanitization `RemoteConfigSource.ts:106–143`, test `remoteHelperConfig.test.mjs:122–149`; main recomputation+plaintext rejection `RemotePiConfigBackend.ts:85–132` and its unit test :62–77. **Gap A2**: unanchored pattern misclassifies non-secret fields. |
| Write only `{expectedVersion, patch}`; RFC 7396; null deletes non-secret; secret replaced only by new string (:481,489) | **Partial** | [verified] merge `RemoteConfigSource.ts:144–163`, tests `remoteHelperConfig.test.mjs:151–200`. **Gap A1**: own `__proto__` key is merged into Object.prototype instead of being refused/handled as data. Also the “null deletes non-secret keys only” wording is ambiguous for deleting an ancestor object containing secrets (observation O7). |
| Patch bounds: plain object, depth/nodes/total bytes; reserialized ≤1 MiB (:489) | **Met on the main path; helper self-bound is partial** | [verified] main `RemotePiConfigBackend.ts:134–153` walks arrays/objects and bounds depth/nodes/serialized bytes before any request, test :112–118; helper bounds `RemoteConfigSource.ts:29,144–168`. Helper `mergeInto` clones array contents without its own depth/node walk (observation O5) — main makes this unreachable today. |
| Target file: no-follow regular file; UTF-8; ≤1 MiB; symlink/type/shape → PATH_UNSUPPORTED; oversize → FILE_TOO_LARGE; malformed JSON → FILE_INVALID without overwrite (:487) | **Partial** | [verified code] `RemoteConfigSource.ts:67–102` (lstat + O_NOFOLLOW + dev/ino equality, size caps, JSON refusal); tests `remoteHelperConfig.test.mjs:202–244` (POSIX skips on this host). **Gap A4**: UTF-8 validity is not enforced (`buffer.toString("utf8")` is non-fatal, line 99). |
| Atomic write: same-dir 0600 temp + fsync + rename + dir fsync; clean temp on failure; readback + unmask; **rename-after readback failure = RESULT_UNCONFIRMED, no retry** (:489) | **Met** | `RemoteConfigSource.ts:169–213`; tests `remoteHelperConfig.test.mjs:151–200,246–257` (POSIX skips here); helper error list includes `CONFIG_RESULT_UNCONFIRMED`; main maps it to `REMOTE_CONFIG_RESULT_UNCONFIRMED` (`RemotePiConfigBackend.ts:59–83`). [verified at code level; POSIX real-fs unverified here] |
| New helper codes in the closed error set; capabilities include `config.read/patch`; old helper → METHOD_NOT_FOUND → REMOTE_CONFIG_UNSUPPORTED, no local fallback (:490) | **Met** | `RemoteHelperContract.ts:108–118,339–344,470–493`; frozen dispatch branch (helper body, `handleConfig`) and capability literal; contract test `remoteConfigContract.test.mjs:19–33`; backend mapping `RemotePiConfigBackend.ts:59–83`; routing/backend tests cover METHOD_NOT_FOUND → unsupported. |
| Main routing: validate target/file/hostId; use `RemoteHostConnectionService.request` on a ready pinned host; config read/write does not borrow a project session/root (:494) | **Met** | `RemotePiConfigBackend.ts:155–181`; assembly `src/main/index.ts:3214–3229` (backend only behind `remoteExperimentEnabled`); transport calls `service.request(hostId, method, params, {timeoutMs:15_000})`; no project id/root involved. |
| Same-host config requests serialized **inside the host operation lock**; no cross-host shared cache/state (:494) | **Not met (A3)** | The transport calls the documented lock-free one-off `request` (`RemoteHostConnectionService.ts:735–747`); `operationLock` is used for project sessions/connect only (:229,573,607,679,704,774). No cache exists (cross-host clean). |
| Reply re-validation: file/target consistency, version/sha shape, object data, secret positions only status strings, secrets recomputed equal, models.providers object; failures → FILE_INVALID; helper raw errors/path/content never leaked (:495) | **Met** | `RemotePiConfigBackend.ts:85–132`; test suite `remotePiConfigBackend.test.mjs:62–102` (plaintext secret rejection, list mismatch, version!=sha, non-object data, bad status, bad models shape). The reply has no file/host field to mismatch (main supplies them structurally). |
| Route only by target.hostId; local never helper; ssh failure never local ConfigManager; feature switch off → UNAVAILABLE (:496) | **Met** | `PiConfigRouter.ts:45–82` (remoteBackend throws when port absent; local branch never touches remote); assembly only builds backend when `remoteExperimentEnabled` (`src/main/index.ts:3214–3229`); routing test :101–104. |
| Batch A helper POSIX real-child tests listed in :506 | **Partial (cannot verify here)** | `remoteHelperConfig.test.mjs` exists and covers the list but is skipped on win32 (5 tests); contract/backend/routing tests pass (60 total / 55 pass / 5 skip). |
| Artifacts: helper 1.21.0, new `config.mjs` pin, entry digest + manifest list updated in the same commit (:507) | **Met** | `RemoteConfigSource.ts:219` sha pin; `RemoteHelperEntry.ts:137,178–189`; contract test `remoteConfigContract.test.mjs:49–71` (config sha, artifact list `helper/git-read/git-write/git-sync/config/terminal-runner`, entry sha); deployment writes all `REMOTE_HELPER_ARTIFACTS` + runner into the manifest (`RemoteBootstrapDeployment.ts:37–52`, cross-checked in §3.3). |

### 3.1 Frozen config scope — what is strong

`RemoteConfigSource.ts` is a 190-line synchronous scope with a deliberately small surface. [verified by
reading the frozen body plus the passing contract tests and the probes above]:

- **No path authority exists**: methods take `{file}`/`{file,expectedVersion,patch}` only; `fileKey` requires
  the exact key set and an own enumerable allowlisted file name, so `auth.json` is structurally unreachable
  (`RemoteConfigSource.ts:38–50`; contract test asserts the source contains neither `auth.json` nor
  `params.path`, `remoteConfigContract.test.mjs:42–46`).
- **Home is shape-validated again inside the scope** (`:34–37`), and `.pi`/`.pi/agent` must be real
  directories — a symlink, a file or an unexpected type is `CONFIG_PATH_UNSUPPORTED` before any file access
  (`:51–66`).
- **Read is identity-checked**: lstat then no-follow open then fstat dev/ino equality; bounded 1 MiB; a
  non-regular or replaced file is refused; a missing file answers the canonical empty document
  (`:28,67–96,189–194`).
- **Malformed JSON is a refusal that never overwrites and never echoes text** (`:97–102`).
- **Secret redaction is unconditional and recursive** across objects/arrays, status derived only from
  presence/emptiness, secret list sorted deterministically (`:106–143`).
- **Write is atomic and guarded**: expectedVersion is the sha256 of the raw current bytes; temp file is
  0600/O_EXCL in the same directory, fsynced and renamed, directory fsync best-effort; any readback mismatch is
  `CONFIG_RESULT_UNCONFIRMED`, never retried or reported as success (`:144–213`).
- **Merge preserves unknown fields and array-replace semantics** (`:144–163`), and secret keys are only
  replaced by an explicit non-placeholder string.
- **Errors are a six-code closed vocabulary**; unknown errors become `HELPER_INTERNAL` in the dispatch wrapper
  (frozen body `handleConfig`) rather than leaking text.

### 3.2 Main backend / router / shared contract — what is strong

- **Eight shared codes are the only codes that can reach the renderer** from this surface:
  `REMOTE_CONFIG_TARGET_INVALID`, `HOST_NOT_READY`, `UNAVAILABLE`, `UNSUPPORTED`, `FILE_INVALID`,
  `VERSION_CONFLICT`, `RESULT_UNCONFIRMED`, `PROVIDER_OPERATION_UNSUPPORTED` (`shared/piConfig.ts:20–40`;
  contract test `remoteConfigContract.test.mjs:73–78`). Every helper/transport code goes through
  `mapHelperCode`, whose default is UNAVAILABLE (`RemotePiConfigBackend.ts:59–83,158–165`); unknown raw text is
  never forwarded. **[verified]**
- **Reply re-validation is genuine and independent of the helper**: shape/size checks, models shape, secret
  positions only the two status strings (plaintext there is rejected), and the supplied secret list must equal
  the recomputed one (`RemotePiConfigBackend.ts:85–132`). **[verified by tests]**
- **Renderer input can never become a path or host authority** on this surface: the renderer names a host id
  (UUID shape) and a file enum; the target file path is assembled main/helper-side from HOME; the patch is data,
  not a path/argv, and is validated/bounded before the request (`piConfigTarget.ts:19–54`;
  `RemotePiConfigBackend.ts:134–153`). **[verified]**
- **No local fallback**: the remote branch is chosen before any ConfigManager call, and the backend module
  contains no ConfigManager/fs/child_process import (proved by `remotePiConfigBackend.test.mjs:123–129`).
  **[verified]**
- **Deferred operations refuse before side effects**: the guard is the first statement in the four guarded
  handlers, and `rejectRemotePiConfigTarget` itself validates the target shape before deciding
  (`PiConfigRouter.ts:40–43`; HEAD `systemIpc.ts:1755,1870,1922,1979`; test
  `remotePiConfigRouting.test.mjs:106–132`). **[verified at code level; no IPC-level behavior test exists]**
- **Local behaviour is preserved**: no channel names were added/changed, old preload call shapes still work
  (options are optional), and the local branch calls the same ConfigManager methods/DTOs
  (`tests/remotePiConfigRouting.test.mjs:60–74,134–162`). **[verified at router/source level]**


## 4. Findings

Severity is for the remote config surface as it will ship once the renderer Batch B target selector is
enabled; the “preconditions” state exactly what is needed to observe it. All four were found by independent
review; A1/A2 are proved by executed probes against the frozen source, A3/A4 by contract/code comparison and a
probe.

| ID | Severity | Finding | Preconditions / impact | Evidence | Recommended fix |
| --- | --- | --- | --- | --- | --- |
| **A1** | **medium** | **Prototype pollution in the frozen config scope.** `mergeInto` treats an own `__proto__` key of the merge patch as a normal object key: `target["__proto__"]` resolves to the base object's prototype, so the patch subtree is merged **into `Object.prototype`** of the helper process. | Renderer code constructs a patch with an own `__proto__` property (e.g. via `JSON.parse`), and the Batch B options passthrough exists. Probe: after one `config.patch`, `({}).pideckPolluted === "yes"` and `Object.prototype.hasOwnProperty(...)` is true in the helper realm. Impact: renderer-controlled global state corruption of the remote helper process that serves config/fs/git/terminal requests; possible DoS/subtle behavior change in later requests; **no demonstrated privilege escalation or secret exfiltration**, and a reconnect starts a fresh helper. Currently latent at HEAD because preload still drops options; the concurrent Batch B preload edit removes that barrier. | Provider: `src/main/remote/RemoteConfigSource.ts:144–163` (`target[key] = merged.value` at :160) — own `__proto__` hits the legacy setter; probe P2 in §2.2; reachability probe §2.2 (structuredClone+JSON preserve own `__proto__`); Batch B uncommitted preload passthrough (§0). Main-side `validatePatch` does not reject the key (`RemotePiConfigBackend.ts:134–153`). | Reject reserved keys (`__proto__`, `constructor`, `prototype`) in **both** layers: main `validatePatch` before any transport, and the frozen helper `mergeInto` (skip or handle with `Object.defineProperty`/null-prototype objects). Add a helper POSIX test and a backend test; the helper change requires a 1.21.x build/sha bump. Do this **before** merging the Batch B options passthrough. |
| **A2** | **medium** | **Secret-key matching is unanchored, so documented non-secret fields are redacted and silently unpatchable.** The shared pattern `token`/`secret`/… matches substrings; `maxTokens` and `tokenizer` match. Reads replace their values with `"configured"`, list them as secrets, and a numeric merge-patch to them is skipped by the secret branch (`typeof next === "string"` only), while the helper still re-writes the file and returns a success receipt with the **unchanged** version. | Remote models/settings editing in Batch B: any model row carrying `maxTokens` (a documented models.json capability field, `docs/pi-model-capability-plan.md:79–80`; also written by `src/main/config/providerMigration.ts:193,224,280,339,443` and typed at `src/main/config/ConfigManager.ts:128–129`). User sees the field mislabelled as a secret and cannot edit it; a save appears to succeed without changing anything. Direction is fail-closed for disclosure; the bug is correctness/data integrity. | `RemoteConfigSource.ts:30` (pattern) and :124–129 (redaction), :154–157 (patch skips non-string); contract repeats the same source string `RemoteHelperContract.ts:490` and the parity test `remoteConfigContract.test.mjs:35–41`; probes P1 in §2.2 report `maxTokens:"configured"`, `tokenizer:"configured"`, a numeric patch no-op, unchanged version and unchanged disk bytes. Tests cover only exact keys like `apiKey`/`token` (`remoteHelperConfig.test.mjs:124`), not `maxTokens`. | Tighten the matcher to whole secret key names / env-style suffixes (exact names `apiKey`, `api_key`, `accessToken`, `refreshToken`, `token`, `secret`, `password`, `passwd`, `authorization`, `cookie`, `credential`, `privateKey`, plus uppercase env-style suffixes `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`), explicitly excluding `maxTokens`/`tokens`/`tokenizer`; amend contract §6.4.1 line 488 and update both the helper literal and the shared pattern in one commit; add read+patch tests for `maxTokens` and an env-style `OPENAI_API_KEY`. |
| **A3** | low | **Config requests are not serialized under the host operation lock as the frozen contract requires** (“同一 host 的配置请求在 host 操作锁内串行”). Assembly calls `service.request`, the documented lock-free one-off path; no host-revision/lifecycle fence is applied to config requests. | Concurrent config read/write requests for the same host, or a rebind/disable while a config request is in flight. Impact is limited: the helper executes the whole config read/patch synchronously (no await), and expectedVersion is a CAS on the current bytes, so lost updates are not possible; but ordering with host lifecycle changes is not fenced, contrary to the contract. | `src/main/index.ts:3214–3229` (transport → `service.request`); `RemoteHostConnectionService.ts:735–747` (documented one-off, no lock, no revision check) vs `:229,573,607,679,704,774` (`operationLock` used only for project/connect paths); plan `docs/remote-development-plan.md:494`. | Add a service-level `withHostRequest(config)` that runs under `operationLock` and re-checks the store revision before/after (mirroring the project-session fence), or record an explicit plan deviation with rationale (helper serialization + CAS) and keep it tested. |
| **A4** | low | **Invalid UTF-8 content is accepted with replacement characters.** The contract lists UTF-8 as a target-file precondition, but `parseData` uses `buffer.toString("utf8")`, which never fails; bytes that happen to remain valid JSON after replacement are returned as a valid snapshot. | A config file corrupted/tampered with invalid UTF-8 inside JSON strings. Reads present `U+FFFD` data as authoritative; a later patch re-serializes and **rewrites** the file, silently replacing the original bytes. No disclosure; integrity/contract issue (fail-open for corruption). | `RemoteConfigSource.ts:97–102` (no `TextDecoder({fatal:true})`); probe P3 in §2.2; plan `docs/remote-development-plan.md:487`. | Decode with `new TextDecoder("utf-8",{fatal:true})` and map failure to `CONFIG_FILE_INVALID`; add a POSIX helper test with invalid bytes inside a string; bump helper build/sha. |

## 5. Observations (not vulnerabilities)

- **O1 — `version/sha256` is a hash of raw bytes and therefore a commitment over secret values.** The contract
  mandates this (plan §6.4.1 line 488); main only checks that both equal. A compromised renderer that knows the
  non-secret fields (and, after a first remote patch, the exact `JSON.stringify` serialization) could
  brute-force a **low-entropy** secret by hashing candidate files and comparing the returned version. Typical
  API keys are high-entropy and not feasible; passwords would be, but credentials are supposed to live in
  `auth.json` (out of scope). Recorded as an accepted-risk decision for the Batch B threat model; a stronger
  design would keep the raw-byte hash main-side and expose an opaque generation token to the renderer.
- **O2 — redaction is key-name heuristic, not content-based.** Values carrying credentials under a
  non-matching key (e.g. userinfo inside a `baseUrl`, a custom header map whose header names do not contain the
  listed words) are returned in plaintext to the renderer. This is the contract's own model (“识别 secret 键名”,
  line 488) and matches it, but Batch B must not assume the sanitized `data` is free of every secret-shaped
  string; the DTO contract says “no secret plaintext”, which is only true for keyword-matching keys.
- **O3 — deferred channels that never take a target cannot be refused by main.** Auth/trust/MCP/raw/
  tokendance-auth/provider-migration/probe channels accept no target option, so main cannot know a renderer
  considers them “remote”; enforcement is Batch B UI-only. A future renderer bug that calls them while showing
  a remote target would silently operate on the **local** config/network. Recommend adding a shared
  “no remote target” guard (or an explicit product note) when Batch B lands; this is a defense-in-depth gap,
  not a current bypass, because the preload at HEAD cannot pass a target to those channels.
- **O4 — read has a filesystem side effect.** `agentDirectory()` creates `.pi`/`.pi/agent` with 0700 even for
  `config.read` (`RemoteConfigSource.ts:60–66,189–194`; test `remoteHelperConfig.test.mjs:140–148` asserts this
  intentionally). Contract line 487 permits creating a missing `agent` dir; noting it because a read-only verb
  mutating the host is surprising and should be documented in the Batch B/UI copy.
- **O5 — helper-side array patch bounds are weaker than the contract.** `mergeInto` returns a deep clone for
  array patch values without walking them, so the helper's own MAX_NODES/MAX_DEPTH do not apply inside arrays
  (main's `validatePatch` does walk arrays and is the effective bound). Unreachable today other than through
  main; parity fix recommended with A2's helper change.
- **O6 — crash-left `.tmp-`hex`` files are never swept.** `writeAtomic` cleans its temp on caught failures, but
  a SIGKILL/power loss between write and rename leaves a 0600 plaintext config temp in `~/.pi/agent`
  (potential secret copy). Same-account/0600 limits the exposure; no periodic cleanup exists. Optional: sweep
  stale `.tmp-*` on the next successful write/read of that file.
- **O7 — null-deleting an ancestor object deletes nested secrets.** The contract says null deletes
  “non-secret keys”; the implementation deletes the whole subtree, so a secret can be removed indirectly by
  deleting its parent object. This is plausibly intended (removing a provider must be possible), but the Batch
  B copy/confirmations should not claim “secrets can only be replaced, never removed”.

## 6. What is solid (short, evidence-backed)

1. **Allowlist with no path authority** — two file keys, exact-key params, no `auth.json`, no directory listing
   (`RemoteConfigSource.ts:27–50`; contract tests).
2. **No-follow, identity-checked, bounded reads** — lstat/O_NOFOLLOW/fstat dev+ino, 1 MiB caps
   (`:67–96`); symlink/size/malformed refusals covered by the POSIX helper tests (skipped here but present).
3. **Atomic, version-guarded writes** with readback verification and a dedicated unconfirmed code
   (`:144–213`; codes `RemoteHelperContract.ts:108–118`).
4. **Recursive secret redaction and a recomputed, cross-checked secret list in main**, including plaintext
   rejection at a secret position (`RemotePiConfigBackend.ts:85–132`; test :62–77).
5. **Eight-code closed set end-to-end**, with unknown helper/transport codes collapsing to UNAVAILABLE and no
   raw text forwarding (`RemotePiConfigBackend.ts:59–83`; tests :79–102).
6. **Renderer input cannot become a path/host/argv authority** on this surface; the patch is bounded data and
   the file is selected from a two-item enum (see §3.2).
7. **Deferred provider/model/usage operations refuse an ssh target before network/key/helper work**
   (four first-statement guards; test `remotePiConfigRouting.test.mjs:106–132`).
8. **Local behaviour preserved** — router local branch and IPC/preload shapes unchanged at HEAD; no new
   channels; tests assert it.
9. **Artifact discipline** — helper 1.21.0, `config.mjs` sha pinned and included in the six-artifact bundle
   list, entry sha recomputed by test, manifest built from the same constants
   (`RemoteConfigSource.ts:219`; `RemoteHelperEntry.ts:137,178–189`; `RemoteBundleMaintenance`-unrelated
   manifest path `RemoteBootstrapDeployment.ts:37–52`; `remoteConfigContract.test.mjs:49–71`).

## 7. Explicit unknowns / cannot verify

1. **No real helper POSIX runs.** All five `remoteHelperConfig` tests are skipped on this Windows host; the
   on-disk claims (atomic 0600 write, readback, symlink refusal, auth.json unreachable at the filesystem level)
   are code + test-source verified only, not reproduced. A Linux/WSL run is required before release.
2. **No real SSH host / real Electron.** Host readiness, transport timeouts, real HOME and remote filesystem
   semantics (ownership, mode, directory fsync behavior) were not exercised. No e2e, no app restart, no pack.
3. **Batch B is absent from the reviewed tree** (except the concurrent uncommitted edits noted in §0): renderer
   target selector, secret badge display, patch-diff construction, disabled-entry copy and the preload options
   passthrough are not reviewed here. A1/A2 become user-reachable through exactly that preload change; the
   recommendation in §8 depends on it landing with the fixes.
4. **Local regression beyond source diff not run**: the local ConfigManager/Renderer config tests were not
   re-run (Batch A does not modify them; router/IPC-shape tests pass). Full `npm test` not run.
5. **O1 accepted-risk decision** (raw-byte hash oracle) is a product/threat-model decision, not resolved here.
6. **Independent human reviewer** still absent; this is an AI agent review, as with the previous two reports.
7. **macOS** remote host and **packaged build** behavior unverified.

## 8. Release recommendation

- **Batch A helper/main/shared can be accepted as designed**, subject to the evidence gaps above (POSIX helper
  run and real-host smoke). The eight-code contract, allowlist, no-follow/atomic write, reply re-validation
  and local-behaviour preservation are in good shape.
- **Block the Batch B renderer target selector until A1 is fixed** (or at minimum until main's `validatePatch`
  rejects `__proto__`/`constructor`/`prototype` so no such patch can reach the helper). A1 is cheap to fix in
  both layers but is the only finding with a memory-safety-adjacent flavor; shipping the options passthrough
  first would expose it to any renderer compromise.
- **Fix A2 in the same helper build** as A1 if possible: the unanchored pattern breaks a documented
  models.json field (`maxTokens`) and produces silent no-op saves, which is exactly the class of “UI says saved
  but nothing changed” bug the release gate should not accept. Update contract §6.4.1 line 488 in the same
  commit so helper/shared/tests stay one source of truth.
- **A3/A4**: A3 should be fixed (host-lock wrapper) or recorded as an explicit plan deviation with the
  serialization/CAS rationale; A4 is a one-line `TextDecoder` fix and should ride along with the A1/A2 helper
  update (build 1.21.x, sha re-pin). If the decision is to defer, say so in the ledger — do not leave the
  frozen contract and implementation silently divergent.
- No release blocker in the **local** config path: the four handlers keep the old behaviour when options are
  absent, and the old preload call shapes still work.

## 9. Non-goals

- No source changes, no commits; no edits outside this addendum; the ledger/handoff/plan/Git plan were read
  only.
- No real host, no Playwright/e2e, no full `npm test`, no `npm run pack`/build, no app restart.
- Not a dependency/CVE audit, not a cryptographic review of sha256/JSON parsing beyond the code checks above.
- Not a review of Batch B renderer/UI/i18n/e2e, local ConfigManager internals, auth/trust/MCP/project config
  surfaces, or any non-config IPC (except the target guards on the four deferred ops).
- Not a fuzzing/penetration test; the three probes exercised the frozen logic with an in-memory fs mock, not a
  real remote filesystem.

## 10. Evidence appendix

Commands (read-only, HEAD `0a0cc53b8`, Windows host):

    node --test --test-concurrency=2 tests/remoteConfigContract.test.mjs tests/remotePiConfigBackend.test.mjs tests/remotePiConfigRouting.test.mjs tests/remoteHelperConfig.test.mjs tests/remoteHelperEntry.test.mjs
    → tests 60, pass 55, fail 0, skipped 5 (the five POSIX real-helper config tests)

Probes (§2.2; frozen `REMOTE_CONFIG_SOURCE` evaluated in a mocked fs/path/crypto sandbox):

    PROBE1 data= {"maxTokens":"configured","tokenizer":"configured","theme":"dark"}
    PROBE1 secrets= [{"path":"maxTokens","status":"configured"},{"path":"tokenizer","status":"configured"}]
    PROBE1 patchedData= {"maxTokens":"configured","tokenizer":"configured","theme":"dark"} versionChanged= false
    PROBE1 disk= {"maxTokens":32000,"tokenizer":"x","theme":"dark"}
    PROBE2 polluted= yes on Object.prototype? true
    PROBE3 accepted data= {"s":"\ufffd\ufffd"} codes= [65533,65533]
    reachability: structuredClone + JSON.stringify preserve an own "__proto__" property

Snapshot commands: `git rev-parse HEAD` = 0a0cc53b8f45cde2937409373999ea65676b9ee2. At review start
`git status --porcelain` was empty; at write time it showed the concurrent Batch B edits described in §0
(`src/shared/piConfig.ts`, `src/preload/index.ts`, `src/main/ipc/systemIpc.ts`, plus a new renderer file) —
none of which is review subject. Static greps used: frozen source contains neither `auth.json` nor
`params.path`; `RemotePiConfigBackend.ts` imports no ConfigManager/fs/child_process; `operationLock` appears
only on project/connect paths in `RemoteHostConnectionService.ts`.

## Fix verification (round 2)

> Task-17 addendum section — read-only verification, appended after the fact. No other file was written, no
> commits, no builds/e2e. **Snapshot note:** this task started at HEAD `dafe725f` + an uncommitted Batch B
> renderer tree; while the verification ran, that Batch B tree was committed as `567bf2d8a` (`feat(remote):
> expose target-routed remote models/settings in the config UI (Batch B)`). The verification below was therefore
> executed against **current HEAD `567bf2d8a`**, which contains both the hardening commit `dafe725f` and the
> Batch B preload passthrough. Tree at write time: clean except two untracked docs (this addendum and
> `docs/remote-night-summary.md`).

**Result: all requested items PASS — no FAIL.** A1, A2 and A4 are fixed in the frozen helper and (for A1) in
main as defense-in-depth; the A3 deviation is explicitly documented in the frozen plan; the committed Batch B
preload passthrough cannot bypass main validation. One residual coverage note for A2 is recorded below.

| Check | Verdict | Evidence |
| --- | --- | --- |
| **A1** prototype pollution (recursive reserved-key rejection, no `Object.prototype` reachable, defineProperty merge) | **PASS** | Frozen source: `RemoteConfigSource.ts:32` (`RESERVED`), `:128` (read-side rejection), `:159` (merge rejection), `:203–217` (whole-patch pre-scan), `:163,168` (`Object.defineProperty` merge); main defense: `RemotePiConfigBackend.ts:137–158` (:151 reserved), called at `:181` **before** the transport at `:182`. Probes: four reserved payloads (own `__proto__`, nested `constructor.prototype`, reserved inside an array, `prototype`) all answered `CONFIG_FILE_INVALID` with `Object.prototype` clean and disk untouched; a file containing an own `__proto__` key is refused on read; main-validator probe: same four payloads → `REMOTE_CONFIG_FILE_INVALID` with **0 transport calls**, while a valid patch reaches the transport. Tests: `tests/remotePiConfigBackend.test.mjs:123–130` passes (`reserved keys are rejected recursively before any transport call`); the POSIX real-helper test `tests/remoteHelperConfig.test.mjs:259–274` is among the skipped-on-Windows tests. |
| **A2** anchored secret-key pattern (real fields not redacted/pinned; secret names redacted; non-string secret patch refused) | **PASS** (acceptance criteria), with a residual coverage note | Pattern `RemoteConfigSource.ts:30–31` = `RemoteHelperContract.ts:493` and contract-test negatives `tests/remoteConfigContract.test.mjs:51–53`. Probe (read, then patch): `maxTokens=32000`, `max_tokens=10`, `tokenizer="x"`, `tokens=5` preserved and absent from `secrets`; `apiKey`, `api_key`, `ANTHROPIC_API_KEY`, `accessToken`, `refreshToken`, `password`, `provider_token`, `client_secret`, `X-Api-Key` all redacted to `"configured"` and listed; a numeric `{maxTokens:8192}` patch now **applies** (returned data and disk both 8192, version changes); `{apiKey:123}` → `CONFIG_FILE_INVALID` with disk secret untouched; explicit string replacement works (read-back `configured`, disk new value). Tests: helper POSIX shape `tests/remoteHelperConfig.test.mjs:276–293` (skipped on Windows), contract negatives above pass. |
| **A4** fatal UTF-8 (invalid bytes → `CONFIG_FILE_INVALID`, file untouched) | **PASS** | `RemoteConfigSource.ts:99–106` uses `new TextDecoder("utf-8", { fatal: true })`; probe: read and patch of `{"s":"\xff\xfe"}` both answer `CONFIG_FILE_INVALID` and the raw bytes on disk are byte-identical afterwards. Plan text updated (`docs/remote-development-plan.md:487`: “严格 UTF-8 … 不替换、不覆盖”); POSIX real-helper test `tests/remoteHelperConfig.test.mjs:295–301` is skipped on Windows. |
| **Helper build / artifact pins** | **PASS** | Entry reports `1.21.1` (`RemoteHelperEntry.ts:137`); config sha pin `95bee7d2…42b7` (`RemoteConfigSource.ts:243`) equals sha256 of the frozen source (probe), the `config.mjs` artifact entry carries the same source+sha (`RemoteHelperEntry.ts:199`), artifact list is `helper/git-read/git-write/git-sync/config/terminal-runner`; contract test `tests/remoteConfigContract.test.mjs:69–71`. |
| **A3 documented deviation** | **PASS (documented)** | `docs/remote-development-plan.md:494` now contains “**已知偏差（2026-10 复审 A3）**：配置请求走既有的一次性 `service.request` 而非 host 操作锁，依靠 helper 单线程执行 + `expectedVersion` CAS + manager identity 保证不丢更新；host 生命周期 revision fence 未加 …”. Matches the finding; no code change claimed. |
| **Batch B preload passthrough cannot bypass main validation** | **PASS** | The committed passthrough only forwards an options object on the four existing channels (`src/preload/index.ts:1111,1124,1146,1165`); main builds the renderer DTO in the same handlers (`src/main/ipc/systemIpc.ts:1622–1661,1693–1731`); the renderer save port goes through `config.saveModels/saveSettings` with `{target, expectedVersion, patch}` (`src/renderer/src/config/useRemotePiConfigPanel.ts:22–33`). Every remote write reaches `RemotePiConfigBackend.patch`, which validates the target/version/patch and runs `validatePatch` (reserved keys, depth/nodes/size) **before** `transport.request` (`RemotePiConfigBackend.ts:177–182`); no new channel or alternate transport exists. The renderer additionally refuses reserved patch keys in its own parser (`src/renderer/src/config/remoteConfigModel.ts:60–95`) — defense in depth, not the relied-upon barrier. |

### Round-2 evidence commands and probe outputs

    node --test --test-concurrency=2 tests/remoteConfigContract.test.mjs tests/remotePiConfigBackend.test.mjs tests/remotePiConfigRouting.test.mjs tests/remoteHelperConfig.test.mjs tests/remoteHelperEntry.test.mjs tests/remoteConfigModel.test.mjs tests/remoteConfigRendererWiring.test.mjs
    → tests 83, pass 75, fail 0, skipped 8

All 8 skips are the POSIX real-helper config tests (the original 5 plus the three new A1/A2/A4 tests); they
were not run on this Windows host. The fixed frozen source was exercised directly instead (sandboxed
fs/path/crypto, same technique that found the bugs in round 1):

    A2 read fields= {"maxTokens":32000,"max_tokens":10,"tokenizer":"x","tokens":5}
    A2 secrets= [ANTHROPIC_API_KEY, X-Api-Key, accessToken, apiKey, api_key, client_secret, password, provider_token, refreshToken]
    A2 numeric maxTokens patch ok= true data=8192 disk=8192
    A2 non-string secret patch= CONFIG_FILE_INVALID disk secret= sk-1
    A2 secret replace ok= true data="configured" disk=new-secret
    A1 payload 0..3 = CONFIG_FILE_INVALID; Object.prototype clean= true; disk untouched= true
    A1 read-with-reserved-key= CONFIG_FILE_INVALID
    A4 read invalid-utf8= CONFIG_FILE_INVALID
    A4 patch invalid-utf8= CONFIG_FILE_INVALID disk untouched= true
    MAIN-A1 payload 0..3 = REMOTE_CONFIG_FILE_INVALID transportCalls= 0
    MAIN valid patch = remote receipt, transportCalls= 1
    configShaPin == sha256(REMOTE_CONFIG_SOURCE); helperVersion=1.21.1; config artifact sha/source match

### Residuals / unknowns after the fix

1. **A2 coverage narrowed for camelCase compounds.** The anchored matcher fixes the false positives, but it no
   longer treats keys such as `clientSecret`, `openaiApiKey` or `dbPassword` as secrets (substring matching used
   to). The probe shows their values are returned in plaintext to the renderer, and a non-string patch to them is
   no longer a secret-shape error. The contract's name list does not include those compound names, so this is
   consistent with the frozen contract, but it is a real coverage change: decide explicitly whether to add
   camelCase-suffix detection (e.g. a documented suffix allowlist) or accept/document it. Do not claim “no
   secret-shaped value ever crosses” without that decision.
2. **Real-helper POSIX verification still missing on this host.** The 8 skipped tests include the new
   on-disk assertions (reserved keys, maxTokens/max_tokens patch, UTF-8 refusal). A Linux/WSL run of
   `tests/remoteHelperConfig.test.mjs` is required before release sign-off; the sandbox probe verifies the
   shipped logic, not real fs/atomic behavior.
3. **A3 remains a documented deviation**, not fixed: the host-lifecycle revision fence is still absent. Recorded
   in the plan (line 494); revisit if a switch race is observed.
4. **Unchanged earlier unknowns:** no real SSH host/e2e, no packaged build, no macOS client, no independent
   human reviewer; O1 (raw-byte hash as a secret commitment) is still an accepted contract decision.
5. **Batch B UI itself** (selector, unsupported notices, copy) was only inspected for the write path above; it is
   not a security review subject here.

**Conclusion:** A1/A2/A4 are verified fixed at HEAD `567bf2d8a` with probe-based PASS evidence; A3 is documented;
the Batch B passthrough is not a validation bypass. Remaining work before release is the POSIX real-helper run,
the A2 compound-name decision, and the pre-existing real-host/packaged/independent-review gates.



## Round 3 (Lead, 2026-10-18): A2 residual (camelCase compounds) fixed in helper 1.21.2

The Round-2 residual note (camelCase compounds such as `clientSecret`/`openaiApiKey`/`dbPassword` were returned in plaintext after pattern anchoring) is fixed in helper 1.21.2: the shared secret pattern is now `^(?:[a-z0-9]+[-_])*(?:[a-z0-9]+)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|password|passwd|authorization|cookie|credential|private[-_]?key)$/i`, which admits one camelCase prefix segment while still excluding `maxTokens`/`max_tokens`/`tokenizer`/`tokens`. Pins: config.mjs 9,639 chars sha `0006235d…`; helper.mjs 40,844 chars sha `957cb034…`; contract/helper tests extended with camelCase positives and the real-field negatives; Windows 56/56, WSL 8/8. POSIX real-helper coverage and A3 documented deviation remain as stated in Round 2.
