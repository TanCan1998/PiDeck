# 远端 v1 发布门禁台账（Remote v1 release-gate ledger）

> 状态：**进行中**（2026-10-17 深夜批次）。本文件是发布前唯一门禁台账：把 [远端开发计划](remote-development-plan.md) §12/§13、[Git 计划](remote-git-plan.md) §6.3、[独立安全审查](remote-security-review.md) 的条目压成一张可核对表。
> 基线：branch `feat/remote-development`，HEAD `c6956d613`（模型目录）；G1–G5e 与全部 Phase 5 功能（文件管理/会话删除/配置后端/模型目录/终端）已交付，最终门禁见 §3。
> 判据：只有本文件标 ✅ 的条目才算门禁通过；**未经用户本机/真机人工 smoke 的条目仅在证据栏注明「自动证据」**，不冒充人工验收。

## 1. Phase 5 安全门禁（计划 §12 Phase 5；审查 §6）

| # | 门禁项 | 状态 | 证据 / 缺口 |
| --- | --- | --- | --- |
| 1 | 所有写操作限制在项目根 | 🟡 部分 | 文本写/Git 写/回收站写各自有 canonical root + per-command 锚定；终端是账号 shell，文档明确非 chroot。回收站/新建项目为项目内/显式 create 模式（待本批落地后复核）。 |
| 2 | commit/branch/ref/path 参数无 shell/option 注入 | ✅ | 固定 argv、shell:false、校验器、`--` 与 check-ref-format；Git 全量 helper 测试。 |
| 3 | 远端项目上现有 Git IPC 全部路由远端；禁用项返回 capability 并向 UI 说明 | ✅ | target router + `git:remote-*` 通道 + `UNSUPPORTED_CAPABILITY` 矩阵；G5d/G5e 后所有既有 Git 动词均可按仓库 scope 走远端。 |
| 4 | 终端 prepare ticket 一次性/防重放/跨项目 | 🟢 已实现并真机通过 | helper 1.20.1 `terminal.prepare` 一次性 ticket + 固定 `terminal-runner.mjs`；真机终端 e2e 1.8m 通过（Windows 客户端→Linux 主机，ConPTY 帧分隔符缺陷已修）。agent-target 变体仍未做（project-only kind）。 |
| 5 | 终端握手/输出/resize/close 与前台 shell 收敛 | 🟢 真机通过 | Windows 客户端→Linux 主机终端 e2e：项目隔离/保存代码/resize/关闭/断开/退出清理全通过；关闭后远端 shell 收敛在负载下最坏约 20–60s（测试等待已放宽到 60s，硬断言仍要求 gone）。 |
| 6 | Git 输出尺寸与超时上限 | ✅ | 1 MiB/256 KiB/16 MiB 预算 + 同步 600s 预算（F1 修复，§5.16.2）。 |
| 7 | Phase 0–5 全能力对照表通过 | ✅ | 文件管理/create-project/终端 ticket/会话真删/配置后端/模型目录全部交付；模型目录与连接探测走目标 host 的 live pi runtime 并脱敏返回；**逐供应商合成探测与用量查询仍为计划内 deferred**（入口禁用 + stable code 文案），不算能力缺口。 |
| 8 | 独立安全审查完成 | 🟡 进行中 | round 1：0 critical/0 high/1 medium(F1 修复)/5 low/4 info；F2/F4/F5/F6 已修；round 2（[report](remote-security-review-round2.md)）：0 critical/high/medium，F1–F6 关闭，F3 project 终端已实现，新 2 low（R2-1/R2-2 均已修）+3 info；配置后端复审（[addendum](remote-security-review-config-addendum.md)）：2 medium（A1 原型污染、A2 secret 误判）+2 low，A1/A2/A4 已修、A3 显式偏差，helper 1.21.1 复验通过（任务 17：无 FAIL），1.21.2 补齐 A2 残余 camelCase 复合名。**独立第三方/人工 reviewer 仍缺**（现为 AI lane + Lead 复核）。 |
| 9 | Windows/macOS 本机 → Linux 远端 smoke | 🟡 部分 | Windows 客户端→Linux 真机：G1–G5e 真机门禁（Git/同步/初始化/嵌套仓库）+ 文件编辑链路已有自动证据；终端切片与 macOS 客户端无证据。 |
| 10 | `npm run pack` 资源检查 | 🟡 自动部分通过 | `npm run pack` 0（2026-10-18，release/win-unpacked）；`resources/` 含 `pi-auth-host.mjs`、`extensions/`（含 manifest）、`prompts/`、`skills/`、`pets/`、`xueprompts.db`、`pi-ai-catalog.json`；app.asar 内逐串命中冻结 helper 源码标记（`PIDECK_TERMINAL/1 READY`、`terminal-runner.mjs`、`terminal.prepare`、`createGitInitProgram`、`.pideck-trash`、F5 文案 key）。**packaged 构建仍被 `!app.isPackaged && PIDECK_REMOTE_EXPERIMENTAL=1` 挡住；发布前需产品决定是否放开 + 打包版人工 smoke（§4）。** |
| 11 | helper 升级/降级 + 断电半写恢复 | 🟡 部分 | 版本/capability 不匹配拒绝、激活复核、abort/EOF 清理已测；F2 host 侧 bundle sweep/TTL 本批修；真实断电半写与显式降级矩阵仍缺。 |
| 12 | 创建空远端目录 + git init | ✅ 真机通过 | create-project（enroll create 模式，独立确认 broker，pinned SSH mkdir + canonical 复核）真机 e2e 通过（含同名再建/回收站链路）；git init helper 1.17.0 另有 G5c 真机证据。 |
| 13 | 远端文件原子写/重命名/删除 | ✅ 真机通过 | 原子写 + rename/move/delete→项目内 `.pideck-trash`（list/restore/prune）真机 e2e 54.1s 通过，`.pideck-trash` 对读面隐藏。 |
| 14 | 发布沟通与 §13 能力总账一致 | 🔴 未开始 | 待发布说明/README/docs-site 对齐（本文件 §4 给出口径）。 |

