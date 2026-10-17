# 远端文件管理：冻结契约与实施计划（Phase 5 缺失文件面）

> 状态：**design draft — not implemented（设计草案，未实现）**。本文件只冻结契约与实施边界，**不含任何已交付能力**；在用户逐条签收 §14 的决定、并按 §12 的实施顺序落地并验收前，不得在 UI、README、发布说明或交接文档里声称新建/重命名/删除/创建空项目已可用。
>
> 核对基线：`feat/remote-development`，HEAD `11f68b27d`（2026-10-17）。本文所有 file:line 引用按该基线的干净树核对；若并行车道随后改动了同一文件，实现前须以基线重新核对行号。本设计任务只新增本文件：不改 src、不提交（其他车道的在途改动与本文件无关）。
> 上游依据：[远端开发总计划](remote-development-plan.md) §6.3／§12 Phase 5／§13；[远端写面计划](remote-write-plan.md)（写面纪律、token、快照/原子 rename、边界）；[远端 Git 计划](remote-git-plan.md)（冻结契约写法参照 §5.10／§5.13／§5.15／§5.16，恢复快照参照 §5.13／§5.15）；[交接文档](remote-development-handoff.md)「远端代码文件编辑保存」「远端 Git G4a／G4b」。
> 冻结纪律：本文件一旦经用户签收，实现只能按 §3 的方法表、§4 的路径/TOCTOU 规则、§5 的版本语义、§6 的删除恢复语义、§8 的上限与 §9 的错误码直接落地；要改其中任何一条，先改本文件并重新签收，代码里不得出现「实现时再定」的分支。

## 0. 结论摘要

1. **机制**：新文件面**不新增 helper op**，沿用现有远端文本保存的机制——main 用固定 Node 标准库脚本 + 独立 POSIX argv，经 pinned SSH 在 `withProjectSession` 的主机锁内执行。理由与不选择的替代方案见 §2.3；helper 侧（`RemoteHelperContract`／部署包版本/hash/能力）**零改动**。
2. **新增 8 条 IPC + 1 处 enroll 扩展**（§3.2）：entry-stat、trash-list、file-create、directory-create、entry-rename、entry-delete、trash-restore、trash-prune；另有 `remote:project-enroll` 增加 `mode: "existing" | "create"`。
3. **删除可恢复性**：采用**方案 A：项目内 `.pideck-trash` 回收站**（基于 rename 的快照，不复制字节；main 持有 manifest；显式手动清理，无自动 TTL 删除）。方案 B（Git recovery refs）只在 Git 仓库内、只覆盖单文件、且要过 Git 写门禁，不能作为文件管理删除的通用恢复机制；方案 C（确认后无恢复）只保留给「清空回收站」这一显式永久动作。对比与理由见 §6。
4. **路径/边界**：全部操作以 `ProjectStore` 里的 ssh locator 为准（renderer 只给 `projectId + 项目相对路径`）；每条远端命令都重新复核 canonical root、逐级非链接父目录、`/proc/self/fd` 锚定父目录、叶 `O_NOFOLLOW`。防普通 `..`/symlink 逃逸与根漂移；**不防**同一远端账号下非协作进程在检查与 rename 之间的替换（§4.4）。
5. **版本语义**：只有「改已有条目的状态」的操作需要 main-owned 一次性令牌（kind `entry`，30 分钟／128 条，绑定 sender+project+host/root 值快照+hostRevision+相对路径+inode 身份）。创建类操作靠 `O_EXCL`/mkdir 的 create-only 语义，不需要令牌；恢复/清理靠 manifest 复核 + create-only link/显式确认，不需要令牌（理由见 §5.1）。
6. **新稳定码 18 个**（§9），主进程唯一注册点是新服务的 `CODES` 闭集；helper 侧不适用（**没有新 helper 方法**）；若未来改为 helper op，必须按 G2b 教训两侧同步（§9.2）。
7. **UI**：只在远端项目面板（文件抽屉/无会话空态）出现；testid、确认文案、空/错/未知态与中英文案在 §10 冻结。
8. **仍需用户签收 11 项**，见 §14；在签收前不动 src。

## 1. 范围与非目标

### 1.1 本计划要交付的能力（Phase 5 的文件面）

| 能力 | 用户可见语义 | 入口 |
| --- | --- | --- |
| 新建文件 | 在指定目录创建 **0 字节**普通文件（内容随后由现有远端编辑器显式保存写入） | 远端项目面板工具栏／行菜单 |
| 新建目录 | 在指定目录创建**单个**空目录（非递归） | 同上 |
| 重命名／移动 | 在**同一远端项目根内**改名或跨目录移动文件/目录；不覆盖任何已存在目标 | 条目行菜单 |
| 删除 | 文件或**整个目录树**移入项目内 `.pideck-trash`（可列出、可还原、可显式永久清理） | 条目行菜单（删除前确认） |
| 回收站 | 列出、还原、显式清理 `.pideck-trash` 条目（有上界、可截断标注） | 面板可折叠区 |
| 新建空远端项目 | 在已 pin/已连接主机上创建一个**空目录**并登记为持久项目 | 侧栏「+」→ 远端（SSH）弹框的「新建空目录」模式 |

Phase 5 的原文要求：总计划 §12 Phase 5 第 1 条「远端文件原子写、rename、delete，以及创建空项目目录」（remote-development-plan.md:784）；Phase 3 已把「只允许添加已有远端目录；创建空目录和 git init 属于写操作，移到 Phase 5」（remote-development-plan.md:762）。能力矩阵里「文件树/读写/搜索」远端首发为「必须」（remote-development-plan.md:812），发布条件见 remote-development-plan.md:829。

### 1.2 非目标（明确不做；不能顺手扩大）

| 不做 | 归属／理由 |
| --- | --- |
| 覆盖写（把 A 内容写到已存在的 B、或创建时替换同名） | 本计划只提供 create-only；覆盖写仍只有「打开-编辑-显式保存」一条路（已有 256 KiB 文本面，remote-write-plan.md:83-92） |
| 递归 `mkdir -p`、批量创建/批量删除、跨项目移动 | 与 remote-write-plan.md:81「真删远端数据、批量操作、跨项目移动不在本计划内」一致；单个操作可审计 |
| 删除远端归档会话／会话 JSONL | 仍归 session 写面（remote-write-plan.md:24-27）；本计划只处理项目工作区文件 |
| Git 提交、`git init`、checkout 等 | 归远端 Git 写面（remote-git-plan.md 的 G2/G3/G4 已交付项与 §6 剩余门禁）；本计划不调用 Git，也不写 `.git` |
| 文件 watch／轮询／后台刷新 | 与 G1 一致：显式刷新（remote-git-plan.md:288「手动刷新」）；本计划无 watcher、无定时器 |
| 内容搜索 | 现有只读搜索只做文件名（remote-development-handoff.md:40）；本计划不改 |
| chmod／chown／ACL/xattr 复制 | 现有写面同样不复制 ACL/xattr（remote-write-plan.md:39、:92） |
| 符号链接/特殊文件的创建、删除、重命名 | 只接受普通文件与目录；链接条目在列表里仍是 `other` 且不可操作（RemoteProjectPanel.tsx:196-197） |
| 外部编辑器 URI、受管本机附件上传、端口转发 | 总计划 §13 v1 禁用项（remote-development-plan.md:816、:824、:827） |
| Windows/macOS 客户端、非 Linux 远端、打包/dev 集成验收 | 与现有远端文本写同一未验收边界（remote-write-plan.md:80、:92）；本计划不改变该边界 |
| 把 `.pideck-trash` 当系统回收站等价物宣传 | 交接/AGENTS 纪律：不得声称普通 `unlink` 可恢复；本计划的文案只说「移动到项目内回收站」（§6.8、§10.5） |

## 2. 现状基线（代码事实）

### 2.1 已交付的远端文本打开／保存链路（本计划要复用的机制）

| 环节 | 位置 | 事实 |
| --- | --- | --- |
| 通道定义 | src/shared/ipc.ts:38-39 | 只有 `remote:project-text-open` / `remote:project-text-save` 两条文件面通道 |
| preload | src/preload/index.ts:271-272 | renderer 只能传 projectId、项目相对路径、正文、不透明 version |
| IPC | src/main/ipc/remoteProjectFileIpc.ts:9-19,36-55 | locator 只从 main 读取；senderId 绑定；未启用返回 `REMOTE_FEATURE_DISABLED`；输入校验先于任何远端 I/O（:21-32、:49-50） |
| 服务 | src/main/remote/RemoteProjectFileService.ts:29-49 | 令牌绑定 sender/project/relative/locator 值快照/hostRevision；locator 可能原地重绑，故存**值快照**（:47-48） |
| 令牌 | 同上 :8-10、:35-41、:114-117、:138-141 | 30 分钟／128 条；保存在首个 await 前消费；窗口销毁撤销；跨 sender/项目/路径/主机/代数一律 `REMOTE_FILE_VERSION_INVALID` |
| 读 | 同上 :87-105 | 先 snapshot 拿 revision（mode/size/dev/ino/uid/gid/mtimeNs/ctimeNs/SHA-256），再按 96 KiB 分块读、逐块校验 base64/长度/摘要，最后整体 SHA-256 对比 |
| 写 | 同上 :106-137 | 令牌校验→快照复核→同目录私有临时文件分块上传（3072 B/块）→提交命令复核上传摘要/归属/源 revision→恢复原 mode、fsync、原子 rename→读回核对→签发新令牌 |
| 固定远端脚本 | src/main/remote/RemoteProjectFileCommands.ts:6-8,18-40,42-89,90-106,111-127 | 固定 Node 标准库脚本；`/proc/self/fd` 锚定父目录；父链逐级 `lstat` 非链接；叶 `O_NOFOLLOW`；每次重证 canonical root；命令 ≤8192 字符（:125）；参数全部单引号字面量（:124） |
| 会话与锁 | src/main/remote/RemoteHostConnectionService.ts:748-772、:484-492；RemoteHostOperationLock.ts:1-17 | 整次操作在**每主机 FIFO 锁**内完成：切根+就绪判定+全部 frame；`runCommand` 在构造 pin/route 前后复核 host store 代数；会话绑定建立它时的 manager |
| 上限 | RemoteProjectFileCommands.ts:6-8；RemoteHelperContract.ts:25；SshClientRuntime.ts:33,144 | 正文 256 KiB；读块 96 KiB；写块 3072 B；单条远端命令 ≤8192 字符；单条 SSH 命令 deadline 上限 30 s |
| 门禁 | src/main/index.ts:2355,2467-2474 | 全部远端能力由 `!app.isPackaged && PIDECK_REMOTE_EXPERIMENTAL === "1"` 裁定；未启用时 handler 只返回稳定码 |
| UI | DrawerSurface.tsx:98-99；ProjectEmptyState.tsx:56-65；RemoteProjectPanel.tsx:36-47,58-102,190-201,239；RemoteFileEditor.tsx:10-37 | 远端项目在文件抽屉与无会话空态都挂同一个面板；列表来自 helper 只读 `fs.list`；打开已有文本文件进入 `RemoteFileEditor`（显式保存） |
| 现状自述 | RemoteProjectPanel.tsx:26；src/renderer/src/i18n/rendererCopy.zh-CN.ts:124 | 面板注释与文案都写明「不开放新建/删除/Git」「本功能不会创建新文件」——本计划正是要补这一类 |

### 2.2 缺口清单（本计划要补的全部行为）

| # | 缺口 | 现状行为 | 交付后行为 |
| --- | --- | --- | --- |
| 1 | 新建文件 | 没有通道；`open` 对不存在的文件返回 `REMOTE_FILE_NOT_FOUND`（RemoteProjectFileService.ts:124 的映射；i18n:124） | create-only 创建 0 字节文件；目标已存在 ⇒ `REMOTE_FILE_TARGET_EXISTS` |
| 2 | 新建目录 | 无 | 单层 mkdir；父不存在/非目录分开报码 |
| 3 | 重命名/移动 | 无 | 项目根内 rename/move；需要 entry 令牌；目标已存在拒绝；不覆盖 |
| 4 | 删除 | 无（`remote-write-plan.md:81` 明确本批不做） | 移入 `.pideck-trash`；可列出/还原；显式永久清理 |
| 5 | 回收站 | 无（本机删除走 Electron `shell.trashItem`，src/main/fs/trash.ts:39-56，结构上只对本机路径有效） | 项目内回收站三件套（list/restore/prune） |
| 6 | 创建空远端项目 | 只能登记**已存在**目录（remoteProjectIpc.ts:134-155；resolveRemoteBrowseRoot 要求 `[ -d ]`，RemoteBrowseRoot.ts:49-53） | 新增「新建空目录」模式：父目录 canonical 复核 + 显式确认 + mkdir + 复核后登记 |
| 7 | 保留命名空间 | 无概念 | `.pideck-trash`／`.git`／`.pi` 受保护；列表/搜索隐藏回收站；读拒绝 |
| 8 | UI | 列表只读；无行菜单/工具栏 | 工具栏 + 行菜单 + 三个弹框 + 回收站区（§10） |

### 2.3 决策：扩展「main 构造的有界 Node 命令」，不新增 helper op

**结论：沿用现有机制**（RemoteProjectFileCommands.ts + RemoteProjectFileService + withProjectSession），新增一组**同形态但独立**的固定脚本与服务，不动 helper/runner 契约，不升 helper 版本。

| 判据 | main 构造 Node 命令（采用） | 新增 helper op（不采用） |
| --- | --- | --- |
| 既有纪律 | 远端写面自 P4.5 起明确「复用 pinned SSH 短命令通道，不新增 helper op、不改 runner 契约」（remote-write-plan.md:3-4、:33-41），文本保存即此形态（remote-write-plan.md:87-88） | 与已冻结的写面决策相反 |
| 部署与版本 | 宿主机已有 helper 即可执行（只用远端 Node 标准库）；App 升级即生效 | 改 helper 必须改冻结正文/多文件 bundle 各自 sha、能力声明、部署 manifest、`tests/remoteHelperEntry.test.mjs` 的逐 artifact 不变量（remote-git-plan.md:363-375）；旧 helper 缺能力要拒绝/重连升级 |
| 审计面 | 新脚本独立成文件、可逐行审阅；预算与命令长度用测试钉住（§8） | helper 部署包已按 96 KiB/文件设审阅上限，且 §5.14 已记录「下一个放不下的特性必须拆分内嵌程序或放弃单文件结构」（remote-git-plan.md:365、:372） |
| 语义表达 | 需要「改名失败回滚」「写 manifest 再 rename」「link+unlink 的 create-only 还原」这类多步补偿；一次性脚本最直接 | helper 是「一请求一结果」的 job 模型，不擅长表达多步补偿 |
| 边界证明 | 每条命令**重新**复核 canonical root/父链（RemoteProjectFileCommands.ts:18-40），不依赖 helper 启动时快照 | 需要另建 helper 端 root 锚定与写纪律，等于第二套实现（违反「路径规则一处实现」remote-write-plan.md:77） |
| 代价 | 每次操作一次 SSH 短命令（用户手势，频率低；单条 ≤30 s） | 常驻连接延迟更低，但收益不抵部署/审计成本 |

**冻结不变量**：

