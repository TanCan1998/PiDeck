# 远端能力并入 dev：集成作战笔记（integration/dev-sync）

> 状态：**冲突已全部解决，门禁进行中**。本文件记录合并决策与验证证据；收尾后并入交接文档并从 docs/ 删除。

## 1. 现状

- 功能分支 `feat/remote-development`（已推送）：HEAD `c2ce9c7f7`，基于 `fd84cef0` 之后 **199** 个提交，版本 v0.7.7。包含约半个月的远端开发：远端 Git（G1–G5e）、文件管理/回收站、会话归档/恢复/永久删除、终端 ticket、配置后端、模型目录、安全修复、e2e/文档。
- 目标分支 `origin/dev`：HEAD `76f752f17`，基于同一 merge-base 之后 **926** 个提交，版本 v0.9.1。包含大量重构：原生 sidecar（xue-index/session-index/file-index/session-store）、GUI 扩展桥、standby 运行时池、ACP/MCP SDK、设置/样式/组件大改。
- 集成分支：`integration/dev-sync`（从 `c2ce9c7f7` 起），已执行 `git merge --no-ff origin/dev`，**合并进行中**。
- 冲突：**59 个文件 / 204 个 hunk**，全部解决（0 conflict marker）。
- 已完成的解决批次：A1 主进程核心 10 文件；A2 主进程外围 12 文件 + feishuIpc 过滤器修复；B 渲染层 24 文件；C 测试 12 文件；D 冲突后 typecheck/针对性测试修复（55 → 0 errors）；E1 合并专属测试修复（14 文件 + unifiedApi 快照显式刷新）。
- 门禁现状：`npm run typecheck` = 0；`npm run build:fast` = 0；`npm run check:format` = 0；`zh-TW` 已按生成脚本重算。

## 2. 解决原则

1. **dev 的新架构优先**：sidecar、session-store、GUI 桥、standby 池、新 IPC 注册结构、设置结构、组件结构一律保留 dev 的实现。
2. **远端能力不能丢**：以 `git diff :1:<path> :2:<path>` 取出「我方相对 merge-base 的改动」，逐块叠加到 `:3:<path>`（dev 侧）上，按 dev 的新 API 适配；不要盲目两边都留。
3. **远端开关语义不变**：feature 分支的门禁是 `!app.isPackaged && PIDECK_REMOTE_EXPERIMENTAL=1`；集成后保持该语义，后续再单独做打包版 opt-in（不要顺手放开）。
4. **i18n**：rendererCopy / mainProcessCopy 取 dev 基线 + 追加远端的键；改完 zh-CN 后跑 `node scripts/genZhTwCopy.mjs`（zh-TW 是生成物）。
5. **测试**：以 dev 的测试为基线，补回远端相关断言；不确定时保留 dev 测试并在报告里列出需要后续补的用例。
6. **不做范围外改动**：只改指派的冲突文件；不 `git add/commit/reset/stash/clean`，不跑 `npm install`，不 kill 进程。

## 3. 冲突批次（续跑用）

| 批次 | 范围 | 文件 | 状态 |
| --- | --- | --- | --- |
| A1 | 主进程核心 | 10 文件 | ✅ 完成（AgentManager/sessionIpc/SessionCatalog/index.ts/preload/shared 契约） |
| A2 | 主进程外围 | 12 文件 + feishuIpc 异常 | ✅ 完成（git/terminal/files/settings/projects/feishu 等） |
| B | 渲染层 | 24 文件 | ✅ 完成（App/atoms/hooks/组件/i18n/previewApi；远程 543 键追加） |
| C | 测试 | 12 文件 | ✅ 完成（dev 基线 + 远端断言；142/143 → 剩余项已由 E1 处理） |
| D | 冲突后修复 | typecheck/build 迭代 | ✅ 完成（55 → 0 errors；build:fast 通过） |
| E1 | 合并专属测试修复 | 14 文件 + unifiedApi 快照 | ✅ 完成（全部绿；unifiedApi 显式刷新到 743 通道 / 85 前缀 / 74 命名空间） |
| E2 | 最终门禁 | 全量单测 + 真机 e2e + 打包 smoke | 进行中（全量单测复跑、e2e、merge commit） |

## 4. 关键风险与提醒

- `AgentManager` / `App.tsx` / `main/index.ts` 是双方改动最大的文件（dev 侧 1433/868/2252 行级改动），必须先读 dev 版本结构再叠加远端逻辑。
- 远端 runtime 启动链路（`remoteRuntimePort`、SshClientRuntime、RemoteHostConnectionService）需要适配 dev 的 runtime coordinator / standby 池 / 认证桥新增路径；不要改动 dev 的启动顺序。
- dev 新增依赖（@agentclientprotocol/sdk、@modelcontextprotocol/sdk、proper-lockfile、zod），合并后已执行 `npm install`。
- 原生 sidecar 的构建脚本（build:xue-index/session-index/file-index/session-store）在最终 `npm run build` 时会用到；Windows 上若缺 Go 工具链，先只保证 typecheck + build:fast，打包前再解决。
- 合并提交前不要 push；完成后由 Lead 复核并决定 PR 时机。

