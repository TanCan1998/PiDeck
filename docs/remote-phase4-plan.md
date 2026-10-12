# 远端 Phase 4 侦察与设计：远端 pi 端到端会话

> 状态：**侦察 / 设计 + 四处已落地**——已实施：§3.7 的 capability gate 接线（task-32）、§3.6 的 `lifetime` 分档与强制 ServerAlive（task-33）、**§7 P4.0 的 `PiSpawnHandle` / `PiRuntimeLauncher` 抽取（本地实现）**、**§7 P4.1 的远端 pi 定位与兼容矩阵**（同步真机只读验证）。仍只有设计：方案 B 的 `proc.*`（§3.4）、心跳（仅诊断，留给 P4.2）。下列「§2.2 真机读数」仍是对 `serve` 的只读快照；本轮未向真机写入任何东西（P4.1 的真机探测也全部只读）。
> 侦察基线：`feat/remote-development` @ `4ba0f79f`（前五批已提交，第六批在途）。
> 远端证据来源：已核验主机 `10.81.2.15`（本机 SSH 别名 `serve`，用户 `zhadainian`）上的**只读**命令；命令与原始输出见 §8。
> 相关计划：`docs/remote-development-plan.md`（§4.1 两条远端通路 / §6.2 PiProcess 最小重构 / §7 Helper 协议 v1 / §10 连接状态 / §12 Phase 4 / §13 能力对照 / §15 风险）、`docs/remote-development-handoff.md:222-229`。

---

## 0. 结论摘要（先读这段）

**五问的答案（一句话版）**

1. **远端 pi 怎么找**：沿用 `RemoteNodeDiscovery` 的既有做法——通过 `/bin/sh -lc` 取登录 shell 的 `PATH`，再按确定性规则挑绝对路径。真机证据：非交互式 shell 里是 `/usr/bin/node` v12.22.9 且**没有 pi**；登录 shell 里是 `~/.nvm/versions/node/v24.11.0/bin/node` v24.11.0，pi 是 `~/.nvm/versions/node/v24.11.0/bin/pi` → `@earendil-works/pi-coding-agent/dist/bundle/cli.js`，`pi --version` = **0.85.1**。项目内 `node_modules` / `npx` 形态在本机不存在，也不能作为探测假设。
2. **通道**：**"Phase 4 必然要扩 helper 协议" 这个前提与已批准的计划冲突，需要 lead 拍板**。计划 §4.1 明确规定**两条通路**：控制通路（每主机一个 helper，NDJSON v1）只做文件/Git/Session 索引；**Agent 通路每个 Session 一个独立 SSH 子进程 + 固定 runner，helper 不参与 Pi RPC**（`docs/remote-development-plan.md:153-173, 501-516`，原文："实际 Pi RPC 不经过控制协议"）。按该设计，最小 Phase 4 甚至可以**零新增 helper op** 起步（pi 定位/版本探测复用主进程既有 `SshClientRuntime` 短命令通道）。本页仍给出"若坚持把 pi 托管进 helper"的完整 `proc.*` 设计（§3.4）与其代价清单，但**推荐方案 A**。
3. **生命周期与恢复**：断线即**杀**（ssh 退出 = runtime 退出，runner 回收进程组），不做可脱离 SSH 存活的 daemon；重连后**从远端 JSONL 重建**会话（真机上有 28 份 session JSONL 可作依据）；`sessionId` 稳定不变，`runtimeGeneration` 每次 launcher 重建 +1，迟到结果按既有 fencing 丢弃；**未确认的 prompt 永不自动重放**。
4. **复用面**：`SshProcessLauncher`（长活双向 stdio + 行订阅）、`RemoteControlClient`、`SshConnectionManager`、`PiRpcClient`（Pi JSONL 解析）、`PiProcess` 的命令/环境组装、`SessionRuntimeCoordinator`（session/runtime 唯一 owner）都能直接复用；**必须新增** `SshPiRuntimeLauncher` + 远端 runner + `PiRuntimeLaunchPlan` 的远端分支；见 §5 的 parity 表。
5. **不可宣称 / 风险**：`pi --mode rpc` 在真机**未被启动过**（本次只读侦察不允许起进程），因此"远端 pi RPC 能在真实 SSH 会话下长期稳定"今天**没有证据**；此外远端 pi **0.85.1 低于计划自己核验过的 0.87.1 基线**、控制会话有 **120 秒硬上限**、远端磁盘已 **91%**。Phase 4 仍只能是邀请制 beta，且 UI 必须持续标记写操作 / Git / 终端不可用（`docs/remote-development-plan.md:674`）。

**必须先拍板的两件事**

| # | 决策点 | 我的建议 | 若反向选择的最小代价 |
| --- | --- | --- | --- |
| D1 | Agent 通路走哪条：计划原案（独立 ssh + runner）还是 lead 前提（扩 helper `proc.*`） | **走计划原案（A）**：控制协议保持"纯请求/响应 + 无子进程"的冻结语义 | 需同时改 7 处不变量（§3.4 表）：帧方向、帧上限、并发槽、timeout clamp、连接 120s 上限、每 root 一个 helper、子进程隔离 |
| D2 | 是否**立即**修 launcher 的 120 秒硬超时（红证与替换设计见 §3.6） | **是，且列为 Phase 4 第 0 步**：今天的 `SESSION_DEADLINE_MS = SSH_LAUNCHER_MAX_TIMEOUT_MS = 120_000` 会把任何长活 SSH 会话（包括未来每个 Session 的 Agent 通路）在 2 分钟内强杀 | 不修则远端会话必然每 ≤2 分钟掉线一次，Phase 4 门禁（断线不重放、长稳）无法成立 |

---

## 1. 侦察口径

- **代码证据**一律写 `文件:行号`，可直接回查。
- **远端证据**只用了只读命令：`uname` / `id` / `command -v` / `node -v` / `pi --version` / `readlink` / `ls` / `find` / `sha256sum` / `df`。**没有写任何远端文件**，**没有读取 `~/.pi/agent/auth.json` 或任何凭据内容**（只看到它的存在与权限位）。`pi --version` 是 `PiLocator` 本地也使用的纯版本查询（`src/main/pi/PiLocator.ts:626`）。
- **未做**：没有在远端启动过 `pi --mode rpc`、没有起过 runner、没有跑过 helper（避免产生进程/文件/日志）。

---

## 2. 问题 1：远端 pi 可执行怎么找 + 远端是否已安装

### 2.1 产品今天怎么解析远端 node（可复用的范式）

- `src/main/remote/RemoteNodeDiscovery.ts:1-25`：非交互式 SSH 不加载用户 shell 初始化（nvm 在 `~/.bashrc` 里），实测会探到 `/usr/bin/node` v12.22.9；因此**只读 PATH，不执行用户命令**：远端跑 `/bin/sh -lc 'printf %s "$PATH"'`（`RemoteNodeDiscovery.ts:56-58`），本地按确定性规则挑 `<绝对目录>/node` 候选（`:68-83`，`MAX_NODE_CANDIDATES = 3`，见 `RemoteBootstrapSession.ts:21`）。
- 本地同源立场：`PiLocator` 也把登录 shell PATH 与 env PATH 合并（`PiLocator.ts:1012-1040`），候选名 `pi`/`pi.js`/`pi.mjs`/`pi.cjs`（`:1004-1010`）。
- **推论**：远端 pi 必须用**同一套登录 shell 解析**，不能假设 `/usr/bin/pi`、不能假设 `npx pi`、不能假设项目内 `node_modules/.bin/pi`。

### 2.2 真机读数（只读）

```text
# A. 非交互式 shell
$ ssh -o BatchMode=yes serve 'echo RECON_OK; uname -srm; id -un; command -v node; node -v; command -v pi || echo NO_PI_IN_NONINTERACTIVE_PATH'
RECON_OK
Linux 6.8.0-136-generic x86_64
zhadainian
/usr/bin/node
v12.22.9
NO_PI_IN_NONINTERACTIVE_PATH

# B. 登录 shell
$ ssh ... serve 'bash -lc "command -v node; node -v; command -v pi || echo NO_PI_IN_LOGIN_PATH; printf %s \"$PATH\" | tr : \"\n\" | head -12"'
/home/zhadainian/.nvm/versions/node/v24.11.0/bin/node
v24.11.0
/home/zhadainian/.nvm/versions/node/v24.11.0/bin/pi
/home/zhadainian/.nvm/versions/node/v24.11.0/bin
/home/zhadainian/.cargo/bin
/home/zhadainian/.local/bin
...（其余为 cuda/usr 系统目录）

# C. pi 的真实身份与版本
$ readlink -f "$(command -v pi)"
/home/zhadainian/.nvm/versions/node/v24.11.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
$ pi --version
0.85.1
# 包内 package.json（只读）: name=@earendil-works/pi-coding-agent, version=0.85.1,
#   bin.pi=dist/bundle/cli.js, type=module, piConfig.configDir=".pi",
#   exports 含 "./rpc-entry" → dist/bundle/rpc-entry.js（与计划 §3.1 第 88 条一致）
```