1. 不新增 helper method、不改 `REMOTE_HELPER_CAPABILITIES`／`REMOTE_HELPER_ENTRY_VERSION`／任何 bundle 文件 sha（RemoteHelperContract.ts:251-277；RemoteHelperEntry.ts:111）。
2. 新命令只用远端 Node 标准库（`node:fs`／`node:path`），Node 路径取同一 helper 会话已验证的 `session.nodePath`（RemoteHostConnectionService.ts:83-93、:482-492）；缺失/非绝对路径即拒绝，不用系统 Node 兜底。
3. 读路径（列表/搜索/读文件）继续走 helper；本计划**不**把 helper 的 `fs.list` 换成 Node 命令。
4. 新增的固定脚本必须单独成文件（建议 `RemoteProjectEntryCommands.ts`），与正文保存脚本各自拥有预算；不得把新 op 塞进现有 `CONTROL_SCRIPT`（实测压平后已 5,219 字符，余量见 §3.4）。

## 3. 协议与 IPC 方法表（冻结）

### 3.1 分层与运行位置

```text
renderer（RemoteProjectPanel/RemoteTrashPanel）
  └─ desktopApi.remoteHosts.*（preload，参数只含 projectId / 项目相对路径 / 名称 / 不透明 token / trashId）
       └─ main/ipc/remoteProjectEntryIpc.ts（边界校验：只做类型/值域/发送者/启用门禁）
            └─ RemoteProjectEntryService（main 拥有 locator、host/root 值快照、token、sender 绑定、错误码折叠）
                 └─ RemoteHostConnectionService.withProjectSession(hostId, root)   ← 每主机 FIFO 锁
                      ├─ 读：session.request → helper 只读方法（不新增）
                      └─ 写：session.runCommand → pinned SSH 固定 Node 脚本（新增）
远程项目创建：
  remote:project-enroll(mode=create) → remoteProjectIpc → pinned SSH 探针/创建命令（不建 helper 会话）
```

- 所有用户写操作都在 `withProjectSession` 的锁内（含建立会话的 canonical root 复核；RemoteHostConnectionService.ts:395-408、:748-772），因此同主机上「项目 A 的写」不会与「项目 B 的切根」交错。
- renderer **永远不发送** hostId／绝对路径／摘要／主机身份给文件写面；只有 enroll 这一条「用户输入绝对路径」的既有例外（remoteProjectIpc.ts:120「renderer 只提交 hostId 与 candidatePath」）。

### 3.2 方法清单（逐条精确输入/输出）

以下 `relativePath` 一律为**项目根相对 POSIX 路径**：非空、非绝对、无反斜杠、无 NUL/控制字节、无空段/`.`/`..` 段、总长 ≤4096（与 RemoteProjectFileCommands.ts:11-14 同规则，新增的一处实现复用同一 validator，不允许第二套归一化——remote-write-plan.md:77）。

| # | 通道（shared/ipc.ts 常量） | 输入（renderer → main） | 输出（main → renderer） | 远端执行 | 令牌 | 写副作用 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `remoteProjectEntryStat` = `remote:project-entry-stat` | `(projectId, relativePath)` | `{ok:true, stat:{kind:"file"\|"directory", bytes?, mtimeMs}, version}` \| `{ok:false, code}` | ENTRY_SCRIPT `action=stat` | 签发 `entry` | 无（纯读；不读正文） |
| 2 | `remoteProjectTrashList` = `remote:project-trash-list` | `(projectId)` | `{ok:true, entries: RemoteTrashEntry[], truncated}` \| `{ok:false, code}` | TRASH_ADMIN_SCRIPT `action=list` | 无 | 无（只读；不创建回收站目录） |
| 3 | `remoteProjectFileCreate` = `remote:project-file-create` | `(projectId, parentRelativePath, name)` | `{ok:true, relativePath, kind:"file"}` \| `{ok:false, code}` | ENTRY_SCRIPT `action=create-file` | 无 | 新建 0 字节普通文件（O_EXCL，mode 0o666 & umask） |
| 4 | `remoteProjectDirectoryCreate` = `remote:project-directory-create` | `(projectId, parentRelativePath, name)` | `{ok:true, relativePath, kind:"directory"}` \| `{ok:false, code}` | ENTRY_SCRIPT `action=create-dir` | 无 | 新建单层空目录（mode 0o777 & umask） |
| 5 | `remoteProjectEntryRename` = `remote:project-entry-rename` | `(projectId, sourceRelativePath, targetRelativePath, version)` | `{ok:true, relativePath}` \| `{ok:false, code}` | ENTRY_SCRIPT `action=rename` | 消耗 `entry` | 文件：`link`+确认+`unlink`；目录：`rename`（均 create-only，目标不存在） |
| 6 | `remoteProjectEntryDelete` = `remote:project-entry-delete` | `(projectId, relativePath, version)` | `{ok:true, trashId}` \| `{ok:false, code}` | TRASH_PUT_SCRIPT `action=delete` | 消耗 `entry` | 建 `.pideck-trash/<id>/`（0700）+ `entry.json`（0600）+ rename 原条目到 `payload` |
| 7 | `remoteProjectTrashRestore` = `remote:project-trash-restore` | `(projectId, trashId)` | `{ok:true, relativePath}` \| `{ok:false, code}` | TRASH_ADMIN_SCRIPT `action=restore` | 无（见 §5.1） | 文件：`link`+`unlink`；目录：`rename`；目标必须不存在；清理条目目录 |
| 8 | `remoteProjectTrashPrune` = `remote:project-trash-prune` | `(projectId, trashIds: string[])`（1..32） | `{ok:true, removed:string[], kept:{id,code}[]}` \| `{ok:false, code}` | TRASH_ADMIN_SCRIPT `action=prune` | 无（显式确认即授权） | 永久删除回收站条目（有界 walk；见 §6.7） |
| 9 | 既有 `remoteProjectEnroll` 扩展 | `(hostId, path, mode?)`，`mode: "existing"(缺省) \| "create"` | 同现有 `RemoteProjectEnrollResult` | pinned SSH：父目录探针 + 叶状态探针（create 模式）；确认后 mkdir + 复核 + 登记 | 无（确认 broker 一次性 requestId） | create 模式：创建一个空目录 |

补充约束：

- 通道 1-8 的 **preload 方法名**建议 `statProjectEntry` / `listProjectTrash` / `createProjectFile` / `createProjectDirectory` / `renameProjectEntry` / `deleteProjectEntry` / `restoreProjectTrash` / `pruneProjectTrash`；`previewApi.ts` 同步 8 个「功能未启用」stub（与 openProjectText/saveProjectText 同形，previewApi.ts:367-368）。
- 全部 9 条都受 `remoteExperimentEnabled` 门禁（main/index.ts:2355）：未启用时返回 `REMOTE_FEATURE_DISABLED`，**不发送任何 SSH/helper 请求**（与 remoteProjectFileIpc.ts:37,46 同语义）。
- 一条写操作在途时，同一 sender 的其它写操作立即 `REMOTE_FILE_BUSY`（新增 per-sender in-flight 集合；读操作不阻塞）。
- 返回给 renderer 的字段必须逐字段**重建**（不直接透传脚本 JSON），与 remoteProjectIpc.ts:238-239、:293-298 的既有做法一致。

### 3.3 跨进程类型（`src/shared/types/remoteFiles.ts` 追加）

```ts
export type RemoteEntryKind = "file" | "directory";
export type RemoteEntryStat = { kind: RemoteEntryKind; bytes?: number; mtimeMs: number };
export type RemoteEntryStatResult = { ok: true; stat: RemoteEntryStat; version: string } | { ok: false; code: string };
export type RemoteEntryCreateResult = { ok: true; relativePath: string; kind: RemoteEntryKind } | { ok: false; code: string };
export type RemoteEntryRenameResult = { ok: true; relativePath: string } | { ok: false; code: string };
export type RemoteEntryDeleteResult = { ok: true; trashId: string } | { ok: false; code: string };
/** intact 之外的状态都不可还原、只能被显式 prune 或留给用户用终端处理。 */
export type RemoteTrashEntryState = "intact" | "payload-missing" | "payload-changed" | "invalid";
export type RemoteTrashEntry = {
  id: string;                 // ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$，main 生成
  originalPath: string;       // 删除前的项目相对路径（来自 manifest，不是 renderer 自报）
  kind: RemoteEntryKind;
  bytes?: number;             // 仅普通文件
  deletedAt: string;          // ISO 8601 UTC
  expiresAt: string;          // 仅作展示的 TTL 标签（默认 deletedAt + 30 天）；不触发自动删除
  state: RemoteTrashEntryState;
};
export type RemoteTrashListResult = { ok: true; entries: RemoteTrashEntry[]; truncated: boolean } | { ok: false; code: string };
export type RemoteTrashRestoreResult = { ok: true; relativePath: string } | { ok: false; code: string };
export type RemoteTrashPruneResult = { ok: true; removed: string[]; kept: Array<{ id: string; code: string }> } | { ok: false; code: string };
```

`RemoteTextDocument`／`RemoteTextOpenResult`／`RemoteTextSaveResult` 保持不变（remoteFiles.ts:1-4）。

### 3.4 固定远端脚本清单与命令预算

新增 `src/main/remote/RemoteProjectEntryCommands.ts`（与正文命令文件同形态、独立文件）：

| 脚本常量 | 操作 | 关键步骤（顺序即契约） | 压平预算 |
| --- | --- | --- | --- |
| `REMOTE_PROJECT_ENTRY_SCRIPT`（ENTRY_SCRIPT） | `stat` / `create-file` / `create-dir` / `rename` | 锚定父目录（`openAnchor`）→ 按 op：stat=lstat+身份 JSON；create-file=父目录 anchor + `O_WRONLY\|O_CREAT\|O_EXCL\|O_NOFOLLOW` + 校验 size=0/普通文件；create-dir=`mkdirSync(anchor/name,{mode})`；rename=文件 `linkSync(srcAnchor/a, dstAnchor/b)` + 校验目标身份 + `unlinkSync(srcAnchor/a)`；目录 `renameSync` + 校验目标身份 + 源消失 → `recheck(bound)` | ≤5,120；**实测 5,054** |
| `REMOTE_PROJECT_TRASH_PUT_SCRIPT`（TRASH_PUT_SCRIPT） | `delete` | 锚定源父目录 → 复核源身份 → 确保 `.pideck-trash`（mkdir 0700；存在则 no-follow 打开并校验）→ `mkdir(<trash>/<id>,0700)` → 写 `entry.json`（0600、≤8 KiB、fsync）→ 源 `rename` 到 `<trash>/<id>/payload` → 校验 payload 身份 == 源 revision（失配则回滚 rename 回原路径并报 `REMOTE_FILE_CHANGED`）→ `recheck(bound)` | ≤5,120；**实测 4,463** |
| `REMOTE_PROJECT_TRASH_LIST_SCRIPT`（TRASH_ADMIN_SCRIPT 的 list 部分） | `list` | 打开回收站（缺失=空表；非目录/软链 ⇒ `REMOTE_FILE_TRASH_UNAVAILABLE`）→ 枚举 id 子项（≤256，超出 `truncated`）→ 每个 no-follow 打开条目目录、读 `entry.json`（≤8 KiB、可解析、id 匹配）并回传**原始对象**；payload 身份校验在脚本、严格 schema 重验在 main（§6.7 的「invalid」判定不变）| ≤5,120；**实测 4,363** |
| `REMOTE_PROJECT_TRASH_RESTORE_SCRIPT`（TRASH_ADMIN_SCRIPT 的 restore 部分） | `restore` | 读 manifest→严格 schema/id/路径/kind/身份→目标必须 ENOENT 且父链非链接→文件 `link`+校验+`unlink(payload)`；目录 `rename`；清理条目目录（失败只标记，不回滚已还原）| ≤6,100（例外）；**实测 6,018** |
| `REMOTE_PROJECT_TRASH_PRUNE_SCRIPT`（TRASH_ADMIN_SCRIPT 的 prune 部分） | `prune` | 逐个 id 校验→`intact/payload-missing/payload-changed` 才允许→有界 walk 校验（≤20,000 项/≤32 层，超限该条 `REMOTE_FILE_ENTRY_LIMIT` 不删）→ 删除 payload（文件 unlink／目录 rmSync 递归）→ 删 manifest→rmdir→逐条回报 | ≤6,100（例外）；**实测 5,995** |

命令构造与预算：沿用 `buildRemoteProjectFileCommand` 的形态——`[nodePath, "-e", script, action, marker, root, relative?, jsonArgs]` 全部 `quotePosixArgument` 后拼接（RemoteProjectFileCommands.ts），再断言 `command.length <= REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH`（常量 8192 见 RemoteHelperContract.ts）。**实现后实测（squash）**：BOUNDARY 1,086（为 rename/restore 的源/目标两个 anchor 扩展为多锚点版，并压短标识符；文本保存脚本只同步改名、行为不变）、ENTRY 5,054、TRASH_PUT 4,463、TRASH_LIST 4,363 均 ≤5,120；**TRASH_RESTORE 6,018、TRASH_PRUNE 5,995 超出 5,120**——这两条必须携带完整的严格 manifest schema 重验（字段集合/路径规则/payload 身份/有界 walk）与回收站、条目两只 fd 锚定，继续压缩只能放松校验或牺牲可审阅性。经 Lead 批准：**只对 restore/prune 采用单脚本 ≤6,100 的预算例外**，其余脚本仍 ≤5,120；构造器仍以 8192 硬上限拒绝超长命令。测试同时钉住：①每个脚本 ≤各自预算；②任一正常请求命令 ≤8,192；③越界路径/名字/trashId 在**构造命令前**拒绝，不靠远端拒绝；④每个操作的命令数不变。实现期另有一处结构性拆分：`TRASH_ADMIN_SCRIPT` 拆为 list/restore/prune 三个脚本常量（操作、命令数与安全语义不变）以满足「按脚本」预算。

边界脚本复用：从 `RemoteProjectFileCommands.ts:18-40` 导出（或原样搬运）同一份 `BOUNDARY_SCRIPT`；**只允许一处实现**。新增的额外检查：

- `checkRoot()`：每次命令都执行（`realpath(root) === root` 且是目录），不再信任 helper 启动时的 `--root` 快照。
- 父链：逐级 `lstat` 是目录且不是符号链接；父目录以 `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` 打开，`/proc/self/fd/<fd>` 的 `realpath` 必须等于父路径；后续全部路径操作走该 anchor。
- 叶：`O_NOFOLLOW`；`lstat` 后 `isFile()/isDirectory()` 二选一，其余类型 `REMOTE_FILE_ENTRY_UNSUPPORTED`。
- 回收站：`.pideck-trash` 以 root anchor 打开/创建，`O_NOFOLLOW` + 目录校验；所有条目读写都经该 anchor。
- 每条命令输出 `marker + JSON`（marker 含 32 hex nonce），main 只认 marker 后**一个** JSON（沿用 RemoteProjectFileService.ts:50-66 的解析与折叠）。

### 3.5 通道注册位置（缺一即运行时 undefined）

与现有两条文本通道同批量同步（AGENTS.md:29；测试先例 tests/remoteProjectFileIpc.test.mjs:60-75）：

1. `src/shared/ipc.ts`：8 个常量（`domain:action` 格式）。
2. `src/main/ipc/remoteProjectEntryIpc.ts`：8 个 `ipcMain.handle`，并导出 `dispose()`（撤销所有 sender 令牌/in-flight）。
3. `src/preload/index.ts`：`remoteHosts` 下 8 个转发方法（只转发，不做业务）。
4. `src/renderer/src/previewApi.ts`：8 个 `REMOTE_FEATURE_DISABLED` stub。
5. `src/main/index.ts`：装配 `registerRemoteProjectEntryIpc({ enabled: remoteExperimentEnabled, service: remoteHostServiceIfEnabled, locator: projectStore 收窄 })`，并把 `dispose` 注册进 quitCleanup（与 remote-git-reads 的 `quitCleanup.register` 同形，main/index.ts:2466）。
6. 定向测试断言上述 5 处 + 通道名不散落字面量（仓库硬规则，AGENTS.md:124）。

