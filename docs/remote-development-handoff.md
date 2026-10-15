# PiDeck SSH 远程开发 — 协作与交接

> 当前开发分支：`feat/remote-development`。代码核对基线：`f7b18947`（第一次协作交接点）；首次交接提交：`a663947c`。
>
> 下方早期批次保留历史时点，不把其中「尚未完成」直接当成现状。消息写面安全边界见本文末尾「权限与冲突加固」；最新已有远端文件编辑保存见「远端代码文件编辑保存」及 `remote-write-plan.md` §6。下一批 Git 的选型、完整能力分期与门禁见 [远端 Git 计划](remote-git-plan.md)；**G1 status/diff 与 G2a 单文件 stage/unstage 已完成 Linux 开发态真实 Electron＋SSH 验收**，最新证据见本文末尾「远端 Git G2a」。commit 与更广发布门禁仍未完成。
>
> ## 交接摘要（面向接手人，2026-10-11 收口）
>
> **现状一句话**：**Phase 3 的远端只读能力已在真实主机 + 真实 Electron 上端到端验收通过**——两次独立运行：run `e2emv3cw2x5`（13:01，1.8 分钟）与 run `e2emv3dr8xb`（13:26，1.9 分钟），均为 `1 passed`。测试覆盖九步：加主机 + pin 指纹命中 → 连接 ready → 登记两个远端项目 → 列出远端会话（含夹具）→ 惰性标题（权威名不标「暂定」、弱兜底标「暂定」）→ 导入（清单刷新 + 选中 + 「已导入」标记 + 不开新 Tab）→ 重复导入（`created=false`）→ 项目级 root 漂移（A 显示「需处理」带稳定码、同主机邻居 B 仍 ok 且仍能列目录）。真机侧已交叉验证（远端会话目录 mtime 同步更新、无夹具/项目残留）。
>
> **已完成（可验收）**：① 前六批实现（项目读取隔离 / 侧栏登记入口 / helper 只读搜索 / 会话建立与重连时的 root 复核 / IPC 按域拆分 / needs-attention 终态 / 远端会话发现与登记 / 按需标题 / 侧栏列表与导入 / 项目级 root 状态 / 集成）；② 第七批及其修复（pi 自定义 `sessionDir` 覆盖、头尾窗口零重叠、尾读降级上报、`readHostId` 传输边界收窄、长活会话 `lifetime` 分档、helper capability gate、跨 store 一致性**设计 + 红例**、Phase 4 **设计**）；③ **真机脚本平台修正**（此前只有 POSIX 客户端能跑，现在 Windows 客户端可跑，并修掉约 3% 的偶发连接失败）；④ 真机验收通过（上条）；⑤ **INV-5a 写侧一致性实施**（第八批：跨进程锁 + 锁内重读 CAS + 引用写入门 + 跨 store 删除补偿；含两处**判据不可满足**的如实修正）；⑥ **Phase 4 P4.0 + P4.1**（第九批：启动面抽取 + 远端 pi 探测/兼容矩阵 + 真机只读证据脚本，含 4 个遗留手写沙箱测试的迁移）。逐条证据见 §3 各批末尾。
>
> **未完成（建议优先级）**：
> 1. **Phase 4 P4.2 只剩两项**——协议层**已端到端验通**（真机 `scripts/verify-remote-runtime.mjs` → `RUNTIME_E2E_OK`）。已交付：`707ecb595` 冻结 runner + 远端启动器；`d919e5402` 真机验收脚本 + `remotePiRuntimeFacts`；`e9bcd19d0` `PiProcess` 远端模式；`61222cc76` `AgentManager` 路由 + 本机 fs 守卫 + catalog fail-closed；`68accdfd6` 远端会话的 catalog 身份；`b76b03dff` 远端会话**恢复（点开）**+ 恰好一条 catalog 记录；`448940ea6` **远端 trust 状态可见**（`AgentTab.remoteTrustUnhandled` + 会话视图内持续提示 + 双语 key；安全默认不变）。**剩下：** (i) **远端自动 reattach**（`reattachProcess` 目前是本地实现）；(ii) **Electron 真机 UI 验收**（这台 Linux 沙箱能跑 Electron，可直接做——这是 P4.2 进入 beta 的最后一关）。
>    **🎉 P4.2 UI 验收全绿（2026-10，确认跑）**：`npx playwright test e2e/remoteSessionAcceptance.spec.ts` ⇒
>    **2 passed (3.7m)**（真实 Electron + 真实主机；证据另存 `/tmp/p42-final/`，命令与凭据只从 env 取）。
>    两条测试覆盖：①产品路「新建会话 → 输入出正文 → 关闭 Agent → 关标签页重开 → 历史仍在 → **远端会话文件里确有 5 行**」；
>    ②「远端 trust 提示如实可见（常驻、非一次性 toast，发送前就在）」。至此 P4.2 的 UI 验收闭合。
>
>    **✅ 远端自动 reattach 已实现（2026-10）**：`reattachProcess` 现在对远端会话走同一套握手，三处远端语义已处理
>    ——① 重连前**用当前会话文件重新 prepare 计划**（create 那份没有 `--session`，复用会开出新会话；单元测试先抓到这条）；
>    ② 路径原样采用（不走本机归一化）；③ 不加载历史；无端口/无 hostId 抛 `REMOTE_RUNTIME_UNAVAILABLE`，绝不掉进本机 pi。
>    回归测试：`tests/agentManagerRemoteRuntime.test.mjs`「远端会话的自动重连（reattachProcess）」（断言第二次 plan 带
>    `--session` 且用 pi 报回的远端文件、路径未被归一化、`record.forbidden` 为空）。
>    **尚未覆盖**：真机演练「远端 pi 中途死掉 → 自动接回」这场景（spec 没做，避免在共享主机上 pkill 误杀）。
>    要做时的安全做法：从**该会话自己的远端 runtime** 拿 pid（不用 `pkill -f pi`），kill 后断言会话自动恢复且历史仍在。
>    ⇒ **P4.2 至此闭合**（协议/运行时/产品路/trust 可见/re-attach）；下一期是 P4.4（远端 trust 完整语义）。## 1. 当前能做什么

远端功能仍限定为开发构建且显式设置 `PIDECK_REMOTE_EXPERIMENTAL=1`。正式包不开放这些能力。

| 能力 | 实现与验证状态 |
| --- | --- |
| 主机添加、独立核验指纹、严格 pin、连接、诊断与修复 | 已接开发态 UI/IPC；Linux 客户端到 Linux 远端有实机证据，不能据此宣称所有平台验收完成 |
| Node 定位、helper 上传与 finalize、连接状态机、NDJSON 控制客户端 | 已接开发态应用链路；有离线测试与实机 `BOOTSTRAP_FINALIZED` 证据 |
| 确认目录后列目录、读文件、拒绝越界 | 设置页那套临时「浏览已确认 root」的入口连同 5 条 `remote:workspace-*` 通道已删除；只读构件（reader / root resolver / helper）与其测试保留 |
| **同主机两个项目之间的读取隔离** | 已实现：`RemoteHostConnectionService.withProjectSession` 用每主机 FIFO 锁把「切根 + 就绪判定 + **整次**列目录/分块读文件」收进同一个受控操作，并把交给操作的会话**绑定**到建立它的 manager。有先红后绿的复现测试，也有独立验证用例（见 §3 末） |
| SSH 项目持久化、登记确认、按 `projectId` 只读浏览 | 已实现：写入侧 / codec 读取 / 主机引用扫描收敛到同一 shared 判据；approve 时复核 canonical root 与主机可用性。定向测试与独立操作链测试通过；**尚无 Electron/真机验收**，Phase 3 未收口 |
| 跨 store rebind | journal、tx 锁、收敛算法及 store 端口已有实现；应用协调器与严格跨 store 写入互斥仍缺失 |
| 远端 pi RPC | 曾完成一次 `get_available_models` 成功往返；尚未接入应用的远端 Agent/Session 生命周期 |
| 远端项目**文件名搜索** | 已实现：冻结 helper 新增有界 `fs.searchNames`（build 1.6.0），经 `remote:project-search` → `withProjectSession` → `RemoteSearchReader` 只读上线；有真实子进程端到端与独立对抗用例。**尚无真机/Electron 验收**；不含内容搜索 |
| 远端 Session 扫描、写文件、Git、终端 | 尚未开放；不能回落到本地实现 |

**已接线的调用链**：`main/index.ts` → `RemoteHostConnectionService` → `bootstrapPinnedHost` → `RemoteBootstrapDeployment` → upload/finalize；连接 manager/attempt 消费 `RemoteControlClient`。修复也已有 IPC。项目只读读取走 `remote:project-list/read` → `withProjectSession` → `RemoteWorkspaceReader`。不要把这些模块当作“只有脚本会调用”的桩，也不要只凭 `index.ts` 有没有直接 import 判定可达性。

`HostRebindJournal.resume()` 内部已有收敛调用；欠缺的是应用层协调与恢复入口，不是重新实现 journal 算法。源码与长计划中部分“尚未装配”注释来自旧阶段，判断当前行为应追踪调用链。

## 2. 完成目标与顺序

| 里程碑 | 用户能完成的操作 | 完成判据 |
| --- | --- | --- |
| M1：远端项目可靠可用（Phase 3 收口） | 侧栏“+”添加远端目录，立即出现项目；多项目切换只读浏览；重启找回项目；断线/根漂移有明确反馈；只读搜索与 Session 发现 | 下方 A/B/C 集成验收通过，补齐搜索/扫描与 UI/实机测试；仍是开发态预览 |
| M2：远端编码实验版（Phase 4） | 在远端项目新建会话、发送、流式接收、停止、重启和恢复；随后完成计划中其余 Session 生命周期与配置能力 | 双会话事件隔离、断线不重复发送、历史由远端 pi 管理；完整 Phase 4 门禁通过后才称实验 beta |
| M3：Remote v1（Phase 5） | 远端文件修改、基础 Git 工作流和 SSH 终端，以及计划要求的跨平台体验 | 实施计划 §13 的“必须”项与 Phase 5 发布门禁全部通过，才开放稳定版 |

关键顺序：**先完成 A/B/C 的项目读取和持久化边界 → 补齐 Phase 3 搜索/扫描 → Phase 4 会话闭环 → Phase 5 写操作/Git/终端**。
Phase 4 的接口梳理与 mock 测试可以并行准备，接入依赖已验收的项目/root 与 Session 身份契约。多 root helper、传输替换、自带 Node 分发、端口转发等另行排期。

## 3. 第一批可分工的任务

A/B/C 可由不同开发者并行，D 随开发跟进。每块指定一个负责人；同一集成文件由一个人协调，避免多人同时改同一个大文件。这里分配的是职责，不额外引入审批流程。

> **状态（第一批已实施）**：A、B、C 均已完成，各自定向测试通过；D 的独立验证用例已就位并已就当前实现重跑。逐条落地位置、验证命令与遗留项见本节末尾「第一批落地结果与遗留项」。并行时用**互不重叠的写作用域**隔离：A 拥有 `src/main/ipc/remoteHostIpc.ts` 与 `src/main/remote/RemoteHostConnectionService.ts`，B 拥有渲染层与 `App.tsx`，C 拥有 `src/main/projects/**` 与引用扫描，契约文件（`shared/ipc.ts`、`preload`、`previewApi`、`main/index.ts`）由集成负责人单独收口。

| 任务包 | 主要修改范围 | 依赖与验收 |
| --- | --- | --- |
| **A：项目读取与确认边界** | `src/main/ipc/remoteHostIpc.ts`、`src/main/remote/RemoteHostConnectionService.ts` 及同域模块 | 保持已选定的单主机单 helper/root；把切根、ready 判定、整次列目录/分块读文件放进同一受控操作。B 可先复用现有 project IPC；A 统一维护 shared/preload/preview 契约与废弃通道清理 |
| **B：项目入口与 UI 状态** | `ProjectTree.tsx`、侧栏动作接口、远端项目登记对话框、`ConnectionsTab.tsx`、`RemoteProjectPanel.tsx`、i18n | 设置页只留设备管理；侧栏“+”进入远端登记，成功后刷新并选中新项目；异步旧结果不能覆盖新项目。`App.tsx` 只装配 |
| **C：持久化与主机引用一致性** | `ProjectStore.ts`、`projectStoreCodec.ts`、`RemoteHostReferenceSources.ts` 与定向测试 | 写入口与读 codec 使用一致校验；扫描与 store 恢复语义一致；异常数据不得被判成“无引用”。把严格跨进程 CAS/跨 store interlock 的未完成部分明确记录，不能用当前内存比较代替 |
| **D：集成与验证** | 对应 `tests/*.test.mjs`、必要的 renderer/Electron 验证、交接状态 | 先复现并发/断线/迟到结果等行为，再验证修复；A/B/C 合在一起验证完整操作链。对比失败名称与断言，不只比失败数量 |

### A：必须覆盖的行为

> 以下五条是**修复前**核对到的行为缺口；第一批已实现其中「读取隔离 / 就绪判定 / 显式断开语义 / approve 复核」，尚未实现的一条（读取时复核 canonical root）在「第一批落地结果」里显式标注为未完成。

- 当前 `rootSwitchByHost` **只串行 setRoot/connect**，`reader.list/readFile` 在队列外；A/B 两个项目仍可能互相切根。串行边界必须覆盖最后一块读取结束，并处理错误后队列继续工作。
- `getWorkspaceRoot()` 返回配置值，不能证明 live helper 已 ready。连接失败后或断线后读取同 root，要能正确恢复或明确返回不可用；不能因为字符串相同跳过连接状态检查。用户显式断开不能被后台读取悄悄撤销。
- 设置页旧 `remote:workspace-list/read` 仅用内存 root 放行，不重新对齐 helper。按 B 的已定方向删除这套临时浏览及旧 IPC；**删除它只解决旧入口问题，不解决项目之间的并发串根**。底层 `RemoteWorkspaceReader`、root resolver 和 helper 测试保留。
- 登记 offer 解析完路径后，approve 目前直接写库。确认时须复核主机状态及被确认路径；确认等待期间目录失效或 symlink 改指时拒绝写入，不能静默接受新目录。
- 持久项目重连时复核 canonical root；漂移/无法复核需拒绝读取并显示待处理状态。重连到同一路径字符串不等于重新验证了目录边界。

验收样例：同主机两个根下各放同名不同内容的文件，让 A/B/A 请求交错并跨多个读取分块；验证内容不会混用、失败可重试、断线不返回另一项目的数据。再覆盖不同主机可独立工作、根漂移与主机禁用发生在确认窗口内等路径。测试用可控替身，实机复核单独进行。

### B：已确定的产品行为

- 设置页仅管理主机添加、信任、连接/断开、诊断和修复；移除 `RemoteWorkspacePanel`。
- 侧栏“+”提供现有本地添加入口和“远端（SSH）”。保留当前本地/WSL 的真实选择行为，不包装成实际仍指向同一行为的假菜单项。
- 第一版远端登记：选已验证且未禁用的主机 → 输入路径 → 展示 canonical 路径确认 → 登记。无可用主机时引导设备设置。**这一版仍是路径输入，不宣称已有登记前远端目录树选择器**。
- 复用 `remote:project-enroll` / `remote:project-answer`；确认弹框只挂一处，按当前请求关联，卸载要退订。登记成功后显式刷新项目列表并选择返回的 `projectId`，不创建本地会话。
- `RemoteProjectPanel` 加请求代次或取消处理，忽略切项目后的迟到结果；处理 IPC reject，loading 必须结束，错误与空目录分别呈现。

验收操作：设置页加主机 → 侧栏加项目 → 立即显示并打开 → 切 A/B 项目 → 断线恢复 → 重启恢复；旧设置页不再能发文件浏览请求。

### C：已有代码不能替代的证明

- `addRemote()` 当前只检查非空，codec 对路径的检查更严格；scanner 要求 UUID hostId，codec 接受范围不同，写入/读取/引用扫描的有效值域需对齐。
- `scanPersistedProjects()` 对缺 locator 的记录直接跳过，未完整校验元数据和 remotePath；主文件/备份的扫描语义需与 store 选择有效 revision 的规则对照。
- `applyHostRebind()` 比较内存 locator 后排队保存，**不是跨进程 CAS**。缺记录结果、失败后恢复、批次校验及幂等行为仍需核验。
- 严格跨 store 锁与 rebind 协调器是独立交付项，必须在开放对应能力前完成；现有代码与测试不能被描述为事务安全已闭环。

