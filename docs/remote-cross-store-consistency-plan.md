# 跨 store 一致性（INV-5）设计与对照计划

> 状态：**INV-5a 已实施（本文件是设计 + 实施记录）；INV-5b 的实现早已存在，但跨 store 协调器与启动收敛仍未装配**。
> 实施改动在 `feat/remote-development` 分支上；落地清单、判据修正与验证证据见 §6.3.2。
> §1/§2/§3 保留**实施前**的基线描述（它们是设计的依据）：读到「今天」字样时请连带看 §6.3.2 的对照。
>
> 基线：分支 feat/remote-development，工作树 4ba0f79fe（本文所有「今天」的陈述都按该工作树的代码与测试名核对过；行号仅作定位，按符号搜索为准）。
>
> 关联：[跨 store 事务设计](remote-host-cross-store-design.md)（INV-1..INV-12 的既有定义与已落地切片，本文不重复其内容，只补 INV-5 的精确语义与写入侧方案）、[实施计划 §5.2](remote-development-plan.md)（rebind 事务与「同一份跨进程持久锁」的原始要求）、[交接文档](remote-development-handoff.md)（「严格跨进程 CAS / 跨 store INV-5 未交付」的历次记录）。

---

## 0. 一句话结论

今天的真实状态是：**引用读取侧很强（fail-closed 扫描，绝不把「读不出」当成「没有引用」），引用写入侧没有任何跨 store CAS 或互锁**。INV-1（引用不悬空）在生产里之所以「看起来成立」，是因为**今天没有任何生产路径会 retire / disable / rebind 主机**，而不是因为有机制在保证它。因此：

- 任何「跨 store 事务安全已闭环」的描述都是错的（交接文档已多次强调，本计划继续保持）；
- 本计划的 INV-5 定义为两个子句：**INV-5a 写入侧无丢失更新（CAS/互锁）** 与 **INV-5b 收敛幂等（replay-safe）**。既有设计文档 §3 的 INV-5 只覆盖 5b，交接文档里未交付的「严格跨进程 CAS / 跨 store interlock」就是 5a；
- 今天 **5b 已实现（有测试、未装配）**，**5a 只对四个持久化实体中的一个（remote-hosts.json）成立**。

---

## 1. 今天真实成立的保证（每条带测试名）

### 1.1 读侧：引用扫描是 fail-closed 的（注册表层）

实现：src/main/remote/RemoteHostReferenceRegistry.ts；生产装配点只有 src/main/remote/RemoteHostCatalogView.ts:25（主机只读目录）。

| # | 保证 | 测试（tests/remoteHostReferenceRegistry.test.mjs） |
| --- | --- | --- |
| 1 | 任一源抛错 ⇒ complete=false，**已读到的 id 仍并入并集**（保守超集） | a source that throws makes the scan incomplete but keeps the ids that were readable |
| 2 | 不可读的源**永不降级成空集** | an unreadable source never degrades into an empty reference set |
| 3 | 零注册源 ⇒ complete=false，且 unavailable 为空（调用方不能只看 unavailable） | no registered source fails closed instead of reporting an empty set |
| 4 | 源返回形状非法 ⇒ 整源按不可读处理，不是空集 | a malformed provider result is unreadable, not empty |
| 5 | 单主机判定在不完整时 referenced 恒为 true，且同时报告 complete | the single-host verdict reports both facts and never hides an unreadable source |
| 6 | 源自报不完整时结果绝不显示 complete | a source that reports its own incomplete scan never makes the result look complete |
| 7 | 非法/重复注册被拒（稳定码），保留第一个 provider | rejects an invalid or duplicate registration with stable codes and keeps the first provider |
| 8 | 声明 canHoldHostReferences=false 的源被跳过且不影响 complete | a source that cannot hold host references is skipped and does not affect completeness |
| 9 | provider hits 被归一到已登记源并去重 | normalizes provider hits to the registered source and deduplicates them |

### 1.2 磁盘引用源：projects.json 与 session-catalog.json 都是真实扫描，坏档一律 fail-closed

实现：src/main/remote/RemoteHostReferenceSources.ts。测试：tests/remoteHostReferenceSources.test.mjs。

| # | 保证 | 测试名 |
| --- | --- | --- |
| 10 | 主档坏、备份声称无引用 ⇒ 仍 incomplete | a broken primary is incomplete even if a backup claims no references |
| 11 | 缺主档但有备份 ⇒ 绝不当成「完整的空集」 | a missing primary with an existing backup never reports an empty complete scan |
| 12 | 未知 version / 未知 locator / 畸形兄弟文件一律 fail closed | unknown versions, locators and malformed siblings fail closed |
| 13 | projects 损坏 ⇒ incomplete，绝不空集 | a malformed or corrupt projects store is incomplete, never an empty reference set |
| 14 | 超限 catalog 不读进内存就判 incomplete | an oversized catalog is incomplete without reading it into memory |
| 15 | 符号链接不跟随（两个源各一条） | a catalog symlink is never followed / a projects symlink is never followed |
| 16 | 合法 v1 数组 complete 且不贡献 host 引用；v1 条目无可用 local path ⇒ incomplete | a legacy v1 project array stays scan-complete and contributes no host reference / a legacy v1 entry without a usable local path is incomplete |
| 17 | projects 备份缺主档 ⇒ incomplete | a projects backup without its primary is incomplete |
| 18 | 只带 hostId 的 ssh session locator 仍贡献引用 | an ssh session locator with only a hostId still contributes a reference |
| 19 | 扫描是纯读：不改写 catalog / projects.json | the persisted SSH locator contributes a host reference without rewriting the catalog / an ssh project contributes a host reference without rewriting projects.json |
| 20 | 两个源给保守并集与 per-source hits | projects and sessions contribute a conservative union with per-source hits |
| 21 | 写侧、codec、引用扫描共用同一 ssh locator 值域 | tests/projectStoreRemoteValidation.test.mjs: write, codec and reference scan accept exactly the same ssh locator domain（另有 3 条「不完整而不是无引用」：a v2 project record without a locator is incomplete, never 'no references' / a v2 ssh record with an invalid remotePath is incomplete, not a host reference / a local locator that carries a hostId is incomplete, not a project without references） |

