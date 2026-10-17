# 远端安全低危项修复记录（F2 / F4 / F5 / F6）

> 状态：**已实现 + 定向验证**（2026-10-17 深夜批次，分支 `feat/remote-development`）。
> 范围：仅修复 [独立安全审查](remote-security-review.md) §4 的四个 low findings —— **F2、F4、F5、F6**。
> 明确不在本批：F1（medium，Git sync 预算）、F3（terminal one-shot ticket）、F7–F10（info / 威胁模型观察）、
> full `npm test`、真实主机 e2e、`npm run pack`、Playwright。审查报告的正文不改写，只在文首加一行状态指针。
>
> 证据口径：所有「已修复」都指**源码 + 定向单测**；未在真实远端主机、打包产物或 Windows→Linux 的真实 SSH
> 会话上复跑（审查 §7 的 follow-up 仍然需要）。OS 相关分支已在 WSL Ubuntu（node 22）实跑，Windows 侧按平台跳过
> 的用例在 WSL 全绿。

## 0. 基线与验证快照

| 项 | 值 |
| --- | --- |
| 基线 commit | `1606fc042`（G5e）+ 本批工作区改动 |
| 改动的生产文件 | 8 个（见各 finding；其中 2 个新模块） |
| 改动的测试文件 | 5 个既有 + 2 个新增 |
| 定向单测（Windows） | 9 个文件：**241 tests / 217 pass / 0 fail / 24 skipped**（skip = POSIX-only 写守卫语义） |
| 定向单测（WSL Ubuntu，node 22） | 4 个文件：**71 tests / 71 pass / 0 fail / 0 skipped**（含 Windows 上跳过的 24 项） |
| typecheck | 本批文件通过（用只含本批文件的 tsconfig 跑 `tsc --noEmit`）；全仓 `npm run typecheck` 在提交时刻被**另一个 lane 的在飞文件** `src/main/ipc/remoteProjectEntryIpc.ts`（未跟踪、file-management 批）挡红，与本批无关 |
| Biome | 本批 15 个文件 `biome format --write` 后无差异 |
| 未运行 | 全量 `npm test`、真实主机 e2e、`npm run pack`、Playwright（按任务约束） |

验证命令（精确）：

    node --test --test-concurrency=2 tests/remoteBundleMaintenance.test.mjs tests/remoteHostIdentityFile.test.mjs tests/remoteHostIpc.test.mjs tests/remoteBootstrapSession.test.mjs tests/remoteSessionHistoryRead.test.mjs tests/remoteSessionHistoryWrite.test.mjs tests/remoteSessionWriteGuard.test.mjs tests/remoteSessionWriteGuardUi.test.mjs tests/sessionRuntimeCoordinator.test.mjs
    → tests 241, pass 217, fail 0, skipped 24

    wsl.exe -e bash -lc 'export PATH=/home/wsl/node-linux/bin:$PATH; cd /mnt/f/PiDeck-remote && node --test tests/remoteSessionWriteGuard.test.mjs'
    → 24 pass / 0 fail / 0 skip（POSIX 专属：uid/gid/mode/symlink/真实 /bin/sh 语义）

    wsl.exe -e bash -lc '... node --test tests/remoteBundleMaintenance.test.mjs'
    → 12 pass / 0 fail（Linux 上额外覆盖 0700/owner 校验分支）

    wsl.exe -e bash -lc '... node --test tests/remoteBootstrapSession.test.mjs'
    → 15 pass / 0 fail

    wsl.exe -e bash -lc '... node --test tests/remoteSessionHistoryWrite.test.mjs'
    → 20 pass / 0 fail

## F2 — 已部署 helper bundle 的 host 侧保留/清理（review §(b)、findings 表）

### Before