### 第一批落地结果与遗留项（实施后核对）

| 任务包 | 落地位置 | 验证 |
| --- | --- | --- |
| A 读取与确认边界 | `src/main/remote/RemoteHostOperationLock.ts`（每主机 FIFO 锁）；`RemoteHostConnectionService.withProjectSession`（切根 + 就绪判定 + **整次**读取 + 会话绑定到当时的 manager）；`remoteHostIpc.ts` 的 `remote:project-list/read` 整次操作都在该边界内；approve 时重新探测并复核 canonical root 与主机可用性 | `tests/remoteProjectReadConcurrency.test.mjs`、`tests/remoteHostOperationLock.test.mjs`、`tests/remoteHostIpc.test.mjs`；独立验证 `tests/remoteProjectReadIsolation.test.mjs`（含「读取未结束时另一项目不得 settle」的锁边界断言）、`tests/remoteProjectReadChain.test.mjs` |
| B 入口与 UI 状态 | `components/sidebar/AddProjectMenu.tsx`、`RemoteProjectEnrollDialog.tsx`、`hooks/useRemoteProjectEnroll.ts`、`atoms/remote-project-atoms.ts`、`components/session/remoteRequestGate.ts`；`RemoteWorkspacePanel.tsx` 删除 | `tests/remoteProjectEnrollHook.test.mjs`、`tests/remoteProjectRequestState.test.mjs`、`tests/settingsTabLayout.test.mjs`、`tests/sessionSidebar.test.mjs` |
| C 持久化与引用一致性 | `src/shared/projectLocation.ts` 成为唯一判据：写入（`ProjectStore.addRemote`）、读取（`projectStoreCodec`）、引用扫描（`RemoteHostReferenceSources`）三处共用；缺 locator / 被拒 locator / 本地记录携带 hostId 一律让整源 incomplete 而非当作「无引用」 | `tests/projectStoreRemoteValidation.test.mjs` + 既有 codec / migration / referenceSources 测试；`tests/remoteHostCrossStoreContract.test.mjs` 的 hostId 审计范围已纳入 `shared/projectLocation.ts` |
| 契约收口（集成） | 删除 5 条 `remote:workspace-*` 通道及 `shared/ipc.ts` / `preload` / `previewApi` 三处入口；一并删除 `RemoteHostConnectionService.getWorkspaceRoot`（它只能回答「配置里的 root」，正是「字符串相同就当作会话可用」的来源） | `npm run typecheck`、`npm run check:format`、上述定向测试 |

**两条已自动验收的语义**：
- 同一主机上，一个项目的整次读取结束前，另一个项目的切根与读取不会开始；交给操作的会话**绑定**到建立它的 manager，manager 被替换时后续帧 fail-closed 返回 `SSH_HOST_NOT_READY`，不会静默换成另一个 root 的数据。
- 用户显式断开后，后台读取返回 `SSH_HOST_DISCONNECTED` 而不是偷偷重连；用户自己发起的 `remote:connect` 会替换被 latch 的 manager 并恢复读取。

**第一批未完成 / 未验收（不得描述为已完成）**：
1. **读取时复核 canonical root**：**已在第二批（F3）实现**——会话需要建立或重建时，在操作锁内用 `verifyRoot`（默认 `resolveRemoteBrowseRoot`）复核，漂移 `SSH_PROJECT_ROOT_CHANGED`、探测失败 `SSH_PROJECT_ROOT_UNRESOLVED`，两者都不建立会话、不发 helper 请求。**仍未做的是状态呈现**：漂移没有路由进连接状态机的终态 `needs-attention`（见第二批遗留项 2），且真机上的 pinned 探测未验收。
2. **严格跨进程 CAS 与跨 store interlock** 仍未交付（见 §3C 末条）；现有实现与测试不得被描述为事务安全已闭环。
3. **sessions 域同类不对称仍在**：`SessionCatalog.isSessionLocator` 接受任意非空 `hostId`，而引用扫描要求 UUID。归属 `src/main/sessions/**`，本批未改。
4. **真机 / Electron 验收未做**：添加主机整条链路（独立核验指纹 / pin / 真实 bootstrap 与 helper 上传）、真实 `resolveRemoteBrowseRoot` 探测、侧栏「+」→ 登记弹框的真实点击链、Dialog 交互与 Esc/遮罩关闭，全部未在真机或 Electron 内跑过。
5. **体量债**：`src/main/ipc/remoteHostIpc.ts` 仍有 ~727 行（仓库规则 >600 行须评估拆分），本批只做删减、未拆分。

### 第二批落地结果与遗留项（实施后核对）

本批把 Phase 3 剩余只读能力里的**文件名搜索**做完，并补上「会话建立/重连时复核 canonical root」。远端 Session 扫描**有意推迟到第三批**（理由见下）。

| 块 | 落地位置 | 验证 |
| --- | --- | --- |
| F1 冻结 helper 只读扩展 | `RemoteHelperContract.ts`（op `fs.searchNames`、`QUERY_INVALID`、上限常量 512/20000/12/128、capabilities）；`RemoteHelperEntry.ts`（build **1.6.0**，sha `66b041d2…c538f`） | `tests/remoteHelperSearchNames.test.mjs`、`tests/remoteWorkspaceEndToEnd.test.mjs`（真实子进程 + 真实 `--root`）、`tests/remoteHelperEntry.test.mjs`；独立验证 `tests/remoteSearchIsolation.test.mjs` |
| F2 搜索链路 | `src/main/remote/RemoteSearchReader.ts`（严格逐字段校验并重建、稳定码、远端文本不外传）；`remote:project-search` handler；渲染层 `useRemoteProjectSearch` + 面板搜索入口（迟到结果作废、截断如实提示） | `tests/remoteSearchReader.test.mjs`、`tests/remoteProjectSearchState.test.mjs`、`tests/remoteHostIpc.test.mjs`（通道三处同步 + 边界校验 + 门禁） |
| F3 会话建立/重连时复核 root | `RemoteHostConnectionService`：新增 `verifyRoot` 端口（默认接 `resolveRemoteBrowseRoot`），只在会话需要建立或重建时、于操作锁内复核 | `tests/remoteProjectReadConcurrency.test.mjs`（先红后绿）、`tests/remoteHostConnectionService.test.mjs`；独立验证 `tests/remoteProjectRootReverify.test.mjs` |

**已自动验收**：文件名搜索的 16 例逃逸与 8 例非法 query/params 全拒且零帧；匹配/已扫描/深度/单目录 dirent 四项上限与 `truncated` 语义；symlink 恒 `other` 且从不跟随；queued 与 in-flight cancel 各恰好一帧 `REQUEST_CANCELLED` 且无部分结果；reader 对 25 类畸形结果的 `PROTOCOL_INVALID`；`truncated` 如实透传（0 匹配 + 截断不被折叠）；渲染层迟到结果作废；root 复核先于建会话、锁内执行、漂移零 helper 请求；在真实 helper 子进程上把 root 改指到 root 外或删除 root 后 `fs.list`/`fs.searchNames`/`fs.read` 全部被拒且零泄漏；helper 源码 sha 与导出常量、manifest、上传计划自洽（陈旧 sha 会被 `BUNDLE_MANIFEST_INVALID` fail-closed）。

**两处必须写清的取舍**：
1. **搜索的 I/O 取舍（已裁决，不是缺陷）**：要让截断结果是**按 name 序的可复现前缀**，helper 必须先把当前目录的名字读完再按序访问。因此「匹配上限触顶」保证的是 **stop-visiting**（不再开新目录、不再访问新条目、不深入子树），**不是 stop-reading**；单次调用 dirent 读取硬上限 20001，最坏相对理想路径 ≤39 倍放大。想改成 stop-reading 就必须先放弃名序可复现性——那是契约改写，别在下游把它当 bug 修。
2. **helper 的 `node -e <source>` 启动形态不再有测试覆盖**：helper body 增长后，其 `-e` 命令行超过 Windows CreateProcess 上限（32767）。**生产不受影响**：生产只用 `-e` 启 bootstrap entry（`RemoteBootstrapContract` 的载荷 14689 字节，仍在限内），helper 本体是**写文件后按文件路径启动**的（`RemoteBootstrapDeployment` 写盘 → manager 用部署路径 spawn）。测试里保留反向 tripwire 记录这次覆盖是刻意移除的。

**第二批未完成 / 未验收**：
1. **远端 Session 扫描仍完全未做**（`session.list`/`session.readPage`、catalog 远端 locator 与稳定 id 匹配、两层标题获取）。推迟理由：`session.list` 必须先定清「远端 session 根」是什么——那是远端 pi 的会话目录布局，属 Phase 4 的 runtime 探测面；现在定会把 op 定义在半空中，且 helper 版本要为它再 bump 一次。**第三批第一步**。
2. **root 漂移未接入 `needs-attention` 的状态呈现**：本批落地的是「复核 + 拒绝读取」（fail-closed），漂移以稳定码呈现。Phase 3 门禁里「重连时 root 复核失败进入 `needs-attention`」的**状态那一半仍未接线**：`needs-attention` 由 `SshConnectionManager` 拥有且只有 attempt 失败能进入，新增该路由需要管理器/服务新接口，本批未做。
3. **真机与 Electron 全未验收**：`verifyRoot` 的 pinned 探测、搜索、侧栏与面板的真实点击链都只在假 ports + 真实子进程 helper 上验过；POSIX symlink 语义用 Windows junction 代替。
4. **严格跨进程 CAS / 跨 store interlock** 仍未交付（同第一批遗留项 2）。
5. **`src/main/ipc/remoteHostIpc.ts` 体量债未清**：本批又给它加了一个 handler（现约 800 行，>600 规则）。拆分方案已明确——把「项目登记 + 项目读取 + 搜索」拆到 `src/main/ipc/remoteProjectIpc.ts`，hosts（添加/指纹/连接/诊断/修复）留在原文件，`main/index.ts` 多注册一个域。**建议第三批随 Session 通道一起做**（那次必然新增 IPC 文件，正好一次拆到位）；单独拆一个刚被验证过的文件收益低、风险高。

### 第三批落地结果与遗留项（实施后核对）

| 块 | 落地位置 | 验证 |
| --- | --- | --- |
| G1 IPC 按域拆分 | `remoteHostIpc.ts` 767→522 行（只留 hosts 域）、新增 `remoteProjectIpc.ts`（303 行，登记/回答/列表/读取/搜索）、新增 `remoteSessionIpc.ts`；`main/index.ts` 分域装配 | `tests/remoteProjectIpc.test.mjs`（两域通道互不越界、体量红线、装配两处注册）、`tests/remoteHostIpc.test.mjs` |
| G2 root 漂移进 needs-attention + 握手 home | reducer 放开 `disconnected/offline` 来源（注释写明「外部已核验的致命条件与 attempt 失败同等可行动」，其余语义不变）；`SshConnectionManager.reportNeedsAttention(hostId, code)`（自由文本折叠成稳定码）；**修掉真缺口**：`connectLocked` 在终态改走 `manager.retry()`（否则 `remote:connect` 出不来终态）；`RemoteHostConnectionService.remoteHome(hostId)` 只在 ready/degraded 给值 | `tests/remoteHostConnectionState.test.mjs`、`tests/sshConnectionManager.test.mjs`、`tests/remoteHostConnectionService.test.mjs`；独立验证 `tests/remoteNeedsAttention.test.mjs`（19 项，含终态性穷举） |
| G3 远端 Session 只读发现与登记 | `RemoteWorkspaceReader.readHead`（64 KiB 上限原语，拒绝不 clamp、绝不整文件读）；`RemoteSessionScanner`（会话根 = `<remote home>/.pi/agent/sessions`，只走现有 `fs.list`/`fs.stat`，不 import node:fs，上限 512 目录 / 2000 文件 / 1 MiB 预算 / 并发 4）；`SessionCatalog.ensureRemoteSession`（ssh locator、两遍匹配、幂等） | `tests/remoteSessionScanner.test.mjs`、`tests/remoteSessionRegistration.test.mjs`；独立验证 `tests/remoteSessionScanIsolation.test.mjs`（17 项） |
| G5 集成 | 两个通道常量 + preload `remoteSessions` + previewApi 桩 + 装配注入（含 `projectIdForHost`）+ 共享返回类型收口到 `shared/types/remoteHost.ts` | `tests/remoteSessionWiring.test.mjs`（三处同步 + 类型不重复定义守卫） |

**已自动验收**：needs-attention 从六种来源进入后**只有 user-retry 能离开**、其余事件返回同一 state 对象、恶意 code 折叠且不进诊断、fencing 与 shutdown latch 未被绕过；`remoteHome` 三态与畸形值不外传；`readHead` 对 10 MiB 文件只请求 64 KiB、空文件零 read 帧；扫描四项上限各自在**对应 I/O 之前**截停、symlink 目录绝不下钻、零 `fs.read` 帧、结果无正文；真实 SessionCatalog 上登记**幂等**（两次同 id、第二次不写盘）、两遍匹配顺序锁定。

**第三批未完成 / 未验收（不得描述为已完成）**：
1. **root 漂移 → needs-attention 这条接线在生产不可达（已接受为防御性代码）**：漂移发生时 manager 要么不存在、要么已被 discard；`manager` 从不发 `offline`，`disconnected` 只由 `service.disconnect(abort)` 产生且顺带置 `explicitlyDisconnected`（读取在 establish 之前就返回 `SSH_HOST_DISCONNECTED`）。因此**漂移只做到按项目 fail-closed（拒绝读取 + 稳定码），不驱动 needs-attention**；当前**可达**的 needs-attention 触发是重连时 helper 握手 `SSH_HELPER_ROOT_MISMATCH`（FATAL，`tests/sshConnectionManager.test.mjs` 端到端覆盖），且已修好「终态出不来」。下一批两种可选设计（当时明确未实现）：(i) 项目级「root needs attention」标志经 hosts-list/诊断呈现、不动连接状态机；(ii) 复核顺序改为「先验新 root、再丢旧会话」并把 needs-attention 语义收窄到 host 级。
2. **侧栏列表/导入 UI 未做**：本批只到 main 进程的发现与登记，通道已按契约收口但渲染层无入口（**第四批**）。
3. **标题是文件名 stem 且 `titleOrigin="fallback"`**：按需头部解析未做，本批只落地 `readHead` 原语。
4. **覆盖缺口**：pi 自定义 `sessionDir` 不覆盖（远端只扫 `~/.pi/agent/sessions`；**第六批已覆盖 user-level 设置，边界见第六批章节**）；深层嵌套 subagent 布局（`<stem>/<run>/session.jsonl`）不扫（冻结设计只要求两层）；`remotePathAliases` 未读写（命中历史记录时其 `remotePath` 会被本次相对路径改写，alias/冲突事务属 Phase 4）。
5. **性能代价**：`fs.list` 不返回 mtime ⇒ 每个候选文件一次 `fs.stat`（≤2000 次、并发 ≤4）；正解是 helper 侧加 `session.list`，而不是在扫描器里编造 mtime。
6. **真机/Electron 未验收**；POSIX symlink 语义用 Windows fixture 模拟，Linux 上未跑。
7. **严格跨进程 CAS / 跨 store interlock** 仍未交付（同前两批）。

### 第四批落地结果与遗留项（实施后核对）

