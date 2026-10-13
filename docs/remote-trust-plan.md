# 远端 trust 完整语义（P4.4）实施计划

> 状态：**已授权开工（P4.4b，用户 2026-10「继续干」）**。本文档是门禁产物——「公共契约 / 安全语义变更」必须先出 Implementation Plan 并取得确认，
> 而 P4.4b 会改变传给远端 pi 的 trust flag（= 远端项目 `.pi` 资源是否被执行）⇒ 属该门禁范围。
> P4.2 收口时的明确边界：PiDeck **刻意不传任何 trust flag**，只把现状如实告知（见
> `docs/remote-development-handoff.md` 与 `RemoteSessionTrustNotice.tsx` 头注释）。

## 1. 为什么需要这一期

- **现状**：远端 pi 的 `project_trust` 事件 `hasUI=false`，项目 `.pi` 资源（扩展/技能/提示词/项目设置）是否加载
  由远端 `~/.pi/agent/settings.json` 的 `defaultProjectTrust` 决定；PiDeck 既不决定也不传递，只显示
  「远端项目资源未加载」的常驻提示（`AgentTab.remoteTrustUnhandled`）。
- **缺口**：用户**无法在 PiDeck 里决定**信任某个远端项目 ⇒ 远端项目的 `.pi` 资源永远不生效，也没有撤销/审计入口。
- **本地对照**：本地由 PiDeck 处理（`AgentManager.ensureProjectTrust` + spawn 时 `--approve/--no-approve`）；
  远端没有对应物 ⇒ 这是「能力 parity」里最后一块明显缺口。

## 2. trust key（本期的核心定义）

**`(hostId, endpointIdentity, canonicalRemotePath)`**

- `hostId`：`RemoteHostStore` 的主机 id（显示名可改 ⇒ **不参与** key）。
- `endpointIdentity`：pin 的指纹（`SshHostPinStore`）+ `user` + `port` ⇒ 三者任一变化都视为**不同 endpoint**，
  旧 trust 一律作废（**fail-closed，不自动继承、不自动重信任**）。
- `canonicalRemotePath`：**项目根**的规范化远端绝对路径。注意 `SessionCatalog` 远端记录的 `remotePath` 有
  「pi 上报的绝对路径」与「相对会话根的路径」两种形态（见 `RemoteSessionHistoryReader` 的说明）⇒ key 必须走
  与读取侧**同源**的规范化（`RemoteSessionScanner.resolveSessionRoot` 一系），**禁止**在 trust 侧另写一套归一化。
- 粒度：**项目级**（信任的是「该项目根的 `.pi` 资源」），不是会话级。

## 3.0 进展与范围判断（2026-10）

- **已交付（授权范围：a-only）**：`src/main/remote/RemoteTrustKey.ts` + `tests/remoteTrustKey.test.mjs` ——
  `(hostId, endpoint 身份, 规范项目根)` 的纯函数实现：路径必须规范成无歧义绝对根（相对/含引号一律拒绝）、
  endpoint 身份只认 pin 的密码学事实（缺即 undefined = 不可判定，fail-closed）、任一材料变化即换 key。
  **零 schema、零行为变更**（不读配置、不改传给 pi 的参数）。提交见 `a86cab491`。
- **另加契约门禁**：`tests/remoteTrustFlagContract.test.mjs` —— 远端 plan/launcher 源码或 plan 类型里出现
  `--approve/--no-approve/trustOverride` 字样即红。目的是把「悄悄开始给远端传 trust flag」变成一个**必须显式改测试**
  的可见动作（测试注释里写明：那是 P4.4b，需授权）。顺手确认了现状：`buildRemotePiArgs` 与 launcher 里没有任何
  trust 字样，plan 类型（`PiSpawnHandle.RemoteSshPiRuntimeLaunchPlan`）里也没有 trust 字段 ⇒ 结构上就传不出去。
- **安全边界（实施时必须遵守）**：渲染层**不得**出现 fingerprint —— 共享类型里已明文规定
  （`RemoteHostDiagnosticEntry` 注释：脱敏诊断"结构上无法携带 fingerprint……这些都不该出现在渲染层"），
  渲染层主机 DTO 只有 `{id,label,sshHost,verified,disabled}`。所以 P4.4a/b 的 UI 只能显示「主机 label + 已验证 +
  决策状态」，**不能**显示指纹/known_hosts 摘要；trust key 里的 endpoint 身份只留在主进程与配置里。

- **P4.4b 已交付（2026-10，本次）**：决策存储（`AppSettings.remoteProjectTrust`，写入只走 trust 域，通用 `settings:update` 碰不到）、
  四态判定（未决策 / 已信任 / 已拒绝 / 因 endpoint 变更作废 + 原因）、flag 传递（`buildRemotePiArgs` 里**唯一**一处映射，
  显式收到决策才追加；未决策一个 flag 都不加 ⇒ 零行为变更）、渲染层（会话提示条四态 + 决策/撤销、设置页「远端信任」清单、
  `remote:trust-list|set|clear` 三通道、渲染层结构上不含任何 pin 材料）、host 退役清理（`RemoteHostStore.onHostRetired` + 下次 open 重试）。
  门禁 `tests/remoteTrustFlagContract.test.mjs` 按授权**等价迁移并加强**：flag 字面量只允许出现在已登记解析点闭集内，
  launcher/plan 不得自拼，plan 类型仍不得有 trust 字段，且「未决策 ⇒ args 精确等于基础参数」「禁止默认 approve」都是硬断言。
  **未做**：远端 pi 版本门（本机有 `supportsTrustFlags`，远端没有 ⇒ 若远端 pi < 0.79 带 flag 会让 pi 启动失败；
  目标主机 0.85.1 已实测支持）、多窗口并发 CAS、主机删除 UI（生产当前没有可达的 retire 入口）。