### 1.3 store 接线：把「无法证明」变成硬失败（没 provider 也不许 fail-open）

测试：tests/remoteHostStoreLifecycle.test.mjs。

| # | 保证 | 测试名 |
| --- | --- | --- |
| 22 | 扫描不完整 ⇒ retire 与 draft 编辑都被拒，且快照逐字节不变 | an incomplete reference scan blocks retire and draft edits without touching the snapshot |
| 23 | 引用集合无法证明时 draft 编辑 fail closed | a draft edit fails closed whenever the reference set cannot be proven |
| 24 | retire 需要 provider + tombstone + 无剩余引用 | retiring needs a reference provider, a tombstone and no remaining references |
| 25 | registry 的引用在**写入时重读**，不是 open 时缓存 | a registry reports references through the store, and they are re-read at write time |
| 26 | retire 提交失败时 pin 不丢、store 仍可用 | a failed retire commit keeps the pin and leaves the store usable（同文件） |
| 27 | 收敛的 retire 前置：完整且为空的引用扫描 | tests/hostRebindJournal.test.mjs: retirement needs a complete and empty reference scan |

### 1.4 写侧：逐记录 CAS 与幂等收敛（rebind 切片，已实现但**未装配**）

实现：src/main/remote/HostRebindJournal.ts + HostRebindTxLock.ts + HostRebindConvergence.ts；两个 store 的端口在 ProjectStore.applyHostRebind（ProjectStore.ts:536）与 SessionCatalog.applyHostRebind（SessionCatalog.ts:844）。

| # | 保证 | 测试名 |
| --- | --- | --- |
| 28 | beforeLocator 已被别人改过 ⇒ changed，且什么都不写 | tests/hostRebindStorePorts.test.mjs: a patch whose beforeLocator no longer matches reports changed and writes nothing |
| 29 | 批次里任一记录 missing ⇒ 整批不写，且每条补丁仍各得一个判定 | a batch with a missing record writes nothing and still reports one verdict per patch |
| 30 | 补丁只允许改 hostId，改别的字段被拒 | a patch that changes more than the hostId is refused |
| 31 | 已应用的补丁重放 ⇒ already-applied，不二次写盘 | replaying an applied rebind reports already-applied without a second write |
| 32 | 端口读/写都拒绝畸形批次，而不是「答非所问」 | port reads and writes reject malformed batches instead of answering them |
| 33 | 一笔写失败不留半写 store，重试后收敛 | a store write that fails mid-transaction leaves no half-written store and converges on retry |
| 34 | 写已落地但抛错 ⇒ 下一次 resume 仍收敛 | a store write that landed but threw is still converged by the next resume |
| 35 | 判定只看记录内容，不看 stage | tests/hostRebindJournal.test.mjs: per-record locators outrank the recorded stage |
| 36 | 每个崩溃点收敛到与不中断跑完相同的终态 | every crash point converges to the same terminal state as an uninterrupted run |
| 37 | 收敛后再 resume 是 no-op | a second resume after convergence is a no-op |
| 38 | 别人写过的记录 ⇒ STALE_PLAN，绝不重试覆盖 | a record written by someone else stops the transaction |
| 39 | 记录消失 ⇒ 停止且**不重建** | a disappeared record stops convergence without recreating it |
| 40 | 未知结果 roll-forward，真实拒绝透传 | a store write that landed but threw is rolled forward, a real rejection passes through |
| 41 | 端口失败不泄漏文本、不伪装成功 | port failures and malformed port results never leak text or look applied |
| 42 | tx 锁：不抢活 owner、能回收可证明已死的 owner | the transaction lock defers to a live owner and recovers a provably dead one（另 tests/hostRebindTxLock.test.mjs 4 条：owner 读不出当活、自己的 pid 当活、同 boot 用探针、不同 boot 判 pid 复用） |
| 43 | 收敛分类：missing / already-applied / pending / stale 各有唯一判定，端口结果不被升级成成功 | tests/hostRebindConvergence.test.mjs 6 条（a record the store no longer holds is missing... / a record already at the target locator is done... / a record at its expected before-locator is pending... / a locator written by anyone else is a stale plan... / store results keep their own verdicts and are never upgraded to success / a malformed or unrecognised store result is unknown, not already-applied） |

### 1.5 主机 store 自身的强保证（唯一有跨进程锁 + 磁盘 CAS 的实体）

| # | 保证 | 测试名 |
| --- | --- | --- |
| 44 | 过时实例、遗留锁文件、畸形快照都不得覆盖更新的数据 | tests/remoteHostStore.test.mjs: stale instances, held lock files, and malformed snapshots do not overwrite newer data |
| 45 | 启动选最高有效 revision，而不是把端点信任回滚 | chooses highest valid revision before checking pins instead of rolling back endpoint trust |
| 46 | 备份只能离线查看，绝不被提升为可写信任 | loads a backup for offline inspection but never upgrades it to writable trust |

### 1.6 类型契约（引用源归属，INV-11）

tests/remoteHostCrossStoreContract.test.mjs：every typed or decoded hostId has a declared reference-source owner；a new hostId field without a reference-source owner fails the contract。

### 1.7 今天**不成立**的清单（本计划的缺口来源）