| 块 | 落地位置 | 验证 |
| --- | --- | --- |
| H1 按需会话标题 | 新通道 `remote:remote-session-title`（只读、**不写 catalog**）：有界头读 64 KiB → 复用本地既有解析管线（仅抽出「接受文本的纯函数」这一种最小重构），解析不出强制 fallback=文件名 stem 且 `titleOrigin="fallback"`（**绝不编造**） | `tests/remoteSessionTitle.test.mjs`；独立验证 `tests/remoteSessionTitleIsolation.test.mjs`（18 项） |
| H2 侧栏远端会话列表与导入 | `RemoteSessionsSection`（SessionTree 下方，已导入的仍走本地树）+ 纯状态机（列表/标题）+ hooks + Jotai atom；惰性标题（只有 `titleOrigin="parsed"` 显示真名，fallback/未接线标「暂定」）、三态分离、上限按**整体拒绝**呈现（与第二批 `truncated` 区分）、`created=false` 独立回执、回显不一致判读不懂；成功后刷新清单 + 选中，不建会话不开 Tab；`RemoteProjectStatusTag` 显示项目级「需处理」 | `tests/remoteSessionsUiState.test.mjs`（17 项）+ 渲染分支源码级守卫 |
| H3 项目级 root 状态（设计 (i)） | 服务按 `(hostId, root)` 记最近一次复核失败码、复核成功只清自己的键；`remote:project-root-status`（只读、零 helper 请求、零 bootstrap、零会话建立）；**收敛**：漂移不再调 `reportNeedsAttention`（否则 A 漂移会阻断同主机 B）；**防永久误报**：该键有记录时即使会话已 ready 也强制再复核一次 | `tests/remoteProjectRootStatus.test.mjs`（6 项）；独立验证 `tests/remoteProjectRootStatusIsolation.test.mjs`（7 项） |
| H5 集成 | `title` / `root-status` 的 shared 常量+类型+preload+previewApi+装配注入；PROJECT_CHANNELS 守卫清单补齐 | `tests/remoteSessionWiring.test.mjs`（9 项）、`tests/remoteProjectIpc.test.mjs` |

**已自动验收（要点）**：**设计 (i) 未被证伪**——同主机 A 的 root 改指后，读 A 被拒（`SSH_PROJECT_ROOT_CHANGED`）、**读 B 仍成功**、`status(A)=needs-attention` 带码而 **`status(B)=ok` 且无码**，且 B 的成功复核不清除 A 的记录；连续查询 5 次，进程/bootstrap/探测/状态推送计数全不变（只读无副作用）。标题：10 MiB 会话只请求 65536 字节、无第二次读；catalog 写入计数 0；空头/畸形/时间戳名/Untitled 一律 fallback 且断言不编造。列表：迟到 scan 作废且状态**引用不变**、`created=false` 独立透传、回显不符即 rejected（防选错会话）。

**第四批未完成 / 未验收**：
1. **真机与 Electron 未验收**：需要一台**已授权**测试主机（IPv4 + 用户名 + 独立核验的 ED25519 指纹）才能跑 `scripts/verify-remote-host.mjs` / `verify-remote-connection-service.mjs`（注意：第二批已把 helper 升到 1.6.0 并换了 sha，**真机脚本需重跑一次**以确认新 bundle 仍能 bootstrap）。第四批的会话列表/标题与项目级 root 状态**没有真机脚本**，需要在 Electron + `PIDECK_REMOTE_EXPERIMENTAL=1` 下按操作链手动走。没有凭据时一律记「未验收」，不得用替身结果冒充。
2. **`reportNeedsAttention` 当前无生产调用方**：能力与 reducer 放开 `disconnected/offline` 两件事保留（有测试、语义通用），但漂移不再驱动它（设计 (i) 的直接后果）；当前可达的主机级 needs-attention 触发是重连时 helper 握手 `SSH_HELPER_ROOT_MISMATCH`。
3. **导入只保证「刷新清单 + 选中」**：远端会话**正文读取**属 Phase 4；选中后正文不可读是主进程既有显式拒绝，不是静默失败。
4. **「已导入」标记依赖该项目 catalog 已有记录**：远端项目不做本地扫描预热，首次展开时标记可能为空（导入后刷新会补上）。
5. **`ProjectTree.tsx` 414 行**（目标 ≤400、硬限 600）：本批只增接线；建议后续把远端展开体抽成插槽组件，避免与侧栏其他改动打架。
6. **覆盖缺口仍在**：pi 自定义 `sessionDir`（**第六批已覆盖 user-level 设置；env 与 project 作用域边界见第六批**）、深层嵌套 subagent 布局、`remotePathAliases`、严格跨进程 CAS / 跨 store INV-5。
7. **64 KiB 头窗口覆盖不到文件尾的权威名**（H1 实现时如实记录）：pi 的权威 `session_info`（`/name`）是**追加在文件尾**的，落在 64 KiB 头窗口之外，所以那类会话会得到 `parsed` 的**弱兜底**（首条 user 文本，与本地管线对无名字行会话的行为一致）或 `fallback`（文件名 stem）。**这是冻结契约（头读 ≤64 KiB）的设计后果，不是缺陷**；要提升覆盖率需要显式修订契约（尾窗口或更大上界），建议作为下一增量单独提出。
8. **`parsed` 的两种强度需要区分看待**：`titleOrigin="parsed"` 现在同时覆盖「权威名（`session_info` / 旧版私有 `sessionName` 字段）」与「弱兜底（首条 user/assistant 文本）」。理由是不复用下半条本地管线就等于只复用半个；若后续要区分，需要给契约加第三档而不是改这两档的含义。

### 第五批落地结果与遗留项（实施后核对）

| 块 | 落地位置 | 验证 |
| --- | --- | --- |
| I1 标题覆盖率修订（尾窗口 + 三档） | `RemoteWorkspaceReader` 新增有界 `readWindow(hostId, path, { offset, maxBytes })`（超 64 KiB **拒绝不 clamp**）；标题改两段式：头内有权威名 → **零尾读**，否则读一次有界尾窗口（≤64 KiB）；`titleOrigin` 由两档升为**三档 `authoritative \| inferred \| fallback`**（authoritative=权威名；inferred=首条 user/assistant 弱兜底；fallback=stem） | `tests/remoteSessionTitle.test.mjs`、`tests/remoteSessionsUiState.test.mjs`（18，含把已废止的 `parsed` 固化为拒绝断言）；独立验证 `tests/remoteSessionWindowIsolation.test.mjs`（19） |
| I2 sessions 域 hostId 判据收敛 | `shared/projectLocation.ts` 新增唯一判据 `readSshSessionLocator`；`SessionCatalog.isSessionLocator` 委托它、**local 分支新增拒绝携带 hostId**；引用扫描删掉自带正则，只经共享判据 | `tests/sessionLocatorHostId.test.mjs`（8）；独立验证 `tests/sessionLocatorHostIdIsolation.test.mjs`（5） |

**已自动验收要点**：`readWindow` 给了 size 就 **0 次 stat**、不给恰 1 次；offset 超 EOF → 空窗口且**零读帧**；10 MiB 文件尾部才放权威名 → `authoritative` 且**恰 2 次读**（各 ≤64 KiB、求和 ≤128 KiB、复用头那次 stat）；头部已覆盖整个文件时**不重复读成自己的尾**；**尾读失败降级为头部结果**（不把标题整体判失败）；非 UUID hostId 在 shared 判据 / catalog / 引用扫描**三处一致拒绝**；候选记录 fail-closed（catalog 条目为空 + 写入抛 `SESSION_CATALOG_NEEDS_REPAIR` + 扫描 `complete=false`，**绝不判成「无引用」**）；合法旧数据（含只带 hostId 的早期记录、带 aliases、local locator、stale 镜像字段）**零误拒**且 scan **不改写文件**。

**真机验收（2026-02，首次从 Windows 客户端通过）**：
- **独立核验成立**：服务器控制台自述 `SHA256:a/qeVMKmlbe47KuxZlAzT2rcUTwtHPNNPqnS5uij/DM` 与本机原记录逐字节一致（未采用 TOFU；不一致就停下不连）。
- `verify-remote-host.mjs --bootstrap` **通过**：`PINNED_PROFILE_OK`；node 经**登录 shell** 解析出 nvm `v24.11.0`（非交互 shell 的 v12.22.9 被正确绕过）；`BOOTSTRAP_FINALIZED 5a46222d…` —— **helper 1.6.0 的新 bundle + sha 在真实主机上成功上传并激活**（第二批换版后必须重跑的一步，现已完成）。
- `verify-remote-connection-service.mjs` **通过**：`state=ready`、`attempts=0`（**首次即成**，未进重试阶梯）、诊断链完整 `SSH_CONNECTION_ATTEMPT_STARTED → PREFLIGHT → PHASE_AUTHENTICATE → PHASE_HELPER → SSH_HELPER_HANDSHAKE_OK → SSH_CONNECTION_READY`；`SERVICE_RECONNECT` 复用已持有会话。
- **顺带修掉真机脚本的 3 处平台缺口**（此前只有 POSIX 客户端能跑）：① 硬编码 `sshPath: "/usr/bin/ssh"`（Windows 上直接抛 `SSH_CLIENT_SCRIPT_SHIM`）；② 硬编码 `/usr/bin/ssh-keyscan`；③ Windows 的 `ssh-keyscan` 对该主机 KEX 协商失败（实测 `choose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com`，服务端 Ubuntu OpenSSH_8.9p1）→ 增加候选回退。**安全性不受影响**：keyscan 只提供**候选**，指纹由用户从服务器控制台独立核验，脚本随后断言观测值与之逐字节一致，对不上即 fail-closed。

**第五批未完成 / 未验收**：
1. **第四批的功能级真机/Electron 验收仍未做**：远端会话列表/标题、项目级 root 状态只有替身级与源码级断言；需要在 Electron + `PIDECK_REMOTE_EXPERIMENTAL=1` 下按操作链手动走（checklist 待补）。
2. **smoke 脚本仍用 `ssh-keyscan` 取候选**：产品设计明确「不得用裸 `ssh-keyscan` 替代」，应改为直接用产品的已认证握手路径（`verifyDraftSshHost` / `querySshDraftRoute`）；本轮只做了平台修正，未动验证工具本身。
3. I1 的 **append 竞争**场景未在真机验证（按冻结语义不校验 eof、以字节数逐字相等兜底）。
4. `SessionCatalog.load()` **不抛异常**：非法记录让**整份快照被拒**（entries 清空、needsRepair），只有写入路径才抛 `SESSION_CATALOG_NEEDS_REPAIR`——这是既有语义，已被测试锁定。
5. 严格跨进程 CAS / 跨 store INV-5 仍未交付。
6. 传输边界 `RemoteSessionScanner.readHostId` 仍是宽松判据（持久化边界已 fail-closed，端到端安全）。
7. **头窗口与尾窗口在 `64 KiB < size < 128 KiB` 时会重叠**：尾窗按冻结算法取「最后 ≤64 KiB」（`offset = max(0, size - maxBytes)`），因此该区间内两窗有重叠（请求总量仍 ≤128 KiB、每段 ≤64 KiB、不读中间段）。要「零重叠」只需把 `offset` 改为 `max(headBytes, size - maxBytes)`（对 10 MiB 这类大文件结果不变）——是纯 I/O 优化、不影响正确性或安全性，**本批按冻结算法实现，未擅自修订契约**。
8. **尾读失败是静默降级**（best-effort，与本地 `readHeadAndInfer` 同口径）：降级结果仍是诚实的 `inferred`/`fallback`，绝不编造；但若要「尾读失败也上报」，需要给 title 结果加一个「已降级」标记（契约修订），本批不做。
9. **测试对机器负载敏感**：`sessionScannerSubagents` 的「aborts a hung WSL scan」在多 agent 并发抢 CPU 时可能被 `--test-timeout` 掐掉（单文件跑 102 ms 即绿，`--test-concurrency=1` 全绿）；这是负载/并发度问题，与代码路径无关——集成跑红了**先看这条**再判回归。

### 第六批落地结果与遗留项（实施后核对）

| 块 | 落地位置 | 验证 |
| --- | --- | --- |
| J2 pi 自定义 `sessionDir` 覆盖 | `RemoteSessionScanner.resolveSessionRoot`：默认 `<home>/.pi/agent/sessions`；每次 scan/title/register 先做一次**有界配置探测**（root=`<home>/.pi/agent`，`fs.stat`+`fs.read` 读 `settings.json` ≤64 KiB，**不新增 helper op**）。`sessionDir` 合法（展开 `~`、`.`/`..` 规范化、规范化后必须仍在 home 内）⇒ 用它当会话根（自定义目录是**平铺** `*.jsonl`、无 cwd 编码；默认根才有 encoded-cwd 子目录——两种布局走同一条「根级 + 一层子目录」扫描路径）；值不可用 ⇒ 稳定码 `REMOTE_SESSION_SESSION_DIR_INVALID`；配置缺失/读不到/畸形 JSON/超上限截断/是目录 ⇒ 退回默认根（与今天逐字一致）。`remoteSessionId` 仍相对会话根 ⇒ catalog 身份语义不变 | `tests/remoteSessionRootResolution.test.mjs`（10，先红后绿）；独立验证 `tests/remoteSessionRootIsolation.test.mjs`（13） |
| J1 Electron 功能级真机验收 | 新 `e2e/remoteHostAcceptance.spec.ts`（270 行）+ `e2e/remote-fixtures.ts`：**环境门控**（缺任一凭据整体 skip，Playwright 在 fixture setup 之前就拦下 ⇒ **不启动 Electron**）；隔离 userData 但**刻意不隔离 HOME/USERPROFILE**（产品要用真实 `~/.ssh` 私钥）；主机与指纹只来自环境变量、不进仓库。流程覆盖：加主机 pin → ready → 登记两个远端项目 → 远端会话列表 → 惰性标题（「暂定」只在非 `authoritative` 出现）→ 导入（刷新 + 选中 + 不新建会话不开 Tab）→ 重复导入（`created=false` 区分回执）→ 项目级 root 漂移（A 显示「需处理」，**同主机 B 仍可读且状态仍 ok**） | `tests/remoteAcceptanceSpecGuard.test.mjs`（7 pass / 1 需凭据 skip）；Lead 独立复核：`--list`=1 test、无凭据 `1 skipped` exit 0、并用**进程路径**证明未起 Electron（当时 6 个 electron 进程全属用户自己在跑的 `F:\PiDeck`） |
| K2 收尾三项 | ① `readHostId` 传输边界收敛到 shared `PROJECT_HOST_ID_PATTERN`（稳定码仍 `REMOTE_SESSION_HOST_ID_INVALID`）；② 标题尾窗改 `offset = max(head.bytes, size - 64 KiB)` **消除头尾重叠**（`RemoteWorkspaceReader` 原语 **0 改动**——零重叠属调用方的 offset 选择，不是原语职责）；③ title 结果新增**可选** `tailDegraded`（只在真降级时出现，旧读取方忽略无碍），一路到侧栏**可见提示**且与「暂定」严格区分 | `tests/remoteHostIdTransportBoundary.test.mjs`（3，**先红 2/3**：非 UUID 原本真能穿过传输边界并发出 `remoteHome` + `withProjectSession`）；零重叠用例（fixture `size=98974`，旧算法重叠 33438 字节）；`remoteSessionsUiState`（20）+ `remoteSessionTitle`（12），含**变异验证**（换文案 / 删 en key 各自转红，还原后 32/32） |
| K1 跨 store 一致性设计 | 新 `docs/remote-cross-store-consistency-plan.md`（299 行，状态行「设计待评审、未实施」，**无 src 改动**）：§1 今天真实成立的保证 46 条**全部带测试名** + 10 条「今天不成立」；§2 INV-5 拆 5a/5b/5c 并覆盖 7 个操作边界；§3 四个候选方案各自写清「能防住哪种具名交错、代价、**以及防不住什么**」；§4 九条「不做」；§5 对照表；§6 合并门禁（4 个新测试 + 5 条必须先在旧代码上红的反例）；§7 六个待拍板问题 | 脚本核对文档引用的 **102 条测试名无漂移**；8 个跨 store 套件 81/79 pass（2 条 symlink 在 Windows skip）；typecheck 0 |