- 远端 `~/.pideck/remote-host/bundles/<bundleSha256>` 只增不减：每次 PiDeck 版本变化、每次重装/换版本都会
  在同一账号下留一份完整快照；`.staging-<nonce>` 与 `.deploy.lock` 只在 bootstrap 进程自己的失败/EOF 路径里
  清理，bootstrap 被本机崩溃/断电打断就永久残留（lock 只能等下一次 bootstrap 的持有者存活判据回收）。
- plan §4.2 的 active/rollback/lease 保留、≤2 份未引用快照、≤7 天、staging >1h 清理、24h artifact TTL 全部
  无实现、无测试。审查 grep 只找到 bootstrap 自己的进程内 `cleanup()`。

### After

新增 **host 侧 sweep**，在 **bootstrap 完成「已确认激活」之后**执行一次（不是激活前，也不是猜测）：

- 固定内联 Node 源码 + 既有 pinned SSH 短命令（`ssh-batch`）执行；**不新增 helper op、不改 helper 协议/sha**。
  与 write guard / bootstrap inline 同一套纪律：源码常量唯一、argv 逐个 `quotePosixArgument`、单条命令
  ≤ `REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH`(8192)、stdout 只写 `<marker><json>`、只有闭集稳定码。
- 保留判据（fail closed）：
  - 本次激活的 `bundleSha256` **永远保留**；扫描结果里找不到它 ⇒ 跳过整个 bundle 清理
    （`ACTIVE_BUNDLE_MISSING`），绝不按目录名猜 active；
  - 最新一份非 active 快照视为 **rollback**，永远保留；
  - 其余未引用快照最多保留 **2** 份且不超过 **7 天**；超出者按最旧优先删除；
  - **并发连接保护**：未引用快照年龄 < **1 小时** 一律不删（另一台机器/另一个 PiDeck 版本可能正连在它上面；
    plan 要求的「连接注册 + lease」尚未实现，这是本批能做到的最保守替代，见 §5 残留风险）；
  - `.staging-*`（名字形状 + 目录 + 非符号链接）只在**没有活跃 deploy lock** 时、目录 mtime > **1 小时** 才删；
  - `.deploy.lock`：持有者按 pid + Linux `/proc/<pid>/stat` start identity 判定（与 bootstrap 同一判据）。
    存活 ⇒ 整个 sweep 跳过（另一个客户端可能正在部署）；已死 ⇒ 删除 stale lock；
  - deployRoot / bundlesDir / 单个 bundle 目录的 owner 或 mode（POSIX：`0700` + 同 uid）无法验证 ⇒
    **不删**并把条目计入 `unverifiable`；`HOME` 与 ready frame 报告的 deployRoot 不一致 ⇒ 整段跳过
    （`DEPLOY_ROOT_UNVERIFIABLE`）。
- 失败语义：**非致命**。bootstrap 里 `sweepDeployedBundles()` 捕获一切异常，只写 warn 日志
  （`scope="remote"`, message=`REMOTE_MAINTENANCE_SWEEP_FAILED`, detail 只有 `hostId` + 稳定码，无路径/命令/正文）；
  成功只记 debug 计数。部署结果不受影响。
- 结果解析：标记后只接受一个严格重建的 JSON（计数/布尔/闭集 skip 码），未知字段/未知码/负计数/重复 skip 码
  一律 `REMOTE_MAINTENANCE_RESULT_INVALID`，绝不用不可信输出去删任何东西。

### Files

| 文件 | 改动 |
| --- | --- |
| `src/main/remote/RemoteBundleMaintenance.ts` | **新增**：冻结内联源码、保留参数常量、命令构造/结果解析、pinned 通道执行器（`maintainDeployedBundles`） |
| `src/main/remote/RemoteBootstrapSession.ts` | `bootstrapPinnedHost` 在 `runPreparedBootstrap` 成功后调用 sweep；非致命 + 稳定码日志 |
| `tests/remoteBundleMaintenance.test.mjs` | **新增**：真实子进程执行冻结源码 + 假 HOME 布局（见下） |
| `tests/remoteBootstrapSession.test.mjs` | 新增两条接线测试：确认激活后调用 sweep（参数来自激活结果）、sweep 失败不影响部署且只记稳定码 |