1. **projects.json 没有磁盘 CAS**：ProjectStore.save() 只在自己的内存 revision 上 +1 后写盘（ProjectStore.ts:616-633），不重读磁盘比对；跨进程锁不存在。
2. **session-catalog.json 连 revision 都没有**：schema 只有 version / sessions / dismissedDshSessionIds（SessionCatalog.ts:84-96；全文件无 revision 字段），写路径同样是进程内队列。
3. **引用写入在生产里是可达且无互锁的**（第四/五批新增，也是与既有设计文档基线最大的差异）：项目登记 projectStore.addRemote（src/main/index.ts:2426，经 remoteProjectIpc 的 enroll 端口）与会话登记 RemoteSessionScanner.register（RemoteSessionScanner.ts:464，经 index.ts:2439 注入的 catalog）。既有设计文档基线 d01464f0 写的是「session catalog 没有写入者」——**今天有生产写入者了**。
4. **生产没有 retire / disable / updateDraft 的调用者**（grep 只命中端口契约与测试）。⇒ INV-1 的悬空引用风险目前是**潜伏**的：一旦 retire / rebind 装配上线，第 2 节的交错立刻变成可达。这条必须写清楚，避免被读成「现在没问题所以设计没问题」。
5. **跨 store 删除是顺序调用 + 吞掉第二段错误**：projectsIpc.ts:108-112、index.ts:3766-3768、index.ts:4339（projectStore.remove 之后 sessionCatalog.removeByProjectId(...).catch(() => 0)）。第一段成功、第二段失败 ⇒ catalog 永久残留已删项目的引用，且没有补偿。
6. **协调器不存在**：全仓库无 HostRebindCoordinator；HostRebindJournal.resume(ports)（HostRebindJournal.ts:350）**没有生产调用者**，生产装配也没有「暴露任一 store 前先恢复未完成事务」（实施计划 §5.2 的原文要求）。
7. **主机目录锁没有 owner**：RemoteHostStore.ts:526-529 只 open(lockPath,"wx",0o600) 后 unlink，不写 {pid,bootId}；崩溃遗留只能人工删（tx 锁有 owner，主机锁没有）。
8. **端口 CAS 的权威是内存快照，不是磁盘**：ProjectStore.applyHostRebind / SessionCatalog.applyHostRebind 的期望值来自各自内存；另一实例或另一个进程直接改磁盘时，端口会拿内存整份覆盖它。既有设计文档 §5.4 已自认这一点，并把 INV-5 里「不得用内存快照覆盖磁盘上更新的数据」标成【待确认】——本文把它定为 **INV-5a 的第一条缺口**。
9. **registry 注入不等于保证**：RemoteHostCatalogView.ts:25 注入了 registry，但它只影响 store 的 retire/updateDraft 判定；既然没有 mutator 被调用，这条装配今天证明不了任何写侧性质。
10. **多版本并行是产品既有行为**：单实例互斥只保证「同版本单实例」（AGENTS.md），不同版本可同时运行同一 userData。任何写入侧协议都必须回答「旧版本不知道新协议」这件事（见 3.4 的方案 D 限制）。

---

## 2. INV-5 精确语义

### 2.1 三个子句

- **INV-5a（写入侧无丢失更新 / CAS）**：任何「新增、删除或改写 hostId 引用」的写入，在其 commit 点上必须建立在该 store **当前磁盘内容**之上——要么磁盘内容仍等于读取点（或等于调用方持有的版本令牌），要么以稳定码拒绝。**不得**用内存快照整份覆盖磁盘上更新的数据。
  适用实体：remote-hosts.json、projects.json、session-catalog.json。今天只有第一个满足（1.5 第 44/45 条）。
- **INV-5b（收敛幂等 / replay-safe）**：对同一事务重复执行收敛任意次，终态相同，且落在 INV-1 允许的状态；权威判据是逐记录 before/after 内容比对（不看 stage），已应用的记录报 already-applied。今天已实现（1.4），未装配。
- **INV-5c（失败可区分）**：每次拒绝都有稳定码，且明确区分「未写入 / 已提交但结果未知 / 校验失败 / 需人工」四类（INV-10 在写入侧的落实）。

### 2.2 操作边界（必须成立的地方）

| 边界 | 写哪些 store | commit 点 | 今天 | INV-5 要求 |
| --- | --- | --- | --- | --- |
| 主机删除（disable / retire） | remote-hosts.json（+ 退役后清 pin） | RemoteHostStore.mutate 的 rename | 有锁 + 锁内磁盘 CAS + fail-closed 引用扫描；**生产不可达** | 5a 对 host store 已成立；5c 有（REMOTE_HOST_REFERENCED / _STORE_BUSY / _NEEDS_REPAIR） |
| 主机修复（4 个修复原语） | remote-hosts.json（+ pin） | mutateRepair 的 rename | reason 白名单 + 锁内新鲜磁盘 + 只允许 revision 前进；有测试（tests/remoteHostRepair.test.mjs） | 5a 单 store 成立；不得借此抬信任（INV-3/4/7） |
| 主机迁移（rebind） | 三个 store | journal committed + 每 store 一次原子写 | 逐记录 CAS（权威=内存）+ 幂等 roll-forward；**协调器/装配缺失** | 5a **不成立**（内存权威）；5b 成立；5c 成立 |
| 项目登记（addRemote） | projects.json | save() 的 rename | 无锁、无磁盘 CAS、无 hostId 仍是可解析 profile 的复查 | 5a 必须成立；且 commit 前必须复查 hostId 未退役（否则 INV-1 破） |
| 项目删除（remove + removeByProjectId） | projects.json + session-catalog.json | 两次独立 rename | 顺序执行 + 第二段吞错 | 需要一个具备 5b（可补偿/可重放）的跨 store 删除，或单 API + 补偿 |
| 会话登记（register） | session-catalog.json | writeSnapshot 的 rename | 先远端确认再写（引用只在能联系到主机时产生）；无磁盘 CAS | 5a + hostId 复查 |
| 会话归档 / 移除（dismiss / removeByProjectId / move 的 aliases 写入） | session-catalog.json | 同上 | 单 store 内原子；无磁盘 CAS | 5a（整份文件重写必须基于最新磁盘内容） |

