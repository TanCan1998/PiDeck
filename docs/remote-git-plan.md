# 远端 Git：调研结论与分阶段实施计划

> 状态：G0 调研完成；G1 只读公共协议/IPC 实施范围已获用户确认，实施准备中；G1–G6 尚未交付。本计划不代表远端 Git 已可用或 Remote v1 已收口。
> 核对基线：`feat/remote-development`，`101b9b82c`。
> 范围：落实总计划 §6.3 的 Git 能力；近期顺序仍为 **status/diff → stage/unstage/commit → 跨平台与稳定性**，不一次性搬运所有本机操作。

## 1. 技术结论：继续使用 Git CLI，不更换引擎或新增 Git 依赖

Git 算法、对象库、index、refs 和提交仍由原生 Git 实现。PiDeck 已有自己的命令封装、结果解析、位置边界、IPC 与 UI；需要补的是这些产品层的远端执行能力，而不是重新实现 Git。

### 1.1 当前代码事实

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