测试覆盖（12 + 2）：

- 真实子进程（不是 mock）在临时假 HOME 下构造 `<home>/.pideck/remote-host/{bundles,staging,lock}`，用
  `utimesSync` 指定年龄，再断言目录**实际存在性**：active 保护、rollback 保护、≤2 份、7 天 TTL、1h 并发保护、
  staging 1h 清理（含半截上传内容）、活跃 lock 全跳过（含「本该被删」的旧 bundle/staging 都还在）、
  crash lock 回收后继续、HOME 不一致 fail closed、active 缺失 fail closed、不可验证条目保留并计数；
- 命令构造：非法 node/deployRoot/sha/nonce/now 全部 `REMOTE_MAINTENANCE_INPUT_INVALID` 且不发命令；命令长度
  ≤ 8192；每个 token 单独 quoting；结果解析的严格性（缺标记/撕裂 JSON/未知码/重复 skip/负计数）。
- 常量契约：`plan §4.2` 的 1h / 7d / 2 份 / 1h 并发门槛同时钉进源码与 TS 常量（防「常量改了、远端还是旧行为」）。

### Residual risk / deviations

1. **多客户端注册未实现**：plan §4.2 要求「按当前活跃连接注册的 bundle + rollback + lease」判可达性；本批没有
   helper 协议变更（那会需要 helper build/sha bump 与 F1 同批协调），因此用「active sha + 最新非 active + 未引用
   ≤2/≤7d + 1h 年龄门槛」近似。最坏情况：另一个 PiDeck 实例正连在一份 **>7 天且被挤出前 2 名** 的 bundle 上时，
   本 sweep 会删掉它（该实例下一次启动/重连会重新 bootstrap 自愈，不会读错代码；但已连接进程可能在后续
   helper respawn 时失败）。审查 §7 item 3 的真机矩阵仍然需要。
2. **触发时机**：sweep 跟随「一次真实 bootstrap」（每次应用启动/每台主机首次连接、store revision 变化时），
   复用 held bootstrap 的纯 connect 不再重复扫。startup-leftover 的常规形态（每次启动至少一次）被覆盖；
   长时间不重启的进程不会周期性清理（plan 的「helper 周期 sweep」未实现）。
3. **24h artifact TTL** 与 terminal launch ticket TTL 不在部署根内／属 F3，本批不覆盖。
4. 扫描/删除是同一远端账号内的文件操作，仍受审查 §2.3 的威胁模型约束（同账号恶意进程不在隔离承诺内）。
   `rmSync` 前做 dev/ino 复核，但不能防住同账号的竞态替换（与计划口径一致）。

## F4 — SSH config 候选的 `IdentityFile ~/...` 规范化（review §(a)、findings 表）

### Before

SSH config 给出 `IdentityFile ~/.ssh/id_ed25519`（真实配置最常见形态）时，候选原样把 `~/.ssh/...` 送进
`remote:host-add`；main 从不展开 `~`，host store codec 要求 `isAbsolute` ⇒ 添加主机以不透明的
`REMOTE_HOST_STORE_INVALID` 失败（审查探针已复现）。plan §5.2 要求 main 保存前展开 `~` 并规范化成本机绝对路径。

### After

- 新增纯函数 `normalizeRemoteHostIdentityFile(value, homeDir = homedir())`：
  - `~` / `~/...` 展开到**本机账号** HOME（这是本地 OpenSSH 客户端要读的私钥引用，不是远端账号文件；
    与 plan §5.2 line 261「规范化为本机绝对路径」一致）；
  - 绝对路径保留并 `path.normalize`；`path.normalize` 会保留尾分隔符，这里显式去掉（`-i` 实参 / store 值都不带）；
  - `~user`、相对路径、空串、控制字节、展开后超 4096 字符 ⇒ `undefined`（拒绝而不是猜）。