> 会话的 move/archive 不改 hostId，但会**整文件重写**含 hostId 的记录 ⇒ 仍受 5a 约束（实施计划 §5.3 的第 280 行也要求「同一个 catalog 原子写」）。

---

## 3. 候选方案对比

公共约束（所有方案都绕不开）：
- 两个引用 store 与 host store **没有共同的 commit 点**（三个文件三次 rename），跨 store 原子性只能靠 journal + roll-forward（5b），不能靠「一次写」；
- 多版本实例可并行（1.7 第 10 条），任何协议都只能约束「知道协议的写者」；
- 不得把内存比较冒充事务安全（第 4 节）。

### 3.1 方案 A：单写者 + 写前复查（advisory interlock + 双重复核）

机制：把「会新增/删除 hostId 引用」的写入收敛到一个 main 进程内的 owner（引用写入协调器）；owner 在 commit 前做两件事——(1) 复查 hostId 仍能解析到一个非 retired 的 profile（host store 锁内读），(2) 在 tx 锁/journal 存在时退让拒绝。写入本身仍走各自 store。

- 能防住的交错：I-1（登记 vs 退役）的**同进程**版本；I-3（删项目 vs 删会话）的第一段——把两步编排放进一个 owner 就能做补偿；I-4（rebind vs 普通写者）的同进程版本。
- 代价：低-中。不改 store schema；新增一个协调器 + 把既有 3 条写入路径改为经它；需要一条「引用写入必须过 owner」的代码约束 + 契约测试（可仿 tests/remoteHostCrossStoreContract.test.mjs 的 AST 扫描）。
- 失败时的可观测行为：写入在 commit 前被拒，磁盘逐字节不变；稳定码沿用 REMOTE_HOST_REFERENCED / REMOTE_HOST_REBIND_IN_PROGRESS（新码需评审）。
- **防不住什么**：I-2（同一 store 两个写者的丢失更新——owner 只管进程内，另一个**进程/实例**根本看不见它）；I-1 的跨进程版本；任何绕过 owner 的写入者（旧版本、启动扫描回填、未来新入口）；以及「owner 自己读到旧磁盘后写入」的窗口。

### 3.2 方案 B：版本 CAS 令牌（两个引用 store 加 revision + 锁内重读比对 + 每 store 一把跨进程锁）

机制：给 projects.json 与 session-catalog.json 的 schema 增加单调 revision（旧文件缺省 0，向后兼容读）；每条写路径：取本 store 的锁文件（带 owner，判定复用 HostRebindTxLock 的 R6 规则）→ 锁内重读磁盘 → 比对调用方持有的 expected revision → 写 revision+1。冲突以稳定码拒绝，写入不发生。

- 能防住的交错：**I-2**（丢失更新：后写者必须拿到最新 token 才能写）；同 store 的多实例并发写；崩溃遗留锁的可诊断（前提是补 owner）。
- 代价：高。两处 schema 迁移 + 两个 store 的每条写路径 + 两把锁 + 新稳定码 + BUSY 的用户可见语义。属于 Phase 1 污染面（ProjectStore / SessionCatalog 都是位置模型在改的文件）。
- 失败时的可观测行为：新码（例如 PROJECT_STORE_REVISION_CONFLICT / SESSION_CATALOG_REVISION_CONFLICT / *_STORE_BUSY），磁盘不变；调用方可以重新读盘再试，而不是「猜写没写成」。
- **防不住什么**：**跨 store 原子性**（I-5：A 锁 projects、B 锁 host，两者互不冲突；B 先 retire，A 后写引用 ⇒ 仍要方案 A/D 的复查或锁顺序才有解）；用户或旧版本手改 JSON（绕过锁与 revision）；跨 store 的「检查 host 再写引用」仍需在**同一**临界区内完成，否则只是把窗口变窄。

### 3.3 方案 C：先落意图再提交（两阶段：意图记录 + 发布）

机制：引用写入改成两阶段——先在同一 store 的一次原子写中落一条「意图/待定」记录（含目标 hostId 与期望 host revision），复查通过后再原子地发布为正式引用；崩溃遗留的是可诊断的待定记录，而不是悬空引用；读者把待定视为不可用。

- 能防住的交错：I-1 的「产生悬空引用」结果（最坏留下待定记录）；I-3 的半完成（待定可被收敛器补完或回滚）。
- 代价：中-高。schema 加状态字段 + 读侧语义（待定≠可用）+ 待定记录的 GC/收敛；**风险是「忘了把待定当不可用」就等于没做**。
- 失败时的可观测行为：待定记录可枚举、可诊断、可收敛；拒绝时磁盘只有意图记录。
- **防不住什么**：I-2（发布阶段仍需要 CAS，否则两个写者互相覆盖）；I-4；两个实例同时推进同一待定记录（需要幂等 token/CAS）；也不解决两个 store 之间的崩溃（除非把意图放在被引用的 host store 一侧，那就变成 host store 的单点串行，代价转移到 host store）。

### 3.4 方案 D：跨进程串行锁（所有引用写者共用一把锁）