### 2.3 结论与缺口

1. **远端已安装 pi**（nvm 全局 shim，0.85.1），node v24.11.0 满足计划 §4.2 的 LTS 门控（`docs/remote-development-plan.md:188`：22.x 或 ≥24 偶数线）。**Node 主版本门控可过**。
2. **版本门禁是本机最现实的第一个 blocker**：计划 §3.1 自己核验的最新正式 Release 是 **0.87.1**（`docs/remote-development-plan.md:75`），而真机是 **0.85.1**；本机开发机上的 pi 是 **1.0.4**（`where pi` → `D:\nodejs\npm-global\pi`）。因此需要一张**明确的兼容矩阵**（最低/最高/超范围）与 fail-closed 行为，且"PiDeck 不静默安装或升级远端 pi"（`:190`）。
3. PiDeck 的 pi RPC 入口是 `pi --mode rpc`（`src/main/pi/PiProcess.ts:317`），远端包也导出 `./rpc-entry`（真机 package.json 证据）——但**本次没有在远端实际启动过 RPC**，这是"无证据"项（见 §6.1）。
4. 真机的 `~/.pi/agent/` 结构（只读 `ls`）：`auth.json(0600, 未读取内容)`、`models.json`、`models-store.json`、`settings.json`、`trust.json`、`sessions/`、`prompts/`、`skills/`、`configs/`、`bin/`、`npm/`、`_bak/`；`sessions/` 下 9 个项目目录、**28 份 `.jsonl`**（形如 `--mnt-data-zhadainian-model--/2026-08-10T09-42-41-275Z_<uuid>.jsonl`）。这既证明 Phase 3 的会话扫描有真实数据面，也证明 **Phase 4 的"恢复"有真实的 JSONL 可依**。

---

## 3. 问题 2：通道设计（本任务的核心分歧）

### 3.1 控制 helper 今天到底提供什么（冻结事实）

| 事实 | 证据 |
| --- | --- |
| helper 是**一个内联冻结字符串**，按内容寻址部署成 `helper.mjs`；bundle 清单是**单文件** | `src/main/remote/RemoteHelperEntry.ts:56-74`、`src/main/remote/RemoteBootstrapDeployment.ts:20-34` |
| 协议是**纯请求/响应**：客户端只按 id 匹配 pending 表；**没有服务端主动推送**，未知 id 的帧只记为诊断并丢弃 | `src/main/remote/RemoteControlClient.ts:474-478`（`unknownId` / `duplicateResponse` 分支） |
| 单帧上限 8 MiB；文件正文分块 ≤1 MiB（base64 计入帧） | `RemoteHelperContract.ts:17, 33` |
| 并发 4 in-flight + 64 等待室，超出 `TOO_MANY_REQUESTS`；新增 method 必须声明是否占槽 | `RemoteHelperContract.ts:35,93`；冻结体（task-7 起 `fs.searchNames` 占槽并在分片间让出事件循环） |
| 每请求 deadline 由 helper 自 clamp，**上限 300 秒**；main 侧同一值 | `RemoteHelperContract.ts:36-37`、`RemoteControlClient.ts:182` |
| 每个请求**最多一个 terminal response**；cancel 未进 commit point 时目标恰好一次 `REQUEST_CANCELLED` | `RemoteHelperContract.ts:71-79`；`RemoteControlClient.ts:236-243, 570-580` |
| helper **只加载 `node:fs` 与 `node:path` 两个 builtin**，冻结体注释明写 "no child process" | `tests/remoteHelperEntry.test.mjs:417-421`（断言恰好两个）、`RemoteHelperEntry.ts:68` 冻结体首段注释 |
| helper 的 `--root` 是**每连接一个目录**（未给则 host-only，所有 `fs.*` 返回 `PATH_OUTSIDE_ROOT`） | `RemoteHelperCommand.ts:26-43, 88-107`；冻结体 root 段 |
| hello 上报的 `capabilities` **今天没有任何消费者**（只校验它是数组） | `SshConnectionAttempt.ts:214`；全仓 `grep capabilities src/main/remote` 仅此一处 + 契约定义 |
| SSH 子进程的**硬超时上限 120 秒**，超时即 `terminate("timeout","force")`；控制会话就按这个上限启动 | `SshProcessLauncher.ts:29-42, 169, 291-298`；`SshConnectionAttempt.ts:126-127, 279` |
| SSH 子进程退出后由连接状态机按 1s/2s/5s/10s/30s 退避重连，最多 5 次 | `RemoteHostConnectionTypes.ts:71-72`、`SshConnectionManager.ts:174, 391-401, 459` |
| 计划原文：控制 helper **"不部署可脱离 SSH 独立存活的 daemon"**；Agent 通路**每 Session 一个独立 SSH 子进程**，"实际 Pi RPC 不经过控制协议" | `docs/remote-development-plan.md:155-173, 501-516` |

### 3.2 分歧点

- **计划 §4.1/§7.2**：Agent 通路 = 独立 SSH + runner；helper 只扩 `runtime.probePi`/`runtime.preparePi`（探测类）与 `artifact.*`（安全快照等有界文件）。
- **本任务交代的前提**："做 Phase 4 必然要扩 helper 协议……需要哪些新 op（进程启动/写 stdin/读 stdout/信号/退出）"。

两者不是措辞差异：把 pi 托管进 helper 会**改变控制协议的语义类别**（从"无子进程的有界文件服务"变成"进程监督者"）。下面把两条路都设计完整，并给出推荐与代价。

### 3.3 方案 A（推荐）：Agent 通路独立 SSH + runner，helper 不托管进程

**形状**（对齐 `docs/remote-development-plan.md:163-171`）：

```text
main ── ssh -T <pinned invocation> ──> [远端 login shell] ──> <node> <runner.mjs>
                                                   │  stdin/stdout = 我方握手帧
                                                   └─ spawn(pi, ["--mode","rpc", ...], { cwd, shell:false, detached:true })
                                                        stdin/stdout 交接给 main（此后只跑 Pi 原生 JSONL）
```

**与本地 `PiProcess` 的接口**（计划 §6.2 已定义，`docs/remote-development-plan.md:379-405`）：

```ts
export interface PiSpawnHandle { stdin: WritableStream; stdout: ReadableStream; stderr: ReadableStream; pid?: number; stop(reason: "abort"|"restart"|"shutdown"): Promise<void>; onExit(listener): () => void }
export interface PiRuntimeLauncher { launch(request: PiRuntimeLaunchRequest): Promise<PiSpawnHandle> }
```

- `PiProcess` 已有 `--mode rpc`、`--session <path>`、trust flags、资源白名单、`PIDECK_SECURITY_CONFIG` 注入与 spawn（`PiProcess.ts:317, 380-381, 405, 656-657, 681`）；拆出 `PiSpawnHandle` 后这些能力**不复制**，只把"进程从哪来"换成 launcher。
- 解析侧完全复用 `PiRpcClient`：8 MiB 行上限、大行 `setImmediate` 延后 parse、按 id 的 pending 表（`PiRpcClient.ts:20-25, 50-79`）。**不需要** helper 的二次分帧。

**runner 的职责与硬要求**（最小化，只做进程与握手）：

| 要求 | 理由 / 证据 |
| --- | --- |
| 固定入口 + 固定 argv；cwd/Pi 参数/用户文本**不进**远端 shell command | `RemoteHelperCommand.ts:5-18` 的同一条纪律；计划 `:166` |
| 首帧初始化（cwd、Pi argv、nonce）→ 独占消费一帧 ready/error；**握手换行后的同 chunk 字节必须保留** | 计划 `:167`；对应 `SshConnectionAttempt.ts:64-75` 的"先注册 stdout 再等帧"既有教训 |
| `spawn(pi, args, { cwd, shell: false, detached: true })`，记录 `pgid = child.pid` | 计划 `:168` |
| 先原子写 + fsync 带 nonce/pid/pgid/进程启动标识的 lease，再发 ready；退出时 `TERM → 有界等待 → KILL -pgid`，确认回收后删 lease | 计划 `:169`；`RemoteBootstrapContract.ts` 已有同样的 lease/锁身份校验模式 |
| 监听 stdin EOF / SIGHUP / SIGTERM，执行同一清理流程 | 计划 `:170`；helper 冻结体对 EOF 的处理是同一哲学（stdin EOF 立即退出） |
| runner **不承载业务语义**（不解析 Pi 消息、不做会话/工具行为） | 计划 `:171` |

**这条路需要的 helper 扩展（仍然有，但都是有界"文件/探测"op，不是进程托管）**：

