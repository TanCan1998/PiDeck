/**
 * 插件开发「能力目录」—— 指南（AI-PLUGIN-GUIDE.md）与文档（docs/gui-extension-points.md）
 * 共用的单一事实源。
 *
 * 数据镜像自：
 * - resources/extensions/pi-deck-gui-bridge-gui-spec.ts 的 GUI_SLOT_METHODS（15 落点）
 * - resources/extensions/pi-deck-gui-bridge-types.ts 的 UINode 联合类型（42 种 kind）
 * - pi 官方文档 docs/extensions.md 的扩展点表
 *
 * 由 tests/pluginDevGuide.test.mjs / tests/guiExtensionPointsDoc.test.mjs
 * 反向解析上述源码做镜像校验——这里抄漏/抄错会红，防止文档漂移。
 */

export type GuideLocale = "zh-CN" | "en-US";

export type CatalogEntry = {
	id: string;
	zh: string;
	en: string;
};

/** pi 原生扩展 API（任何宿主可用；完整签名见 pi 官方 docs/extensions.md）。 */
export const PI_EXTENSION_APIS: readonly CatalogEntry[] = [
	{ id: "pi.registerCommand()", zh: "注册 / 斜杠命令", en: "Register a / slash command" },
	{ id: "pi.registerTool()", zh: "给模型添加可调用工具（TypeBox 参数 schema）", en: "Add a model-callable tool (TypeBox schema)" },
	{ id: "pi.registerToolRenderer()", zh: "自定义任意工具调用的渲染（含 MCP 工具）", en: "Custom rendering for any tool call (incl. MCP tools)" },
	{ id: "pi.registerProvider()", zh: "添加自定义模型供应商", en: "Add a custom model provider" },
	{ id: "pi.registerMcpServer()", zh: "添加 MCP 服务器", en: "Add an MCP server" },
	{ id: "pi.registerVirtualModel()", zh: "注册虚拟模型（请求路由/包装）", en: "Register a virtual model (request routing)" },
	{ id: "pi.registerShortcut() / pi.registerFlag()", zh: "注册快捷键 / CLI 旗标", en: "Register a shortcut / CLI flag" },
	{ id: "pi.on()", zh: "监听生命周期与消息事件（见下表）", en: "Listen to lifecycle and message events" },
	{ id: "pi.sendUserMessage() / pi.sendMessage()", zh: "以用户/自定义身份发消息", en: "Send user or custom messages" },
	{ id: "pi.appendEntry()", zh: "把非上下文数据持久化进会话文件", en: "Persist non-context session entries" },
	{ id: "pi.events", zh: "跨扩展通信的事件总线", en: "Event bus for cross-extension messaging" },
] as const;

/** 常用事件（节选；完整 39 个事件见 pi 官方文档）。 */
export const PI_COMMON_EVENTS: readonly CatalogEntry[] = [
	{ id: "session_start", zh: "会话启动（挂载 UI 落点的推荐时机）", en: "Session starts (recommended slot-mount point)" },
	{ id: "agent_start", zh: "一轮任务开始", en: "An agent run starts" },
	{ id: "before_agent_start", zh: "一轮任务开始前，可改提示词/工具集", en: "Before a run; can adjust prompt/toolset" },
	{ id: "tool_call", zh: "工具调用（可改参数或阻断）", en: "Tool call (may mutate or block)" },
	{ id: "tool_result", zh: "工具结果（可改写内容）", en: "Tool result (may rewrite content)" },
	{ id: "message_end", zh: "消息定稿（可替换保角色）", en: "Message finalized (replaceable)" },
	{ id: "agent_end", zh: "一轮任务结束（统计/通知的好时机）", en: "Run ends (good for stats/notify)" },
	{ id: "session_shutdown", zh: "会话结束（清理资源的配对点）", en: "Session ends (cleanup pair)" },
] as const;

/**
 * ctx.ui.gui 的 19 个 UI 落点。
 * 签名统一：set*(key, factory | undefined, options?)，传 undefined 清除该落点。
 * factory: (gui, theme, ctx) => GuiComponent | GuiNode。
 */
