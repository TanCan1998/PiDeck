# 会话数据面统一 sidecar 对照计划（Session Data Plane）

> 状态：**Wave 0 完成**（探针 `scripts/probeSessionRead.mjs` 已入库，基线数字见 §7；Wave 1–4 未开始。落地时按本文件收口：每波完成后更新状态行与 parity 表；全部迁完删除本文件）。
> 前置已落地：`native/session-index`（跨会话正文搜索，多词 AND + 项目级 roots）、`native/file-index`（工作区文件索引 + 正文检索）、`native/xue-index`。三个 sidecar 的宿主客户端（`SessionIndexService` / `FileIndexService` / `XueIndexService`）已定型同一套纪律：NDJSON stdio 协议、roots/库签名变化重启、请求 id 配对、迟到响应丢弃、进程身份核对、失败一律 `{ ok: false }` 降级不抛异常。

## 1. 问题

同一份 pi 会话 JSONL（`<sessionDir>/**/*.jsonl`）目前在主进程被 4 套 TS 代码各自解析一遍，各自有各自的上界、缓存与失效策略：

| 消费方 | 文件 | 规模 | 读法/上界 | 失效策略 |
|---|---|---|---|---|
| 侧栏目录 + 标题/预览 | `src/main/sessions/SessionScanner.ts` | 2490 行 | 每文件只读头部（`SUMMARY_PARSE_MAX_BYTES = 1MiB`），超 `MAX_IN_MEMORY_SESSION_BYTES = 32MiB` 的会话直接拒绝整体进内存 | 目录扫描 + 进程内 catalog |
| 会话目录/身份修复 | `src/main/sessions/SessionCatalog.ts` | 1823 行 | 与 scanner 重叠的头部解析 | 同上 |
| 打开会话的历史分页/跳转 | `src/main/pi/SessionHistoryReader.ts` | 2280 行 | 全量解析 + 每次打开重建显示索引；`FULL_TEXT_CACHE_MAX_BYTES = 32MiB`、`MAX_LOAD_WINDOW_ENTRIES = 1600`、`MAX_PAGE_WINDOW_ENTRIES = 600`、`MAX_TURN_PAGE_SIZE = 10`、`BRANCH_PREVIEW_MAX_ENTRIES = 1000` | 无持久化，进程内 LRU |
| 用量聚合 | `src/main/usageStats/{UsageLogReader,UsageStatsService,usageStatsAggregator,usageLogParser}.ts` | 172+310+450+100 行 | 增量读（`DEFAULT_MAX_LOG_BYTES = 256MiB`） | 自己的游标 |
| 外部 transcript 导入 | `src/main/sessions/*Importer.ts`（12 个） | 3794 行 | 各自解析外部格式后**写** pi JSONL | 不适用·写路径 |

直接后果：

- 每个新消费方（正文搜索、轨迹重建、token 统计…）都要重新发明「怎么读 JSONL、上界多少、缓存怎么失效」；
- 大会话必须整体进内存（32MiB 上限之外直接拒绝打开），打开成本随文件大小线性上升；
- 上界与字段解释略有差异，容易出现「同一文件在不同 UI 里表现不一致」（历史上出现过 toolResult 配对、分支预览截断一类问题）。

`native/session-index` 已经证明：**只读投影到紧凑语料 + 定长快照**能把这类成本压到毫秒级——实测 646 个会话文件 / 594.6MB → 首建 5008ms、语料 12.7MB、快照复用 boot 0ms / indexMs 28ms、单词查询 5–8ms。

## 2. 目标 / 非目标

目标：

1. 主进程只保留**一个**会话文件读入口（sidecar，NDJSON 协议，与既有三个 sidecar 同哲学）；
2. 打开会话/刷新侧栏不再重新解析 JSONL（快照复用优先）；
3. 统一字段解释与上界，新消费方只加协议方法，不再各自解析；
4. 全程 fail-open：sidecar 缺失/未就绪/超时 → 回退现有 TS 路径（旧代码留到 parity 全绿再删）。

非目标（硬边界）：

- **不接管 pi 的会话写入**（append / edit / fork / 删除墓碑仍由 pi 负责；PiDeck 只读，`context_edit` 三道闸不许放宽）；
- 不改 pi 的 JSONL 格式、不做双写；
- 不改 `sessions:*` IPC 的入参/出参/错误语义（渲染层零感知）；
- 不把导入器搬进 sidecar（写路径留在宿主，见 P9）。