1. `runtime.probePi`（可**暂不做**：pi 定位可按 `RemoteNodeDiscovery` 的方式由 main 走 `SshClientRuntime` 短命令完成，`RemoteBootstrapSession.ts:3-5` 就是现成范式）。若要做进 helper，形状建议：
   ```ts
   // params: {}  → result: { piCommand: string; piVersion: string; nodePath: string; nodeVersion: string; supported: boolean; reason?: "PI_UNRESOLVED" | "PI_TOO_OLD" | "PI_TOO_NEW" | "NODE_UNSUPPORTED" }
   ```
   约束：只回答**绝对路径 + 版本字符串**；不返回 stderr 文本；解析规则与 `RemoteNodeDiscovery` 同源；超时 ≤ 5s；失败一律 fail-closed（不猜测路径）。
2. `artifact.create / artifact.writeChunk / artifact.commit / artifact.remove`（计划 §7.2 已列）：用于把 main 生成的**脱敏安全快照**写到远端 `0600` 的 runtime artifact 根，launch plan 只传 **remotePath**（计划 `:411`：`PIDECK_SECURITY_CONFIG` 必须指向远端路径，禁止把本机路径传给远端）。这是**有界文件 op**，与 `fs.*` 同族，能保持 1.6.0 的全部不变量。
3. （Phase 4 后半段）`session.*` 存储 op 与 `config.*`：属计划 §7.2 已声明的范畴，同样有界。

**结论**：走方案 A 时，**"最小端到端会话"（新建 → 发送 → 流式 → 停止 → 重启恢复）可以零新增 helper op 起步**；helper 的扩展发生在 Phase 4 后半段的安全快照/生命周期，且全部保持请求/响应 + 有界文件语义。

### 3.4 方案 B（备选，也是 lead 前提）：把 pi 托管进 helper

若 D1 决定必须复用控制连接，则 helper 需要新增一族**进程托管 op**。下面给出可实现的形状，同时列出**必须同时改的 7 处不变量**——它们不是实现细节，而是冻结契约的一部分。

**op 设计（建议命名与语义）**

| op | params | result | 语义要点 |
| --- | --- | --- | --- |
| `proc.start` | `{ cwd, argv: string[], env?: Record<string,string>, nonce }` | `{ procId, pid, pgid }` | `spawn(argv[0], argv.slice(1), { cwd, shell:false, detached:true, env: 白名单合并 })`；`cwd` 必须经既有 `readTargetPath` + root containment（复用 `fs.*` 的校验，禁止绝对路径/越界/反斜杠/控制字节）；`argv` 每项 ≤4 KiB、总长 ≤64 KiB、禁 NUL；env 只接受白名单键（否则 `PROC_ENV_INVALID`） |
| `proc.write` | `{ procId, data }` | `{ bytes }` | 单次 ≤256 KiB，写入子进程 stdin；进程已死返回 `PROC_GONE`；不缓冲无界数据 |
| `proc.read` | `{ procId, maxBytes?, waitMs? }` | `{ data, eof }` | **长轮询**：有数据立即返回，无数据最多等 `waitMs`（clamp ≤ 5s）；每次 ≤256 KiB；**不得跨帧丢字节**（见 B2"行边界"） |
| `proc.signal` | `{ procId, signal: "TERM" \| "KILL" \| "INT" }` | `{ ok }` | 只发信号给 `-pgid`，不等待 |
| `proc.stop` | `{ procId }` | `{ ok }` | `TERM → 有界等待 → KILL` 的组合，幂等 |
| `proc.status` | `{ procId }` | `{ state: "running" \| "exited", code?, signal?, pidAlive }` | 退出后保留结果直到 reap |
| `proc.reap` | `{ procId }` | `{ ok }` | 释放句柄与缓冲；幂等 |
| `proc.list` | `{}` | `{ procs: [{ procId, pid, cwd, startedAt }] }` | 供 main 在重连后判断孤儿；**重连后 main 必须先 list 再决定接管/清理** |

**必须同时改的 7 处不变量（方案 B 的真实代价）**

| # | 冲突 | 证据 | 需要的改动 |
| --- | --- | --- | --- |
| B1 | 协议**没有服务端推送**：pi 的流式事件只能靠 main 轮询或新增通知帧 | `RemoteControlClient.ts:474-478` | 二选一：(a) 长轮询（保持请求/响应，但空闲也会持续发请求，且受 300s clamp 约束）；(b) 新增 `{type:"event"}` 通知帧方向 → **改控制协议语义**，需 client 新增订阅、generation/hostId fencing、去重与丢弃规则 |
| B2 | 帧上限 8 MiB 且"声明单帧语义的方法必须自带上限"；pi 的 `get_messages`/`bash` 输出可能很大 | `RemoteHelperContract.ts:17, 27-33`；计划 `:497` | `proc.read` 必须分块 + **行边界重组**：main 侧要重新实现"半个 JSON 行"的拼装（`PiRpcClient` 会拒超大行，`PiRpcClient.ts:25`），或 helper 负责按行切片并在超长行时 fail-closed |
| B3 | 并发槽 4 + 等待室 64 是**全局共享**的：一个长轮询占槽，多会话 + `fs.*` 会互相队头阻塞 | `RemoteHelperContract.ts:35,93`；计划 `:498`（长传输不得队头阻塞短请求） | 要么给 `proc.read` **单独的不占槽通道**（等于承认它是另一条协议），要么把并发槽改成"每 Session 一槽"，两者都改冻结语义 |
| B4 | 每请求 deadline 上限 300s，而 Agent 会话是**小时级**；长轮询必须反复短请求 | `RemoteHelperContract.ts:37`、`RemoteControlClient.ts:182` | 长轮询只能用 ≤5s 的 `waitMs` + 密集轮询：空转请求量 ≈ 180 req/min/Session，且每次都要过 pending 表与帧解析 |
| B5 | 控制 SSH 会话**最多活 120 秒**：helper 被强杀 → 子进程 pi 连带被杀 | `SshProcessLauncher.ts:29-42,291-298`、`SshConnectionAttempt.ts:126-127,279` | 必须新增"无 deadline"的 launcher 模式（同时重新论证 `maxOutputBytes` 与背压） |
| B6 | helper 冻结体的自我约束："no child process"、只加载两个 builtin、EOF 即退出 | `RemoteHelperEntry.ts:68` 冻结体注释、`tests/remoteHelperEntry.test.mjs:417-421` | 必须**刻意**改三处：加载 `node:child_process`、把"无子进程"改写为"有界子进程托管"、把 EOF 语义改为"杀进程组后退出"；源变化 → build/sha/清单全变（§3.5） |
| B7 | helper 的 `--root` 是**每连接一个**目录；多项目 = 多 root，B 想省的连接数并不真的省下来 | `RemoteHelperCommand.ts:26-43`（`--root` 单值） | 除非先做 §7.2 的 `root.register` 多 root 机制，否则每个项目仍要独立 helper |

**方案 B 的失败模式**（需要在设计评审里明确接受才可走）：pi 子进程死循环/刷屏 → 控制事件循环被 stdout 分帧拖慢甚至 OOM，**同一主机上的文件浏览/Git/Session 请求一起受害**；一个会话的异常输出污染整台主机的控制通道。方案 A 天然隔离（每 Session 独立 ssh 进程）。

### 3.5 版本与 sha 冻结策略（无论 A/B 都要定）

**真机证据：内容寻址部署链是活的、可核对的**（只读 `sha256sum`）：

```text
~/.pideck/remote-host/bundles/<bundleSha256>/helper.mjs
5a46222d…→ helper.mjs sha256 = 66b041d2675f9276f0ea03a29ed0f3d34a261fc2184546cb95c6928ca4fc538f  （helper build 1.6.0，= 仓库当前冻结体）
da66adca…→ 01a2505c7f18ac2b45cd42bfda61d16a3fe867da3995d6eb1ee6ab6eb7ceca05  （helper build 1.5.0）
7d6bd77f…→ 8c5681ea396f91b61d0a67b62e656d35d8b21db46da9278fcb2a32666787cc9a  （helper build 1.4.0）
```

三点结论：
1. **远端已有三份历史 bundle 共存**，且最新一份与仓库 `REMOTE_HELPER_ENTRY_SHA256` **逐字节一致**——前几批的真机链已把 1.6.0 部署上去了。这为"新增 op = 新 bundle = 可回滚"提供了现成机制（计划 §4.2 `:184` 的保留策略）。
2. 因此 **helper 冻结策略不需要新机制**：每次源码变更 → 版本号 + sha + 新 bundle 地址（`RemoteHelperEntry.ts:50-52`、`RemoteBootstrapDeployment.ts:20-34`）；部署走既有 bootstrap/manifest。
3. 但**能力协商今天是空的**：`hello.capabilities` 没有任何消费者（§3.1 证据），Phase 4 必须在 main 侧引入**显式 gate**，建议：
   - 契约新增 `REMOTE_HELPER_REQUIRED_CAPABILITIES`（feature → capability 列表），例如 `{ phase4Runtime: ["runtime.probePi", "artifact.create"] }`；
   - 连接 attempt 的 `assertHelperHandshake` 之后加一步 capability 检查（`SshConnectionAttempt.ts:196-234` 现只验 protocolVersion/root）→ 缺能力返回结构化码（`SSH_HELPER_CAPABILITY_MISSING`）并进入既有 needs-attention/degraded 语义，**不降级成 METHOD_NOT_FOUND 才发现**；
   - `REMOTE_HELPER_ENTRY_VERSION` 只在"需要按 build 判定"的场景使用（manifest/UI 展示），**兼容判据用 protocolVersion + capability 集合**，不要用版本号字符串比较；
   - 另：今天所有 SSH 会话被 120s 硬超时（§3.1 表），所以"长活 helper"本身也是 Phase 4 的既定改动面。