export type GuiSlotEntry = Omit<CatalogEntry, "id"> & { method: string; slotId: string };

export const GUI_SLOTS: readonly GuiSlotEntry[] = [
	{ method: "setSidebarPanel", slotId: "sidebar.panel", zh: "左侧边栏的整块面板", en: "A full panel in the left sidebar" },
	{ method: "setSidebarSection", slotId: "sidebar.section", zh: "侧栏内的一个分组区块", en: "A grouped section inside the sidebar" },
	{ method: "setContentView", slotId: "content.view", zh: "主内容区视图（整页替换，慎用）", en: "Main content view (full replace; use sparingly)" },
	{ method: "setComposerToolbar", slotId: "composer.toolbar", zh: "输入框上方的工具条", en: "Toolbar above the composer input" },
	{ method: "setTitlebarAction", slotId: "titlebar.action", zh: "标题栏动作区按钮", en: "Title bar action area" },
	{ method: "setBanner", slotId: "banner", zh: "顶部横幅（公告/警告）", en: "Top banner (notice/warning)" },
	{ method: "setToolExtra", slotId: "tool.extra", zh: "工具消息卡片的附加区", en: "Extra area on a tool message card" },
	{ method: "setMessageExtra", slotId: "message.extra", zh: "消息卡片的附加区", en: "Extra area on a message card" },
	{ method: "setThinkingExtra", slotId: "thinking.extra", zh: "思考块的附加区", en: "Extra area on a thinking block" },
	{ method: "setDialogAction", slotId: "dialog.action", zh: "对话框按钮行", en: "Dialog action row" },
	{ method: "setDialogBody", slotId: "dialog.body", zh: "对话框内容体", en: "Dialog body" },
	{ method: "setSettingsSection", slotId: "settings.section", zh: "设置弹窗底部追加一块", en: "Appended block in the settings dialog" },
	{ method: "setConfigPage", slotId: "config.page", zh: "「Pi 管理」侧栏里的整页（一级导航）", en: "A full page in the Pi-manage sidebar" },
	{ method: "setSessionItemExtra", slotId: "session.item", zh: "会话列表条目的附加徽标", en: "Extra badges on a session list item" },
	{ method: "setContextMenuItem", slotId: "context.menu", zh: "右键菜单项", en: "Context menu item" },
	{ method: "setTimelineEvent", slotId: "timeline.event", zh: "时间线底部的事件条（会话标记/备注）", en: "Event strip below the message timeline" },
	{ method: "setStatusbarItem", slotId: "statusbar.item", zh: "会话头部状态区的小条目", en: "Compact item in the session header status area" },
	{ method: "setTerminalToolbar", slotId: "terminal.toolbar", zh: "底部终端面板头部的工具区", en: "Toolbar area in the terminal dock header" },
	{ method: "setGitPanelSection", slotId: "git.panel.section", zh: "Git 面板底部的附加区块", en: "Extra section at the bottom of the Git panel" },
] as const;

/** ctx.ui.gui 的交互与服务方法（落点之外的部分）。 */
export const GUI_SERVICES: readonly CatalogEntry[] = [
	{ id: "gui.command(id, handler)", zh: "注册交互回调（按钮 actionId → 处理器）", en: "Register an interaction handler (actionId → handler)" },
	{ id: "gui.toast(message, { tone })", zh: "弹出轻提示", en: "Show a toast" },
	{ id: "gui.confirm(title, body, opts)", zh: "确认对话框（Promise<boolean>）", en: "Confirm dialog (Promise<boolean>)" },
	{ id: "gui.overlay(node, opts)", zh: "全屏浮层，返回带 close() 的句柄", en: "Full-screen overlay; returns a close handle" },
	{ id: "gui.custom(factory, opts)", zh: "全自定义画布（Promise 结果）", en: "Fully custom canvas (Promise result)" },
	{ id: "gui.icon(name, svgPath)", zh: "注册自定义图标供节点引用", en: "Register a custom icon for nodes" },
	{ id: "gui.filePicker(opts)", zh: "宿主原生文件选择框（Promise<string[] | null>）", en: "Host-native file picker (Promise<string[] | null>)" },
	{ id: "gui.openPath(path)", zh: "用系统默认程序打开文件/目录（Promise<boolean>）", en: "Open a file/dir with the OS default handler (Promise<boolean>)" },
	{ id: "gui.theme", zh: "宿主主题（语义 tone 档位，禁裸色值）", en: "Host theme (semantic tones; no raw colors)" },
] as const;