- `remoteHostIpc.readAddInput` 在 **`createDraft` 之前**调用它；无法规范化时返回独立稳定码
  **`REMOTE_HOST_IDENTITY_FILE_INVALID`**（与表单其它字段的 `REMOTE_HOST_ADD_INVALID` 区分；渲染层现有
  `settings.connections.add.failed {code}` 会直接显示这个码，无需 i18n 变更）。
- 候选流程（`AddHostDialog`）无需改动：它原样提交 `candidate.identityFile`，规范化发生在 main。

### Files

| 文件 | 改动 |
| --- | --- |
| `src/main/remote/RemoteHostIdentityFile.ts` | **新增**：纯函数规范化 + 稳定码 |
| `src/main/ipc/remoteHostIpc.ts` | `readAddInput` 返回 `{ok,input}|{ok:false,code}`；identityFile 走规范化并映射专用码 |

测试：

- `tests/remoteHostIdentityFile.test.mjs`（新增 5 条）：`~`/`~/...` 展开、绝对路径规范化（含 `//`、`./`、
  尾斜杠）、`~user`/相对路径/控制字节/超长/非字符串拒绝、坏 home 拒绝、稳定码形状。
- `tests/remoteHostIpc.test.mjs`（+2 条）：候选形态 `~/.ssh/id_ed25519` 在 `createDraft` 前变成绝对路径、
  不合法形态返回 `REMOTE_HOST_IDENTITY_FILE_INVALID` 且**不创建 draft**（不再出现 `REMOTE_HOST_STORE_INVALID`）；
  不填 `identityFile` 时字段保持缺省。

### Residual risk / deviations

1. **任务描述里写的是「expand against the remote account HOME」**，但权威依据（review F4 的 suggested fix、
   plan §5.2 line 261）明确是**本机** HOME：identityFile 是本地 OpenSSH 的 `-i` 引用，按远端 HOME 展开在语义上
   是错的。本批按 review/plan 实现（本机 HOME），此处记录与任务描述的偏差。
2. `~user` 形式（其他用户 home）被拒绝而不是解析：需要 NSS/LDAP 查询且跨机器不一致，属于猜。
3. 文件是否存在/可读仍由既有连接预检（`assertReadableIdentity`）在连接期验证；本批不改变该职责（plan 允许
   「保存时文件暂不存在」）。

## F5 — 会话历史改写「提交回执丢失」的结果未确认语义（review §(f)/(h)、findings 表）

### Before

`RemoteSessionHistoryWriter.writeRemoteFile` 的提交命令（守卫脚本 `commit` 动作）失败时统一报
`REMOTE_SESSION_HISTORY_WRITER_COMMAND_FAILED`，其注释还写着「非 0 退出 ⇒ 目标文件没被改动」。但守卫脚本的
顺序是「校验 → `renameSync` → 写结果」：SSH 在 rename 之后断开/超时/丢 stdout 时，远端文件可能**已经是新内容**，
而渲染层只显示通用的「会话操作失败，请重试」——基于错误前提的手动重试。

### After

- 新增稳定码 **`REMOTE_SESSION_HISTORY_WRITER_RESULT_UNCONFIRMED`**（提交 rename 可能已发生）：
  - 提交命令的**传输层异常**、**非 0 退出**、**输出不可信（缺标记/JSON 撕裂/形状非法）** ⇒ 该码；
  - 守卫脚本**亲自报告**的提交前失败（`fileChanged` / 脚本级 `transferInvalid` 等，rename 确定未发生）⇒
    保持原码不变（用 `isRemoteSessionWriteGuardUntrustedOutput()` 区分「输出不可信」与「脚本明确拒绝」，
    避免把真正的冲突诊断折叠成未确认）；
  - 提交前（分块写临时文件）失败仍为 `commandFailed`；该码的注释收敛为「提交点之前」。
