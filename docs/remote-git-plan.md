# 远端 Git：调研结论与分阶段实施计划

> 状态：G0 调研、G1 status/diff、G2a 单文件 stage/unstage、**G2b 单次普通提交**、**G3a 只读历史／引用**（helper 1.10.0，§5.10／§5.11）、**G3b 分支写面（新建分支／切换）**（helper 1.11.0，§5.12）、**G4a 可恢复丢弃／删除**（helper 1.12.0，§5.13）、**helper 多文件部署包拆分**（1.13.0，§5.14）与 **G4b 恢复清单／一键还原／清理**（helper 1.14.0，§5.15）已完成 Linux 开发态实现、针对性回归及真实 Electron＋SSH 验收（G2b 见 §5.9.1）；G6a 补故障／并发／短周期资源回归并修复未知结果提示，G6b 新增真实 SSH 长稳验收且有一次完整 1 小时通过，G6c 更正暖机阶跃归因并加 steady-state 门禁（§5.6–§5.8）。G3 写面（checkout／建分支）与 G4–G5、完整 G6 未完成。仍受开发态实验门禁约束，不代表 Git parity 或 Remote v1 已收口。
> 核对基线：`feat/remote-development`，G0 调研基线 `101b9b82c`；G1 从 `bc25ebe20` 实施，G2a 从 `f83f9d550` 实施。
> **冻结 helper 源码编辑纪律**（2026-10-16，同一次会话内第二次踩到；§5.14 拆分后该纪律按**每个 bundle 文件**逐一适用，各文件的审阅上限仍是 96 KiB）：`RemoteGitReadSource.ts`／`RemoteGitWriteSource.ts` 的正文是 `String.raw` 模板，**新写的注释里出现反引号或 `${` 会提前终止模板**，结果是文件仍「像」有内容但编译产物丢掉后半段（本次现象：写入源少了整个分支程序、压平产物报 `Illegal return statement`）。改这两处之后固定三步自检：① 文件内反引号总数 == 2；② `node --check` 压平后的 helper 产物；③ `loadTsCommonJs` 读出的 `REMOTE_GIT_*_SOURCE` 里能搜到新函数名。
> 范围：落实总计划 §6.3 的 Git 能力；近期顺序仍为 **status/diff → stage/unstage/commit → 跨平台与稳定性**，不一次性搬运所有本机操作。

## 1. 技术结论：继续使用 Git CLI，不更换引擎或新增 Git 依赖

Git 算法、对象库、index、refs 和提交仍由原生 Git 实现。PiDeck 已有自己的命令封装、结果解析、位置边界、IPC 与 UI；需要补的是这些产品层的远端执行能力，而不是重新实现 Git。

### 1.1 G0 开工前代码事实（G1 实施结果见 §4.6）

| 层 | 已有实现 | 远端断点 / 复用判断 |
| --- | --- | --- |
| 命令与语义 | `src/main/git/GitService.ts` | 使用系统 Git；部分方法走 `gitProcess.runGit`，部分读取直接 `execFile`，工作区内容还使用本机 fs。不能整类直接用于 SSH。 |
| 进程生命周期 | `src/main/git/gitProcess.ts` | 已有 timeout、输出字节预算、进程树终止和兜底 settle。本机执行器保留；远端需要在远端进程实际产生风险的位置执行对应限制。 |
| executable | `src/main/git/gitExecutable.ts` | 本机设置与 PATH；不能用于选择远端 Git，也不能向远端复制本机 binary。 |
| 位置边界 | `src/main/git/GitBackend.ts` | `LocalGitBackend` 使用本机路径与 fs；`GitBackendRouter` 明确拒绝 SSH。现有接口主要负责路径边界，不是可替换的完整 Git 操作接口。 |
| IPC | `src/main/ipc/gitIpc.ts` | 当前处理器先取得本机 repository context，再直接调用本机 `GitService`。仅加一个返回远端 cwd 的 backend 会误入本机 Git/fs，必须按操作路由。 |
| 契约 | `src/shared/types/git.ts` | SCM resource 已有 `target`、`oldTarget`、项目相对 `path` 和 `displayPath`；可以复用，不新增伪造本机绝对路径。 |
| 展示 | `GitDrawerHost`、`GitPanel`、现有 diff viewer | 已有多仓 scope、SCM 分组和双侧内容展示。优先复用触达部分；需要 capability 控制按钮和后台请求，不能以返回空列表假装未实现的历史功能。 |
| SSH 接入 | `RemoteHostConnectionService.withProjectSession` | 已覆盖整次项目操作的主机锁、root 切换、verified Node、pin/route 与连接身份。Git 沿该链路接入，不新增信任链或 Agent 通道。 |
| 已部署 helper | `RemoteHelperContract`、`RemoteHelperEntry`、`RemoteBootstrapDeployment` | 当前只提供 hello/echo/cancel 与只读 fs 方法，没有 Git。新增 Git method 是显式协议扩展，需要 capability、冻结版本/hash、部署及取消/清理测试一起更新。 |

`package.json` / `package-lock.json` 没有 `simple-git`、`dugite`、`isomorphic-git` 或 `nodegit` 依赖。本机现有 Git 能力包括状态、diff、stage/unstage/discard、commit、分支、历史/refs/compare、fetch/push/pull/ahead-behind、refs watch 和 worktree/历史修改等；这些不等于远端已支持。

### 1.2 成熟方案比较

| 方案 | 官方资料确认的定位 | 对本任务的结论 |
| --- | --- | --- |
| **simple-git** | MIT；通过子进程封装 Git CLI，支持自定义 executable，binary 数组至多两个 token。 | 适合从零写 Node CLI 封装；本项目已有对应层。不能将它简单配置成 `ssh` 就获得安全的 root、身份、取消与 typed operation；仍需写这些接入，还要迁移既有解析和错误语义。暂不引入。 |
| **dugite** | MIT；TypeScript Git CLI API，由 GitHub Desktop 等 GitHub 项目需求驱动；对应 `dugite-native` 提供 portable Git 工具链。 | 有真实桌面产品参考价值，但主要解决应用执行 Git 的封装/分发，不解决本项目的 verified SSH 工作区。当前无打包 Git binary 的需求，替换收益不足。 |
| **isomorphic-git** | MIT；面向 Node/browser 的纯 JavaScript Git 实现，直接操作兼容的 `.git` 磁盘格式。 | 会引入第二个 Git 引擎，并带来与原生配置、属性、过滤器、索引/提交语义的额外兼容验收。用户需要远端账号现有 Git，不是浏览器内 Git，暂不采用。没有以未核实的 SSH 支持结论作为排除依据。 |
| **NodeGit** | MIT；libgit2 的 Node bindings，官方 README 包含本地构建/系统库要求。 | 会引入另一套 Git 引擎与 native binding，增加 Electron ABI、平台、远端安装和打包验证面。未安装、未验证它对本项目 Electron/Node 组合的兼容性，不宣称它不可用；只是目前不值得替换。 |

这些库均不能直接作为现有 PiDeck SSH Git 面板的即插即用模块。结论不是“所有代码自己写”，而是：**原生 Git 做 Git；复用 PiDeck 已有产品层；只实现缺失的远端 adapter 与安全/生命周期边界。** 不安装依赖、不升级 Git/pi、不复制第三方大段源码。

## 2. 整体能力地图与交付顺序

| 批次 | 能力 | 完成条件 / 边界 |
| --- | --- | --- |
| **G0** | 现状审查、库调研、整体计划 | 本文；不改 Git 业务代码。 |
| **G1** | root 仓库识别、status、按需 workspace/index/untracked diff、能力矩阵 | 真实 UI 可查看已有普通根仓库；明确区分 non-repository、空状态、unsupported 与失败；所有写面保持禁用。 |
| **G2** | stage/unstage/commit | 精确路径操作、unborn 行为、index/HEAD 并发、提交预览与回执不确定性、仓库工程门禁通过后开放。可独立收口 stage/unstage；不能为凑齐三项而降低 commit 门禁。**现状：stage/unstage（§5.5）与单次普通提交（§5.9.1）均已交付；amend／merge／签名仍禁用。** |
| **G3** | 历史/log/count/refs/detail/commit diff、compare、基础分支、嵌套仓库发现、refs polling | 有界历史与 diff，明确 repo scope；checkout 单独处理 dirty/conflict 和工作区改写；polling 随连接代数、窗口及订阅清理。 |
| **G4** | init、discard 单个/批量、删除 workspace 文件 | 创建及破坏性写面单独验收。tracked discard 保留 index；untracked 删除必须可恢复或明确确认，不把远端永久删除称为本机回收站等价。 |
| **G5** | ahead/behind、fetch/push/pull | 只在远端使用远端凭据；用户明确发起网络/历史变更；非交互、无隐式 fetch/pull/rebase/force、无断线自动重放。 |
| **G6** | Windows/macOS 客户端→Linux、延迟/断网/长稳、打包与发布门禁 | 在 G1/G2 最小闭环后优先开始跨平台与稳定性验证，并对后续批次增量复验；未完成 G3–G5 不能宣称 Git parity 或 Remote v1。 |
| 后续独立范围 | clone、worktree 创建/移除、cherry-pick/revert/reset/drop、checkpoint/rewind | v1 禁用并给原因；不顺手打开危险历史修改。 |
| 后续独立范围 | AI 生成 commit message、远端 Git executable 设置 | 前者须先完成 host-target 模型与有界 diff 输入，不沿用本机 QuickGen cwd；后者不展示本机 executable 文件选择器。 |

表中 G3–G5 是完整 Git 路线图，不是本次 status/diff 的扩大授权。近期实际写面仍先 G2；其余操作在各批次给出具体 Implementation Plan 后推进。

## 3. 公共边界与实现落点

### 3.1 操作路由，不传“虚拟本机 cwd”

- renderer 只发送 `projectId`、可选 repo 的 `ProjectFileTarget`、文件 target、封闭操作枚举及必要业务参数。不能发送 host/root/executable、任意 shell、argv 或 Git config。
- main 从当前 `ProjectStore` 取得 SSH locator，经 `withProjectSession` 验证 canonical root 和 host revision。项目快照、连接身份与结果接收端必须绑定；所有产生副作用的 await 之后再次检查。
- main Git 域增加远端服务/operation port；IPC 仅校验和适配。保留本机 `GitService` / `LocalGitBackend` 的现有行为，不为了三个远端操作重写整个本机类。
- SSH 请求在进入本机 repository/fs/path 解析之前分流。其余 Git IPC 保持明确 unsupported，不能返回成功空值或 local fallback。
- 项目 trust 必须现读有效 host-endpoint-root 决策；未确认、拒绝、撤销、失配或材料不可读时不执行 Git。Pi 项目资源授权不能被解释成任意 Git hook/filter 的授权，也不能偷偷扩大已有设置含义。

### 3.2 控制通路与资源生命周期

采用**现有 SSH stdio control helper 的可协商 Git method**，不新增 HTTP、SFTP 工作区镜像或独立常驻 Git 服务，也不借 pi RPC 让 Agent 代做 UI Git。

- helper 以原生 `spawn(executable, argv, { shell: false, ... })` 执行固定命令模板；每个 operation 有 allowlist，实际执行边界再次校验参数。复用纯解析规则，不在 renderer 或远端写第二套 Git 算法。
- Git executable 在已 pin 的远端账号环境中探测为绝对路径并核对版本/能力；缺失时给安装提示，不自动安装、不信任 renderer 提供的路径。不以本机 Git 设置代替远端事实。
- 新 Git method 占用有界并发槽；timeout/cancel、stdin EOF、helper 退出和连接丢失均回收远端 Git 子进程/进程组，所有 main pending 请求有限时间结算。不能只杀本机 SSH 而假称远端进程已清理。
- helper source/version/digest、capability 声明与部署 manifest 同批更新；旧 helper 明确 unsupported，需要显式重连升级，不猜测支持、不重放旧请求。
- 无自动后台 fetch，也不沿用本机 fs watcher 监控远端路径。G1 手动/可见面板刷新；后续 polling 有预算、无重叠请求、可卸载与断线清理。

### 3.3 身份、路径、结果与能力

- `ProjectFileTarget` 为唯一文件 authority。旧路径只作为 display，不进入本机 fs、spawn cwd、shell 或 `file://`。
- 使用远端 POSIX 语义，拒绝绝对路径、`..`、NUL/控制字节、非法旧路径与超长参数。路径作为数据传递，使用 literal pathspec 与 `--`，不拼 shell；ref/branch 按类型验证，不统一当自由字符串。
- status 使用 Git 官方稳定 `--porcelain=v1 -z` 格式；完整 UTF-8/完整记录验证后解析，保留 rename/copy 的新旧路径与 index/worktree 双状态。不能按行切割或按空格拆文件名。
- capability 同时约束 main 与 UI：按钮、菜单、初始 mount 请求、历史加载、refs watcher、自动刷新都需守卫。不能只把按钮涂灰而后台仍调用 unsupported 方法。
- SSH 图谱/分支/同步尚未实现时显示原因，不能用空历史/空 branch 列表假装支持。
- 同 host 双项目、不同 host 同相对路径、项目切换和迟到结果按身份隔离。缓存不跨 host/root/revision/generation 复用，身份失效清掉可信快照。

## 4. G1 Implementation Plan：只读 status/diff

### 4.1 精确范围

- 只支持**项目根即普通非 bare Git 仓库根**，`.git` 为项目内真实目录。unborn、detached HEAD 均需明确呈现。
- G1 不向项目父目录自动发现 Git，不接受项目外 gitdir/commonDir/对象 alternates；gitfile/worktree/submodule/复杂仓库明确 unsupported，不能跟随它们读项目外 metadata，也不能忽略它们后显示干净。
- 不扫描嵌套仓库、不 init、不 stage/unstage/commit、不 discard/delete、不 checkout、不网络同步、不 refs watcher、不 AI commit message。
- 状态按现有 merge/index/workingTree/untracked 分组展示。冲突只展示事实与只读 diff，不解决冲突。
- 双侧 diff 对齐已有语义：index＝HEAD→index，workingTree＝index→工作区，untracked＝空→工作区，删除侧为空；rename 使用明确的 old/current target，冲突需说明所用基线，不伪造三方 merge editor。
- 工作区普通文本按需读取，不通过本机 files API；符号链接不跟随，二进制、非法 UTF-8、特殊文件、超限或状态已变化给明确不可预览/刷新结果，不伪造空文本。

### 4.2 Read-only 不只是命令名字

`git status` 默认可能刷新 index；G1 使用 `--no-optional-locks` / 等价环境限制，验证前后 index 字节与 metadata 不变。Git 读取还可能触发 fsmonitor、pager、external diff、textconv 或属性 filter；只读执行器必须在执行点关闭不必要的外部执行面，且对不能安全保持语义的仓库明确拒绝。

- 原始 Git blob 不使用 textconv/filter；工作区内容由 helper 有界读取；若使用原生 diff，固定 `--no-ext-diff --no-textconv`。
- 清理继承的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、object/config injection 等变量，仅由受控执行器设置；关闭 pager/color/交互提示与 fsmonitor，不回传原始 stderr 或秘密配置。
- 对需 clean/process filter 才能得到正确状态的仓库，不能悄悄忽略 filter 并展示错误状态；G1 明确 unsupported，后续单独设计。
- 不设置 `safe.directory=*` 绕过 Git ownership 检查。不根据错误消息自动更改远端配置。

### 4.3 初始预算（实施与测试必须同源）

