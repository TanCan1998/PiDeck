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

## 远端 Git G6a（稳定性切片，不是完整 G6）

- **产品修复**：重复断线／重连状态以及失败的手动刷新，会把 `GIT_WRITE_RESULT_UNCONFIRMED` 覆盖成普通连接错误；两个永久红例先复现。`remoteGitViewState.ts` 现在保留该警告直到成功显式刷新，迟到写成功仍丢弃，不自动读写重放。不扩大远端能力、不变更 IPC／helper 协议；helper 保持 1.8.0 和 G2a hash。
- **新增生产链回归**：`tests/remoteGitStability.test.mjs` 通过真实 controller→注册 IPC/service→主机锁→NDJSON client→本机 helper 子进程→原生 Git，模拟已发布 index 的回执丢失和 generation 切换，核对真实 blob 已生效但写请求不重放、离线刷新不能清未知提示。两个逻辑 sender 同 revision 并发只发布首个、第二个 stale；锁队列取消零写且另一 sender grant 不受影响。Electron sender 和 withProjectSession 外层为替身，不能称真实双窗口或 SSH 故障验收。
- **短周期资源证据**：中文／空格／单引号根和相对路径，24 轮 stage/diff/unstage（48 写）逐轮 helper FD 数不增长、listener 保持 1、pending=0、host lock 释放、无 owned scratch/lock 残留；HEAD、其他 index blob、工作区内容与 inode/mode/size/mtime/ctime 独立核对不变。约 6 秒不是长稳或内存/RSS 证明。
- **平台测试**：旧 Windows resolver 测试在 Linux 查找真实 System32 失败，已保留日志；改明确 win32 path/fs 模拟，断言 SSH/SCP 绝对路径和打开关闭，新增缺 SCP 拒绝／不回退 PATH。产品解析器未改，Windows 原生四项依旧按平台跳过；没有 Windows/macOS 真机通过声明。
- **最终验证**：39 文件 **418 passed／5 skipped／0 fail/cancel，5 suites（423 项）**，约 19.1 秒；typecheck、触达 Biome/diff 与 production renderer 构建通过（没有重建未改 main/preload）。五项跳过为四项 Windows 原生＋未启用约 155 秒生存探针。真实 Linux Electron＋SSH 的既有 G1/G2a **2 passed（2.7m）**、两项 `CLEANUP_OK`，独立 oracle 不变；该真机复验没有注入网络丢包，不外推故障注入的真实性。
- **证据**：`/tmp/remote-git-g6a-warning-red.log`、`/tmp/remote-git-g6a-refresh-red.log`、`/tmp/remote-git-g6a-platform-transport.log` 保留红例／旧平台失败；`/tmp/remote-git-g6a-regression-final.log`、`/tmp/remote-git-g6a-typecheck-final.log`、`/tmp/remote-git-g6a-build-renderer.log`、`/tmp/remote-git-g6a-ui-final.log`、`/tmp/remote-git-g6a-ui-final-artifacts/` 保留最终证据。永久重跑命令与完整边界见 [Git 计划 §5.6](remote-git-plan.md)；`/tmp` 不承诺长期保留。
- **仍缺**：真实跨平台、双窗口／双实例、真实网络黑洞／延迟、小时级长稳、打包/dev 集成和独立安全审查。commit、G3–G5 和完整 Remote v1 不因本切片完成而解锁。

## 远端 Git G6b（2026-10-15，一次完整真实 SSH 1 小时通过，尚非稳定性收口）

- **交付**：新增 opt-in `e2e/remote-git-soak.ts`、`remote-soak-evidence.ts`、`remote-soak-policy.ts` 与原真机 spec 装配；只改测试，不改生产／helper／IPC／依赖和写能力。真实UI执行 pin/连接/项目登记、双项目周期切换、开关抽屉、Git刷新/stage/index-diff/unstage；一个项目根含中文／空格。`hour` 固定3,600,000ms，`smoke` 固定180,000ms，缺模式／非Linux在fixture前skip，非法模式失败。用 `--trace off` 避免小时级trace扰动，采样／失败截图和日志另存。
- **结果**：本机真实子进程生产 launcher 延寿探针 **7/7（约151.1s）**，不是SSH探针。smoke3 **1 passed**，主计时180,006ms，同helper观测180,006ms；hour2 **1 passed（1.0h）**，主计时 **3,600,017ms／120轮（240次正常index写）／122样本**，另有预热及一次中断写尝试。每5分钟切项目而正常轮换12个helper，最长同一身份293,146ms，不冒称同一helper持续一小时。每轮独立Git/工作区metadata语义oracle与本机对照保持，锁／scratch检查通过。
- **真实中断／清理**：重新核对本次Electron后代、私有pin/root、SSH executable和start ticks后仅中断一个本次SSH。实际出现未知写结果提示，明确断开／重连仍保留，SCM不自动重读、index SHA和inode/size/mode/mtime/ctime不变，手动刷新才恢复。两次通过运行的这次写均未发布，不算“已发布回执丢失”的真机证明。退出后无本次项目存活helper和已观测到的本地存活后代，专用根 `CLEANUP_OK` 且不存在；不扩展为daemon/disown清理承诺。
- **资源与风险（已由下方 G6c 更正）**：阈值在运行前固定、没有因结果放宽。main FD **240→253（峰253）**，RSS **495.7→547.1MiB（峰550.4）**；JS heap14.8→12.7MiB，renderer FD55→52／RSS328.9→300.1MiB，SSH FD恒7、helper FD恒21，本地后代最大5。原写的“main FD＋13／RSS约＋51.4MiB 仍未定位”是起止对比把首 2.5 分钟暖机阶跃与之后平台期混在一起；G6c 确认阶跃落在首次抽屉关闭→重开，后 55 分钟平坦，但这仍不是无泄漏证明。
- **不能抹掉的失败**：smoke1触发已有的单引号根trust拒绝，未改安全门；smoke2修正重开抽屉应明确选Git的操作假设。hour1第46轮后独立SSH/Git oracle失败并停止，47样本、截图和失败日志已存；原错误没有code/signal/stdout/stderr，无法确认是SSH超时还是残留检测，根因未定（G6c 复现出同类空 stderr 失败并拿到 `killed:true, signal:SIGTERM`——harness 自己的 20s 预算杀 ssh；hour1 本身仍不追认）。仅补诊断后重新独立完整跑hour2，后一次绿灯不是已修复首轮失败的证据。DSH旧错误未修。
- **检查**：5文件 **28/28**，typecheck、触达Biome/diff与spec `--list`通过。新e2e helper strict无自身错误；未改依赖 `remote-fixtures.ts:141` 的旧ProcessEnv类型诊断仍在。仅测试变化，未重建未改main/renderer或做全仓库构建。永久策略与所有权反例守住时长不造假、增长不放宽、非后代/他人pin/root/PID复用/非SSH/权限错误不发送信号。
- **证据与复跑**：详见 [Git计划§5.7](remote-git-plan.md)。`/tmp/remote-git-g6b-session-deadline.log`、`/tmp/remote-git-g6b-regression-delivery.log`、`/tmp/remote-git-g6b-typecheck.log`、`/tmp/remote-git-g6b-e2e-strict-final.log`；smoke1…3各自日志/artifacts，hour1失败日志/artifacts与hour2最终日志/artifacts均保留。`/tmp/remote-git-g6b-hour2-artifacts/metrics-summary.json` 是122样本派生汇总，原始JSONL仍在；`/tmp`不保证长期保存。
- **下一步门禁**：先处理 G6c 的剩余风险（暖机阶跃的产品归因、harness 传输超时下的重跑预算），再补Windows/macOS、真实双窗口／双实例、网络黑洞／高延迟、打包/dev集成与独立安全审查。commit完整index/expected HEAD门禁保持禁用；不把本次单轮小时验收当作完整G6或Remote v1完成。

## 远端 Git G6c（2026-10-16，暖机阶跃归因、稳态门禁与 harness 传输预算）