### 3.6 与现有文本保存通道的关系

- 文本保存的行为**零改动**：令牌、上限、草稿、错误码全部保持；回归测试 tests/remoteProjectFileService.test.mjs（262 行）与 tests/remoteProjectFileIpc.test.mjs（75 行）必须原样全绿。
- 两个服务各自持有令牌表（text / entry），互不驱逐；`webContents.destroyed` 时两个服务的 `releaseSender` 都必须被调用（冻结语义是「窗口销毁后两类令牌都不可再用」）。**实现结果（Lead 已批准）**：文本保存 IPC 与文件管理 IPC 是两个模块、各自注册一个 destroyed 监听并撤销自己的令牌表；语义由测试钉住——`tests/remoteProjectEntryIpc.test.mjs` 同时注册两个真实 handler，销毁同一 sender 后断言两类 `releaseSender` 都被调用。
- 新建文件后用户点开它，走**现有** open 通道即可（空文件是合法 UTF-8 文本：snapshot size=0、无分块读取、`text()` 返回空串，RemoteProjectFileService.ts:87-105）。
- 若「新建文件」时要允许直接进入编辑器：本计划**不**新增 create-with-content 通道；UI 创建成功后自动打开该文件（复用 open），内容由用户显式保存。

## 4. 路径、root、symlink 与 TOCTOU

### 4.1 渲染层输入规则（main 边界第一行职责）

- `projectId`：非空字符串、≤256，且 `ProjectStore.get(projectId)` 必须是 ssh 项目（`isRemoteProject`）；未知/本地项目 ⇒ `REMOTE_PROJECT_TARGET_INVALID` / `UNSUPPORTED_PROJECT_LOCATION`（沿用 remoteProjectIpc.ts:203-212）。
- `relativePath` / `parentRelativePath` / `targetRelativePath`：复用 `validateRemoteProjectTextPath` 同一判据（RemoteProjectFileCommands.ts:11-14）：非空、≤4096、不以 `/` 开头、无控制字符/反斜杠、无空段/`.`/`..`。**根（`""`）只在 `parentRelativePath` 合法**（表示项目根），其余为非法。
- `name`：**单段**名字。规则：非空；UTF-8 字节 ≤255；不含 `/`、反斜杠、NUL/控制字节（U+0000–U+001F、U+007F）；不是 `.`/`..`；不等于保留名 `.pideck-trash`；不以 `.pideck-tmp` 结尾（避免与正文保存临时文件形态混淆，RemoteProjectFileCommands.ts:120）。不合法 ⇒ `REMOTE_FILE_NAME_INVALID`。
- `trashId`：`^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$`；非法 ⇒ `REMOTE_FILE_INPUT_INVALID`。
- `version`：`^[a-f0-9]{32}$`（与现有令牌形态一致，remoteProjectFileIpc.ts:49）；格式不对不烧令牌。
- 任何值域失败都在**构造/发送远端命令之前**返回稳定码，测试断言 `commands.length === 0`（先例 tests/remoteProjectFileService.test.mjs:158-162）。

### 4.2 项目边界（每条命令重证，不缓存）

1. canonical root：`fs.realpathSync(root) === root` 且为目录；否则 `REMOTE_FILE_PATH_INVALID`（沿用 :24）。根漂移（持久 locator 指向的目录被替换/软链改指）⇒ 不执行任何写。
2. 父链：从 root 到父目录逐段 `lstat`：必须是目录、不是符号链接；违反 ⇒ `REMOTE_FILE_PATH_INVALID`（与现有「不跟随父/叶软链」一致，remote-write-plan.md:88）。
3. 父目录 fd 锚定：`openSync(parent, O_RDONLY|O_DIRECTORY|O_NOFOLLOW)`，`realpath('/proc/self/fd/'+fd) === parent`；后续 rename/link/unlink/mkdir 全部使用 `anchor/name`，防「检查后目录被换成软链」。
4. 叶：`O_NOFOLLOW` 打开（stat/read）或 `lstat`（分类）；叶是符号链接/FIFO/socket/device ⇒ `REMOTE_FILE_ENTRY_UNSUPPORTED`（不跟随、不删除）。
5. 命令内**前后各复核一次**根与 anchor（保留现有 `recheck(bound)` 形态，:39）；写操作完成后还要复核目标身份（§5.6）。
6. 平台前提：Linux + `/proc` + `O_NOFOLLOW` 可用；否则 `REMOTE_FILE_PLATFORM_UNSUPPORTED`（与现有 :26 同一前提；macOS/Windows 远端未验收）。

### 4.3 保留命名空间

| 路径 | 规则 | 执行点 |
| --- | --- | --- |
| 项目根本身 `""` | 不能 rename/delete；只能作为 parentRelativePath | main 校验 + 脚本 |
| 根级 `.pideck-trash`（含其全部后代） | 用户不可创建/重命名/删除/读；只能经 trash 三通道操作 | main 校验（`REMOTE_FILE_PROTECTED_PATH`）+ list/search 过滤 |
| 根级 `.git`、`.pi`（含后代） | 拒绝 rename/delete/create/move；提示用远端终端 | main 校验 `REMOTE_FILE_PROTECTED_PATH` |
| 任意层级 `.pideck-trash` 段 | 同上（避免把回收站搬到子目录/从子目录恢复） | main 校验 |
| 后缀 `.pideck-tmp` | 新名字禁止使用（保留给正文保存的私有临时文件） | `REMOTE_FILE_NAME_INVALID` |

对**既有只读通道**的最小配套（不改语义、只加拒绝/过滤，避免回收站污染用户体验）：

- `remote:project-list`：返回前过滤掉根级 `.pideck-trash` 这一项（remoteProjectIpc.ts:238-239 的 map 之前）。
- `remote:project-search`：过滤 `path` 第一段为 `.pideck-trash` 的匹配（remoteProjectIpc.ts:293-298）。
- `remote:project-read` 与 `remote:project-text-open/save`：对第一段 `.pideck-trash` 的路径返回 `REMOTE_FILE_PROTECTED_PATH`（新增于各自 validator 之后；不改变其它路径行为）。

> 说明：`RemoteSessionScanner` 的 `.trash`／`.pideck-archive` 跳过列表（src/main/sessions/RemoteSessionScanner.ts:235-236）是**会话根**的既有口径，与本计划的**项目根** `.pideck-trash` 不是同一目录，不能互相替代。

### 4.4 TOCTOU 边界：防什么、不防什么

**本计划防御（可测试的判据）**

| 威胁 | 判据 |
| --- | --- |
| renderer 伪造绝对路径/主机/摘要绕过 | renderer 只传 projectId+相对路径+不透明 token；main 从 ProjectStore 取值快照（RemoteProjectFileService.ts:42-49）；token 不透明且 main 持有全部期望值 |
| `..`/反斜杠/控制字节/绝对路径逃逸 | 词法校验在构造命令前（§4.1） |
| 父目录被换成软链 | 每命令父链 lstat + `O_NOFOLLOW` 目录 fd + `/proc/self/fd` realpath 复核（§4.2） |
| 叶被换成软链 | `O_NOFOLLOW`/lstat 分类；`other` 一律拒绝 |
| 根漂移（目录被删/改名/软链改指） | 每命令 `realpath(root) === root`；不通过即零写 |
| 源文件在「读身份」与「改」之间被外部改（同长度改写/追加/换 inode/chmod/删除） | entry 令牌绑定 mode/size/dev/ino/uid/gid/mtimeNs/ctimeNs；脚本执行前再次比对（沿用现有 revision 比对方式，RemoteProjectFileService.ts:120-127） |
| 目标已存在被覆盖 | 创建用 `O_EXCL`/mkdir EEXIST；文件移动用 `link`（EEXIST）；目录 rename 前 lstat 目标必须 ENOENT；还原文件用 `link`（EEXIST ⇒ 目标已存在） |
| 删除把别的文件搬进回收站（源在检查后、rename 前被替换） | rename 后校验 payload 身份 == 期望 revision；失配即回滚 rename 回原路径并报 `REMOTE_FILE_CHANGED`；回滚失败报 `REMOTE_FILE_RESULT_UNCONFIRMED` |
| 半截文件/半截目录 | rename 在单文件系统内是原子替换；本计划不做「复制再删」 |
| 并发写同一项目 | withProjectSession 每主机 FIFO 锁 + 同 sender 写操作 single-flight（`REMOTE_FILE_BUSY`） |

**本计划不防御（必须如实写进文档与 UI，不得用「已防护」暗示）**

| 不防御 | 说明 |
| --- | --- |
| 同一远端账号下的恶意/非协作进程在「检查→rename」之间替换目录或文件 | 这不是内核 CAS；与现有写面同一限制（remote-write-plan.md:49、:92） |
| 目录 rename 前的「目标不存在」检查与 rename 之间的竞态 | 目标若在这窗口内变成**空目录**，rename 会替换它（非空目录/普通文件会失败）；本计划不声称目录移动是 create-only CAS |
| 目录内部并发写入 | 移动整棵树时不逐文件校验；里层内容可能在操作期间被改，但整体按 rename 时刻的树移动 |
| 提交后 SSH 回执丢失 / 结果未知 | 可能已执行；统一报「结果未确认，请刷新核对」，不自动重试（沿用现有语义，RemoteProjectFileService.ts:59-62 与 i18n:128） |
| 回收站内的 payload 被同账号进程改写/替换 | list 只能按 manifest 身份（inode/size/mtimeNs/ctimeNs）发现变化；伪造这些字段的写者能绕过（非协作 writer），还原前会再校验一次，不匹配即 `REMOTE_FILE_TRASH_ENTRY_INVALID` |
| ACL/xattr/硬链接语义 | rename/link 保留 inode 及其属性（这是相对 Git 快照恢复的优势），但**不复制**任何 ACL/xattr；不承诺 NFS/CIFS 等网络文件系统的 rename 原子性与大小写语义 |
| 跨设备（EXDEV） | `.pideck-trash` 与被删条目若不在同一文件系统（项目内挂载子目录），rename 会失败 ⇒ `REMOTE_FILE_TRASH_UNAVAILABLE`，**绝不回退 unlink** |
| 真实大小写不敏感远端文件系统 | 本机验证主机是 Linux（大小写敏感）；case-only rename 的「同 inode 目标」分支只做纯函数/脚本级测试，见 §11.2 末尾「不纳入本批真机验收」 |

## 5. 冲突与版本语义

### 5.1 令牌种类、消费与 sender 绑定

| kind | 签发时机 | 绑定字段 | 生命周期 | 用途 |
| --- | --- | --- | --- | --- |
| `text`（既有） | `open` 成功后 | sender、projectId、relative、locator 值快照、hostRevision、revision（含 SHA-256） | 30 分钟／最多 128；首个 await 前消费；窗口销毁撤销 | `save`（现状不变） |
| `entry`（新增） | `entry-stat` 成功后 | sender、projectId、relative、locator 值快照、hostRevision、**`RemoteEntryRevision`**（无摘要、无 256 KiB 尺寸上限） | 同上（独立表，独立 128 条） | `rename`／`delete` |
| 无令牌 | `create-file`／`create-dir`／`trash-list`／`trash-restore`／`trash-prune` | — | — | 见下 |

为什么 `entry` 不能复用 `RemoteSessionFileRevision`：现有 `readRemoteSessionFileRevision` 强制 `size <= 256 KiB` 且要求 64 hex 摘要（src/main/remote/RemoteSessionWriteGuard.ts:105-127）。删除/重命名必须覆盖任意大小的文件与目录，且不应为了令牌去读全文（大文件会变成 O(size) 的网络/CPU 成本，且 `stat` 语义不需要正文）。因此新增：

```ts
export type RemoteEntryRevision = {
  mode: number; size: number;
  dev: string; ino: string; uid: string; gid: string;
  mtimeNs: string; ctimeNs: string;
};
// 校验：mode 0..0o7777；size 0..Number.MAX_SAFE_INTEGER；其余为 1..40 位十进制字符串（bigint 转十进制）
```

- **一次性消费发生在任何 await 之前**（现有 save 的硬规则，RemoteProjectFileService.ts:114-117）：同一窗口双击、重复提交、重放都只可能成功一次。
- **sender 绑定**：`webContents.id`；`destroyed` 时两类令牌全撤（§3.6）。跨窗口/跨项目/跨路径/主机代数变化 ⇒ `REMOTE_FILE_VERSION_INVALID`，不消费不匹配的令牌（先比对后删除，与 :114-117 一致）。
- **跨 kind 使用** ⇒ `REMOTE_FILE_VERSION_INVALID`。
- **失败后的令牌**：令牌在 await 前已消费，因此 `REMOTE_FILE_CHANGED`／权限失败／未知结果之后都必须重新 `stat` 才能再操作（UI 靠刷新列表重新走 stat，§10.3）。
- **创建/恢复/清理为什么不需要令牌**：
  - create：`O_EXCL`/mkdir EEXIST 本身就是内核级 create-only 判据，没有「被覆盖的旧状态」需要确认；令牌只会增加一次无意义的 stat。
  - restore：manifest 由 main 生成并在脚本里重验身份；目标用 `link`（EEXIST 即目标已存在）或目录 rename 前的 lstat 保证不覆盖。重复提交的第二次会因目标已存在而失败，不会重复生效。
  - prune：它删除的是**已经离开用户可见路径**的回收站条目，且必须显式确认；没有「用户可见文件的最新版本」需要 CAS（每条的 payload 身份仍会被脚本校验）。
  - 只有「外部可能改动了用户正在看的那个条目」的场景（rename/delete）才值得一次 stat + 令牌。

### 5.2 覆盖语义：不存在

本计划所有通道都**不提供覆盖**。任何「目标已存在」都返回稳定码，不写、不删、不部分执行：

| 操作 | 目标已存在时的结果 |
| --- | --- |
| create-file | `REMOTE_FILE_TARGET_EXISTS`（O_EXCL/EEXIST） |
| create-dir | `REMOTE_FILE_TARGET_EXISTS`（mkdir EEXIST） |
| rename/move（文件） | `REMOTE_FILE_TARGET_EXISTS`（link EEXIST） |
| rename/move（目录） | `REMOTE_FILE_TARGET_EXISTS`（lstat 预检；rename 对非空目录/普通文件也会失败，但预检先给稳定码） |
| trash-restore | `REMOTE_FILE_TARGET_EXISTS`（link EEXIST；目录先 lstat） |

### 5.3 源 revision 冲突（rename/delete）

1. `entry-stat` 返回 revision 与令牌。
2. 用户在 UI 确认时，服务消费令牌，**先**执行 `snapshot` 语义的 identity 命令（同一条 ENTRY_SCRIPT `stat`）比对 revision。
3. 不一致 ⇒ `REMOTE_FILE_CHANGED`，零副作用（不产生回收站条目、不移动文件）。
4. 一致 ⇒ 执行 rename/delete；执行后按 §5.6 复核目标身份；失配 ⇒ 尝试回滚；回滚失败 ⇒ `REMOTE_FILE_RESULT_UNCONFIRMED`。
5. 外部删除源 ⇒ `REMOTE_FILE_CHANGED`（与现有 save 的 ENOENT→CHANGED 映射一致，:124）。

### 5.4 case-only rename（`Foo` → `foo`）