/** GuiNode 节点目录（42 种 kind；group 决定文档分组）。 */
export type GuiNodeKindEntry = Omit<CatalogEntry, "id"> & { kind: string; group: string };

export const GUI_NODE_GROUPS: readonly { id: string; zh: string; en: string }[] = [
	{ id: "basic", zh: "文本与基础", en: "Text & basics" },
	{ id: "layout", zh: "布局容器", en: "Layout" },
	{ id: "form", zh: "表单控件", en: "Form controls" },
	{ id: "data", zh: "数据展示", en: "Data display" },
	{ id: "feedback", zh: "反馈与浮层", en: "Feedback & overlays" },
	{ id: "native", zh: "宿主原生设置件", en: "Host-native settings" },
] as const;

export const GUI_NODE_KINDS: readonly GuiNodeKindEntry[] = [
	{ kind: "text", group: "basic", zh: "文本（style: dim/bold/italic…）", en: "Text (style tokens)" },
	{ kind: "markdown", group: "basic", zh: "Markdown 富文本", en: "Markdown rich text" },
	{ kind: "codeblock", group: "basic", zh: "代码块（language 高亮）", en: "Code block (syntax language)" },
	{ kind: "ansi", group: "basic", zh: "ANSI 字符行（降级保命出口）", en: "ANSI lines (degradation escape hatch)" },
	{ kind: "image", group: "basic", zh: "图片（src/alt）", en: "Image (src/alt)" },
	{ kind: "icon", group: "basic", zh: "图标（name + tone）", en: "Icon (name + tone)" },
	{ kind: "badge", group: "basic", zh: "徽标（tone 着色）", en: "Badge (tone-colored)" },
	{ kind: "divider", group: "basic", zh: "分隔线（可带 label）", en: "Divider (optional label)" },
	{ kind: "spacer", group: "layout", zh: "占位空白", en: "Spacer" },
	{ kind: "vstack", group: "layout", zh: "纵向堆叠（gap）", en: "Vertical stack (gap)" },
	{ kind: "hstack", group: "layout", zh: "横向堆叠（gap）", en: "Horizontal stack (gap)" },
	{ kind: "stack", group: "layout", zh: "方向堆叠（column/row + align）", en: "Directional stack (column/row + align)" },
	{ kind: "grid", group: "layout", zh: "网格（columns）", en: "Grid (columns)" },
	{ kind: "split", group: "layout", zh: "分栏（ratio）", en: "Split pane (ratio)" },
	{ kind: "box", group: "layout", zh: "内边距盒子（padding/bg）", en: "Padded box (padding/bg)" },
	{ kind: "card", group: "layout", zh: "卡片（title + children）", en: "Card (title + children)" },
	{ kind: "scroll", group: "layout", zh: "滚动区（maxHeight；pi-tui 兼容）", en: "Scroll area (maxHeight; tui-compatible)" },
	{ kind: "scrollarea", group: "layout", zh: "滚动区（GUI 原生）", en: "Scroll area (GUI native)" },
	{ kind: "collapse", group: "layout", zh: "可折叠分组（count/actionId）", en: "Collapsible group (count/actionId)" },
	{ kind: "tabs", group: "layout", zh: "标签页（active/actionId）", en: "Tabs (active/actionId)" },
	{ kind: "button", group: "form", zh: "按钮（actionId + tone/variant）", en: "Button (actionId + tone/variant)" },
	{ kind: "input", group: "form", zh: "单行输入（actionId）", en: "Single-line input (actionId)" },
	{ kind: "textarea", group: "form", zh: "多行输入（rows）", en: "Textarea (rows)" },
	{ kind: "editor", group: "form", zh: "代码编辑器", en: "Code editor" },
	{ kind: "select", group: "form", zh: "列表选择（pi-tui 兼容）", en: "List select (tui-compatible)" },
	{ kind: "selectinput", group: "form", zh: "下拉选择输入", en: "Dropdown select input" },
	{ kind: "checkbox", group: "form", zh: "复选框", en: "Checkbox" },
	{ kind: "switch", group: "form", zh: "开关", en: "Switch" },
	{ kind: "slider", group: "form", zh: "滑杆（min/max/step）", en: "Slider (min/max/step)" },
	{ kind: "list", group: "form", zh: "可导航列表（selected）", en: "Navigable list (selected)" },
	{ kind: "table", group: "data", zh: "表格（columns + rows）", en: "Table (columns + rows)" },
	{ kind: "tree", group: "data", zh: "树（expanded）", en: "Tree (expanded)" },
	{ kind: "keyvalue", group: "data", zh: "键值对列表", en: "Key-value list" },
	{ kind: "settings", group: "data", zh: "设置项列表（pi-tui 兼容）", en: "Settings list (tui-compatible)" },
	{ kind: "progress", group: "feedback", zh: "进度条（value/max）", en: "Progress bar (value/max)" },
	{ kind: "spinner", group: "feedback", zh: "加载指示", en: "Spinner" },
	{ kind: "loader", group: "feedback", zh: "加载器（frames 可定制）", en: "Loader (custom frames)" },
	{ kind: "toast", group: "feedback", zh: "轻提示（actions 可带按钮）", en: "Toast (optional action buttons)" },
	{ kind: "banner", group: "feedback", zh: "横幅（tone 着色）", en: "Banner (tone-colored)" },
	{ kind: "modal", group: "feedback", zh: "模态框（title/actions）", en: "Modal (title/actions)" },
	{ kind: "setting-box", group: "native", zh: "宿主设置页同源容器", en: "Host settings-page box" },
	{ kind: "setting-row", group: "native", zh: "宿主设置页同源行（title/description/level）", en: "Host settings-page row" },
] as const;