**pi 证据（本机全局 `@earendil-works/pi-coding-agent@1.0.4`，已由独立验证逐条复核）**：`dist/config.js:491-497`（`getAgentDir() = $PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")`）、`:511-513`（`getSettingsPath()`）、`:527-528`（`getSessionsDir() = join(getAgentDir(), "sessions")`）；`dist/core/settings-manager.js:499-502`（`getSessionDir() = normalizePath(settings.sessionDir)`）；`dist/core/session-manager.js:290-295`（默认 `join(agentDir, "sessions", "--<encoded-cwd>--")`）、`:713`（自定义目录下 `join(sessionDir, <ts>_<id>.jsonl)`）；`docs/sessions.md:50`（默认 `~/.pi/agent/sessions/` 按 cwd 分组）；`docs/settings.md:64`（相对路径按**会话 cwd** 解析，`PI_CODING_AGENT_SESSION_DIR` / `--session-dir` 覆盖它）；`CHANGELOG:5217`（自定义目录直接当会话目录用、**无 cwd 编码**）；`CHANGELOG:2344`（settings 里的 `sessionDir` 会展开 `~`）。⇒ **未配置时等于 `<home>/.pi/agent/sessions`**，与 G3 硬编根逐字一致。

**为什么相对路径 `sessionDir` 也拒绝（而不是退回默认根）**：pi 的相对路径按**会话自己的 cwd** 解析，单一扫描根在原理上不可能正确；退回默认根会返回**看起来正常但是错的**列表（配了 `sessionDir` 的机器上，自定义目录里的会话会全部消失）——这正是「发现不了比报错更糟」的直接应用。稳定码经 `scan` 的 `{ok:false,code}` 到侧栏错误态（H2 三态），不退化成空列表：`tests/remoteSessionRootResolution.test.mjs` 断言 IPC → `readScanResponse` → 侧栏文案这条链，`tests/remoteSessionScanIsolation.test.mjs` 另锁「上限/码不被吞」。

**K1 的三条核对结论（第六批新增，值得单独记住）**：① 既有基线文档 `docs/remote-host-cross-store-design.md` 说「session catalog 没有写入者」**已经过期**——现在有生产写入者（`RemoteSessionScanner.register`、`ProjectStore.addRemote`），且两者都**没有磁盘 CAS / 互锁**；② INV-1 在生产是**潜伏成立**：全仓库没有任何生产调用者会 retire/disable/updateDraft 主机、没有 `HostRebindCoordinator`、`HostRebindJournal.resume` 没有生产调用者 ⇒ 今天没有悬空引用**不是机制保证，而是退役路径不可达**；③ 唯一具备**跨进程锁 + 磁盘 CAS** 的实体只有 `remote-hosts.json`（`projects.json` 是内存 revision+1，`session-catalog.json` **连 revision 字段都没有**）。

**`tailDegraded` 的强度边界（如实）**：「何时渲染」由**纯判据（`isTitleTailDegraded`）+ 源码三元守卫**两层锁定，**不是真渲染快照**（仓库无 React DOM 装置、`RemoteSessionRow` 未导出；owner 拒绝为测试改动组件公开面）。要做真渲染快照需先导出该行组件或引入渲染装置。

**J1 的沙箱边界（决定谁来执行）**：本执行沙箱**无法启动 Electron**——Playwright 需经**管道**从子进程取 CDP 端点，而沙箱内程序不能开命名管道；证据是仓库既有 `e2e/smoke.spec.ts` 以**完全相同的方式**失败，而 `node_modules/electron/dist/electron.exe --version` 直接运行正常。⇒ J1 的真机流程与「错指纹真红」两条**必须由用户在宿主终端执行**。
**第六批未完成 / 未验收**：
1. **远端进程环境不覆盖**：`PI_CODING_AGENT_DIR`（整体挪走 agent 目录）与 `PI_CODING_AGENT_SESSION_DIR`（直接指定会话目录）都是**远端进程环境**——helper 1.6.0 已冻结且没有读 env 的操作，扫描期无法观测。
2. **project 级 `.pi/settings.json` 不覆盖**：project 作用域是 cwd 相关的（pi 加载顺序在 user 之后），读会话内容前不知道它自己的 cwd。
3. **每操作 +1 次配置探测**：一次 scan/title/register = 1 次探测会话建立 + 1 次 `fs.stat` + 1 次 ≤64 KiB `fs.read`，再叠加本来那次会话操作；探测 root（`<home>/.pi/agent`）与会话 root 不同时，服务的 helper 会话会随之切换（现有服务语义）。若成为瓶颈，正解是**短 TTL 的按 host 缓存**（本批不做：缓存会让「改了配置看不到新会话」多一个一致性窗口）。
4. ~~**J1 真机执行未做**~~ —— **已在第七批完成并通过**：宿主终端跑 `%TEMP%\pideck-acceptance.ps1`（内含三个凭据）→ `✓ 1 passed (1.8m)`、`RESULT: passed | failedTests=0`，run `e2emv3cw2x5`（13:01:41 起）。真机侧交叉验证：远端 `~/.pi/agent/sessions` mtime 更新到 13:03:22、无夹具/项目目录残留 ⇒ 是真实运行且清理干净，不是 skip。**后续批次仍不得用替身证据冒充端到端结论。**
5. **选择器只有源码级证据**：仓库无 DOM 基建，`aria-label` / `.project-group` / `data-remote-session-id` / `.session-row.active` 等未在真实 Electron 里命中过。首次真机跑很可能在某个选择器上失败，属**正常首次调试**；修法是改选择器或夹具，**不放宽断言**。
6. **K1 §7 两条产品决策待拍板**：5a 是否收窄到「只保证写入侧不产生新悬空引用」；多版本并行写入同一 userData 是否允许（决定要不要真正跨进程锁，而不只是写前复查）。未拍板前 INV-5 保持「设计待评审、未实施」。
7. `remoteSessionIpc.ts:19` 与 `remoteHostIpc` 各有一份**字面** UUID 正则（取值相同、行为一致），未收敛到同一 import。
8. **POSIX symlink 语义未验**（本机 Windows）：J2 对越出 home 的路径做的是词法 + 规范化拒绝，真机 symlink 逃逸未验。

### 第七批：真机功能级验收（Electron + 真实主机，进行中）

用 Playwright + 真实 Electron 对已核验主机（`10.81.2.15` / `zhadainian`，指纹独立核验）跑完整链路。真实运行暴露了产品缺陷，也暴露了测试选择器、首启引导处理与夹具布局的问题；不能把每次失败都归为产品缺陷：

| # | 现象 | 根因 | 修复与证据 |
| --- | --- | --- | --- |
| 1 | 首次打开被「命令面板」引导弹框盖住，后续点击全部超时 | 隔离 userData ⇒ 每次都是首启，而 spec 没处理引导 | spec 先消解引导（只在存在时点「以后再说」）；截图定位 |
| 2 | **Windows 上「添加 SSH 主机」保存即报 `SSH_CLIENT_UNSUPPORTED_PLATFORM`**，pin 弹框永不出现 ⇒ Windows 用户没有远端功能入口 | `SshHostPinStore` 的懒解析直接调 POSIX-only 的 `resolvePosixSshClient()`（它在 win32 必抛）。历史是**故障平台反转**：更早裸调 `createSshClientRuntime()` 导致 Linux 加主机失败，改成 POSIX-only 后炸的换成 Windows | `SshClientRuntime.resolveVerifiedSshClient()` 收口平台判断；四处裸构造一并修好。红→绿 + 单测；已提交 `65bb5504` |
| 3 | **连接偶发失败** `REMOTE_CONNECTION_NONCE_INVALID`（约 3%） | 服务**自己生成、自己校验** nonce：生成器用 base64url，而契约（与冻结 helper 共用）要求首字符为字母数字 ⇒ 约 3.1% 的生成结果被自己的校验拒掉 | 生成器改 hex（恒合契约、128 位熵不变），**不动契约**（改它要 bump helper bundle）。独立测得 66/2000 → 0/2000 |
| 4 | **列远端会话永远显示「无法确定远端会话目录（远端 home 解析失败）」**，而主进程稍后再扫却完全成功 | `remoteHome` 只读缓存状态，而其它远端路径都**按需建立会话**；并发场景（项目面板加载 vs 扫描）里会话切换窗口内读不到状态 ⇒ 假失败，且界面不会自动重试 | 扫描路径改用 `remoteHomeEnsuring`（同一把主机锁内按需建立再读），**UI 的只读语义一行不动**。可复现探针：Q2 `UNDEFINED` → Q3 拿到 home；红证单测 |
| 5 | 导入回执成功，但项目清单和「已导入」标记没有更新 | 先前将其直接归因于「选错项目」证据不足。即便编码匹配且登记到正确项目，`sessionsCatalogList` 仍一律拒绝远端项目；刷新异常在 App/hook 两层被吞掉。另外 `sessionRecordToSummary` 会过滤无本机 filePath 的 SSH 记录 | 远端 catalog 读取只返回已登记元数据、禁止调用本机 scanner；SSH 记录按稳定 id 投影为侧栏行，filePath 保持空；成功回执延后至刷新/选中完成，刷新失败单独说明「已登记但刷新失败」。`tests/remoteImportedCatalogList.test.mjs` 用真实 catalog + IPC handler + 刷新 hook + 侧栏投影复现并验证，另有反馈时序测试 |

**阶段性真机进展**：第 6 次运行首次验通了「加主机 + pin → 连接 ready → 登记两个远端项目 → 列出远端会话（30 条，含夹具）→ 惰性标题在真实数据上正确 → 导入回执」，随后卡在导入后的显示（见下表第 5 行，已修）。

**导入显示修复的证据**：新增 3 条 catalog/投影回归在修复前全部失败（2 条 `UNSUPPORTED_PROJECT_LOCATION`、1 条 SSH 行被丢弃），反馈时序回归也先失败（刷新未结束已显示成功）；修复后相关套件全绿，并在**随后的真机运行中确认**导入显示、重复导入、root 漂移全部通过。

**端到端验收已于 2026-10-11 通过两次**：run `e2emv3cw2x5`（13:01:41 起，1.8 分钟）与 run `e2emv3dr8xb`（13:26:01 起，1.9 分钟，**最终构建**），均为 `1 passed`。加主机 + pin 指纹命中 → 连接 ready → 登记两个远端项目 → 列出远端会话（30 条，含两条夹具）→ 惰性标题（权威名不标「暂定」、弱兜底标「暂定」）→ **导入**（清单刷新 + 选中 + 「已导入」标记 + 不开新 Tab）→ **重复导入**（`created=false` 区分回执、仍只一条记录）→ **项目级 root 漂移**（A 显示「需处理」带稳定码、远处邻居 B 仍 ok 且仍能列目录）。夹具自带清理，远端无残留（已交叉核对）。

**仍属未验证/已知边界**：① 导入的会话**打开后读不到正文**（界面如实报「无法读取会话文件」）——Phase 4 范围（导入只保证登记 + 选中）；② 真机只跑过**单次主流程**，长时间稳定性、并发多会话、多版本并行、断线重放等门禁未覆盖；③ POSIX symlink 语义与真机 symlink 逃逸未验；④ 选择器此前只有源码级证据的问题由本次真机运行消除（全部命中），但**新增步骤仍需实跑验证**。

**执行方式的硬边界**：本执行沙箱**无法启动 Electron**（Playwright 需经**管道**取 CDP 端点，沙箱内程序不能开命名管道；仓库既有 `e2e/smoke.spec.ts` 以完全相同方式失败，而 `electron.exe --version` 正常）⇒ 真机功能级验收**必须由用户在宿主终端**运行。本会话提供了 `%TEMP%\pideck-acceptance.ps1`（**纯 ASCII + BOM**：Windows PowerShell 会把无 BOM 的 UTF-8 按 GBK 读，脚本里的中文会导致解析失败——这个坑已踩过）。凭据只存在于该本地脚本，不进仓库。

**方法论沉淀（值得沿用）**：① 真机失败先看 `error-context.md` 的 DOM 快照与截图，往往一步定位（本次 4 个 bug 里 3 个由此定位）；② 关键失败要用**产品自己的代码在沙箱里写探针复现**——本次两个 bug 的根因都靠探针钉死，其中「并发窗口」只有把探针改成「会话切换在飞时去读」才复现；③ 修复一律**红证先行**（先让旧行为变红再改）；④ 失败证据先 `Copy-Item` 另存，注意 **Playwright 每次启动会清空 `test-results/`**（本会话误删过一次证据）。

### 第八批：INV-5a 写侧一致性实施（已完成，2026-10）

本轮不改任何 renderer / IPC 通道 / helper 契约，只动**写入侧协议**与两个 store 的提交路径。设计与门禁来自 [跨 store 一致性计划](remote-cross-store-consistency-plan.md)，实施记录写在它的 §6.3.2。

| 块 | 落地位置 | 验证 |
| --- | --- | --- |
| 共用跨进程锁 + CAS 原语 | `src/main/persistence/StoreFileLock.ts`、`src/main/persistence/storeFileCas.ts`；`HostRebindTxLock` 改为委托（导出名/稳定码/行为不变） | `tests/hostRebindTxLock.test.mjs`、`tests/projectStoreCas.test.mjs` |
| `projects.json` 写事务 | `ProjectStore` 全部 mutator 改为「持锁 → 重读磁盘 → 在最新内容上重放意图 → 有改动才写 `revision+1`」；`readHostRecordLocators` 读磁盘并对齐内存 | `tests/projectStoreCas.test.mjs`（4）+ `tests/projectStore*.test.mjs` 保持绿 |
| `session-catalog.json` 写事务 | `SessionCatalog` 同形改造 + 可选 `revision`（**不 bump `version`**，旧版仍可读）+ 加载期归一化改为「令牌相等才写回」 | `tests/sessionCatalogCas.test.mjs`（5）+ `tests/sessionCatalog*.test.mjs` 保持绿 |
| 引用写入门 | `src/main/remote/RemoteReferenceWriteGuard.ts`（host 可解析 + 无 rebind 事务；三个码各自可行动）；已注入 `ProjectStore` 与 `SessionCatalog`（`main/index.ts`） | `tests/remoteHostReferenceInterlock.test.mjs`（5） |
| 跨 store 删除 | `src/main/projects/projectRemoval.ts`：**先清引用、后删被引用者**，不再 `.catch(() => 0)`；三处生产调用点收口 | `tests/crossStoreEnrollRetireRace.test.mjs`（2） |
| 同源磁盘根 | `src/main/remote/RemoteHostPaths.ts`，`RemoteHostStore` / `SshHostPinStore` / `HostRebindJournal` / 门共用 | 上述全部套件 |

**门控结果**：`PIDECK_INV5_EXPECT_RED=1 node --test tests/crossStoreInv5Counterexamples.test.mjs` 从**4 红**变为 **6 pass / 0 fail**；默认（不设变量）仍为 1 pass / 5 skipped / 0 fail。

**两处判据修正（如实记录，不是放宽）**：CE-2 原断言同时要求「引用确实写入了」与「该 host 不在 `retiredHostIds`」，但 retire 已删掉 profile 并只留墓碑——引用若写进去必然悬空，正是 INV-1 要禁止的结果；按 §6.3 行 2「写入在 commit 前被拒」改写为**拒绝 + 稳定码 + 磁盘逐字节不变**。CE-3 原断言在「注入主文件 rename 必失败」之后要求主文件不再残留引用，而任何守规矩的整文件写都必须 rename 到那儿（不 rename 等于放弃原子替换），所以不可满足；改写为「**失败带稳定码 + 失败时项目不删（无悬空引用）+ 重放收敛**」。两处都补强了「磁盘逐字节不变」。另有两处旧测试按新语义修正（`remoteSessionRegistration` 的写盘计数改为只数 catalog 临时文件；`hostRebindStorePorts` 的「落地但抛异常」改为断言 `already-applied` 且文件逐字节不变），旧断言编码的正是被替换掉的「权威=内存」语义。

**本机基线证据（Linux / Node 24.21，工作树 `c95d999ef` + 本轮改动）**：`npm test` 全量 **7587 项 / 7555 pass / 19 fail / 13 skip**；在**干净基线**（stash 后同一命令）为 **7571 / 7539 pass / 19 fail / 13 skip** —— 测试数与通过数各多 16（即四个新测试文件的用例数），**失败集合逐条一致**（均与本轮无关，典型是 JetBrains 探测、Git/安全等级契约、`sync-workflow-choices`、`toaster`、`remoteHelperSearchNames` 的两条“入口上限”在负载下的失败等）。