机制：引入一把带 owner 的跨进程锁（复用 tx 锁的 owner/存活判定），所有「会新增/删除/迁移 hostId 引用」的写者都必须先持锁；这是实施计划 §5.2 原文要求的字面实现。

- 能防住的交错：I-1、I-2、I-4、I-6（两个实例同时 retire 同一主机——host store 自身已防）以及多版本实例并行写同一文件的全部交错（**只要写者都知道这把锁**）。
- 代价：最高。需要覆盖 enroll / register / remove / archive / 启动导入 / 扫描回填等十余条路径；锁争用与 BUSY 的用户可见性；崩溃遗留锁的诊断（依赖 owner 元数据）。
- 失败时的可观测行为：拿不到锁 ⇒ 稳定码 BUSY，什么都不写；owner 诊断可读。
- **防不住什么**：I-5（跨两个 store 的中途崩溃仍需 journal/roll-forward）；**旧版本写者**（不知道这把锁的版本会直接写盘，锁保护不了它——这是「多版本并行」产品的硬限制）；用户手改 JSON；写盘本身的失败（盘满/权限）；以及「持锁进程崩溃但锁判定不出」（owner 缺失时只能转人工）。

### 3.5 建议组合与理由

- **建议：A（同进程互锁 + commit 前复查）+ B（两个 store 的磁盘 CAS）+ 既有 journal（5b）**。A 便宜且能立刻消掉最常见的同进程交错；B 是唯一能把 5a 做到「跨进程也不丢更新」的途径；journal 已经提供 5b。
- **D 只有在产品接受**「所有引用写者都必须持锁、多版本并行写同一 userData 会得到 BUSY」之后才值得做；它是唯一能覆盖跨进程 TOCTOU 的方案，但不能替代 A/B（因为它管不了旧版本与崩溃原子性）。
- **C 适合作为局部的登记增强**（尤其是 enroll 这种「先探测再写」的路径），但它不解决 5a，不能单独作为 INV-5 的方案。
- **不要相信**任何一种方案能给出「两 store 之间的事务原子性」：四实体里今天只有一个有跨进程锁与磁盘 CAS，三个文件三次 rename，没有共同提交点。跨 store 的原子性只能等于「journal + 幂等 roll-forward + 可诊断的未收敛态」。

---

## 4. 明确不做什么

1. **不引入第二套 IPC 通道**：跨 store 用例继续走既有 remote:* 域与 main-only 端口；renderer 不得分多次 IPC 自行拼事务（实施计划 §5.2 第 270 行）。
2. **不改 helper 契约**：remote helper 1.6.0 已冻结且真机验过；本计划不新增/修改任何 helper 方法、帧或字段。
3. **不把内存比较冒充事务安全**：任何文档、注释、测试名都不得把「端口拿内存快照比对」说成 CAS；方案 B 落地前，端口层必须显式声明「权威=内存」。
4. **不合并 needs-repair 与 needs-attention**：前者是磁盘一致性，后者是连接终态（既有设计文档 Q10），本计划不动连接状态机。
5. **不新增第二套 locator 规范器**：before/after 比对继续用 canonicalHostLocatorJson（既有设计文档 §4.4 的字节陷阱）。
6. **不删 pin、不降信任、不手改 JSON**：修复路径只走既有原语（三条铁律）。
7. **不给 journal 加 .bak**：journal 丢失的后果是「合法但半迁移」，用同一对 source/target 重跑即可（既有 Q8）。
8. **不做 renderer 侧状态**：项目/会话的引用状态只在 main 持有。
9. **不在本计划内实现**：本文件只设计；「至少两个方案」的对比与门禁就是它的产物。

---

## 5. parity 对照表（能力 × 实体）

### 5.1 持久化实体的写入侧能力（今天）

| 能力 | remote-hosts.json | projects.json | session-catalog.json | ssh-host-keys/&lt;hostId&gt; |
| --- | --- | --- | --- | --- |
| 进程内串行 | 目录锁本身即互斥 | writeQueue | writeQueue | 无 |
| 跨进程锁 | 有（.lock，无 owner） | 无 | 无 | 无（靠 link() 发布天然拒绝覆盖） |
| 磁盘 CAS / revision | 有（锁内重读 + revision+content 比对） | 无（内存 revision+1） | 无（schema 无 revision） | 以 link() 原子发布 |
| 备份 | temp + .bak + 轮换 | temp + .bak + 轮换 | temp + .bak（轮换失败只告警） | 无 |
| needs-repair 停写 | 有（修复原语白名单例外） | 有 | 有 | 不适用 |
| 引用写入可达（生产） | 无 mutator；只读目录 | **有**（addRemote） | **有**（register） | 有（offer/confirm） |

### 5.2 不变量 × 今天的成立情况

| 不变量 | 今天 | 证据 |
| --- | --- | --- |
| INV-1 引用不悬空 | 生产**无机制**保证，仅因 retire 不可达而潜伏 | 1.7 第 3/4 条 |
| INV-2 retire 前完整且空引用扫描 | 读侧成立、有测试；生产不可达 | 第 22/24/27 条 |
| INV-3 信任不继承 / INV-4 唯一信任锚 | 修复原语侧有测试；rebind 侧未装配 | tests/remoteHostRepair.test.mjs |
| INV-5a 写入侧无丢失更新 | **仅 host store 成立** | 第 44/45 条；1.7 第 1/2/8 条 |
| INV-5b 收敛幂等 | 实现+测试有，未装配 | 第 35-43 条 |
| INV-5c 失败可区分 | 已有词表与折叠点；端口直通码有测试 | 第 41 条；既有设计文档 §4.4 |
| INV-11 引用源归属 | 成立（AST 契约测试） | 1.6 |
| INV-12 连接门（journal/tx 存在时拒绝新连接） | 未装配（无 journal 装配） | 1.7 第 6 条 |