**冻结纪律（对每个新增 op 的硬要求，沿用 task-7 `fs.searchNames` 的做法）**：契约常量 + 冻结体字面量 + 红测试（真实子进程 / 真实 root）+ 上限与截断语义 + 取消语义 + sha/版本同步 + biome。禁止"先上 op 再补测试"。

---

### 3.6 D2：lifetime 分档（`command` | `session`）——**task-33 已实施**

**现状（可执行证据）**：控制会话的 launcher 请求是 `timeoutMs: SESSION_DEADLINE_MS = SSH_LAUNCHER_MAX_TIMEOUT_MS = 120_000`（`SshConnectionAttempt.ts:126-127,279`），launcher 对任何请求的 `timeoutMs` 都 clamp 到 120 s 并在到点后 `terminate("timeout","force")`（`SshProcessLauncher.ts:29-42,169,291-298`）⇒ 任何"应该活过 2 分钟"的会话都会被强杀。这条发现已被固化成可执行证据：`tests/sshLongLivedSessionDeadline.test.mjs`

| 用例 | 证明什么 |
| --- | --- |
| `a live child is force-killed at the 120 s ceiling…` | 请求 10 分钟 → 实际武装的定时器就是 120000 ms；到点 `SIGKILL`、退出报告 `{kind:"timeout"}`（注入计时器，确定性） |
| `the deadline is wall-clock, not a liveness check…` | 一个持续应答的正常会话被同样杀掉 ⇒ 现有机制不是"心跳/空闲"判据，任何"它还在输出所以应该活着"的直觉都不成立 |
| `the connection machine answers that kill with a backoff reconnect and never re-sends the request…` | 连接机记录 `SSH_CONNECTION_TIMEOUT`、进入 `reconnecting`、武装退避第一档 1 s、在途请求以稳定码失败且**不重发** |
| `REAL: a genuine long-lived process is killed at the same 120 s ceiling`（opt-in：`PIDECK_SSH_DEADLINE_REALTIME=1`） | 同一个结论对**真实长活进程**再测一遍（约 125 s，故意默认跳过以免拖慢每次运行） |


**实施记录（task-33，已落地）**

- **契约**：`SshLauncherRequest` 新增可选 `lifetime: "command" | "session"`（`RemoteHostConnectionTypes.ts`，缺省即 `command`，即"不写就是今天的行为"）。
- **launcher**：`command` 档逐字节不变（默认 30 s、clamp 120 s、到点强杀）；`session` 档**不武装任何 deadline 定时器**，只保留 `stop` 配对收敛（`TERM → killTimeoutMs → KILL`）、spawn 失败、`maxOutputBytes`/`maxLineBytes` 越界、ssh 自身退出。`lifetime: "session"` 与 `timeoutMs` 同时出现会被**直接拒绝**（`SSH_LAUNCHER_REQUEST_INVALID`）：隐藏的 wall-clock 比没有更糟（调用方会以为会话有界）。
- **控制会话**：`SshConnectionAttempt` 现在传 `lifetime: "session"`、不再传 `timeoutMs`；握手仍有自己的本地 deadline（`handshakeTimeoutMs`），会话的真实边界 = 输出预算 + ssh keepalive + 配对 release 路径。
- **ServerAlive（不依赖用户 ssh_config）**：**已经**由 PiDeck 自己显式写进 pinned argv —— `SshCommandBuilder.ts:134-136` 的 `-o ServerAliveInterval=15` / `-o ServerAliveCountMax=3`，命令行的 `-o` 覆盖用户 `ssh_config`；strict 校验还强制生效值必须是 15/3（`SshVerifiedConnection.ts:97-98`，反例见 `tests/sshVerifiedConnection.test.mjs:273` 的 `serveraliveinterval 0`）。task-33 补的是**断言**（`tests/sshLongLivedSessionDeadline.test.mjs` 钉在 builder 输出上：三种 kind 的 argv 都含这一对）。机制与边界：15 s × 3 次未应答 ≈ **45 s** 是发现"对端已停止响应"的时间上界；它是**链路**存活判据，不是任务进展判据。
- **心跳**：候选 2 的"心跳仅诊断"**本任务未实施**（需要 runner，属 P4.2）；当前 session 档没有任何活性终止判据，进程只按上面的四条路径结束。
- **候选 3（调大上限）拒绝进生产**：不提供任何放宽 `SSH_LAUNCHER_MAX_TIMEOUT_MS` 的开关；`command` 档仍是 120 s 上限（断言锁住），`session` 档是"无期限"而不是"更大的期限"。
- **测试（红→绿都留档）**：`tests/sshLongLivedSessionDeadline.test.mjs` —— session 档"没有任何 deadline 被武装"、"输出/行预算仍致命"、"session+timeoutMs 被拒"、command 档三组有界断言、连接机 session 档 + 配对清理（stop → SIGKILL → 收敛）+ 不重发、argv keepalive 断言；opt-in 真实用例证明真实 session 进程活过 120 s。

**必须保持的不变量（无论选哪个候选）**

1. **一次性短命令仍必须有界**：探针、远端 node/pi 解析、bootstrap、`SshClientRuntime.run`、`scp` 统统沿用今天的 30 s 默认 / 120 s 上限，绝不因为"长活会话要放开"而一起放开。
2. **失败必须可观测且如实**：任何结束路径都要有稳定码 + 诊断；不允许把"超时"悄悄改成"永远等下去"。
3. **断线不重放 prompt（失败关闭）不得放松**：新的分档/心跳只能影响"进程什么时候被杀"，不得让"未确认的请求"变成"可自动重放"。未确认的 prompt 永远是 `unknown` + 用户确认（§4.3），与 `docs/remote-development-plan.md:893` 的门禁一致。
4. **runner 的 lease 回收语义不变**（`docs/remote-development-plan.md:168-170`）：`TERM → 有界等待 → KILL -pgid`，确认回收后删 lease；孤儿判定同时匹配 nonce + pid/pgid + 进程启动标识，**禁止按裸 pid 杀**。
5. **输出与背压边界不放松**：`maxOutputBytes`（默认 64 KiB、上限 16 MiB 的**未消费**字节）与 `maxLineBytes`（8 MiB）继续生效；"长活"不等于"允许无界缓冲"。
6. **连接状态机的退避/终止语义不变**：杀掉一个长活会话仍走 `reconnecting` → 1/2/5/10/30 s 阶梯 → 5 次后 `needs-attention`。
7. **本地（非远端）行为零变化**：这一档只作用于远端 ssh 会话。

**候选 1（lead 已拍板、task-33 已实施，见上）：按用途分档 —— command 档保持现状，session 档不设 wall-clock 期限**

- 形状：`SshLauncherRequest` 增加显式 `lifetime: "command" | "session"`（默认 `command`，即"不写就是今天的行为"）。
  - `command`：默认 30 s、上限 120 s，到点强杀 —— 逐字节保持现状。
  - `session`：launcher **不武装 wall-clock deadline**；进程只在以下情况结束：显式 `stop/abort/shutdown`、spawn 失败、`maxOutputBytes`/`maxLineBytes` 越界、ssh 自身退出。
- 为什么是这一档：它把"谁拥有生命周期"讲清楚 —— **会长活的进程由 owner（连接机 / runner+lease）负责收敛，短命令由 launcher 兜底**，而不是让一个通用超时同时承担两种职责。
- 与 runner lease 的衔接：runner 是 `session` 档进程的 owner（先写 lease 再 ready；退出/信号时按 `TERM → 有界 → KILL -pgid` 回收）；launcher 只保留 `stop` 引发的有界收敛（`killTimeoutMs`）与输出边界。
- **防不住什么**：
  - **卡死的会话不再被自动清理**：如果上层忘了停（bug、或 PiDeck 自己崩了），ssh 进程会一直挂着。缓解：连接机关闭/退出路径必须逐条配对 `stop()`（现有 `releaseSshAttempt`/`dispose` 已是这个形状），并补一条"上层不 stop 就会泄漏"的反例测试。
  - **半开链路（TCP 黑洞）**：远端已经没了，ssh 进程却既不退出也不报错，"活着但无用"。这条今天由 ssh 自己的 `ServerAliveInterval/ServerAliveCountMax` 兜底 —— strict 配置里是 `serveraliveinterval 15` + `serveralivecountmax 3`（`tests/helpers/sshPinnedHostFixture.mjs:52`）≈ 45 s 无响应后 ssh 退出；但**非 strict 路径依赖用户 ssh_config**，必须核实并（建议）由 PiDeck 强制写死，否则"不设期限"在黑洞网络下会变成永久悬挂。
  - **无限刷屏**：`maxOutputBytes` 只统计**未被消费**的字节；消费者正常读取时总量仍然无界。缓解：session 档需要额外的"每会话总字节/速率配额"或周期性 backpressure 判定，否则内存与带宽可能被一个疯跑的 agent 拖垮。