- 修正模块注释：只有提交前失败能保证「目标未改动」；提交失败 ≠ 未生效。
- `SessionRuntimeCoordinator.remoteMessageMutationCommandError` 保留该码到
  `SessionCommandError.debugDetails`（code 仍为 `SESSION_COMMAND_FAILED`，因为 `SessionCommandErrorCode` 是
  shared 契约，另一 lane 本轮拥有 shared/renderer），并加注释说明渲染层必须按 debugDetails 显示「结果未确认」。
- 不自动重试、不谎报成功：同一路径不会在失败后再发第二条提交命令（测试锁定）。

### Files

| 文件 | 改动 |
| --- | --- |
| `src/main/remote/RemoteSessionHistoryWriter.ts` | 提交阶段错误分流 + 新稳定码 + 注释修正 |
| `src/main/remote/RemoteSessionWriteGuard.ts` | 解析器区分「输出不可信」（带标记属性）与「脚本报告的码」；导出只读判据 |
| `src/main/sessions/SessionRuntimeCoordinator.ts` | 错误映射注释（保留独立 debugDetails） |
| `tests/remoteSessionHistoryWrite.test.mjs` | 提交失败断言改为 unconfirmed；新增 4 种回执丢失路径 |
| `tests/sessionRuntimeCoordinator.test.mjs` | unconfirmed 码 → `SESSION_COMMAND_FAILED` + 独立 debugDetails |

测试（historyWrite 20 → 21）：

- rename 已执行、SSH 随后断开 ⇒ `RESULT_UNCONFIRMED`，且目标字节**确实已变**（证明不能声称「未改动」）；
- 退出码 0、stdout 丢失（缺标记）⇒ `RESULT_UNCONFIRMED`，目标已变；提交命令只发一次（不自动重试）；
- 结果行撕裂（半个 JSON）⇒ `RESULT_UNCONFIRMED`（不是 transferInvalid、也不是 commandFailed）；
- 守卫脚本明确报告 `fileChanged`（未 rename）⇒ 保持 `FILE_CHANGED`，目标未动；
- 既有读/写临时文件失败仍 `COMMAND_FAILED`、目标未动。

### Renderer / i18n patch（**本批不应用**，另一 lane 拥有 shared/renderer）

现状（F5 的剩余一半）：`src/renderer/src/utils/sessionCommands.ts` 只特判
`REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED`，其余 debugDetails 落到通用「会话操作失败，请重试」。建议补丁：

```diff
--- a/src/renderer/src/utils/sessionCommands.ts
+++ b/src/renderer/src/utils/sessionCommands.ts
@@
 const SESSION_COMMAND_ERROR_KEYS: Record<SessionCommandError["code"], TranslationKey> = {
@@
 	SESSION_FILE_TOO_LARGE: "sessionCommand.fileTooLarge",
 };
+
+/** F5：把远端写面的稳定 debugDetails 映射到专用文案（只对 SESSION_COMMAND_FAILED 生效）。 */
+const REMOTE_WRITE_DETAIL_KEYS: Record<string, TranslationKey> = {
+	REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED: "sessionCommand.remoteFileChanged",
+	// 提交 rename 可能已生效：文案必须说「重新加载核对、不自动重试」，不能是通用「请重试」。
+	REMOTE_SESSION_HISTORY_WRITER_RESULT_UNCONFIRMED: "sessionCommand.remoteWriteUnconfirmed",
+};
@@ constructor
 	constructor(error: SessionCommandError) {
-		super(t(error.code === "SESSION_COMMAND_FAILED" && error.debugDetails === "REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED" ? "sessionCommand.remoteFileChanged" : SESSION_COMMAND_ERROR_KEYS[error.code], error.params));
+		const detailKey = error.code === "SESSION_COMMAND_FAILED" && error.debugDetails !== undefined ? REMOTE_WRITE_DETAIL_KEYS[error.debugDetails] : undefined;
+		super(t(detailKey ?? SESSION_COMMAND_ERROR_KEYS[error.code], error.params));
 		this.name = "SessionCommandFailure";
```