---

## 6. 合并门禁

### 6.1 进入实施前的评审门禁（本文件的验收方式）

1. 评审能回答：「实施后哪个具体交错被挡住、哪个仍不会」——本文 3.x 的「防不住什么」一栏就是答案模板；
2. INV-5a/5b 的取舍被显式拍板（Q1/Q2/Q3）；
3. 反例清单（6.3）被接受为「必须先在旧代码上红」，不接受「实现完再补测试」。

### 6.2 实施后必须全绿的测试（建议新增；既有测试全部保持绿）

- tests/projectStoreCas.test.mjs：两个独立 store 实例（模拟两进程）同目录并发写 ⇒ 后写者拿冲突码、磁盘不被覆盖；合法重试（重读后带新 token）成功。
- tests/sessionCatalogCas.test.mjs：同上 + schema v1（无 revision）/ v2 兼容读；损坏快照仍 fail closed。
- tests/remoteHostReferenceInterlock.test.mjs：tx 锁/journal 存在时，enroll/register/remove 一律拒绝且磁盘逐字节不变；不新增 IPC 通道（只测既有域端口）。
- tests/crossStoreEnrollRetireRace.test.mjs：登记与退役交错的端到端回归（见 6.3 反例 2）。
- 既有：本文件第 1 节列出的全部文件必须保持绿（尤其 tests/remoteHostReferenceSources.test.mjs、tests/remoteHostReferenceRegistry.test.mjs、tests/remoteHostStoreLifecycle.test.mjs、tests/hostRebind*.test.mjs、tests/remoteHostCrossStoreContract.test.mjs）。
- tests/crossStoreInv5Counterexamples.test.mjs（见 6.3.1）：默认必须保持「1 pass / 5 skipped / fail 0」；实施后同一门控运行必须从「4 红」变成「全绿」——这是「修复真的发生了」的判据，不允许靠删用例或放宽断言变绿。

### 6.3 必须**红**的反例（先在当前实现上跑红，再修到绿）

| # | 反例 | 今天的期望（红） | 修复后的期望（绿） |
| --- | --- | --- | --- |
| 1 | 两个 store 实例并发写同一 projects.json（模拟两进程） | 后写者覆盖先写者的改动（内存 revision 各自 +1） | 后写者以冲突码失败，磁盘保持先写者内容（逐字节比对） |
| 2 | 登记 vs 退役交错：读 host 存在 → retire 提交 → 写引用 | 产生指向 retired id 的引用（INV-1 破） | 写入在 commit 前被拒（或落在待定/补偿并有稳定码），引用要么指 source 要么指 target |
| 3 | 删项目 + 删会话：第二段失败 | catalog 永久残留 projectId 引用，且无告警 | 显式稳定码 + 可重放补偿；断言最终不残留 |
| 4 | 端口 CAS 是否看得见另一实例写的磁盘内容 | 看不见（权威=内存），会把别人的写入整份覆盖 | 看见（锁内重读 + token 比对），冲突即拒 |
| 5 | 「被拒绝的写入」是否真的没写 | ——（新增断言） | 拒绝路径上 store 文件哈希逐字节不变，且**不靠读侧 fail-closed 蒙过去** |

> 反例 5 是防止「用读侧 fail-closed 的测试冒充写侧安全」的保险：凡声称 5a 的用例，必须断言写入被拒 + 磁盘不变 + 拒绝码明确。

#### 6.3.1 红例已落地（L2，默认 skip，不污染套件）

文件：tests/crossStoreInv5Counterexamples.test.mjs。全部使用**真实 store**（真 ProjectStore / 真 SessionCatalog / 真 RemoteHostStore + 真引用注册表）；唯一替身是 catalog 的 rename 故障注入（注入一次真实写失败，store 本身不假）。

- 门控：默认（不设环境变量）**全部 skip**，套件 fail 0；设 PIDECK_INV5_EXPECT_RED=1 才真正执行。
- 实测（2026-09，基线 4ba0f79f，命令与输出见交接记录）：**CE-1 / CE-2 / CE-3 / CE-4 红，CE-5 绿**。

| 用例 | 对应上表 | 门控实测 | 证明了哪个交错 |
| --- | --- | --- | --- |
| CE-1 | 反例 1 | **红**：磁盘只剩后写者的 /srv/two | 两个写者各自 load→改→save，先提交的远端项目被整份覆盖 |
| CE-2 | 反例 2 | **红**：projects.json 的 hostId ∈ retiredHostIds 且无 profile | 「读 host 存在 → retire 提交 → 写引用」产生悬空引用（INV-1） |
| CE-3 | 反例 3 | **红**：catalog 主文件仍留 1 条 projectId 指向已删项目 | 跨 store 删除第二段失败被吞（返回值 0 与「本来就没有」无法区分） |
| CE-4 | 反例 4 | **红**：端口读回内存旧值、判 applied、覆盖别人已提交的 rebind | 端口 CAS 的权威是内存快照，看不见另一实例已提交的磁盘内容 |
| CE-5 | 反例 5 | **绿**（预期如此）：被引用时 retire 拒绝且 remote-hosts.json 哈希不变 | 拒绝路径不写盘已成立（由 tests/remoteHostStoreLifecycle.test.mjs 的既有保证覆盖）；它同时是「其余红例不靠读侧蒙混」的判据保险 |

> 门控复现：`$env:PIDECK_INV5_EXPECT_RED=1; node --test tests/crossStoreInv5Counterexamples.test.mjs`（默认绿：1 pass / 5 skipped / 0 fail；门控：2 pass / 4 fail）。

#### 6.3.2 实施记录（2026-10，INV-5a 落地）