**未做（不得描述为已闭环）**：① **跨 store 协调器与启动 `resume` 未装配**：journal 收敛算法与幂等早有实现但无生产入口，遗留 journal 只能 fail-closed 阻塞引用写入；② 旧版本写者靠**磁盘 CAS 检测**而非阻止；③ 主机目录锁仍未补 owner（§1.7 第 7 条）；④ 两 store 之间仍无共同提交点，跨 store 原子性 = journal + 幂等 roll-forward + 可诊断的未收敛态。

**执行方式（本轮）**：全程无需真机与 Electron（纯离线套件 + 全量基线对照）；未动 helper、未动远端。

### 第九批：Phase 4 P4.0 + P4.1（已完成，2026-10）

本轮把「启动面」与「远端 pi 定位」这两件不碰远端写入的前置做完，并用真机只读证据收口。

| 块 | 落地位置 | 验证 |
| --- | --- | --- |
| P4.0 启动面抽取（本地） | `src/main/pi/PiSpawnHandle.ts`（新）、`src/main/pi/LocalPiRuntimeLauncher.ts`（新）；`PiProcess` 改为 `await runtimeLauncher.launch(plan)`、`proc` → `handle` | `tests/piRuntimeLauncher.test.mjs` 9/9（spawn 选项、非法 plan 零 spawn、同步/异步失败、Unix/Windows 停止顺序、幂等、**真实子进程**退出码与 SIGTERM 回收）；`tests/piProcess*.test.mjs` 34/34；Electron `e2e/smoke.spec.ts` 通过 |
| 遗留测试基础设施 | 4 个仍在用手写 vm 沙箱的 PiProcess 测试 → `createTsSandbox` | 34/34，断言行数逐文件一致（未放宽） |
| P4.1 远端 pi 探测 + 兼容矩阵 | `src/main/remote/RemotePiDiscovery.ts`（新）；`RemoteNodeDiscovery` 新增 `parseLoginShellPathWithCode` 与 `listToolCandidatesFromPath`（node/pi 共用目录判定） | `tests/remotePiDiscovery.test.mjs` 24/24（含 POSIX `set --` 行为验证、候选上限在 I/O 之前、错误码即消息） |
| P4.1 真机证据脚本 | `scripts/verify-remote-pi.mjs`（新）+ `scripts/remoteVerifyPinnedHost.mjs`（把 pin 路径从两个脚本抽成一份，三个脚本共用） | 真机 `PI_OK …/bin/pi 0.85.1 class=supported probed=1` / `PI_PROBE_OK`（exit 0）；错指纹 ⇒ `HOST_FINGERPRINT_MISMATCH`（exit 1） |
| 真机脚本去 `ssh-keyscan`（交接遗留项） | `scripts/verify-remote-host.mjs` / `verify-remote-connection-service.mjs` | 真机 `PINNED_PROFILE_OK` 复现；新建 `tests/remoteVerifyScriptsContract.test.mjs` 守卫（禁 keyscan、必须保留独立指纹比对） |

**三条决定（已写进 `docs/remote-phase4-plan.md`）**：

1. **D4 兼容窗口**：下限 `0.85.0`，依据是仓库自己的兼容账本 `docs/pi-compatibility.md`（当前基线 pi 0.85.0，通信即 `pi --mode rpc`）；计划里写的 0.87.1 是「写计划时上游最新 release」，拿它会把真机 0.85.1 无理由判死。`0.85.x` 为已核验窗口；更高 ⇒ **放行** + `REMOTE_PI_VERSION_UNVERIFIED`；更低 ⇒ `REMOTE_PI_TOO_OLD` + 升级指引（不静默降级、不替用户升级远端 pi）。
2. **pi 版本命令的形态（真机实测逼出来的）**：必须写成 `'<已解析 node>' '<pi>' '--version'`。nvm 装出来的 `pi` 是 `#!/usr/bin/env node` shim，而非交互式 SSH 的 PATH 只有系统 node（真机 v12.22.9）⇒ 裸执行在 pi bundle 首条语句 SyntaxError（exit 1、stdout 空）；登录 shell 包装能绕过但会把 `~/.bashrc` 横幅混进 stdout。**P4.2 的远端启动必须复用同一形态**（`<node> <pi> --mode rpc …`）。
3. **契约等价迁移**：`tests/processMetrics.test.mjs` 的源码级断言随 `proc → handle` 改名同步迁移（断言目标换成新抽象，**不放宽、不删**）——这正是「契约测试断言的源码文本会随重构过期」那条坑。

**未做 / 边界（不要当成已完成）**：

1. **P4.1 探测还没有生产调用方**：接线在 P4.2 的启动准备里，且必须先由 `resolveRemoteNodeExecutable` 解析出 `nodePath` 再传进来。
2. **三个码的 i18n 文案未接线**（随 P4.2 的 UI；届时按导出的 `REMOTE_PI_DISCOVERY_CODES` 映射）。
3. `verify-remote-connection-service.mjs` 本轮**未在真机复跑**（它会部署远端 helper，属写操作）：但它的 pin 段已与已复跑成功的 `verify-remote-host.mjs` 共用同一实现。
4. E2E：`e2e/smoke.spec.ts` 通过；`e2e/agent-flow.spec.ts` 的 3 条失败在**干净基线同样红**（既有环境/夹具问题，非本批）。

**全量基线对照（本机 Linux / Node 24.21，同一命令、同一夹具）**：有改动 **7625 项 / 7593 pass / 19 fail / 13 skip**；干净基线（stash 后）**7588 / 7556 pass / 19 fail / 13 skip** ⇒ 新增 37 项全绿、**失败集合逐条一致**。`npm run typecheck` 与 `npm run check:format` 均 exit 0。

**建议下一步**：P4.2 —— `SshPiRuntimeLauncher`（复用 P4.0 的 `PiSpawnHandle` 与 P4.1 的探测）+ 冻结 runner（握手/进程组/lease，作为同一份 bundle 的第二个冻结 entry）+ 把 prompt 的 `unknown` 状态接进会话链路。

## 4. M1 之后如何推进

1. **Phase 3 剩余只读能力**：目录/内容搜索与远端 Session 发现走 helper，由 catalog 保存远端 locator；不得把远端路径交给本地 scanner。结果数量、字节和超时必须有界。
2. **Phase 4 先做最小端到端会话**：沿现有 runtime 接口加入 SSH launcher，新建一个远端 pi 会话，完成发送 → 流式消息/工具事件 → 停止 → 重启恢复。扩展快照、trust、security artifact 和 pi 版本门禁是启用这条链路的前置条件。
3. **Phase 4 再补生命周期**：双会话隔离、断线处理、历史恢复、rename/archive/restore/remove/delete、edit/resend/fork/export 和目标主机的配置能力。所有事件绑定 `sessionId + agentId + runtimeGeneration`；不确定是否执行的 prompt 不能自动重发。
4. **Phase 5**：文件写入、Git、终端按领域分工，统一复用项目定位与 capability 边界；最后执行 §13 能力对照、安全与跨平台验收。Remote v1 不等同于“能聊天”。

完整范围与禁用项以实施计划 §12–13 为准；本页的先后顺序不删减已有发布门禁。

## 5. 开发与验证

完成仓库 [贡献指南](../CONTRIBUTING.md) 中的开发环境准备后，在 POSIX shell 启用：

```bash
PIDECK_REMOTE_EXPERIMENTAL=1 npm run dev
```

门禁位于 `src/main/index.ts`：`!app.isPackaged && process.env.PIDECK_REMOTE_EXPERIMENTAL === "1"`。设置页“连接”现在只管设备（添加、信任、连接/断开、诊断、修复）；**远端项目入口已在侧栏“+”**（本地目录 / 远端 SSH 两个真实入口）。

日常只跑改动涉及的检查。例如 A 的读取/连接改动：

```bash
npm run typecheck
node --test tests/remoteHostIpc.test.mjs tests/remoteHostConnectionService.test.mjs tests/remoteProjectReadConcurrency.test.mjs tests/remoteHostOperationLock.test.mjs tests/remoteProjectReadIsolation.test.mjs tests/remoteProjectReadChain.test.mjs tests/remoteSearchReader.test.mjs tests/remoteHelperSearchNames.test.mjs tests/remoteSearchIsolation.test.mjs tests/remoteProjectRootReverify.test.mjs
```

跨域集成时再跑：`npm run check:format`，以及 `tests/remoteBrowseRoot.test.mjs`（本机有 1 个既有的 `/bin/sh` 平台失败）、`tests/remoteWorkspaceReader.test.mjs`、`tests/remoteWorkspaceEndToEnd.test.mjs`。

C 对应 `projectStoreCodec.test.mjs`、`projectStoreMigration.test.mjs`、`remoteHostReferenceSources.test.mjs`；B 需更新 `settingsTabLayout.test.mjs` 并补实际交互状态覆盖。格式化仅涉及文件（`node_modules/.bin/biome format --write <files...>`）；集成时运行 `npm run check:format`。纯文档修改检查差异、链接与命令准确性即可。

**测试记录的边界（第四批实施后更新）**：Windows / Node 24.19 上跑的集成集合（remote* + projectStore* + sessionCatalog* + hostRebind* + 侧栏/面板/文案/连接管理器/locationAdapters/workspaceTree/sessionFirstRenderer）：第一批 **512 项 / 505 pass / 2 fail / 5 skip**；第二批 **689 项 / 682 pass / 2 fail / 5 skip**；第三批 **921 项 / 914 pass / 2 fail / 5 skip**；第四批 **991 项 / 984 pass / 2 fail / 5 skip**；第五批 **1040 项 / 1033 pass / 2 fail / 5 skip**；第六批 **1080 项 / 1072 pass / 2 fail / 6 skip**。六轮 fail 的**名称与断言完全相同**，就是下面列出的**既有**失败，并已在干净基线 worktree(`f7b18947`) 上逐字复现——所以第二、三、四批均零回归。`npm run typecheck` 与 `npm run check:format`（2173 个文件，无改动）通过。全量 `npm test` 本批未跑（仓库规则：仅跨域大改动或合并前最终确认时跑），因此**没有「全量已全绿」这个结论**。

这 2 个既有失败已在**干净基线 worktree（`f7b18947`，不含本批任何改动）上逐字复现**，不是本批引入的回归，而且不能全归为平台原因：
- `tests/remoteBootstrapSessionIntegration.test.mjs` → `BOOTSTRAP_READY_INVALID`（真实子进程 + frozen entry 握手，两侧同样失败）；
- `tests/remoteBrowseRoot.test.mjs` → Windows 上 `/bin/sh` 不可解析（Git 的 `sh.exe` 位于 `C:\Program Files\Git\bin\sh.exe`），属平台环境。

先前在 Linux/Node 24 交接环境记录的全量 **7181 项 / 7157 pass / 18 fail / 6 skip** 是**那个环境**的数字，与本机不可直接比较；引用时必须连环境一起引用，也不能因为「数量仍是 18」就判断没有回归——本批的做法是在干净基线 worktree 上按**测试名与断言**逐一对照。

**第八批（INV-5a，Linux / Node 24.21）**：全量 `npm test` 实施后 **7587 / 7555 pass / 19 fail / 13 skip**，干净基线（同命令、stash 后）**7571 / 7539 pass / 19 fail / 13 skip**——差量恰为四个新测试文件的 16 条用例，**失败集合逐条一致**。门控红例从 4 红变 **6 pass / 0 fail**（默认仍 1 pass / 5 skipped / 0 fail）。本机两条既有失败在**同一环境**下逐字复现：`remoteHelperSearchNames` 的 “entry ceiling stops at 20000” 与（集成负载下的）“scanned-entry cap” 两条；与代码路径无关，归类为环境/负载。

需要基线对照时，在相同环境的独立干净 checkout 比较同名测试的失败断言；不要为跑基线 stash 或清理其他开发者的工作。跨域集成/合并前才扩大到 `npm test`，不为每个文档或局部改动重复跑全量。本任务未授权全仓库构建。

真机脚本的参数是 **IPv4、用户名、独立核验过的 ED25519 指纹**，不是只传 SSH alias：

```bash
node scripts/verify-remote-host.mjs '<IPv4>' '<user>' '<independently-verified-ED25519-SHA256-fingerprint>' --bootstrap
node scripts/verify-remote-connection-service.mjs '<IPv4>' '<user>' '<independently-verified-ED25519-SHA256-fingerprint>'
```

只替换成自己的已授权测试主机信息。这些脚本会连接并可能部署 helper；远端 Node 需 ≥22.3，执行需有界，失败即停。脚本通过仍不替代 Electron UI、多项目并发与 Session 生命周期验收。

## 6. 代码定位与协作方式

| 领域 | 入口 |
| --- | --- |
| 应用装配/IPC | `src/main/index.ts`、`src/main/ipc/remoteHostIpc.ts`、`src/shared/ipc.ts`、`src/preload/index.ts` |
| SSH/信任/生命周期 | `src/main/remote/SshVerifiedConnection.ts`、`SshHostPinStore.ts`、`RemoteHostStore.ts`、`RemoteHostConnectionService.ts`、`SshConnectionManager.ts` |
| helper 部署与读取 | `RemoteBootstrapSession.ts`、`RemoteBootstrapDeployment.ts`、`RemoteControlClient.ts`、`RemoteBrowseRoot.ts`、`RemoteWorkspaceReader.ts`（均在 `src/main/remote/`） |
| 项目与引用 | `src/shared/types/project.ts`、`src/shared/projectLocation.ts`、`src/main/projects/ProjectStore.ts`、`projectStoreCodec.ts`、`src/main/remote/RemoteHostReferenceSources.ts` |
| UI | `src/renderer/src/components/sidebar/ProjectTree.tsx`、`components/app/settings/ConnectionsTab.tsx`、`components/session/RemoteProjectPanel.tsx`（后两者相对 `src/renderer/src/`） |

远端 `Project` 只有 SSH locator，没有本地 `path`。用 `isLocalProject` / `isRemoteProject` 窄化；不能用 `as`、非空断言或默认 cwd 绕过。类型调整曾产生 71 个编译错误、涉及 21 个文件，这是一次检查结果，不是消费点穷尽证明；可选链和默认路径仍需按直接调用链审查。

建议不同开发者使用独立 checkout，从 `feat/remote-development` 开工作分支，PR 的 base 选 `feat/remote-development`。当前同一工作区的代理继续当前分支，避免并行切换污染彼此工作。每个 PR 包含单一可验收任务、验证结果和剩余缺口；接口/装配文件由集成负责人统一协调。

分支与 `main` 已分叉，这是普通 Git 合并情形，**不代表不能合并**。集成负责人单独处理与 main 的能力对照、冲突和验证；协作者不各自做大规模 rebase，也不强推共享分支。合并/发布另行执行已规定的门禁。

## 7. 不改变的边界

- 每台主机独立核验指纹，不采用首次连接自动信任（TOFU）；保持系统 OpenSSH、严格 pin 与路由复核。
- pi 负责 Agent、工具、模型与会话行为；PiDeck 管窗口、进程和 UI，经 stdio JSON-RPC 通信。
- 不复制本地秘密到远端，不把 remotePath 交给本地文件、Git、终端或 Agent 实现；不擅自改用户的 Node/SSH 环境。
- helper 当前要求远端 Node ≥22.3；版本探测使用实际选中的可执行文件，不用不同 Node 的探测结果代替。
- 所有未验收能力继续受开发态门禁约束；失败必须显式呈现，不能通过删断言或回落本地掩盖。

更多背景：[项目位置 ADR](project-location-architecture.md)、[WSL 位置基线](wsl-location-baseline.md)。

## 远端历史窗口读取（已交付 `de769e460`，父代理已真机复跑）

- **能力**：`sessions:read-messages` 按 locator 路由——ssh locator 记录不再落进「没有本机会话文件」分支
  （那会返回空页并被渲染层 force 写进缓存，正是「应用重启后点开远端会话没历史」的成因）。
- **传输**：既有 pinned SSH 短命令（`buildPinnedSshInvocation` + `SshClientRuntime.run`，每次读取复查 pin/指纹/
  路由摘要/严格配置），**零新增 helper op**；命令只带窗口上界，**永不把文件大小写进命令**。