## 6. 合并后的语义决策（必须保持）

1. **dev 架构优先**：standby 池、sidecar、session-store、GUI 桥、ACP、项目事务写入（ProjectStore INV-5a）一律保留 dev 实现；远端能力以端口/路由方式叠加。
2. **远端写面与 dev 新契约对齐**：远端会话消息 edit/delete 改为追加 pi 原生 `context_edit`（原文不改写、不墓碑），resend 仍墓碑截断；`remove-image` 在远端 fail-closed（`REMOTE_SESSION_HISTORY_WRITER_OPERATION_INVALID`），本机链路不受影响。
3. **本机专属链路统一收窄**：Feishu/WeChat/托盘/小窗/内容索引/提示词与原生资源/ACP 项目读取/文件树本地刷新，一律 `isLocalProject` 过滤或跳过；ssh 项目不得进入本机路径消费者。
4. **远端终端**：隧道/launcher 保持 ticket + 固定 runner；node-pty 改为 `loadNodePty()` 惰性加载（原生模块禁止顶层静态 import）；终端 I/O 非法载荷按 dev 语义静默忽略，远端 16KiB 输入预算仍抛 `INVALID_TERMINAL_INPUT`。
5. **远端开关不变**：`!app.isPackaged && PIDECK_REMOTE_EXPERIMENTAL === "1"`；打包版 opt-in 是后续独立产品决策。
6. **i18n**：dev 删除的 9 个旧键不得复活（collapsePrevRunsOnNewTurn、config.label.compaction、config.moveProviderUp/Down、rpc.logOpenedTitle/Description/logViewNow）；远端 540+ 键保留；zh-TW 只由 `node scripts/genZhTwCopy.mjs` 生成。

## 7. 已知红灯归属（合并后全量单测）

- dev 基线也红（环境/上游，不修）：`feishuSessionRuntimeBinding`（Node 24 子进程反序列化 runner 问题，`--test-isolation=none` 下 35/35 绿）、`quoteChip`、`rewindCheckpointCore`、`shortcutRegistry`、`tabSwitchPerf`。
- 功能分支合并前就红（历史遗留，不属本次回归）：`fileIcons`、`piRuntimeLauncher`、`remoteBootstrapSessionIntegration`、`remoteBrowseRoot`、`remoteGitRecovery`、`remoteHelperSearchNames`、`remoteProjectFileService`、`remoteRunnerEntry`、`remoteSessionRootIsolation`、`remoteSoakOwnership`、`sessionCatalogCommand`、`spinnerUtility`、`sshClientRuntime`。
- 合并专属红灯：**已由 E1 全部修绿**（14 文件 + unifiedApi 快照刷新）。注意 unifiedApi 快照锚点在下一次 dev 同步时需要再次显式刷新。

## 8. 收尾结果（E2，2026-10-18）

- **单元门禁**：`npm run typecheck` = 0；`npm run check:format` = 0；`npm run build:fast` = 0；全量串行单测 12,753 例仅剩允许的既有红灯（dev 基线 / 功能分支历史红灯，逐类见 §7，无合并专属失败）。
- **真机 e2e（真实 Electron + 真实 Linux 主机）**：13 项门禁测试 **12 passed / 1 failed**（13.2m）；G1–G5d/e、文件管理 v1、终端项目隔离全部通过，个别用例单跑亦通过。
- **剩余已知问题（产品侧，需后续处理）**：
  1. **远端 Fork 偶发挂起（阻断产品路 e2e）**：冷会话点「Fork」后主进程完成 runtime 激活，但后续无 fork 日志/无新 Tab/无错误 toast，240s 超时；单跑 7 次中 3 次通过。初步怀疑 `getRuntimeForkMessages` 无超时或 standby claim/target 竞态，需要主进程埋点定位。
  2. `LocalProjectFileBackend.list` 把词法项目根传给 `FileSystemService.listTree`，而 target 已 realpath 规范化：Windows 8.3 短路径（`%TEMP%\ADMINI~1`）下 Chat 项目 `files:list` 报 “escapes project directory”。e2e fixture 用 `realpathSync.native` 规避；产品修复建议传 `boundary.canonicalRoot`。
  3. TerminalDock 的 WebGL 渲染器降级路径中 `terminal.open` 抛错落在 try/catch 之外（xterm 仍以 DOM 渲染）；建议包住 open 并 dispose addon。
  4. 新建终端失败提示显示稳定码而非 `terminal.remoteDisconnected` 文案（`useTerminalDockTabs.reportFailure` 未走 `remoteTerminalErrorMessage` 映射）。