- **判定**：源与目标的父目录相同，且仅 basename 不同、两者 `toLowerCase()` 相等时，视为 case-only 候选。
- **目标状态**：目标 lstat 应为 ENOENT（Linux 大小写敏感，正常 rename 即可）。若目标存在且 `(dev, ino)` 与源相同（大小写不敏感远端文件系统），才进入「同条目」分支；**否则**一律 `REMOTE_FILE_TARGET_EXISTS`（也覆盖「目标恰好是源的硬链接」这种用户误选）。
- **同条目分支**：执行 `rename` 后**必须复核**：新名 lstat 的 `(dev,ino)` 等于源 revision，且旧名 lstat 为 ENOENT。若旧名仍存在（POSIX 对「源/目标是同一 inode 的硬链接」会 no-op 并返回成功），报告 `REMOTE_FILE_RENAME_UNSUPPORTED`，并明确「没有改名」；不谎报成功。
- **未验证**：真实大小写不敏感远端（APFS/CIFS/SMB）上的行为不在本机真机验收范围；只有纯函数判定 + 脚本级 shim 测试。
- 非 case-only 的「目标与源同 inode」一律 `REMOTE_FILE_TARGET_EXISTS`（用户想给硬链接改名应换一个不冲突的名字）。

### 5.5 跨目录移动（同一项目根内）

- 允许：`a/b.txt` → `c/d/e.txt`（目标父目录 `c/d` 必须已存在、是真实目录、非软链；目标名合法）。
- 禁止：跨项目（通道只有 projectId，无法表达另一项目）；移动到项目根之外（路径校验天然阻止）；把目录移进自身或自身后代（lexical 判定：`targetParent === source` 或 `targetParent.startsWith(source + "/")` ⇒ `REMOTE_FILE_MOVE_INTO_SELF`）；重命名受保护路径（§4.3）。
- 文件移动用 `link(srcAnchor/a, dstAnchor/b)` + 校验目标身份 + `unlink(srcAnchor/a)`：避免 `rename` 对已存在目标的覆盖；两个父目录各自 anchor 校验。**link 不可用的文件系统**（FAT/exFAT/某些网络挂载）⇒ `REMOTE_FILE_RENAME_UNSUPPORTED`，**不回退 rename 覆盖**。
- 目录移动用 `rename`（目录不能 link）：先 lstat 目标 ENOENT，再 rename，再复核目标身份与源 ENOENT；若目标存在 ⇒ `REMOTE_FILE_TARGET_EXISTS`。
- EXDEV（跨挂载点）⇒ `REMOTE_FILE_RENAME_UNSUPPORTED`，不回退复制。

### 5.6 写后复核与「结果未确认」

每条写命令的成功判据不是「脚本没抛错」，而是脚本内**回读**：

| 操作 | 成功判据 |
| --- | --- |
| create-file | 目标 `lstat` 普通文件、size=0、mode 合法；父链 recheck 通过；否则 `REMOTE_FILE_RESULT_UNCONFIRMED` |
| create-dir | 目标 `lstat` 目录；父链 recheck 通过 |
| rename（文件） | 目标 lstat `(dev,ino)` == 源 revision；源 lstat ENOENT；父链 recheck |
| rename（目录） | 同上（目录身份：dev/ino/mode/mtimeNs/ctimeNs） |
| delete | payload lstat 身份 == 源 revision；条目 manifest 可读回且字段一致；源路径 ENOENT |
| restore | 目标 lstat 身份 == payload/manifest 身份；payload 已消失；条目目录清理完成或标记为 deferred |
| prune | 每条 payload 消失 + manifest 删除；单项失败进 `kept` |

统一语义（沿用既有写面）：

- 命令**发出前**的任何失败 ⇒ 明确稳定码，零副作用（可断言原文件字节/元数据不变）。
- 命令**发出后**回执丢失/超时/断线/读回失配 ⇒ `REMOTE_FILE_RESULT_UNCONFIRMED`：不自动重试、不回滚（回滚本身也是写，可能再失败）、UI 保留「结果未确认，请刷新核对」直到用户显式刷新。
- 失败即停：本计划**没有重试逻辑**，也没有后台补偿任务。

### 5.7 与正在运行的远端 pi/编辑器草稿的关系

- 远端 pi 运行时会读写项目文件（Agent 操作）；本计划**不做 runtime 互斥**（与 Git 面板对基线的态度一致：只保证自己的一致性协议，不声称锁住其它 writer）。删除/重命名一个正在被 Agent 写的文件属于产品风险，UI 在确认文案里提示「其他程序可能正在使用该文件」。
- 编辑器草稿：`RemoteFileEditor` 的令牌只对**打开时的相对路径**有效（RemoteProjectFileService.ts:114-117）。若该路径被 rename/delete：
  - 保存时 snapshot 失败 → 现有映射为 `REMOTE_FILE_CHANGED`／`REMOTE_FILE_NOT_FOUND`（:124），UI 保留草稿并提示「文件已变化/不存在，请复制内容后重载」——本计划不改这条路径。
  - delete/rename 成功后，若同一路径有**干净**草稿，渲染层清理该草稿；**脏**草稿一律保留（不自动丢弃用户输入），并显示 stale 提示。
- 用户正在编辑一个目录内的文件、而该目录被删除：同上（保存会失败、草稿保留）。

## 6. 删除可恢复性：方案、建议与精确语义

### 6.1 背景与纪律

- 本机所有「用户主动删除」必须走系统回收站（src/main/fs/trash.ts:3-14、:39-56；FileSystemService.ts:181-182），回收站不可用时**直接报错而不是硬删**。
- 远端没有等价物：Electron `shell.trashItem` 只操作本机路径；远端账号的 XDG Trash 目录没有被授权/建模，且跨主机不可观测。**不能**把远端 `unlink` 说成可恢复（remote-git-plan.md:47、:436；remote-write-plan.md:17、:26）。
- G4 的剩余门禁要求「可恢复远端方案须定义位置、权限、容量、TTL、恢复与失败语义；无方案时不开放」（remote-git-plan.md:436）。本 §6 就是逐条回答这六项。
- 现有 Git 恢复快照的经验（G4a：先写快照再动文件；G4b：列出/还原/CAS 删除）是**参照**，但不是本计划的实现载体（见 6.3）。

### 6.2 方案 A（推荐）：项目内 `.pideck-trash`，rename 即快照

**机制**：删除 = 把条目 `rename` 到项目根的 `.pideck-trash/<id>/payload`，同时写 `entry.json`（manifest）；还原 = 反向 rename/link。**快照语义是 main-owned CAS**：删除命令先用 entry 令牌里的 expected revision 复核源条目（§5.3），复核通过后把**原 inode** 原子 rename 进回收站，并把恢复所需的全部身份/来源写进 main 生成的 manifest；还原时再按 manifest 身份做一次 CAS 校验。因此「快照」在这里不是字节副本，而是「身份已确认的原条目 + main-owned 恢复记录」。**不复制字节**，因此：

- 原 inode 保留 mode/uid/gid/mtime（以及 ACL/xattr——不复制也不需要复制）；比 Git 快照只存字节更强（Git 快照会丢 uid/gid，且只支持文件）；
- 目录树是 O(1) 移动，不需要遍历（大目录/大文件不产生额外传输与超时风险）；
- 位置就在项目根，与原条目**同一文件系统**（正常情况下），不依赖远端 home、不新增授权根、不新增 helper/协议；
- 回收站生命周期与项目数据同生命周期（项目删除/迁移时回收站随之移动）；
- 与现有写纪律同源：main-owned 期望值 + 固定 Node 脚本 + pinned SSH + 主机锁。

**代价/已知缺陷**：

- 会在项目根产生一个对用户与 Git 可见的目录：`git status` 多一条未跟踪项 `.pideck-trash/`（只一条目录项，不是逐文件）；PiDeck 列表/搜索隐藏它；**不自动写 .gitignore 或 .git/info/exclude**（见 §14 第 3 条）。
- 跨挂载点条目（项目内挂载了子目录）无法 rename 进回收站 ⇒ fail-closed `REMOTE_FILE_TRASH_UNAVAILABLE`，不回退 unlink。
- 回收站不自动清理；容量不经管（见 6.6 的容量语义）。
- 不是「系统回收站」：其他工具/用户看不到也不需要看到；文案必须如实。

**数据布局（冻结）**：

```text
<projectRoot>/.pideck-trash/                     # mode 0700；由 delete 首次创建；rename 前 no-follow 校验
  <id>/                                          # id = YYYYMMDDTHHMMSSZ-<8hex>（UTC，main 生成）
    entry.json                                   # mode 0600；≤8 KiB；严格 schema；写后 fsync
    payload                                      # 原条目（文件或目录树），保持原名字段在 manifest
```

`entry.json`（schemaVersion 1，字段集合封闭）：

```json
{
  "schemaVersion": 1,
  "id": "20261017T093012Z-1a2b3c4d",
  "originalPath": "src/old name.ts",
  "name": "old name.ts",
  "kind": "file",
  "bytes": 1234,
  "deletedAt": "2026-10-17T09:30:12.000Z",
  "expiresAt": "2026-11-16T09:30:12.000Z",
  "revision": { "mode": 33188, "size": 1234, "dev": "…", "ino": "…", "uid": "…", "gid": "…", "mtimeNs": "…", "ctimeNs": "…" }
}
```

- `bytes` 只对普通文件存在；目录不计算大小（不遍历）。
- `expiresAt` 只是**展示用 TTL 标签**（默认 30 天），**不触发任何自动删除**；过期条目仍可还原（恢复优先于回收）。
- schema 严格：未知字段、缺失字段、类型错误、路径不合法、id 与目录名不一致 ⇒ 该条目 `state:"invalid"`，列出但**不可还原、不可被 prune 自动删除**（避免误删未知数据），文案提示用终端处理。

**权限**：`.pideck-trash` 0700、条目目录 0700、manifest 0600、`payload` 继承原条目权限（rename 保留）。不 chown、不 chmod 原条目。

### 6.3 方案 B（不采用为文件管理删除机制）：Git recovery refs

现状（已交付，可复用的事实）：G4a `git.discard` 在动文件前用 `hash-object -w --no-filters` + `commit-tree` + `refs/pideck/recovery/<stamp>` create-only CAS 保存原始字节（remote-git-plan.md:344-350）；G4b 提供 `git.recoveryList/Restore/Drop`，列表只服务「提交树里恰好一个路径」的条目，上限 64，还原创建路径时要求目标不存在或与 index 一致（remote-git-plan.md:381-387）。

**为什么不能作为本计划的删除恢复机制**：

1. **只在 Git 仓库内**：Phase 5 还包括非仓库项目；`git init` 属于 Git 写面且要有单独门禁（本计划不调用 Git）。**非仓库项目**的删除将无恢复。
2. **只覆盖单文件**：G4a 确实覆盖仓库内的**未跟踪文件**（`git.discard` 的 `untracked` 组，remote-git-plan.md:344-345），但仅限单文件、且要过 Git 写门禁；G4a／G4b 明确不做目录递归（remote-git-plan.md:350、:398），而文件管理必须能删目录。
3. **要过 Git 写门禁**：hooks/hooksPath/filter/签名/进行中操作一律拒绝（remote-git-plan.md:345）；一个与 Git 无关的文件删除不该因为仓库配置被拒。
4. **元数据不保真**：Git 只记 mode 100644/100755 与字节，还原不保留 uid/gid/mtime/xattr（G4b 还原语义，remote-git-plan.md:383-384）；本项目最需要的是「拿回原文件」，而不是「拿回一份内容副本」。
5. **恢复语义不同**：recovery ref 是 Git 对象库里的旁路日志，用户在 Git 面板里管理；把文件删除的恢复混进 Git 面板会让「删一个文件」与「丢弃工作区改动」出现两套不同的恢复入口，违反「一个 UI 能力一个挂载点」的既有取向（AGENTS.md 模块内聚规范）。
6. **容量更差**：每次删除在 `.git/objects` 新增 commit+tree+blob≈文件大小，且不自动清理（remote-git-plan.md:348）；rename 回收站是零复制。

**保留结论**：Git 面板的 `git.discard`／未跟踪文件删除继续使用 G4a／G4b 的 recovery refs（已交付，不在本计划改动范围）；**文件管理面板的删除不使用 Git**。两个入口的恢复面各自归属，UI 文案不得混称。

### 6.4 方案 C（不采用为普通删除，仅用于「清空回收站」）：显式确认 + 无恢复

- 「清空回收站／永久删除回收站条目」：用户显式确认后**永久删除**（无恢复）；这是唯一允许「删了就是删了」的地方，因为被删对象**已经离开用户可见工作区**，且已给过用户一次可恢复窗口。
- 普通文件/目录删除**不提供**「确认后直接 unlink」选项：那会把「远端没有回收站」变成默认路径，与 6.1 的纪律冲突。
- 如果 `.pideck-trash` 不可用（被同名文件占用/项目根不可写/跨设备），**不提供降级 unlink**；返回 `REMOTE_FILE_TRASH_UNAVAILABLE`，提示用远端终端。这是本计划唯一「做不到就不给做」的硬边界。

### 6.5 对比与推荐

| 判据 | A：项目内回收站 | B：Git recovery refs | C：确认后无恢复 |
| --- | --- | --- | --- |
| 覆盖非 Git 项目 | ✅ | ❌ | ✅ |
| 覆盖目录树 | ✅（rename 整树） | ❌（只单文件） | ✅ |
| 元数据保真 | ✅（同 inode rename） | ❌（只字节+mode 位） | — |
| 额外网络/CPU 成本 | ~0（rename） | O(文件大小) 写对象库 | 0 |
| 依赖 Git 门禁/仓库形态 | 不依赖 | 依赖（hooks/filter/签名/进行中操作） | 不依赖 |
| 恢复入口 | 文件面板「回收站」 | Git 面板「恢复」 | 无 |
| 磁盘占地/清理 | 项目内可见、手动清理 | 对象库、手动 `update-ref -d` | 无 |
| 用户可理解性 | 高（就是「项目里的垃圾桶」） | 中（Git 语义） | 低（危险） |
| 与既有纪律一致 | 高（先可逆、后破坏） | 中（已用于 Git 面） | 仅限清空回收站 |

**推荐 A**，并把 C 只用于「清空回收站」。理由：①Phase 5 同时包含非仓库项目；②目录删除必须有恢复；③rename 是零复制的原 inode 移动，保真度最高且成本最低；④它不扩大 helper/协议/授权链，和现有写面同一套纪律；⑤恢复入口天然属于文件面板，不与 Git 面板的恢复语义打架。B 保留为 Git 面已交付能力（不在本计划内变更）。

### 6.6 回收站的容量、TTL 与清理语义（回答 G4 六项）

| 项 | 冻结值 |
| --- | --- |
| 位置 | `<projectRoot>/.pideck-trash/`（仅项目根；不跟随项目 locator 以外的目录） |
| 权限 | 目录 0700、manifest 0600、payload 保留原权限；不 chown/chmod 原条目 |
| 容量 | **不设硬上限**（硬上限会阻止用户释放空间）；用户可见：每条大小（文件）与总数；列表上限 256 条（超出 `truncated:true`）；prune 单次 ≤32 条；单条目目录 walk ≤20,000 项/32 层（超限 `REMOTE_FILE_ENTRY_LIMIT`，该条不删） |
| TTL | 展示用 30 天（`expiresAt`）；**没有自动删除**、没有远端定时器、没有后台任务；清理只能由用户显式发起 |
| 恢复 | 仅 `state:"intact"` 可还原；还原到原路径；目标必须不存在；父目录必须存在且非软链；不自动建父目录；不跨项目 |
| 失败语义 | 快照（manifest）建立前的失败：零副作用（原条目未动）；manifest 建立后/rename 后的失败：`REMOTE_FILE_RESULT_UNCONFIRMED`，不自动重试/回滚；条目可能处于 `payload-missing`/`payload-changed`，如实列出 |

