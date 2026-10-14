# 远端写面实施计划（P4.5）

> 状态：**已授权开工**（用户 2026-10「可以」）。按项目门禁——**破坏性远端写入必须先出方案**——本文件即方案。
> 决策与边界以本文件为准；与既有「零新增 helper op」决定一致（写面复用 pinned SSH 短命令通道，不改 helper/runner 契约）。

## 0. 决策记录

**远端「移除记录」＝墓碑（不删远端数据）**（用户 2026-10「看你的建议」）：

- 移除 catalog 记录（与本地一致的部分）+ 记入 **ssh 墓碑**（`dismissedRemoteSessions`，按 `(hostId, remoteSessionId)` 成对记；
  参照 DSH 的 `dismissedDshSessionIds`），**下次远端扫描不再把它列为「可导入」**（否则用户会觉得「删了又回来」）。
- **先停后摘（与本地「先杀后删」同序）**：有运行实例时先走既有「关闭 Agent」链路停掉它，再移出记录、写墓碑。
  **停止进程 ≠ 改数据**——停止链路只终止进程（本地 ssh launcher 收尾 / 远端 runner 的停止信号），
  不读写任何会话文件；因此本操作仍然**零远端数据写入**。留一个 `sessionId` 已不存在的悬空 runtime 绑定会漏事件、
  产生幽灵条目，而且用户找不到停它的入口，所以不停进程的变体已被否决（2026-10 裁决）。
- UI 文案如实改为「**从列表移除**」，并说明**远端文件保留**；不给出「已删除数据」的错觉。
- 删除远端文件（真删）**另立**为显式动作（后续，需二次确认）——本批不做：跨机删除不可回滚，且与
  「先安全、后可逆」的既有取向一致。

## 1. 范围清单（哪些操作是「远端写」）

| 操作 | 远端需做什么 | 归属 |
|---|---|---|
| 移除记录 | 只动本机 catalog + 墓碑；有运行实例时先停进程（**零远端数据写入**） | **P4.5a** |
| 归档 / 取消归档 / 列出归档 | 远端 `move` 进 `.pideck-archive/`（同目录旁）+ 本机归档索引；取消归档不能沿用本机「归档路径」契约（按本机 catalog id 恢复，见 handoff、「P4.5b 已实现」） | **P4.5b 已交付** |
| 删除归档 | 远端 `rm`（**永久删除**，无回收站） | **不做**（P4.5b 明确排除，fail-closed：远端路径不过 IPC、写面无 `rm`）；需另立需二次确认的显式动作 |
| edit-message / delete-message / prepare-resend | 改写远端 JSONL（截断/墓碑行） | **P4.5c 已交付并加固**（`RemoteSessionHistoryWriter` + `RemoteSessionWriteGuard`：分块读回 + 私密临时文件 + SHA-256/文件身份复核后原子 rename；运行中先判后发，原文及改写结果上界 256 KiB，UI 判据已认 ssh locator）；**不做**远端删文件与停态 clone |
| fork / clone（落盘） | pi 自己写新会话文件（经 RPC，不由 PiDeck 写） | **P4.5d 有界切片已实现**（live-runtime 身份链；停态 clone 与临时会话面不做，
  非全量 P4.5d/P4.5c） |
| 改名后的 `name` 行 | 改写远端 JSONL | P4.5c（可经 pi RPC 时优先 RPC） |
| export-HTML | **已交付**（只读远端 + 本机写文件） | ✅ 完成 |

## 2. 执行模型（所有远端写共用）

1. **通道**：既有 pinned SSH 短命令（`buildPinnedSshInvocation` + `SshClientRuntime.run`，每次复查 pin/指纹/路由
   摘要/严格配置）。**不新增 helper op**、不改 runner 契约版本。
2. **参数安全**：远端路径必须**绝对**、规范化、**拒绝含单引号**（沿用 `RemoteTrustKey.canonicalRemoteRoot` 与
   读取侧同源规则）；命令里只允许单引号字面量，禁止字符串插值拼接。
3. **原子性与权限**：改写类操作一律**同目录临时文件 + 原子 rename**，禁止「先截断再写」。消息改写首块以 `umask 077` + noclobber 排他创建，上传期间为 `0600`；固定远端 Node 提交命令复核完整性与原文件版本后才恢复原 POSIX mode。源/临时 inode 的 uid/gid 必须一致（不执行 chown）。失败尝试将残留临时文件恢复为 `0600`，不自动清理、不重试；不承诺复制 ACL/xattr。
4. **失败即停**：破坏性动作**不自动重试**；失败返回稳定码，并把已知的实际状态写进日志与 UI（不谎报成功）。
5. **脱敏**：日志只记稳定码与身份（hostId/sessionId），**不记路径、不记命令、不记正文**（沿用既有纪律）。

## 3. 与运行中远端 pi 的冲突规则（硬性）