```diff
--- a/src/renderer/src/i18n/rendererCopy.zh-CN.ts
+++ b/src/renderer/src/i18n/rendererCopy.zh-CN.ts
@@
+	"sessionCommand.remoteWriteUnconfirmed": "远端会话写入结果未确认，改写可能已经生效。请重新加载会话核对；不会自动重试。",
 	"sessionCommand.remoteFileChanged": "远端会话文件已被其他程序修改，本次操作未覆盖这些修改。请重新加载会话后再操作。",
--- a/src/renderer/src/i18n/rendererCopy.en-US.ts
+++ b/src/renderer/src/i18n/rendererCopy.en-US.ts
@@
+	"sessionCommand.remoteWriteUnconfirmed": "The remote session write outcome is unconfirmed and the rewrite may already have applied. Reload the session to check; it will not be retried.",
 	"sessionCommand.remoteFileChanged": "The remote session file changed outside this operation. Those changes were not overwritten. Reload the session before trying again.",
```

建议的回归断言（`tests/remoteSessionWriteGuardUi.test.mjs`，与 `remoteFileChanged` 同一模式）：
`new SessionCommandFailure({ code: "SESSION_COMMAND_FAILED", debugDetails: "REMOTE_SESSION_HISTORY_WRITER_RESULT_UNCONFIRMED" }).message === "sessionCommand.remoteWriteUnconfirmed"`，
并扫描两份词典确认 key 存在且含「重新加载/Reload」。

### Residual risk

1. **主进程侧已稳定**，但**渲染层仍未应用**上述补丁：在补丁合入前，用户看到的仍是通用「会话操作失败，请重试」
   （debugDetails 会作为 toast 附注出现）。这是本批唯一的「已修一半」项，已明确写进给 Lead 的报告。
2. rename 后回执丢失时，远端同目录可能残留 `.pideck-tmp` 临时文件（本切片不自动删除远端文件；无未确认时的
   自动清理，避免在「可能已生效」语义上再发破坏性命令）。staging/bundle 侧由 F2 覆盖，会话目录内 tmp 属于后续
   24h artifact TTL sweep 的候选（plan §4.2，未实现）。

## F6 — 会话历史路径判据必须接收已规范化的绝对路径（review §(f)、findings 表）

### Before

`validateRemoteSessionHistoryPath` 只拒绝「不以 `/` 开头」与「以 `/` 结尾」，放行
`/home/u/.pi/agent/sessions/../../../etc/passwd`、重复分隔符、`.` 段（审查探针已复现）。文档一直称它是
canonical 判据；生产 catalog 写入侧另有拒绝，但「唯一路径权威」不应依赖上游每次都记得再查，未来新增写面或
本地 catalog 被篡改就是缺口。

### After

- `validateRemoteSessionHistoryPath` 在原有（长度/控制字节/单引号/绝对/非尾斜杠）之上，要求路径**已经规范化**：
  `value.slice(1).split("/")` 的每一段必须非空且不是 `.` / `..`（等价于拒绝重复分隔符、空段、点段）。
- 选择**拒绝**而不是本地 `path.posix.normalize`：命令里的路径必须与远端真实文件逐字一致；静默 normalize 会把
  两个不同字符串映射到同一远端路径（符号链接语义下甚至不是同一文件），也会掩盖调用方拼接错误。
- 判据仍是读取/写入/归档三点共用的唯一实现：构造期（`buildRemoteSessionWindowCommand` /
  `buildRemoteSessionHistoryChunkReadCommand` / temp path / archive target / write guard nodePath+remotePath）
  全部随之 fail closed，且**零远端命令**。
