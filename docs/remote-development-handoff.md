# PiDeck SSH 远程开发 — 协作与交接

> 当前开发分支：`feat/remote-development`。代码核对基线：`f7b18947`（第一次协作交接点）；首次交接提交：`a663947c`。
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
>    **P4.2 唯一剩余项：远端自动 reattach**（`reattachProcess` 仍是本地实现）。实现要点（本次侦察所得，避免重走弯路）：
>    - 现状：`AgentManager.reattachProcess`（:2662）第一件事就是 `if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION")`；
>      两个触发点：进程退出型压缩（:2495）、abort 期间进程退出（:4413）。
>    - 远端分支应复用 create 的 launch 构造：`remoteRuntime.prepare({ hostId: project.locator.hostId,
>      remoteCwd: project.locator.remotePath, sessionFile: sessionPath })` + `remoteRuntime.createLauncher()`（见 :1646）。
>    - **不能复用 `handshakePiProcess`**（:669 的签名不接 launch/plan）⇒ 要照 create 路径的**远端内联握手**写
>      （`PiProcess` 带 launch 起进程 + `get_state` 合并状态）。
>    - **两处硬坑（必须按远端语义处理）**：①远端路径**不得**走 `normalizeSessionPathFromPi`（create 明确注释
>      「原样采用」，本机规则会把它改错）；②远端**不加载历史**（本批 `historyLoading: "unsupported"`），
>      reattach 里的 `loadMessages` 对远端会被守卫拒绝（需 `.catch` 兜住或跳过）。
>    **✅ 已修复并通过真机验收（2026-10，`93cad060e`）**：修法是「预热激活成功后**主动回拉一次 runtime 快照**」
>    ——渲染层首键预热走 IPC `sessionsRuntimeActivate`（`sessionIpc.ts:1456`）直接调 `coordinator.activateRuntime`
>    后返回，**绑定成功后没有任何推送**，而 `emitSessionRuntimeEvent` 在无绑定时会把整条 tab 快照丢掉；
>    `useSessionRuntimeBridge` 又只在挂载时拉一次 `listRuntimes()` ⇒ 静置的会话永远收不到标记。回拉走 `SessionRuntimeInfo`
>    （已带 `remoteTrustUnhandled`）这条**拉**的路径，绕开被丢的事件。真机复跑：**test 2（trust 提示）转绿**、
>    整份 spec 从 2 failed 变 1 failed（1 passed / 1 failed，2.4 分钟）。两处临时探针已在该提交后删除。
>    **P4.2 UI 验收只剩最后一项**：test 1 的「SSH 读远端会话文件核验历史」拿到 `Expected >= 2 / Received 0`
>    ——下一步要判：spec 用的远端路径是否等于 `locator.remotePath` / 那条 ssh 命令的 stderr 是否被吞 / 文件确实为空。
>    **trust 提示不显示＝真产品 bug（探针定案，2026-10）**：两处 app 日志探针给出确凿序列——
>    `emitSessionRuntimeEvent`（`main/index.ts:537`）在「协调器无绑定」时 `return false`，**整条事件（含 tab 快照）
>    被丢弃**；而 trust 标记**只搭 `agents:state` 的 tab 快照**（`agents:runtime-state` 载荷不带它）。真机实测：
>    test 2 的会话 3 次广播**全部 `forwarded:false`**（绑定建立前发出），此后该会话**再无状态变化** ⇒ 标记永远到不了
>    渲染层 ⇒ 提示不显示；test 1 的会话 8 次广播里 3 次 false、5 次 true（后续 prompt/流式补上了车）。
>    **最小修法（下一步）**：绑定建立后必须**补一次 `agents:state` 推送**（否则绑定前丢的 tab 快照里的一切状态——
>    不只 trust 标记——渲染层都拿不到）。落点：协调器绑定成功后发一次状态（`main/index.ts` 已把「解绑 + 推送」
>    的通道接好，绑定侧对称补上即可），或让广播侧在被丢时记下 agentId、绑定后重放一次。修完删掉两处探针。
>    **第三轮真机 UI 验收（2026-10，含 `31394947a` + `a05f66352`）**：仍 2 failed，但**失败点又各推进了一步**。
>    - test 1（产品路）：失败点从「侧栏 0 行」推进到 `spec.ts:314` —— 「**远端会话文件必须至少有一问一答两行**」
>      `Expected >= 2 / Received 0`。即：**侧栏行找到了、点开重开了、历史断言可能已过**，卡在「去远端读会话文件核验」这一步
>      （下一手要看 spec 那条 ssh 读取命令是否真的取到文件：路径用的是 locator.remotePath 还是别的）。
>    - test 2（trust 提示）：**仍然不出现**（`spec.ts:372` 240s 超时）⇒ `31394947a` 的渲染层修法**不是全部原因**。
>      已排除的：组件挂载是**无条件**的（`SessionView.tsx:262`，其后无分支/早退）、组件根**已带** `data-testid`、
>      主进程给远端 tab 恒写标记、`emitState()` 发**全量 tab 快照**（无字段白名单）⇒ 剩下唯一可能是
>      **标记没进渲染层 `sessionRuntimeByIdAtom[该会话]`**。下一步诊断建议：临时在渲染层读该 atom（或让 spec dump
>      该会话的 runtime 条目键位），确认是「事件没到」还是「键位/会话 id 不匹配」。
>    **侧栏 0 行的进一步诊断（父代理查 spec 与快照，2026-10）**：失败点其实**很靠后**——test 1 的
>    「新建会话 → 发 prompt → 出正文 → 关闭 Agent」**全过**，失败在最后一步「关标签页 → 回侧栏点开该会话」：
>    `projectRow(远端项目).locator('.session-row')` 得到 **0**（期望 1）。两个候选成因，判定方法已明确：
>    (a) **组是折叠的**：失败快照里该项目组旁有「展开」按钮（`- button "展开"`）⇒ 行不在 DOM 里 ⇒ 计数必为 0。
>        spec 侧修法：计数前先展开该组，或改成断言「组内存在这条会话」而不是计数。
>    (b) **行在但类名不是 `.session-row`**：草稿行用的是 `draft-session-row`（`SessionTree.tsx:379`，**不带**
>        `session-row`）⇒ 若远端会话在侧栏仍是草稿，就正好 0 命中。根因指向登记的门：
>        `AgentManager` 里 `if (input.deckSessionId && tab.sessionPath)` 才登记（`registerRemoteSessionIdentity`）——
>        任一为空则**静默跳过**，draft 永不被吸收（`SessionCatalog:1352` 注释说明远端是靠握手吸收 draft 的）。
>    判定入口：失败时刻的侧栏 DOM（`projectRow(...).locator('.session-row, .draft-session-row')` 计数 + innerHTML），
>    快照已存 `/tmp/p42-ui-acceptance-mine/`。test 2 的快照里侧栏**有**该会话标题的按钮 ⇒ 行确实存在过。
>    另：test 2 在更早一步（`composer[data-session-id=…]` 文本）就失败 ⇒ **`6b60fcb60` 的 trust 传播修法仍未被真机确证**。
>    **父代理自己跑的一轮真机 UI 验收（2026-10，HEAD `6b60fcb60` 之后）**：`env PIDECK_E2E_REMOTE_HOST=… npx playwright test e2e/remoteSessionAcceptance.spec.ts`
>    ⇒ **2 failed**，但**失败点在很后面**，前半条链已经通了：加主机 + pin → 连接 ready → 登记远端项目 → **在远端项目里新建会话**
>    （真实 UI 点击）全部成功；app 日志显示 agent 生命周期完整：`Agent create requested → Agent pi process start → Pi process spawned
>    → Agent get_state completed → Agent stopped → Pi process exit`，且**没有任何 `REMOTE_*`/`SSH_*` 稳定码**
>    ⇒ **真实应用里的远端 pi 会话确实起来了、`get_state` 也回来了**。
>    **两个待修点（下一轮）**：
>    (1) **侧栏不显示这条远端会话**：断言「远端项目下恰好一条会话行」拿到 `Expected: 1 / Received: 0`。runtime 层是好的
>        ⇒ 属渲染层/刷新链（登记成功后没有让侧栏刷新，或侧栏对 ssh-located 记录的列表路径没覆盖）——这是**当前最实的缺口**；
>    (2) spec 第二步在 `composer[data-session-id=…]` 上断言输入框含 prompt 失败（输入没落进 composer 或选择器不对），
>        trust 提示那条断言因此还没跑到 ⇒ **`6b60fcb60` 那条传播修法尚未被真机确证**。
>    失败证据已另存 `/tmp/p42-ui-acceptance-mine/`（含 `error-context.md` 与截图）。
>    **UI 验收现状（2026-10，`3f9bff495`）**：`e2e/remoteSessionAcceptance.spec.ts` 已在真机上跑过，**产品路走到第 3 步并走通**
>    （加主机/pin → 连接 ready → 登记远端项目 → **在远端项目里新建会话**这个 UI 入口存在且被真实点击 → 远端 runtime 被预热）；
>    随后在「远端 trust 提示可见」上失败（`getByTestId('remote-session-trust-notice')` 240s 未找到）。
>    **成因判别（父代理看过 DOM 证据，2026-10）**：组件**已经带** `data-testid="remote-session-trust-notice"`
>    （part 7 就加了），所以「缺 testid」这一支**排除**；而最近一次留下的快照是**超时污染**的
>    （`Error: Channel closed`，页面只剩空壳）⇒ 不可用作判据。因此**最可能的成因是已知限制那一支**：
>    `SessionRuntimeInfo` 不携带 `remoteTrustUnhandled`，提示要等**下一条 `agents:state` 事件**才出现，
>    而 spec 的「输入首键预热 runtime」那一步在断言时刻还没产生该事件。
>    **下一步（最小修法）**：`shared/types/session.ts` 的运行时信息加 1 个可选字段 + `SessionRuntimeCoordinator.runtimeInfo()`
>    透出它（渲染层已按 runtime-info 组装状态）⇒ 重载/无事件也能显示。修完再跑一轮**只做执行与取证**的真机
>    验收（把第 5~7 步一并确证）。
>    第 5~7 步（prompt 出正文 / 关闭 / 重开历史仍在）**尚未确证**（lane 在这两条上 30 分钟超时）。
>    已知限制（如实记）：`SessionRuntimeInfo` 不带 `remoteTrustUnhandled`（那要动 SessionRuntimeCoordinator），所以**只有渲染层重载且远端 runtime 空闲**时，提示要等下一次 `agents:state`（激活/attach 会发）才出现；最小修法＝`shared/types/session.ts` 加 1 字段 + `runtimeInfo()` 加 1 行。
>    另：D5 已定（runner 作为同一份 bundle 里的**第二个冻结 entry**）；**Pi RPC 走「每 Session 独立 SSH + 固定 runner」**，**不走控制协议**，全程零新增 helper op。
> 2. ~~**INV-5 实施**~~ —— **已在第八批完成**（见 §3 第八批）：跨 store 写入侧现在有真正的跨进程锁 + 锁内重读（权威=磁盘），门控下 CE-1…CE-5 **全绿**。剩余遗留：**跨 store 协调器与启动 `resume` 仍未装配**（遗留 journal 只能 fail-closed 阻塞，不能自动收敛）、旧版本写者靠 CAS **检测**而非阻止、主机目录锁仍无 owner。
> 3. **导入会话的正文读取**（远端 JSONL）：属 Phase 4。当前导入只保证「登记 + 进清单 + 选中」，打开会**如实**报「无法读取会话文件」——不是静默失败。
> 4. **覆盖缺口**：深层嵌套 subagent 会话布局、`remotePathAliases`、`PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR`（远端进程环境，helper 无读 env 的操作）与 project 级 `.pi/settings.json`（cwd 作用域）不在扫描期覆盖、POSIX symlink 语义未验。
> 5. **收尾小项**：两处字面 UUID 正则（`remoteSessionIpc.ts` / `remoteHostIpc`）未收敛；两个 smoke 脚本仍用 `ssh-keyscan` 取候选，应改用产品自己的已认证握手路径；`ProjectTree.tsx` 414 行可插槽化。
> 6. **全量 `npm test` 仍有 7 条失败**，全在**我们从未改动的文件**里（`piLocator` 的 Windows cmd shim、`quickMessages`、`securityLevelRuntimeSwitch`、`sonnerToasterMount`、`syncWorkflowChoices`），另有 3 条已知环境失败（bootstrap 集成、Windows 无 `/bin/sh`、`sshClientRuntime` 的 POSIX-only 断言）。**只做了文件级归因，未在干净基线上逐条比对**——接手后若要动，请先基线比对再改。**（2026-10 更新）第八批已在 Linux/Node 24.21 环境做过一次全量逐条基线对照**：改动前后均为 19 条失败且**集合逐条一致**，详见 §3 第八批；上面那串 Windows 数字仍未经同等对照。
>
> **接手必读的坑**（都是实际踩过并付出过代价的）：
> 1. `.ps1` 脚本必须 **ASCII + BOM**：Windows PowerShell 会把无 BOM 的 UTF-8 按 GBK 读，脚本里的中文会让**整个脚本解析失败**（表现为语法错误而非业务错误）。
> 2. **Playwright 每次启动会清空 `test-results/`**：真机失败证据必须先 `Copy-Item` 另存，否则下一次跑（或任何人跑一次）就把 trace/截图冲掉。
> 3. **夹具必须像真的**：远端会话夹具要放在项目的**编码目录** `--<encoded-cwd>--/` 下（`encodePiSessionDirectory`），否则归属判定判不出来，测的就不是真实行为。
> 4. **契约测试断言的源码文本会随重构过期**：改实现后契约必须**等价迁移**（意图不变），**绝不放宽断言**；否则守卫会变成噪音或掩盖真问题。
> 5. 跨 VM realm（`loadTsCommonJs` 加载的对象）**不能用 `deepEqual` 比对象**（原型不同会误判），断言字段。
> 6. helper 是**冻结**的（1.6.0 + sha 与仓库常量逐字节一致）：改它必须 bump bundle；新增远端能力优先走 runner 路径而不是扩控制协议。
> 7. 每个 bug 修复**红证先行**：先让旧行为变红，再修到绿（本会话有多个 bug 就是靠这条避免了「断言恒真」）。
> 8. 给用户的命令**不要用超长单行**（易粘贴出错）；本仓库用 `%TEMP%\pideck-acceptance.ps1` 直接把凭据与步骤写进脚本。
>
> **怎么验证**：离线 `npm run typecheck` + 针对性套件（`node --test tests/remote*.test.mjs tests/session*.test.mjs …`）+ `npm run check:format`；真机 `& "$env:TEMP\pideck-acceptance.ps1"`（内含三个凭据，期望 `1 passed`）。**本执行沙箱无法启动 Electron**（Playwright 需经管道取 CDP 端点，沙箱内程序不能开命名管道；仓库既有 `e2e/smoke.spec.ts` 同因失败），所以**功能级真机验收必须在宿主终端**跑；而 `scripts/verify-remote-host.mjs` 与 `scripts/verify-remote-connection-service.mjs`（协议层/服务层）**可以在沙箱里跑**。
>
> 本页是协作入口：实现状态、下一批任务、验收与验证方法。架构和发布范围见 [实施计划](remote-development-plan.md)，跨 store 设计见 [跨 store 一致性计划](remote-cross-store-consistency-plan.md) 与 [旧事务设计](remote-host-cross-store-design.md)。
> 文档中的任务包是待实施工作，不表示已分配给具体开发者或已创建 GitHub issue。

## 1. 当前能做什么

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