- **harness 传输预算**：验收主机是共用机器（80 vCPU／128 GiB，`load average 1.90 3.54 6.46`，10 个用户在线）。G6b smoke1 的失败在补上诊断后被坐实是 harness 自己的 20s `execFile` 预算杀掉 ssh（`killed:true, signal:SIGTERM`、stdout/stderr 空），不是仓库残留；hour1 的同形失败因早于诊断，只保留为“同类超时的可能”，不追认为已修复。本机各 20 次受限探测：oracle 形状命令中位 0.40s／最大 0.71s，`uptime` 中位 0.38s／最大 0.59s，20/20 成功。现在探针统一有界 60s 预算，预算自身结束时抛 `SOAK_PROBE_TRANSPORT_TIMEOUT(<label>)`，>5s 打印 `slow-probe=`；断言一条未改，产品代码零改动。
- **暖机阶跃的真实身份（更正 G6b 的读法）**：原先写的“240→253 FD／+51 MiB 未定位增量”是起止对比把一次性阶跃与平台期混在一起。逐步骤采样（idle/refresh/stage/diff/unstage/drawer/pre-drawer）加完整 FD 清单（116→124 kind、列合计 263→271 与真实 FD 总数相等）显示：四次运行里阶跃落在不同相邻动作（oracle 窗口、纯 idle 等待、stage→diff 窗口），时间却一致落在 soak 后 92–125s，故与 soak 动作无关；+8 FD 全是 `/tmp/.org.chromium.Chromium.<随机> (deleted)` 共享内存段，没有任何 pipe／socket／inotify／仓库文件，主进程 JS heap 在该步不变。抽屉动作本身实测零变化（271→271 FD、550→551 MiB）。只到“Chromium 浏览器进程懒分配、约在应用运行 2.5–3 分钟”为止，**未归因到具体产品代码路径**。
- **steady-state 门禁**：长跑在“相对起点的绝对预算”之外，再用 settled（≥300s）基线逐样本判定：main/renderer FD +4、main RSS +32 MiB、renderer RSS +48 MiB、main heap +24 MiB、renderer heap +48 MiB、后代 +1、SSH FD ≤16、helper FD ≤32，首个越界样本即失败；smoke 窗口不足不套用。预算取实测噪声数倍、约为“每轮泄漏 1 FD 或 1 MiB”一小时量的 1/20；HEAD 无该门禁（导出计数 0）为红灯依据，测试同时守住“暖机阶跃不算泄漏”和“绝对预算看不出的慢泄漏必须被抓”。
- **最终验收**：带 steady 门禁的 hour 完整跑通 **1 passed（1.0h）**：主计时 3,600,017ms、120 轮／240 次正常 index 写、163 样本、`settledAtMs=306,213`；`steadyDelta={mainFd:0, mainRssMiB:-2, rendererFd:-3, rendererRssMiB:+7, mainHeapMiB:-0.2, descendants:0}`——后 55 分钟平坦，这是“不是持续增长”的直接证据。中断写实际出现“结果未确认”、显式重连不改写 index（该次写最终未发布）、退出后无存活本次 helper 或已观察后代、夹具 `CLEANUP_OK`。另有 smoke4／smoke5 各 1 passed（4.0m）验证新采样与清单。
- **自己的旧夹具**：主机上残留 `~/.pideck-e2e-e2emv7goca4`（10-14 旧 run，无 `.git`／锁／scratch）。按精确 runId 形状＋仅本套件四个 fixture 文件＋无特殊条目做归属校验后删除，输出 `OLD_FIXTURE_CLEANED`。
- **不能外推**：Chromium 共享内存的确切触发点仍未归因；Windows/macOS、真实双窗口／双实例、网络黑洞／高延迟、打包/dev 集成、独立安全审查与 commit 门禁均未完成。单次 hour 绿灯不是长稳全景，也不是 Remote v1 收口。
- **证据**：`/tmp/remote-git-g6c-smoke1.log`（harness 超时失败）、`/tmp/remote-git-g6c-smoke2…smoke5.log`（含 fdKinds 归因）、`/tmp/remote-git-g6c-hour1.log` 与 `/tmp/remote-git-g6c-hour-final-artifacts/`（最终 hour 报告＋163 样本）、`/tmp/remote-git-g6c-smoke5-artifacts/`（完整 FD 清单）、`/tmp/g6c-transport-probe.sh` 及运行输出、`/tmp/remote-git-g6c-unit*.log`、`/tmp/remote-git-g6c-steady-red.log`。细则见 [Git 计划 §5.8](remote-git-plan.md)。

## 远端 Git G2b（2026-10-16，单次受控提交，已真机验收）

- **交付**：helper **1.9.0**（冻结 SHA-256 `9ed9ccc5837bf92c476a74967205f310b1ce92bb30a95e0a43fb034ca2159145`，75,262 字符单行可打印 ASCII，仍只用四个 builtin）新增 `git.commit`；审阅阈值按计划 64 KiB → 80 KiB，只有阈值数字变了，单行／ASCII／四 builtin／双处 hash／每 method 契约测试全部保留（理由写在测试注释）。renderer 侧 `RemoteGitPanel` 增加有界消息框＋“提交已暂存的改动”按钮（无消息禁用、4096 字节计数）、`git:remote-commit` 通道、`status.commitToken`、中英文案与稳定码文案。
- **机制**：官方 `.git/index.lock` 排他 → 私有 scratch 复制已验证 index → `git write-tree` → `git commit-tree <tree> [-p <expectedHead>]`（消息经 `-F` 逐字送入；不执行 hook、不签名）→ 父链自检 → `git update-ref -m "commit: <首行>" <ref> <new> <old>` **原生 ref CAS**（unborn 用零 OID）→ 回读 HEAD 后才返回。**不发布任何 index 字节**（确认的 index 本就等于新 HEAD 的 tree；真机与单测都断言真实 `.git/index` 的 SHA+inode+mtimeNs 未变）。
- **门禁与语义**：hooks／`hooksPath`／filter／签名／进行中操作／非 stage-0 ⇒ `GIT_WRITE_UNSUPPORTED`（`commit-tree` 不跑 hook，所以有 hook 必须拒绝，绝不静默跳过）；`GIT_COMMIT_NOTHING_STAGED`／`GIT_COMMIT_MESSAGE_EMPTY`／`GIT_COMMIT_IDENTITY_REQUIRED`／`GIT_COMMIT_HEAD_CHANGED`／`GIT_INDEX_LOCKED`／`GIT_RESOURCE_CHANGED`；身份只读仓库配置链（本地优先、全局兜底），永不写配置。ref 移动后回读失败或回复丢失 ⇒ `GIT_WRITE_RESULT_UNCONFIRMED`，不回滚不重试；CAS 拒绝时不产生提交（可能留下未引用对象，不自动 GC）。token 现在带 `kind`：index 与 commit 的 grant 可同时存在、刷新只替换同类、跨类使用报 `GIT_RESULT_INVALID` 且不烧 token。
- **验证**：helper 级真实子进程＋原生 Git **13/13**；Git 面回归 **269/269**；typecheck、Biome、e2e strict 自诊断 0；真实 Electron＋SSH 的 G1＋G2a/G2b **2 passed（2.7m）**、两项 `CLEANUP_OK`——真机核对 HEAD 移动／父提交／`%B` 逐字（含 `#` 行与西里尔文）／reflog／`diff-index` 与 HEAD 一致／无锁与 scratch，并在 nothing-staged、hook（零执行）、签名三类拒绝后断言 HEAD 不变、其余文件 metadata 与 tracked.txt 内容/身份 witness 一致。
- **偏离与未完成**：计划里的 `commit.ready` 发现字段**未实现**（沿用 stage/unstage 的模型：能力＋grant 决定控件可用，门禁拒绝在尝试后如实报码），因此可能出现“按钮可用但点击被拒绝”。未支持 amend／merge／rebase／cherry-pick／`--allow-empty`／`-a`／签名／模型生成提交信息／push/fetch；被 CAS 拒绝可能留下未引用对象；Windows/macOS、多窗口与长稳、打包/dev 集成、独立安全审查仍未验收——本批**不是** Remote v1 收口。
- **证据**：`/tmp/remote-git-g2b-ui-final-artifacts/`、`/tmp/g2b-ui-final4.log`（2 passed）、`/tmp/g2b-regression-final.log`（269）、`/tmp/g2b-typecheck-final.log`；实现期失败留档 `/tmp/g2b-commit-red.log`（能力未接线）、`/tmp/g2b-commit-4.log`（稳定码被折叠成 IO_ERROR）、`/tmp/g2b-commit-5.log`（scratch 未清理）、`/tmp/g2b-ui-final{,1,2,3}.log`（抽屉已开、witness 与自身改写冲突）。机制设计事实来自 `/tmp/g6b-commit-probe.sh` → `/tmp/remote-git-g2b-write-shape-probe.log`。细则见 [Git 计划 §5.9／§5.9.1](remote-git-plan.md)。

## 远端 Git G3a（2026-10-16，只读历史／引用，已真机验收）

- **交付**：helper **1.10.0**（冻结 SHA-256 `f04c1c8773883d33b9c516cf175dafe39e80e242c768c1cdc309be521ae603de`，85,625 字符，96 KiB 审阅阈值最后一次上调、规则在测试注释）新增 `git.log`／`git.commitDetail`／`git.refs`／`git.refFileDiff` 四个只读方法（固定 argv、`%x1e/%x1f` 定界、超限整页拒绝、无网络／无 hooks／无 pager／不读 remote-tracking）；main 侧 `RemoteGitService` 四读方法＋逐字段重验、`remoteGitReadIpc` 四通道（无 token）、preload/previewApi；renderer 侧 `RemoteGitPanel` 历史与引用两个可折叠只读区（testid `remote-git-history(-row/-more)`／`remote-git-commit-detail`／`remote-git-commit-file`／`remote-git-refs`／`remote-git-ref-row`），两版本单文件差异复用 `remote-git-diff`。稳定码新增 `GIT_OBJECT_NOT_FOUND`。修复契约撞名：历史详情消息上限改名 `REMOTE_GIT_DETAIL_MESSAGE_MAX_BYTES`（与 G2b 提交输入 4096 上限区分）。
- **语义**：历史／引用**展开即加载、手动刷新**；每页 50、显式「加载更多」（失败页保留已显示行）；详情最后点击生效；`refresh`／写操作／断线让历史／引用／详情与快照事实同生共死，面板不混代显示，刷新后展开中的区重取（回到第一页）。无轮询、无 checkout／建分支／tag／推送控件；`remoteGit.historyReadOnly` 明示未开放；i18n 中英同步。
- **验证**：helper 真实子进程＋原生 Git `remoteGitHistory` **9/9**（每方法前后见证 index SHA/inode/mtimeNs＋全部 ref＋无锁无残留；非法 UTF-8／二进制／对象不存在／根提交／rename／`base: null`／两侧皆无／全部参数边界）；`remoteHelperEntry` 37/37（新增无 eval/Function、能力声明两次出现不变量）；IPC 11/11（越界参数开 SSH 前拒绝、helper 回复重验）；view 26/26；167 文件 **1720 项 1706 通过／8 skip／6 失败——6 项全为 HEAD 既有红**（1.6.0 钉住类×4、scanned-entry cap、非 git 目录 fetch，经干净 worktree 复现，非本批引入）；typecheck/Biome/`build:fast` 0。真机 `G1|G2a/G2b|G3a` **3 passed（4.2m）**：55 提交夹具逐行对照原生 `git log`、详情消息与 `cat-file` 逐字节一致（含 `#` 行）、rename `R100`＋oldPath、两版本两侧＝`git show`、refs 含 annotated peeled 提交、写控件计数 0、刷新重建事实、index/refs/HEAD/工作区前后不变、远端 `/tmp` 零残留。
- **偏离与未完成**：独立复核车道未执行（子智能体基础设施失败：async 缺 `@earendil-works/chord`、同步 worker stream 中断，主代理按车道边界顺序实施并自审）；refresh 后分页位置不保留；rename 文件旧侧按单 `path` 契约显示为空。checkout／建分支／tag 写、compare、fetch/push、Windows/macOS、多窗口、长稳、打包集成、独立安全审查未验收——不是 Remote v1 收口。
- **证据**：`/tmp/g3-e2e-final.log`、`/tmp/g3-full-regression.log`、`/tmp/g3-entry-final.log`、`/tmp/g3-ipc2.log`、`/tmp/g3-viewstate3.log`、`/tmp/g3-head-red{,2}.log`（既有红复现）。细则见 [Git 计划 §5.10／§5.11](remote-git-plan.md)。

