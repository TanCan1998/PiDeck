# PR 说明：修复未闭合思考标记泄漏到助手正文

> 目标分支：上游 `dev`。本次验证基线为 `6aef02ea`；发起 PR 前，上游已推进到 `226c8663`，其间包含修复下述 4 项旧基线失败的 `653f5b6b`。
>
> 本文记录本次修复的范围、验证与限制，不修改仓库通用 PR 模板。**旧基线上的验证不等于与最新 `dev` 合并后的验证，因此以 Draft PR 发起评审，不宣称可以无条件合并。**

## Summary

### 问题与根因

部分兼容服务将思考内容放进 assistant `text`，并在工具调用前省略 `</thinking>`。PiDeck 原有展示清理只处理成对标签，导致未闭合内容直接铺到正文。原始会话消息已包含这些文字，本次只做展示兼容，不能描述为已修复供应商协议。

### 修复内容

- 助手正文使用统一显式标记清理入口，桌面/Web、正文计数、编辑初值及多选助手纯文本复制共用同一规则。
- 使用 CommonMark 语法节点确认独立标记，保留链接目标/标题、HTML 属性/注释、代码及 `pre` 中的标签字面量，不按语言或英文内容猜测思考。
- 按原始源坐标收集隐藏区间，正常多块共用解析结果；异常上下文修复的累计解析字符量不超过输入的 3 倍，避免逐块重扫全文。
- 共享 Markdown 边界空白处理，保留首行代码缩进；桌面历史投影剥宿主提示时启用，飞书/标题等既有调用维持原默认行为。
- 将触达的旧手写 TS 沙箱加载片段改为项目统一 helper，业务断言不放宽。

### 范围、兼容性与行为取舍

- 不修改 pi 的模型调用、工具行为、JSONL 原文、模型上下文或会话存储格式。
- 不新增 IPC、全局状态、通信通道、编辑器或 Markdown 渲染引擎。
- 用户原话不按思考清理；多选原始 Markdown 导出维持既有行为。助手纯文本复制与可见正文一致。
- 这是**展示兼容兜底，不是安全/隐私过滤器**。极端畸形文本耗尽预算时保留无法确认的内容，优先避免误删正常正文。
- `3N` 限制累计送入解析器的字符量，不是严格 CPU 耗时或跨设备帧率保证。

### 依赖说明

显式声明 `@lezer/markdown@^1.7.2` 为直接开发依赖，由 renderer 构建打入产物。该版本原已通过 CodeMirror 间接安装；直接使用纯解析入口，避免经 `@codemirror/lang-markdown` 引入编辑器集成依赖。`package.json` / lock 只增加同一项直接依赖声明，没有升级其他包。

### 实现位置

| 文件 | 职责 |
| --- | --- |
| `src/renderer/src/utils/thinkingText.ts` | 语法标记确认、源坐标隐藏区间、解析预算 |
| `src/shared/markdownWhitespace.ts` | 主/渲染共用的保留代码缩进空白规则 |
| `src/main/pi/messageContent.ts` | 桌面正文投影收口 |
| `src/main/feishu/docActions.ts` | 兼容选项，非桌面调用保留旧默认行为 |
| `src/renderer/src/components/session/timeline/answerText.ts` | 正文展示统一入口 |
| `src/renderer/src/components/session/timeline/editableAnswerTarget.ts` | 编辑初值不再重复 trim |
| `src/renderer/src/components/session/timeline/messageCopyText.ts` | 按角色处理多选纯文本复制源 |
| `SurfaceComponents.tsx` / `WebAssistantText.tsx` / `SessionMessageTimeline.tsx` | 窄接口接线，不新增独立清理规则 |

## Checklist

- [x] 已运行 `npm run typecheck`。
- [x] 已运行完整 `npm run build`，干净安装的 `npm run pack` 也执行了完整构建链。
- [x] 已为非显然逻辑、解析预算和兼容边界添加注释。
- [x] 已更新 `docs/maintenance-domains.md`。
- [x] 已运行 `npm run check:format` 与 `git diff --check`。
- [x] 相关单测 334 项、UI 回归 14 项通过。
- [x] 已用 npm 11.6.2 在全新目录运行包含生命周期脚本的 `npm ci`。
- [x] Windows unpacked 打包通过，新产物的自动启动 smoke 通过。
- [ ] 全量单测全部通过：**旧基线验证未满足**，详见下方归属分析。
- [ ] 在 PR 附上实际截图；下方本地路径不是远程附件链接。
- [ ] 合并前在最新 `dev` 合并结果上重新验证，不能将旧基线证据作为最终绿灯。

### 验证环境与命令

环境：Windows x64、Node **24.9.0**、npm **11.6.2**。仓库 CI 使用 Node 24.13.0，本地结果不冒充 CI 同环境结果。

| 命令/验证 | 实际结果 |
| --- | --- |
| 全新目录执行 `npx --yes npm@11.6.2 ci --no-audit --no-fund` | 通过，安装 1696 个包；执行 postinstall；非 Git 目录中的 prepare 按设计跳过 Git 钩子安装 |
| `npx --yes npm@11.6.2 run typecheck` | 干净安装通过 |
| `npx --yes npm@11.6.2 run check:format` | 通过，检查 3000 个文件 |
| `node --test --test-concurrency=4` 加 38 个相关测试文件 | 334/334 通过；完整文件清单与命令保存在本地 `commands.json` |
| `npx playwright test e2e/thinking-fallback.spec.ts e2e/thinking-history.spec.ts` | 14/14 通过，覆盖字面量保留、性能、编辑保存、Electron 历史 reload 和多选复制 |
| `npx --yes npm@11.6.2 run test:serial -- --test-timeout=120000 --test-force-exit` | **失败**：10,346 项，10,326 通过、8 失败、12 跳过；该干净源码目录没有 `.git` |
| 在最终 Git 工作区重跑全部 7 个失败文件 | 54 项：50 通过、4 失败；依赖 Git 元数据的失败消失 |
| 在干净基线 worktree `6aef02ea` 重跑相同 7 个文件 | 54 项：50 通过，**相同 4 项失败**；基线源码工作区保持干净 |
| 干净安装执行 `npx --yes npm@11.6.2 run pack` | 通过，执行完整 build + `electron-builder --dir`，afterPack 原生运行时检查通过 |
| `PIDEK_E2E_EXECUTABLE_PATH=<新产物 PiDeck.exe> npx playwright test e2e/smoke.spec.ts` | 1/1 通过，使用隔离 userData 启动新打包的 EXE |
| 3375 个源码文件在安装/测试/打包前后的 SHA-256 对照 | 无源码漂移 |