- 需要的证据：`command` 档现有测试逐条不动（回归即证据）；`session` 档一条"超过 120 s 仍存活"的绿灯（注入计时器断言"没有任何 deadline 定时器被武装" + opt-in 真实测量）；黑洞链路用 ssh ServerAlive 的真实/注入证据；刷屏配额边界测试。

**候选 2：心跳 / lease 续期（把绝对期限换成滑动空闲窗口）**

- 形状：保留"会杀"，但判据从"活过 120 s"改成"**连续 N 秒没有任何证据**"：证据 = 成功读到一个 stdout 帧 / 成功写入一帧 / runner 周期 heartbeat（launcher 侧把 `timeoutMs` 解释为 idle window 并在每次活动时重置）。runner 用 lease + 周期心跳证明"我还在、进程组还在"。
- **防不住什么**：
  - **"活着但卡死"会永远续期**：agent 长时间思考、长工具调用、慢模型流都会持续产出或至少持续心跳，窗口形同失效；反过来把窗口设小就会**误杀合法长任务**（例如一个跑 10 分钟的 `bash` 工具调用）。这是"要么无界、要么误杀"的两难。
  - 心跳只证明**协议层**活着，不证明**任务在推进**：适合做 UI 健康指示，不适合作为唯一终止判据。
  - 半开链路同样解决不了（与候选 1 同一条：要靠 ssh `ServerAlive`）。
- 定位：适合作为**可观测性/诊断**叠加在候选 1 之上，不适合单独替代硬超时。

**候选 3（仅过渡）：把上限从 120 s 提到"会话级"（如 30 分钟 / 6 小时）**

- 改动最小、语义不变；但只是把强杀**推迟**，长会话仍会在半途被掐断，Phase 4 的"长稳"门禁依然不成立。
- **防不住什么**：任何超过新上限的健康会话；以及"越界强杀"本身造成的"用着用着突然断"体验。
- 定位：如果 D2 需要时间拍板，可以先把它当**明确的临时护栏**（并写清"这是过渡，不是设计"），不作为新语义。

**拍板结果（lead）**：候选 1 已实施（task-33）；候选 2 的心跳只作为**诊断/UI**、留给 P4.2 与 runner 一起做；**候选 3（调大上限）明确不进生产** —— 它只推迟强杀，会让「长稳」看起来成立，比没有更糟。ServerAlive 无需新增参数（生产早已显式强制，见上面的实施记录），task-33 补的是断言 + 机制说明。


### 3.7 capability gate（task-32 已接线，可执行）

§3.1 指出 `hello.capabilities` 当时没有任何消费者。task-32 已把最小、additive 的接线落下（`src/main/remote/SshConnectionAttempt.ts` + `SshConnectionManager.ts` 的 FATAL_CODES 一行）：

- **必需集合**（每个 ready 主机都会被用到的只读批次）：`fs.stat` / `fs.list` / `fs.read`。缺任何一个 ⇒ 会话**不进 ready**，直接 `needs-attention`，终态码 `SSH_HELPER_CAPABILITY_MISSING`，**不重试**（能力不会因为重连而出现）。
- **精确诊断**：每个缺失操作各有一条稳定码，用户据此知道缺什么：`SSH_HELPER_CAPABILITY_MISSING_FS_STAT` / `_FS_LIST` / `_FS_READ`（诊断记录只允许稳定码，不放自由文本）。
- **可行动**：远端 helper/runner 是**内容寻址部署**的（真机三份 bundle 证据，§3.5），能力错配几乎总是"客户端比远端新"⇒ 正解是**重新部署/升级远端 bundle**，不是网络排查、也不是重试。UI 文案与 i18n 属于后续集成批次。
- **additive**：未知能力（未来 op）不拒绝；`capabilities` 不是数组时保持既有 `SSH_HELPER_HANDSHAKE_INVALID` 行为。`fs.searchNames` 等可选能力**不在必需集合**里：缺它的主机仍然可用，需要它的功能层必须自行降级（后续应把能力集合经 manager 暴露给功能层，本任务未做）。
- 证据：`tests/sshHelperCapabilityGate.test.mjs`（缺任一必需 op ⇒ 不 ready/needs-attention/不重试/点名诊断；能力完整或含未知能力 ⇒ ready；能力非数组 ⇒ 沿用既有拒绝）。


## 4. 问题 3：生命周期与恢复

### 4.1 断线时远端 pi 怎么办：杀 / 留 / 接管

| 策略 | 评价 | 依据 |
| --- | --- | --- |
| **杀（推荐）**：ssh 进程退出 = runtime 退出；runner 按 `TERM → 有界 → KILL -pgid` 回收；helper 侧（若 B）在 EOF 时做同一件事 | 与现有本地语义一致；无孤儿；无需长期持有 lease；恢复靠 JSONL | 计划 `:161,169-171`；helper 冻结体 EOF 语义 |
| 留 + 重连接管（detached + lease 重连 attach） | **与计划冲突**：计划明确"不部署可脱离 SSH 独立存活的 daemon"；且需要"重连后如何把 pi 的 stdout 重新接上"的机制（stdout 是管道，进程活着但读者已断 → 必须由常驻 broker 持有，等于第二条通道） | `docs/remote-development-plan.md:157` |
| tmux/nohup 兜底 | 引入远端额外依赖与"谁清理"的新问题；计划未收录 | — |

**推荐落地**：杀 + **从远端 JSONL 恢复**。真机上 28 份 `~/.pi/agent/sessions/**/*.jsonl` 就是恢复面（§2.3 证据）；重连后由 `SessionRuntimeCoordinator` 触发 `activateRuntime` → 新 launcher 实例 → `--session <远端 session 文件>`（`PiProcess.ts:380-381`）。

### 4.2 sessionId 连续性与 runtimeGeneration

- **复用本地方案，不发明新机制**：
  - `sessionId` 由本地 `SessionCatalog` 拥有（远端只提供 locator/ref，helper 不生成 `SessionRecord.id`，计划 `:528`）；
  - 每次 launcher 重建先 `bind()` 递增 `runtimeGeneration` 再发布状态（`SessionRuntimeCoordinator.ts:454,480`；计划 `:405`）；
  - 事件与命令的 fencing 已存在：主进程按 `sessionId + agentId + runtimeGeneration` 校验（`SessionRuntimeCoordinator.ts:910,964`），renderer 侧同样丢弃旧 generation（`src/renderer/src/atoms/session-atoms.ts:1075,1100-1115,1471-1472`）。
- **远端需要新增的只有"传输层生死判定"**：一段 `SshProcessExit` → 该 runtime 的 `stop/lost` 终态；**不要**把它折进 host 连接状态（`RemoteHostConnectionTypes.ts:3-8` 明确"host ready ≠ agent ready"）。**双层 generation 不可混用**：控制连接的 `connectionGeneration`（helper 帧 fence）与 runtime 的 `runtimeGeneration`（会话 fence）是两个独立计数。
- **迟到结果**：控制通道迟到帧已被 client 按 hostId/generation/id 丢弃（`RemoteControlClient.ts:464-478`）；runtime 事件走 coordinator fence。因此远端不需要第三套机制，只需要**测试证明**（计划 §14.1 已列 `remoteRuntimeGeneration.test.mjs`）。

### 4.3 "不自动重放 prompt" 的落地

- 计划门禁原文："**永不自动重放未确认 prompt**；重新扫描 Session 后由用户决定"（`docs/remote-development-plan.md:893`）。
- 落地建议：`sendPrompt` 在远端 target 下进入显式 pending 状态机——发出后进入 `awaiting-first-event`；传输死亡时该 prompt 标记 `unknown`（**不是失败、不是成功**），UI 明确提示"远端可能已执行，请确认后重发"；`runtimeGeneration` 递增后旧 `unknown` 记录不得自动重发。
- 与本地差异：本地进程死掉也没有"自动重发"，但本地不会出现"远端可能已执行"的不确定性；远端必须**显式呈现**这一状态（否则等于静默丢 prompt）。

---

## 5. 问题 4：复用面与能力 parity

### 5.1 可直接复用