## 远端 Git G3b（2026-10-16，分支写面：新建分支／切换，已真机验收）

- **交付**：helper **1.11.0**（冻结 SHA-256 `a9196036c37108b6013907c80e11893fe5b085f40a5d6bff669f94551cff5621`，92,388 字符，96 KiB 阈值未再上调）新增 `git.createBranch`（`refs/heads/<name>` 原生 create-only CAS，零 OID 老值；不改 HEAD/index/工作树）与 `git.switchBranch`（原生 `git switch -- <name>`；工作区冲突由 Git 拒绝 ⇒ `GIT_SWITCH_CONFLICT`，绝不 force/discard；切换后回读 HEAD/branch + `git diff --quiet HEAD` 核对）。名字先 `check-ref-format --branch`（rc 1/128 皆为非法）再自拒 `@`／`@{`／`\`／控制字符／`refs/`／oid 形／伪引用名／超 1024 字节。**实测 `switch` 会执行 post-checkout hook**，故两者都先过既有 hooks/config 门禁：有有效 hooks／`core.hooksPath` ⇒ `GIT_WRITE_UNSUPPORTED` 且零执行。新稳定码 `GIT_REF_EXISTS`／`GIT_REF_NOT_FOUND`／`GIT_SWITCH_CONFLICT`（helper `stable` 与 main `ERRORS` 两侧同步）。
- **main／IPC／renderer**：`RemoteGitWriteExpectation` 增 `kind: branch|switch` 与 `head`（读回确认的 HEAD）；`status` 额外签发 `branchToken`／`switchToken`（同 kind 刷新替换、跨 kind 不烧、单次用、15 分钟、按 sender+项目绑定）；两通道由 main 注入 `expectedHead`，渲染层只给名字；引用区加 `remote-git-branch-name`＋`remote-git-create-branch`＋逐行 `remote-git-switch-branch`（当前分支不出现、非法名/无 grant/忙碌禁用），拒绝与未知结果沿用 G2b 语义（丢事实、保留告警、未知绝不重放）。不提供删除分支／重命名／tag 写／force／丢弃。
- **验证**：`remoteGitBranch` 13/13（真实子进程＋原生 Git；创建后 HEAD/index/工作树/其他 ref 不变、同名与 18 类非法名零副作用、stale/unborn、双 hooks 门禁零执行、干净切换工作树＝目标树且未跟踪保留、tracked/untracked 冲突皆拒绝且用户文件逐字节保留、同分支 no-op、新分支出现在只读 `git.refs`）；IPC 6/6；view 17/17；有界回归 **1742 项 1728 通过／8 skip／6 失败＝与 G3a 批次相同的既有红**（1.6.0 期钉住×4、scanned-entry cap、本地 fetch 集成），零回归；typecheck／Biome／`build:fast` 0。真机 `G1|G2a/G2b|G3a|G3b` **4 passed（2.9m）**，G3b 单项 1 passed（29.2s）：UI 建分支、UI 切换、dirty 拒绝且仓库逐字节不变、刷新重建事实、只多一个 ref、零锁与 scratch 残留、远端零残留。
- **偏离与未完成**：删除分支／重命名／tag 写、compare、fetch/push 未支持；切换不保留引用区分页位置（刷新重取）；未知结果不自动核对；独立复核车道未执行；Windows/macOS、多窗口、长稳、打包集成、独立安全审查未验收——不是 Remote v1 收口。
- **证据**：`/tmp/g3b-e2e-final2.log`、`/tmp/g3b-e2e-run8.log`、`/tmp/g3b-full-regression.log`、`/tmp/g3b-helper-all.log`、`/tmp/g3b-ipc4.log`、`/tmp/g3b-view3.log`；实现期失败留档 `/tmp/g3b-branch1.log`、`/tmp/g3b-e2e-run1..7.log`。细则见 [Git 计划 §5.12／§5.12.1](remote-git-plan.md)。

## 远端 Git G4a（2026-10-16，可恢复丢弃／删除，已真机验收）

- **交付**：helper **1.12.0**（冻结 SHA-256 `be042d1e33fe9ec24f7c96a7397431b596fd058e879cb5f01b208f918ecf36d2`）新增 `git.discard`：**先写快照再动文件**——`hash-object -w --no-filters` 原始字节 → scratch `read-tree --empty`＋`update-index --cacheinfo` → `write-tree` → `commit-tree` → `refs/pideck/recovery/<stamp>` create-only CAS → `rev-parse <ref>:<path>` 回读，然后才 `git restore --worktree`（workingTree）或无跟随 unlink（untracked）。快照提交身份是固定常量 PiDeck recovery（不读写用户 GitHub 配置）。`git restore` 跑在本 run 私有的 index 副本上，真实 index 一个字节不写；scratch 布局无条件建立，所以「撤销删除」（`" D"`，无快照）也可用。失败语义：快照前失败 ⇒ 不动文件、如实报码；快照后任何失败 ⇒ `GIT_WRITE_RESULT_UNCONFIRMED`。
- **main／renderer**：`RemoteGitWriteExpectation` 增 kind `discard`，`status` 签发 `discardToken`（同 kind 刷新替换、跨 kind 不烧、单次用、15 分钟）；恢复 ref 名经主进程白名单校验（只认 `refs/pideck/recovery/*`）；面板在 workingTree／untracked 行给出「回滚更改」入口，先内联确认（`remote-git-discard-confirm`／`remote-git-discard-cancel`），成功后 `remote-git-recovery-note` 显示 ref 与恢复命令（`recoveryRef: null` 表示只是撤销删除）；恢复提示跨刷新不被读操作抹掉。**没有**自动清理、面板内一键恢复（G4b）、批量丢弃、目录递归删除。
- **96 KiB 取舍**：本批正文一度 102 KB，未抬阈值，而是把冻结正文的解释性长注释压成一行式不变量、长文迁到两个 frozen source 的 TS 侧文件头；压缩后 97,822 字符、余量 <500，行为代码零改动。测试注释写明：下一个放不下的特性必须拆分内嵌程序。
- **验证**：`remoteGitDiscard` 13/13（真实子进程＋原生 Git：CRLF／Unicode／空格路径字节逐字可取回、`text` 属性路径上原始快照 ≠ Git 转换后 blob 的对照、丢弃后工作区＝index 且 index 内容不变、删除后可取回、`" D"` 无 ref、超 8 MiB／符号链接／gitlink／stale／hooks／外部锁全部快照前拒绝零副作用、身份缺失仍可用、同名两次两个 ref、嵌套路径形态保留、零残留）；IPC 5/5；view 21 项；有界回归 **1764 项 1750 通过／8 skip／6 失败＝同一批既有红**，零回归；typecheck／Biome／`build:fast` 0。真机 `G1|G2a/G2b|G3a|G3b|G4a` **5 passed（3.4m）**，G4a 单项 1 passed（32.4s）：取消不动仓库、确认后备份可取回、删除未跟踪文件后可取回（CRLF 逐字节）、HEAD/分支/tag 未动、status 干净、恰好两个恢复 ref、零残留。
- **证据**：`/tmp/g4a-e2e-gate.log`、`/tmp/g4a-e2e-run4.log`、`/tmp/g4a-full-regression.log`、`/tmp/g4a-helper-all2.log`、`/tmp/g4a-ipc2.log`、`/tmp/g4a-view1.log`；探针 `/tmp/g4a-probe*.sh`。细则见 [Git 计划 §5.13／§5.13.1](remote-git-plan.md)。

## helper 多文件部署包拆分（2026-10-16，结构性改动，已真机验收）

- **为什么**：G4a 把单文件正文推到 97,822 字符（96 KiB 上限、余量 <500），而 G4b 必然要加代码；按已记录规则（§5.13、entry 测试注释）不再抬阈值，改为拆分。
- **拆成什么**：一个内容寻址 bundle 四个文件，各自审阅/哈希/钉住——`helper.mjs` 30,342（协议帧＋并发/取消＋只读 fs 批＋argv/root 两态＋Git 分发骨架，import `./git-read.mjs`）、`git-read.mjs` 31,565（只读 Git 批与共享执行器，import `./git-write.mjs`）、`git-write.mjs` 36,130（stage/unstage、commit、branch、discard 四个写程序工厂）、`remote-runner.mjs` 13,620（远端 pi 监督，本来就在同 bundle）。`frozenHelperBundleManifest()` 列出全部文件与各自 sha256，bundle sha 随内容变化。
- **不变量**：entry 测试改为逐 artifact——每文件 SHA-256 钉住、单行可打印 ASCII、无控制字节/`console.`/`eval`/`Function`/`require(`、<96 KiB、**只允许 import 审阅清单内的兄弟文件**、每能力在 CAPABILITIES 与分发各出现一次。`node -e <source>` 自测形态主动放弃（entry 依赖兄弟 import）：测试改为从文件启动整套 bundle，并断言相对 import 存在。
- **验证**：entry 37/37、bootstrap 部署 12/12、session 集成 78/78、workspace 端到端 49/49、Git 面全绿（除既有基线红）；有界回归 1764 项 1750 通过／6 失败＝同一批既有红；typecheck／Biome／build 0；真机五合一 5 passed（3.4m），真实 SSH 上传并激活四文件 bundle。
- **遗留**：真机 `~/.pideck/remote-host/bundles/` 已累积 11 个 bundle（bundle GC 不在本片范围，记录在案）；一次并行回归中 `remoteGitDiscard` 无身份用例返回过 `GIT_WRITE_RESULT_UNCONFIRMED`，未复现，按一次性抖动记录。细则见 [Git 计划 §5.14](remote-git-plan.md)。

## 远端 Git G4b（2026-10-16，恢复清单／一键还原／清理，已真机验收）

- **交付**：helper **1.14.0** 新增 `git.recoveryList`（一次 for-each-ref ＋ 每条一次 `ls-tree -l`；只服务「恰好一个路径的提交树」，外来 ref／多路径树跳过；上限 64，超出标 `truncated`）、`git.recoveryRestore`（快照字节写回同路径，只在目标不存在或与 index 一致时写入，写后逐字节回读；缺父目录拒绝）、`git.recoveryDrop`（`update-ref -d <ref> <oid>` 原生 CAS 删除）。三份 bundle 文件各自钉住；main 增 kind `restore`／`drop` 与三个通道＋逐字段重验；面板第三个可折叠区「恢复」（展开即加载、删除二次确认、结果提示 `remote-git-recovery-outcome`）；i18n 中英同步。
- **重大发现并修复**：G4a 那两次「并行回归偶发 UNCONFIRMED、无法复现」的真根因是**影子 index 连 stat 缓存一起拷贝**——缓存看起来是当前状态时 `git restore` 跳过写入，`git status`/`git diff` 又因同一缓存报干净（racy-git 假干净）。修法：影子 index 从 index 自己的 tree 重建（丢光 stat、`GIT_OBJECT_DIRECTORY` 指向真实对象库），判定改为「Git 自己的 worktree-vs-index 比较跑在无 stat 缓存的影子 index 上」（保留 `text`/`eol` 转换语义）；还原的覆盖保护同法。另修：`dropRecovery` 成功未 refresh 导致整块区（含提示）随快照清空而卸载；恢复列表与写共用 epoch 导致读作废写的回执（改独立 `recoveryEpoch`）。
- **验证**：`remoteGitRecovery` 9/9 ＋丢弃 15/15（含两条 racy 确定性回归）＋ helper 全套 144/144；并行批次连续 3 轮 135/135（此前会闪）；IPC 6/6；view 26/26；有界回归 1787 项 1773 通过／6 失败＝同一批既有基线红；typecheck／Biome／build 0；真机六合一 6 passed（4.0m），G4b 单项 1 passed（26.5s）。
- **遗留**：无自动清理/TTL（列表上限 64＋显式删除，对象由 Git 回收）；不做批量、不跨项目、不自动建父目录；`git log --all` 仍列出恢复提交；独立复核车道未执行。证据：`/tmp/g4b-e2e-gate.log`、`/tmp/g4b-full-regression.log`、`/tmp/g4b-helper-all-final.log`、`/tmp/g4b-rec-x2.log`（假干净现场）。细则见 [Git 计划 §5.15／§5.15.1](remote-git-plan.md)。

## 远端 Git G5a（2026-10-16，同步能力：helper＋main／IPC＋控制器已交付，面板同步条回退待重做）

- **已交付**：helper **1.15.0** 第四份 bundle 文件 `git-sync.mjs`（唯一网络代码）——`git.syncFacts`（上游全名＋ahead/behind＋**只有名字**的 remotes）、`git.fetch`（`--no-tags`、不 prune、只动 `refs/remotes/*`、前后指纹核对）、`git.push`（`--porcelain`、无 force／无 `--set-upstream`，三种拒绝措辞都归一到 `GIT_PUSH_REJECTED`）、`git.pull`（前置：脏工作区拒绝、分歧且未配置策略拒绝；`--no-edit`；冲突如实报码不 abort）。三动词都过 hooks/config 门禁、用 10 分钟预算。**身份链硬规则**：不注入 `GIT_SSH`／`ASKPASS`、不写 URL／配置、不碰 `~/.ssh`／known_hosts、不关 host-key 校验；远端 Git 用远端账号自己的身份链。main 三种 grant＋四通道＋逐字段重验；renderer 控制器与 i18n 齐全。
- **面板同步条已交付**：固定两行高度（facts ＋ 预留消息行）、推送内联确认、没有 remote／上游时在消息行说明且不写配置；抖动根因是「facts 由 effect 监视快照自动重载」与 `refresh()` 互相触发，修法＝facts 只在项目身份变化后读一次 ＋ `loadSync` 不受 `state.loading`／`state.mutating` 阻塞（自带单飞）＋ 几何恒定常量高度；显式手势（刷新／trust 通过）与动词成功后才重读。真机六合一回到 6 passed（3.9m），G1 等无写控件断言按新能力更新。
- **真机同步 e2e 已通过**：`e2e/remote-git-sync.ts`（run 内 bare remote＋第二工作副本扮演队友）走真实面板——同步条不显示远端路径、获取只动远端跟踪引用（计数随 fetch 变化、HEAD/工作区不动）、拉取快进把文件带回工作区、原生写脏后拉取被拒且文件不动、推送先确认（取消不动远端／确认后远端 ref == 本地 HEAD）；仓库自己配置合并策略后制造分叉，拉取如实报「冲突」且 `.git/MERGE_HEAD`／`UU tracked.txt` 留在原地（产品不自动 abort）。稳定关键是**以按钮可用性做时序**（token 在一次读取后才签发 ⇒ 等按钮 = 等快照就绪），加上「计数只在 fetch 后断言」「拒绝文案断言到面板错误行」。
- **验证**：helper 级 `remoteGitSync` 9/9、`remoteGitSyncIpc` 4/4、view 29/29（含同步）、helper 全链路 104/104、typecheck／Biome／build 0、真机 6 passed（4.0m）。证据：`/tmp/g5-sync8.log`、`/tmp/g5-ipc5.log`、`/tmp/g5-focused-final.log`、`/tmp/g5-e2e-gate8.log`、`/tmp/g5-probe2.sh`（原生事实）。细则见 [Git 计划 §5.16／§5.16.1](remote-git-plan.md)。

## 远端 Git G5b（2026-10-17，引用对比＋有界 refs polling 已交付；含两处 G5a 修正）

- **交付（helper 1.16.0）**：`git.compare {base, head}`（两个全名本地引用 → 有界变更文件列表；固定 argv `diff --name-status -z --find-renames --no-ext-diff --no-textconv`；1 MiB／4096 文件预算超限拒绝；结果携带解析时 OID，逐文件复用 `refFileDiff`；只读见证走 `unchangedRead`）。main 新通道 `git:remote-compare`（无 token、纯读、逐字段重验），renderer 引用区内「分支对比」区（testid `remote-git-compare` 系列）+ 逐文件既有 diff surface；i18n 中英同步。
- **有界 refs polling（renderer only，无新 helper op）**：15s 固定间隔，仅引用区展开＋窗口可见＋项目当前＋host ready＋已有 refs 事实时运行；quiet read（不清空行、失败留旧行）、单飞、手动 `loadRefs` 使在飞回答作废、收起/隐藏/切项目/卸载/断线清 interval、迟到回答按 epoch＋身份丢弃；不调用 `loadSync`、不新增 effect（`remoteGitSyncBar` 守卫保持绿）。与 §6.3 字面的 control-helper 事件推送存在偏差，已在契约 §5.17 显式记录。
- **两处 G5a 修正**：① **同步 10 分钟预算未接线**（独立安全审查 F1，medium）：main 传 30s、control client clamp 300s、helper 再 clamp 30s ⇒ 真实 fetch/push/pull 超 30s 即失败；三层同源修复（contract 上限 600000、helper 仅网络动词用 600000、`run()` 仅同步动词传 `REMOTE_GIT_SYNC_TIMEOUT_MS`），详见 [Git 计划 §5.16.2](remote-git-plan.md)。② **同步条显式刷新竞态**（本批真机门禁抓出）：`refreshAll` 并发 `refresh()`＋`loadSync()`，snapshot 的 update 重建 view state 会丢掉 sync facts，facts 先返回时同步条永久停在加载；修法 `refresh().then(() => loadSync())`。修复前 G5a 连续 3 次红，修复后 35.4s 绿。
- **验证**：Windows 定向 8 套件 **113/113**；WSL helper 真实子进程＋原生 Git **125/125**（含新 `remoteGitCompare` 套件）；typecheck／format／`build:fast` 0；e2e `--list` 8 tests；**真机八合一 8 passed（6.0m）**（G5b 单项 1.3m：对比行与原生 `git diff --name-status` 一致、rename 保留 oldPath、逐文件两侧内容等于 `git show`、可见时原生建 tag ≤2 间隔自动出现且不 fetch、HEAD/index/refs/工作区见证不变、`CLEANUP_OK`）；全量回归与干净 HEAD 基线对照零新增（见 Git 计划 §5.17.1）。
- **验证环境记录**：DSH 宿主注入 `ELECTRON_RUN_AS_NODE=1` 时须先清除再跑 Playwright；WSL git 2.53 首次 fetch 会创建 `refs/remotes/origin/HEAD`（已做测试兼容，非产品变更）；e2e oracle SSH 预算 20s→60s（G6c 传输预算教训），add-host 候选断言改为可等待 `toBeVisible`。
- **未完成**：`git init`／嵌套仓库发现；Windows/macOS、打包集成、真实慢网络（>30s 同步）未验收。细则见 [Git 计划 §5.17／§5.17.1](remote-git-plan.md)。

## G6 独立安全审查（2026-10-17，只读报告）

- 交付 `docs/remote-security-review.md`（独立只读审查，快照为 dirty tree）：**0 critical / 0 high / 1 medium / 5 low / 4 info**；明确列出 Phase 5 §12 安全门禁未满足项：terminal.prepare ticket、create-project、file rename/delete、remote config backend、跨平台 smoke、pack/upgrade-downgrade/power-loss。
- **F1（medium）已在本批修复**：见 Git 计划 §5.16.2（同步预算未接线）。其余 findings **未处理**：F2 bundle/TTL 清理、F3 terminal ticket、F4 `IdentityFile ~` 不展开、F5 会话写回执丢失文案、F6 会话路径 `./..` 校验，以及 F7–F10 info 项。审查文档 §0 记录快照与行号漂移，实施前须按当前 HEAD 复核。

## 远端文件管理冻结契约（2026-10-17，设计草案待签收）

- 交付 `docs/remote-file-management-plan.md`（**design draft — not implemented**）：补齐 Phase 5 缺失文件面——新建文件/目录、重命名/移动、删除（项目内 `.pideck-trash` 可恢复回收站）、回收站 list/restore/prune、新建空远端项目；机制决定沿用 main-built 有界 Node 命令（**不新增 helper op／不改 helper 版本与能力**）；8 条新 IPC＋enroll `mode` 扩展、18 个新稳定码、UI/testid/i18n 与真机 e2e 计划齐全。
- **11 项用户签收点**（文档 §14，均附建议）未答复前不动 src；其中删除恢复采用「项目内回收站（A）＋仅清空回收站才无恢复（C）」为建议方案。

## 远端 Git G5c（2026-10-17，显式远端 `git init` 已交付；helper 1.17.0）

- **交付**：`git.init {}` → `{ branch: string | null }`；helper 1.17.0（entry／git-read／git-write 三份 SHA 重钉，仍四个 bundle 文件，无新文件）。前置：`root/.git` 以任何形态存在（目录／gitfile／符号链接）⇒ `GIT_REPO_EXISTS`；`git rev-parse --git-dir` 成功（父级仓库 governs 本目录）⇒ `GIT_REPO_EXISTS`，均零磁盘变化；执行固定 argv `git init --quiet` 走既有净化执行器（无 `--template`／`-c`／config 覆盖、不联网、无 hook/filter 执行点）；派发后从磁盘核对 `.git` 为非链接目录且在 root 内、root dev/ino 未变、无 `.git/index.lock`，再用原生 `symbolic-ref --short HEAD` 读分支。派发后异常 ⇒ `GIT_WRITE_RESULT_UNCONFIRMED`（不重试、不回滚、不删 `.git`）。新稳定码 `GIT_REPO_EXISTS` 四处登记（helper frozen `stable` Set／contract／main `ERRORS`／renderer 错误映射与中英文案）。
- **main／IPC／renderer**：`RemoteGitService.init(projectId, signal)` 复用同一 `run()` 边界（live locator＋现读 trust＋host ready＋hello capability＋assertCurrent）；新通道 `git:remote-init`（`gitRemoteInit`，只收 projectId，无 token——没有可绑定的已确认仓库状态，但丢回复仍按写面计 UNCONFIRMED）；preload `initRemote`＋previewApi stub。控制器 `initRepository()` 单飞＋代际围栏（`mutatingKind: "init"`、`initializing`、`initNotice`），仅在 `GIT_NOT_REPOSITORY` 可用；成功 refresh 读回新仓库事实，未知结果保留告警、不自动刷新、永不重试。面板内联确认入口的 testid：`remote-git-not-repository`／`remote-git-init`／`-init-confirm`／`-init-cancel`／`-init-outcome`；`notRepository` 文案保留「不会自动初始化、不搜索父目录」并给显式入口，中英同步。
- **验证**：Windows 定向 13 套件 **131/131**（lane）＋Lead 复跑关键 7 套件 **111/111**；WSL helper `remoteGitInit` **11/11**（空根/非空根/已存在/gitfile/符号链接/父仓库/hooks 零执行/重 init 拒绝/无残留）＋ init+read+write+compare **67/67**；typecheck／format／`build:fast` 0；e2e `--list` 14 tests；**真机九合一 9 passed（8.3m）**，G5c 单项 36.3s（取消不产生 `.git`；确认后原生 `.git` 是项目根自己的仓库、`rev-parse --git-dir == .git`、HEAD＝报告分支、现有文件字节不变且成为 untracked、初始化入口消失、重开抽屉不复活、无 index.lock、`CLEANUP_OK`）。全量回归与干净 HEAD 基线对照零新增：工作树 8291 项（8054 通过／31 败／206 skip）vs 基线 8261 项（8035／31／195），失败测试名集合完全相同（+30 测试，+11 skip 为 Windows 上 Linux-only `remoteGitInit` 平台守卫）。
- **未完成**：**嵌套仓库发现**（需要协议级 repo path 与独立 scope，下一批；本批未碰 `GitBackend`／`git:list-repos`）；Windows/macOS 客户端、打包集成、真实慢链路未验收；面板前置拒绝路径（已存在/gitfile/symlink/父仓库）无法经正常产品路径构造，由 helper 子进程套件确定性覆盖，不在真机 UI 伪造。细则见 [Git 计划 §5.18／§5.18.1](remote-git-plan.md)。

## 远端 Git G5d（2026-10-17，嵌套仓库发现＋只读 scope 已交付；helper 1.18.0）

- **交付（helper 1.18.0，仍是四个 bundle 文件；entry＋git-read 改，git-write／git-sync 字节不变）**：NDJSON 帧新增可选 `repo` 字段（项目相对 POSIX，`""`／缺省＝项目根）；entry 与冻结 `prepare` 双重校验——仅 9 个只读方法接受（status、workspaceDiff、log、commitDetail、refs、refFileDiff、compare、recoveryList、syncFacts），写方法＋`git.init`＋`git.repos` 传非空 repo ⇒ `GIT_RESULT_INVALID` 且零 Git 子进程。仓库锚定：从 root fd 逐段 `lstat` 不跟随＋`open(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`，`ctx.cwd=/proc/self/fd/<repoFd>`，请求结束关闭；缺失／非目录／符号链接 ⇒ `GIT_NOT_REPOSITORY`；空 repo 行为与原实现字节一致。新增 `git.repos {}`：项目根内有界发现（深度≤4、≤50 仓库、≤512 目录、固定 skip 名单＋隐藏目录、不跟随符号链接、`.git` 任意形态、根路径 `""`、根优先再稳定排序、`truncated` 只在真正截断时为真、只读、先于 `.git` 检查分发）。
- **main／IPC／preload**：新 `validateRemoteGitRepoPath`＋发现结果重验（拒重复/逃逸，不静默过滤）；`RemoteGitService.listRepositories`；新通道 `git:remote-repos`（无 token）；所有读通道新增尾随 repo 参数（status/workspaceDiff 兼容旧 `ProjectFileTarget` 形状），写通道签名不变并显式拒绝多余参数（零 host 工作）；**嵌套 scope 的 snapshot 签发 0 个写 token**——只读由主进程强制，不只靠 UI。
- **renderer**：`useRemoteGitRepos`（每项目身份一次有界发现；显式刷新与 init 成功后重载）；仓库选择器 `remote-git-repo-select`（≥2 个仓库或根不是仓库但有嵌套时显示）；repoPath 进 projectKey，切 scope 销毁并重建成新 controller；**所有读调用携带 repo**（workspaceDiff、历史/详情、refs 手动＋轮询、compare＋逐文件 refFileDiff、recoveryList、syncFacts、snapshot）；嵌套 scope 禁用 commit／新建/切换分支／丢弃／恢复 restore+drop／fetch/push/pull 与 init，只读说明 `remote-git-repo-readonly-note` 紧邻禁用控件；recovery 列表仍可读；i18n 中英同步。
- **顺带修复（真实场景必需）**：根仓库里存在**未跟踪的嵌套仓库**时，`git status` 输出 `?? dir/`（尾随斜杠产生空段），冻结 `relative()` 与 main `validateRemoteGitPath` 均拒绝 ⇒ 整个根 status 失败；已在 worker `resources()` 与 main `readRemoteGitStatus` 归一化（原始字节不入渲染层），根仓库状态在有嵌套仓库时恢复正常。
- **验证**：Windows 35 套件 354 项 214 通过／140 platform skip／0 失败（lane）＋Lead 复跑 8 套件 **124/124**；WSL helper 12 套件 **185/185**（含 `remoteGitRepos` 10/10）＋Lead 复跑 repos+read **32/32**；typecheck／format／`build:fast` 0；e2e `--list` 15 tests；**真机十合一（G1…G5d）10 passed（7.9m）**（G5d 单项 31.3s，G1–G5c 同一次运行保持绿，`CLEANUP_OK`；执行中修了两处作者侧 e2e 断言，非产品缺陷）；全量回归与干净 HEAD 基线对照零新增：工作树 8317 项（8070 通过／31 败／216 skip）vs 基线 8291 项（8054／31／206），失败测试名集合完全相同（+26 测试，+10 skip 为 Windows 上 Linux-only `remoteGitRepos` 平台守卫；唯一差集是旧 handshake 形状断言因可选 `repo` 字段缺省而更新，非产品回归）。
- **未完成**：**G5e 嵌套仓库写面**（stage/commit/branch/discard/recovery restore+drop/sync 及 token 绑定 repoPath；本批主进程拒绝且 UI 禁用）；Windows/macOS、打包集成、慢链路未验收；发现只在项目根内（不发现父级仓库、不跨根、不跟随符号链接）。细则见 [Git 计划 §5.19／§5.19.1](remote-git-plan.md)。

## 远端 Git G5e（2026-10-17，嵌套仓库写面已交付；helper 1.19.0）

- **交付（helper 1.19.0，仍是四个 bundle 文件；entry＋git-read 改，git-write／git-sync 字节不变）**：帧 `repo` 接受面从 9 个只读方法扩到 **9 读＋11 写**（stage／unstage／commit／createBranch／switchBranch／discard／recoveryRestore／recoveryDrop／fetch／push／pull）；entry 用 `REPO_METHODS` 集合先校验、冻结 `prepare` 用 `READ_REPO`＋`WRITE_REPO` 再校验，均在启动任何 Git 子进程之前拒绝；`git.init`／`git.repos` 仍只接受根。锚定机制不变（root fd 逐段 no-follow），所有写程序本来就是 `ctx.cwd` 相对（per-repo hooks／filters／config、index.lock、recovery refs 都在选中仓库内），因此 `git-write.mjs`／`git-sync.mjs` 源码字节不变。SHA 重钉：`helper.mjs` `7a77c38e…`（32,611）、`git-read.mjs` `e3773b24…`（44,662）；`git-write.mjs`（`e3a655b8…`）与 `git-sync.mjs`（`4b285dbb…`）未变。
- **main／IPC／preload**：`RemoteGitWriteExpectation.repoPath`；`status(projectId, repoPath)` 对任意 scope 签发全部 10 种 grant（G5d 的「嵌套不签发」撤销）；`run()` 在 locator／trust／withProject **之前**校验 `expected.repoPath === repoPath`（`GIT_TARGET_CHANGED`，零 host 工作）并把 repo 放进写请求帧；10 个写 service 方法、10 个 IPC handler、preload 方法都在 token 之后新增尾随 repo（`validateRemoteGitRepoPath`，开 SSH 前拒绝）；`tokens.take(senderId, projectId, kind, repoPath, token)`——scope 不匹配 ⇒ `GIT_WRITE_SNAPSHOT_EXPIRED`（不烧 token），kind 不匹配 ⇒ `GIT_RESULT_INVALID`（不烧）。
- **renderer**：controller 对全部 10 个写 API 附带 repoPath（根显式 `""`，不是 undefined）；移除 G5d 的嵌套禁用与只读说明（两个词典同时删除 `repoReadOnlyNote`）；嵌套 scope 显示与根相同的写控件；init 仍只在根 scope；仓库发现／选择器／scope 重置不变。
- **验证**：Windows 定向 383 项 223 通过／158 platform skip／2 个既有环境红（`remoteGitRecovery` 缺 Linux 守卫、`remoteSoakOwnership` 需 `/proc`，均与干净 HEAD 相同；lane）＋Lead 复跑 9 套件 **130/130**；WSL helper 13 套件 **195/195**（新增 `remoteGitScopedWrite` 10/10：嵌套仓库内 11 个动词、各自 bare remote 的 fetch／push／pull、跨仓库字节 witness、拒绝面）＋Lead 复跑 scopedWrite+repos **20/20**；typecheck／format／`build:fast` 0；e2e `--list` 15；**真机十合一（G1…G5e）10 passed（7.4m）**（G5d/G5e 用例 30.4s，G1–G5c 同一次运行保持绿，`CLEANUP_OK`；执行中修了三处作者侧 e2e 断言——根 witness 吸收嵌套 `.git/index`、strict-mode 多元素、信任按钮 `isVisible()` 竞态，均为测试健壮性、非产品缺陷）；全量回归与干净 HEAD 基线对照零新增：工作树 8329 项（8072 通过／31 败／226 skip）vs 基线 8317 项（8070／31／216），失败测试名集合完全相同（+12 测试，+10 skip 为 Windows 上 Linux-only `remoteGitScopedWrite` 平台守卫）。
- **未完成**：Windows／macOS 客户端、打包集成、双窗口／长稳、独立安全审查复核；嵌套 sync 只在 helper 级用本地 bare remote 验证，未走真实 SSH 慢链路；仓库发现仍只在项目根内。细则见 [Git 计划 §5.20／§5.20.1](remote-git-plan.md)。

## 远端文件管理 v1（2026-10-18，新建／改名／移动／删除＋回收站／清空回收站／新建空项目已交付）

- **交付（main／IPC／preload，遵循 [文件管理计划](remote-file-management-plan.md) §2.3 机制决定：不新增 helper op、不改 helper 版本）**：`RemoteProjectEntryCommands.ts`（固定 Node 命令、路径/名字/trashId 构造前校验、每操作命令数固定、BOUNDARY 重构为多锚点版；ENTRY/PUT/LIST ≤5,120，RESTORE/PRUNE 经批准的 6,100 例外，构造器仍 hard-gate 8,192）、`RemoteProjectEntryService.ts`（18 个新稳定码进闭集、entry 令牌绑定 sender/project/path/host 快照/hostRevision/kind/revision、30min/128、await 前消费、sender 写单飞、§5.3 stat 复核、写回执丢失 ⇒ `RESULT_UNCONFIRMED` 不重试）、`RemoteFileMutationTokens.ts`、`RemoteProjectCreateCommands.ts`（probe/mkdir pinned SSH，不建 helper 会话）、`remoteProjectEntryIpc.ts`（8 通道 + sender destroyed 撤销）、`remoteProjectCreateIpc.ts`（独立 create 确认 broker，命令数 3）。既有只读/编辑面配套：项目列表隐藏 `.pideck-trash`、搜索过滤、文件树/文本打开/保存拒绝回收站前缀；enroll 增加 create 模式（探针 3/4/5/6 + mkdir 退出码映射、canonical 复核后 `ProjectStore.addRemote`、mkdir 回执丢失 ⇒ `CREATE_UNCONFIRMED` 不重试）。
- **renderer**：`RemoteProjectPanel`（toolbar／行菜单／outcome／回收站区）、`RemoteProjectEntryDialogs`、`RemoteTrashPanel`、`useRemoteProjectEntries`（单飞、成功显式刷新、失败按码保留输入、未知不重放、rename/delete 后回收干净草稿并标 stale）、`remoteFileManagementState`（纯 reducer + 码→i18n）、编辑器 stale 提示、登记弹框 create 模式＋双推送订阅；zh/en 同步；§10.2 testid 全量。
- **语义（按计划建议方案，用户验收时可改）**：普通删除 = rename 进项目内 `.pideck-trash` 快照（可 list／restore／prune）；**清空回收站 = 显式无恢复的二次确认动作**（方案 C）；rename/移动限同一项目根、不覆盖、case-only rename 保留；`.pideck-trash` 对读面隐藏且文本读写拒绝；未知结果一律不重放。
- **验证**：lane 新增 35/35（POSIX 真实命令 11/11 在 WSL 临时目录执行生产命令、服务层 9/9、Windows IPC/状态机/create 15/15 含双令牌销毁）＋既有回归 WSL 65/65、Windows 50 pass/1 skip；typecheck／`build:fast` 0；e2e `--list` 16（新增文件管理用例）；**真机文件管理 e2e 54.1s 通过**（新建空项目→新建/改名/移动/删除+回收站还原/清空→同名再建，19 步，`CLEANUP_OK`；执行中修正作者侧三处断言：创建确认框 strict-mode、回收站 manifest 的 glob 引号、还原后同名再建前需先删除）。全量回归见末尾门禁节。
- **未验证**：真机 e2e、全量回归（Lead 见末尾）；打包/跨平台、真实大小写不敏感远端 FS、非协作写者 TOCTOU（既有写面边界）。

## 安全低危 F2/F4/F5/F6 修复（2026-10-18，helper 协议不变）

- **F2**：`RemoteBundleMaintenance.ts` 在确认激活后用既有 pinned SSH 通道跑冻结单行 Node 维护脚本——保留 active 与最新回滚快照，其余未被引用快照 ≤2 个且 ≤7 天；新增 1 小时并发连接保护；`.staging-*` 仅 >1h 且无 live deploy lock 才删；崩溃遗留 `.deploy.lock` 仅在持有者被证明死亡（pid + /proc start 身份）时删；不可验证目录/owner/mode 一律不删（fail-closed）；HOME 与 deployRoot 不一致时跳过；失败非致命只记稳定码。
- **F4**：`RemoteHostIdentityFile.ts` 将 SSH-config 候选里的 `~`/`~/...` 按**本机** HOME 展开（`-i` 参数是本地 OpenSSH 语义；计划/审查原文即本机），绝对路径规范化，`~user`/相对/控制字符/超长拒绝；host-add 返回专用 `REMOTE_HOST_IDENTITY_FILE_INVALID`。
- **F5**：新稳定码 `REMOTE_SESSION_HISTORY_WRITER_RESULT_UNCONFIRMED`——提交阶段 transport throw/非零退出/不可信 stdout 均视为「rename 可能已生效」；守卫脚本亲自报告的提交前失败仍保留原码（untrustedOutput 判别）；renderer/i18n 映射已由 Lead 应用（`sessionCommand.remoteWriteUnconfirmed` 中英，含「重新加载核对、不自动重试」）并加测试。
- **F6**：`validateRemoteSessionHistoryPath` 拒绝空段／`.`／`..`／重复分隔符；读、写、归档共用同一实现，命令构造在发远端前 fail closed。
- **验证**：Windows 定向 241（217 pass／24 POSIX skip）＋ WSL 71/71；F5 UI 补丁后 Lead 单测 5/5；typecheck 0。细则与残留风险见 [安全修复记录](remote-security-remediation.md)：F2 多客户端 lease（需 helper 协议变更）仍未做、真机多版本矩阵待补、F5 真实断线链路未测、F6 仅词法 canonical。

## 终端 prepare ticket + 固定 runner（2026-10-18，F3；helper 1.20.1）

- **交付（helper 1.20.1，五个 helper artifact；部署 bundle 六个 manifest 条目含既有 runner.mjs）**：新增冻结 `terminal-runner.mjs`（12,835 字符，`88f48c4b…`，0600 常规文件）与 `terminal.prepare` op。helper 从自身 argv `bundles/<64hex>/helper.mjs` 推导 deployRoot/bundleSha（扁平 dev helper ⇒ `TERMINAL_TICKET_UNAVAILABLE`；host-only 会话 ⇒ `TERMINAL_TICKET_INVALID`）；ticket 目录 `<deployRoot>/terminal-tickets` 0700 owner-only（lstat/no-follow、过宽则收紧、符号链接拒绝），ticket 0600 原子写入（temp 0600→link/rename+fsync）、JSON ≤4096、绑定 kind/projectId/hostId/routeDigest/canonical root/bundleSha/ref/120s expiry，仅返回 `{ticketRef}`；每次 mint 有界 sweep（≤256，只删过期/畸形 ref 票与自己的 stale temp）。参数只由 main 从 live session 构造（renderer 无法提供；host 不匹配在发请求前拒绝）。
- **runner 握手**：READY（stty -g 捕获 + stty -echo 成功后）→ main 写一行 base64url `{v,ticketRef}` → runner 原子消费（rename→claim，ENOENT ⇒ `ALREADY_CONSUMED`；O_NOFOLLOW、0600/uid、严格 key、expiry、bundleSha 对比、cwd realpath+isDirectory 复核），**每个路径都恢复 termios**，再输出 `START <base64url(shell)>` 并 `spawn` 账号登录 shell（`$SHELL` 须绝对路径+常规文件+X_OK+无参数/控制字符，否则 `/bin/sh`；argv0 `-<basename>`、cwd 来自 ticket、stdio inherit、shell:false），转发退出码；失败输出闭合 ERROR 码。main 侧 `SshTerminalSessionLauncher` 在 host 锁内 mint ticket、`withTerminalInvocation` 启动并在锁外完成有界握手（32KiB 预握手上限），START 后剩余字节恰好投递一次；`LocalTerminalSessionLauncher` 字节级保留本地/WSL 行为，`RemoteTerminalSessionManager` 继续独占 tab/replay/input/resize/close（仅移除私有 nonce-marker 握手）。
- **验证**：Windows 定向 70/70（entry 39/39：1.20.0、五 artifact pins、`terminal.prepare` 在 CAPABILITIES/dispatch 各一次）；WSL 真实 PTY + 真实 helper 子进程 15/15（runner 9：有效票/重放/过期/bundle 不匹配/cwd 变化/穿越/明文/超长帧/超时恢复 termios/不可信 ticket 目录；prepare 6：0600/0700/绑定、畸形参数零文件、扁平+host-only 拒绝、有界 sweep、chmod 收紧+符号链接拒绝）；typecheck／`build:fast` 0；e2e `--list` 16。既有 `remoteRunnerEntry` 的 Windows POSIX 用例红与本批无关（lane 记录）。
- **真机发现并修复（1.20.1）**：Windows 客户端 node-pty 的 **ConPTY 会剥离 C0 分隔符 RS(0x1e)/US(0x1f)**，保留 CRLF；旧解析按精确 `\u001e…\u001f` 匹配，READY 永不命中 ⇒ 未发 init ⇒ runner `TERMINAL_INPUT_TIMEOUT`，标签页停在启动中。修法：runner 每帧改为 `RS + 纯 ASCII marker [+ token] + US + CRLF`（Linux 保持原样），main 解析改为纯 marker 匹配、读到 CRLF 结束（容忍 RS/US 缺失、Linux ONLCR 的 CR CR LF、ConPTY 注入的转义噪声），START 后剩余字节恰好投递一次；ticket 绑定/TTL/0600/0700 与闭合错误码集不变。helper 1.20.1、`terminal-runner.mjs` 1.0.1（`0c9e382f…`，12,844 字符）。新增 ConPTY-loss 解析单测（RS/US 剥离、marker 跨块、CR CR LF、ERROR 变体）。真机终端 e2e 已由 Lead 通过（1.8m；项目隔离→保存代码测试→resize→关闭/断开/退出清理，`CLEANUP_OK`）。
- **未验证**：打包/macOS 客户端；agent-target ticket 变体不在本批（project-only kind，闭集）。

## 2026-10-18 夜间门禁（文件管理 + 安全低危 + 终端 ticket 批次）

- **真机十二项（G1…G5e、文件管理 v1、远端终端）12 passed（9.8m）**：Git 十项、文件管理 54.1s、终端 1.8m 同一次运行全绿，`CLEANUP_OK`；Windows 客户端→Linux 主机。
- **门禁暴露并修复的问题（全部有测试/复跑）**：① Windows node-pty ConPTY 剥离 C0 帧分隔符，终端 READY 永不命中 ⇒ 产品级修复到 helper 1.20.1/runner 1.0.1（详见上节）；② 终端 launcher 要求 session 携带 `hostRouteDigest`，`withProjectSession` 曾对无法提供 route 的只读链测试端口整段返回 `SSH_HOST_NOT_READY` ⇒ 改为「revision 不一致仍 fail closed；route 缺失只让终端拒绝 mint（空 digest），普通读不依赖 ticket」，复跑 read-chain／isolation／concurrency **23/23**；③ 作者侧 e2e 断言：信任按钮一次性 `isVisible()` 竞态（G5b/G5c/G5d 改为等「信任门或已就绪」）、根仓库 witness 误吸收嵌套 `.git/index`、创建确认框 strict-mode、回收站 manifest 的 glob 引号、还原后同名再建前需先删除、Git oracle 的 SSH 瞬时断连单次重试、终端关闭后远端 shell 收敛等待 20s→60s（仍为硬断言）。
- **全量回归与干净 HEAD `1606fc042` 基线对照**：工作树 **8413 项：8123 通过／30 败／260 skip**，基线 **8329 项：8072 通过／31 败／226 skip**；**失败集合里没有任何只出现在工作树的项（零新增）**，且基线唯一多出的红是「terminal command pins actual cwd…」（新 launcher 已替换该命令模板、对应测试同批更新，属预期消失）。+84 测试，+34 skip（Linux-only 套件在 Windows 的守卫）。
- **仍未完成/需人工**：macOS 客户端（无机器）、打包版人工 smoke、Linux 客户端长稳 soak（`PIDECK_E2E_REMOTE_GIT_SOAK` 仅 Linux 运行）、独立第三方安全 reviewer；功能面剩**远端配置后端**（models/settings + provider 测试/模型目录）与**远端会话真删**，见 [发布门禁台账](remote-release-gate-status.md)。

## 远端会话永久删除（2026-10-18，已归档远端会话的显式删除已交付）

- **交付**：shared 单一闭集 `sessionDeleteCodes.ts`（14 个稳定码）+ 两条 id-only 通道；main `RemoteSessionDelete.ts`（固定 Node 脚本只 unlink 会话目录旁 `.pideck-archive/*.jsonl`：lstat 普通文件非符号链接、父目录 canonical containment、unlink 前 `(dev,ino)` 复核、marker+JSON 回执；无标记/撕裂/非零退出 ⇒ `RESULT_UNCONFIRMED`；8192 命令上界+2048 脚本预算）与 `RemoteArchivedSessionDelete.ts`（`PendingConfirmationBroker` sender/60s/索引 digest 绑定、消费一次；运行中先判后发；in-flight 锁贯穿删除+清理；成功后才摘 `archivedRemoteSessions` 并清同身份墓碑）。sessionIpc 两 handler + sender destroyed 撤销；main 装配 pinned SSH，零新增 helper op。
- **renderer**：`remoteArchivedDeleteState` 纯 reducer（confirm 只能从 confirming、deleting 不可取消、unconfirmed 只能显式 acknowledge）、`useRemoteArchivedSessionDelete`（answer 抛错也按 UNCONFIRMED，未确认不刷新）、归档行内「删除（永久）」+ 不可恢复确认 + 未确认/失败内联提示与 testids；本机 pi/DSH 行回收站删除与批量排除不变；zh/en 11 条。
- **验证**：新增 17 项（main 11：WSL 真实脚本 unlink/拒符号链接 11/11，Windows 10 pass/1 skip；UI 6）；相关回归 Windows 143 pass/1 skip、WSL 39/39、spec guards 14 pass/1 skip；typecheck／`build:fast` 0；e2e `--list` 136/56（acceptance 仍 16，步骤级扩展）。真机门禁待补（见下）。
- **边界**：范围仅已归档远端会话（活动会话须先归档）；单文件 unlink 非递归 rm；检查→unlink 的 TOCTOU 与归档 move 同量级（文档与测试写明）；本机数据仍走系统回收站。

## 独立安全复审 round 2（2026-10-18，只读）

- 报告 [remote-security-review-round2.md](remote-security-review-round2.md)：**0 critical / 0 high / 0 medium**；round-1 的 F1（已修）、F2（已修，多客户端 residual 记录）、F3（project 终端 ticket 已实现；agent-target 变体仍缺）、F4/F5/F6 均确认关闭；F7–F10 仍为 info。
- 新发现 2 low + 3 info：**R2-1** `.pideck-trash` 未从 `remote:project-list`/`search` 过滤（与冻结计划/台账矛盾，内容读取仍被拒）→ **本批已修**：根 list 过滤该保留名、递归 search 按首段过滤整棵 trash、子目录同名用户数据与 `.pideck-trashish` 类路径保留；新增 2 组测试，`remoteHostIpc` 75/75。**R2-2** ticket TTL 120s vs 计划 ≤60s、sweep 只在 mint 时跑、崩溃遗留 `.claim-*` 未清理、main TTL 常量未使用 → 车道修复中（helper 1.20.2：60s、启动时 sweep、claim orphan sweep、常量互钉）。O1（runner 不复核 hostId/routeDigest，主进程同 session mint+spawn 保证，未发现跨 host 路径）、O2（runner 选中的 shell 未回填 tab label，cosmetic）、O3（root-drift 码折叠到 FILE_COMMAND_FAILED，fail-closed）为 info。
- 复审验证：493 targeted / 411 pass / 0 fail / 82 POSIX skip（分五批）；未跑 e2e/真机/pack/全量。

## 远端配置后端 Batch A/B（2026-10-18；provider 测试/模型目录仍 deferred）

- **Batch A（helper + main，已提交 0a0cc53b8）**：helper 1.21.0 新增独立冻结 artifact `config.mjs`——只允许 `$HOME/.pi/agent/{models,settings}.json`（无任意路径参数、auth.json 结构上不可达、no-follow 普通文件、≤1 MiB、坏 JSON 不覆盖、递归 secret 脱敏、RFC 7396 merge-patch + expectedVersion + 0600 temp/fsync/rename/目录 fsync + 读回校验、回执丢失 ⇒ `CONFIG_RESULT_UNCONFIRMED`）。shared `PiConfigTarget` / 闭集码；main `piConfigTarget` 严格校验、`RemotePiConfigBackend` 只按 hostId 经 ready/pinned host 请求并逐字段重验（含 secret 列表重算与明文拒绝）、`PiConfigRouter` local 逐字不变且 ssh 无本地回落；四个既有 config IPC 接受可选 target；provider test/fetch/usage 对 ssh 在发任何请求前返回 `REMOTE_CONFIG_PROVIDER_OPERATION_UNSUPPORTED`。
- **独立复审与 A-fix（已提交 dafe725f，helper 1.21.x；A2 复审残余 camelCase 复合名在 1.21.2 补齐）**：复审 addendum [remote-security-review-config-addendum.md](remote-security-review-config-addendum.md) 报 2 medium + 2 low。已修：A1 保留键（`__proto__`/`constructor`/`prototype`）在 read/patch 任何层级拒绝（helper 全量校验 + null-proto/defineProperty 合并，main 同样拒绝，渲染层 patch 解析器同规则），阻断原型污染；A2 secret 匹配改为整名 + 可选 `_`/`-` 前缀段，`maxTokens`/`max_tokens`/`tokenizer` 不再误判且可 patch，secret 非字符串值改为 `CONFIG_FILE_INVALID` 不再静默成功；A4 改为 fatal TextDecoder，非法 UTF-8 → `CONFIG_FILE_INVALID` 且不覆盖；A3（配置请求走一次性 transport + expectedVersion CAS，未加 host 操作锁/revision fence）作为显式偏差记录在计划 §6.4.1。helper 1.21.2 再补 A2 复审残余：secret 正则支持 camelCase 复合名（`clientSecret`/`openaiApiKey`/`dbPassword` 会被脱敏），同时继续排除 `maxTokens`/`max_tokens`/`tokenizer`/`tokens`；helper.mjs 40,844 chars `957cb034…`、config.mjs 9,639 chars `0006235d…`，六 artifact 与 entry 全部重钉，Windows 56/56 + WSL 8/8。
- **Batch B（已提交）**：preload 只给四个既有 config 方法加可选 options（无新通道）；systemIpc 远端返回 local-compatible DTO + 脱敏 remote 快照；渲染层 target selector、远端 panel（secret 只显示 configured/missing、显式 merge-patch、VERSION_CONFLICT 保留草稿、RESULT_UNCONFIRMED 阻止重试、deferred provider 操作说明、auth/trust/mcp/raw 禁用页）、ConfigModal 最小集成 + 远端草稿丢弃确认、zh/en ~52 key；A1 渲染层保留键守卫。作者态 e2e `remote-config.ts` 挂在文件管理验收用例内（备份远端 models.json → UI 读 → 唯一非密钥 marker patch → SSH 落盘核验 → finally 字节还原），用例数不变（16/136）。
- **验证**：Windows Batch A/B targeted 累计 112 项（104 pass/8 skip/0 fail，最终聚焦 99/99）、WSL 真实 helper 配置套件 8/8 + 定向 16/16；typecheck/format/build:fast 0；e2e `--list` 136/56（acceptance 16）。真机门禁见本节下方「最终门禁」。
- **仍未做**：provider 连接测试 / 模型目录拉取（第 819 行 must；deferred，入口保持禁用）；用量查询 remote 禁用；renderer 未做 DOM 级测试（纯 reducer + 源码契约，仓库无 DOM harness）。





## 最终门禁（2026-10-18 夜，13 项真机 + 全量回归 + 打包）

- **十三项真机门禁 13 passed（12.4m，`CLEANUP_OK`，最终复跑含模型目录）**：G1–G5e 十项 + 文件管理 v1（含新增远端配置 e2e：host target → secret 徽标读取 → 非密钥 merge-patch → SSH 落盘核验 → finally 字节还原，59s）+ 终端（1.7–1.8m）+ 远端会话产品路（含归档/恢复/永久删除；曾因删除步骤早于 fork 导致 oracle 失败，已把删除步骤移到历史变更步骤之后并单独复跑通过）。
- **全量回归零新增**：工作树 **8507 项 / 8205 通过 / 30 败 / 272 skip**，与干净 HEAD `a52eb53ea` 的失败集合**完全一致**；30 条为本机既有环境/基线红。
- **打包**：`npm run pack` 0；`release/win-unpacked/resources` 含 pi-auth-host/extensions(manifest)/prompts/skills/pets/xueprompts.db/pi-ai-catalog；app.asar 命中 `config.read`/`config.patch`/`CONFIG_RESULT_UNCONFIRMED`/`REMOTE_CONFIG_PROVIDER_OPERATION_UNSUPPORTED` 及新增的保留键/secret 逻辑与既有终端/Git 冻结标记。**packaged 仍被 `!app.isPackaged && PIDECK_REMOTE_EXPERIMENTAL=1` 挡住（需产品决定是否放开）。**
- **已知测试基础设施抖动（非产品失败）**：主机高负载时 G2a/终端 oracle 的 SSH 瞬时断连各出现过 1 次，均单独复跑通过；已加 oracle 单次重连重试与收敛等待。最终干净门禁一次通过。
- **仍需人工**：打包版真实 SSH 点按 smoke、macOS 客户端、Linux 客户端长稳 soak、独立人工安全 reviewer 签字；逐供应商合成探测/用量查询为计划内 deferred（模型目录/连接探测已交付）。


## 远端模型目录（2026-10-18，Phase 5 行 819 收口）

- **交付**：`RemoteModelProbe`（main）只接受 `hostId`；从 `ProjectStore` 解析该 host 的远端项目 → 窄 `AgentManager.findLiveRemoteAgentId(projectIds)`（只回 agentId，渲染层永远不提供 agentId/路径）→ 既有 `getAvailableModels(agentId)` RPC 单次 60s 有界调用（不重试）→ 只回脱敏 allowlist（`{id,name?,provider,contextWindow?,maxTokens?,reasoning?,input?,images?}`，provider+id 去重、上限 1000、排序），错误一律闭集码（TARGET_INVALID/NO_PROJECT/NO_RUNTIME/UNAVAILABLE/FAILED/EMPTY），运行时自由文本不跨边界。新通道 `remote:pi-models`、preload `probeRemoteModels(hostId)`，与其它 remote 域同一实验门禁。
- **语义**：v1 的「provider 连接测试」= 目标 host 上 live pi runtime 的可用模型探测（与本地模型选择器同一来源，凭据只在 host 上）；**逐供应商合成 HTTP 探测与用量查询仍 deferred**，UI 明确禁用并给 stable code 文案。
- **渲染层**：远端 models 面板把旧的禁用「测试连接/拉取模型」替换为真实动作（loading、按 provider 分组、EMPTY 中性态、闭集码文案、deferred 说明），auth/trust/mcp/raw/usage 保持禁用；17 个 zh/en key 且 parity。作者态 e2e 挂在产品路验收（live remote agent）里，只读；真机门禁已实际跑通（非空 provider 列表）。
- **验证**：Windows targeted 84/84、WSL 55/55、typecheck/format/build:fast 0、e2e `--list` 136/56；全量回归 8507 项（8205 通过/30 败/272 skip），失败集合与干净 HEAD **完全一致**；`remoteHostCrossStoreContract` 新增 `RemoteModelProbeResult` 的 runtime 属主登记（回显 hostId、不落盘）。
- **已知偏差**：EMPTY 以 `ok:false` 闭集码返回但 UI 渲染为中性空态；models.json 读失败时 catalog 动作不可达（v1）；无 DOM 级 UI 测试（仓库无 harness，纯模型 + 源码契约）。