- **刻意未做（并说明理由）**：P4.4a 里的「存储 + 设置页清单 + 提示条显示状态」在本期**没有决策入口**
  （决策 UX 属 P4.4b），做出来就是「无人可写、永远显示『未决策』」的空壳 ⇒ 按仓库纪律（不为假设中的未来需求
  增加抽象/配置项）暂不实现。**建议**：把「存储 + 决策 UX + 传递 flag」放进同一批（P4.4b，需授权），
  这样 UI 一出现就是可用的（能真的信任/撤销），而不是先摆一排只读控件。

## 3. 需要决策的点（授权门禁）

| # | 决策 | 选项 | 倾向 |
|---|------|------|------|
| 1 | **是否传 flag**（P4.4b） | 传 `--approve`/`--no-approve` / 维持不传 | 授权后才传；未授权则只做 P4.4a |
| 2 | 未决策时的默认 | A 维持现状（不传 flag）/ B 显式 `--no-approve` / C 首次进入时询问 | **A**（零行为变更，最保守） |
| 3 | 粒度 | 项目根 / 主机级一次信任 | **项目根** |
| 4 | 存储 | `SettingsStore` 新段 / 随 `RemoteHostStore` / 独立 store | `SettingsStore`（随配置备份；host 删除时清理该 host 的条目） |
| 5 | 撤销与审计 | 设置页「远端信任」清单 + 项目右键「不再信任」；指纹变更自动作废并**写明原因** | 两者都要 |

## 4. 分期

- **P4.4a（只读，不改安全语义）**：key 计算 + 存储 + 状态（未决策 / 已信任 / 已拒绝 / 因 endpoint 变更作废）；
  UI 可见（提示条与设置页）；**不传任何 flag** ⇒ 行为与今天完全一致。单测覆盖 key 与状态机。
- **P4.4b（改安全语义，需授权）**：按状态传 `--approve`/`--no-approve`（落点：`piRemoteRuntimePlan` 的 args，
  与本地 `trustOverride` 对称）；提示条从「如实告知」变成「可决策 + 可撤销」；文档与迁移。
- **P4.4c**：与主机重绑（`HostRebindJournal`）联动——重绑后按 `endpointIdentity` 判定 trust 是否保留。

## 5. 验证计划

### 5.0 真机事实与可观测判据（2026-10-12，父代理在目标主机实测，pi **0.85.1**）

- **flag 存在且语义正确**：`pi --help` 原文 —— `--approve, -a` = "Trust project-local files for this run"；
  `--no-approve, -na` = "Ignore project-local files for this run"。
- **目标版本没有 `project_trust` 事件**（在 `dist/bundle/*.js` 里 grep 计数为 0）⇒ **不要**用事件判断"远端 pi 实际信任了
  什么"；UI 状态以**我们自己的决策存储**为权威（"下一次会传什么 flag"）。本机 pi（0.99.1）与远端 pi（0.85.1）版本不同，
  更不能把事件当契约。
- **可观测判据（不需要模型配额）**：在远端项目里放一个项目级提示词模板
  `<remoteRoot>/.pi/prompts/trustprobe.md`，然后起一次 RPC 会话调 `get_commands`：

  | 传入的 flag | `get_commands` 里是否出现 `trustprobe` |
  |---|---|
  | 无 flag | ✗（0 命中） |
  | `--approve` | **✓（命中）** |
  | `--no-approve` | ✗（0 命中） |

  ⇒ `--approve` 在目标版本**确实会加载项目本地资源**；未决策与 `--no-approve` 的可观测结果一致（符合"未决策＝维持现状"）。
  验收 P4.4b 时就用这条：决策为 approve ⇒ 该模板可见；deny / 未决策 ⇒ 不可见；撤销后**下一次 spawn** 立刻回到不可见。
  另一条既有日志（`Remote pi runtime plan prepared { args }`）同时可断言 args 里究竟有没有 flag。

- **单测**：key 计算（相对/绝对路径归一、单引号/大小写/尾斜杠、指纹与 user/port 变化 ⇒ 作废）、存储迁移、
  状态机（未决策 → 信任 → 撤销）、host 删除时清理。
- **真机**：
  1. P4.4a：状态可见且**远端行为不变**——用已有的诊断日志 `Remote pi runtime plan prepared { args }` 断言
     args 里**没有** trust flag（这条日志是 P4.2 收口时加的，正好可作判据）。
  2. P4.4b：`--approve` 后远端 `.pi` 资源**确实生效**（用「只在信任时加载的项目扩展/提示词」当探针），
     `--no-approve` 时明确不加载；两次都要看远端 pi 的 `project_trust` 事件/日志作为佐证。
- **回归**：现有 `remoteTrustUnhandled` 提示条语义不得退化；`e2e/remoteSessionAcceptance.spec.ts`（含
  trust 提示断言）与 `tests/remoteSessionAcceptanceSpecGuard.test.mjs` 保持绿。

## 6. 风险与安全底线

- **禁止**为「让资源生效」而默认传 `--approve`：那等于静默信任任意远端项目 ⇒ 远端代码执行面扩大。
- **指纹变更 = 换机或中间人 ⇒ trust 必须作废**（fail-closed），且 UI 要说明原因，不能只是悄悄失效。
- 路径规范化必须与读取侧同源（一处实现），否则会出现「读得到历史但 trust 判定为另一个项目」这类割裂。
- 撤销必须**立即生效**（下一次 spawn 即不带 flag），不要求重启应用。
- 远端 trust 与本地 trust 的存储与语义**各自独立**，不得互相回退（远端某主机的信任不因本地项目被信任而生效）。