- 单次 status 原始输出 ≤ 1 MiB，资源记录 ≤ 4096；超过任一上限整次明确拒绝，不返回“看似完整”的截断状态。
- 单侧 diff 原始正文 ≤ 256 KiB，两侧合计 ≤ 512 KiB；考虑 JSON/base64 开销后仍严格低于现有 8 MiB frame。二进制/大文件返回不可预览原因，不截断成可编辑文本。
- index 一致性检查最多读取 16 MiB；metadata 使用有界目录 cursor，最多 20000 条、32 层；超限拒绝，避免在大对象库中无界遍历。sparse/split index、partial clone/promisor、submodule 和外置 metadata 不在 G1 支持范围。
- 读取 Git 进程 deadline 30s，stderr ≤ 64 KiB；超限立即中止，timeout/cancel 使用有界 settle。预算按 UTF-8 字节而非字符计。
- 列表不携带正文；diff 仅当前点击文件按需读；renderer 不缓存全仓所有 diff。
- 请求不得重叠轮询；切项目或断线后丢弃迟到结果，不把旧快照当成新项目状态。

### 4.4 触达面

1. Git 域：远端 operation 服务、固定 argv/结果解析、capability 与身份校验；确有复用必要时最小提取现有纯 parser，保留本机行为与导出。
2. helper：Git 只读 dispatch、原生子进程有界生命周期、版本/hash/capability/部署校验。
3. shared / IPC / preload：能力声明与只读 target 路由，同步 preview API；既有 local 契约不被 remote 预算改变。
4. renderer：SCM 只读资源与 diff 入口、能力守卫、稳定错误码、双语说明；App 只做装配，不堆业务策略，不创建第二套视觉语言。
5. tests / e2e：生产 helper 子进程、router、生命周期、UI guard 与真实 Electron/SSH 专用 repo；不依赖模型生成正文。

### 4.5 最短验收路径

- 红例先证明 SSH status/diff 被现状拒绝；增加生产测试，再实现。
- 普通 repo、unborn、detached、修改/新增/删除/rename、staged 后再编辑（MM）、冲突、空仓与 non-repo；special name、option-like/pathspec 字符、非法路径、symlink、外置 Git metadata、filter/执行面、无 Git、输出超限与断线。
- 全 Git IPC 的 SSH 负对照：unsupported 请求零本机 Git/fs 调用；helper 未声明能力时零 Git 执行。
- 真机新建本次唯一专用仓库，通过 UI 读分组及 diff，两侧内容与独立远端 Git/blob/files oracle 一致；前后 HEAD/index/工作区及本机对照仓不变。
- 双项目同名文件、切换迟到、手动断开后零隐式连接、明确重连刷新；关闭窗口/退出后进程与订阅清理。
- `npm run typecheck`、触达 Biome、相关有界单测、spec `--list`、触达 main/preload 与 production renderer 构建、真实产品路径、diff/status 复核。只编译触达目标，不全量构建/测试。

### 4.6 实施证据（2026-10-14，Linux 开发态只读切片）

- `RemoteGitReadSource.ts` 的自包含程序嵌入冻结 helper **1.7.0**，只加载 Node 内置模块；新 method 为 `git.status` / `git.workspaceDiff`。没有部署第三方 Git 引擎或新增写/网络 method。
- `RemoteGitService.ts` 绑定当前项目值、现读 trust、已确认 root 与 helper capability，严格验证完整协议数据；取消仅命中当前请求 id，迟到/改指结果拒绝。
- `gitStatusParser.ts` 为本机既有纯 SCM parser 的等价提取；远端单独补 intent-to-add 展示，不顺手改变本机 stage/diff 行为。
- 核心有界针对性测试 **9 文件 94/94**；涵盖真实 helper/Git 的 HEAD/index/worktree、rename/delete/intent/unborn/detached/conflict、BOM/CRLF、二进制/预算/metadata/filter 拒绝、fsmonitor/external-diff/textconv 零执行、取消/timeout/EOF/overflow 实际子进程回收，以及 main service trust/capability/身份/数据校验。证据：`/tmp/remote-git-g1-core-tests2.log`。类型检查通过：`/tmp/remote-git-g1-core-typecheck.log`。
- **产品接线**：`remoteGitReadIpc` 提供结构化 snapshot，既有 status/workspace-diff IPC 在本机 repository 解析前分流。总32在途／每窗口4；sender销毁、项目视图卸载和quit配对取消，cancel authority只接受sender＋project，不让renderer指定helper id。`withProjectSession` 在主机锁内应用 `requireReady`，只允许已有ready主机切helper根，不自动连接离线主机；排队取消后零Git请求。旧helper能力缺失不执行Git。
- **UI**：仅可见SSH Git抽屉挂载`RemoteGitPanel`，复用`FileTree`与已有`FileDiffViewer`。按需读取双侧正文，不挂载原生repo发现／history／graph／branch／fetch／refs watch或轮询；会话底栏SSH branch polling也被阻断。文件行不提供stage/unstage/discard/delete。失败刷新清旧快照、跨project/root切换丢弃迟到结果；主机状态失效清快照，明确connect本身不重放Git读取。root切换销毁旧helper的迟到disconnect事件不再伪造新主机故障。
- **授权入口**：Git未授权时只显示说明和明确按钮，复用既有项目trust决策；原样列出目录，说明也会在下一次pi启动允许该项目`.pi`资源。没有隐式授权，也不把approve解释成Git hook/filter权限；所有Git读取仍现读有效host-endpoint-root材料。
- **最终回归**：25个针对性测试文件 **207/207**，覆盖上述核心、注册后的全Git IPC SSH零本机负对照、sender/project精确取消、离线零bootstrap、旧helper零Git、UI只读控件/挂载、异步身份失效、trust明确按钮/迟到结果，以及本机Git、终端、远端文件与root邻域。项目typecheck、触达Biome、diff检查、spec `--list`、main/preload与production renderer构建通过。证据：`/tmp/remote-git-g1-regression-final.log`、`/tmp/remote-git-g1-typecheck-final.log`、`/tmp/remote-git-g1-build-main.log`、`/tmp/remote-git-g1-build-renderer2.log`。
- **真实Electron＋SSH**：本次唯一双仓库通过真实UI授权与SCM分组，核对MM、staged rename/delete、untracked；HEAD→index、index→工作区、空→untracked的显示正文对应独立Git/blob/file oracle；二进制明确拒绝。双项目同名文件往返不串正文，实际断开后刷新不隐式连接、快照清空，明确重连不重放，用户刷新才恢复。读取前后两个仓库每个文件SHA-256和mode/size/inode/mtime/ctime（含HEAD/index/metadata/工作区）逐字一致，本机临时对照仓index字节/metadata与文件不变。仅本次唯一夹具被创建和清理，不依赖模型回复或修改用户Git设置。Git专项最终复验与原trust专项 **2 passed（3.7m）**；证据`/tmp/remote-git-g1-ui-final.log`、`/tmp/remote-git-g1-ui-final-artifacts/`（独立前后oracle附件），此前Git单项1 passed/1.9m。
- **失败记录**：第一轮卡在跨项目抽屉关闭动画上，按项目保存的chrome重新打开并核对DOM projectId，未force点击；连接设置页既有local state在remount后丢失，沿终端验收先明确连接再实际断开，不把旧label作为连接事实。另一次定位到状态文字包含主机前缀，移除错误的exact选择器而不放宽连接/断开断言。`/tmp/remote-git-g1-ui1…ui3.log`及对应artifacts保留失败；未顺手改连接设置页状态设计。`/tmp`无长期保留承诺。
- **未验证／未开放**：真实UI证据仅Linux客户端→Linux主机；unborn/detached/conflict/无Git/复杂配置/进程组取消等由生产helper子进程测试覆盖，不称这些全部经过真机UI。完整默认会话/模型流程未重跑，旧模型额度、DSH、本机旧Agent入口基线问题不被本轮绿灯覆盖。G2写面、G3–G5、Windows/macOS、长稳、多窗口、打包、dev集成及独立安全审查仍未完成；前后复核不是内核原子快照，也不保证所有外部Git writer并发。没有新增Git库、升级Git/pi或安装服务器依赖。

## 5. G2 写面：先定语义和工程门禁，再实现

### 5.1 stage / unstage

- stage 仅当前请求且最新 status 认可的项目内路径，rename 的两路径一并验证；不运行 `add -A`、不顺带暂存其他文件。
- unstage 仅改 index，保留工作区字节；有 HEAD 与 unborn 分别用 Git 的合法原语处理，不使用 destructive reset。
- root-only 仓库先交付，避免 project 是 monorepo 子目录而 commit 意外包含 sibling index 的歧义。
- main 所有写操作按 host/project/repo 串行；不同客户端、Agent 或远端终端不共享这把锁，不能声称已锁住所有 Git writer。
- 新鲜 status/index/HEAD 与所选路径需复核；锁竞争、stale、外部改动及超限明确失败，不静默跳过后报成功，不自行删除 `.git/index.lock`。

### 5.2 commit

- commit 仅提交暂存区，禁止顺手 stage。预览列出完整 index 范围、当前 branch/HEAD 和所用快照；不支持 partial repository scope 下的隐式全仓提交。
- message 为有界数据，经 stdin / 固定 Git 参数传递，不拼 shell；缺 author/committer、需要交互、冲突 index 或已有 merge/rebase 等操作状态明确阻塞。
- 必须先验证 index/HEAD 变化与提交边界。**普通前后检查加 native `git commit` 不是原子 expected-index/HEAD CAS**；不宣称它能保证所有外部并发。若无法满足“不意外包含未确认的暂存内容”的产品门禁，先交付 stage/unstage，commit 保持禁用，不改用自写 Git 引擎或未经审查的 index/ref 事务掩盖问题。
- 成功以 Git 退出状态、可核对的 commit OID/父链/tree 事实为依据，不以日志字符串或 UI toast 为 oracle。
- 命令开始后断网/timeout/cancel 可能已修改 index/创建提交；返回“结果未确认，先刷新检查”，不得假称未执行、自动重试、reset 或反向提交。

### 5.3 hooks、filters、signing：不偷偷绕过工程门禁

早期总计划写过“UI 写操作使用空 hooks 目录并关闭签名”。这不是本轮已实施能力；实施时不能以该简写自动绕过仓库要求。

- G2 初始只开放不依赖项目 hooks/clean-process filter/交互签名的 managed 基础写面。
- 如果检测到有效 hook、强制签名或相关执行要求，UI 写面明确拒绝并说明使用远端终端；不偷偷 `--no-verify`、关闭签名或改配置来让 commit 成功。
- 要在 UI 支持这些执行面，需独立决定授权、secret/AskPass、运行预算和 hook 修改文件/index 后的语义；不把 Pi 资源 trust 直接扩成 hook 授权。
- `.sample` 与有效 hook、全局/仓库 config、attributes 及 helper 检测需要针对性测试；不能只检查一个固定 `.git/hooks` 路径。

G2 真机只操作本次创建的 repo：stage→diff→unstage 字节不变→重新 stage→commit→独立 Git 核对 tree/父链；包括 unborn、精确范围、外部 index/HEAD 变化、hook/签名拒绝、权限/锁失败和回执不确定性。普通 Git 配置不得被探针覆盖。

### 5.4 G2a Implementation Plan：单文件 stage／unstage（已确认并实施，证据见 §5.5）

本批先交付可独立验证的暂存／取消暂存，**commit保持禁用**。原因不是缺少CLI，而是完整确认的index和expected HEAD无法靠「检查后普通git commit」形成原子门禁；不以commit-tree/update-ref或自定义Git事务临时拼接绕过该问题。后续commit另行完成工程门禁与并发方案。

> 该保留意见在 G2b（§5.9）落地：提交不使用 `git commit`，而是 `write-tree` + `commit-tree` + `update-ref <new> <old>` 的**原生 ref CAS**，因此“完整确认的 index + expected HEAD”由 Git 自己的比较交换保证；工程门禁照旧拒绝而不是绕过（§5.9.1）。

1. **公共契约**：helper新增可协商`git.stage`／`git.unstage`，升级冻结build/hash；snapshot额外带main签发的短期、一次性opaque mutation token。renderer只发送projectId、封闭operation/group、单个ProjectFileTarget和token，不能指定host/root/executable/config、旧路径或helper requestId。旧helper仍可读，写能力缺失明确禁用。现有本机stage/unstage行为不改，不借原生批量按钮扩大范围。
2. **快照与身份**：token绑定sender、当前project locator、host store revision及helper核对的root/gitdir identity、HEAD/branch、index完整SHA与metadata、完整porcelain状态摘要；同项目刷新取代旧token，消费发生在首个await前，最多128条／15分钟。主机锁队列后再核对身份、trust和helper capability；原始期望摘要只在main/helper间传递。stale、过期、冲突、merge/rebase等进行中状态均明确拒绝，不能静默跳过后报成功。
3. **官方index锁与受控副本**：Linux普通根仓库；root与`.git`分别FD锚定/no-follow。排他创建官方`.git/index.lock`（0600），已存在的锁拒绝且永不删除／解锁他人文件。持锁后复核期望index/HEAD/status，再将原index复制到同一锚定gitdir内本次随机排他shadow index。原生Git以受控`GIT_INDEX_FILE`操作shadow，真实index在最终提交前不变；没有第二Git引擎或旧版兼容fallback。
4. **精确路径语义**：只接受最新对应组认可的一行；stage读取动作开始时的最新普通UTF-8文本（单文件256 KiB），不是对旧diff正文逐字节确认。工作区文件在执行前后核对字节/metadata，删除不得被复创建文件冒充；rename旧路径由helper从受核对状态派生，不能由renderer自报。stage使用原生Git的精确literal pathspec，staged rename后的新路径编辑不得误带已不存在的旧路径。unstage有HEAD时对冻结commit OID做仅路径index恢复，unborn从shadow index移除但不删工作区；nativeCLI保留其他暂存内容。最终验证非选中index entries未变，工作区未被写入，不使用add -A全仓、reset --hard或discard。
5. **工程执行门禁**：先用有效配置与默认hooks目录核对。任意配置的`core.hooksPath`、非sample有效可执行hook（含post-index-change）、clean/process filter、签名要求或复杂index/仓库均拒绝；不清空hooks、chmod脚本、关闭签名或改Git配置换取成功。`.sample`不是有效hook；未实现的执行要求提示使用远端终端。
6. **实际发布点**：验证shadow index结果、source index/HEAD/root事实和所属锁；只向本人持有的lock FD写入有界index、保持原mode/uid-gid（不chown）、fsync，复核后原子rename lock→index。操作后核对实际index字节／归属。官方index锁只约束配合Git锁协议的writer；不保证非协作直接写者，也不宣称HEAD与index有跨文件原子CAS。晚到HEAD变化仍是显式风险，unstage使用冻结OID，不偷偷换基线。
7. **结果与清理**：deadline30s、stderr64 KiB，index16 MiB与已有metadata预算保留。取消/EOF/超时回收真实子进程；只释放／清理核对为本人所有的锁和temp。原生add可能已写入未引用Git objects，即使最终index未发布也不宣称「远端零磁盘变化」；不自动GC、删index.lock、reset/revert或重试。发布后异常或传输丢失统一为“结果未确认，刷新核对”，绝不自动重放写操作。
8. **UI与验收**：复用FileTree单行stage/unstage按钮；隐藏目录／all／discard／delete／commit／sync操作。一次写操作在途时禁用其他写与刷新，成功再只读刷新，未知结果需手动核对；切项目/卸载丢迟到结果并撤销旧token。先红后绿覆盖真实helper/Git、一次性token/身份/窗口、原生本机负对照；真机仅本次唯一repo，stage→diff→unstage、unborn、rename、精确范围、外部index/HEAD变更、hooks/签名/锁拒绝、工作区字节和本机对照不变。只构建触达main/preload/renderer，不做全仓build。