- **真机证据（父代理复跑）**：`HOST_HANDSHAKE_OK` → `REMOTE_HISTORY_BOUND WINDOW 131072 TRANSPORT 262144`
  → `REMOTE_HISTORY_PAGE MESSAGES 2 NEXT_BEFORE none` → `REMOTE_HISTORY_ROLES user,assistant` → `…_PAGE_OK`；
  指纹当场核对与既定值一致。脚本 `scripts/verify-remote-history.mjs`（只读，凭据只从 env 取）。
- **注意**：验收 spec 收尾会删掉它自己造的 `*pideck-e2e*` 远端会话目录 ⇒ 拿那些路径复跑脚本会 `COMMAND_FAILED`
  （文件已不存在），不是实现问题；用该主机上任何真实存在的会话文件即可复跑。

### 已知偏差（待专门契约，不在本项范围）

- 远端 `nextBefore` 是**字节偏移**（本地是活动分支消息下标）：页边界只对齐行、不对齐完整轮次；`total` 是窗口
  消息数（下界）；`options.beforeEntryId` 对远端不适用；窗口内才可回溯 parentId ⇒ 窗口首条之后的分支归属可能
  与本地整文件索引不同；单行超过整个窗口时该行永不显示（该页 `nextBefore=null`，不循环）。
- **渲染层游标语义风险**：`cacheMessages` 在「页 + 内存超限裁剪」分支对数值游标做算术（`nextBefore + dropCount`），
  按 `source === "disk"` 生效，而远端页目前也走 `source:"disk"`。触发面窄（长会话 + 远端记录），后果是下一次
  「加载更早」起点偏移、可能跳内容。**修法**：给远端页独立 `source`（联合类型加 `"remote"`，`page` 一并带上，
  只让 disk 走那条算术）或改成不透明游标契约；修完再加一条针对性测试。
- 投影按 `{id, parentId, type:"message", message:{…}}` 处理是**推断**（无真实远端文件样本前的读码推断）；
  真机复跑已读到 `user,assistant` 两条，形态与推断一致。

## 远端崩溃恢复演练（#35，开关 `PIDECK_E2E_P42_REATTACH_DRILL=1`）

**形态**：作为验收 spec 主流程末尾的**开关控制步骤**（默认关闭）。在一个**正在进行/刚结束的回合**之后，杀掉该会话**自己的**
远端进程组，然后走产品恢复路径（⋯ →「启动/重启 Agent」），断言：①主控项回到可启动/可重启态（不假装还在跑）；
②重启前的两条 prompt 仍在（同一会话）；③还能继续对话并出正文；④（判别性）新回合**追加进同一个远端会话文件**（行数增长）。

**它替我抓到的三个事实（都有真机证据）**：
1. **不能用 `ps | grep <会话名>` 找远端 pi**：实测候选表只剩我们自己的诊断命令——runner 承载 pi、参数走 stdin，命令行里
   没有会话路径；`pgrep -af pi` 还会匹配到**我们自己的 ssh 命令**（路径含 `.pi/`），首次演练就是这样杀错对象、命令非零退出。
   正路是按 **runner lease** 定位：`<home>/.pideck/remote-host/leases/<nonce>.json` 里有 `pid`/`pgid`（契约文档明写），
   再 `kill -9 -<pgid>` 杀**整个进程组**（runner + pi 一起，才是真实崩溃形态）。lease 写入有延迟 ⇒ 读的时候要**重试**。
2. **重开远端会话只是"显示历史"这个动作，runtime 要等输入才起**（首键 activateRuntime）⇒ 演练里等「assistant 卡片可见」
   会被**历史里的旧回复**瞬间满足 ⇒ 必须改等**本轮真正结束**（发送钮从「停止」回到「发送」）。
3. 演练**一次性通过**（`1 passed (1.9m)`，真实主机，见 §证据），随后加固了第 ④ 条断言。

**最终结果（已通过）**：加固版（第 ④ 条判别性断言）在真机上 **`1 passed (49.0s)`** ——
重启后的新回合让**同一个远端会话文件行数增长** ⇒ 恢复后的 pi 确实在续写同一会话。
两个过程性发现值得记住：① 第一次跑成红是**假警报**——pi 落盘有延迟，断言必须**轮询**（现已改成最多 ~15s 轮询，
失败时还会把该目录所有 jsonl 的行数打出来，能区分「延迟」与「另开新文件」）；② 为定位「这次到底用什么会话文件起的 pi」，
在 `AgentManager` 远端 prepare 成功后加了一条**永久诊断日志** `Remote pi runtime plan prepared { agentId, hostId, args }`
——runner 的 plan 走 stdin、lease 里也没有 argv，这是 app 日志里唯一能自证的地方（这次就是靠它确认：新建那次无 `--session`、
重启那次带的是**绝对路径且与 UI 记录的文件一致**）。
**范围诚实说明**：本演练验的是「进程组被杀 → 用户走产品恢复路径 → 同一远端会话继续」。产品**自动**重连只覆盖两个窄窗口
（abort 窗口内退出 / `code===0` 干净退出，见 `AgentManager` 的 `autoRestartAttempted` 分支），`kill -9` 不在其中——
所以演练**刻意不断言"自动接回"**（那会是一条假测试）；自动窗口由单元测试 + `reattachProcess` 的远端分支覆盖。

### 回归证据（最新 HEAD）

`2026-10` 在 `31407ce3c`（含本轮的 i18n 接线、远端游标契约收口、plan-args 诊断日志、trust key 模块与
trust-flag 门禁）上重跑完整真机验收 `e2e/remoteSessionAcceptance.spec.ts`（两条：产品路 + trust 提示）：
**`2 passed (2.3m)`**。即：这一批改动对 P4.2 已交付的产品路**零回归**。

## 远端会话生命周期 parity 侦察（重命名 / 归档 / 移除记录 / 编辑重发 / fork / 导出）

**侦察口径**：读码 + 针对性测试（未真机复跑）。判据只有一条——`SessionCatalog.getLocalFilePath` 是**本机文件路径的唯一入口**，
对 `locator.kind === "ssh"` 经 `SessionLocatorRouter.resolveFilePath` 直接抛稳定码 `UNSUPPORTED_PROJECT_LOCATION`。所以
「今天远端能不能用」这一列基本等价于「这条路径会不会经过本机文件」：经过就 fail-closed（明确抛码，**不是**静默失败），
不经过的才可能通。

| 操作 | 通道 / 实现入口 | 实现碰什么 | 今天远端 | 缺什么 |
| --- | --- | --- | --- | --- |
| 改名（改标题，无运行实例） | `sessions:catalog-update` → `sessionIpc` catalogUpdate | 前半是纯 catalog（`claimTitleOwnership` + `update`）；local locator 额外改本机 JSONL 的 name 行 | **本批打通**：只落 catalog 标题（manual 终态） | 远端 JSONL 的 name 行不更新 —— 远端 pi/TUI 里仍是旧名 = 远端写面 |
| 改名（有运行实例） | 同通道 → `SessionRuntimeCoordinator.renameRuntime` → pi RPC `set_session_name` | 只发 RPC，由 pi 自己写远端文件 | **推测可用**（`AgentManager.rename` 不碰本机文件；`reportSessionPathFromPi` 对远端 runtime 原样收下回报路径） | 真机验收（含「改名后重启仍是新名」） |
| 归档 | `sessions:catalog-archive` | 远端文件 `mv` 进**同目录旁的** `.pideck-archive/` + 本机归档索引 + 移出 catalog | **P4.5b 已交付** | —（运行中仍 fail-closed，先停 Agent） |
| 取消归档 | `sessions:catalog-unarchive`（本机） / `sessions:catalog-unarchive-remote`（远端，新通道） | 远端按**本机 catalog 会话 id** 查归档索引，把文件 `mv` 回原位并重建记录 | **P4.5b 已交付**（按 id，不沿用本机路径契约） | UI 与真机往返已验证（见下） |
| 列出归档 | `sessions:catalog-list-archived` | 本机扫描根下的 `.pideck-archive/` + **本机归档索引**里的远端条目 | **P4.5b 已交付**（远端归档区**不扫描**） | UI 与真机往返已验证（见下） |
| 删除归档 | `sessions:catalog-delete-archived` | 本机回收站（`shell.trashItem`）+ 归档索引 | **不适用且有意保持 fail-closed**：远端没有本机归档路径，也没有 `rm` 链路 | 需另立「真删远端数据」的显式动作（二次确认） |
| 移除记录 | `sessions:catalog-delete` | **删本机会话文件（回收站）+ 移出 catalog** | 抛稳定码（fail-closed） | 需要产品决策 + （真删远端）远端写端口，见下条 |
| edit-message | `sessions:catalog-edit-message` → `SessionRuntimeCoordinator.mutateCatalogMessage` | 改写 JSONL（本机：本机文件；ssh：**远端文件**，经 `RemoteSessionHistoryWriter`） | **P4.5c 已交付**（`RemoteSessionHistoryWriter` + `RemoteSessionWriteGuard`）：ssh 分支在 `getLocalFilePath` **之前**分流，快照/分块读回/读后复核 → 本机同一语义算新内容 → `0600` 排他临时文件分块写 → 提交前复核 SHA-256/文件身份/归属并恢复原 mode → 原子 rename；运行中**先判后发**（零远端命令，`SESSION_RUNTIME_BUSY`）；提交前失败不替换目标文件，提交后回执丢失可能结果未知且不自动重试；日志只记身份与操作 |
| delete-message | `sessions:catalog-delete-message` | 同上（写墓碑） | **P4.5c 已交付**（同写面）：assistant 的过程链一并墓碑、子节点重挂；文件里没有该消息且无停止摘要时是 no-op（零远端写命令）；有实时身份摘要但无法唯一核对时拒绝，不谎报删除成功 |
| prepare-resend | `sessions:catalog-prepare-resend` | 同上（截断该消息及其后继） | **P4.5c 已交付**（同写面）：返回原文/参考图快照 + 该条及其后继全部墓碑 |
| fork | `sessions:runtime-fork` → pi RPC `fork`（需运行实例） | 官方 RPC → fresh `get_state` → 既有远端端口登记**新 ssh record** → coordinator 换绑 | **live-runtime 身份链已实现**（取消不 refresh/不登记；否定响应或状态读取失败按「身份未知」fail-closed） | **真机语义已查明（2026-10-12，协议级探针）**：pi 的 `fork` 立刻把 `get_state.sessionFile` 换成新路径，但该**文件懒创建**（要等该会话首次追加消息才落盘；连 `set_session_name` 成功也不落盘）⇒ 登记新记录是对的，但**新记录可能暂时指向磁盘上还不存在的文件**；应用侧换绑已真机验证（composer 换 session id、侧栏 1→2 行、原文件 sha256 未变）。验收步骤已按正确判据改写并**在真机跑通**（2026-10-12：`2 passed (2.0m)`，含 trust 步骤；证据 `originShaUnchanged=true newFiles=[] rowsAfterFork=2`）|
| clone（同族，一并记录） | `sessions:runtime-clone`（RPC）/ `sessions:catalog-copy`（本机临时 pi 进程） | 同上（与 fork 同一替换 owner）；catalog 版先过 `getLocalFilePath` 守卫 | RPC 版同上（clone 在 pi 里也走 fork 语义）；catalog 版仍抛稳定码 | 同上（停态/临时会话面明确不做） |
| export-HTML | `sessions:catalog-export-html` | 先 `getLocalFilePath` 守卫 → 本机临时 pi 进程导出 HTML | 抛稳定码（fail-closed） | 只需**远端读**：复用 `RemoteSessionHistoryReader` 读窗口，HTML 仍写本机（新接线，不改远端） |

**本批已实现（只做「纯 catalog 记录操作」那一档）**

- `src/main/ipc/sessionIpc.ts` 的 catalogUpdate：无运行实例且 locator 是 ssh 时，改名**只落 catalog 标题**，刻意不调用
  `localSessionFilePath`（它对 ssh locator 抛码，会让一次纯记录操作整体失败）。本机 locator 分支逐字未动。
- 代价（有意为之、已写进代码注释）：远端文件里的 name 行不变。远端写属未交付面，不在这一档里顺手补。
- 证据：`tests/remoteSessionCatalogRename.test.mjs`（真实 `SessionCatalog` + 真实 `registerSessionIpc`，本机文件面整个换成
  留痕替身）——远端改名成功且 `getLocalFilePath` / 会话文件改写**一次都没发生**；标题落盘后仍是 ssh locator、重名登记不得覆盖；
  本机会话改名仍按本机路径改写 name 行；远端**归档**装配未提供远端端口时仍是稳定码拒绝且不动 catalog 记录
  （P4.5b 起该码是 `REMOTE_SESSION_ARCHIVE_UNAVAILABLE`，见下）。

**明确没做（会碰远端会话文件，或需要产品决策）**

1. **移除记录（`sessions:catalog-delete`）不是纯记录操作**：今天的语义是「删文件 + 移出记录」。只给 ssh 记录做 catalog 移除
   会有两个用户可感知后果 —— 远端文件仍在（toast 说「会话已删除」而远端数据没删），且**下次远端扫描会把它重新列为「可导入」**
   （ssh 记录没有墓碑；DSH 侧靠 `dismissedDshSessionIds`）。要不要墓碑、要不要真删远端文件、文案怎么改，都需要先定方案与授权。
2. 归档 / 取消归档 / 列出归档 / 删除归档：全部依赖远端文件移动或远端归档索引 = 远端写面。
3. edit-message / delete-message / prepare-resend：**P4.5c 已交付**（远端写面，见上表）。已知边界：
   ① 整读上界 **256 KiB**（本机链路是 32MB）⇒ 超出的会话失败于 `SESSION_FILE_TOO_LARGE`（文案带真实上界），不截断改写；
   ② 临时文件上传期间固定为 **0600**（排他创建），提交时保留原 POSIX mode；uid/gid 不一致拒绝替换，不执行 chown。未复制/验证 ACL/xattr，不能宣称完整元数据 parity；
   ③ **乐观版本复核已交付**：读前/实际读回 SHA-256/读后/提交前核对 mode/size/dev/ino/uid/gid/mtimeNs/ctimeNs/digest，变化拒绝并提示重载。仍不是严格互锁：最终复核与 rename 之间保留非协作写者竞态，提交后回执丢失也不能保证未提交；
   ④ 运行中拒绝复用本机同一条 `SESSION_RUNTIME_BUSY`（渲染层既有文案 + debugDetails），没有 P4.5b 那种「先停止 Agent」专用 key；
   ⑤ 真机证据分层：**命令形状已在真实主机验证**（2026-10-12 探针：分块写 `base64 -d >`/`>>`、`wc -c <`、
      分块读 `tail -c +N -- | head -c M | base64`、`mv --` 原子替换四种形状逐条通过，base64 折行往返 200B→200B）⇒
      worker 原先列的「`base64 -d` 可能不存在」风险已关闭；内容语义端到端证据另见⑦，不能用传输成功代替。
   ⑥ 真机**往返**已验证（2026-10-12 探针，纯 shell 用写面的同一套命令形状）：取真实会话文件（2.4 MB 那条）的前 32 KiB 作载荷，
      分块读（`tail -c +N -- f | head -c 4096 | base64`）→ 分块写（`base64 -d >` / `>>`）→ `mv --` 原子替换：**8 块、字节级一致**、
      源文件未变 ⇒ 分块边界数学与远端工具链在真数据上成立（含 base64 折行）。这一证据仅验证传输层。
   ⑦ **内容语义真机已验证（2026-10-13）**：`e2e/remote-history-mutations.ts` 作为默认产品路门禁，经真实 UI 操作本次测试生成的远端会话，
      `e2e/remoteHistoryAssertions.ts` 用本机真实 `SessionFileEditor` 在临时副本生成期望，并逐字节比较整份结果：编辑 >4096B 中文/换行/引号正文；
      重发旧轮次墓碑 + 同文件新增 user/assistant entryId；先删 user 保留并重挂 assistant，再删 assistant，重载后为空且文件不再变化。
      首两跑暴露实时 UUID 未映射及跨机时钟约 5.8 秒偏差；修复为停止前保存 32 会话 × 256 消息的身份摘要（不留正文），
      从 pi 原始事件保留远端时间，仅在活动分支中按角色 + 5 秒窗口 + 完整内容摘要唯一匹配；UI 时间不变，不放宽窗口，歧义/失配 fail-closed。
      真机日志 `/tmp/p45c-real-ui-attempt3.log`：**2 passed（3.7m）**；最终重建 main/preload 后 `/tmp/p45c-real-ui-final.log`：**2 passed（3.9m）**。
      11 个针对性测试文件 **190/190**、项目 typecheck、oracle 严格类型检查、spec `--list`、定向 Biome 均通过；JSONL before/after 附件随 Playwright trace 留存。
      这批语义证据未覆盖真实参考图重发、工具过程链、多会话并发；后来完成的上传期外部追加反例见下面「权限与冲突加固」。
