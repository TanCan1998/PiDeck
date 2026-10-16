# 远端 Git：调研结论与分阶段实施计划

> 状态：G0 调研、G1 status/diff 与 G2a 单文件 stage/unstage 已完成 Linux 开发态实现、针对性回归及真实 Electron＋SSH 验收；G6a 已补故障／并发／短周期资源回归并修复未知结果提示，G6b 新增真实 SSH 长稳验收并有一次完整 1 小时通过，详见 §5.6–§5.7（首轮失败未定因、资源增量仍需跟进）。commit 仍禁用，G3–G5 与完整 G6 未完成。仍受开发态实验门禁约束，不代表 Git parity 或 Remote v1 已收口。
> 核对基线：`feat/remote-development`，G0 调研基线 `101b9b82c`；G1 从 `bc25ebe20` 实施，G2a 从 `f83f9d550` 实施。
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
| **G2** | stage/unstage/commit | 精确路径操作、unborn 行为、index/HEAD 并发、提交预览与回执不确定性、仓库工程门禁通过后开放。可独立收口 stage/unstage；不能为凑齐三项而降低 commit 门禁。 |
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

- **helper与本机边界**：`RemoteGitWriteSource.ts`与G1读取程序同源嵌入helper **1.8.0**，冻结SHA-256 `86db736b3e6a20f4bd98d29c498d2b732ff8bb9a9f985da2cb0291dc1d4d94ff`。仍只用四个builtin；为维持原有64 KiB审阅上限，删除大行内与文件头重复的10段解释注释，不放宽测试阈值；正文64,257个ASCII字节。新能力只声明`git.stage`／`git.unstage`，没有commit、网络或自由argv入口；既有本机Git写IPC对SSH仍拒绝。
- **受控原生Git**：官方`index.lock`排他0600，root/gitdir FD锚定；同目录随机0700 scratch中复制index、HEAD与白名单有效配置，通过私有`GIT_DIR`／`GIT_INDEX_FILE`运行原生Git，以现有objects目录存放原生生成的blob。真实有效hooks、任意hooksPath、filter定义或签名要求在副本执行前后拒绝；私有context冻结的配置不具有项目代码执行能力，不把late新增的hook/config竞态带进原生add。不是把现有工程门禁清空后照样发布；晚到门禁阻塞真实index替换。保留原生autocrlf/attributes语义，比较非选中stage0 entries（mode/OID）不变、工作区正文/metadata与属性不变，再写本人lock、保mode/uid/gid、不chown、fsync、rename并核对结果。拒绝skip-worktree、assume-unchanged、split/sparse与非stage0 index。
- **令牌与生命周期**：`RemoteGitMutationTokens.ts`最多128条／15分钟，sender＋project绑定、刷新替换，host revision与locator绑定在main-held expectation中；消费发生在首个await前。helper revision摘要绑定root/gitdir identity、index SHA/metadata、HEAD/branch和完整status；不把内部摘要或host/root交给renderer作为写权限。视图卸载、断线、明确取消、sender销毁和quit均撤销令牌／取消在途操作；旧helper仍能只读，未协商写能力无按钮。IPC新通道只接封闭operation/group、单target和opaque token。
- **失败语义**：子进程组在deadline/cancel/EOF被终止；先等待回收再清理，清理只认本次拥有的inode，未知／被替换artifact保留，不递归删未知目录或删别人的锁。明确错误不替换真实index；发送写请求后timeout/cancel/断线、未知错误／身份变化，以及发布后的异常，main统一提示结果未确认，清旧事实，要求用户手动刷新，不重放。中断可能留下未引用objects或可核查scratch，不自动GC或reset；SIGKILL／宿主崩溃的残留锁没有自动解锁。写前后核对不等于所有非协作writer下的内核CAS，也不保证HEAD＋index跨文件原子性。
- **UI**：`FileTree.indexActionsOnly`只开单行stage/unstage；即使误传其他callbacks，也不出现discard/delete/目录动作，保留local默认行为。刷新与写操作互斥，成功只读刷新；失败/未知不自动刷新或重试写。正文说明stage选取动作开始时最新整文件内容，不是「提交旧diff」；commit、bulk stage、合并解决、discard、历史、refs与同步均未开放。所有新增说明与稳定错误中英同步。
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