| 模块 | 复用点 | 证据 |
| --- | --- | --- |
| `SshProcessLauncher` / `SshLauncherHandle` | 长活双向 stdio：`onStdoutLine` / `onStderrLine` / `onExit` / `write` / `stop`；行边界与字节上限已实现 | `RemoteHostConnectionTypes.ts:41-69`；`SshProcessLauncher.ts:162-179` |
| `RemoteControlClient` | 控制通道的 id/deadline/generation fence、单次终态判定 | `RemoteControlClient.ts:99-182, 246-298, 455-493` |
| `SshConnectionManager` / `RemoteHostConnectionService` | 主机级连接、退避重连、`request(hostId, method, …)` 适配面 | `SshConnectionManager.ts:88-96, 649-675`；`RemoteHostConnectionService.ts:413-417, 534-543` |
| `PiRpcClient` | Pi 原生 JSONL 解析（response/event）、按 id pending、8 MiB 行上限、大行延后解析 | `PiRpcClient.ts:20-25, 50-79` |
| `PiLocator` | 登录 shell PATH 合并、候选名、`pi --version` 探测、`createInvocation`、`sanitizePiChildEnv` | `PiLocator.ts:1004-1019, 1022-1040, 302-331, 626` |
| `PiProcess` | `--mode rpc` / 资源白名单 / trust flags / security env / spawn / 进程树清理 | `PiProcess.ts:317-405, 656-657, 681` |
| `SessionRuntimeCoordinator` | session/runtime 唯一 owner、`bind`/generation fence、事件流 | `SessionRuntimeCoordinator.ts:41-146, 454-485, 910, 964` |
| `RemoteNodeDiscovery` | 登录 shell PATH 范式（pi 探测直接照搬） | `RemoteNodeDiscovery.ts:56-83`；`RemoteBootstrapSession.ts:3-5, 21` |
| bootstrap/manifest/部署链 | helper（及未来 runner）内容寻址上传、多文件清单、原子激活、保留策略 | `RemoteBootstrapDeployment.ts:20-34`；计划 `:183-188`；真机 3 份 bundle 证据 |
| `RemoteWorkspaceReader` 的 port 形状 | `{ request(hostId, method, params, { timeoutMs, onRequestId }), cancel? }`——新 op 的 reader 直接照这个形状接 | `RemoteWorkspaceReader.ts:113-140` |

### 5.2 必须新增

| 新增件 | 职责 | 落点建议 | 备注 |
| --- | --- | --- | --- |
| `SshPiRuntimeLauncher` | 每次 runtime 一条 pinned ssh（无 120s 上限）+ runner 握手 + 字节交接为 `PiSpawnHandle` | `src/main/remote/`（与 launcher 同域） | 计划 §6.2 已命名 |
| 远端 `runner`（冻结、内容寻址、可上传） | 只做 ready 握手、`spawn`、进程组回收、lease | 与 helper 同一条 bootstrap/manifest 链（当前 wrapper 是单文件，需扩到多文件或第二份冻结 entry） | **不要**长业务语义 |
| `PiRuntimeLaunchPlan` 远端分支 | location-aware 启动计划；远端 plan 只含远端路径/artifact ref | 计划 §6.2 `:400` | 禁止本机绝对路径出现 |
| `PiProcess` 的 `PiSpawnHandle` 抽取 | 让 spawn 可注入 | 计划 §6.2 `:379-405` | 本地行为必须零回归 |
| Phase 4 后半段：远端 session storage / config backend / artifact | 会话变换、配置、安全快照 | 计划 §6.3/§6.4 | 走 helper 有界 op |
| capability gate（见 §3.5） | 新 op/build 的 fail-closed 判定 | `SshConnectionAttempt` / contract | 今天 capabilities 无人消费 |

### 5.3 能力 parity 表（本地现状 × 远端可达 × 缺什么）

| 能力 | 本地现状（证据） | 远端可达（Phase 4 目标） | 缺什么 / 差异 |
| --- | --- | --- | --- |
| 新建会话 | `SessionRuntimeCoordinator.create` + `PiProcess.start` | 必须 | `SshPiRuntimeLauncher` + runner（§5.2） |
| 发送 prompt | `sendPrompt` → Pi RPC `prompt`（`SessionRuntimeCoordinator.ts:66,294`；AgentManager `type:"prompt"`） | 必须 | 无协议差异（Pi 原生 JSONL 直通）；需"未确认不重放"状态（§4.3） |
| 流式消息 / 工具事件 | `PiRpcClient` event → coordinator → renderer atoms | 必须 | runner 握手期字节保留（计划 `:167`） |
| 停止 / abort | `stop`/`abort`（`SessionRuntimeCoordinator.ts:70-72`）；Pi RPC `abort` | 必须 | ssh 死亡即 runtime 死亡；中断线不得谎报"已停止" |
| 重启 / 恢复 | `restart`（`:69`）+ `--session` | 必须 | 远端 JSONL 路径解析（真机 28 份 JSONL 已验证存在） |
| 模型 / thinking | `setModel`/`setThinking`/`getAvailableModels`（`:84,117-118`） | 必须（per host） | 配置作用域按 host；用远端 pi 自己的 models 配置 |
| compact / fork / edit-resend / export_html | `compact`/`forkSession`/`prepareResendFromMessage`；`export_html`（AgentManager `type:"export_html"`） | 必须（计划 §13） | 活动会话走 Pi RPC；未打开会话导出需临时远端 runtime + artifact（计划 §7.2） |
| UI 交互（ask_question / extension_ui_response） | `sendUIResponse`（`:130`） | 必须 | 无协议差异 |
| 历史读取 | 本地 scanner + `SessionHistoryReader` | 已具备只读（Phase 3 会话发现） | 正文读取属 Phase 4（handoff `:161`） |
| 内置扩展注入 | `-e` + `appendBuiltInExtensionArgs`（`PiProcess.ts:13`） | 必须上传校验快照 | 远端 immutable path；版本门禁 `extensionVersionGate.ts:11,22,29` |
| security gate 快照 | `PIDECK_SECURITY_CONFIG`（`PiProcess.ts:656-657`） | 计划要求（`:411`） | 需 helper `artifact.*`（§3.3 第 2 条） |
| 项目 trust / approve | trust flags（`PiProcess.ts:405`）+ 本地 trust key | 必须 | 统一 `buildProjectTrustKey()`（计划 §6.2 `:413`）尚未实现 |
| 认证 / 登录 | `pi-auth` 例外通道（AGENTS.md） | **首版仅远端终端** | 不复制/不读取 `auth.json`（真机上它存在且 0600；本次未读） |
| 本机路径附件 / 拖入 | 完整 | **v1 禁用** | 明确拒绝，不静默转换（计划 §13 `:808`） |
| checkpoint/rewind、worktree、历史改写、Git clone、用量查询 | 完整/部分 | **v1 禁用** | capability 驱动禁用 + i18n 解释（计划 §13 `:799,804,809`） |
| 终端 / Git 面板 / 浏览器 | 完整 | Phase 5+ | 不在 Phase 4 宣称 |

---

## 6. 问题 5：风险与不可宣称

### 6.1 今天**没有证据**的结论（不得写进验收或发布说明）

1. **远端 `pi --mode rpc` 未被启动过**：真机只做过 `pi --version`。RPC 启动、初始化帧、事件流、长稳全部**未验**。
2. **真实 SSH 链路下的长期稳定性未验**：控制会话今天上限 120s（§3.1 表），任何"能跑几小时"的说法都没有依据。
3. **远端 pi 版本兼容未验**：真机 0.85.1 < 计划核验基线 0.87.1，本机 1.0.4；"0.85.1 可用"没有实测支撑。
4. **并发/多会话未验**：多 Session = 多 ssh 进程，真机连接数、sshd `MaxSessions`、退避重连互相叠加的行为无数据（计划 §15 `:908` 明确列为 Phase 4 阻塞项）。
5. **延迟预算未测**：计划要求的 50ms RTT fixture（终端 ≤150ms、文件树 ≤2s、会话首屏 ≤3s，`docs/remote-development-plan.md:764`）没有任何实测。
6. **远端磁盘压力是真实风险**：真机 `df -h ~` = 468G 中已用 404G（**91%**），剩 41G。bundle/artifact/TTL 的保留策略必须考虑该现实（§8 证据）。
7. **POSIX symlink 逃逸未验**（handoff `:220` 已记录）：本机是 Windows，Phase 3 的越界拒绝是词法+规范化判据。

### 6.2 风险（与计划 §15 对齐，只列 Phase 4 新增判断）

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 通道选型走错（B） | 控制 helper 变成进程监督者后，一个会话的刷屏/死循环会波及同主机的文件/Git/Session 请求（§3.4 失败模式） | 采用方案 A（进程隔离） |
| 120s 硬超时被忽略 | 任何长活会话每 ≤2 分钟被强杀，Phase 4 门禁无法成立 | D2：Phase 4 第 0 步修 launcher 的 deadline 策略 |
| runner 变成"事实上的第二条协议" | runner 一旦承载业务语义，就要跟 pi 版本一起演进 | runner 只做握手/进程组/lease；文档写明"可整体删除" |
| prompt 不确定性被静默 | 断线时用户以为没发出去 / 以为发出去了 | §4.3 的 `unknown` 状态 + UI 文案 + 测试 |
| 版本门禁做成字符串比较 | 真机与本地跨度大（0.85.1 vs 1.0.4） | 用 protocolVersion + capability + 兼容矩阵（§3.5） |
| 部署链被 Phase 4 打乱 | 新 runner/helper bundle 与多会话并存 | 复用既有 bundle 保留/lease（真机 3 份 bundle 已是现状） |