**只读可行性验证（不是生产验收）**：在本机唯一临时仓库用原生Git证明，持有真实`index.lock`期间可通过shadow `GIT_INDEX_FILE`独立取消unborn暂存／恢复rename两路径；真实index与HEAD/工作区未变，另一条暂存blob保持原OID。该临时目录已清理。生产安全／并发／失败与真机证据必须由后续回归独立给出，不能据此提前称G2a完成。

### 5.5 G2a 实施证据（2026-10-15，Linux 开发态）

- **helper与本机边界**：`RemoteGitWriteSource.ts`与G1读取程序同源嵌入helper **1.8.0**（G2b 起为 1.9.0，见 §5.9.1），冻结SHA-256 `86db736b3e6a20f4bd98d29c498d2b732ff8bb9a9f985da2cb0291dc1d4d94ff`。仍只用四个builtin；为维持原有64 KiB审阅上限，删除大行内与文件头重复的10段解释注释，不放宽测试阈值；正文64,257个ASCII字节。新能力只声明`git.stage`／`git.unstage`，没有commit、网络或自由argv入口；既有本机Git写IPC对SSH仍拒绝。
- **受控原生Git**：官方`index.lock`排他0600，root/gitdir FD锚定；同目录随机0700 scratch中复制index、HEAD与白名单有效配置，通过私有`GIT_DIR`／`GIT_INDEX_FILE`运行原生Git，以现有objects目录存放原生生成的blob。真实有效hooks、任意hooksPath、filter定义或签名要求在副本执行前后拒绝；私有context冻结的配置不具有项目代码执行能力，不把late新增的hook/config竞态带进原生add。不是把现有工程门禁清空后照样发布；晚到门禁阻塞真实index替换。保留原生autocrlf/attributes语义，比较非选中stage0 entries（mode/OID）不变、工作区正文/metadata与属性不变，再写本人lock、保mode/uid/gid、不chown、fsync、rename并核对结果。拒绝skip-worktree、assume-unchanged、split/sparse与非stage0 index。
- **令牌与生命周期**：`RemoteGitMutationTokens.ts`最多128条／15分钟，sender＋project绑定、刷新替换，host revision与locator绑定在main-held expectation中；消费发生在首个await前。helper revision摘要绑定root/gitdir identity、index SHA/metadata、HEAD/branch和完整status；不把内部摘要或host/root交给renderer作为写权限。视图卸载、断线、明确取消、sender销毁和quit均撤销令牌／取消在途操作；旧helper仍能只读，未协商写能力无按钮。IPC新通道只接封闭operation/group、单target和opaque token。
- **失败语义**：子进程组在deadline/cancel/EOF被终止；先等待回收再清理，清理只认本次拥有的inode，未知／被替换artifact保留，不递归删未知目录或删别人的锁。明确错误不替换真实index；发送写请求后timeout/cancel/断线、未知错误／身份变化，以及发布后的异常，main统一提示结果未确认，清旧事实，要求用户手动刷新，不重放。中断可能留下未引用objects或可核查scratch，不自动GC或reset；SIGKILL／宿主崩溃的残留锁没有自动解锁。写前后核对不等于所有非协作writer下的内核CAS，也不保证HEAD＋index跨文件原子性。
- **UI**：`FileTree.indexActionsOnly`只开单行stage/unstage；即使误传其他callbacks，也不出现discard/delete/目录动作，保留local默认行为。刷新与写操作互斥，成功只读刷新；失败/未知不自动刷新或重试写。正文说明stage选取动作开始时最新整文件内容，不是「提交旧diff」；commit 随后在 G2b 开放（§5.9），bulk stage、合并解决、discard、历史、refs与同步仍未开放。所有新增说明与稳定错误中英同步。
- **针对性验证**：最终29文件 **246/246、5 suites、0 fail/cancel/skip**；typecheck、触达Biome/diff、e2e `--list`、main/preload与production renderer构建通过。新增真实helper测试覆盖精确范围/unborn/rename/deletion/intent、UTF-8/CRLF与原生autocrlf、FIFO/符号链接、现有锁保留、全局hooksPath/有效hooks/签名/merge/split/skip拒绝，以及write期间外部index／HEAD／hook／worktree／attributes变更。真实子进程timeout/cancel/EOF回收且真实index不被发布；token owner/TTL/128上限、跨host revision、一次性消费及UI未知结果／迟到结果不重放均有回归。G1生产fixture原样抽到共享测试helper，未删行为断言。
- **真实产品验收**：G2a首轮 **1 passed（1.7m）**；加入stage后真实diff正文断言，再与G1双仓只读专项最终复验 **2 passed（3.5m）**。普通仓stage→HEAD/index diff→unstage、untracked往返、rename双路径取消、外部index变化拒绝且外部index SHA不变、hooks/signing/已有锁拒绝并保留锁内容、unborn stage/unstage保留另一条暂存blob；独立原生Git/index/blob事实匹配UI，不依赖模型或直接IPC。HEAD不动，工作区SHA与mode/size/inode/mtime/ctime前后一致，本机对照index/文件不变；只操作本次唯一夹具，两项均`CLEANUP_OK`。
- **证据**：`/tmp/remote-git-g2a-regression-final.log`、`/tmp/remote-git-g2a-typecheck-final.log`、`/tmp/remote-git-g2a-build-main.log`、`/tmp/remote-git-g2a-build-renderer.log`、`/tmp/remote-git-g2a-ui-final.log`、`/tmp/remote-git-g2a-ui-final-artifacts/`（独立oracle附件）。红例`write-red`／`ipc-red`／`view-red`保留；中期测试曾发现外部损坏index先被Git读到导致错误归类、以及helper重复builtin／source size不符，修代码与去重复注释，不降低门禁。UI两轮均通过；DSH既存报错不被本轮修复。`/tmp`非长期保留。
- **仍未完成**：commit完整index确认＋expected HEAD并发门禁，Windows/macOS客户端、断网后的多实例长稳、打包/dev集成、独立安全审查、G3–G5。权限/owner异常、不可回收native进程／OS崩溃、所有非协作并发场景没有全部经过真实UI，不以子进程回归冒充真机证据。后续优先跨平台/稳定性验证；若当前环境没有对应平台，不假装通过，也不借此绕过commit门禁。

### 5.6 G6a 稳定性切片：未知结果提示与生产链故障回归

- **最小产品修复**：`remoteGitViewState.ts` 原先第一次断线设为 `GIT_WRITE_RESULT_UNCONFIRMED`，后续连接失败事件会覆盖成普通断线；手动刷新失败也会丢掉警告。两个独立红例先复现，再改为跨连续状态、刷新中及刷新失败均保留未知提示，只有成功读回仓库事实才清除；旧代迟到成功仍不能刷新、没有自动重放。未改 IPC／helper 协议、写能力、trust、预算或工程门禁；helper 仍为 1.8.0 与原冻结 hash。
- **生产链故障注入**：新增 `tests/remoteGitStability.test.mjs`，调用生产 renderer controller、注册 IPC／service、主机操作锁、`RemoteControlClient`，经真实 NDJSON 连接本机 helper 子进程并运行原生 Git；Electron sender 和 `withProjectSession` 外层是替身，不是实际 SSH 或两个 Electron 窗口。确认 index 已发布后丢弃成功回执、切 generation：真实 staged blob 存在，迟到帧被拒，三次连接失效及离线刷新仍保留未知提示，明确重连＋刷新才恢复，写请求始终只有一次。两个不同 sender 从同一 revision 并发写，首个成功、第二个 stale 拒绝且不能覆盖；排队请求被取消时零 Git 写，另一 sender 的 grant 仍有效。
- **短周期资源与路径**：同一链路完成 24 轮 stage→diff→unstage（48 次 index 写），每轮 helper FD 数等于初始值、sender destroyed listener 保持 1、client pending 为 0、host lock 释放、owned scratch／index.lock 无残留。独立原生 Git 核对 HEAD／其他 index blob 和工作区内容、inode/mode/size/mtime/ctime 不变。夹具根和目标文件均含中文、空格、单引号，正文保留 CRLF。测试耗时约 6 秒，**不是小时级长稳、内存/RSS 或跨进程多实例验收**。
- **平台证据修正**：既有 `sshHostPinStorePlatform.test.mjs` 在 Linux 直接要求本机存在 Windows System32 OpenSSH，实跑失败 `SSH_CLIENT_MISSING`；对应源码与测试在 HEAD 均无改动，属旧测试环境耦合。改用明确的 Windows `path.win32`／fs 替身，保留 SSH/SCP 路径与打开关闭校验，并新增 SCP 缺失时拒绝且不回退 PATH 的反例。产品 `SshClientRuntime.ts` 不改；模拟通过不等于 Windows executable 可运行，更不是 Windows/macOS 真机通过。
- **最终验证**：39 个针对性测试文件，共 **423 项：418 passed、5 skipped、0 fail/cancel，5 suites**，约 19.1 秒；跳过的四项需原生 Windows，第五项为未开启的约 155 秒进程生存探针。typecheck、触达 Biome／diff 与仅触达 production renderer 构建通过。真实 Linux Electron＋SSH 复跑已有 G1/G2a **2 passed（2.7m）**，两项 `CLEANUP_OK`；独立 Git/blob/index/工作区 oracle 保持，不启动 Agent／依赖模型。真机回归没有注入已发布回执丢失，不能混称该故障已在真实网络复现。
- **证据与复现**：永久测试为 `tests/remoteGitStability.test.mjs`、`tests/remoteGitMutationView.test.mjs`、`tests/sshHostPinStorePlatform.test.mjs`；最窄重跑 `timeout 90 node --test --test-concurrency=4 tests/remoteGitStability.test.mjs tests/remoteGitMutationView.test.mjs tests/sshHostPinStorePlatform.test.mjs`。红例 `/tmp/remote-git-g6a-warning-red.log`、`/tmp/remote-git-g6a-refresh-red.log`；旧平台失败 `/tmp/remote-git-g6a-platform-transport.log`；最终 `/tmp/remote-git-g6a-regression-final.log`、`/tmp/remote-git-g6a-typecheck-final.log`、`/tmp/remote-git-g6a-build-renderer.log`、`/tmp/remote-git-g6a-ui-final.log`、`/tmp/remote-git-g6a-ui-final-artifacts/`。`/tmp` 不承诺长期保留。
- **未完成门禁**：Windows/macOS 客户端及打包资源／dev 集成，真实双窗口／双应用实例、网络黑洞与延迟、长时内存／进程回收、独立安全审查仍需分别给证据；不因本切片完成将整个 G6 标绿。commit 完整 index 确认与 expected HEAD 门禁保持禁用，后续不能借稳定性绿灯绕过。

### 5.7 G6b：真实 Electron＋SSH 的有界 1 小时验收（2026-10-15）

- **范围与实现**：仅新增测试，不修改生产逻辑、IPC、helper、Git 能力或实验门禁。`e2e/remote-git-soak.ts` 复用原 spec 的真实 pin／连接／登记／草稿 UI；`remote-soak-evidence.ts` 用独立原生 Git、文件 metadata 与 Linux `/proc` 采样；`remote-soak-policy.ts` 固定时长和预算。没有模型调用、假的 IPC 成功响应或主机网络配置修改。两个本次唯一根仓库，其中一个目录含中文／空格；不扩展既有 trust 对单引号根路径的拒绝。
- **可复现入口**：预先设置既有三个 `PIDECK_E2E_REMOTE_*` 凭据变量，再运行 `PIDECK_E2E_REMOTE_GIT_SOAK=hour timeout 4500 ./node_modules/.bin/playwright test e2e/remoteSessionAcceptance.spec.ts --grep '远端 Git G6b' --trace off`。`smoke` 是独立 180,000ms 模式，不能累加或重标成 hour；未设置模式或非 Linux 时在 fixture 启动前 skip，非法模式直接失败。长测试关闭 action trace 以免观测开销污染资源测量，保留逐轮 JSONL、失败前截图／面板文本和主进程日志。
- **事先固定的判据**：预热后主计时必须 ≥3,600,000ms；30s 一轮刷新→stage→真实 index diff 两侧正文→unstage，每五轮关开抽屉并明确点 Git，每五分钟切项目。主进程／renderer PID＋start ticks 不得替换；FD 不超过各自预热值＋16，主进程／renderer RSS 分别不超过＋64／128MiB，JS heap 分别不超过＋32／64MiB；本地后代不超过＋2，稳定采样时恰好一个匹配私有 pin/root 的 SSH 与一个匹配 helper hash 的项目 helper；SSH/helper FD 不超过＋4，helper RSS 不超过＋32MiB。每轮独立 Git 的 HEAD、所有 index stage entries、工作区 SHA／inode/mode/size/mtime/ctime 与基线一致，无 index.lock 或 owned scratch；本机对照仓库未变。预算没有根据结果提高。
- **真实结果**：独立 smoke 第三次通过，180,006ms、6轮／8样本；最终 hour 第二次 **1 passed（1.0h）**，主计时 **3,600,017ms、120轮／240次正常 index 写、122样本**（另有预热及一次受控中断写尝试）。每五分钟按项目 scope 正常轮换，记录12个 helper 身份；同一个 helper 最长连续观测 **293,146ms**，不是声称同一 PID 连续运行一小时。已有 `PIDECK_SSH_DEADLINE_REALTIME=1 timeout 220 node --test tests/sshLongLivedSessionDeadline.test.mjs` **7/7**，真实子进程约150s仍活且配对 stop 回收；该探针是本机生产 launcher 的真实 Node 子进程，不冒称 SSH。
- **真实连接中断／退出**：信号只发送给本测试 Electron 后代中、私有 known_hosts 路径／项目 root／SSH executable／PID start ticks 均匹配的一个客户端，发送前立即重查。stage 点击后中断本次 SSH，实际显示“结果未确认”；显式断开收敛后冻结 index SHA＋inode/size/mode/mtime/ctime，明确重连不恢复旧 SCM、不改写 index，手动刷新才重新读。smoke 与最终 hour 的该次写均未发布；**不是“已发布但回执丢失”真机证据**（那仍只有 G6a 注入）。退出后独立检查无本次项目存活 helper 或已观察到的本地存活后代，随后唯一夹具 `CLEANUP_OK` 并断言目录不存在；不保证任意 daemon/disown 的清理。
- **资源实测（MiB 约值）**：main FD **240→253，峰值253**；renderer FD 55→52；SSH FD 恒7，helper FD恒21；本地后代5→4、最大5。main RSS **495.7→547.1，峰值550.4**；renderer RSS328.9→300.1、峰值328.9；helper RSS峰值71.1（跨正常轮换 PID，不能当同一进程的增长）；main JS heap14.8→12.7、峰值15.1，renderer JS heap61.0→48.1。**该“未定位增量”的读法已被 §5.8 更正**：它是首 2.5 分钟的一次性暖机阶跃（落在首次抽屉关闭→重开），此后 55 分钟平坦，不是持续增长；但仍不等于已证明无泄漏。
- **保留失败与边界**：smoke1 卡在含单引号根的明确 trust 拒绝，未放宽安全门，而是使用已有支持的中文／空格根；smoke2 证明标题栏重开默认 Files，改走真实 Git rail，不强制点击。hour1 在46轮后独立 SSH/Git oracle 命令失败，保留47样本与截图，随后 fail-fast 并清理；原记录缺 code/signal/stdout/stderr，**不能区分 SSH 超时与残留检测，根因未定**（§5.8 复现出同类空 stderr 失败并拿到 `killed:true, signal:SIGTERM`，即 harness 自身 20s 预算杀 ssh；hour1 本身仍不可追认）。DSH 既有 credentials/version 错误未修。
- **检查与证据**：5个针对性文件 **28/28**，typecheck、触达 Biome／diff、spec `--list` 通过；新增三个 e2e helper 独立 strict 检查无自身诊断，依赖的未修改 `remote-fixtures.ts:141` 仍有既存 `ProcessEnv` 类型错误。仅改测试，无全仓库构建，沿用上一轮已验证的 main/renderer 产物。所有权反例覆盖非后代、他人 pin/root、PID复用、非 SSH executable、权限错误不伪造零值；策略反例覆盖资源增长、renderer替换和短进程不可累加为长期存活。
- **证据路径**：`/tmp/remote-git-g6b-session-deadline.log`、`/tmp/remote-git-g6b-regression-delivery.log`、`/tmp/remote-git-g6b-typecheck.log`、`/tmp/remote-git-g6b-e2e-strict-final.log`；`/tmp/remote-git-g6b-smoke1…smoke3.log` 及对应 artifacts；`/tmp/remote-git-g6b-hour1.log`／`/tmp/remote-git-g6b-hour1-artifacts/` 保留失败，`/tmp/remote-git-g6b-hour2.log`／`/tmp/remote-git-g6b-hour2-artifacts/` 保留最终报告、122样本与派生 `metrics-summary.json`。永久重跑入口在仓库，`/tmp` 不承诺长期保存。Windows/macOS、真实双窗口／双实例、网络黑洞／高延迟、打包/dev集成、独立安全审查与 commit 门禁仍未完成；本轮不是完整 G6／Remote v1 发布收口。