## 3. 能力 parity 表（逐行迁移，未迁完不删旧实现）

| # | 能力 | 现在在哪 | sidecar 协议方法 | parity 判据 | 状态 |
|---|---|---|---|---|---|
| P1 | 会话文件清单（按项目/全局） | `SessionScanner` 目录扫描 | `list-files { roots, since? }` | 文件集合、`updatedAtMs`、size 逐项一致 | 待迁 |
| P2 | 摘要头字段（title/preview/messageCount/首条用户消息…） | `SessionScanner` 头部解析 | `read-summary { path }` | 侧栏渲染字段逐字段一致（含缺失值语义） | 待迁 |
| P3 | 分页窗口（load window / page window） | `SessionHistoryReader` | `read-window { path, from, count }` | 同窗口条目数、边界、`hasMore` 一致 | 待迁 |
| P4 | 单轮分页 | `SessionHistoryReader` | `read-turn { path, turnId, page }` | 轮边界与条目切分一致 | 待迁 |
| P5 | 分支预览（1000 条 / 256KiB 行截断） | `SessionHistoryReader` | `read-branch { path, ref }` | 预览条目与截断标记一致 | 待迁 |
| P6 | 跳转定位（`jumpToMessage`） | `SessionHistoryReader` 显示索引 | `locate { path, messageId }` | 返回窗口起点与现有跳转落点一致 | 待迁 |
| P7 | 用量聚合（按日/按模型） | `usageStats/*` | `usage-rollup { roots, from, to }` | 对账脚本按日/模型比对误差 0 | 待迁 |
| P8 | 跨会话正文搜索 | `native/session-index` | 已有 | — | 已完成 |
| P9 | 导入外部 transcript | 12 个 `*Importer.ts` | **不进 sidecar** | 只要求导入产物能被 P1–P7 读出 | 明确不迁 |

## 4. 分波计划（每波独立可验证、可回滚）

- **Wave 0 — 基线与探针（无行为变化）**：✅ 已完成。`scripts/probeSessionRead.mjs` 量出三个现状数字：侧栏首屏扫描耗时（文件数/总字节）、打开 1MB / 10MB / 50MB 会话耗时、主进程内存增量，数字见 §7。命令：`node scripts/probeSessionRead.mjs`（改实现后用同一命令复跑对比）。
- **Wave 1 — 会话投影 sidecar（P1/P2）**：`native/session-store`（纯标准库，快照布局照 `native/session-index`），只做清单 + 摘要头；宿主 `SessionStoreService`（照 `src/main/files/FileIndexService.ts` 抄：`isReady` / `warmup` / 就绪粘滞）；`SessionScanner` 原路保留作回退，用设置开关 `settings.sessionStoreEnabled`（默认开，开发者页可关）切换。
- **Wave 2 — 历史窗口（P3–P6）**：协议扩展 `read-window` / `read-turn` / `read-branch` / `locate`；宿主在 `SessionHistoryReader` 外挂适配层（sidecar 优先、失败回退），**不动 IPC 与渲染层契约**。门禁：把开大会话的耗时/内存对比写回本文档。
- **Wave 3 — 用量（P7）**：`usage-rollup` 替换 `usageStatsAggregator` 的读路径（账本与游标仍由宿主维护）；对账脚本逐日/逐模型比对到 0 误差。
- **Wave 4 — 进程收敛（可选）**：把 session-index 语料与 session-store 快照合并进一个进程（多方法一进程，减少常驻进程数）。仅在 Wave 1–3 落地且进程数成为实际问题时做。

## 5. 合并门禁（每波必须全绿）

1. **parity 对照**：对应行的字段级对照测试（Go 表驱动 + 宿主契约测试），不以「看起来一样」结案；
2. **降级证明**：sidecar 缺失/未就绪/超时/异常各有一条测试证明回退到旧路径生效（形状同 `tests/fileIndexService.test.mjs` 的 `binary-missing` / `not-ready` 用例）；
3. **有界读取**：新增读路径必须有字节/条目上界（沿用或严于现有口径），禁止无界 `readFile`；
4. **IPC 不变**：`sessions:*` 通道入参/出参/错误语义逐项不变，相关 e2e 差分跑一次；
5. **验证命令**：`npm run typecheck` + 改动涉及的针对性 `node --test tests/<x>.test.mjs` + `go -C native/<mod> test ./...`；不做全量构建（项目硬约束）；
6. **开关与回滚**：设置项一键关闭后行为与今天逐字一致；
7. **文档**：本文件状态行、parity 表、实测数字当次更新；全绿后删除本文件（不留悬空计划）。