### 6.7 回收站三通道的精确语义

**list（`remote:project-trash-list`）**

1. `.pideck-trash` 不存在 ⇒ `{ok:true, entries:[], truncated:false}`（不创建）。
2. 存在但不是目录/是软链 ⇒ `REMOTE_FILE_TRASH_UNAVAILABLE`。
3. 枚举子项：名称必须匹配 id 正则；不匹配的条目**忽略**（不是本应用创建的，不展示也不 prune）。
4. 每条：`entry.json` 必须存在、≤8 KiB、完整读回、严格 schema、`originalPath` 重新过 §4.1 路径规则、id 与目录名一致、payload 存在且身份 == manifest revision。
5. 状态：全部满足 ⇒ `intact`；payload 不存在 ⇒ `payload-missing`；身份不符 ⇒ `payload-changed`；manifest 缺失/损坏/字段非法/条目目录含未知文件 ⇒ `invalid`。
6. 排序 `deletedAt` 倒序；最多 256 条；超出 `truncated:true`（**有标注的截断**，不假装完整——与 `fs.searchNames`／`git.recoveryList` 同一先例）。
7. 输出不含正文、不含绝对路径（`originalPath` 是项目相对路径）。

**restore（`remote:project-trash-restore`）**

1. 只接受 `trashId`（main 生成、脚本复核）；不得由 renderer 指定恢复路径（路径来自 manifest）。
2. 重新读 manifest + 校验 payload 身份（防止 list 之后被替换） ⇒ 不符 `REMOTE_FILE_TRASH_ENTRY_INVALID`；id 不存在 ⇒ `REMOTE_FILE_TRASH_ENTRY_NOT_FOUND`。
3. 目标路径：manifest.originalPath 的父目录必须存在、逐级非链接；目标必须 ENOENT（lstat）⇒ 否则 `REMOTE_FILE_TARGET_EXISTS`。
4. 文件：`link(payload, targetAnchor/name)`（EEXIST ⇒ TARGET_EXISTS）→ 校验目标 `(dev,ino)` == manifest revision → `unlink(payload)`。目录：`rename(payload, target)` → 校验身份与源 ENOENT。
5. 清理条目：删 `entry.json` → rmdir 条目目录；清理失败不使已完成的还原变成失败，只把该条目标记为待清理（下次 list 会显示 `invalid`/残留）；返回 `{ok:true, relativePath}`。
6. 还原后不刷新用户其它状态（由 UI 显式刷新目录）。

**prune（`remote:project-trash-prune`）**

1. 只接受 `trashIds`（≤32，去重后仍 ≤32）；每个 id 必须匹配；不存在 ⇒ 该条进 `kept`（code `REMOTE_FILE_TRASH_ENTRY_NOT_FOUND`）。
2. 只处理 `intact`/`payload-missing`/`payload-changed`；`invalid` 一律进 `kept`（`REMOTE_FILE_TRASH_ENTRY_INVALID`），**永不递归删除无法识别的目录**。
3. `payload` 为目录时先有界 walk（20,000 项/32 层）复核规模；超限 `REMOTE_FILE_ENTRY_LIMIT` 进 `kept`，不删。
4. 删除：文件 unlink；目录 `rmSync(recursive, force:false, maxRetries:0)`；然后 manifest、条目目录。
5. 逐条结果：成功进 `removed`，失败进 `kept` 并带稳定码；单条失败不影响其它条；整体仍 `ok:true`（这是有界批量删除，不是「全有或全无」）。
6. UI「清空回收站」= 对当前可见条目 id 调用 prune（≤32/次；超过则提示分批）；文案明确「永久删除，无法恢复」。

### 6.8 UI 义务与文案纪律（含回收站的 Git 可见性说明）

- 删除主操作文案：文件「删除文件」、目录「删除文件夹」，确认框正文必须写明「将移动到项目内回收站（.pideck-trash），不立即永久删除；可从回收站还原」。
- 目录删除额外写明「整个目录树会被移动到回收站」（rename 是整树移动）。
- 永久清理文案必须写明「永久删除回收站中的条目，无法恢复」。
- 不得出现「系统回收站」「与本地删除相同」等表述；也不得承诺自动清理。
- 若 `.pideck-trash` 存在会给 Git 带来一条未跟踪项，面板可给一次性的说明文案（不自动改 .gitignore）。

## 7. 创建空远端项目（authorization outside the project root）

### 7.1 用户路径

侧栏「+」→ 远端（SSH）→ 现有登记弹框（RemoteProjectEnrollDialog.tsx:39-164）新增模式选择：

- `使用已有目录`（默认，行为与现在完全一致）；
- `新建空目录`：用户输入**一个尚不存在的绝对路径**；弹出确认框显示「将创建该目录并添加为项目」；确认后 main 创建、复核、登记并返回 projectId。

入口唯一挂载点保持不变（App 装配的登记弹框；RemoteProjectEnrollDialog.tsx:12-20 的「全应用唯一挂载点」原则）。

### 7.2 授权模型（为什么可以先创建再登记）

创建目录发生在**任何项目根之外**，因此不能复用 `withProjectSession`（它需要一个项目 root 来启动/切换 helper）。设计如下：

1. **主机信任已存在**：只允许对「已验证 pin 且可连接」的主机发起（与现有 enroll 一样先 `resolveService`，remoteProjectIpc.ts:141-142、:178-179）。不新增信任链，不绕过 pin/route 复核。
2. **显式确认**：复用现有 `PendingConfirmationBroker`（60 s TTL、最多 128 条、一次性、绑定 sender+action+subject+stateDigest；src/main/security/PendingConfirmationBroker.ts:22-60），**新增一个独立的 create 动作与推送通道**（不复用 enroll 的 requestId 语义；两者可同时挂起而互不串扰——与现有 host pin/repair/enroll 各自独立 broker action 的做法一致，remoteProjectIpc.ts:114-132）。
3. **确认内容**：确认框展示 host label、用户输入的路径、canonical 后的父目录、叶名、以及「目录当前不存在，将在远端创建」；`stateDigest` 绑定 `(hostId, parentCanonical, leaf, mode)`，确认窗口内父目录/叶状态变化则 `CONFIRMATION_CHANGED`。
4. **命令形态**：与 `resolveRemoteBrowseRoot` 同源——pinned SSH 短命令（`buildPinnedSshInvocation` + `SshClientRuntime.run`），路径全部单引号字面量，不经过 shell 插值（RemoteBrowseRoot.ts:49-66、:92-104）。创建命令只做单层 `mkdir`，不带 `-p`、不覆盖、不改 mode（0777 & umask）。
5. **不需要项目 trust**：项目 trust 决定远端 pi 是否加载项目 `.pi` 资源，与「创建一个空目录」无关；本流程不授予任何 trust。
6. **不经过 helper 会话**：创建命令是独立短进程，不碰 helper 的 `--root`；与其它项目的读写并发没有共享 helper 资源。它不持有主机操作锁——但它是「不读项目文件、不依赖当前 helper」的一次性命令，且每次 `buildPinnedSshInvocation` 都复核 pin/route/代数（与现有 root 探针同一安全前提，RemoteBrowseRoot.ts:92-104）。

### 7.3 精确步骤（create 模式）

1. **输入校验**（main）：`path` 为绝对 POSIX、≤4096、无控制字节、不以 `/` 结尾、非根、无空段/`.`/`..`（复用 RemoteBrowseRoot.ts:56-66 的 `assertProbePath` 规则）。
2. **父/叶拆分**：main 纯字符串拆成 `parent` 与 `leaf`（要求 `parent + "/" + leaf === path`）；`leaf` 走 §4.1 的 name 规则（但不允许已存在）。
3. **父目录 canonical 复核**：pinned 命令：`readlink -f -- <parent>` 成功 + `[ -d ]` + 输出必须等于 `parent`（不改写用户的输入；不一致即 `REMOTE_BROWSE_ROOT_UNRESOLVED`／`REMOTE_PROJECT_ROOT_CHANGED`，同现有 canonical 语义 RemoteBrowseRoot.ts:92-104）。
4. **叶状态探针**：命令返回 0 = 不存在（`[ -e ]` 与 `[ -L ]` 都不成立）；3 = 父不存在；5 = 父不是目录；6 = 叶已存在（⇒ `REMOTE_PROJECT_TARGET_EXISTS`）；其他 = `REMOTE_BROWSE_ROOT_PROBE_FAILED`。
5. **确认**：begin broker（action `remote:project-create`）+ 推送确认；用户 deny ⇒ 无任何写；过期 ⇒ `CONFIRMATION_EXPIRED`（UI 可重新发起）。
6. **批准后复核 + 创建**（同一确认的 stateDigest 已绑定）：再次执行步骤 3/4（父/叶仍与确认时一致，否则 `CONFIRMATION_CHANGED`）；pinned 命令 `mkdir -- <path>`：
   - 成功 ⇒ 进入 7；
   - EEXIST ⇒ `REMOTE_PROJECT_TARGET_EXISTS`（不删除、不覆盖；用户可改用「已有目录」模式）；
   - 父消失/权限/IO ⇒ `REMOTE_PROJECT_PARENT_NOT_FOUND`／`REMOTE_FILE_PERMISSION_DENIED`／`REMOTE_PROJECT_CREATE_FAILED`。
7. **复核 canonical**：`resolveRemoteBrowseRoot(path)` 必须返回 `path`（新目录为空且 canonical；若不一致 ⇒ `REMOTE_PROJECT_ROOT_CHANGED`，目录已创建但**不登记**，文案说明）。
8. **登记**：调用现有 enroll 端口 `ProjectStore.addRemote({hostId, canonicalRemotePath: path})`（ProjectStore.ts:305-346；写入侧仍用 `readSshProjectLocator` 校验）；返回 projectId。登记失败 ⇒ `REMOTE_PROJECT_TARGET_INVALID`（目录已创建，可改用「已有目录」重试）。
9. **结果未知**：第 6 步命令已发出但回执丢失 ⇒ `REMOTE_PROJECT_CREATE_UNCONFIRMED`；UI 提示「请重新解析该路径；若已存在，可直接用『已有目录』登记」。**不自动重试 mkdir**。

### 7.4 与 ProjectStore／root 复核的关系

- `ProjectStore` 不改：仍只接受 main 解析/确认过的 canonical 路径（ProjectStore.ts:306-314）。
- 登记后第一次打开项目面板时，`withProjectSession` 会像现有项目一样复核 canonical root（RemoteHostConnectionService.ts:395-408）；创建流程末尾的复核是「登记条件」，不是替代。
- 空目录的语义：用户创建后得到的是一个空项目（面板显示现有空目录提示，i18n 键 `project.remote.empty`），随后可用本计划的「新建文件」或远端 Agent 生成内容。**不**自动 `git init`（Git 写面另有门禁）。

### 7.5 非目标（create 模式）

- 不递归创建父链（`mkdir -p` 不做）；父目录必须已存在。
- 不覆盖已存在路径、不接管已存在空目录（必须先确保不存在；「已有目录」模式负责登记已存在目录）。
- 不设置自定义 mode/owner、不写模板文件、不创建 `.git`／`.pi`／`.pideck-trash`。
- 不新增「远端目录选择器」（仍是绝对路径输入 + 确认；与现有登记一致）。

## 8. 上限（caps）清单

| 项 | 值 | 执行点 |
| --- | --- | --- |
| 项目相对路径 | ≤4096 字符；无控制/反斜杠/空段/`.`/`..` | main validator（复用 RemoteProjectFileCommands.ts:11-14） |
| 单段 name | ≤255 UTF-8 字节；非 `.`/`..`、不含 `/`、控制字节；非保留名/后缀 | main validator |
| 单条远端命令 | ≤8192 字符 | 命令构造（RemoteProjectFileCommands.ts:125 同款 gate） |
| 固定脚本（squash 后） | entry/put/list ≤5120；**restore/prune ≤6100（Lead 批准的预算例外，见 §3.4）** | 新测试不变量；两条 admin 脚本实测 6,018/5,995 |
| 单条 SSH 命令 deadline | ≤30 s | SshClientRuntime.ts:33、:144 |
| 一次操作命令数 | stat 1；create 1；rename 1；delete 1；list 1；restore 1；prune 1；create-project 3（父探针+叶探针+mkdir，复核可复用探针） | 设计（§3.4、§7.3） |
| entry 令牌 | 30 分钟；最多 128（独立表） | 服务（镜像 RemoteProjectFileService.ts:9-10） |
| sender 写并发 | 1 个在途；其余 `REMOTE_FILE_BUSY` | 服务 |
| trash list | ≤256 条；manifest ≤8 KiB/条；列表输出 ≤64 KiB | 脚本 + main 重验 |
| trash prune | 每调用 ≤32 个 id；单条目 walk ≤20,000 项/32 层 | 脚本 |
| trash manifest 路径 | ≤4096 字符；严格 §4.1 规则 | 脚本 + main 重验 |
| create-project | path ≤4096；leaf ≤255 字节；确认 TTL 60 s；broker ≤128 | main（RemoteBrowseRoot.ts:56-66；PendingConfirmationBroker.ts:31、:39） |
| 文本面（既有，不变） | 正文 256 KiB；读块 96 KiB；写块 3072 B | RemoteProjectFileCommands.ts:6-8 |
| 超限行为 | **完整拒绝**，不截断（列表是唯一例外：截断必须带 `truncated:true`） | 所有层 |

## 9. 错误码（新增稳定码 + 注册点）

### 9.1 新增稳定码（main 侧唯一注册点：`RemoteProjectEntryService.CODES` 闭集）

| 稳定码 | 含义 | 发出层 | 建议 i18n key |
| --- | --- | --- | --- |
| `REMOTE_FILE_TARGET_EXISTS` | 目标已存在（创建/重命名/移动/还原） | main/脚本 | remoteFileEntry.targetExists |
| `REMOTE_FILE_NAME_INVALID` | 名字非法（含保留名/后缀） | main | remoteFileEntry.nameInvalid |
| `REMOTE_FILE_PARENT_NOT_FOUND` | 上级目录不存在 | 脚本 | remoteFileEntry.parentMissing |
| `REMOTE_FILE_PARENT_NOT_DIRECTORY` | 上级不是目录/是软链 | 脚本 | remoteFileEntry.parentNotDirectory |
| `REMOTE_FILE_ENTRY_UNSUPPORTED` | 叶是符号链接/FIFO/socket/device 等 | main/脚本 | remoteFileEntry.unsupportedEntry |
| `REMOTE_FILE_PROTECTED_PATH` | 受保护命名空间/根/回收站路径 | main | remoteFileEntry.protectedPath |
| `REMOTE_FILE_MOVE_INTO_SELF` | 目标位于源目录内部 | main | remoteFileEntry.moveIntoSelf |
| `REMOTE_FILE_RENAME_UNSUPPORTED` | 大小写重命名不可实现/EXDEV/link 不可用 | 脚本 | remoteFileEntry.renameUnsupported |
| `REMOTE_FILE_TRASH_UNAVAILABLE` | 回收站不可用（同名占用/非目录/跨设备/不可写） | 脚本 | remoteFileEntry.trashUnavailable |
| `REMOTE_FILE_TRASH_ENTRY_NOT_FOUND` | trashId 不存在 | 脚本 | remoteFileEntry.trashNotFound |
| `REMOTE_FILE_TRASH_ENTRY_INVALID` | manifest/身份不匹配或损坏 | 脚本 | remoteFileEntry.trashInvalid |
| `REMOTE_FILE_ENTRY_LIMIT` | 目录规模超过 walk 上限（prune 拒绝该条） | 脚本 | remoteFileEntry.entryLimit |
| `REMOTE_FILE_RESULT_UNCONFIRMED` | 命令已发出但结果无法确认 | main | remoteFileEntry.unconfirmed |
| `REMOTE_FILE_BUSY` | 同一 sender 已有写操作在途 | main | remoteFileEntry.busy |
| `REMOTE_PROJECT_TARGET_EXISTS` | create 模式下目标目录已存在 | main | sidebar.remoteEnroll.createExists |
| `REMOTE_PROJECT_PARENT_NOT_FOUND` | create 模式父目录不存在 | main | sidebar.remoteEnroll.parentMissing |
| `REMOTE_PROJECT_CREATE_FAILED` | mkdir 失败（权限/IO/未知） | main | sidebar.remoteEnroll.createFailed |
| `REMOTE_PROJECT_CREATE_UNCONFIRMED` | mkdir 回执丢失，结果未知 | main | sidebar.remoteEnroll.createUnconfirmed |