- 会话文件正被远端 pi 追加时，**禁止** PiDeck 直接改写该文件（edit/delete-message/resend/改名 name 行）：
  - **优先经 pi 自己的 RPC**（运行中会话的 edit/resend 与本地同路）；RPC 不可用则要求**先停止 Agent**，
    并在 UI 明确提示原因，而不是排队等待或并发写。
- 消息改写同时采用**乐观版本复核**：远端 Node 快照包括 mode/size/dev/ino/uid/gid/mtimeNs/ctimeNs/SHA-256；读前、实际读回内容、读后、提交前一致才可替换。变化返回 `REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED`，现有 IPC 失败包络承接，双语 UI 提示重载，不自动覆盖。
- **不是严格互锁**：最终复核与 rename 之间仍有非协作写者竞态。原子 rename 只保证不出现半截文件，不是文件系统 CAS；另一机器上的 TUI/手工编辑不参与本应用 runtime 锁。提交后丢失 SSH 回执可能结果未知，须重载核对，不保证所有错误都代表「从未提交」。
- 归档/移动同理：**运行中会话禁止 move**（会与 pi 的写入打架）。判断依据：该会话当前是否绑定运行实例
  （`sessionRuntimeCoordinator.getTarget(sessionId)`）+ 远端 pi 是否仍在写。
- 任何"不确定是否在写"的情形 ⇒ **fail-closed 拒绝**并给出「请先停止 Agent」的可执行提示。

## 4. 验证计划

- **单测**：假 SSH exec 按**真实语义**在内存字节串上执行（沿用 `tests/remoteSessionHistoryRead.test.mjs` 的写法）；
  覆盖：命令行只含单引号字面量、拒绝相对路径/含引号路径、临时文件+rename 的两步顺序、失败即停不重试、
  稳定码、运行中会话被拒（不产生任何远端写命令）。
- **真机脚本 / UI**：在 e2e 专用目录做归档 → 列归档 → 取消归档往返，事后只清理本次夹具；
  断言文件确实移动/移回且 SHA-256 不变，恢复后能读回历史；运行中归档被拒且记录保留。
  已由 `e2e/remoteSessionAcceptance.spec.ts` 真机验证（2 passed / 2.4m，2026-10-12）。
  **不包含删除归档**：远端永久删除在 §1/§5 明确排除。
- **内容语义真机 UI（2026-10-13）**：默认产品路包含 `e2e/remote-history-mutations.ts`，仅写本次 e2e 生成的文件。
  编辑 >4096B 中文/换行/引号回复、重发墓碑后同文件新增真实 user/assistant entryId、连续删除 user → assistant 并重载为空；
  用真实本机 `SessionFileEditor` 生成临时副本期望，完整结果逐字节核对，before/after JSONL 附件保留在 trace。
  首跑证明实时 UUID 不能直接命中文件；第二跑拒绝定位，追到本机 UI 时间与远端 pi 时间约 5.8 秒差。
  停止前保存有界摘要（不含正文），保留 pi 原始事件时间，在活动分支按角色/5 秒窗口/内容摘要**唯一**匹配；
  不放宽时间窗、不凭相同正文猜最近一条；有摘要但定位失败的 delete 不再谎报 no-op。第三跑 **2 passed / 3.7m**，
  日志 `/tmp/p45c-real-ui-attempt3.log`；最终重建 main/preload 后再次 **2 passed / 3.9m**（`/tmp/p45c-real-ui-final.log`）。
  11 个针对性测试文件 **190/190**、项目 typecheck、oracle 严格类型检查、spec `--list`、定向 Biome 通过。
  这批初始语义证据不代表真实参考图、工具链或外部并发写者也已真机验收；后续并发追加证据见下项。
- **权限与冲突加固（2026-10-13）**：`tests/remoteSessionWriteGuard.test.mjs` 在一次性本机 POSIX 目录执行生产命令，先写 16 条回归全部红，实施后转绿；扩展为 24 条，覆盖三种 mode 的 edit/delete/resend、多块上传私密性、同长度篡改/追加/同字节换 inode/权限变化/删除、读期间和上传期间变化、临时文件碰撞/软链接、临时内容篡改、超限、rename 失败回收私密权限及归属失配。默认真机 UI 再增加本次专用会话的上传期外部追加反例：原追加逐字节保留、未覆盖成请求的新正文、UI 明确提示重载、残留 temp 为 `0600`；之后重载与 edit/resend/delete 正常闭环仍绿。真机原文件统一收紧为 `0600`，每一步再核对 mode。本切片未降低旧内容语义断言。最终相关14文件 **227/227**、typecheck 和 spec `--list` 通过；最终构建真机 **2 passed / 4.2m**（`/tmp/remote-write-hardening-ui-final.log`），trace/JSONL 在 `/tmp/remote-write-hardening-ui-final-artifacts/`。
- **回归**：本机同操作行为不变；`e2e/remoteSessionAcceptance.spec.ts` 保持绿。

## 5. 边界