## 6. 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| pi 会话格式演进 | 新增条目类型/字段时严格解析会漏读 | 未知类型跳过并计数（stats 回传，便于诊断），保留 TS 回退 |
| 双实现漂移 | sidecar 与回退路径可能给出不同结果 | parity 表逐行对照；迁完即删旧实现，避免长期双实现 |
| 进程/内存 | 每项目一个 sidecar 会放大常驻内存 | Wave 1–3 单进程多方法；只在必要时谈 Wave 4 |
| 打包/签名 | 新 Go 二进制要进 `extraResources`、CI 构建、macOS 签名链 | 照 `scripts/build-file-index.mjs` + 三平台 workflow env + `go test` 步骤抄，不新发明 |
| WSL | 宿主 Go 进程读 UNC 不可靠 | 与现有 sidecar 一致：WSL 模式整体降级回 TS 路径 |
| 写入路径误伤 | 一旦 sidecar 越界写文件可能损坏会话 | 协议只读（`mode=ro` / 只 open 读），写路径留在宿主与 pi |

## 7. 现状参考数字

### sidecar 侧（`native/session-index`，本机 646 文件 / 594.6MB 源）

首建索引 5008ms、30484 条目、语料 12.7MB；快照复用 boot 0ms / `indexMs` 28；单词查询 5–8ms。

### TS 侧基线（Wave 0，`node scripts/probeSessionRead.mjs --top 5`，2026-10，本机）

口径：侧栏扫描 = 并发 4 + 每文件 1MiB 头窗口 + 逐行 `JSON.parse`（对齐 `SessionScanner`）；打开会话 = 1MiB 定长块流式扫描 + 逐行 `JSON.parse`（对齐 `SessionHistoryReader` 全量重建）。

| 根 | 文件数 / 总字节 | 侧栏首屏扫描 | 每文件 | 头+尾窗口变体 | 打开 1MiB | 打开 10MiB | 打开 20–31MiB |
|---|---|---|---|---|---|---|---|
| `~/.pi/agent/sessions` | 647 / 595.1 MiB | **2786 ms**（头读 275 MiB，9.07 万行） | 4.31 ms | +758 ms（多读 155 MiB） | 4 ms | 165 ms | 94 ms（19.4 MiB） |
| `<repo>/.pi/sessions` | 242 / 512.2 MiB | **1298 ms**（头读 173 MiB，4.15 万行） | 5.36 ms | +649 ms（多读 126 MiB） | 5 ms | 102 ms | 87 ms（31.1 MiB） |

内存（同一次运行，未开 `--expose-gc`）：全局根 rss Δ142.7 MiB / 峰值 288.6 MiB，仓库根 rss Δ43.7 MiB / 峰值 286.1 MiB；heapUsed 增量仅 7–18 MiB（parse 产物被回收），说明**峰值内存压力来自 read 缓冲与一次性字符串，不来自常驻对象**，但已逼近主进程 384MB 老生代上限（见 `src/main/v8HeapLimits.ts`）。

注：单机多次复跑有 ±20% 波动（磁盘缓存冷热、杀毒扫盘），只看同机前后对比，不做跨机比较；内存数字建议加 `--expose-gc` 复跑一次取更干净的口径。

结论（决定波次顺序）：

1. 侧栏清单不是瓶颈而是「机械成本」——每文件 4–5 ms 全部花在 stat + 头读 + 逐行 parse，且只读 1MiB；sidecar 快照复用（28ms）能把它压到接近 0，但收益上限就是这几秒，且只发生在冷启动/失效时。
2. **打开大会话才是真痛点**：10–31 MiB 会话 87–165 ms 且必须整体流式扫一遍（无持久化索引），每次打开重建；20 MB 级文件已接近 32MiB 全量内存闸门。
3. 因此 P3–P6（历史窗口）优先于 P1/P2（清单投影）在收益上更划算；P1/P2 仍值得做，但定位是「给 sidecar 立最小骨架 + 统一解析」，不是性能救命。
4. 侧栏扫描的 4 秒（两根合计）里还有未计入的策略成本（身份修复、子代理分组、fork 链、标题推断），sidecar 化后这部分仍留在 TS。