**复用既有码**（不新造）：`REMOTE_FILE_PATH_INVALID`、`REMOTE_FILE_CHANGED`、`REMOTE_FILE_NOT_FOUND`、`REMOTE_FILE_TOO_LARGE`、`REMOTE_FILE_PERMISSION_DENIED`、`REMOTE_FILE_PLATFORM_UNSUPPORTED`、`REMOTE_FILE_INPUT_INVALID`、`REMOTE_FILE_COMMAND_FAILED`、`REMOTE_FILE_VERSION_INVALID`（RemoteProjectFileService.ts:11-23）；`REMOTE_PROJECT_NOT_FOUND`／`REMOTE_PROJECT_TARGET_INVALID`／`REMOTE_PROJECT_ROOT_CHANGED`／`REMOTE_PROJECT_ROOT_UNRESOLVED`（remoteProjectIpc.ts:182、:207）；`REMOTE_BROWSE_ROOT_*`（RemoteBrowseRoot.ts:27-33）；`REMOTE_FEATURE_DISABLED`、`SSH_HOST_NOT_READY`、`SSH_HOST_DISCONNECTED`、`REMOTE_CONNECTION_SERVICE_UNAVAILABLE`、`REQUEST_CANCELLED`、`CONFIRMATION_EXPIRED`／`CONFIRMATION_CHANGED`（broker 既有码）。

### 9.2 注册位置（两侧规则）

- **main 侧（本计划的实现形态）**：脚本 `fail()` 只允许上表闭集；`RemoteProjectEntryService` 的 `CODES` Set 收录全部新增码 + 复用码；IPC `code()` 只放行 `^[A-Z][A-Z0-9_]{2,63}$` 的稳定码（沿用 remoteProjectFileIpc.ts:33-35）；renderer 的 `remoteFileEntryErrorMessage(code)` 负责文案（§10.5），未知码一律落到「操作未获确认（{code}）」而不是静默。
- **helper 侧：不适用**——本计划没有新增 helper 方法，`REMOTE_HELPER_ERROR_CODES`（RemoteHelperContract.ts:54-101）与 helper 冻结正文的 `stable` Set **零改动**。
- **若未来改走 helper op**（需重新签收本文件）：必须同时更新 helper 端 `stable` Set、main 端错误表、`REMOTE_HELPER_CAPABILITIES` 与各 artifact sha；G2b 的教训是 helper 端漏加一个码会被折叠成 `IO_ERROR`（remote-git-plan.md:318）。**本计划按「不做 helper op」验收，任何只改一端的实现都不合格。**

### 9.3 用户可见文案原则

- 每个码都有中英文案；默认兜底文案区分三类：「未执行」（前置失败）、「未获确认」（已发出、结果未知）、「已拒绝/冲突」（有明确原因）。
- 不把稳定码当正文直接抛给用户（可附在括号里便于排障）；不显示远端路径/命令/stderr（沿用写面脱敏纪律，remote-write-plan.md:41）。

## 10. UI 契约（冻结）

### 10.1 挂载点与门槛

| 表面 | 现状 | 本计划 |
| --- | --- | --- |
| 会话文件抽屉（远端项目） | DrawerSurface.tsx:98-99 渲染 RemoteProjectPanel | 加工具栏/行菜单/回收站区；不新增挂载点 |
| 无会话空态（远端项目） | ProjectEmptyState.tsx:63-64 渲染同一面板 | 同上（同一组件，不复制逻辑） |
| 本机项目的 FileTree/右键菜单 | App.tsx:4059-4160 的本机文件菜单 | **不改**；远端条目不会走本机 `api.files.delete` |
| 预览/静态模式 | previewApi stubs | 8 个新 stub 返回 `REMOTE_FEATURE_DISABLED` |

### 10.2 testid 全表（新 vs 复用）

| testid | 元素 | 说明 |
| --- | --- | --- |
| `remote-file-toolbar` | 工具栏容器 | 含新建文件/新建文件夹/回收站开关 |
| `remote-file-create` | 新建文件按钮 | 打开新建文件弹框 |
| `remote-file-mkdir` | 新建文件夹按钮 | 打开新建目录弹框 |
| `remote-file-row-menu` | 行内「更多」按钮 | 打开行菜单（重命名/删除） |
| `remote-file-row-rename` | 行菜单项 | — |
| `remote-file-row-delete` | 行菜单项 | 打开删除确认 |
| `remote-file-new-dialog`／`remote-file-new-name`／`remote-file-new-confirm`／`remote-file-new-cancel` | 新建文件/目录弹框 | 两种 kind 共用，标题/placeholder 由 kind 决定 |
| `remote-file-rename-dialog`／`remote-file-rename-input`／`remote-file-rename-confirm`／`remote-file-rename-cancel` | 重命名弹框 | 预填当前名字；非法/未变时禁用确认 |
| `remote-file-delete-confirm`／`remote-file-delete-cancel` | 删除确认 | 正文见 §10.5；文件名与类型在正文中出现 |
| `remote-file-outcome` | 操作结果/错误消息区（`aria-live="polite"`） | 单行固定高度，避免布局抖动（参照 Git 同步条 `remote-git-sync-message`，RemoteGitPanel.tsx:184） |
| `remote-trash-toggle` | 回收站折叠开关 | 展开即手动加载（无轮询） |
| `remote-trash` | 回收站区容器 | — |
| `remote-trash-row` | 回收站条目行 | 显示原路径、大小（文件）、相对时间、状态标签 |
| `remote-trash-restore` | 行内「还原」 | 仅 `intact` 可点 |
| `remote-trash-prune` | 「清空回收站」 | 打开确认 |
| `remote-trash-prune-confirm`／`remote-trash-prune-cancel` | 永久删除确认 | 文案见 §10.5 |
| `remote-trash-expired` | 过期标签 | 仅展示，不触发删除 |
| `remote-trash-outcome` | 回收站结果/错误区 | 与 `remote-file-outcome` 分离（读不覆盖写回执，参照 G4b 的 recoveryEpoch 教训，remote-git-plan.md:395） |

enroll 新建模式复用现有无障碍选择器（`#remote-enroll-host`／`#remote-enroll-path`，RemoteProjectEnrollDialog.tsx:93-109），新增 `#remote-enroll-mode-existing`／`#remote-enroll-mode-create` 两个 radio；确认弹框展示「父目录 / 将创建的目录」两行。

### 10.3 交互状态机（可单测的纯函数）

`src/renderer/src/components/session/remoteFileManagementState.ts`（纯 reducer，无 React）：

- `idle → creating|renaming|deleting|restoring|pruning → idle|failed|unknown`
- **单飞**：任一写操作在途时，其余写按钮禁用；读刷新不阻塞写（但用户显式刷新会作废旧请求代次，沿用面板 gate：RemoteProjectPanel.tsx:44-46、:58-92）。
- **成功**：只做「显式刷新当前目录 + 回收站列表（若展开）」，并输出成功消息；不自动打开/关闭其它弹框。
- **失败（有明确码）**：弹框保持打开或关闭由码决定（`TARGET_EXISTS`/`CHANGED` 保留输入便于改名重试；`PROTECTED_PATH` 关闭并提示）；旧目录事实保留（不显示半真状态）。
- **未知（`REMOTE_FILE_RESULT_UNCONFIRMED`）**：消息区保留「结果未确认，请刷新核对；不会自动重试」直到用户**显式刷新**成功；写按钮保持可用（用户可刷新后重试，但不得自动重放）。
- **刷新失败**：保留已有条目与未知提示（不得清空成「空目录」——沿用 RemoteProjectPanel.tsx:78-89 的「失败不冒充空目录」）。
- **草稿**：删除/重命名成功后，干净草稿可回收；脏草稿保留并标记 stale（§5.7）；不自动丢弃。

### 10.4 空态/错误态/可访问性

| 场景 | 呈现 |
| --- | --- |
| 目录为空 | 现有空提示（`rendererCopy.zh-CN.ts:3440` 的 `project.remote.empty`）；工具栏仍可见（可在空目录新建） |
| 回收站为空 | `remoteTrash.empty`：「回收站为空」；不显示 prune |
| 回收站不可用 | `remoteTrash.unavailable` + 稳定码；不显示 restore/prune；不降级 unlink |
| 连接不可用 | 复用 `project.remote.notConnectedHint` 同等语义（RemoteProjectPanel.tsx:14-17、:82） |
| 截断 | 显示「仅显示最近 256 条；清理后重试」（`truncated` 如实） |
| 写操作消息 | `role="status"`/`aria-live="polite"`；不阻塞焦点；错误用 `role="alert"`（与 RemoteFileEditor.tsx:71-75 一致） |
| 按钮禁用 | 仅用能力/状态驱动（非「点一下再报码」）：启用门禁关闭、无连接、忙碌、只读不适用时禁用并给 tooltip 说明 |

### 10.5 文案（zh-CN / en-US，键名即实现清单）

新增 key（渲染层 `rendererCopy.zh-CN.ts` + `rendererCopy.en-US.ts` 同步；AGENTS.md:156）：

| key | zh-CN | en-US |
| --- | --- | --- |
| remoteFileEntry.newFile | 新建文件 | New file |
| remoteFileEntry.newFolder | 新建文件夹 | New folder |
| remoteFileEntry.nameLabel | 名称 | Name |
| remoteFileEntry.parentLabel | 位置 | Location |
| remoteFileEntry.createAction | 创建 | Create |
| remoteFileEntry.renameTitle | 重命名 | Rename |
| remoteFileEntry.renameAction | 重命名 | Rename |
| remoteFileEntry.deleteTitleFile | 删除文件 | Delete file |
| remoteFileEntry.deleteTitleFolder | 删除文件夹 | Delete folder |
| remoteFileEntry.deleteBody | 将移动到项目内回收站（.pideck-trash），不会立即永久删除；可从回收站还原。 | Move to the project's trash (.pideck-trash). This is not a permanent delete; you can restore it from the trash. |
| remoteFileEntry.deleteBodyFolder | 整个文件夹会被移动到项目内回收站（.pideck-trash）；可从回收站还原。 | The whole folder tree is moved to the project's trash (.pideck-trash); you can restore it from the trash. |
| remoteFileEntry.deleteAction | 删除 | Delete |
| remoteFileEntry.busy | 正在执行其他文件操作… | Another file operation is in progress… |
| remoteFileEntry.unknown | 结果未确认：命令已发出但未收到回执，可能已执行。请刷新核对；不会自动重试。 | Result unconfirmed: the command was sent but no receipt arrived. Refresh to check; it will not retry automatically. |
| remoteFileEntry.targetExists | 目标已存在；本功能不会覆盖已有条目。 | The target already exists; this action never overwrites. |
| remoteFileEntry.nameInvalid | 名称不合法（不能包含 /、控制字符，不能是 . 或 ..，且不能使用保留名）。 | Invalid name (no "/", no control characters, not "." or "..", and not a reserved name). |
| remoteFileEntry.parentMissing | 上级目录不存在。 | The parent folder does not exist. |
| remoteFileEntry.parentNotDirectory | 上级路径不是目录，或包含符号链接。 | The parent path is not a folder, or contains a symbolic link. |
| remoteFileEntry.unsupportedEntry | 仅支持普通文件和目录；符号链接、设备等类型请用远端终端处理。 | Only regular files and folders are supported; use a remote terminal for symlinks, devices, etc. |
| remoteFileEntry.protectedPath | 该路径受保护（.git、.pi、回收站或项目根），不能在这里操作。 | This path is protected (.git, .pi, the trash, or the project root). |
| remoteFileEntry.moveIntoSelf | 不能把目录移动到它自身或它的子目录中。 | A folder cannot be moved into itself or its own subfolder. |
| remoteFileEntry.renameUnsupported | 无法在该远端文件系统上完成此重命名（可能跨设备或文件系统限制）。 | Renaming is not possible on this remote filesystem (cross-device or unsupported). |
| remoteFileEntry.trashUnavailable | 回收站不可用：项目根不可写，或 .pideck-trash 被占用/跨文件系统。请用远端终端处理。 | Trash is unavailable: the project root is not writable, or .pideck-trash is occupied/cross-device. Use a remote terminal. |
| remoteFileEntry.trashNotFound | 回收站条目不存在（可能已被清理）。 | The trash entry no longer exists. |
| remoteFileEntry.trashInvalid | 回收站条目已损坏或与记录不一致，未执行还原。 | The trash entry is corrupted or does not match its record; nothing was restored. |
| remoteFileEntry.entryLimit | 目录规模超过上限，未执行清理；请用远端终端处理。 | The folder exceeds the limit; nothing was removed. Use a remote terminal. |
| remoteFileEntry.expired | 已过期（仅提示，不会自动删除） | Expired (informational only; not auto-deleted) |
| remoteFileEntry.changed | 条目已被其他程序修改，本次操作已拒绝。请刷新后重试。 | The entry changed on the remote; the operation was refused. Refresh and retry. |
| remoteFileEntry.permission | 没有足够权限，操作未完成。 | Not enough permission; the operation did not complete. |
| remoteFileEntry.platform | 当前远端文件面仅支持 Linux 远端（需要 /proc 与 O_NOFOLLOW）。 | Remote file management currently supports Linux remotes only (/proc and O_NOFOLLOW are required). |
| remoteFileEntry.failure | 文件操作未获确认（{code}）。 | File operation unconfirmed ({code}). |
| remoteTrash.title | 回收站 | Trash |
| remoteTrash.empty | 回收站为空 | Trash is empty |
| remoteTrash.restore | 还原 | Restore |
| remoteTrash.restored | 已还原 {name} | Restored {name} |
| remoteTrash.prune | 清空回收站 | Empty trash |
| remoteTrash.pruneConfirmTitle | 永久删除回收站条目 | Permanently delete trash entries |
| remoteTrash.pruneConfirmBody | 永久删除回收站中的条目，无法恢复。 | Permanently delete the selected trash entries. This cannot be undone. |
| remoteTrash.pruneAction | 永久删除 | Permanently delete |
| remoteTrash.removed | 已永久删除 {count} 个条目 | Permanently deleted {count} entries |
| remoteTrash.kept | {count} 个条目未清理（{code}） | {count} entries were not removed ({code}) |
| remoteTrash.truncated | 仅显示最近 {count} 条；清理后重试 | Showing the latest {count} entries; empty some and retry |
| remoteTrash.gitNote | 回收站位于项目根（.pideck-trash），会作为一条未跟踪目录出现在 Git 状态中；PiDeck 不会修改 .gitignore。 | The trash lives at the project root (.pideck-trash) and appears as one untracked folder in Git status; PiDeck does not modify .gitignore. |
| sidebar.remoteEnroll.modeLabel | 目录模式 | Directory mode |
| sidebar.remoteEnroll.modeExisting | 使用已有目录 | Use an existing folder |
| sidebar.remoteEnroll.modeCreate | 新建空目录 | Create an empty folder |
| sidebar.remoteEnroll.createHint | 输入的路径当前必须不存在；PiDeck 将创建一个空目录并添加为项目（不会覆盖、不会递归创建父目录）。 | The path must not exist yet; PiDeck will create one empty folder and add it as a project (no overwrite, no recursive parent creation). |
| sidebar.remoteEnroll.createConfirmTitle | 新建空远端项目目录 | Create an empty remote project folder |
| sidebar.remoteEnroll.createConfirmBody | 将在主机「{host}」上创建目录：{path}。创建后会复核 canonical 路径并添加为项目。 | PiDeck will create this folder on "{host}": {path}. Afterwards it re-checks the canonical path and adds it as a project. |
| sidebar.remoteEnroll.createExists | 该路径已存在。请改用「使用已有目录」，或换一个名字。 | The path already exists. Use "Use an existing folder" or choose another name. |
| sidebar.remoteEnroll.parentMissing | 上级目录不存在；不会递归创建。 | The parent folder does not exist; parents are never created recursively. |
| sidebar.remoteEnroll.createFailed | 创建目录失败（{code}）。 | Failed to create the folder ({code}). |
| sidebar.remoteEnroll.createUnconfirmed | 创建结果未确认：可能已创建。请重新解析该路径；若已存在，请改用「使用已有目录」。 | The creation result is unconfirmed; the folder may exist. Resolve the path again, or use "Use an existing folder". |