- 上游检查（`remoteRuntimePort`、`RemoteSessionScanner`）保持不动（defense in depth：判据不是唯一防线）。

### Files

| 文件 | 改动 |
| --- | --- |
| `src/main/remote/RemoteSessionHistoryReader.ts` | `validateRemoteSessionHistoryPath` 增加 canonical 段判据 + 文档说明 |
| `tests/remoteSessionHistoryRead.test.mjs` | 新增 canonical 拒绝/放行矩阵（含审查探针） |
| `tests/remoteSessionHistoryWrite.test.mjs` | 非规范 locator 在写面同样零命令拒绝 |

测试：

- 审查探针 `.../sessions/../../../etc/passwd`、`.../sessions/../x.jsonl` 被拒；
- `//`、`./`、`.`/`..` 段、尾斜杠、根、控制字节、单引号被拒；合法形状（隐藏目录、名字带点、深路径、`/a`）
  逐字保持；
- 读取命令构造、`joinRemoteSessionRoot`（绝对/带 `//` 的 root/相对段 `./`、`a/../b`）同判据拒绝；
- 写面：非规范 `remotePath` 在发任何远端命令前以 `..._WRITER_PATH_INVALID` 拒绝（`commands === []`）；
- 既有 archive / history 测试全绿（`remoteSessionArchive` 35 项一起跑）。

### Residual risk / deviations

1. 判据是**词法** canonical（不解析符号链接）：远端真实身份仍由写守卫（O_NOFOLLOW/identity）和各命令自己的
   检查保证——与审查「defense-in-depth」定位一致。
2. 行为收紧：若远端 `HOME` 报告成带尾斜杠/重复分隔符（非规范），由它推出的会话根现在会 fail closed 而非
   发出一个「多一个斜杠也能跑」的命令。真实 HOME 极少非规范；这是有意选择（宁可拒绝也不静默规范化）。
3. 真机未复跑（无主机）；Windows 上按 POSIX 跳过的写守卫语义已在 WSL 全绿。

## 4. 与审查 §7 needs-follow-up 的关系

本批只关闭 **F2/F4/F5/F6 的代码缺口**；审查 §7 中以下 follow-up **仍未完成**，需要在真机上复跑：

1. 重复连接多个 helper 版本 + 模拟崩溃/lock 残留：验证 F2 sweep 的真实行为、以及 >7 天多客户端并存的残留风险；
2. 真实 SSH config 含 `IdentityFile ~/.ssh/...` 的 host-add 全流程（F4）；
3. 真实 SSH 在 commit rename 后断开/超时的回执丢失（F5，需要可注入断线的真实链路）；
4. F1（medium）与 F3（terminal ticket）不在本批；F7–F10 状态不变；
5. full `npm test`、`npm run pack`、Windows/macOS→Linux 客户端 smoke 未运行（任务约束）。

## 5. 给 Lead 的偏差清单（必须知道）

1. **F5 只完成 main 侧**：renderer/i18n 补丁在 §F5 中给出但未应用（shared/renderer 由另一 lane 本轮拥有）。
   合入前用户仍看到通用「请重试」。
2. **F2 的多客户端注册/lease 未实现**：以 active+rollback+≤2/≤7d+1h 年龄门槛近似；1h 门槛是新增的并发保护，
   比 plan 的「≤2 份」略宽松（但在无注册面时更安全），已在常量与测试中显式记录。
3. **F4 按 review/plan 展开到本机 HOME**，与任务描述里的「remote account HOME」相反（语义依据见 §F4）。
4. **F6 收紧 HOME 派生根的合法性**（非规范 HOME 现在 fail closed）。
5. 全仓 `npm run typecheck` 在交付时刻因另一 lane 的在飞文件 `src/main/ipc/remoteProjectEntryIpc.ts` 报 9 个错误
   而红；本批 8 个生产文件用只含本批文件的 tsconfig 单独 `tsc --noEmit` 通过（见 §0）。