### 5.8 G6c：暖机阶跃归因、steady-state 门禁与 harness 传输预算（2026-10-16）

- **首个失败定因**：G6b smoke1（补诊断之后）在远程采样命令上失败，记录 `code:null, signal:SIGTERM, killed:true`、stdout/stderr 空——即 harness 自己的 20s `execFile` 预算杀掉 ssh，**不是仓库残留**。hour1 在同一位置更早发生（补诊断之前），消息形状相同（`Command failed: ssh …` + 空 stderr）但缺 code/signal，只能按“同类 harness 侧超时的可能”保留，**不追认为已修复**。
- **为何会超时**：验收主机是共用机器（80 vCPU／128 GiB，`load average 1.90 3.54 6.46`，10 个用户在线）。本机受限探测各 20 次：oracle 形状命令中位 0.40s／p90 0.45s／最大 0.71s，`uptime` 中位 0.38s／最大 0.59s，20/20 成功——典型很快，但 OpenSSH 偶尔被接受却未及时服务，20s 预算过低。
- **修复（仅测试）**：harness 探针统一有界 60s 预算，预算自身结束命令时抛 `SOAK_PROBE_TRANSPORT_TIMEOUT(<label>)`，>5s 的探针打印 `slow-probe=`。断言一条未改，产品代码零改动；超时仍然失败，只是不再把环境超时冒充残留结论。
- **阶跃归因（结论与初稿不同，已修正）**：初稿把阶跃记在“首次抽屉关闭→重开”上，因为当次只采到抽屉前后两个点。加上 `pre-drawer`（点关闭之前）与完整 FD 清单后，归因变了：hour-final 的最大跳变落在 `unstage`(93.8s) → 下一轮 cycle-end(94.9s) 的 oracle 窗口；smoke4 落在 `pre-drawer` 之前（抽屉动作本身 271→271 FD、550→551 MiB，**零变化**）；smoke5 落在 stage(91.8s) → diff(121.0s)。四次运行相邻动作各不相同而时间一致（soak 后 92–125s），故是**时间相关、与 soak 动作无关**的一次性分配。
smoke5 用完整清单（116→124 个 kind、列合计从 263→271 与真实 FD 总数相等）直接看到这 +8 FD 是八个 `/tmp/.org.chromium.Chromium.<随机> (deleted)` 共享内存段：没有一个 pipe／socket／inotify／仓库文件，也无应用层句柄。主进程 JS heap 在该步不变（~13 MiB），RSS +~55 MiB 全在 Chromium 自身共享内存上。应用日志里同一时间窗只有 `announcement refreshed`（+2.39min）这一类后台活动；**只到“Chromium 浏览器进程懒分配、时间上约在应用运行 2.5–3 分钟”为止，未归因到具体产品代码路径**。
- **仍未证伪的风险**：该阶跃一次性出现且此后不再增长——hour-final 用 steady 门禁实测后 55 分钟 `steadyDelta={mainFd:0, mainRssMiB:-2, rendererFd:-3, rendererRssMiB:+7, mainHeapMiB:-0.2, descendants:0}`。但“未归因”仍是缺口：无法排除某个尚未触发的路径会累积，也不能把“Chromium 共享内存”当成已证实结论。
- **steady-state 门禁（新）**：除“相对起点的绝对预算”外，长跑再用 **settled 基线（≥300s）** 判定平台期：main/renderer FD +4、main RSS +32 MiB、renderer RSS +48 MiB、main heap +24 MiB、renderer heap +48 MiB、后代 +1、SSH FD ≤16、helper FD ≤32。每个样本都判，首个越界样本即失败（fail-fast）。预算取 hour2 实测噪声的数倍、约为“每轮泄漏 1 FD 或 1 MiB”一小时量的 1/20，故持续泄漏无法藏在暖机余量里；smoke 窗口不足不套用。测试同时守住“暖机阶跃不算泄漏”与“绝对预算看不出的慢泄漏必须被抓住”，并对 HEAD 反证（HEAD 策略模块与 harness 均无该门禁，导出计数 0）。
- **自己的旧夹具**：主机上残留 `~/.pideck-e2e-e2emv7goca4`（10-14 旧 run，无 `.git`、无锁／scratch）。按精确 runId 形状＋仅本套件四个 fixture 文件＋无特殊条目做归属校验后删除，验证输出 `OLD_FIXTURE_CLEANED`；不是用通配符清理。
- **检查**：`tests/remoteSoakOwnership.test.mjs`＋`tests/remoteGitSoakPolicy.test.mjs` 共 **13/13**，e2e helper strict 自诊断 0，fd 种类清单在真实 `/proc` 上做冒烟断言（Chromium shm 必须折叠为单桶）。
- **证据**：`/tmp/remote-git-g6c-smoke1.log`（harness 超时失败，含 `killed/SIGTERM`）、`/tmp/remote-git-g6c-smoke2.log`、`/tmp/remote-git-g6c-smoke3.log`（含 fdKinds 归因）、`/tmp/remote-git-g6c-policy.log`、`/tmp/remote-git-g6c-steady-red.log`（HEAD 无门禁反证）、`/tmp/g6c-transport-probe.sh` 与其输出、`/tmp/remote-git-g6c-unit*.log`。仍需 Windows/macOS、真实双窗口／双实例、网络黑洞／高延迟、打包/dev 集成、独立安全审查与 commit 门禁；本轮不是完整 G6／Remote v1 收口。

- **带 steady 门禁的最终 hour 验收**：`hour` 模式完整跑通 **1 passed（1.0h）**：主计时 3,600,017ms、120 轮（240 次正常 index 写）、163 样本（前 8 轮逐步骤另计）、`settledAtMs=306,213`，12 个 helper／12 个 SSH 身份，同身份最长 293,832ms；中断写实际出现“结果未确认”，显式重连不改写 index（该次写最终未发布），退出后无存活本次 helper 或已观察后代，夹具 `CLEANUP_OK`。`warmupDelta={mainFd:+11, mainRssMiB:+54, rendererRssMiB:-33, descendants:-1}`，`steadyDelta` 见上；预设预算一条未放宽。

### 5.9 G2b commit 的 Implementation Plan（待确认后实施）

> 状态：**仅计划，未写代码**。commit 属公共契约与安全语义变化，按项目纪律需先确认。下列机制的事实依据来自本机一次性原生 Git 实验（`/tmp/g6b-commit-probe.sh` → `/tmp/remote-git-g2b-write-shape-probe.log`）：`write-tree` 可用私有 `GIT_INDEX_FILE`；`commit-tree` 逐字保存 stdin 消息（`#` 行不被剥离）、不运行 hook（可执行且失败的 `pre-commit` 未执行、无 marker）、不签名（`commit.gpgSign=true` 时 `gpgsig` 仍为 0）；`update-ref <ref> <new> <old>` 是真 CAS（stale 时 rc=128、`is at … but expected …`，HEAD 不变）；unborn 可用零 OID 断言“尚不存在”；真冲突索引 `write-tree` 拒绝（`c.txt: unmerged`，rc=128）。临时仓已删除，**这些不是产品验收**。

**范围**：单次普通提交，只提交用户已确认的暂存区。不做 amend、merge／rebase 提交、cherry-pick、冲突解决、`--allow-empty`、`-a`／pathspec 暂存、签名、hook 执行支持、模型生成提交信息、push／fetch。

**机制（全原生 Git，主机锁内 + 官方 `.git/index.lock` 排他）**
1. 入参 `{message, expectedRevision}`；先按 G2a 同一判据复核 revision（root／gitdir 身份 + index metadata+SHA + HEAD + branch + 完整 porcelain），并要求 index 全为 stage 0、无进行中操作（MERGE_HEAD／CHERRY_PICK_HEAD／REVERT_HEAD／rebase-*／sequencer／BISECT_*）。
2. 把已验证 index 拷入本次 scratch，用私有 `GIT_INDEX_FILE` 跑 `git write-tree` 得 `tree`（对象进真实 object store）。
3. `git commit-tree <tree> [-p <expectedHead>]`，消息走 **stdin 逐字**（不剥注释，与 `git commit` 默认行为不同）；身份取冻结配置，缺失时**只读**探测全局配置，绝不写任何 Git 配置。unborn 时省略 `-p`。
4. `git update-ref <fullRef> <newCommit> <expectedHead>`：真 CAS，只有 ref 仍等于用户确认值才成功；stale 报稳定码 `GIT_COMMIT_HEAD_CHANGED`（不产生提交）。unborn 用 40 个零。
5. ref 移动成功后才把提交后的 index 发布到真实 `.git/index`（沿用 G2a 的 owner／mode／fsync／rename 纪律），再回读 HEAD 与 index，返回 `{applied:true, head, tree}`。

**拒绝面（都在写之前）**：树与 HEAD 树相同 ⇒ `GIT_COMMIT_NOTHING_STAGED`（实验证明可检测）；空／全空白／NUL／超限／非法 UTF-8 消息 ⇒ `GIT_COMMIT_MESSAGE_EMPTY`／`GIT_RESULT_INVALID`；缺身份 ⇒ `GIT_COMMIT_IDENTITY_REQUIRED`；有效 hooks（含 `hooksPath`）、clean／process filter、签名要求、进行中操作、非 stage-0 index ⇒ `GIT_WRITE_UNSUPPORTED`（**因为 commit-tree 不执行 hook，有 hook 时必须拒绝，绝不“静默跳过”**）；锁已存在 ⇒ `GIT_INDEX_LOCKED`；revision 不符 ⇒ `GIT_RESOURCE_CHANGED`。

**结果语义**：ref 已移动但 index 发布失败，或回复在移动后丢失 ⇒ `GIT_WRITE_RESULT_UNCONFIRMED`：提交已存在，不回滚、不重试、不 reset；UI 保留“结果未确认、请手动核对”直到显式刷新。写之前的失败不发布任何东西，保有 G2a 的清理纪律（不删别人的锁、不可回收 artifact 保留）。

**已知不可保证（写入文档，不藏）**：ref CAS 与 index 发布是两步、不是同一事务；持官方 index 锁可挡住协作 writer，但非协作 writer（如终端里 `git reset --soft`）可在窗口内移动 HEAD——此时 CAS 直接拒绝且我们不产生提交；反过来，发布失败会产生“提交已在、index 未更新”的状态，只能如实报未确认。worktree 文件永不被触碰。

**契约与落点**：helper 1.9.0 新增 `git.commit`（`params {message, expectedRevision}`、`result {applied:true, head, tree}`，消息 ≤4096 字节 UTF-8 且无 NUL）；新稳定码 `GIT_COMMIT_NOTHING_STAGED`／`GIT_COMMIT_MESSAGE_EMPTY`／`GIT_COMMIT_IDENTITY_REQUIRED`／`GIT_COMMIT_HEAD_CHANGED`。main：`RemoteGitService.commit(...)` 在同一锁／locator／hostRevision／trust 复核下执行；`RemoteGitMutationTokens` 增 `commit` 期望（消息随请求传输、不进 token）；新通道 `git:remote-commit`（renderer 只发 projectId + message + opaque token，无 authority 字段）。`git.status` 增诚实发现字段 `commit: {ready, reason?}`（同一已核验 pass 内算出，例如存在有效 hook 时给 `GIT_WRITE_UNSUPPORTED`），按钮禁用不需要先失败一次。UI：`RemoteGitPanel` 加有界消息框 + 提交按钮，仅在有效 token 且 `commit.ready` 时可用，文案明确“只提交已确认暂存区、不自动暂存、不支持 amend／push、消息逐字发送、未知结果不自动重试”；中英同步。

**验证计划（先红后绿）**：helper 真实子进程 + 原生 Git —— 正常提交（HEAD 移到新提交、父 = 原 HEAD、`ls-tree` 等于暂存内容）、unborn 根提交、nothing-staged、空／全空白／纯注释／NUL／超限／非法 UTF-8 消息、缺身份、hooks（pre-commit／commit-msg／hooksPath）**零执行且拒绝**、签名配置拒绝、进行中操作拒绝、锁存在、revision 不符（外部改 index → 零提交）、stale HEAD（窗口内外部移 ref → CAS 拒绝且零提交）、cancel／timeout 真进程回收与不发布、提交后 index 不变量（status 干净、旧 revision 再提交被拒）；回复丢失用 G6a 同款进程内注入，断言 unknown + 不重放 + 外部核对 HEAD。main／IPC／token 负例（无 authority 字段、malformed 不烧 token、越项目／错 token、迟到结果丢弃）；view／UI（unknown 跨重连保留、按钮禁用态、无自动重放、i18n key 对齐）。真实 Electron＋SSH：stage → 提交 UTF-8 消息 → 独立原生 Git oracle 核对 HEAD 移动／父链／树与内容／reflog／工作区 SHA 与 mode/size/inode/mtime/ctime 不变／index 干净／无 scratch 与锁残留；拒绝用例 HEAD 不变；只用本次专用夹具。回归子集 + typecheck + biome + 触达构建；helper hash／体积／契约测试同步。

**体积上限**：当前 inline source 64,257 字符，距 64 KiB 审阅阈值仅剩 **1,279 字符**，commit 路径塞不进去。建议把**审阅阈值**提到 80 KiB，同时继续强制真正约束审阅面的不变量（单行、可打印 ASCII、只用四个 builtin、SHA-256 钉在代码与测试、每个 method 的契约测试）。若坚持 64 KiB，替代路径是把 read／write 程序拆成两个嵌入文件——更大的重构，会动 G1／G2a 的 helper 形状。