所有既有 `remoteFile.*` 文案保持；新增错误文案在 `RemoteFileEditor` 的错误映射里不改变现有文件的报错行为（远端编辑器只处理文本 open/save 的码，见 RemoteFileEditor.tsx:14-37）。

### 10.6 渲染层模块落点（≤400 行/文件，AGENTS.md:127）

- `RemoteProjectPanel.tsx`：加工具栏/行菜单钩子，保持 ≤~340 行。
- 新增 `RemoteProjectEntryDialogs.tsx`（新建/重命名/删除确认，纯受控组件）。
- 新增 `RemoteTrashPanel.tsx`（折叠区，展开即加载）。
- 新增 `hooks/useRemoteProjectEntries.ts`（命令与状态机接线；IPC 只经 desktopApi）。
- 新增 `components/session/remoteFileManagementState.ts`（纯 reducer + 错误文案映射，可离开 React 单测）。
- Jotai：复用现有 `remote-file-atoms.ts` 的草稿表（无需新全局状态）；回收站状态归 hook 本地 state（不跨组件共享）。

## 11. 验证计划

### 11.1 单元/契约测试（先红后绿；生产命令在一次性 POSIX 临时目录真实执行）

新增 `tests/remoteProjectEntryCommands.test.mjs`（沿用 tests/remoteProjectFileService.test.mjs:21-69 的 fixture：本地 mkdtemp + `/bin/sh -c` 执行**生产命令**）：

1. 命令形态：每条 `command.length <= 8192`；只含单引号字面量（引号路径/空格/Unicode/中文）；marker 唯一；nonce 形态；新脚本 squash 长度 ≤5,120。
2. 边界：父/叶软链、根被替换为软链、`..`/绝对路径/反斜杠/控制字节 ⇒ `REMOTE_FILE_PATH_INVALID` 且零写。
3. create：新建 0 字节文件（mode 受 umask 影响时断言不变式）、重复创建 ⇒ TARGET_EXISTS、父不存在/父是文件、名为 `.pideck-trash`/`x.pideck-tmp`/`..`/`a/b` ⇒ 稳定码；目录同样；不创建父链。
4. rename：文件跨目录移动（字节/mode/inode 不变、源消失）；目录移动整树；目标存在 ⇒ TARGET_EXISTS 且双方不变；移动到自身子目录 ⇒ MOVE_INTO_SELF；受保护路径拒绝；case-only：`foo`→`Foo`（Linux 正常 rename）成功；「目标为同 inode 硬链接」⇒ TARGET_EXISTS；用 `link` 制造同 inode + shim 让 rename no-op 的分支 ⇒ RENAME_UNSUPPORTED（不谎报）。
5. delete：文件移入回收站（原路径消失、payload 字节/mode/inode 不变、manifest 字段正确）；目录整树移入；外部在 stat 后改文件 ⇒ CHANGED 且原文件未动、无回收站条目；受保护路径/符号链接/特殊文件拒绝；`.pideck-trash` 被同名文件占用 ⇒ TRASH_UNAVAILABLE。
6. trash list：空/1 条/超过 256 条 `truncated`；invalid（manifest 缺字段/损坏/payload 被替换/未知文件）如实标状态；外来 id 目录被忽略；不创建回收站目录。
7. restore：文件/目录逐字节（`sha256sum` 或本地读回）与 mode 还原；目标已存在 ⇒ TARGET_EXISTS 且两边不变；manifest 身份失配 ⇒ TRASH_ENTRY_INVALID；父目录缺失 ⇒ PARENT_NOT_FOUND；条目清理失败不谎报失败（返回成功 + 残留条目）。
8. prune：只删 intact/payload-missing/payload-changed；invalid 保留；>32 id 拒绝；目录 walk 超限 ⇒ ENTRY_LIMIT 且不删；逐条 kept/removed 正确；删除后条目目录消失。
9. 未知结果：用与 tests/remoteProjectFileService.test.mjs:43-46 相同的 `NODE_OPTIONS --require` shim，在 rename/link 成功后制造读回失配/丢失 marker ⇒ `REMOTE_FILE_RESULT_UNCONFIRMED`；断言不自动重试（命令数恰好 1）、原始数据按实际状态可解释。
10. 失败即停：权限拒绝（chmod 0500 父目录，skip root）⇒ PERMISSION_DENIED；断言无回收站条目/无 manifest 半成品，或半成品如实残留且不被自动清理。

新增 `tests/remoteProjectEntryService.test.mjs`：

- entry 令牌：sender/project/relative/locator 值快照/hostRevision/TTL/一次性；跨 kind 使用；令牌被 evict 后 ⇒ VERSION_INVALID；`releaseSender` 撤销；locator 原地 mutate 不影响已签发令牌（沿用 tests/remoteProjectFileService.test.mjs:178-186 思路）。
- 非法输入在开 SSH/构造命令前拒绝（`commands.length === 0`）；`REMOTE_FILE_BUSY` 单飞；错误码折叠（脚本未知码 ⇒ COMMAND_FAILED）。
- 写操作只读刷新语义：service 不缓存目录事实。

新增 `tests/remoteProjectEntryIpc.test.mjs`：

- 8 条通道的入参校验、disabled 返回 `REMOTE_FEATURE_DISABLED`、sender destroyed 释放、去抖/跨项目/额外字段不烧令牌；
- 5 处接线断言（shared/ipc、preload、main/index、previewApi、handler 文件）——沿用 tests/remoteProjectFileIpc.test.mjs:60-75 的写法；
- 读通道（list/search/read/text-open）对 `.pideck-trash` 的过滤/拒绝。

新增/更新 `tests/remoteProjectEntryState.test.mjs`（纯 reducer）：忙/未知/失败/成功刷新/脏草稿 stale/回收站截断与空态；不调用真实 IPC。

**回归门禁**：现有 tests/remoteProjectFileService.test.mjs（262 行）与 tests/remoteProjectFileIpc.test.mjs（75 行）必须不改断言全绿；tests/remoteProjectIpc.test.mjs、tests/remoteProjectReadChain.test.mjs、tests/remoteProjectReadIsolation.test.mjs、tests/remoteProjectReadConcurrency.test.mjs、tests/remoteProjectRootReverify.test.mjs 保持绿；`npm run typecheck`；触达文件 `biome format`（AGENTS.md:176-178；不跑全量 `npm test`，除非 Lead 要求）。

### 11.2 真机 e2e 计划（run-owned fixtures、无外部网络；由 Lead 串行执行）

**新增**：`e2e/remoteFileManagement.ts`（fixture/断言 helper）+ 在 `e2e/remoteSessionAcceptance.spec.ts` 增加一条用例（沿用现有门禁：三个 `PIDECK_E2E_REMOTE_*` 环境变量缺一整体 skip，remoteSessionAcceptance.spec.ts:59-61；userData 隔离、HOME 不隔离以读真实 ssh config，remote-fixtures.ts:106-152）。用例名含「远端文件管理」，便于 `--grep '远端文件管理'` 单跑。

**夹具（全部 run-owned，在验收主机上）**：

- `home = runRemoteCommand('$HOME')`；`e2eRoot = home + "/.pideck-e2e-" + runId`；项目根 `e2eRoot + "/files-" + runId`；邻居项目 `e2eRoot + "/neighbor-" + runId`（清理只删这两个 + 会话证据目录，沿用 remoteSessionAcceptance.spec.ts:134-165、:268-270 的 CLEANUP_OK 归属自检）。
- 初始文件：`keep.txt`（内容 A）、`crlf.txt`（BOM+CRLF）、`nested/dir/a.txt`、`nested/dir/b.txt`、`to-rename.txt`、`trash-me.txt`（UTF-8 中文/空格/引号名字各一）。用 `printf base64 -d` 写入（remote-file-editing.ts:11-20 同款），避免引号/换行转义歧义。
- **无外部网络**：不 clone/fetch/push，不调用模型；只连已 pin 的验收主机。

**步骤（真实 UI 点击，不直调 IPC）**：

1. 加主机/pin/连接/登记（复用 remoteSessionAcceptance.spec.ts:168-219 的既有 helper），打开文件抽屉。
2. 新建文件 `new-`+runId+`.txt`：原生 `test -f`、`stat -c '%s' == 0`；UI 行出现；点开编辑器可保存内容（证明与现有保存面衔接）。
3. 新建目录 `tmpdir`：原生 `test -d`；进入后新建文件；再次创建同名 ⇒ `remote-file-outcome` 含「目标已存在」，原生状态不变。
4. 重命名 `to-rename.txt` → `renamed.txt`：原生旧名不存在、新名 `sha256sum` 与初始一致、`stat -c '%a %u %g'` 不变（inode 保留的证据：`stat -c '%i'` 前后相同）。
5. 移动到子目录 `nested/renamed.txt`：原生路径正确；再移回。
6. 冲突：原生先在目标路径写一个文件 → UI 重命名到该目标 ⇒ TARGET_EXISTS，原生两侧字节不变。
7. 外部修改竞态：UI 打开重命名/删除确认（此动作触发 stat 令牌）→ 用 SSH 原生改写该文件 → 确认 ⇒ 「条目已被修改，已拒绝」；原生内容仍是外部写入的那份，未产生回收站条目。
8. 删除 `trash-me.txt` → 原生 `test ! -e`、`test -f <root>/.pideck-trash/<id>/payload`、manifest 可读；UI 回收站展开显示 1 条（原路径/大小/时间）。
9. 删除目录 `nested`（含文件）→ 原生整树消失、回收站 payload 为目录；还原后 `find nested -type f` 与初始一致、逐文件 `sha256sum` 一致、回收站条目消失。
10. 还原 `trash-me.txt` → 字节一致；回收站空态文案出现。
11. 再删一个文件 → 明确「清空回收站」流程：取消 ⇒ 条目仍在；确认 ⇒ 原生条目目录消失、`.pideck-trash` 为空目录（或已不存在，断言无子项）。
12. 受保护路径：尝试删除/重命名 `.pi` 目录（若夹具没有则先建）⇒ 「该路径受保护」，原生未动；也可用 `.pideck-trash` 自身路径做负例。
13. 断开主机（真实断开）后点删除 ⇒ 明确连接错误、零写、无回收站条目；显式重连后刷新可继续。
14. 新建空远端项目：侧栏「+」→ 远端 → 切「新建空目录」→ 输入 `e2eRoot + "/created-" + runId`（父存在、叶不存在）→ 确认框出现父/叶两行 → 确认 ⇒ 原生 `test -d` 且 `test -z "$(ls -A <path>)"`；项目出现在侧栏并可打开文件面板；再创建同名 ⇒ 「路径已存在」；输入父不存在的路径 ⇒ 「上级目录不存在」，原生无残留。
15. 清理：只删本次 runId 命名的 e2e 根与由项目路径编码出的会话目录，输出 `CLEANUP_OK`；断言不存在残留 `.pideck-trash` 于夹具外、无 helper/SSH 后代、无锁/scratch。

**断言口径**：独立原生 SSH oracle（`cat`/`sha256sum`/`stat`/`find`/`test`）与 UI 显示一致；不依赖模型回复；只操作本次夹具；失败时保留 trace 与主进程日志（preserveAppLogs 同款，remoteSessionAcceptance.spec.ts:244-258）。

**不纳入本批真机验收**（必须在文档/报告里如实列出）：大小写不敏感远端文件系统、跨挂载点/EXDEV、NFS/ACL/xattr、Windows/macOS 客户端、非 Linux 远端、打包安装版、双窗口/双实例并发、断网黑洞与小时级长稳。

### 11.3 构建/门禁（实施时）

`npm run typecheck`；触达文件 Biome；`npx playwright test ... --list`；仅构建触达的 main/preload 与 production renderer（沿用各批次的「只构建触达目标」纪律）；**不跑全量 `npm test` 与真机 e2e**（由 Lead 串行决定）；本设计任务不跑任何测试。

## 12. 实施落点与顺序（供后续派工）

### 12.1 文件级落点

| 车道 | 文件 | 内容 |
| --- | --- | --- |
| A：远端命令+服务 | 新增 `src/main/remote/RemoteProjectEntryCommands.ts`（≤300 行）；新增 `src/main/remote/RemoteProjectEntryService.ts`（≤350 行）；新增/提取 `src/main/remote/RemoteFileMutationTokens.ts`（纯令牌表，可单测）；改 `RemoteProjectFileCommands.ts`（仅导出 BOUNDARY_SCRIPT/validator，不改行为）；`tests/remoteProjectEntryCommands.test.mjs`／`remoteProjectEntryService.test.mjs` | 命令、脚本、服务、令牌、错误码 |
| B：契约+IPC+enroll | `src/shared/ipc.ts`（8 常量）、`src/shared/types/remoteFiles.ts`（§3.3 类型）、新增 `src/main/ipc/remoteProjectEntryIpc.ts`、`src/preload/index.ts`、`src/renderer/src/previewApi.ts`、`src/main/index.ts`（装配）、`src/main/ipc/remoteProjectIpc.ts`（`mode` 扩展 + create 探针/创建）、`src/shared/types/remoteHost.ts`（enroll 请求加 mode）、`tests/remoteProjectEntryIpc.test.mjs`／`remoteProjectEnrollCreate.test.mjs` | 通道、类型、确认流程 |
| C：渲染层 | `RemoteProjectPanel.tsx`、新增 `RemoteProjectEntryDialogs.tsx`／`RemoteTrashPanel.tsx`／`hooks/useRemoteProjectEntries.ts`／`components/session/remoteFileManagementState.ts`、`RemoteProjectEnrollDialog.tsx`、`i18n/rendererCopy.zh-CN.ts`／`en-US.ts`、`tests/remoteProjectEntryState.test.mjs` | UI/testid/文案/状态机 |
| D：真机验收 | `e2e/remoteFileManagement.ts`、`e2e/remoteSessionAcceptance.spec.ts` 追加用例；独立 oracle 断言 | 由 Lead 串行执行 |
| E：复核 | 独立复核车道（读契约/断言/失败语义；非实现者） | 参照 Git 计划的独立复核缺口教训（remote-git-plan.md:301 偏离项①） |