/** 硬约束（违反不是报错，就是内容被隐藏/降级——排查时先对照这张表）。 */
export const GUI_CONSTRAINTS: readonly CatalogEntry[] = [
	{ id: "MAX_NODES=2000", zh: "单次序列化节点数上限，超限该贡献整体隐藏", en: "Per-serialization node cap; oversized contributions are hidden" },
	{ id: "MAX_DEPTH=32", zh: "节点树深度上限", en: "Node-tree depth cap" },
	{ id: "tone-only", zh: "颜色只能用语义 tone 档（accent/success/warning/error/muted…），禁止裸色值", en: "Colors must use semantic tones only; raw color values are rejected" },
	{ id: "no-react", zh: "禁止返回 React 元素（$$typeof 检测）——声明式节点是唯一通道", en: "React elements are rejected; declarative nodes are the only path" },
	{ id: "degrade-ansi", zh: "宿主不认识的 kind 降级为纯文本渲染，绝不抛错", en: "Unknown kinds degrade to plain text; never throws" },
	{ id: "dynamic-component", zh: "动态内容必须返回 GuiComponent（render() 每帧重建）；直接返回 GuiNode 只求值一次", en: "Dynamic content must return a GuiComponent; a bare GuiNode is evaluated once" },
	{ id: "order-default-1000", zh: "落点 options.order 缺省 1000，升序排；同 order 按 key 字母序", en: "Slot order defaults to 1000 (ascending); ties sort by key" },
	{ id: "10hz-ticker", zh: "桥以 10Hz tick 重新求值贡献并做哈希去重推送——状态变了下一帧自动生效", en: "A 10Hz ticker re-evaluates and hash-dedupes; state changes apply next frame" },
] as const;

/** 指南里写死的文件名（Service 落盘与 UI 提示共用）。 */
export const PLUGIN_DEV_GUIDE_FILENAME = "AI-PLUGIN-GUIDE.md";
export const DEMO_PLUGIN_FILENAME = "pi-deck-demo-plugin.ts";