**需确认的 5 点**：① 机制用 `write-tree`＋`commit-tree`＋`update-ref` CAS（而不是 `git commit`，后者给不出 expected-HEAD CAS）；② 消息逐字发送、不剥 `#` 注释；③ 身份仓库本地优先、缺失时只读探测全局，绝不写配置；④ ref 移动成功后再发布 index，发布失败报未确认、不回滚；⑤ 审阅阈值 64 KiB → 80 KiB。

### 5.9.1 G2b 实施结果（2026-10-16，Linux 开发态）

- **交付**：helper **1.9.0**，冻结 SHA-256 `9ed9ccc5837bf92c476a74967205f310b1ce92bb30a95e0a43fb034ca2159145`，正文 75,262 字符、单行可打印 ASCII、仍只用四个 builtin。新增可协商 `git.commit`：`params {message, expectedRevision}`、`result {applied, head, tree}`。审阅阈值按计划从 64 KiB 提到 **80 KiB**（唯一改动是阈值数字；单行／ASCII／四 builtin／双处 hash 钉住／每 method 契约测试这些真正约束审阅面的不变量全部保留，理由写在该测试的注释里）。
- **机制**：官方 `.git/index.lock` 排他 → 私有 scratch 复制已验证 index → `git write-tree` → `git commit-tree <tree> [-p <expectedHead>]`（消息经 `-F <scratch>/message` **逐字**送入；实测不执行 hook、不签名）→ 自检父链（必须是确认 HEAD 的唯一子提交）→ `git update-ref -m "commit: <首行>" <ref> <new> <old>` **原生 CAS**（unborn 用零 OID，detached 直接更新 `HEAD`）→ 回读 HEAD 后才返回。**不发布任何 index 字节**：用户确认的 index 本来就描述即将成为 HEAD 的 tree，真机与 helper 测试都断言真实 `.git/index` 的 SHA+inode+mtimeNs 未变。
- **门禁与稳定码**：有效 hooks／`hooksPath`／clean/process filter／签名要求／进行中操作（merge、cherry-pick、revert、rebase、sequencer、bisect）／非 stage-0 index ⇒ `GIT_WRITE_UNSUPPORTED`（实现里 `commit-tree` 不跑 hook，所以有 hook 时必须拒绝，绝不静默跳过）；另有 `GIT_COMMIT_NOTHING_STAGED`、`GIT_COMMIT_MESSAGE_EMPTY`、`GIT_COMMIT_IDENTITY_REQUIRED`、`GIT_COMMIT_HEAD_CHANGED`、`GIT_INDEX_LOCKED`、`GIT_RESOURCE_CHANGED`。身份只读仓库配置链（本地优先、全局兜底），永不写 Git 配置。
- **结果语义**：ref 已移动但回读失败或回复丢失 ⇒ `GIT_WRITE_RESULT_UNCONFIRMED`，不回滚、不重试、不 reset；CAS 拒绝时不产生提交（`commit-tree` 可能已写入的对象会变成未引用对象，不自动 GC）。`update-ref` 因锁失败而 HEAD 未变时按 `GIT_WRITE_UNSUPPORTED` 如实回报，不冒充“HEAD 变了”。
- **授权模型**：`RemoteGitWriteExpectation` 增 `kind: "index" | "commit"`，token 按 kind 绑定——同一 sender+project 的两种 grant 可同时存在，刷新只替换同类，跨类使用报 `GIT_RESULT_INVALID` 且不烧 token；`status` 新增 `commitToken`（renderer 仍只见 opaque token）。
- **验证**：helper 级真实子进程 + 原生 Git **13/13**（正常提交的父链/tree/消息逐字含 `#` 行/reflog/真实 index 未变/无残留；unborn 根提交；nothing-staged；消息与参数边界；身份三态；hooks＋`hooksPath`＋签名拒绝且零执行；in-progress；外部 index lock 保留且可重试；stale revision；外部移 HEAD；ref 锁；timeout 零副作用）。Git 面回归 **269/269**、typecheck、Biome、e2e strict 自诊断 0。真实 Electron＋SSH：G1＋G2a/G2b **2 passed（2.7m）**、两项 `CLEANUP_OK`，真机核对 HEAD 移动／父提交／`%B` 逐字（含 `#` 行与西里尔文）／reflog／`diff-index` 与 HEAD 一致／无锁与 scratch，并在 nothing-staged、hook（零执行）、签名三类拒绝后断言 HEAD 不变、其余文件 metadata 与 tracked.txt 内容/身份 witness 一致。
- **偏离计划之处**：计划里的 `commit.ready` 发现字段**没有实现**——状态读取不再多跑一遍门禁扫描（与 stage/unstage 相同的既有模型：能力＋grant 决定控件可用，门禁拒绝在尝试后如实报码）；界面因此可能出现“按钮可用但点击被拒绝”，文案与 stage 一致。未支持 amend／merge／rebase／cherry-pick／`--allow-empty`／`-a`／签名／模型生成提交信息／push/fetch。Windows/macOS、多窗口与长稳、打包/dev 集成、独立安全审查仍未验收——本批**不是** Remote v1 收口。
- **证据**：`/tmp/remote-git-g2b-ui-final-artifacts/`（真机 G1＋G2a/G2b 的 trace/oracle 附件）、`/tmp/g2b-ui-final4.log`（2 passed）、`/tmp/g2b-regression-final.log`（269 项）、`/tmp/g2b-typecheck-final.log`；实现期红例与中间失败：`/tmp/g2b-commit-red.log`（METHOD_NOT_FOUND→能力未接线）、`/tmp/g2b-commit-4.log`（稳定码被折叠成 IO_ERROR）、`/tmp/g2b-commit-5.log`（scratch 未清理）、`/tmp/g2b-ui-final{,1,2,3}.log`（抽屉已开、工作区 witness 与自身改写冲突）。`/tmp` 不承诺长期保留。

### 5.10 G3a（远端只读历史／引用）冻结契约与分工（2026-10-16）

> 状态：**已完成实施并真机验收（2026-10-16，结果见 §5.11）**。契约与分工仍如本文冻结；子智能体派发因基础设施失败（缺 `@earendil-works/chord`、同步 worker stream 中断），实际由主代理按车道边界顺序实施，独立复核车道未执行（见 §5.11 偏离）。

- **范围**：只读历史页（分页 log）、单提交详情（消息＋变更文件列表）、本地分支与 tag 列表、两个版本之间单文件两侧内容。**不做**：checkout／建分支／tag 写、refs watch 或轮询、compare／ahead-behind、fetch／push、读 remote-tracking ref、生成模型提交信息。
- **helper 方法（能力名即协议名）**
  - `git.log` `{maxCount?, skip?}` → `{commits: [{oid, parents(≤8), authorName, authorEmail, authorTimeSec, subject}], hasMore}`；`maxCount` 1..100（缺省 50）、`skip` 0..100000；重复固定 argv，多取一条只为算 `hasMore`。
  - `git.commitDetail` `{oid}` → `{oid, parents, authorName, authorEmail, authorTimeSec, committerName, committerEmail, committerTimeSec, subject, message, files: [{status, path, oldPath?}]}`；`message` ≤ 64 KiB 且必须是有效 UTF-8（超限或非法编码拒绝，不截断）；`files` ≤ 512（超限拒绝）；根提交用 `--root` 列出全部文件。
  - `git.refs` `{}` → `{head, branch, refs: [{fullName, name, oid, kind}]}`；只含 `refs/heads/*`（kind=`branch`）与 `refs/tags/*`（kind=`tag`），≤ 512 条，名字 ≤ 1024 字节，输出按 `for-each-ref` 的稳定顺序。
  - `git.refFileDiff` `{base: oid|null, head: oid, path}` → `{originalContent, modifiedContent}`；两侧各 ≤ 256 KiB 文本，NUL／二进制／非法 UTF-8 拒绝（复用 `GIT_NOT_TEXT`）；`base: null` 表示该侧不存在；两侧都不存在 ⇒ `GIT_RESOURCE_CHANGED`；oid 必须是 40/64 hex，形状合法但对象不存在 ⇒ `GIT_OBJECT_NOT_FOUND`。
- **只读不变量**：新方法不得写 index／refs／工作区／对象库，不执行 hooks／filters／external diff／textconv，不开 pager，不访问网络（无 fetch／ls-remote），不读 remote-tracking ref，路径仍经 `relative()` 校验。所有列表与正文超限一律完整拒绝。
- **UI 语义**：历史与引用都是**手动刷新**（沿用 G1：不轮询、不隐式连接）；每页 50 条、显式“加载更多”才取下一页；提交详情与文件差异按需读取；checkout／建分支／tag／推送按钮**不出现**，并用一句文案明确未开放。
- **分工（文件名冻结）**：车道 A＝helper（`RemoteGitReadSource.ts`、`RemoteHelperEntry.ts` 版本/能力/hash、helper 测试）；车道 B＝main（`RemoteGitService.ts`、`remoteGitReadIpc.ts`、`preload/index.ts`、`previewApi.ts`、service／IPC 测试）；车道 C＝renderer（`RemoteGitPanel.tsx`、`useRemoteGitView.ts`、`remoteGitViewState.ts`、i18n、view 测试）；车道 D＝e2e 真机与独立 oracle；车道 E＝独立复核。各车道只动自己的文件，不提交不推送。
- **验证计划**：helper 真实子进程＋原生 Git（分页与 `hasMore`、根提交、rename 文件列表、非 UTF-8 消息与文件拒绝、对象不存在、ref 与 head/branch 一致、`base: null`、两侧皆不存在、超限、无写入与无残留）；main／IPC 负例（越界 `maxCount`／`skip`、非法 oid、跨项目、额外 authority 字段不烧 token）；renderer（分页与错误态、无轮询、无写入口）；真机 e2e 用独立原生 Git oracle 对照 log／refs／detail／diff，并断言 index／worktree／HEAD／refs 全部不变。
- **UI 契约（冻结，车道 C 实现、车道 D 验收）**：`RemoteGitPanel` 新增两个可折叠只读区：历史（testid `remote-git-history`，行 `remote-git-history-row`，下一页按钮 `remote-git-history-more`，详情区 `remote-git-commit-detail`，文件行 `remote-git-commit-file`）与引用（`remote-git-refs`／`remote-git-ref-row`）；两个版本之间的单文件差异渲染到现有 `remote-git-diff`（复用 `FileDiffViewer`）。按钮文案固定为「加载更多」「提交历史」「引用」（i18n key `remoteGit.historyMore`／`remoteGit.historyTitle`／`remoteGit.refsTitle`），未开放说明用 `remoteGit.historyReadOnly`（中英同步）；提交行显示短 oid + subject + 作者与相对时间，引用行显示 kind + 短名。**无 polling、无 checkout／建分支／tag／推送控件**。

### 5.11 G3a 实施结果（2026-10-16，Linux 开发态）

- **交付**：helper **1.10.0**，冻结 SHA-256 `f04c1c8773883d33b9c516cf175dafe39e80e242c768c1cdc309be521ae603de`，正文 85,625 字符、单行可打印 ASCII、仍只用四个 builtin。新增四个可协商只读方法：`git.log`（`%x1e/%x1f` 定界、固定 argv、多取一条算 `hasMore`）、`git.commitDetail`（`cat-file commit` 逐字消息＋`diff-tree -z --name-status --find-renames --root` 文件列表）、`git.refs`（`for-each-ref` 仅 heads/tags、annotated tag 用 `%(*objectname)` peeled 提交）、`git.refFileDiff`（两侧 `show --no-ext-diff --no-textconv`，缺失侧为空）。审阅阈值 80 KiB → **96 KiB（最后一次提高，规则写在测试注释：下一个放不下的特性必须拆分内嵌程序或放弃单文件）**。
- **main／preload**：`RemoteGitService` 四读方法（选项边界校验＋逐字段重验 helper 回复：页长≤100、oid 形状、身份≤320B、subject≤1024B、message≤64KiB 有效 UTF-8、files≤512、refs≤512 且拒绝 remote-tracking 混入、内容≤256KiB 无 NUL）＋`remoteGitReadIpc` 四通道（与 status 同一 sender／项目／并发压力边界，无 token）＋preload `remoteLog/remoteCommitDetail/remoteRefs/remoteRefFileDiff`＋previewApi 四 stub。稳定码新增 `GIT_OBJECT_NOT_FOUND`（service 与 helper 两侧 allowlist 同步）。修复契约缺陷：G3a 详情消息上限与 G2b 提交输入上限曾撞名 `REMOTE_GIT_COMMIT_MESSAGE_MAX_BYTES`（tsc TS2451），历史详情侧改名 `REMOTE_GIT_DETAIL_MESSAGE_MAX_BYTES`。
- **renderer**：`RemoteGitPanel` 新增两个可折叠只读区（历史：`remote-git-history`／行 `remote-git-history-row`（短 oid＋subject＋作者＋相对时间，复用 usage 的 relative-time 词汇）／`remote-git-history-more`／详情 `remote-git-commit-detail`／文件行 `remote-git-commit-file`；引用：`remote-git-refs`／`remote-git-ref-row`（kind＋短名＋短 oid））；两版本单文件差异渲染进现有 `remote-git-diff`。语义：**展开即手动加载**、每页 50、显式「加载更多」追加且失败页保留已显示行、详情最后点击生效、`refresh`／写操作／断线使历史／引用／详情事实与快照事实**同生共死**（面板不混代显示），刷新后展开中的区由该手动动作经 effect 重取。无轮询、无 checkout／建分支／tag／推送控件；`remoteGit.historyReadOnly` 一句话说明未开放。i18n 中英同步（historyTitle／historyMore／refsTitle／historyReadOnly／detailFiles／refBranch／refTag）。
- **只读不变量的验证**：`tests/remoteGitHistory.test.mjs` 9/9——真实部署 helper 子进程＋原生 Git oracle，每个方法前后见证真实 `.git/index` SHA＋inode＋mtimeNs、全部 ref、无 `index.lock`、无 scratch 残留；非法 UTF-8 消息（`hash-object --literally` 手工提交）与二进制 blob 拒绝；对象不存在（`cat-file -t` exit 128 实测定为 `GIT_OBJECT_NOT_FOUND`）；根提交 `--root`；rename `R100`＋oldPath；`base: null` 与两侧皆不存在；全部参数边界（maxCount 0/101/1.5、skip -1/100001、额外字段、大写 oid、冒号路径、`../`／绝对路径按既有 `relative()` 拒绝）。
- **回归与门禁**：`remoteHelperEntry` 37/37（新不变量：无 eval/Function、每个声明能力须在 CAPABILITIES 与分发各出现一次）、`remoteGitReadIpc` 11/11（四通道正例＋越界参数在开 SSH 会话前拒绝＋helper 回复重验：101 行页／换 oid 回复／remote-tracking 混入／NUL 内容）＋view 状态 26/26；167 文件有界回归 **1720 项：1706 通过／8 skip／6 失败——6 项全部经 HEAD 干净 worktree 复现为既有红**（`remoteHelperSearchNames` 的 1.6.0 期钉住×2、`remoteSessionRootIsolation` 的 1.6.0 逐字节钉住×2、`remoteSearchIsolation` scanned-entry cap、`gitCommitFileDiff.integration` 非 git 目录 fetch），非本批引入、按「旧缺口不扩大修」记录在案。typecheck 0、Biome 0、`build:fast` 通过。
- **真机验收**：`远端 Git G1|远端 Git G2a/G2b|远端 Git G3a` **3 passed（4.2m）**。G3a 用例（`e2e/remote-git-history.ts`）：55 提交夹具（baseline＋带 `#` 行正文的 second＋53 个 filler＋`feature/x` 分支＋轻量 `v1.0`＋annotated `v2.0`），第一页 50 行 `data-oid` 与原生 `git log --format='%H %s'` 逐行一致，「加载更多」后 55 行全量对照；详情消息与 `git cat-file commit | sed '1,/^$/d'` **逐字节一致（含 `#` 行）**；rename 行 `R100`＋`← old.txt`；两版本差异两侧等于 `git show <rev>:tracked.txt`；引用 4 行含 v2.0 的 peeled 提交短 oid；写控件计数 0（丢弃／推送／拉取／全部暂存／初始化／检出／切换分支／新建分支／创建分支／打标签）；手动刷新后事实重建（50 行＋more＋4 refs）；前后见证 index SHA＋stat／全部 refs／HEAD＋symbolic-ref／工作区文件哈希**全部不变**；远端 `/tmp` 零残留。默认分支按远端实际（`master`）从 oracle 断言，不硬编码。
- **偏离与未完成**：①独立复核车道（E）未执行——子智能体基础设施失败（async 缺 chord 包、同步 worker stream 中断），主代理自审代替，复核缺口如实保留；②历史区在 `refresh` 后回到第一页（分页位置不保留，事实同生共死的代价，已用断言钉住）；③rename 文件的两版本差异按冻结契约单 `path` 参数，旧侧显示为空（不追 oldPath 侧）；④§5.10 计划的「子车道并行」实际为顺序实施。checkout／建分支／tag 写、compare、fetch/push 仍未支持；Windows/macOS、多窗口、长稳、打包集成、独立安全审查未验收——本批**不是** Remote v1 收口。
- **证据**：`/tmp/g3-e2e-final.log`（3 passed 4.2m）、`/tmp/g3-e2e-run6.log`（G3a 单项 1 passed 1.9m）、`/tmp/g3-full-regression.log`（1720 项）、`/tmp/g3-build.log`、`/tmp/g3-entry-final.log`（46/46）、`/tmp/g3-ipc2.log`（11/11）、`/tmp/g3-viewstate3.log`（26/26）；实现期红例：`/tmp/g3-history1.log`（utf8() 未定义折叠 IO_ERROR 等）、`/tmp/g3-laneB-regression.log`、HEAD 既有红复现 `/tmp/g3-head-red.log`、`/tmp/g3-head-red2.log`。`/tmp` 不承诺长期保留。