| 块 | 落地 | 说明 |
| --- | --- | --- |
| 公共原语 | `src/main/persistence/StoreFileLock.ts`（跨进程锁：owner 元数据 + R6 可证陈旧才回收）、`src/main/persistence/storeFileCas.ts`（锁内重读 + `changed` 判定 + 可选 `expectedRevision` 令牌） | `HostRebindTxLock` 改为**委托**同一实现（导出名、稳定码、行为不变），三把锁共用一套 owner/回收规则 |
| `projects.json` | `ProjectStore` 的每一处写路径改为写事务：持锁 → **重读磁盘** → 在最新内容上重放可重放意图 → 有改动才写 `revision+1`；`readHostRecordLocators` 读**磁盘**并把内存对齐到它 | 稳定码 `PROJECT_STORE_BUSY / _REVISION_CONFLICT / _LOCK_UNWRITABLE`（INV-5c）：三者不可合并，用户动作不同 |
| `session-catalog.json` | `SessionCatalog` 同形改造；文件新增可选 `revision`（**不 bump `version`**：旧版仍能读，多版本并行不被锁死）；`load()` 的旧数据归一化改为「令牌相等才写回」的 best-effort | 稳定码 `SESSION_CATALOG_BUSY / _REVISION_CONFLICT / _LOCK_UNWRITABLE`；`revision` 值域非法 fail-closed |
| 引用写入门 | `src/main/remote/RemoteReferenceWriteGuard.ts`：登记/登记会话前复查 host 仍可解析（读磁盘）且无 rebind 事务在跑；删除路径只要求「无事务」 | 三个码各自可行动：`..._REBIND_ACTIVE`（等收敛）、`..._HOST_UNRESOLVED`（重新加主机）、`..._STORE_UNVERIFIED`（修复磁盘）；探测 tx 锁用**真实** bootId/存活探测，不会把活锁删掉 |
| 跨 store 删除 | `src/main/projects/projectRemoval.ts`：顺序固定为**先清引用、后删项目**，两段都不吞错；三处生产调用点（`projectsIpc` 的删除、Web 端删除、启动孤儿清理改为记日志） | 第一段失败 ⇒ 项目不删（无副作用）；第二段失败 ⇒ 引用已清（不悬空），重试即收敛 |
| 同源磁盘根 | `src/main/remote/RemoteHostPaths.ts`：`RemoteHostStore` / `SshHostPinStore` / `HostRebindJournal` / 写入门共用一个路径解析入口 | “锁指向另一个根”这类漂移以类型/单一入口防住 |

**验证**（本机 Linux / Node 24.21，工作树在 `c95d999ef` 之上）：

- 门控红例：`PIDECK_INV5_EXPECT_RED=1 node --test tests/crossStoreInv5Counterexamples.test.mjs` → **6 pass / 0 fail**（实施前为 4 红）；默认（不设变量）仍为 **1 pass / 5 skipped / 0 fail**。
- §6.2 四个新测试：`tests/projectStoreCas.test.mjs`（4）、`tests/sessionCatalogCas.test.mjs`（5）、`tests/remoteHostReferenceInterlock.test.mjs`（5）、`tests/crossStoreEnrollRetireRace.test.mjs`（2）全部绿。
- §1 列出的全部既有套件（含 `remoteHostCrossStoreContract` / `hostRebind*` / `projectStore*` / `remoteSessionRegistration`）保持绿；定向集 1829 项 1820 pass / 2 fail / 7 skip。
- **全量基线对照**：`npm test` 实施后 **7587 项 7555 pass / 19 fail / 13 skip**；在干净基线（stash 后同一命令）为 **7571 / 7539 pass / 19 fail / 13 skip**——测试数与通过数各多 16（就是四个新文件的 16 条用例），**失败集合逐条一致**。
- 两处**判据修正**（§6.3 反例 2 / 3，原断言在原理上不可满足）：① CE-2 原断言同时要求「引用确实写入了」与「该 host 不在 retiredHostIds」，但 retire 会删掉 profile 并只留墓碑，引用一旦写入必然悬空——即本条要禁止的结果；按 §6.3 行 2「修复后的期望（写入在 commit 前被拒）」改写为拒绝 + 稳定码 + 磁盘逐字节不变。② CE-3 原断言在「注入主文件 rename 必失败」之后要求主文件不再残留引用：任何守规矩的整文件写都必须 rename 到那儿（不 rename 等于放弃原子替换），因此不可满足；按 §2.2「具备 5b（可补偿/可重放）的跨 store 删除」改写为「失败带稳定码 + 失败时项目不删（无悬空引用）+ 重放收敛」。两处都是**把断言指向设计自己写的修复后期望**，并补强了「磁盘逐字节不变」。
- 另有两处**旧测试按新语义修正**（不是放宽）：`tests/remoteSessionRegistration.test.mjs` 的「第二次不写盘」改为按路径只数对 catalog 的写（锁文件 open 不算写盘）；`tests/hostRebindStorePorts.test.mjs` 的「落地但抛异常」用例改用「重跑报 already-applied、`migratedSessions=0`、且 catalog 逐字节不变」——旧断言编码的正是被替换掉的「权威=内存」语义。

**仍未做（不得描述为已闭环）**：

