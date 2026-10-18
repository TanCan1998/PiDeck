# 插件开发支持（Plugin Dev）维护指南

> 面向 PiDeck 维护者。用户/AI 视角的完整规格由应用内生成（见下），本页讲这套功能
> 怎么组装、改哪里、怎么防漂移。

## 功能组成

PiDeck 的「插件」= **pi 扩展**（TypeScript 单文件，pi 用 jiti 加载，无需编译）。
本功能不引入新运行时机制，只做三件事降低用户参与门槛：

1. **能力目录 + AI 指南生成**：`src/shared/pluginDevCatalog.ts` 是单一事实源
   （pi 原生 API 节选、8 个常用事件、15 个 GUI 落点、7 个 GUI 服务、42 种节点 kind、
   8 条硬约束）；`src/shared/pluginDevGuide.ts` 把目录渲染成双语 Markdown
   （`AI-PLUGIN-GUIDE.md`）。用户把生成的文件路径发给任意 AI，即可代写插件。
2. **demo 插件**：`resources/plugin-dev/pi-deck-demo-plugin.ts`，一个文件演示
   命令 + 事件统计 + GUI 落点三层能力；「复制 demo 插件」把它拷进用户扩展目录
   作为起步模板（已存在不覆盖——可能是用户改过的）。
3. **设置页入口**：扩展页第三个 tab「插件开发」（仅全局作用域），
   `src/renderer/src/config/PluginDevSection.tsx`。

## 文件地图

| 关注点 | 文件 |
| --- | --- |
| 能力目录（单一事实源） | `src/shared/pluginDevCatalog.ts` |
| 双语指南生成器 | `src/shared/pluginDevGuide.ts` |
| demo 插件本体 | `resources/plugin-dev/pi-deck-demo-plugin.ts` |
| 主进程服务 | `src/main/extensions/PluginDevService.ts` |
| IPC（plugin-dev: 域） | `src/main/ipc/pluginDevIpc.ts` + `src/shared/ipc.ts` + `src/preload/index.ts` 三处同步 |
| 渲染层入口 | `src/renderer/src/config/PluginDevSection.tsx`（挂 `ExtensionsTab` 第三 tab） |
| 能力参考文档 | `docs/gui-extension-points.md`（表格由目录生成） |
| 契约测试 | `tests/pluginDevGuide.test.mjs`、`tests/guiExtensionPointsDoc.test.mjs`、`tests/pluginDevService.test.mjs` |

## 目录与镜像契约（防漂移）

`pluginDevCatalog.ts` 的数据镜像自三处实现，契约测试反向解析源码校验：

- **19 落点** ← `resources/extensions/pi-deck-gui-bridge-gui-spec.ts` 的 `GUI_SLOT_METHODS`
  （测试逐项断言 method 名与 slotId 一致）
- **42 节点 kind** ← `resources/extensions/pi-deck-gui-bridge-types.ts` 的 `UINode` 联合类型
  （测试提取全部 `kind: "..."` 字面量，双向断言不多不少）
- **指南/文档** ← `tests/pluginDevGuide.test.mjs` 断言生成的指南含全部目录 id、双语各生成一份；
  `tests/guiExtensionPointsDoc.test.mjs` 断言 `docs/gui-extension-points.md` 含全部
  kind/slotId/约束 id（空白容忍正则，遵守仓库扫描契约测试规范）

**改桥新增落点或节点 kind 时**：先改桥实现 → 同步 `pluginDevCatalog.ts`（带 zh/en 文案）
→ 跑三个契约测试 → `docs/gui-extension-points.md` 重新生成（`.scratch-gen-ep.mjs` 式脚本
或手补表格行，契约测试会拦漏）。

## 打包与路径

- `resources/plugin-dev/` 经 `extraResources` 进安装包（filter `*.ts`）；
  开发态读 `app.getAppPath()/resources/plugin-dev`，打包态读 `process.resourcesPath/plugin-dev`
  （`resolveDemoPluginSourcePath`，与内置扩展同一套 `BuiltInExtensionPathRoots`）。
- 指南/demo 落点固定为**用户级扩展目录** `~/.pi/agent/extensions/`：home 来源与
  `ExtensionManager.userHomeDir` 同源（WSL 场景跟随扩展列表的 home 解析），
  保证复制进去的文件一定出现在扩展页的本地扫描里。
- demo 源缺失（打包漏资源）时 `copyDemoPlugin` 显式抛错，便于安装包 smoke 发现。

## 已知边界

- 无热重载：改插件 → 重启会话（`AI-PLUGIN-GUIDE.md` 里对 AI 也这么交代）。
- 指南是生成物，覆盖写不备份；用户改了指南下次生成会被覆盖（有意为之，防过期文档流传）。
- demo 插件不进 `BUILT_IN_EXTENSIONS` 白名单（它不是 `-e` 注入的内置扩展，是拷给用户
  的起步文件），扩展页对它的管理走本地文件扩展路径。