4. fork / clone：远端 pi 会落盘**新**会话文件（经 pi 的写）。live-runtime 身份链已实现（见上表）：
   替换策略唯一 owner 是 `src/main/sessions/agentSessionReplacement.ts`（`main/index.ts` 只留依赖注入转发），
   本机与 SSH 走同一个 `replaceBoundRuntime` 状态机。**停态 clone**（本机临时 pi 进程那条）仍不做；远端 edit/resend 已由 P4.5c 写面承接。
5. export-HTML：只缺接线（远端读能力已交付），不在本批。

**P4.4b 已实现（远端项目 trust：决策存储 + flag 传递 + 决策 UX）**

- 决策存储 `AppSettings.remoteProjectTrust`：每条记 `trustKey`（`hostId::endpointDigest::规范项目根`）+ 三个零件 + `decision` + `decidedAt`；
  旧设置文件缺段 = 空表；host 退役（`RemoteHostStore.onHostRetired`）时清理该主机条目，失败下次 open 补清；目录对账丢弃 retired/未知 host 条目。
- 判定：同 host + 同根但 endpoint 摘要不同 ⇒ **作废 + 写明原因**（不是悄悄回到未决策）；材料只取既有 pin 事实（`openRemoteHostCatalogView`，不新增 SSH 通道）。
- 传递：`buildRemotePiArgs` 里**唯一**一处映射（`approve → --approve`、`deny → --no-approve`）；**未决策/材料缺失/解析失败 ⇒ 一个 flag 都不加**（零行为变更，禁止默认 approve）；
  每轮 `prepare()` 现读决策 ⇒ 撤销下一次 spawn 即生效。目标主机 pi 0.85.1 已实测两个 flag 存在且语义正确。
- 渲染层：会话头部提示条从"只告知"变四态 + 决策/撤销；设置页「远端信任」清单；三通道 `remote:trust-list|set|clear`；**渲染层结构上不含指纹/known_hosts 摘要/endpoint 摘要**
  （`RemoteProjectTrustEntry` 装不下，另有源码级守卫）。静态标记 `remoteTrustUnhandled` 保留作"是否渲染提示条"，含义改为"该会话 trust 由 PiDeck 决策表管理"。
- 验收判据（**不需要模型配额**）：远端项目放 `.pi/prompts/trustprobe.md`，`--approve` 时 `get_commands` 里出现该模板、无 flag / `--no-approve` 时不可见；
  另加既有日志 `Remote pi runtime plan prepared { args }` 断言 args 有无 flag（真机 e2e 步骤待补）。
- **未做**：远端 pi 版本门（本机 `supportsTrustFlags` 无远端对应物）、多窗口并发 CAS、主机删除 UI（生产无可达 retire 入口）、真机 e2e 步骤。

**P4.5b 已实现（远端归档 / 取消归档 / 列出归档）**

- 归档：远端文件 `mv` 进**文件所在目录旁的** `.pideck-archive/`（`mkdir -p` 后 `move` 两步；同目录 ⇒ 同一文件系统 ⇒
  rename 原子；扫描口径本就跳过该目录名），成功后才在本机落**归档索引**并把记录移出 catalog。远端**数据不删**。
- 取消归档：**不能沿用本机路径契约**（本机通道的入参是 `.pideck-archive/*.jsonl` 本机路径，远端没有这种路径）。
  选择：catalog 持久化一份**远端归档索引**（`archivedRemoteSessions`：sessionId + hostId + projectId + title +
  originalRemotePath + archivedRemotePath），恢复按 **本机 catalog 会话 id** 走新通道 `sessions:catalog-unarchive-remote`；
  两个绝对路径**归档时就落盘**，恢复不再重算会话根（会话根可能已被改过）。
- 列出归档：远端条目只来自**本机索引**，远端归档区**不扫描**（列一次归档 = 一次 ssh 往返 + 会话根探测，而索引就是权威）。
  条目带 `archivedRemoteSessionId`，**不带** `originalPath`（本机字段里不出现远端路径）。
- 运行中**先判后发**：`sessionRuntimeCoordinator.getTarget/isActivating` 命中时一个远端命令都不发，抛 `session.remoteArchiveStopFirst`
  / `session.remoteUnarchiveStopFirst`（可执行文案：先停 Agent），稳定码 `REMOTE_SESSION_ARCHIVE_BUSY` 进日志。
- 路径判据与读取侧**同源**（`resolveRemoteSessionPath` / `validateRemoteSessionHistoryPath`，绝对 + 规范化 + 拒单引号）；
  `[ ! -e '<目标>' ] &&` 保证**不覆盖**已有归档/同名活会话；失败即停不重试、只回稳定码（stderr 不外传、日志不记路径/命令）。
- 证据：`tests/remoteSessionArchive.test.mjs`（真实 `SessionCatalog` + 真实 `registerSessionIpc` + **按真实 mkdir/mv 语义执行的假 SSH exec**）：
  两步顺序、移动结果、索引与列表（含重启后仍在）、恢复与「恢复后记录重建」、运行中拒绝且零远端命令、
  路径非法（相对无根 / 含单引号）零命令、失败不覆盖不谎报成功、本机归档/取消归档行为不变。

**P4.5b 明确没做 / 已知缺口**

1. **删除归档（真删远端数据）不做**：远端没有回收站，`rm` = 永久删除，按 §0 属另一件需二次确认的显式动作。
   fail-closed 由构造保证：渲染层的远端归档行只带 id（远端路径不过 IPC），`sessions:catalog-delete-archived` 只接受本机
   归档路径并交给 `sessionScanner.deleteArchived`（它拒绝不在本机扫描根 `.pideck-archive/` 内的路径），远端写面里没有任何 `rm`。
2. 同级子会话目录（`<stem>/`）不随远端归档一起移动（本地归档会移动它）：本批只移动会话文件本身。

**P4.5b UI 与真机收口（2026-10-12）**

- 管理列表接受已有文件身份的 SSH 会话；`sessionRecordToSummary` 保留 locator，远端路径仍不进入 filePath。
- 归档视图按 catalog projectId 过滤远端条目，恢复传 `archivedRemoteSessionId`，不要求本机 originalPath。
  单行删除按钮隐藏，行复选框禁用，全选/批量最终执行也排除远端条目；本机与 DSH 行保持原行为。
- 真机定位到恢复后空白的根因：新 SSH 记录 `messageCount=0` 表示未读取摘要，而非无历史；
  `isKnownEmptySessionRecord` 对已有 SSH 文件身份的 active 记录不再短路读页，草稿仍保持原空态。
- 验证：类型检查通过；相关 63 条单测通过（含摘要投影与空态判定的红→绿回归）。
  `e2e/remoteSessionAcceptance.spec.ts` 真机 **2 passed (2.4m)**，默认覆盖运行中拒绝归档并保留记录、
  归档→列表→恢复 UI 往返、远端文件确实移走/移回、两次 SHA-256 不变、恢复后新记录读回 prompt 与回复。
  证据日志 `/tmp/p45b-ui-acceptance-final.log`；失败定位证据 `/tmp/p45b-ui-third-failure/`（修复前恢复后空白）。

**哪些是推测**：上表「有运行实例的改名」仍是读码推断（只发 RPC、无本机守卫），没有真机复跑；
fork/clone 的**身份链**（RPC → fresh state → 新 ssh record → coordinator 换绑 → 旧记录不动）已有真实 catalog/coordinator/AgentManager 行为测试覆盖；
**真机实测（2026-10-12）**：fork 的语义已用协议级探针查明（pi 立刻换身份、文件懒创建），应用侧换绑与「原文件不变」已在真机验证；仍**未真机验证**的是「新会话首次追加消息后新文件出现且历史读得回来」（远端 pi 模型配额用尽，跑不动完整回合）。
P4.5b 的单会话归档/恢复已完成真实 Electron＋SSH 验证，不能据此声称 fork/clone 或子会话目录也有 parity。

## 权限与冲突加固（2026-10-13，已交付）

- **范围**：只加固消息 edit/delete/resend，不合并 dev、不升级依赖、不扩展代码文件编辑器/Git/终端，也不移动归档子会话目录。`RemoteSessionWriteGuard` 用固定 Node 标准库脚本，经既有 pinned SSH；Node 来自 `remotePiRuntimeFacts`，没有 PATH/本机解释器兜底或新 helper op。
- **生效约束**：首块 `umask 077` + noclobber 排他创建，上传为 `0600`；读前/实际读回摘要/读后/提交前核对 mode/size/dev/ino/uid/gid/mtimeNs/ctimeNs/SHA-256。临时文件摘要和大小也须匹配；uid/gid 不一致拒绝，成功替换保留原 mode。输入、输出都保留 **256 KiB** 上界。
- **冲突 UX**：稳定码 `REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED` 经现有 `SESSION_COMMAND_FAILED + debugDetails` 包络承接；双语提示外部修改未被覆盖、请重载，不改公共错误码表、不自动重试。失败残留 temp 不自动删除，提交失败会尝试恢复为 `0600`。
- **回归证据**：新增 16 条生产命令 POSIX 回归先全红，最终扩展为 **24/24**；完整相关 14 文件 **227/227**，typecheck 与 spec `--list` 通过。Biome 只格式化触达文件；构建只做受影响的 main/preload 和 renderer，不执行全仓库构建/生成清单。
- **真实 Electron＋SSH**：默认产品路在本次专用会话上传期间外部追加一条合法 custom entry，断言外部内容逐字节保留、请求的新正文未提交、重载提示可见、残留 temp 为 `0600`；重载后旧内容仍在，原有 edit/resend/delete 内容语义门禁继续通过。每种改写后都检查原文件仍为 `0600`。最终构建版本 **2 passed（4.2m）**，`/tmp/remote-write-hardening-ui-final.log`；前一次正确构建 **2 passed（4.4m）**，`/tmp/remote-write-hardening-ui2.log`。首轮停在启动画面是定向 renderer 构建漏了 electron-vite production 初始化；修正构建后再测，不改产品或弱化断言。
- **证据保留**：`/tmp/remote-write-guard-red.log`（初始16条红）、`/tmp/remote-write-hardening-regression.log`（227条）、`/tmp/remote-write-hardening-ui-final-artifacts/`（trace 与 JSONL 附件）；`/tmp` 无长期保留承诺。
- **边界不外推**：最终版本复核到 rename 之间仍有非协作写者竞态，不是内核 CAS/严格跨机器互锁。提交后 SSH 回执丢失可能结果未知，须重载核对；ACL/xattr 未复制/验证，跨平台、真实参考图和工具过程链未在本切片验收。超256KiB仍明确拒绝，不截断覆盖。
- **dev/版本集成风险**：本切片从 `dd35b2f0f` 开始；核对时本分支独有157提交、origin/dev独有764提交（`7fb3d74b4`）。本机 pi 为 **1.2.0**，本分支 pi-ai 依赖 **0.86.1**，dev 为 **1.2.0**，本轮真机远端仍为 **0.85.1**。此组合下本切片验收通过，但不证明 dev 合并或远端 pi 1.2.0 兼容；会话文件结构、RPC事件/模型/扩展、trust flag、打包与迁移应在单独集成批次验证，不能把代码堆完后直接声称可合并发布。

## 远端代码文件编辑保存（2026-10-14，已交付切片）

- **可用入口**：无会话时的远端项目面板，以及已有会话的右侧文件抽屉；两处复用 `RemoteFileEditor`。点已有文件打开CodeMirror，修改后点「保存远端文件」或Ctrl/Cmd+S，明确不自动保存。项目标题去掉旧「只读」标签；目录/文件名搜索仍是原只读helper。
- **身份与安全**：两个新IPC在shared/preload/main同源，renderer只发projectId、相对路径、正文与不透明令牌；main解析SSH locator值快照，版本绑定窗口/项目/主机/根/路径/host store代数/源文件版本，令牌30分钟、总上限128，窗口销毁撤销。每块在pin/route构造前后复核代数，主机资料变化后重建旧held，不向新路由使用旧Node。所有远端I/O经已有pinned SSH、已验证Node和单主机操作锁，不新增helper op或pi API桥，不走本机fs兜底。
- **文件约束**：仅Linux远端已有普通UTF-8文本，256 KiB字节上限，支持BOM及一致LF/CRLF；NUL/无效编码/混合换行/裸CR/软链接/越界拒绝，超限不截断。固定Node命令用`/proc/self/fd`锚定非链接父目录、`O_NOFOLLOW`打开叶；上传同目录随机排他0600临时文件，复核原文件摘要/身份和上传内容/uid/gid，再恢复mode、fsync和rename。上传块3072 B，为长路径保留8192字符命令预算。
- **草稿规则**：Jotai按项目＋相对路径保存最多5个内存草稿，单文件256 Ki字符预算；不驱逐脏文件或在途IO。失败打开的干净空条目可回收，避免点5个二进制文件永久占满预算。切文件/项目/关抽屉与保存失败不丢草稿；保存期间继续输入，完成只推进旧请求正文基准。冲突/断开/回执未知/令牌过期不自动重试，需重新加载核对；丢弃脏草稿前确认，重载失败保留原草稿。退出应用不持久化草稿，界面提示先保存/复制。
- **不能外推**：不是文件系统CAS/严格跨机器互锁；最后复核→rename间仍有非协作写者竞态，提交后回执丢失或读回失配可能已提交。失败temp不自动清理，rename失败尝试恢复0600；ACL/xattr不复制、硬链接其他路径不同步。没有新建/删除/重命名、批量/watch、Git、终端、安装包或跨平台客户端验收，也未合并dev/升级依赖；仍是显式开发态实验功能，不是Remote v1。
- **回归**：18个针对性测试文件 **202/202**，项目typecheck、触达文件Biome、spec `--list`与diff检查通过。回归包括源/结果超限、编码/BOM/换行、600/640/644、同长度/追加/替换inode/chmod/删除和上传期修改、私密残留、权限/rename失败及提交后读回失配、引号路径、身份冻结/窗口/代数/过期令牌、host变更发生在pin构造期间、项目/草稿隔离、迟到结果与保存期输入；本机编辑/引用/抽屉及原远端读面门禁保持绿。
- **真实Electron＋SSH**：新增默认代码文件用例验证明确保存→远端字节相等→重读、BOM/CRLF保留、外部改写拒绝且草稿跨文件导航保留、取消/确认重载、双项目同名隔离、手动断开不隐式重连/写、显式重连重载、已有会话文件抽屉可达。随后远端Agent真实read源码并bash运行`node test.cjs`；从专用JSONL关联bash toolCall和成功toolResult，不能只凭模型口头成功。最终main/preload＋renderer构建复跑 **3 passed（5.5m）**，此前完整跑 **3 passed（4.1m）**；补齐提交后异常不得谎称拒绝覆盖的生产回归后，仅重建触达main/preload并复跑代码用例 **1 passed（1.2m）**，原会话历史/fork/消息edit/resend/delete/冲突/trust断言未降低。仅操作并清理本次唯一e2e目录。
- **失败考证**：连接页在切项目重建helper后可能显示上次显式操作的断开状态，测试先显式连接再断开；项目组展开后中心hover不在标题浮层，夹具改hover真实`.project-draggable`，不force点击。Agent bash继承的系统Node仍是旧版本，`node:assert/strict`报MODULE_NOT_FOUND；模型虽口头输出成功，工具oracle正确报红。测试夹具改用旧Node也支持的标准`assert.strictEqual`后实际工具执行转绿，不修改服务器Node/PATH。首次抽屉选择器错用了button而实际rail是tab，改走真实标题栏开关与rail断言；均未弱化产品断言。
- **证据**：`/tmp/remote-file-editor-regression-final.log`（202项）、`/tmp/remote-file-editor-typecheck-final.log`、`/tmp/remote-file-editor-ui-final-build.log`（最终3项）、`/tmp/remote-file-editor-ui-final-build-artifacts/`（完整trace、保存后源码及Agent JSONL）、`/tmp/remote-file-editor-ui-delivery.log`与`/tmp/remote-file-editor-ui-delivery-artifacts/`（最终代码用例）；`/tmp/remote-file-editor-ui1…ui5.log`及对应artifacts保留失败定位，`/tmp`无长期保留承诺。e2e独立严格检查发现既存`timeouts.stepMs`两处和fixture依赖类型错误，已与HEAD比对；新增`remote-file-editing.ts`自身无严格类型诊断，未扩大范围修旧错误。