## 2. Git §6.3 支持清单（[Git 计划](remote-git-plan.md)）

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| list repos / init / status / original+workspace diff | ✅ | G1/G5c/G5d；helper 1.18.0 发现 + 只读 scope |
| stage / unstage / discard single+batch / commit / delete workspace files | ✅ | G2a/G2b/G4a/G5e（嵌套 scope 写面） |
| branches / checkout / create branch / log / refs / compare / commit detail / diff between refs | ✅ | G3a/G3b/G5b/G5e |
| fetch / push / pull / ahead-behind | ✅ | G5a；F1 预算修复；嵌套 scope 写面 G5e |
| refs watch → 有界 polling | ✅ | G5b（15s，可见时） |
| 嵌套仓库发现 | ✅ | G5d/G5e（有界发现 + repo scope 读写） |

## 3. 本批（今晚）工作项

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| G5e | 嵌套仓库写面 + token 绑定 scope | ✅ 已交付（1606fc042） |
| file management v1 | create/rename/move/delete+回收站、空回收站、新建空远端项目 | ✅ 真机通过（54.1s，19 步） |
| security lows | F2 host bundle sweep/TTL、F4 IdentityFile `~`、F5 receipt-loss、F6 session path canonical | ✅ 已实现（真机复核项见 §4） |
| terminal ticket (F3) | `terminal.prepare` 一次性 ticket + 固定 terminal-runner 握手 | ✅ 真机通过（1.8m；含 ConPTY 修复 helper 1.20.1） |
| 夜间总门禁 | 十二项真机门禁 + 全量回归 | ✅ 12 passed (9.8m)；回归零新增失败（8413 vs 8329，30 vs 31 败） |
| remote session delete | 已归档远端会话行内永久删除（独立确认、pinned SSH 固定脚本、UNCONFIRMED 不重试） | ✅ 已实现（targeted 17/17 + 回归 143/1 skip；真机门禁待跑） |
| 安全复审 round 2 | 独立只读复审 + R2-1/R2-2 修复 | ✅ R2-1 已修（host IPC 75/75）；R2-2 已修（helper 1.20.2：60s TTL/启动 sweep/claim 清理/常量互钉） |
| remote config backend Batch A | helper 1.21.x `config.mjs`（models/settings 白名单、secret 状态、merge-patch + expectedVersion 原子写）+ main target 路由/重验/无本地回落 | ✅ 已交付（0a0cc53b8；复审 2 medium 后 hardening 提交 dafe725f，helper 1.21.2 含 camelCase 复合 secret 名） |
| remote config backend Batch B | 设置页 target selector + 远端 models/settings 面板（secret 徽标、显式 patch、冲突/未确认状态、禁用项文案） | ✅ 已交付（作者态 e2e 挂在文件管理用例，真机门禁见下） |
| release evidence | `npm run pack` 资源检查、packaged/开发态门禁口径、长稳+真实慢链路、独立复核 | 🟡 pack 0 且资源/冻结源码检查通过；长稳（Linux 客户端）与人工独立复核待排 |
| remote model catalog（行 819） | 目标 host live pi runtime 的可用模型探测 + 脱敏模型目录（provider 测试 v1） | ✅ 已交付（c6956d613；Windows 84/WSL 55 targeted；真机产品路步骤通过；逐供应商合成探测/用量仍 deferred） |
| 最终门禁（13 项真机） | G1–G5e + 文件管理（含远端配置 e2e）+ 终端 + 远端会话产品路（含归档/永久删除 + 模型目录 e2e） | ✅ **13 passed（12.4m）**，`CLEANUP_OK`；配置 e2e：host target → 脱敏读取 → 非密钥 patch → SSH 落盘核验 → 还原；产品路 e2e：live runtime → 设置 → 模型 → ssh target → 非空 provider 目录 |
| 最终全量回归 | 工作树 vs 干净 HEAD `a52eb53ea` | ✅ 8507 项 / 8205 通过 / 30 败 / 272 skip，**失败集合完全一致（零新增）** |
| 最终打包 | `npm run pack` + 产物冻结源码标记检查（含 config.mjs/1.21.2、模型目录） | ✅ pack 0；app.asar 命中 `config.read`/`config.patch`/`CONFIG_RESULT_UNCONFIRMED`/`remote:pi-models`/`REMOTE_MODEL_PROBE_NO_RUNTIME`/`remoteModel.deferredNote` 与既有终端/Git 标记 |

## 4. 需要用户/人工确认的项（不能被自动证据替代）

1. **macOS 客户端**：无机器/无 session，无法今夜验证；发布口径只能写「Windows 客户端已验证，Linux 客户端已有开发态证据，macOS 未验证」。
2. **打包版人工 smoke**：`npm run pack` 产物可以自动检查资源与启动，但真实 SSH 远端流程的人工点按体验需用户明天确认。
3. **独立安全 reviewer**：已有两轮 AI lane 只读审查 + Lead 复核（round 2 报告见 remote-security-review-round2.md）；计划要求的「独立第三方/人工 reviewer 签字」仍需要人。
4. **文件管理 11 项签收点**：本批按文档建议方案（回收站 A + 空回收站 C）实现；用户可在验收时改，但实现已按建议走。
5. **真实慢网络/长稳**：可自动跑有界 soak；数小时网络抖动下的用户感知需人工判断。

## 5. 更新纪律

- 每个批次合入后更新本表；状态只用 ✅ / 🟡 / 🔴 / ⬜。
- 证据指向：单测文件、真机门禁输出、交接文档对应节（`remote-development-handoff.md`）。
- 本文件不替代安全审查报告与计划正文；冲突时以审查/计划为准并在本文件注明。