### 6.3 发布边界（照抄计划，不得放宽）

计划 §12 原文（`docs/remote-development-plan.md:674`）：Phase 4 **只允许邀请制/显式实验开关 beta**，并在 UI **持续标记**文件写入、Git 与终端尚未可用。Phase 4 门禁（`:764`）还要求在 50ms RTT 参考链路上记录核心交互延迟并与初始预算对照——**超预算先做传输/并发/连接复用优化，不得绕过**。本页任何"分阶段建议"都不减少这些门禁。

---

## 7. 分阶段落地建议（每步都有可验收的证据）

> 原则：把"通道"与"版本门禁"这两件最容易返工的事放在最前；每一步都要求**真实子进程/真实主机**级证据，不以单测代替。

**P4.0 前置与护栏（不动会话功能）**
- 内容：**已落地** —— launcher 的 `lifetime` 分档（§3.6）+ capability gate（§3.7）；**接口抽取（本地实现）也已落地** —— `src/main/pi/PiSpawnHandle.ts`（`PiRuntimeExit` / `PiRuntimeLaunchPlan`（含 `kind` 位置判别式）/ `PiSpawnHandle` / `PiRuntimeLauncher`）与 `src/main/pi/LocalPiRuntimeLauncher.ts`；`PiProcess` 改为 `await runtimeLauncher.launch(plan)`，`proc` → `handle`（`start/stop/isRunning/pid/退出中止` 全部转接）。**剩余**：把「卡死会话」的收敛责任交给后续 runner/lease（属 P4.2，远端侧才存在）。
- 与计划文本的一处偏差（已记入模块注释）：计划给的接口只有 `onExit`，但 Node 的 spawn 失败**只发 error 不发 exit**，而仓库靠这个区分做启动失败归因（`diagnostics.spawnFailed`），因此 handle 额外提供 `onSpawnError`（并对晚注册者重放一次，收紧原竞态）。
- 验收证据：`tests/piRuntimeLauncher.test.mjs` 9/9（spawn 选项逐字段、非法 plan 零 spawn、同步/异步失败、Unix/Windows 停止顺序、stop 幂等、**真实子进程**的退出码与 SIGTERM 回收）；4 个 `tests/piProcess*.test.mjs` 34/34（含把仍有手写 vm 沙箱的四个文件迁到 `createTsSandbox` 后断言逐字不变）；Electron 冒烟 `e2e/smoke.spec.ts` 1 passed；`e2e/agent-flow.spec.ts` 3 failed 在**干净基线上同样红**（既有环境/夹具问题，与本次无关）。
- 不做：任何 helper op、任何远端 pi 启动。

**P4.1 远端 pi 探测与兼容矩阵（只读）——已落地**
- 内容：`src/main/remote/RemotePiDiscovery.ts`：登录 shell 只读 PATH（复用 `RemoteNodeDiscovery` 的哨兵范式，目录判定收口到新的 `listToolCandidatesFromPath`）→ 候选 → 逐候选 `--version`（有界，`MAX_PI_CANDIDATES = 3`）→ 数值化比较的分类。**版本命令的形态是 `'<已解析 node>' '<pi>' '--version'`**：真机实测 nvm 的 `pi` 是 `#!/usr/bin/env node` shim，非交互 SSH 的 PATH 只有系统 node v12.22.9 ⇒ 裸执行在 pi bundle 首条语句 SyntaxError（exit 1、stdout 空），登录 shell 包装能绕过但会把 `~/.bashrc` 横幅混进 stdout。**P4.2 的远端启动必须复用同一形态**（`buildRemotePiVersionCommand` 的注释里写明了）。
- 真机证据（只读；`serve`；`scripts/verify-remote-pi.mjs`）：

```text
$ node scripts/verify-remote-pi.mjs 10.81.2.15 <user> <独立核验指纹>
HOST_HANDSHAKE_OK HOST 10.81.2.15:22 USER <user> DIGEST <每次不同> FP SHA256:…
SSH_CLIENT /usr/bin/ssh
OPENSSH OpenSSH_10.0p2
NODE_OK /home/<user>/.nvm/versions/node/v24.11.0/bin/node v24.11.0 probed=1
PI_OK /home/<user>/.nvm/versions/node/v24.11.0/bin/pi 0.85.1 class=supported probed=1
PI_PROBE_OK   （exit 0）
```

（负例：指纹改一位 ⇒ `HOST_FINGERPRINT_MISMATCH`、exit 1。）
- 单测：`tests/remotePiDiscovery.test.mjs` 24/24（含用 POSIX `set --` 实际验证「怪路径各是一个参数」的行为断言、候选上限在 I/O 之前生效、探测次数上限、错误码即消息）。
- **D4 已拍板（2026-10）**：下限 `REMOTE_PI_MIN_SUPPORTED = 0.85.0`，依据是仓库自己的兼容账本 `docs/pi-compatibility.md` 的「当前基线 pi 0.85.0」——PiDeck 与 pi 的全部通信就是 `pi --mode rpc`，那份适配矩阵就是按它核对的；计划里写的 0.87.1 是「写计划时上游最新正式 release」，不是 PiDeck 的兼容基线，用它会把真机 0.85.1 无理由判死。上限只比 `major.minor`（`0.85.x` 已核验，更高 ⇒ **放行** + `REMOTE_PI_VERSION_UNVERIFIED` 警告：远端 pi 是用户自己的软件，拒绝新版本会把「用户升级了」变成功能不可用）。低于下限 ⇒ `REMOTE_PI_TOO_OLD` + 升级指引，**不静默降级、不替用户升级远端 pi**。
- **仍未做**：① 本模块**还没有生产调用方**（P4.2 的启动准备接线，须先 `resolveRemoteNodeExecutable` 取 `nodePath`）；② 三个码的 **i18n 文案未接线**（属 P4.2 的 UI，届时按 `REMOTE_PI_DISCOVERY_CODES` 映射）；③ 探测只在单测 + 一次性真机脚本上验过，尚未进入应用链路。

**P4.2 最小端到端会话（方案 A 的核心闭环）**
- 内容：`SshPiRuntimeLauncher` + runner（握手/进程组/lease）+ `PiProcess` 抽出 `PiSpawnHandle`；在远端项目根下新建会话 → 发送 → 流式 → 停止 → 重启恢复。
- 验收证据：真机上一个会话完成 "prompt → 至少一个 assistant 事件 → abort → restart 后历史仍在"；runner 回收后 `ps` 无残留 pi 进程组；握手换行同 chunk 的字节保留 fixture；断线时 prompt 标记 `unknown` 且**无自动重放**（对照计划 `:893`）。
- 不做：多会话、Git、终端、写文件。

**P4.3 生命周期与恢复**
- 内容：双会话事件隔离、断线/重连、从远端 JSONL 恢复、`runtimeGeneration` 递增与迟到结果丢弃、host 切换不串 catalog。
- 验收证据：计划 §14.1 的 `remoteRuntimeGeneration.test.mjs` / `remoteDisconnectRecovery.test.mjs` 绿；真机连续两次重连后事件不串。

**P4.4 安全与配置面（helper 开始扩 op）**
- 内容：security 快照 artifact（`artifact.*`）、内置扩展远端注入、trust key 统一判据、per-host 配置后端。
- 验收证据：`PIDECK_SECURITY_CONFIG` 在真机指向远端 artifact 路径（`ls -l` 0600）；launch plan 内**不含**任何本机绝对路径（契约测试扫描）；配置返回脱敏。

**P4.5 门禁与真机长稳（进入 beta 判定）**
- 内容：50ms RTT fixture 的延迟测量、多会话连接数上限、`npm run pack` 资源核对、helper/runner 升降级与断电恢复。
- 验收证据：计划 §12 Phase 4 门禁逐条 + §15 `:908`（超上限返回结构化错误、并发/长稳测试）。

---

## 8. 附录：本次只读侦察的命令与原始输出

（本机 SSH：`C:\Windows\System32\OpenSSH\ssh.exe`；`~/.ssh/config` 中 `Host serve` → `HostName 10.81.2.15` / `User zhadainian`。全部命令只读，无写重定向，未读取凭据文件。）