### 5.12 G3b（远端分支写面：新建分支／切换）冻结契约与实施结果（2026-10-16）

> 状态：**已完成实施并真机验收**（helper 1.11.0）。子智能体基础设施不可用（见 §5.11 偏离），仍由主代理按车道边界顺序实施。目标：G3 写面最小闭环——**新建分支**与**切换分支**，两者都不得丢用户文件。

- **G3b 原生 Git 事实（本机实测，`/tmp/g3b-probe*.sh`）**
  - `git update-ref -m <msg> refs/heads/<new> <oid> <zero>` 创建 CAS：成功 rc=0、目标已存在 rc=128；零 OID 表示“必须不存在”。
  - `git check-ref-format --branch <name>`：接受 `ünïcode`／`a/b/c`／`heads/x`／`a-`；拒绝 `-dash`／`a b`／`@{`／`a..b`／`.dot`／`x.lock`／`HEAD`／`lock/x.lock`；**`@` 竟 rc=0**（故必须自拒 `@`，不能只依赖 Git）。
  - `git switch <name>`（`GIT_OPTIONAL_LOCKS=0` 下 rc=0，untracked 文件随切换携带、`status` 字节不变）：工作树有**冲突**改动（目标会覆盖的 tracked 文件被改）时 rc=1 且不切换；目标文件为 tracked 而本地是**同名 untracked**时 rc=1 且不切换（两者都**不丢文件**）。**post-checkout hook 会真正执行**（实测写入文件）⇒ 必须复用既有 hooks 门禁拒绝，绝不静默跳过。
  - 干净切换会**重写 `.git/index`**（inode 与 size 变化）——这是 switch 的正常语义，不是越界写入：新不变量只钉“工作树文件与 HEAD/refs 一致”，不再钉 index 字节不变。
  - unborn 仓库 `git switch <branch>` rc=128（无可切分支），`git symbolic-ref --short HEAD` 仍可读。