- 远端路径与 endpoint 身份规则与读取/trust 侧**同源**（一处实现，禁止第二套归一化）。
- 渲染层不得出现 fingerprint（既有硬边界）：写面的 UI 只显示主机 label 与稳定码文案。
- `RemoteSessionWriteGuard` 固定脚本只使用远端 Node 标准库，经既有 pinned SSH 短命令运行，Node 路径来自 `remotePiRuntimeFacts`；缺失即拒绝，不尝试系统 Node、不依赖 pi SDK、不升级远端软件、不改 helper 协议。保留每条命令长度门禁与 256 KiB 输入/输出上界。
- Windows/macOS 客户端、非 Linux 远端及 ACL/xattr 未在本切片验收；不能外推为完整并发锁或全部元数据 parity。
- 真删远端数据、批量操作、跨项目移动：**不在本计划内**，另行评估与授权。

## 6. 已有远端代码文件编辑保存（2026-10-14，已实现）

用户选择「按照计划」推进的最小切片，不扩展新建/重命名/删除、watch、Git、终端或依赖升级。原会话写面与下面代码文件协议分别拥有边界，不能把 JSONL 专用写入器当通用文件 API。

- **入口与契约**：`remote:project-text-open/save` → `remoteProjectFileIpc` → `RemoteProjectFileService`；跨进程类型在 `shared/types/remoteFiles.ts`，preload 只暴露 projectId、项目相对路径、正文与不透明版本令牌。main 从 ProjectStore 获取 host/root，不接受 renderer 自报绝对路径、摘要或主机身份；非 SSH 项目不回落本机 files API。
- **项目边界**：只编辑已有普通文件。固定 Node 标准库命令每次复核 canonical root 和逐级非链接父目录，Linux `/proc/self/fd` 锚定父目录，叶文件使用 `O_NOFOLLOW`；拒绝越界、根漂移、父/叶软链接，不创建目录或目标文件。Node 是同一 helper 会话已验证的绝对路径，沿用 pinned SSH 与单主机锁；每块在构造 pin/route 前后复核 host store 代数，不新增 helper op/通信协议。
- **有界文本**：源/结果最大 **256 KiB UTF-8 字节**，读取块 96 KiB，上传块 **3072 B**（为长路径保留命令预算），每条命令仍 ≤8192 字符；超限拒绝，不截断。保留 BOM、一致 LF/CRLF；无效 UTF-8、NUL、裸 CR 或混合换行拒绝，不能静默规整原文。渲染草稿另有单文件256 Ki字符与总共5文件的内存预算，超限输入被拒绝并提示，不落盘正文。
- **版本与提交**：main 的128个/30分钟不透明令牌绑定窗口、项目、host/root值快照、相对路径、host store代数和 mode/size/dev/ino/uid/gid/mtimeNs/ctimeNs/SHA-256。保存在任何 await 前消耗令牌，先复核源，再上传同目录随机排他 `0600` 临时文件；提交校验上传摘要/归属、再次复核源，恢复原mode、fsync后rename。失败不自动重试/清理残留temp；rename失败尝试恢复temp为0600。成功签发新令牌。
- **UX 与草稿**：无会话项目面板及已有会话文件抽屉共用 `RemoteFileEditor`，CodeMirror显式保存/Ctrl或Cmd+S，无本机autosave。Jotai草稿按projectId＋相对路径隔离，切文件/项目、关抽屉或保存失败保留；保存完成只推进已发送正文的基准，不盖掉保存期间的新编辑。冲突/回执未知/过期阻止再次保存，要求显式重载；丢弃脏草稿前确认，重载失败仍保留。只回收干净且无在途IO的条目，不驱逐脏草稿。退出应用不持久化草稿，关闭前请保存或复制。
- **真实边界**：不是跨机器内核CAS，最后版本检查到rename仍有非协作写者竞态；SSH提交后回执丢失或提交后读回失配可能已经提交，须重载核对，不能保证所有错误都意味着未写。保留POSIX mode与一致uid/gid，不复制ACL/xattr；原inode被替换，硬链接的其他路径不会同步。仅Linux远端，有`/proc`前提；macOS/Windows客户端与正式安装包未验收。
- **验证**：生产命令在一次性POSIX目录验证权限600/640/644、重复/空保存、同长度/追加/inode/权限/删除冲突、上传期修改、私密残留、窗口/身份/代数/过期令牌、根/软链/路径/编码/上限与草稿策略。真机默认spec增加独立代码文件用例：显式保存/重读字节相等、BOM/CRLF保留、外部修改拒绝且草稿切换后仍在、取消/确认重载、双项目同名隔离、手动断开零隐式重连/写、已有会话抽屉可达；最后远端Agent读源码并实际执行`node test.cjs`。oracle必须看到对应bash toolCall与成功toolResult，不接受模型口头成功。完整spec首次 **3 passed（4.1m）**，最终构建复跑 **3 passed（5.5m）**；提交后读回失配专项加固后定向复跑代码用例 **1 passed（1.2m）**，18个相关测试文件 **202/202**、项目typecheck通过；旧会话/trust门禁不变，最终证据见handoff。