```text
$ ssh -o BatchMode=yes -o ConnectTimeout=10 serve 'echo RECON_OK; uname -srm; id -un; command -v node; node -v; command -v pi || echo NO_PI_IN_NONINTERACTIVE_PATH'
RECON_OK
Linux 6.8.0-136-generic x86_64
zhadainian
/usr/bin/node
v12.22.9
NO_PI_IN_NONINTERACTIVE_PATH

$ ssh ... serve 'bash -lc ''command -v node; node -v; command -v pi || echo NO_PI_IN_LOGIN_PATH; printf %s \"$PATH\" | tr : \"\n\" | head -12'''
/home/zhadainian/.nvm/versions/node/v24.11.0/bin/node
v24.11.0
/home/zhadainian/.nvm/versions/node/v24.11.0/bin/pi
/home/zhadainian/.nvm/versions/node/v24.11.0/bin
/home/zhadainian/.cargo/bin
/home/zhadainian/.local/bin
/usr/local/cuda-12.4/bin
/usr/local/sbin
/usr/local/bin
/usr/sbin
/usr/bin
/sbin
/bin
/usr/games
/usr/local/games

$ ssh ... serve 'bash -lc ''readlink -f "$(command -v pi)"; ls -la "$(command -v pi)"; ls -d ~/.nvm/versions/node/v24.11.0/lib/node_modules/*'''
/home/zhadainian/.nvm/versions/node/v24.11.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
lrwxrwxrwx 1 zhadainian zhadainian 70  9月 10 18:09 /home/zhadainian/.nvm/versions/node/v24.11.0/bin/pi -> ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
（全局包目录含 @earendil-works、@anthropic-ai、@deepseek-ai、@openai、@qwen-code、pnpm、npm、web 等）

$ ssh ... serve 'bash -lc ''head -32 ~/.nvm/.../@earendil-works/pi-coding-agent/package.json; echo ---; pi --version'''
{
	"name": "@earendil-works/pi-coding-agent",
	"version": "0.85.1",
	"type": "module",
	"piConfig": { "configDir": ".pi" },
	"bin": { "pi": "dist/bundle/cli.js" },
	"main": "./dist/index.js",
	"exports": { ".": {...}, "./rpc-entry": { "import": "./dist/bundle/rpc-entry.js" }, "./client": { "source": ... }, "./experimental/plugin": { "source": ... } },
	...
}
---
0.85.1

$ ssh ... serve 'ls -la ~/.pi; echo ---; ls -la ~/.pi/agent; echo ---; ls -la ~/.pi/agent/sessions; echo ---; find ~/.pi/agent/sessions -maxdepth 3 -name "*.jsonl" | wc -l'
~/.pi: agent/ cache/
~/.pi/agent: auth.json(-rw-------, 未读取内容) models.json models-store.json settings.json trust.json sessions/ prompts/ skills/ configs/ bin/ npm/ _bak/
~/.pi/agent/sessions: 9 个目录（--home-zhadainian--、--home-zhadainian-.codex--、--home-zhadainian-video-search-and-summarization--、--mnt-data-zhadainian--、--mnt-data-zhadainian-model-- …）
find ... | wc -l → 28
样例：--mnt-data-zhadainian-model--/2026-08-10T09-42-41-275Z_019feb0d-8b7b-7738-b8e5-f95a80b8dbfc.jsonl

$ ssh ... serve 'for d in ~/.pideck/remote-host/bundles/*/; do printf "%s " "$(basename $d)"; sha256sum "$d/helper.mjs" | cut -d" " -f1; head -c 120 "$d/helper.mjs" | grep -o "helper build [0-9.]*"; done'
5a46222dae7305eb18f74c55cba613a02f8e6dea1742ef803d9237f13d37a163 66b041d2675f9276f0ea03a29ed0f3d34a261fc2184546cb95c6928ca4fc538f
helper build 1.6.0
7d6bd77f94944eb27efb8b83a85f5733250aac705bfad967ccc134730de1b9cc 8c5681ea396f91b61d0a67b62e656d35d8b21db46da9278fcb2a32666787cc9a
helper build 1.4.0
da66adca809d87ea6a521c51fa9c1ff0b8b632e56dc8ba88512bed1d02655ca7 01a2505c7f18ac2b45cd42bfda61d16a3fe867da3995d6eb1ee6ab6eb7ceca05
helper build 1.5.0

$ ssh ... serve 'df -h ~ | tail -1'
/dev/nvme0n1p2  468G  404G   41G   91% /
```

本机对照（本地证据）：`where pi` → `D:\nodejs\npm-global\pi`（`pi --version` = 1.0.4）；`node_modules/@earendil-works/pi-ai` = 0.86.1（`package.json`）。本机 pi 版本比远端高一个大版本，说明**兼容矩阵必须覆盖多个远端版本**。

---

## 9. 侦察中发现的三处"计划与实现漂移"（供集成批次处理，本任务不动代码）

1. **计划 §4.2 的 `resources/remote-host/` 文件化 helper 并未落地**：仓库没有该目录，`package.json` 也没有对应 `extraResources` 项（`grep remote-host package.json` = 0 命中；`glob resources/remote-host/**` = 0 文件）。现状是 **inline 冻结字符串 + bundle manifest**（`RemoteHelperEntry.ts:56-74`、`RemoteBootstrapDeployment.ts:20-34`）。**2026-10 的 D5 决定**：继续保持 inline 冻结体，不引入 `resources/` 文件化 —— 现有部署链本来就是多文件的（`buildBundleManifest(files[])`、`deployPreparedBundle({ names, executableNames })`），runner 作为**同一份 bundle 里的第二个冻结 entry** 加入即可，不需要新的 manifest 生成器。
2. **`sanitizeSshChildEnv()` 这条漂移已不存在（2026-10 核对）**：计划 §6.2 `:401` 要求的是「只保留 OpenSSH/agent/代理必需变量」的白名单，仓库里以 `SshClientRuntime.sanitizeSshClientEnv()` 的形式存在（POSIX/Windows 两套键、拒 NUL/空值），并且 `buildPinnedSshInvocation` 返回的 `env` 就是 `client.env` ⇒ **所有 pinned ssh 子进程（bootstrap、将来的 runner）已经在用清洗后的环境**。P4.2 不需要新模块，只需在 launch plan 里继续使用同一个 client。
3. **`hello.capabilities` 已有消费者（2026-10 核对）**：task-32 已把必需能力门接在 `SshConnectionAttempt`（缺 `fs.stat`/`fs.list`/`fs.read` ⇒ 不进 ready、`needs-attention`、不重试，逐 op 点名稳定码）。

---

## 10. 待拍板清单（给 lead）

| # | 问题 | 建议 | 影响面 |
| --- | --- | --- | --- |
| D1 | Agent 通路：独立 ssh + runner（A）还是 helper 托管（B） | A | 控制协议是否变成进程监督者；B 需改 7 项不变量（§3.4） |
| D2 | 是否把 launcher 的 120s deadline 策略列为 Phase 4 第 0 步 | 是 | 否则长活会话/长稳门禁不成立 |
| D3 | helper 扩展清单是否就按"probe/artifact/session/config 有界文件 op，不含 `proc.*`"冻结 | 是（配合 D1=A） | 决定 helper build 1.7.0 的 op 面与契约 |
| D4 | 远端 pi 兼容窗口（真机 0.85.1 如何处理） | **已拍板（2026-10）**：下限 `0.85.0`（依据 `docs/pi-compatibility.md` 当前基线，不是「写计划时的最新 release」0.87.1）；`0.85.x` 为已核验窗口；更高 ⇒ 放行 + `REMOTE_PI_VERSION_UNVERIFIED`；更低 ⇒ `REMOTE_PI_TOO_OLD` + 升级指引，不静默升级 | 已决定 P4.1 的分类行为；UI 文案随 P4.2 接线 |
| D5 | runner 的部署形态（第二份冻结 entry vs 多文件 bundle） | **倾向：同一份 bundle 里加第二个冻结 entry（`runner.mjs`）**：现有链已经是多文件的（`buildBundleManifest(files[])`、`deployPreparedBundle({names, executableNames})`），不需要新 manifest 生成器；P4.2 落地时按此实现 | 影响 bootstrap manifest/门禁与真机重验 |

## 状态（本次更新）

- **P4.2：已闭合**。协议/运行时/产品路真机验收**全绿**（`e2e/remoteSessionAcceptance.spec.ts` 2 passed / 真实主机）；
  远端自动 reattach 已实现（`reattachProcess` 远端分支 + 回归测试）；唯一未做的只是「真机演练远端 pi 中途死掉→自动接回」
  （安全做法写在 `remote-development-handoff.md`）。
- P4.4（远端 trust 完整语义）仍未开始，P4.2 期间只做「如实可见」。

## P4.4（远端 trust 完整语义）

实施计划已单独成文：`docs/remote-trust-plan.md`（状态：**待授权**）。要点：trust key = `(hostId, endpointIdentity, canonicalRemotePath)`；
P4.4a 只读不改安全语义、P4.4b 才传 `--approve/--no-approve`（需明确授权，因为那等于决定远端项目 `.pi` 资源是否执行）。