1. **跨 store 协调器与启动 `resume` 未装配**（§1.7 第 6 条、§6.4 第 4 步）：journal 的收敛算法与幂等早有实现，但没有生产入口；因此今天若盘上遗留 journal，引用写入会一直退让（fail-closed）而不会自动收敛。
2. **旧版本写者靠检测而非阻止**（§1.7 第 10 条）：磁盘 CAS 能发现「别人推过」，但不知道协议的旧版仍会盲目整份重写。
3. **两 store 之间没有共同提交点**：跨 store 原子性仍等于「journal + 幂等 roll-forward + 可诊断的未收敛态」。
4. **§1.7 第 7 条（主机目录锁没有 owner）未修**：`remote-hosts.json.lock` 仍无 owner 元数据，崩溃遗留只能人工处理——本轮未动它（改动会有 needs-repair 语义的连带影响）。
5. **范围**：本次实施未改动 helper 契约、未新增 IPC 通道、未改 renderer；远端功能仍只在开发态门禁后可见。

### 6.4 实施顺序（若评审通过 A+B）

1. 同源磁盘根（既有设计文档第 25 项）：一个 resolveRemoteHostPaths 入口，避免「锁指向另一个根」；
2. 两个引用 store 的 revision + 锁内重读 CAS（方案 B）+ 迁移兼容读；
3. 引用写入 owner / advisory interlock（方案 A）+ 既有退让语义；
4. 装配协调器与启动收敛（HostRebindCoordinator + 暴露 store 前 resume）；
5. 反例 1-5 转绿，且第 1 节所有既有测试保持绿。

### 6.5 可宣称与不可宣称（实施后更新，2026-10）

**可宣称**：引用扫描 fail-closed；host store 单实体有跨进程锁 + 磁盘 CAS；两个引用 store 的写事务**建立在锁内重读的最新磁盘内容上**（有稳定冲突码与逐字节不变的拒绝路径）；登记/登记会话/删除在有 rebind 事务或 host 不可解析时拒绝；跨 store 删除不再吞错且不会留下悬空引用（先清引用后删项目）；rebind 的收敛幂等已实现（仍有测试覆盖）。

**不可宣称**（继续成立）：不写「跨 store 事务安全已闭环」；不写「等价于跨进程事务」；不写「不会产生悬空引用」——准确表述是「写入侧不再产生**新**悬空引用，且可检测旧版写入；跨 store 原子性仍等于 journal + 幂等 roll-forward + 可诊断的未收敛态」；启动收敛未装配前，遗留 journal 只能靠 fail-closed 阻塞而不是自动收敛。

---

## 7. 待评审拍板的问题

| # | 问题 | 建议 |
| --- | --- | --- |
| Q1 | INV-5a 是否允许收窄为「host store 严格 CAS + 两个引用 store 同进程串行 + 可检测」（接受跨进程丢失更新作为已知残余）？ | 不建议收窄，但可作为「先上 A、后补 B」的阶段划分；收窄必须写进文档与 UI 提示 |
| Q2 | 是否接受给 projects.json / session-catalog.json 加跨进程锁（新 BUSY 语义、复杂度、Phase 1 冲突面）？ | 接受；否则 5a 永远只有 1/4 实体成立 |
| Q3 | 多版本并行写同一 userData 是否必须支持？ | 必须支持（产品既有行为），因此方案 D 只能保护新版本；旧版本的写入必须靠 B 的磁盘 CAS **检测**（而不是靠锁阻止） |
| Q4 | 删项目的两段删除改成什么？ | 保留两段但加显式补偿 + 稳定码；不新造跨 store 事务 API 去假装原子 |
| Q5 | 是否顺带给主机目录锁补 owner（G5）？ | 建议一并做：与 tx 锁共用 owner 判定，能免掉「只能人工删锁」 |
| Q6 | 本文与既有 remote-host-cross-store-design.md 的 INV-5 编号关系 | 既有 INV-5 = 本文 5b；本文把 handoff 未交付项定义为 5a；两份文档以本文为准补充，不推翻既有条目 |

**拍板结果（2026-10）**：Q1 **不收窄**（5a 按本文件实现，不把「只保证写入侧不产生新悬空引用」当作交付）；Q2 接受两个引用 store 各自的跨进程锁与新 BUSY 语义；Q3 必须支持多版本并行 ⇒ 旧版写者靠**磁盘 CAS 检测**而不靠锁阻止；Q4 采取「**先清引用、后删被引用者** + 显式稳定码 + 可重放收敛」，而不是给两段各加一套补偿日志（同样的 INV-1 保证，机制更少）；Q5 主机目录锁 owner **本轮未补**（记为遗留，见 §6.3.2）；Q6 以本文为准。

---

## 8. 本文件的证据来源（审阅用）

- 既有设计：docs/remote-host-cross-store-design.md（INV-1..INV-12、§4 端口契约、§5.3 放弃的保证、§5.4 权威=内存的自认、§7.1 落地清单）、docs/remote-development-plan.md 第 262-272 行（rebind 与跨进程锁的原文要求）、docs/remote-development-handoff.md（历次「未交付」记录）。
- 实现（按符号核对）：src/main/remote/RemoteHostReferenceRegistry.ts、RemoteHostReferenceSources.ts、RemoteHostCatalogView.ts、RemoteHostStore.ts、RemoteHostRepair.ts、HostRebindJournal.ts、HostRebindTxLock.ts、HostRebindConvergence.ts、src/main/projects/ProjectStore.ts、src/main/sessions/SessionCatalog.ts、RemoteSessionScanner.ts、src/main/ipc/projectsIpc.ts、remoteSessionIpc.ts、remoteProjectIpc.ts、src/main/index.ts 的装配点（2426 / 2436-2439 / 3766-3768 / 4339）。
- 测试：本文第 1 节逐条列出的 8 个文件里的测试名（remoteHostReferenceRegistry / remoteHostReferenceSources / remoteHostStoreLifecycle / remoteHostStore / hostRebindStorePorts / hostRebindJournal / hostRebindConvergence / hostRebindTxLock / remoteHostCrossStoreContract / projectStoreRemoteValidation / projectStoreMigration / remoteSessionRegistration）。