## 项目归属 SSH 终端（2026-10-14，开发态最小切片）

- **实现与归属**：独立 `RemoteTerminalSessionManager`＋原生 node-pty 承载已验证绝对 SSH executable，复用 pin/route、主机操作锁和 Node 事实；固定 `/bin/sh -i`。renderer只提交projectId/main签发tab id，main解析host/root，并按窗口＋项目隔离，不走本机shell或把remotePath当本机cwd。Agent启动/替换/停止不换owner；独立PTY不因控制helper切项目根而关闭。项目空态与已有会话都可打开；首帧/失败态不展示或查询本机Shell候选。
- **启动与撤销**：可信root独立引用，启动前核对实际`pwd -P`，进程PATH只前置已验证Node目录、`ENV=`，不改服务器配置；私有nonce marker、32 KiB握手上限和30s启动deadline，超时即settle，迟到资源仅回收。SSH plan构造前后及立即消费时核对代数，原生spawn前重读project locator，已切主机/根则零spawn；禁用OpenSSH本地escape控制台，终端字节只作为远端shell输入。每次input/resize及1s巡检复核locator/host，host异步校验后还要重读locator。关闭、显式断开、host/project变化、窗口销毁和quit取消/回收；迟到data/exit无效。只撤销所属PTY，不做host级杀进程。
- **有界流与UI**：一包在途＋sequence ack，单包≤32 KiB UTF-8、queue≤256 KiB，128/64 KiB pause/resume，代理对不跨包；main replay与renderer buffer各128 Ki字符，未知tab不创建缓存。自然退出先交付最后输出再发exit。远端input≤16 KiB UTF-8、排队≤64 KiB/32次，总32 tab/每窗口16/同项目同窗口4（包括已退出tab，关闭后释放）；本机大段粘贴不套远端预算。显式connect不创建终端，ensure不重建已退出tab，用户新建才有新shell，不自动重连/重放。
- **真实Electron＋SSH**：最终main/preload和production renderer构建，终端专项＋原trust专项 **2 passed（3.2m）**（前次相同切片2 passed/3.0m）。两个本次专用项目分别证明cwd/输出/输入/PID隔离，往返项目同shell；在真实xterm运行UI保存后的`node test.cjs`，成功marker及exit code均核对；`stty size`为`11x156 → 9x107`。composer首键启动真实runtime后以及菜单关闭Agent后，终端PID均保持；关闭/手动断开/应用退出后经独立SSH确认对应前台shell死亡。断开后新建失败、无新tab，显式connect也不重建/重放，用户再新建才启动；所有写入/清理仅本次唯一夹具。
- **复现后修复**：后台`remoteHomeEnsuring`也经过内部connect函数，旧逻辑会解除显式断开；解除动作移到用户connect入口、锁内生效，后台读取拒绝，回归先红后绿。host校验await期间项目变更仍可input、provider超时后不返回让ensure悬挂、UTF-8切包切断emoji、本机粘贴误套远端预算，均有永久红→绿测试。新增首帧Shell断言在真实UI复现原生菜单闪现，改按project atom派生外观；重复验收复现runtime预热导致xterm重建/延迟聚焦抢走composer输入，保护已有输入焦点并配对取消RAF，保留完整composer文字与真实runtime判据后专项通过。
- **回归与门禁**：22个相关测试文件 **180/180**，覆盖主机/项目/窗口隔离、在途启动取消/超时、迟到资源、输入排序/UTF-8预算、背压/ack/replay、身份变化/异步竞态、自然退出末尾输出、verified spawn/listener清理、disabled零spawn、已有本机终端与远端文件/读面邻域；项目typecheck、触达文件Biome、spec `--list`和diff检查通过。只构建main/preload、renderer，未做全仓库build或生成扩展清单。新增`remote-terminal.ts`独立strict检查无自身诊断；依赖的未修改`remote-fixtures.ts:141`仍有既存`ProcessEnv`类型错误。
- **未通过的更广验证**：默认4用例跑出3失败/1通过，其中原会话和Agent执行代码测试因远端`Codex error: The usage limit has been reached`无正文；终端用例在手动断开保护处暴露上述产品bug，修复后最终终端/trust专项通过，**未宣称默认4项全绿**。本机`layout-terminal.spec.ts`两项停在不存在的旧“启动 Agent”入口（尚未挂载终端），已在独立HEAD `ef1a77eea`工作区仅构建相同main/renderer并复跑，基线同两处失败；不改旧断言，也不把它算本机终端实机通过。一次首次启动未出现tab的失败未稳定复现，现保留40s有界wait及即时产品错误toast捕获，不据最终单次成功宣称长稳。
- **证据路径**：`/tmp/remote-terminal-regression-verified.log`（180项）、`/tmp/remote-terminal-typecheck-verified.log`、`/tmp/remote-terminal-ui-verified.log`及`/tmp/remote-terminal-ui-verified-artifacts/`（最终两项trace/附件）。`/tmp/remote-terminal-ui-full-failed-artifacts/`和`/tmp/remote-terminal-ui-final.log`保留默认4项失败；`/tmp/remote-terminal-shell-menu-red.log`及对应artifacts、`/tmp/remote-terminal-focus-red-artifacts/`保留UI红例；`/tmp/remote-terminal-disconnect-red.log`、`/tmp/remote-terminal-unicode-red.log`、`/tmp/remote-terminal-native-paste-red.log`、`/tmp/remote-terminal-spawn-fence-red.log`、`/tmp/remote-terminal-ssh-escape-red.log`保留生产单测红例。`/tmp/remote-terminal-native-ui.log`与`/tmp/remote-terminal-native-baseline-ui.log`及各自artifacts证明旧入口基线问题；`/tmp`无长期保留承诺，临时基线worktree收尾删除，当前工作区不用stash。
- **不能外推**：初始cwd校验不是chroot，用户交互shell仍拥有远端账号权限；前台shell清理证据不保证杀掉主动daemonize/disown的后台任务。未实现`terminal.prepare`、launch ticket、manifest runner或统一launcher（总计划§6.5.2仍为远期设计），无shell切换/端口转发/后台恢复/自动重连/命令重放。仅Linux客户端→Linux远端实测，未验证Windows/macOS客户端、打包、dev集成或长稳；未新增依赖/升级pi，独立reviewer依赖环境仍不可用，本轮由主代理复核，不能声称独立安全审查通过。下一批仍是Git status/diff，再stage/unstage/commit；不是Remote v1完成或可合并发布声明。

## 远端 Git G1（2026-10-14，Linux 开发态只读）

- **选择与范围**：保留原生Git CLI，无新Git库、第二引擎、Agent代理Git或服务器安装。普通non-bare项目根仓库的status和按需双侧文本diff；gitfile/worktree/submodule/外置metadata/partial/sparse/split index与clean/process filter明确拒绝。helper升级1.7.0，新增可协商`git.status`／`git.workspaceDiff`，冻结hash与独立契约同步。
- **生效链**：main-owned `RemoteGitService`现读project locator与host-endpoint-root trust，经`remoteGitReadIpc`／既有status-diff IPC在本机repository解析前分流；仍复用verified SSH executable/pin/route与`withProjectSession`主机锁。只读请求要求host已ready，不隐式连接离线主机；窗口销毁、视图卸载、project切换与quit配对取消，精确helper requestId不由renderer自报。所有未实现Git IPC对SSH拒绝，注册handler测试证明零本机fs/process/Git与零remote write。
- **只读预算与执行面**：status1 MiB／4096资源，单侧UTF-8正文256 KiB，index16 MiB，metadata20000条／32层，stderr64 KiB，deadline30s。超限完整拒绝，不截断状态或伪造空正文。固定argv、shell:false、literal pathspec、no-optional-locks，清继承Git注入、关闭fsmonitor/pager/external diff/textconv；不设置safe.directory=*或自动改配置。root FD/普通文件no-follow、HEAD/index与正文前后复核；不声称内核原子快照或锁住所有外部writer。
- **UI与授权**：SSH抽屉只挂`RemoteGitPanel`，复用现有FileTree与FileDiffViewer；不挂原生repo发现、图谱、历史、refs watch、branch polling或fetch，也无stage/commit/discard/delete按钮。授权按钮明确说明此决策也会影响下一次pi加载项目`.pi`资源，但不授予Git hooks/filter；不自动批准。清除失败/断线快照，取消或丢弃迟到结果，明确connect不重放，用户刷新才继续。共享服务抑制已被root切换丢弃的旧helper shutdown事件，避免其冒充当前主机故障。
- **验证**：最终25个针对性测试文件 **207/207**，typecheck、触达Biome/diff检查、e2e `--list`、main/preload＋production renderer构建通过。核心真实helper子进程覆盖unborn/detached/conflict/rename/delete/intent/BOM/CRLF、执行面零触发、预算/无Git/非法数据、timeout/cancel/EOF/overflow实际进程组回收；IPC/renderer/main身份与能力负对照和本机Git/远端文件/终端/root邻域通过。
- **真实Electron＋SSH**：本次专用双仓库证明SCM分组、HEAD→index／index→worktree／空→untracked正文与独立Git/blob/file事实相符，二进制拒绝、双项目同名隔离、实际断开不隐式连接、明确connect不重放、手动刷新恢复。前后全部fixture文件SHA与mode/size/inode/mtime/ctime（包括HEAD/index/metadata/工作区）逐字一致，本机临时负对照repo的index字节/metadata与工作区文件不变。最终Git＋原trust专项 **2 passed（3.7m）**，Git本身不依赖模型或启动Agent；仅清理本次唯一夹具。
- **证据与失败口径**：`/tmp/remote-git-g1-regression-final.log`、`/tmp/remote-git-g1-typecheck-final.log`、`/tmp/remote-git-g1-ui-final.log`及`/tmp/remote-git-g1-ui-final-artifacts/`（独立前后oracle附件）。前三轮UI失败分别为per-project抽屉动画、新挂载连接设置页丢local state、状态文本带主机前缀；修正真实操作/选择器，不force、不改断言成恒真，保留`ui1…ui3`日志/artifacts。沿既有terminal验收先明确connect再执行实际disconnect；未顺手修设置页状态设计。`/tmp`非长期存储承诺。
- **仍未完成**：G2写面、history/branches/sync与所有危险历史操作、跨平台/长稳/打包、多窗口/dev集成和独立安全审查。真实UI未覆盖所有helper边界；完整默认模型/会话spec未重跑，旧模型额度和DSH问题不归因Git、也未因本次绿灯被解决。下一批按计划先stage/unstage并单独满足commit完整index确认／工程门禁；不是Git parity、Remote v1或发布完成。

## 远端 Git G2a（2026-10-15，单文件暂存／取消暂存）

- **范围**：用户确认[Git计划§5.4](remote-git-plan.md)后实施；普通Linux根仓库、单行stage/unstage。commit仍禁用，没有目录／全仓操作、discard/delete/history/refs/sync，不引库或升级Git/pi。原生本机Git与旧SSH写IPC行为不改，使用新封闭`git:remote-mutate-index`通道。
- **helper**：1.8.0、可协商`git.stage`／`git.unstage`，hash `86db736b3e6a20f4bd98d29c498d2b732ff8bb9a9f985da2cb0291dc1d4d94ff`；保持四builtin与64KiB源码上限，移除重复大行注释而非放宽门禁。root/gitdir FD锚定、排他官方index.lock、随机0700私有metadata/index context。原生Git负责add/reset路径／unborn rm--cached；原HEAD不移动、非选中mode/OID不变，工作区字节/metadata与属性前后核对，最后写本人lock、保mode/uid/gid、不chown、fsync/rename并回读核对。现读有效hooks/hooksPath/filter/签名/进行中操作，执行前后拒绝；private context冻结白名单配置，不让late配置/hook执行，也不在工程门禁失败时发布。skip/assume/split/sparse/non-stage0拒绝。
- **main与UI**：内存一次性令牌32hex、128条／15分钟，绑定sender/project/locator/hostRevision与helper的root/gitdir/index/HEAD/status摘要；内部expectation不下发renderer。首await前消费、刷新替换、断线/取消/窗口销毁/卸载/quit撤销。FileTree仅单行stage/unstage，即使误传callbacks也隐藏目录/discard/delete。写在途禁刷新和其他写；成功只读刷新，未知/失败清旧事实要求手动核对，不自动重试。stage取动作开始时最新整文件内容；不是旧diff内容的逐字节确认。
- **失败边界**：timeout/cancel/EOF回收真实进程组，确认回收后只清本次owned锁／artifact；外部锁不删，无法确认的temp保留。已发写请求的transport/timeout/cancel或发布后异常统一结果未确认，不自动reset/revert/GC/replay。原生add可能已生成未引用objects；崩溃可能留下index.lock，不能称未发布即远端零磁盘变化。没有跨文件HEAD＋index原子CAS，也不保证同账号恶意目录竞态/非协作writer。commit安全门禁仍单列，不用commit-tree/update-ref拼临时替代。
- **验证**：最终29文件 **246/246，5 suites，0 fail/cancel/skip**；typecheck、触达Biome/diff、spec `--list`、main/preload＋production renderer通过。真实helper覆盖unborn/rename/delete/intent/CRLF/autocrlf/FIFO/symlink、外部index/HEAD/hook/worktree/attributes并发、既有lock保留、hooksPath（含全局）/签名/merge/skip/split拒绝、timeout/cancel/EOF真实进程回收；main token owner/TTL/128上限/单次消费/host drift、UI未知结果和迟到成功不重放有回归。G1行为测试仅抽共享fixture，未删断言。
- **真实Electron＋SSH**：G2a首轮1 passed/1.7m；补stage后UI diff正文，最终G1只读双仓＋G2a **2 passed（3.5m）**。验证精确stage→diff→unstage、untracked与rename取消、unborn另一条暂存blob保持、外部index SHA不被覆盖、hook零执行、签名和锁拒绝且锁内容保持。HEAD不动，工作区SHA/mode/size/inode/mtime/ctime与本机对照index/文件前后不变；独立原生Git/blob事实与UI匹配，两项`CLEANUP_OK`。不启动Agent、不依赖模型、不碰原有用户仓库。
- **证据**：`/tmp/remote-git-g2a-regression-final.log`、`/tmp/remote-git-g2a-typecheck-final.log`、`/tmp/remote-git-g2a-build-main.log`、`/tmp/remote-git-g2a-build-renderer.log`、`/tmp/remote-git-g2a-ui-final.log`与`/tmp/remote-git-g2a-ui-final-artifacts/`（独立oracle附件）。红例write/ipc/view保留；中期错误归类/重复builtin/source-size失败通过修代码／去重复注释解决，未放宽断言；真实UI两轮均通过，DSH旧错误仍存在。`/tmp`不承诺长期保留。
- **后续**：commit完整index确认/expected HEAD门禁未满足；优先跨平台和稳定性。Windows/macOS、长稳、多窗口、打包/dev集成、独立安全审查及G3–G5仍未验收；无法提供对应平台就明确记缺口，不把本次Linux绿灯当作Remote v1完成。完整默认模型/会话spec亦未重跑。