- **新增方法（能力名即协议名，helper 1.11.0）**
  - `git.createBranch` `{name, expectedHead}` → `{applied: true, branch}`；`expectedHead` 为**本次预期 HEAD**（`null` 表示 unborn）：对象不存在/形状非法 ⇒ `GIT_OBJECT_NOT_FOUND`／`GIT_RESULT_INVALID`；名字先过 `check-ref-format --branch` 再自拒 `@{`/`@`/`\`/控制字符/超长（≤ `REMOTE_GIT_REF_MAX_NAME_BYTES`）；目标已存在 ⇒ `GIT_REF_EXISTS`；期间 HEAD 已变 ⇒ `GIT_COMMIT_HEAD_CHANGED`；**不切分支**、不写 index、不动工作树；ref 移动后回读失败/回复丢失 ⇒ `GIT_WRITE_RESULT_UNCONFIRMED`（不重放、不回滚）。
  - `git.switchBranch` `{name, expectedHead}` → `{applied: true, branch, head}`；名字必须**已存在**（否则 `GIT_REF_NOT_FOUND`）；只接受 `git check-ref-format --branch` 通过且不是 `@` 的**本地分支名**（不接受全 ref 名、不接受 detached/oid）；工作树冲突 ⇒ 原生拒绝 ⇒ `GIT_SWITCH_CONFLICT`（**绝不 `--force`／`--discard-changes`**）；期间 HEAD 已变 ⇒ `GIT_COMMIT_HEAD_CHANGED`；切换后工作树/HEAD/refs 被读回核对，不一致 ⇒ `GIT_WRITE_RESULT_UNCONFIRMED`。
  - **两者都不新增 hooks 例外**：既有 hooks／hooksPath／filter／签名要求门禁照旧拒绝（`GIT_WRITE_UNSUPPORTED`），因为 switch 会执行 post-checkout、createBranch 不执行任何 hook 但同属写面。
  - 新稳定码：`GIT_REF_EXISTS`／`GIT_REF_NOT_FOUND`／`GIT_SWITCH_CONFLICT`，helper 端 `stable` Set 与 main 端 `ERRORS` Set 两侧同步（G2b 曾因 helper 端漏加把稳定码折叠成 `IO_ERROR`）。
- **UI 契约（冻结）**：`RemoteGitPanel` 引用区新增控件——新建分支输入框 `remote-git-branch-name` ＋按钮 `remote-git-create-branch`（空名/超长/非法名禁用）、切换按钮 `remote-git-switch-branch`（每行 ref）；两动作都需要 **main-owned token**（`branchToken`／`switchToken`，kind 分离 `branch`／`switch`，与 index/commit 同规则：同 kind 刷新替换、跨 kind 不烧）；写结果未知时保留告警直到成功刷新（沿用 G6a 语义）；文案 `remoteGit.createBranch`／`switchBranch`／`branchNamePlaceholder`／`branchCreated`／`branchSwitched`／`refExists`／`refNotFound`／`switchConflict`（中英同步）。**不提供**删除分支／重命名／tag 写／force checkout／丢弃改动。
- **验证计划**：helper 真实子进程＋原生 Git（新建＋已存在＋非法名＋`@`＋unborn＋HEAD 变化＋门禁拒绝零执行＋无残留；切换干净／dirty 冲突／untracked 冲突／不存在分支／同分支 no-op／HEAD 变化；两方法前后见证 HEAD＋refs＋工作树文件哈希，switch 允许 index 变化但断言工作树内容与 oracle 一致）；main／IPC（kind 分离 token、跨项目拒绝、参数边界）；真机 e2e 追加到 G3b 用例（真实 UI 建分支＋切分支＋dirty 拒绝不丢文件＋远端原生 Git 核对 refs/HEAD/工作树）。

#### 5.12.1 G3b 实施结果

- **交付**：helper **1.11.0**（冻结 SHA-256 `a9196036c37108b6013907c80e11893fe5b085f40a5d6bff669f94551cff5621`，正文 92,388 字符、单行可打印 ASCII、仍只用四个 builtin；96 KiB 阈值未再上调）新增 `git.createBranch`（`update-ref -m "branch: created <name>" refs/heads/<name> <expectedHead> <zero-oid>` 原生 create-only CAS，**不移动 HEAD、不写 index、不动工作树**）与 `git.switchBranch`（原生 `git switch -- <name>`，冲突即由 Git 拒绝 ⇒ `GIT_SWITCH_CONFLICT`，**绝不 force/discard**；切换后回读 HEAD/branch 与 `git diff --quiet HEAD` 核对，不一致 ⇒ `GIT_WRITE_RESULT_UNCONFIRMED`）。名字先 `check-ref-format --branch`（实测 rc=1 或 128 都算非法），再自拒 `@`／`@{`／`\`／控制字符／`refs/`／40-64 hex／`HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_HEAD`／超 1024 字节。**两者都先过既有 hooks/config 门禁**：实测 `git switch` 会真的执行 post-checkout hook，所以有有效 hooks／`core.hooksPath` 时一律 `GIT_WRITE_UNSUPPORTED` 且零执行。新稳定码 `GIT_REF_EXISTS`／`GIT_REF_NOT_FOUND`／`GIT_SWITCH_CONFLICT` 在 helper `stable` Set 与 main `ERRORS` Set 两侧同步。
- **main／IPC**：`RemoteGitWriteExpectation.kind` 扩为 `index|commit|branch|switch`，`head` 字段记录**读回时确认的 HEAD**；`status` 在 helper 声明对应能力时额外签发 `branchToken`／`switchToken`（与 index/commit 同规则：同 kind 刷新替换、跨 kind 不烧、单次使用、15 分钟过期、按 sender+项目绑定）；`remoteGitReadIpc` 两通道把 `expectedHead` 从 main-owned expectation 注入，渲染层只能给名字；`validateRemoteGitBranchName` 作为主进程侧权威校验（与渲染层同名函数规则一致）。previewApi 两个 stub。
- **renderer**：引用区新增 `remote-git-branch-name` 输入框＋`remote-git-create-branch` 按钮（非法名/无 grant/忙碌即禁用）与逐行 `remote-git-switch-branch`（仅分支行、当前分支不出现、无 grant 禁用）；`createBranch`／`switchBranch` 沿用 G2b 语义（一次一个动作、成功后显式刷新、拒绝/未知结果丢事实并保留告警、未知**绝不重放**）；`mutatingKind` 增 `branch|switch` 文案；新稳定码中英文案。**不提供**删除分支／重命名／tag 写／force checkout／丢弃改动。
- **验证**：helper 级真实子进程＋原生 Git `remoteGitBranch` **13/13**（创建只加一个 ref 且 HEAD/index/工作树/其他 ref 逐字节不变；同名拒绝；18 类非法名零副作用；stale expectedHead 与 unborn；post-checkout 与 hooksPath 双门禁零执行；干净切换后工作树＝目标分支树且未跟踪文件保留；tracked 冲突与 untracked 冲突均拒绝并保留用户文件；不存在分支／全 ref 名／`@`；同分支 no-op；新建分支出现在只读 `git.refs` 列表）；IPC `remoteGitBranchIpc` **6/6**（grant 注入 expectedHead、跨 kind 不烧 token、非法名开 SSH 前拒绝、helper 拒绝码透传、答复不匹配／丢回复 ⇒ 未知、跨项目／关闭／dispose 零请求）；view 状态 17/17。有界回归 **1742 项：1728 通过／8 skip／6 失败——6 项与 G3a 批次完全相同的既有红**（1.6.0 期钉住×4、scanned-entry cap、本地 fetch 集成），非本批引入。typecheck／Biome／`build:fast` 0。
- **真机验收**：`G1|G2a/G2b|G3a|G3b` **4 passed（2.9m）**，其中 G3b 单项 **1 passed（29.2s）**：真机夹具建 `feature`（含一次 tracked 修改）＋未跟踪用户文件；UI 里 `refs/heads/nope`、`HEAD` 使「新建分支」保持禁用（本地校验），输入 `ui-created` 后创建成功且原生 `refs/heads/ui-created` == HEAD、HEAD 仍在默认分支；逐行「切换」到 `feature` 后 `symbolic-ref`/`rev-parse` 与面板分支名一致、`tracked.txt` 内容＝`git show feature:tracked.txt`、未跟踪文件仍在；原生写脏 `tracked.txt` 后点切换回默认分支 ⇒ 告警含「工作区有未提交改动」、HEAD/工作区**逐字节未变**、面板丢弃过期事实（不显示半真状态）；手动刷新后事实重建、前后见证只多 `refs/heads/ui-created`、无 `index.lock`／`pideck-index-*` 残留；远端 `/tmp` 与 `~/.pideck-e2e-*` 零残留。G3a 用例的「无写控件」断言按新能力更新为「历史只读 + 引用可建/可切 + 其余危险控件仍不存在」。
- **偏离与未完成**：①删除分支／重命名／tag 写、compare、fetch/push 仍未支持；②切换**不保留分页/引用区滚动位置**（刷新即重取，沿用 G3a 语义）；③`GIT_WRITE_RESULT_UNCONFIRMED` 之后不做任何自动核对（必须手动刷新）；④父代理自审代替独立复核车道（基础设施不可用）；⑤Windows/macOS、多窗口、长稳、打包集成、独立安全审查未验收——本批**不是** Remote v1 收口。
- **证据**：`/tmp/g3b-e2e-final2.log`（4 passed 2.9m）、`/tmp/g3b-e2e-run8.log`（G3b 单项 1 passed 29.2s）、`/tmp/g3b-full-regression.log`（1742 项）、`/tmp/g3b-helper-all.log`（59/59）、`/tmp/g3b-ipc4.log`（41/41）、`/tmp/g3b-view3.log`（17/17）、`/tmp/g3b-build3.log`；实现期红例与中间失败：`/tmp/g3b-branch1.log`（`name` TDZ 折叠 IO_ERROR）、`/tmp/g3b-e2e-run1..7.log`（夹具未引号消息、`test` 未导入、伪引用 `HEAD` 面板未拦、引用区被 own click 关掉、refs 排序、尾随换行）。`/tmp` 不承诺长期保留。

### 5.13 G4a（可恢复丢弃／删除）冻结契约（2026-10-16）

> 状态：**已完成实施并真机验收（helper 1.12.0，结果见 §5.13.1）**。G4 的第一片：**丢弃**（tracked 工作区改动还原到已暂存版本）与**删除**（untracked 文件）都必须**先留可恢复快照再动文件**；没有快照就没有这次操作，绝不退回 `unlink`。

- **G4a 原生 Git 事实（本机实测，`/tmp/g4a-probe*.sh`）**
  - `git hash-object -w --no-filters -- <path>`：把工作区**原始字节**写进仓库对象库（CRLF 逐字节保留：`0d0a`），且**实测不执行 clean 过滤器**（配了 `filter.marker.clean`＋`.gitattributes filter=marker` 时标记文件零出现）。
  - 空 index 不能直接 `update-index`（「索引文件比预期的小」）；`GIT_INDEX_FILE=<scratch> git read-tree --empty` 给出合法的 65 字节空 index，再 `update-index --add --cacheinfo <mode>,<blob>,<nested/path>` 可建**只含本次丢弃路径**的树（含多层目录）。
  - `git commit-tree <tree> -m "discard: <path>"` ＋ `git update-ref --create-reflog -m "discard: <path>" refs/pideck/recovery/<id> <commit> <zero>`：create-only CAS（成功 rc=0、同 ref 再次 rc=128），`git show <ref>:<path>` 回读**逐字节**等于丢弃前内容，reflog 带路径信息。
  - 影响面：`refs/heads`／`refs/tags` 不变（既有 refs 面板与提交操作不受影响）；`git status` 不变；**`git log --all` 会列出恢复提交**（根提交、消息 `discard: <path>`）——有意保留的可发现性，文档明示。
  - `git restore --worktree -- <path>`：把工作区还原为 **index（已暂存）版本**（staged＋unstaged 混存时结果为 staged 内容）；unborn／detached HEAD 同样可用；**实测会重写 `.git/index`**（字节与 stat 都变）⇒ 本次不变量是「index **内容**（同一路径的 staged blob）不变」，不是 index 字节不变（与 G3b 的 switch 同类）。
  - untracked 删除只改工作区：`git status` 仅少了该文件，无 ref/对象副作用。
- **新增方法（helper 1.12.0，能力名即协议名）**
  - `git.discard {path, group: "workingTree" | "untracked", expectedRevision}` → `{applied: true, recoveryRef, path, mode: "restored" | "removed"}`；`recoveryRef` 为 `null` 仅当被丢弃的「改动」本身就是删除（`" D"` 资源：没有字节可存，恢复读的是已持久化的 index 版本），此时操作本质是「撤销删除」，不可能丢数据。
  - **顺序是契约**：门禁（既有 hooks／hooksPath／filter／签名／进行中操作，复用 G2a/G2b 的 `gates`）→ 官方 `.git/index.lock` → 指纹（`expectedRevision`）核对 → 逐项类型门禁（必须是普通文件、非符号链接、mode 100644／100755；`workingTree` 组必须有同路径 index 条目）→ **先写快照**（`hash-object -w --no-filters` → scratch `read-tree --empty` ＋ `update-index --cacheinfo` → `write-tree` → `commit-tree` → `refs/pideck/recovery/<UTCstamp>-<8hex>` create-only CAS）→ **再动文件**（`workingTree` 用 `git restore --worktree -- <path>`；`untracked` 用无跟随删除并核对 ENOENT）→ 回读核对。
  - 快照提交身份是固定常量 `PiDeck recovery <pideck-recovery@localhost>`（经 env 注入，**不读也不写用户 Git 配置**），因此身份缺失的仓库也能丢弃。
  - 恢复语义：`git show <ref>:<path>` 给出逐字节原文（多层目录同样可寻址）；`refs/pideck/*` 不在 `git.refs`（heads/tags）里，也不会被 push 的默认 refspec 带走。
  - 容量／TTL（**本片明确不自动清理**）：单文件超过 `REMOTE_GIT_DISCARD_MAX_BYTES`（8 MiB）⇒ `RESULT_TOO_LARGE`；每次丢弃在对象库新增 1 commit＋1 tree＋1 blob（≈文件大小），不自动 prune；清理方式=用户显式 `git update-ref -d <ref>`（本片不提供 UI 删除）。
  - 失败语义：**快照 ref 建立之前的任何失败都不动文件**（如实报码：`GIT_WRITE_UNSUPPORTED`／`RESULT_TOO_LARGE`／`GIT_RESOURCE_CHANGED`／`GIT_COMMAND_FAILED`）；**快照之后的任何失败一律 `GIT_WRITE_RESULT_UNCONFIRMED`**（字节已安全，文件状态未知，不重放、不回滚）。
- **UI 契约（冻结）**：`workingTree`／`untracked` 行出现 `remote-git-discard`（文案 `remoteGit.discard`／`remoteGit.deleteFile`），点击先要求内联确认（`remote-git-discard-confirm`／`remote-git-discard-cancel`，文案 `remoteGit.discardConfirm`／`remoteGit.discardCancel`）；成功后刷新并在 `remote-git-recovery-note` 显示可恢复引用与恢复命令（`remoteGit.discardRecovered`）；需要 main-owned `discardToken`（kind `discard`）。**不提供**多文件批量丢弃、目录递归删除、面板内一键恢复（列出／还原属 G4b）、自动清理。
- **验证计划**：helper 真实子进程＋原生 Git（CRLF／Unicode／空格路径字节一致；`--no-filters` 零过滤器执行；丢弃 tracked 后工作区＝index、index 内容与 staged blob 不变、其他文件与 HEAD/refs 不变、恢复 ref 可逐字节还原；删除 untracked 后可还原；冲突／符号链接／子模块／超大文件／stale 指纹拒绝且零副作用；快照后失败 ⇒ UNCONFIRMED；无锁无 scratch 残留）；main／IPC（token kind 分离、越项目拒绝、参数边界、回复重验）；真机 e2e（面板丢弃与删除→仓库状态与原生 oracle 一致、`git show <ref>` 等于丢弃前字节、零残留）。

#### 5.13.1 G4a 实施结果

- **交付**：helper **1.12.0**（冻结 SHA-256 `be042d1e33fe9ec24f7c96a7397431b596fd058e879cb5f01b208f918ecf36d2`，96 KiB 阈值**未再上调**）新增 `git.discard {path, group, expectedRevision}`。顺序即契约：门禁（既有 hooks／filter／签名／进行中操作）→ 官方 `.git/index.lock` → 指纹核对 → 类型门禁（普通文件、非符号链接、mode 100644／100755；`workingTree` 需有同路径 index 条目）→ **先写快照**（`hash-object -w --no-filters` 原始字节 → scratch `read-tree --empty` ＋ `update-index --cacheinfo` → `write-tree` → `commit-tree` → `refs/pideck/recovery/<UTCstamp>-<8hex>` create-only CAS → `rev-parse <ref>:<path>` 回读校验）→ **再动文件**（`workingTree` 用 `git restore --worktree`；`untracked` 用无跟随 `unlink` ＋ ENOENT 核对）→ 回读 HEAD/门禁/index 内容。快照提交身份是固定常量 `PiDeck recovery <pideck-recovery@localhost>`（env 注入，绝不读写用户 Git 配置）。
- **两处实现决定（均由测试逼出来）**：①`git restore` 会刷新 index，而我们正持有官方 index.lock，因此 restore 跑在**本 run 私有的 index 副本**上（`GIT_INDEX_FILE=<scratch>/worktree-index`）——真实 index 一个字节都不写，工作区仍拿到 Git 自己会产出的版本（这条比原计划更强，已写进 §5.13 的顺序条款）；②`restore` 需要仓库形态的元数据目录，所以 scratch 布局（refs/objects/info/hooks＋HEAD＋config）在快照之前无条件建立，`" D"`（工作区已删除）这种无需快照的形态也能撤销删除。scratch 中被 Git 创建/改写的 `index` 与 `worktree-index` 都在动文件前后重录身份，清理才敢删（否则残留目录——正是这一条把两次红例钉出来的）。
- **96 KiB 阈值下的取舍（重要）**：本批正文一度到 102 KB，**没有提阈值**，而是把冻结正文里的解释性长注释压成一行式不变量，长文迁到 `RemoteGitReadSource.ts`／`RemoteGitWriteSource.ts` 的 TS 侧文件头（正文之外、不进审计面）。压缩后正文 97,822 字符、余量 <500；测试注释已写明：**下一个放不下的特性必须拆分内嵌程序或放弃单文件结构**，不得再次抬阈值。行为代码一字未动（压缩只碰注释），110 项 helper 级测试全绿。
- **验证**：helper 级真实子进程＋原生 Git `remoteGitDiscard` **13/13**——CRLF／空格／Unicode 路径字节逐字可取回（`git show <ref>:<path>`）；配了 `.gitattributes text` 的路径上「我们的原始快照 blob ≠ Git 自身转换后的 blob」被显式对照（证明 `--no-filters` 真的绕过了转换）；丢弃 tracked 后工作区＝index 版本、index 内容（staged blob）不变、其他文件/HEAD/分支/tag 全不变；删除 untracked 后可取回且 `status` 不再列出；`" D"` 撤销删除不产生 ref；超 8 MiB、符号链接 typechange、gitlink 仓库、stale 指纹、hooks、外部 index.lock 全部**在快照前**拒绝且零副作用、零 ref 残留；身份缺失的仓库仍可丢弃；同名两次丢弃产生两个 ref 各存自己的字节；嵌套路径在快照里保留目录形态；无锁无 scratch 残留。IPC `remoteGitDiscardIpc` **5/5**（grant 与 revision 由 main 注入、单次使用、跨 kind 不烧、非法组/越项目/额外字段/`../` 在开 SSH 前拒绝、外域 ref 名不被当作恢复引用〔写已发出 ⇒ 诚实地报未知〕、删除的 `recoveryRef: null` 透传、丢回复 ⇒ 未知、关闭/dispose 零请求）；view 状态 17+4 项含「恢复提示跨刷新不被读操作抹掉」。有界回归 **1764 项：1750 通过／8 skip／6 失败＝与 G3a／G3b 批次完全相同的既有红**（1.6.0 期钉住×4、scanned-entry cap、本地 fetch 集成），零回归；typecheck／Biome／`build:fast` 0。
- **真机验收**：`G1|G2a/G2b|G3a|G3b|G4a` **5 passed（3.4m）**，其中 G4a 单项 **1 passed（32.4s）**：面板里「回滚更改」先弹内联确认，**取消**后仓库逐字节不变；**确认**后工作区回到已提交版本、`remote-git-recovery-note` 显示 `refs/pideck/recovery/<stamp>` 且 `git show <ref>:tracked.txt` 等于被丢弃的原文；删除未跟踪文件（含 CRLF）后 `test -e` 为 absent、`git show <ref>:scratch.txt` 逐字节等于删除前内容；HEAD／分支／tag 全未动、`status --porcelain` 为空、恰好两个恢复引用、工作区其余文件与 `keep.txt` 不变、无 `index.lock`／`pideck-index-*` 残留、远端 `/tmp` 与 `~/.pideck-e2e-*` 零残留。同时补上 G3b 声称过但实际未落盘的「按 kind 的进行中文案」（新建分支／切换／丢弃各有自己的进度行）。
- **偏离与未完成**：①**没有自动清理**：恢复 ref 会一直留在对象库（每次丢弃 ≈ 1 commit＋1 tree＋1 blob≈文件大小），清理方式是用户显式 `git update-ref -d <ref>`；②**面板内没有恢复入口**（列出与一键还原属 G4b），恢复目前是文档化命令里的一条 `git show`；③不支持多文件批量丢弃、目录递归删除、index 组的「丢弃」；④`git log --all` 会列出恢复提交（根提交、消息 `discard: <path>`）——这是刻意的可发现性，已文档化；⑤父代理自审代替独立复核车道；⑥Windows/macOS、多窗口、长稳、打包集成、独立安全审查未验收——本批**不是** Remote v1 收口。
- **证据**：`/tmp/g4a-e2e-gate.log`（5 passed 3.4m）、`/tmp/g4a-e2e-run4.log`（G4a 单项 1 passed 32.4s）、`/tmp/g4a-full-regression.log`（1764 项）、`/tmp/g4a-helper-all2.log`（110/110）、`/tmp/g4a-ipc2.log`（5/5）、`/tmp/g4a-view1.log`（44/44）、`/tmp/g4a-build.log`；机制探针 `/tmp/g4a-probe.sh`、`/tmp/g4a-probe2.sh`、`/tmp/g4a-shadow-probe2.sh`；实现期红例 `/tmp/g4a-discard{1..7}.log`（`name` TDZ／restore 撞 index.lock／scratch 布局缺失／测试漏暂存／残留 scratch）、`/tmp/g4a-e2e-run{1,2,3}.log`（提示竞态、尾随换行、见证范围含恢复 ref）。`/tmp` 不承诺长期保留。

### 5.14 helper 多文件部署包拆分（2026-10-16，结构性改动，已真机验收）

- **为什么**：G4a 把单文件正文推到 97,822 字符（96 KiB 上限、余量 <500）。§5.13 与 `tests/remoteHelperEntry.test.mjs` 已把规则写成「下一个放不下的特性必须拆分内嵌程序或放弃单文件结构」。G4b（恢复列表／一键还原）必然要加代码，因此先做拆分，而不是再抬阈值、也不是删掉使正文可审计的不变量。
- **拆成什么**：部署包现在是**四个文件**，各自单独审阅、单独哈希、单独钉住——
  - `helper.mjs`（30,342 字符）：协议帧、并发/等待室、`hello`/`echo`/`cancel`、只读 fs 批（`fs.stat`/`fs.list`/`fs.read`/`fs.searchNames`）、argv/root 两态规则、Git 方法分发骨架；`import{createGitReadProgram}from"./git-read.mjs"`。
  - `git-read.mjs`（31,565 字符）：只读 Git 批与共享执行器（root FD 锚定、元数据门禁、无跟随读取、预算拒绝、`unchangedRead`）；`import{...}from"./git-write.mjs"`。
  - `git-write.mjs`（36,130 字符）：四个写程序的工厂（stage/unstage、commit、branch、discard），构成本 run 的私有元数据上下文与官方 index.lock 纪律。
  - `remote-runner.mjs`（13,620 字符，本来就在同一 bundle 里）：远端 pi 监督进程。
  - 四个文件同属**一个内容寻址 bundle**（`frozenHelperBundleManifest()` 列出全部文件与各自 sha256），因此不可能出现「helper 是 A 版、runner 是 B 版」的组合。
- **不变量的搬家与保留**：`tests/remoteHelperEntry.test.mjs` 的不变量检查改为**逐 artifact**：每个文件一个 SHA-256 钉住、单行可打印 ASCII、无控制字节、无 `console.`、无 `eval`/`Function`、无 `require(`、<96 KiB、**只允许 import 自己在审阅清单内的兄弟文件**（entry→git-read、git-read→git-write、git-write→无），且每个声明能力必须在 entry 的 CAPABILITIES 与分发里各出现一次。`node -e <source>` 自测形态**按计划主动放弃**：entry 现在 import 兄弟文件，命令行只带 entry 根本跑不起来——测试改为从**文件**启动整套 bundle（这正是部署形态），并断言 entry 带着相对 import，防止单文件形态悄悄复活。
- **部署链路**：`REMOTE_HELPER_ARTIFACTS` 是唯一文件清单（名称＋源码＋sha256），`deployFrozenHelperBundle` 逐个写入（0400）并让 manifest 覆盖全部文件；bundle sha 随内容自动变化。测试侧新增 `tests/helpers/remoteHelperArtifacts.mjs` 物化整套文件，`remoteGitFixture`/`remoteHelperEntry`/`remoteWorkspaceEndToEnd`/`remoteBootstrapDeployment`/`remoteBootstrapSession`/`remoteBootstrapSessionIntegration`/`remoteSearchIsolation`/`remoteHelperSearchNames`/`remoteProjectRootReverify` 已全部改为物化整套 bundle。
- **验证**：helper entry 37/37（含逐 artifact 不变量）、bootstrap 部署 12/12、bootstrap session 集成 78/78（含 runner 路径与 bundle 清单）、workspace 端到端 49/49、依赖 helper 的 Git 套件 194→全绿（除既有基线红）；有界回归 **1764 项 1750 通过／8 skip／6 失败＝同一批既有基线红**（1.6.0 期钉住×4、scanned-entry cap、本地 fetch 集成），零新增；typecheck／Biome／`build:fast` 0；真机 `G1|G2a/G2b|G3a|G3b|G4a` **5 passed（3.4m）**——真实 SSH 上传并激活四文件 bundle、每个 Git e2e 仍绿、远端零残留。
- **已知观察与遗留**：①真机测试机的 `~/.pideck/remote-host/bundles/` 已累积 11 个内容寻址 bundle 目录（每次 helper 版本变化一个）；**bundle 的 GC/容量上限不在本片范围**，作为远端磁盘占用问题记录在案；②`REMOTE_HELPER_ENTRY_VERSION` 升到 1.13.0（文件集变化本身是协议形状变化）；③一次四路并行回归中 `remoteGitDiscard` 的「无身份仓库」用例曾返回 `GIT_WRITE_RESULT_UNCONFIRMED`，此后单独与并行各跑两轮均未复现（无身份路径与判定条件未变），按**未复现的一次性抖动**记录，不作为已修问题。

### 5.15 G4b（恢复清单／一键还原／清理）冻结契约（2026-10-16）

> 状态：**已完成实施并真机验收（helper 1.14.0，结果见 §5.15.1）**。补齐 G4a 的承诺：丢弃/删除前留下的 `refs/pideck/recovery/*` 快照要能在**面板里看到、能一键还原、能显式清理**，而不是只留一条 `git show` 命令。

- **方法（能力名即协议名，helper 1.14.0）**
  - `git.recoveryList {}` → `{entries: [{ref, oid, path, bytes, at}], truncated}`。只列 `refs/pideck/recovery/*`（`for-each-ref --sort=-creatordate` 最新在前）；每个 ref 必须指向**恰好含一个路径**的提交树，否则该条目不列出（外部往这个命名空间塞东西不会被当成恢复项）。条数上限 `REMOTE_GIT_RECOVERY_MAX_ENTRIES`（64：实测每条约 2 个子进程，128 条会让一次列表在负载下逼近请求预算），超过则返回最新的 64 条并 `truncated: true`（**有标注的截断**，与 `fs.searchNames` 同一先例，不假装完整）；`ref` 名不是本命名空间的 ref 一律忽略；读写都只读，不动 index/工作区/refs。
  - `git.recoveryRestore {ref, oid, path}` → `{applied: true, path, bytes}`：把该快照的**原始字节**写回工作区同路径。**覆盖保护是契约**：目标必须「不存在」或「与当前 index 版本一致」（`git diff --quiet --no-ext-diff --no-textconv -- <path>` 为 0），否则 ⇒ `GIT_RESTORE_CONFLICT`（**绝不覆盖未提交的新改动**）；符号链接/类型变化/父目录不存在一律拒绝；`ref` 必须存在且仍指向 `oid`（`rev-parse` 核对，过期 ⇒ `GIT_RECOVERY_ENTRY_NOT_FOUND`）；写完回读字节与 mode 一致，否则 `GIT_WRITE_RESULT_UNCONFIRMED`。**不做任何过滤器转换**：还回的就是你当时有的字节；若 `.gitattributes` 里有 `text`/`eol`，Git 可能因此把该文件视为已修改——那是你的内容原样回来，文档明示。
  - `git.recoveryDrop {ref, oid}` → `{applied: true}`：`update-ref -d <ref> <oid>` **原生 CAS 删除**（只删仍指向该 oid 的 ref）。**这是唯一让快照永久消失的操作**，面板必须二次确认；helper 不提供批量删除。
  - 三者都要求 `ref` 形如 `refs/pideck/recovery/<名字>`、`oid`/`path` 形状合法；`restore`/`drop` 走既有写纪律（hooks/config 门禁＋官方 `.git/index.lock`＋指纹 `expectedRevision` 核对），`list` 是纯读且不取锁。
- **容量与 TTL（本片把语义补完）**：仍然**没有自动清理**，但用户第一次有了「看得见＋删得掉」的手段：列表给出每个快照的路径/大小/时间与 `truncated` 标志，逐条 CAS 删除即回收（对象由 Git 自己按 GC 规则回收）；`REMOTE_GIT_RECOVERY_MAX_ENTRIES` 是列表上限而不是存储上限——存储占用仍由用户自己掌控，README/计划不宣称自动 TTL。
- **新稳定码**：`GIT_RESTORE_CONFLICT`、`GIT_RECOVERY_ENTRY_NOT_FOUND`（helper 端 `stable` Set 与 main 端 `ERRORS` Set 两侧同步）。
- **UI 契约（冻结）**：面板第三个可折叠只读区「恢复」（testid `remote-git-recovery`／行 `remote-git-recovery-row`／还原按钮 `remote-git-recovery-restore`／删除按钮 `remote-git-recovery-drop`／删除确认 `remote-git-recovery-drop-confirm`、`remote-git-recovery-drop-cancel`）；**展开即手动加载**（与历史/引用一致，无轮询）；行显示路径、大小、相对时间与 `ref`；还原成功后显式刷新并提示「已还原 …」；`truncated` 时显示「仅显示最近 64 条」。写动作需要 main-owned token（kind `restore`／`drop`）。**不提供**批量还原/批量删除、跨项目恢复、自动清理。
- **验证计划**：helper 真实子进程＋原生 Git（列表与丢弃后的事实一致、foreign ref/多路径树被忽略、`truncated` 在 >128 条时为真、还原后字节逐字等于丢弃前、目标有新改动时拒绝且不动文件、目标缺失时创建、ref 过期/伪造 ⇒ 未找到、CAS 删除只删匹配 oid、删除后 `for-each-ref` 为空、无锁无 scratch 残留）；main／IPC（token kind 分离、越项目、参数边界、回复重验）；真机 e2e（丢弃→展开恢复区→还原→字节一致→删除 ref→列表为空且原生 ref 消失）。

#### 5.15.1 G4b 实施结果

- **交付**：helper **1.14.0** 新增三个方法（bundle 三份文件各自钉住：`helper.mjs` 30525 字符 `63710a1f…`、`git-read.mjs` 33407 字符 `57ebe93c…`、`git-write.mjs` 51904 字符 `e5665dc3…`，见 `RemoteHelperEntry.ts` 的三个常量）。`git.recoveryList`：一次 `for-each-ref --sort=-creatordate --format=%(refname)%09%(objectname)%09%(creatordate:unix)` 拿全部 ref＋提交＋时间，再对每条一次 `ls-tree -l -r -z` 拿**唯一路径与大小**（每条约 2 个子进程；实测 `%09` 才会被 Git 展开成制表符，`%x09` 原样输出；`ls-tree -l` 的 size 列有空格填充，解析要容忍）。只为「恰好一个路径的提交树」服务：命名空间里别人塞的 ref（blob 引用、多路径树）**跳过而不是拒绝**，读取失败也只跳过该条。上限 `REMOTE_GIT_RECOVERY_MAX_ENTRIES=64`（实测每条约 2 次子进程；128 条会让一次列表在负载下逼近请求预算），超出返回最新 64 条并 `truncated: true`。`git.recoveryRestore`：把快照字节写回同路径，**只在目标「不存在」或「与 index 版本一致」时**允许（否则 `GIT_RESTORE_CONFLICT`），写后逐字节回读、HEAD/门禁复核，父目录不存在则拒绝（不替用户建目录）。`git.recoveryDrop`：`update-ref -d <ref> <oid>` **原生 CAS 删除**，删后回读确认。
- **重大发现（G4a 遗留的间歇 UNCONFIRMED 的真根因，已修）**：把真实 index **字节拷贝**成影子 index 时，stat 缓存也被一起拷走；当缓存项「看起来是当前状态」时，`git restore` 会**跳过写入**——文件仍是用户的改动，而 `git status`/`git diff` 因同一缓存**报干净**（racy-git 的假干净）。此前 G4a 里两次「并行回归偶发 `GIT_WRITE_RESULT_UNCONFIRMED`、无法复现」正是它；这次用临时 stderr 诊断（失败路径才写）抓到 `disk=5/fcbc800d… index=5/f34848ca… status=`（状态为空）。修法两条：①影子 index 改为**从 index 自己的 tree 重建**（`write-tree` ＋ `read-tree`，只保留 mode/对象、丢光 stat 数据，`GIT_OBJECT_DIRECTORY` 必须指向真实对象库，否则嵌套目录的 `write-tree` 会因拿不到 blob 而失败），因此 checkout 一定会写；②判定改为 **Git 自己的 worktree-vs-index 比较跑在无 stat 缓存的影子 index 上**（既不受缓存影响，也保留 `text`/`eol` 属性的转换语义——纯字节比较在 `text=auto` 仓库里会误判）。`git.recoveryRestore` 的覆盖保护同样用这个影子比较，外加「index 里没有该路径就拒绝」。回归测试：`withCachedTimestamp`（把文件 mtime 设成缓存值）＋ `text eol=crlf` 仓库里的丢弃/还原两条确定性用例。**该修复同时让 G4a 的丢弃与 G4b 的还原都变确定**。
- **另外两个由测试逼出来的缺陷**：①`dropRecovery` 成功时没有 refresh，成功更新里不带仓库事实 → 快照被清空后**整块区（含刚设置的提示）随子树卸载**，用户只看到空面板（真机 e2e 抓到：`refs` 已删、面板无提示）；补 `refresh()` 后一致。②恢复列表原本与写操作共用 `epoch`，「还原成功后自动重载列表」这个读会把随后 drop 的成功回执挤掉（用户操作的结果被判为过期）→ 列表改用自己的 `recoveryEpoch`，读永远不能作废写的回执；补了确定性竞态测试（首个列表挂起、drop 成功、再放行列表，断言提示仍在）。
- **main／IPC／renderer**：`RemoteGitWriteExpectation` 增 kind `restore`／`drop`；`status` 签发 `restoreToken`／`dropToken`（与既有 kind 同规则）；`git:remote-recovery-list`（无 token）／`-restore`／`-drop` 三通道，主进程逐字段重验（ref 必须匹配 `refs/pideck/recovery/*`、oid 形状、path 经 `validateRemoteGitPath`、bytes/at 非负安全整数、列表条数≤64）；面板第三个可折叠区「恢复」（testid `remote-git-recovery`／行 `remote-git-recovery-row`／`-restore`／`-drop`／删除确认 `-drop-confirm`、`-drop-cancel`／结果提示 `remote-git-recovery-outcome`，与 G4a 的备份提示 `remote-git-recovery-note` **分开**），展开即手动加载、`truncated` 明示「仅显示最近 64 条」、删除必须二次确认、还原不需要；i18n 中英同步。
- **验证**：helper `remoteGitRecovery` 9/9（列表与丢弃事实一致、外来 ref／多路径树被忽略、边界 `truncated`、还原逐字节、目标有新改动拒绝、无 index 条目的路径拒绝、丢失父目录拒绝、ref 过期/伪造 ⇒ 未找到、CAS 删除只删匹配 oid、删除后 ref 消失、零锁零 scratch 残留）＋丢弃 15/15（含两条 racy 回归）＋全套 144/144；并行批次（此前会闪）连续 3 轮 135/135；IPC `remoteGitRecoveryIpc` 6/6；view 26/26；有界回归 **1787 项 1773 通过／8 skip／6 失败＝同一批既有基线红**（1.6.0 期钉住×4、scanned-entry cap、本地 fetch 集成），零新增；typecheck／Biome／`build:fast` 0；真机 **`G1|G2a/G2b|G3a|G3b|G4a|G4b` 6 passed（4.0m）**，G4b 单项 1 passed（26.5s）：面板丢弃→展开恢复区看到路径/大小/相对时间→一键还原后字节逐字回来且 `git status` 显示改动→取消删除不动 ref→确认删除后原生 ref 消失、行清空、提示「已删除」，零残留。
- **偏离与未完成**：①**没有自动清理／TTL**：列表上限 64，删除是用户显式动作（每条一次 CAS），对象随后由 Git 自己回收；②不做批量还原/删除、不跨项目恢复、不自动建父目录；③`git log --all` 仍会列出恢复提交（G4a 的既有取舍）；④父代理自审代替独立复核车道；⑤Windows/macOS、多窗口、长稳、打包集成、独立安全审查未验收——本批**不是** Remote v1 收口。
- **证据**：`/tmp/g4b-e2e-gate.log`（6 passed 4.0m）、`/tmp/g4b-e2e-run13.log`（G4b 单项 1 passed 26.5s）、`/tmp/g4b-full-regression.log`（1787 项）、`/tmp/g4b-helper-all-final.log`（144/144）、`/tmp/g4b-racy-test7.log`、`/tmp/g4b-rec-final{2,3,4}.log`（3 轮 9/9）、`/tmp/g4b-recovery-ipc1.log`（6/6）、`/tmp/g4b-view-final.log`（26/26）；诊断期红例 `/tmp/g4b-rec-x2.log`（`diff exit 1 disk=… index=… status=` 抓到假干净）、`/tmp/g4b-e2e-run{1..12}.log`。`/tmp` 不承诺长期保留。

## 6. 完整路线的剩余门禁

- **G3**：历史/refs 先读；checkout/create branch 再写。真实 branch 类型/ref 校验，dirty/冲突不丢用户文件；polling 不触发 fetch，断线与跨代清理。嵌套仓库独立 scope；外置 metadata 不借字符串检查放宽。
- **G4**：delete/discard 不复用本机 trash。可恢复远端方案须定义位置、权限、容量、TTL、恢复与失败语义；无方案时不开放，不声称普通 `unlink` 等价可恢复删除。
- **G5**：远端 Git 服务连接不是已 pin 的工作区 SSH endpoint，两条身份链不能混称。保留远端账号既有认证/host-key policy，不拷贝本机 key/token/known_hosts，不关闭校验。fetch/push/pull 区分副作用；禁止隐式 force 或改 pull strategy，失败不自动重放。
- **G6**：客户端路径/SSH executable、中文/空格、shell/Unicode、EOF/process group、网络延迟与断线、大 repo 预算、窗口多实例、打包资源/helper 部署、新旧 Git/helper capability 组合分别验收。一次成功不代表长稳；独立安全审查与发布门禁仍不可省。

每个批次完成后更新本文状态/能力表与 handoff，准确列出通过、失败、未验证项。G1/G2 的绿灯不将 G3–G6 标绿，也不改变 Remote v1 的完整发布门禁。

## 7. 调研来源

- [simple-git 官方仓库](https://github.com/steveukx/git-js) / [自定义 binary](https://github.com/steveukx/git-js/blob/main/docs/PLUGIN-CUSTOM-BINARY.md) / [MIT license](https://raw.githubusercontent.com/steveukx/git-js/main/LICENSE)
- [dugite 官方 README](https://github.com/desktop/dugite) / [portable Git 工具链](https://github.com/desktop/dugite-native) / [MIT license](https://raw.githubusercontent.com/desktop/dugite/main/LICENSE)
- [isomorphic-git 官方定位与能力](https://isomorphic-git.org) / [FAQ](https://isomorphic-git.org/docs/en/next/faq) / [license](https://raw.githubusercontent.com/isomorphic-git/isomorphic-git/main/LICENSE.md)
- [NodeGit 官方 README](https://github.com/nodegit/nodegit) / [license](https://raw.githubusercontent.com/nodegit/nodegit/master/LICENSE)
- [Git status：porcelain v1 / -z / optional locks](https://git-scm.com/docs/git-status)
- [Git diff：external diff / textconv](https://git-scm.com/docs/git-diff)

来源用于选型与格式/执行面依据；没有安装四个候选库、跑它们的兼容测试或比较基准，不伪称已实测维护质量/性能。