- **合并后保持的产品语义**（E2 修复，已进集成分支）：
  - 远端 SSH 会话的 edit/resend 保持 catalog/RemoteSessionHistoryWriter 路径（pi fork 只接受 user 条目，编辑目标是 assistant 回复；走 fork 会 `REMOTE_SESSION_REPLACEMENT_RPC_FAILED`）。
  - `RemoteSessionHistoryReader` 应用 `buildSessionProjection`，使 context_edit 的编辑/删除在远端时间线可见且 entryId 对齐。
  - e2e 断言按合并后的 context_edit 语义更新（effective history + 字节级 oracle 不变），终端用 DOM 渲染回退读取真实文本。

## 9. 收尾步骤（E2 剩余）

1. 修复远端 Fork 挂起（主进程埋点 + 超时/竞态修复），复跑产品路至稳定 13/13；
2. 修复 8.3 短路径 canonical root、TerminalDock WebGL open、终端断连文案映射；
3. 本地 merge commit；推送集成分支 → 由用户验收后合入 dev / 开 PR。


1. 全量 `npm run test:serial` 复跑：确认只剩上述允许红灯，无合并专属失败。
2. 13 项真机 e2e（`PIDECK_REMOTE_EXPERIMENTAL=1`，真实 Linux host 10.81.2.15）复跑；
3. `npm run build` / 打包 smoke（Windows portable/unpacked）确认远端 UI/链路可用；
4. 本地 merge commit（`chore(integration): merge origin/dev into remote feature branch`）；推送集成分支 → 由用户决定合入 dev / 开 PR。

## 10. 第二轮 dev 同步（2026-10-18 深夜，45 commits / 193 文件）

**结果**：merge commit `728366f70`，13 个冲突 / 22 处 hunk 全部解决，0 marker。

**冲突批次**：
| 文件 | 归属 | 解决方式 |
|------|------|----------|
| `src/main/settings/SettingsStore.ts` | 语义 | dev 把 `migrateComposerModesVisibility` 重命名为 `migrateRemovedComposerModesToggle`；采新名 + 保留远端 `remoteProjectTrust` 归一化 |
| `src/main/ipc/gitIpc.ts` | 语义 | dev 的 watcher 自带 toplevel 解析（`acquire` 改同步）；保留远端 `repoPath?: unknown` 边界校验 + `await requireGitCwd` |
| `src/renderer/src/utils/fileTreeLazy.ts` | 语义 | 采 dev 的 `touched` 引用稳定语义，键比较切到远端用的 `fileTreeNodeKey` |
| `src/renderer/src/hooks/useProjectSync.ts` | 合并 | 两侧 import 都要（`isLocalProject/isRemoteProject` + `useFileTreeContentState`） |
| `src/renderer/src/components/session/WorkspaceSurface.tsx` | 结构 | dev 把文件树行/会话历史拆出，采 dev 结构；保留远端 `ProjectFileTarget` 类型 |
| `src/shared/api/consolidations.ts` · `docs/unified-api.md` · unifiedApi 三测 | 数字 | 743 通道 / 85 前缀 / 74 命名空间 / sessions 115 / git 59（已用探针实测确认） |
| `tests/tabSwitchPerf` · `tests/workbenchContentHost` | 契约 | 采 dev 的空白容忍正则与新宿主路径，按远端 `fileActionTarget` 改断言 |
| `rendererCopy.zh-TW.ts` | 生成物 | 改 zh-CN 后重跑 `genZhTwCopy.mjs`（四份词典全部重生成） |

**第二轮新增的远端适配（关键）**：dev 在本轮把文件树整块迁到 `FileTreeRows.tsx` / `useProjectFileTreeController`，**新文件不含远端适配**，直接用会让远端文件树回归。已补回：
- `FileTreeRows.tsx`：`fileActionTarget = node.target ?? node.path`（点击/双击打开）、活跃文件比较 `node.path ?? node.relativePath`、目录展开键与拖拽落点统一走 `fileTreeNodeKey`、子项 `key={fileTreeNodeKey(child)}`、Git 着色查表用 path/relativePath 而非裸 `node.path`。
- `useFileTreeGitStatus.ts`：远端仓库条目可能没有 `path`，缺省时不再把 `undefined` 传给 `git:status`（按默认 scope 处理）。
- `workbenchContentHost` 契约测试同步跟到新宿主并断言 `fileActionTarget`。

**门禁**：typecheck 0、check:format 0、build:fast 0；unifiedApi 三测 23/23 绿；远端域测试 1653 例仅 9 红，全部落在 §7 既有红灯清单内（无合并专属失败）。