`--no-audit --no-fund` 只关闭安装审计/捐赠输出，没有跳过生命周期脚本；干净安装**未使用** `--ignore-scripts`。

### 全量失败归属与上游后续修复

| 归属 | 文件/断言 | 处理与证据 |
| --- | --- | --- |
| 非 Git 环境 | `builtInExtensionRootsGate.test.mjs`，2 项 | 调用 `git ls-files`；最终与基线 Git 工作区均通过 |
| 非 Git 环境 | `gitProcessSpawnGate.test.mjs`，1 项 | 调用 `git ls-files`；最终与基线 Git 工作区均通过 |
| 非 Git 环境 | `xuePromptLikeGate.test.mjs`，1 项 | 调用 `git ls-files`；最终与基线 Git 工作区均通过 |
| 旧基线失败 | `agentUtilsTrim.test.mjs:166`，自动标题注册源码契约 | `6aef02ea` 同样失败；上游 `653f5b6b` 已修复 |
| 旧基线失败 | `sessionContextMeter.test.mjs:224`，底栏 context-meter 源码契约 | 同上 |
| 旧基线失败 | `spinnerUtility.test.mjs:56`，微信设置页旧 spinner class | 同上 |
| 旧基线失败 | `timelineHistoryLoadError.test.mjs:8`，历史错误 JSX 源码契约 | 同上 |

发起 PR 前刷新远端，确认 `dev` 比本次验证基线多 29 个提交，其中 `653f5b6b` 已修复上述 4 项。**这是上游修复，不是本 PR 的改动；本 PR 没有把这些失败断言改绿。** 合并结果仍需重新验证，不据此勾选旧验证的全量通过项。

在最终工作区与基线 worktree 上执行的相同归属验证命令：

```bash
node --test --test-concurrency=1 \
  tests/agentUtilsTrim.test.mjs \
  tests/builtInExtensionRootsGate.test.mjs \
  tests/gitProcessSpawnGate.test.mjs \
  tests/sessionContextMeter.test.mjs \
  tests/spinnerUtility.test.mjs \
  tests/timelineHistoryLoadError.test.mjs \
  tests/xuePromptLikeGate.test.mjs
```

### 未覆盖项与历史环境问题

- 没有在 Git 工作区从头重跑整个全量套件；只对全部 7 个失败文件补了 Git 上下文与基线对照，不拼凑“全量绿灯”。
- Windows unpacked 构建和自动启动 smoke 不等于 NSIS 安装器、便携发行包、人工验收或发布批准。
- 未运行 macOS/Linux 打包与平台 UI smoke。
- 早期 Vite 开发夹具冷启动及一次增量 TypeScript 构建超时；最终 UI 夹具改为先构建再静态预览，14 项通过；本地增量缓存备份清理后重跑 build 通过，之后干净安装的 pack 通过。超时尝试不记为通过。
- 保留构建中 `use client`/sourcemap 及生成 CSS 的告警记录，不声称由本 PR 修复。

## Screenshots

以下是本地合成夹具生成的验证图，**尚未上传到 PR**。创建 PR 后可作为附件上传，再替换成 GitHub 附件链接；不提交整个 `test-results` 或日志目录。

| 场景 | 本地文件 |
| --- | --- |
| 亮色，桌面/Web 流式与结束态 | `test-results/thinking-fallback-light-un-bcab0--settled-desktop-Web-bodies/thinking-fallback-light.png` |
| 暗色，480px 窄栏 | `test-results/thinking-fallback-dark-unc-47792--settled-desktop-Web-bodies/thinking-fallback-dark.png` |
| 列表/引用嵌套代码和后续结论 | `test-results/thinking-fallback---quoted-12076-n-survive-settled-rendering/quoted-code-final-answer.png` |
| 最终回答原样编辑保存 | `test-results/thinking-fallback-indented-06ced-nged-final-answer-edit-save/edit-save-final-answer.png` |
| 真实 Electron 历史读取 | `test-results/thinking-history-Electron--1dbce-ut-exposing-marked-thinking/thinking-history-electron.png` |
| 真实 Electron 页面 reload 后 | `test-results/thinking-history-Electron--1dbce-ut-exposing-marked-thinking/thinking-history-reloaded.png` |

用户最初的截图可能含私有对话，未经额外许可不上传；上述验证图使用合成内容，不含真实会话数据。

### 本地证据（不提交）

工作区 `.tmp/contribution-verification/` 保留精确命令、真实退出码、源码/产物哈希、完整测试日志、基线对照和截图副本。此目录被 Git 忽略，部分记录含本地绝对路径，分享前需检查脱敏。

本说明是源码验证完成后新增的纯文档，不改变已验证的生产/测试 diff。尚无关联 issue 编号，不填写虚构的 `Closes #…`。这份说明不修改通用 PR 模板，也不授予自动发布或安装应用的权限。
