# DSH 0.2.1 升级对照

状态：代码适配与本机隔离验证完成，发布前跨平台与人工 smoke 待补齐（0.2.0-rc.2 → 0.2.1-rc.1）。

目标版本取 npm `next` 的 `0.2.1-rc.1`：GitHub 已有 `dsh-v0.2.1-rc.2` release，但该版本未发布到 npm（`@deepseek-ai/dsh@0.2.1-rc.2` 404），不能作为安装源。

## 边界与验收

本次只升级 PiDeck 的 DSH 运行时集成，不改 PiDeck 的会话/RPC 契约。开发验证使用临时 HOME/profile，不读取凭据、不启动真实会话、不重启应用、不发布线上 runtime。

| 能力 | 新版变化 | 适配与验收 |
| --- | --- | --- |
| 依赖布局 | 19 个 profile 插件包（jobs-local、session-query-sqlite、storage-json 等）不再 hoist 到顶层 | lock 全量重建（删除 `@deepseek-ai` 条目后重新解析），并显式声明 `dsh-web-app`、`dsh-goal`、`dsh-workspace`、`dsh-api-session-controller`、`dsh-ptc-runtime-node`、`dsh-subagent-{fork,spawn}-in-process`；否则归档内只有嵌套副本，boot 在 `dsh-runtime/node_modules` 解析失败 |
| 停发包 | `dsh-invariants`、`dsh-subagent-in-process-driver` 不再发布；driver 拆成 spawn/fork 两个 provider | 从 devDependencies 与 REQUIRED 移除两个旧包，REQUIRED 补两个新 provider（dsh-base 补丁的直接入口） |
| Peer 作用域 | Connection fetch 与 Gateway stream 都要求显式 `PeerScope`（旧版传 `undefined` 表示进程内 operator） | `hostEntry` 统一用 `ctx.connection.browserPeer`（Connection 服务持有的本机 owner Peer，生命周期随 host 插件） |
| wire 描述符 | 生成物改为 `$remote` + `TYPERT.invocations` getter，并 import `createTypertRemoteInfo` | `check-dsh-wire` 兼容两种形状（descriptors/invocations），注入真实 `createTypertRemoteInfo`；31 个调用点形状仍匹配 |
| 预设 | 主补丁移除 `tool-ralph` 的 disabled 行；standard/ptc 移除 persona 工作目录后缀、新增 time-context/tool-schedule 行 | `dshWebAgentPlaneDisabledIds` 24 → 23（只删 `tool-ralph`）；PiDeck 不硬编码 persona suffix 与子代理后台模式 |
| 子代理默认值 | 预设不再设 `backgroundMode: continuable` | PiDeck 显式传 one-shot/continuable，行为不变（dsh 测试覆盖） |
| `--from-default-profile` | 由「补缺失」改为「模板全新覆盖已有 profile」 | PiDeck 使用独立 profile + 组合补丁，不依赖该参数的增量语义 |
| 本地插件 peer | rc 线的 caret 会解析到更高 prerelease（`^0.2.1-rc.1` → rc.2），产生两套 runtime 副本 | `dsh-tool-pwsh-persistent` 的 peer 精确 pin 到 `0.2.1-rc.1`，测试断言同步 |

## 升级与回退

会话格式（V3/V4）与 0.2.0 一致，由 DSH runtime 负责迁移；回退边界同 [DSH 0.2.0 升级对照](dsh-0.2.0-migration.md)：不能只降 npm 版本，V4 新写入不会回填 V3。

## 验证门禁

- `npm run typecheck`。
- `node --test --test-concurrency=4 "tests/dsh*.test.mjs" tests/providerMigration.test.mjs`。
- `npm run check:dsh-wire`。
- 只构建 `packages/dsh-tool-pwsh-persistent`，不跑全仓构建。
- `node scripts/pack-dsh-runtime.mjs --out <隔离目录> --lite` 后，用同一 tgz 依次跑 `check-dsh-asar.mjs`、`check-dsh-boot.mjs`、`check-dsh-migration.mjs`。
- 分平台归档只验证归档完整性；非本机平台真实运行需对应 runner，不把交叉打包称为跨平台运行通过。

## 交付记录

### 已通过

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `node --test --test-concurrency=4 "tests/dsh*.test.mjs" tests/providerMigration.test.mjs` | 822 项通过，0 失败/跳过 |
| `npm run check:dsh-wire` | 31 个调用点形状匹配，0 不符（跳过事件网关与动态端点） |
| `npm run build --prefix packages/dsh-tool-pwsh-persistent` | 本地 DSH 插件单包构建通过 |
| `node scripts/pack-dsh-runtime.mjs --out "$TEMP/dsh-021-pack" --lite` | win32-x64 归档成功，638 包 |
| `node scripts/check-dsh-asar.mjs "$TEMP/dsh-021-pack/dsh-runtime-win32-x64.tgz"` | 38,504 entries / 512 packages；19 基线 + 9 入口包、640 个包目录入口与关键文件通过 |
| `node scripts/check-dsh-boot.mjs <tgz>` | 真实 hostEntry 与 RPC 启动、官方/旧预设健康、相对资源、配置保存/重启通过 |
| `node scripts/check-dsh-migration.mjs <tgz>` | V3 冷读、写租约发布 V4、V3 字节保留、V4 重启、损坏输入拒绝、最高代扫描、follow/control/fork 通过 |

### 保留的验证产物

本次 win32-x64 产物位于 `C:/Users/14012/AppData/Local/Temp/dsh-021-pack/`：

- `dsh-runtime-win32-x64.tgz`：155,944,002 bytes（148.7 MiB）；runtime `0.2.1-rc.1`，最低应用版本 `0.9.1`。
- `dsh-runtime-win32-x64-releases.json`：下载索引与完整性校验元数据。
- 归档 SHA-256：`3dabb72b787779a4bb8360a3401638196ee2adfe03b996b796628663465d3d18`。

### 未验证及发布前要求

- 其他目标平台的归档完整性与真实启动不在本次已通过范围；需各自对应 runner 补齐。
- 未验证安装包内 Electron utilityProcess、真实供应商请求/工具执行及人工 UI smoke。
- 主工作区 node_modules 未在本次改动中重装（多人并行写入期间禁止 `npm install`）；使用前需执行 `npm ci` 对齐新 lock。
- 未上传 runtime sidecar 或发布应用；在线 Release 需同时提供各平台新版 tgz 与索引。
