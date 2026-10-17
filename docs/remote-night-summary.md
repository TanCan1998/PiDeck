# 今晚交付总览（2026-10-18 凌晨批次）

> 给明天验收用的一页纸：**做了什么、怎么试、还差什么**。细节与证据在 [交接文档](remote-development-handoff.md)、[Git 计划](remote-git-plan.md)、[发布门禁台账](remote-release-gate-status.md)、[安全复审 round 2](remote-security-review-round2.md)、[配置后端安全 addendum](remote-security-review-config-addendum.md)。

## 1. 今晚完成的提交

| 提交 | 内容 |
| --- | --- |
| `0b9de7357` | feat(remote)：远端文件管理 v1 —— 新建/改名/移动/删除（项目内 `.pideck-trash` 可恢复回收站/还原/清空）、新建空远端项目（enroll create 模式 + 独立确认） |
| `a431605e0` | fix(remote)：安全低危 F2（helper bundle 保留/清理）、F4（SSH config `IdentityFile ~` 本地 HOME 展开）、F5（会话改写回执丢失 ⇒ RESULT_UNCONFIRMED + 专用文案、不自动重试）、F6（会话路径 canonical 校验） |
| `836327e6b` | feat(remote)：终端一次性 launch ticket + 固定 `terminal-runner.mjs`（helper 1.20.1；真机抓出并修复 **Windows ConPTY 剥离 C0 帧分隔符**） |
| `2da2be007` | docs：夜间门禁与发布门禁台账（十二项真机 12 passed、全量回归零新增） |
| `1dbed3132` | fix(remote)：安全复审 R2 —— `.pideck-trash` 从只读列表/搜索隐藏；ticket TTL 120s→60s、启动时 sweep、崩溃遗留 `.claim-*` 清理、常量互钉（helper 1.20.2） |
| `049133280` | feat(remote)：已归档远端会话的**显式永久删除**（行内不可恢复确认、id-only、pinned SSH 固定脚本、回执丢失不重试） |
| `0f81c6e98` | docs：会话删除 + 独立安全复审 round 2 + 远端配置契约 |
| `0a0cc53b8` | feat(remote)：远端配置后端 Batch A —— helper 1.21.0 `config.mjs`（models/settings 白名单、secret 仅状态、merge-patch + expectedVersion 原子写）+ main target 路由/重验/无本地回落 |
| `dafe725f` | fix(remote)：配置后端安全 hardening（helper 1.21.1）—— A1 原型污染（保留键全链路拒绝）、A2 secret 整名匹配（maxTokens 等不再误判）、A4 严格 UTF-8；A3 记为显式偏差 |
| `567bf2d8a` | feat(remote)：配置后端 Batch B —— 设置页 target 选择器 + 远端 models/settings 面板（secret 徽标、显式 merge-patch、冲突/未确认状态、禁用项文案）+ 作者态 e2e |
| `9dbd8142` | fix(remote)：配置后端 camelCase 复合 secret 名（clientSecret/openaiApiKey）检测（helper 1.21.2）+ 配置 e2e host 选择器修正 |
| `c6956d613` | feat(remote)：远端模型目录 v1 —— 目标 host live pi runtime 探测 + 脱敏 provider/模型列表（`remote:pi-models`、closed codes、渲染层 catalog 面板 + e2e），Phase 5 行 819 收口 |
| 待提交 | docs：本总览 / 交接 / 门禁台账 更新 |

Git 能力（G1–G5e、嵌套仓库发现与读写、同步、恢复、compare/polling）、文件管理、终端 ticket、会话永久删除、远端 models/settings 配置与模型目录都已在真机门禁覆盖。

## 2. 自动证据（Lead 已跑）

- **真机门禁**：最终 **十三项 13 passed（12.4m，`CLEANUP_OK`，含模型目录）**——G1–G5e、文件管理 v1（含远端配置 e2e：host target/脱敏读取/非密钥 patch/SSH 落盘核验/字节还原）、终端、远端会话产品路（含归档/永久删除 + live runtime 模型目录 e2e：设置→模型→ssh target→非空 provider 列表）。主机高负载时 G2a/终端/G4b oracle 的 SSH 瞬时抖动偶发，均单独复跑通过，并已加固 oracle 重试与收敛等待；最终干净门禁一次通过。
- **全量回归**：工作树 **8507 项 / 8205 通过 / 30 败 / 272 skip**，与干净 HEAD `a52eb53ea` **失败集合完全一致（零新增）**；30 条为本机既有环境/基线红。
- **打包**：`npm run pack` 0（最终产物含 helper 1.21.2/config.mjs + 模型目录通道）；`release/win-unpacked/resources` 含 pi-auth-host、extensions（含 manifest）、prompts、skills、pets、xueprompts.db、pi-ai-catalog；app.asar 命中 `config.read`/`config.patch`/`CONFIG_RESULT_UNCONFIRMED`/`REMOTE_CONFIG_PROVIDER_OPERATION_UNSUPPORTED` 以及终端/Git/回收站冻结标记。
- **安全**：两轮独立只读复审 + 配置后端独立 addendum（A1 原型污染、A2 secret 误判两 medium 均已修复并由复审 lane 逐项 PASS 复验，A3 显式偏差，camelCase 复核残余已在 1.21.2 补齐）；round 2 为 **0 critical / 0 high / 0 medium**，F1–F6 关闭，R2-1/R2-2 已修复。仍缺人工独立 reviewer 签字。

## 3. 明天怎么试（最短路径）

1. 仓库根目录 `npm run dev`（远端实验门禁 `PIDECK_REMOTE_EXPERIMENTAL=1`；打包版仍关闭远端，见 §4）。
2. 设置 → 连接：添加 SSH 主机（指纹确认）→ 连接。
3. 项目：`+` → 远端（SSH）→「使用已有目录」或「新建空目录」；侧栏出现远端项目。
4. 右侧抽屉：
   - 文件：新建/改名/移动/删除（项目内回收站，可还原/清空）；
   - Git：状态/暂存/提交/分支/历史/引用对比/同步/嵌套仓库选择；
   - 终端：项目隔离、resize、断开/退出清理。
5. 会话管理：远端会话归档/恢复/永久删除（仅已归档行、行内二次确认、明说不可恢复）。
6. 设置 → 配置管理 → 模型/设置：target 选择器切到已连接 SSH 主机 → 脱敏读取（version + secret configured/missing 徽标）→ 显式 merge-patch 编辑；「拉取远端模型目录（测试连接）」从该主机的 live pi runtime 取回脱敏 provider/模型列表（需先在该主机打开一个远端会话）；逐供应商合成探测/用量按设计禁用。

## 4. 还差什么（诚实清单）

- **模型目录 / 连接探测**：已交付（目标 host 的 live pi runtime + 脱敏列表）；**逐供应商合成 HTTP 探测与用量查询**仍按计划 deferred（remote target 下禁用并给 stable code 文案）。
- **打包版远端**：仍被 `!app.isPackaged && PIDECK_REMOTE_EXPERIMENTAL=1` 挡住；放开是产品/发布决定，且需要打包版人工 smoke。
- **macOS 客户端**：无机器，今夜无法验证。
- **Linux 客户端长稳 soak**：`PIDECK_E2E_REMOTE_GIT_SOAK` 仅 Linux 运行（当前为 Windows 客户端环境），需 Linux 客户端或 CI 跑 1 小时。
- **独立人工 reviewer 签字**：现为 AI lane 两轮 + Lead 复核，计划要求的人工独立 reviewer 仍需人。
- **agent-target 终端 ticket**：当前 ticket 仅支持 project 终端（kind 闭集），agent 终端变体未做。