写作用域互不重叠：A 不碰 shared/preload；B 不碰 renderer；C 不碰 main。契约文件（shared/ipc.ts、preload、previewApi、main/index.ts）只由 B 车道写。

### 12.2 顺序与门禁

1. 先写红例：命令/服务/IPC/状态机四层，确认现状「没有通道/不会创建」。
2. A→B→C 顺序实施；每步跑对应定向测试 + typecheck；C 完成后跑触达 Biome。
3. D 由 Lead 在执行前确认环境变量/主机/时间窗；真机失败按真实原因归因（环境超时不得冒充产品失败，参照 G6c 的传输预算教训，remote-git-plan.md:227-228）。
4. E 独立复核本文件 §4.4／§5／§6 与实现逐条对应，特别是「失败即停」「无自动重试」「未确认不谎报」「helper 零改动」。
5. 全部完成后：更新交接文档新增一节、总计划 §6.3 补一句、能力矩阵对应的 Phase 5 行改状态；本文件状态行从 `design draft — not implemented` 改为已交付（含证据路径）。**不得**在只完成部分能力时把状态行改成已交付。

## 13. 风险与未验证边界（如实记录，不得删）

1. **不是内核 CAS**：与现有远端写面同一限制（remote-write-plan.md:49、:92）。检查→rename 之间同一远端账号的其它进程可以替换目录/文件；目录目标存在性检查的窗口（§4.4）。
2. **回执丢失后的未知状态**：rename/delete/restore/prune 命令已发出但 SSH 回执丢失 ⇒ 可能已执行；统一 `REMOTE_FILE_RESULT_UNCONFIRMED`，不自动重试；用户必须刷新核对。
3. **回收站是项目内目录**：对用户/Git 可见（一条未跟踪项）；不自动写 `.gitignore`/`.git/info/exclude`；用户的项目备份/同步工具会把回收站一并带走（这是可恢复性的代价）。
4. **容量不经管**：没有自动 TTL 删除/容量上限；列表 256 条截断、prune 32 条/次只是单次操作上界；长时间不清理会占磁盘。
5. **跨设备/特殊文件系统未验证**：EXDEV、NFS/CIFS、只读挂载、大小写不敏感 FS 的 case-only rename、link 不可用 FS；这些分支按 fail-closed 设计，但只在 Linux 本机 ext4/overlay 类环境有证据。
6. **目录内部并发写入**：rename 整树不逐文件校验；操作期间里层文件可能被 Agent/其它进程改动，移动的是 rename 时刻的树。
7. **特殊条目**：符号链接/FIFO/socket/device 一律拒绝（不是跟随、也不是删除）；用户可以要求放开，但那是需要单独签收的范围扩大。
8. **helper 零改动是硬约束**：任何把新 op 塞进 helper/runner 或改动 helper 部署包/能力/hash 的实现都违反本契约，需要重新签收。
9. **`.pideck-trash` 被同名文件占用/项目根不可写/跨设备** ⇒ 删除直接不可用（`REMOTE_FILE_TRASH_UNAVAILABLE`），不提供降级 unlink。
10. **大小写/硬链接边角**：同 inode 目标 + POSIX no-op 的处理只到「报告 RENAME_UNSUPPORTED、不谎报」；未在真实大小写不敏感远端上验证。
11. **远端 pi/其它 writer 无互斥**：本计划不声称锁住 Agent、终端、其它机器上的写者；只保证自身协议内的一致性。
12. **跨平台/打包/长稳/双实例**：未验收；与现有远端能力的未验证清单同口径（remote-write-plan.md:80、:92；remote-development-handoff.md:381-389）。
13. **恢复数据保真**：rename 保留 inode 与属性，但**不**复制 ACL/xattr（rename 不需要复制，故通常保留；若跨文件系统被拒绝则不发生）。不得宣称 ACL/xattr 已验收。
14. **UI 与真机证据的边界**：本计划给出的 e2e 步骤是「要跑什么」；在 Lead 实际执行并保留证据前，不得把任何一条写成已通过。

## 14. 需要用户签字决定的点（逐条给建议）

> 以下每条都需要用户明确答复；未答复项按「建议」执行之前不得开工。实现时如发现与签收结论冲突，停下并回到本文件。

1. **机制**：新增文件面继续用「main 构造的有界 Node 命令 + pinned SSH」，**不新增 helper op、不改 helper 版本/hash/能力**（§2.3）。
   *建议*：按本文件采用；理由是既有写面决策与审计/部署成本。
2. **删除恢复**：采用方案 A（项目内 `.pideck-trash`，rename 即快照，可列出/还原/显式清理）作为普通删除的唯一恢复机制；方案 B（Git recovery refs）不用于文件管理删除；方案 C 只用于「清空回收站」（§6）。
   *建议*：按本文件采用 A + C（仅清空回收站）。
3. **回收站位置与命名**：`<项目根>/.pideck-trash/`（0700），不放到远端 home、不放项目同级目录；**不自动**写 `.gitignore`/`.git/info/exclude`。
   *建议*：采用；若用户更在意仓库干净，可选「另立远端 home 回收站」但需新增授权根与跨设备失败处理（成本更高，不推荐首发）。
4. **TTL 与自动清理**：只给 30 天**展示标签**，不自动删除、无后台任务、无远端定时器；清理由用户显式触发（单次 ≤32 条，「清空回收站」分批）。
   *建议*：采用；自动 TTL 删除等于替用户毁掉最后一次恢复机会。
5. **保留命名空间**：`.pideck-trash`（含后代）、根级 `.git`／`.pi`（含后代）、项目根不可重命名/删除；只读列表/搜索隐藏回收站，读/编辑/写作拒绝。
   *建议*：采用；`.git` 被误删是不可逆事故，UI 写面不做「删仓库元数据」。
6. **特殊文件**：符号链接/FIFO/socket/device 一律不可创建/删除/重命名（只支持普通文件与目录）。
   *建议*：采用 fail-closed；需要时走远端终端。
7. **创建空项目**：扩展现有 `remote:project-enroll`（`mode: "existing" | "create"`）+ 独立 create 确认 broker + pinned 探针/创建命令；只创建单层空目录（不 `-p`、不覆盖、mode 0777 & umask）；创建后复核 canonical 并登记（§7）。
   *建议*：采用；不新增第二条 IPC 通道，避免同一登记流程两套确认。
8. **新建文件语义**：只创建 0 字节普通文件（mode 0666 & umask），内容由现有编辑器显式保存写入；不提供 create-with-content。
   *建议*：采用；与现有 256 KiB 文本面/草稿模型一致。
9. **令牌策略**：只有 rename/delete 需要 main-owned 一次性 `entry` 令牌；create/restore/prune 不签发令牌（理由 §5.1）；同一 sender 的写操作单飞（`REMOTE_FILE_BUSY`）。
   *建议*：采用；避免为不可覆盖的 create-only 操作制造无意义状态。
10. **恢复/清理的 UI 归属**：回收站三件套只在**文件面板**；Git 面板的恢复区（G4b）保持原样，两个恢复入口不合并、不互相引用。
    *建议*：采用；与「一个 UI 能力一个挂载点」和既有 G4b 语义一致。
11. **文件管理写面 UI 挂载范围**：只在远端项目面板（会话文件抽屉 + 无会话空态）出现；本机 FileTree/右键菜单不改；不提供批量操作。
    *建议*：采用；批量删除/移动属多对象事务，需单独设计确认与恢复语义。

## 15. 实施后必须同步的文档/状态（本文件不是最终收口）

- `docs/remote-development-handoff.md` 新增「远端文件管理（new/rename/delete/trash/create-project）」一节：交付清单、证据路径、未验证边界、偏离。
- `docs/remote-development-plan.md` §6.3 补一句本计划与实现状态；§12 Phase 5 的文件面勾选；§13 能力矩阵对应行状态（文件树/读写/搜索的远端首发）。
- `docs/remote-write-plan.md` §1 的「删除归档不做」保持不变；在 §5 边界里注明「项目文件删除/重命名/新建已由 remote-file-management-plan.md 另行契约化」（避免两份计划口径冲突）。
- `docs/remote-git-plan.md` **不改**（文件面不属于 Git；G4a/G4b 仍是 Git 面板的恢复语义）。
- 本文件状态行与证据段落：从 `design draft — not implemented` 更新为已交付/部分交付，并逐项列通过、失败、未验证。

## 16. 代码与文档索引（本文件断言的出处）

| 断言 | 出处 |
| --- | --- |
| 文本 open/save 通道与三处接线 | src/shared/ipc.ts:38-39；src/preload/index.ts:271-272；src/main/ipc/remoteProjectFileIpc.ts:9-19,36-55；src/main/index.ts:2467-2474 |
| 文本保存的令牌/上限/提交/未知结果 | src/main/remote/RemoteProjectFileService.ts:8-23,29-49,87-137；tests/remoteProjectFileService.test.mjs:21-69,125-140,248-255 |
| 固定 Node 命令、边界、命令预算 | src/main/remote/RemoteProjectFileCommands.ts:6-8,11-14,18-40,42-89,90-106,111-127；src/main/remote/RemoteHelperContract.ts:25 |
| 主机锁/会话绑定/runCommand 复核 | src/main/remote/RemoteHostConnectionService.ts:395-408,410-516,748-772；src/main/remote/RemoteHostOperationLock.ts:1-17 |
| SSH deadline/maxBuffer | src/main/remote/SshClientRuntime.ts:33,128,144 |
| 项目 locator/登记/读入口校验 | src/main/projects/ProjectStore.ts:305-346；src/main/ipc/remoteProjectIpc.ts:101-112,120-155,203-212 |
| 远端项目只读 UI + 文本编辑宿主 | src/renderer/src/components/workspace/DrawerSurface.tsx:98-99；src/renderer/src/components/session/ProjectEmptyState.tsx:56-65；src/renderer/src/components/session/RemoteProjectPanel.tsx:19-35,36-47,58-102,190-201,239；src/renderer/src/components/workspace/RemoteFileEditor.tsx:10-37,53-103；src/renderer/src/hooks/useRemoteFileDraft.ts:14-62 |
| 本机回收站纪律（远端不可复用） | src/main/fs/trash.ts:3-14,39-56；src/main/fs/FileSystemService.ts:181-182 |
| 写面纪律/零新增 helper op/不承诺 unlink 可恢复 | docs/remote-write-plan.md:3-4,20-31,33-41,75-81,83-92 |
| Git 恢复快照与 G4 六项门禁 | docs/remote-git-plan.md:47,318,332-351,377-389,436 |
| Phase 5 文件面/Phase 3 边界/能力矩阵 | docs/remote-development-plan.md:422-457,762,782-789,803-829 |
| 既有远端能力与未验收边界 | docs/remote-development-handoff.md:27-43,381-389,565-586 |
| e2e 夹具/门禁/清理先例 | e2e/remote-fixtures.ts:22-30,97-100,106-152；e2e/remoteSessionAcceptance.spec.ts:59-61,134-165,200-219,244-270；e2e/remote-file-editing.ts:11-20,31-87 |
| i18n/测试/文件体量/IPC 规则 | AGENTS.md:29,124,127,156,176-178,204-206,369 |
| 冻结契约写法参照 | docs/remote-git-plan.md:277-291（G3a §5.10）、:332-351（G4a §5.13）、:377-389（G4b §5.15）、:401-419（G5a §5.16） |

## 17. 实施状态（2026-10-18，file-mgmt 赛道交付）

- **状态：dev-mode implemented（开发态实现完成；真机 e2e 已编写，未由本赛道执行）。** 不是 Remote v1 发布声明：真机 Playwright、全量回归、打包/跨平台验收由 Lead 执行。
- **能力**：远端项目面板（无会话空态 + 会话文件抽屉）里的新建 0 字节文件 / 新建单层目录 / 项目内改名与跨目录移动 / 删除到项目内 `.pideck-trash`（manifest + payload，可列出/还原/显式清空）；侧栏「+ → 远端（SSH）→ 新建空目录」（mkdir + 复核 canonical + 登记，不 clone/不联网/不 git init）。
- **落点**：`src/main/remote/RemoteProjectEntryCommands.ts`（脚本/校验/预算）、`RemoteProjectEntryService.ts`（令牌/单飞/回执语义/码闭集）、`RemoteFileMutationTokens.ts`、`RemoteProjectCreateCommands.ts`；`src/main/ipc/remoteProjectEntryIpc.ts`、`remoteProjectCreateIpc.ts`；`src/main/ipc/remoteProjectIpc.ts`（mode 分支 + create 通道 + 回收站过滤/读拒绝）、`remoteProjectFileIpc.ts`（文本面拒绝 .pideck-trash）；shared/preload/previewApi 同步；renderer：`RemoteProjectPanel` / `RemoteProjectEntryDialogs` / `RemoteTrashPanel` / `useRemoteProjectEntries` / `remoteFileManagementState` / 草稿 stale 回收 / 登记弹框 create 模式；e2e：`e2e/remote-file-management.ts` + `e2e/remoteSessionAcceptance.spec.ts` 新增用例（仅作者态）。
- **验证（本赛道已跑）**：新增 35 项——POSIX 生产命令真实执行（WSL 临时目录）11/11（含脚本预算/命令形态/create/stat/rename/delete/list/restore/prune/权限/未知结果）；服务层 9/9（令牌绑定/单飞/CHANGED 零副作用/未知结果不重试/字段重验/**每操作命令数固定**）；Windows 非 POSIX 15/15（IPC 边界 + 双令牌销毁 + 状态机/草稿 + create-project 流程/命令形态）。既有回归：文本保存与项目 IPC（WSL 7 套件 65/65；Windows 8 套件 50 通过/1 skip，含 remoteProjectIpc/remoteProjectEnrollHook/spec guards）；`npm run typecheck` 0；`npm run build:fast` 0；`npx playwright test --list` 136 tests/56 files（`remoteSessionAcceptance.spec.ts` 16 tests，新增本批一项）；Biome 触达文件格式检查 0；未运行真机 e2e / 全量 `npm test`（由 Lead 执行）。
- **偏离（均经 Lead 批准或已报告）**：① restore/prune 单脚本预算 5,120→6,100（§3.4 实测与理由）；② `TRASH_ADMIN_SCRIPT` 拆为 list/restore/prune 三个常量（操作与命令数不变）；③ 两个 destroyed 监听模块各自撤自己令牌表（§3.6，测试证明两类令牌都被撤销）；④ list 的严格 manifest schema 重验放在 main（脚本只回传原始对象并做 ≤8KiB/id/payload 身份检查），restore/prune 仍在脚本内严格重验；⑤ BOUNDARY 扩为多锚点版并压短标识符；⑥ create-project 的确认流程抽到 `remoteProjectCreateIpc.ts` 以满足 400 行体量红线（方法表/通道名不变）；⑦ `MOVE_INTO_SELF` 由 main 依据 entry 令牌携带的 kind 判定（permission-only mode 无法携带文件类型位）。
- **未验证/不外推**：真机 Electron+SSH e2e（作者态，未运行）；`npm test` 全量；打包版/Windows/macOS 客户端；真实大小写不敏感远端文件系统；非协作进程在 check→rename 之间的替换（与既有写面同一边界）；`.pideck-trash` 的 Git 可见性（不自动写 .gitignore）按设计呈现。
