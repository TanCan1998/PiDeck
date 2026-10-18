/**
 * 插件开发 AI 指南生成器 —— 把「给 PiDeck 写插件」的全部要素写成一份
 * 可以直接当提示词用的 Markdown（AI-PLUGIN-GUIDE.md）。
 *
 * 与主题的 customThemeGuide.ts 同构：数据来自 pluginDevCatalog.ts（单一事实源），
 * 双语模板拼装，Service 落盘到用户扩展目录。
 */

import { DEMO_PLUGIN_FILENAME, GUI_CONSTRAINTS, GUI_NODE_GROUPS, GUI_NODE_KINDS, GUI_SERVICES, GUI_SLOTS, PI_COMMON_EVENTS, PI_EXTENSION_APIS, type CatalogEntry, type GuideLocale } from "./pluginDevCatalog";

export { PLUGIN_DEV_GUIDE_FILENAME, DEMO_PLUGIN_FILENAME } from "./pluginDevCatalog";

export type PluginDevGuidePaths = {
	/** 用户级扩展目录（~/.pi/agent/extensions）。 */
	userExtensionsDir: string;
	/** 项目级扩展目录（<项目>/.pi/extensions），可缺省。 */
	projectExtensionsDir?: string;
};

type Dict = {
	title: string;
	whatIsHeading: string;
	whatIs: string[];
	installHeading: string;
	install: string[];
	quickstartHeading: string;
	quickstart: string[];
	piApiHeading: string;
	piApiLead: string;
	eventsHeading: string;
	eventsLead: string;
	guiHeading: string;
	guiLead: string[];
	slotsHeading: string;
	servicesHeading: string;
	nodesHeading: string;
	nodesLead: string;
	constraintsHeading: string;
	constraintsLead: string;
	securityHeading: string;
	security: string[];
	debugHeading: string;
	debug: string[];
	forAiHeading: string;
	forAi: string[];
	noPluginHeading: string;
	noPlugin: string[];
};

const ZH: Dict = {
	title: "PiDeck 插件开发指南（AI 编写插件用）",
	whatIsHeading: "一、插件是什么",
	whatIs: ["PiDeck 的插件 = **pi 扩展**：一个 TypeScript 文件（pi 用 jiti 直接加载，无需编译打包），运行在 pi 进程里。", "它能用 pi 的全部原生扩展点（命令、工具、事件、模型供应商…），再通过 GUI 桥把声明式 UI 渲染进 PiDeck 界面。", "本文件是完整规格说明——把它作为提示词交给任意 AI，即可让它按规范写出能直接运行的插件。"],
	installHeading: "二、放哪里、怎么生效",
	install: ["- 用户级（所有项目生效）：把 `.ts` 文件放进 `{USER_DIR}`（不存在就创建）", "- 项目级（仅当前项目）：放进 `{PROJECT_DIR}`", "- 生效方式：**重启会话**（PiDeck 会话工具栏的重启按钮）。设置 → 扩展页可启用/禁用单个扩展", "- 多文件插件：用子目录 + `index.ts` 入口；npm 依赖写在旁边的 package.json 里"],
	quickstartHeading: "三、三分钟起步（复制 demo 改）",
	quickstart: [
		"1. 把应用内置的 `{DEMO}` 复制到上述目录（PiDeck 设置 → 扩展 → 插件开发 → 「复制 demo 插件」）",
		"2. 重启会话：侧栏出现「Demo 统计」面板（含 Hello/选文件/打开按钮），`/demo` 命令可执行；demo 刻意只占侧栏一个落点，不碰输入区等共享位置",
		"3. demo 演示了全部三层能力：命令注册、事件统计、GUI 落点与宿主服务——照着改就是你的插件",
	],
	piApiHeading: "四、pi 原生扩展点（任何宿主可用）",
	piApiLead: "默认导出一个工厂函数，收到 `pi: ExtensionAPI`：",
	eventsHeading: "常用事件（pi.on）",
	eventsLead: "handler 签名 `(event, ctx) => void | 效果`；完整 39 个事件见 pi 官方 docs/extensions.md。",
	guiHeading: "五、PiDeck 专属：ctx.ui.gui（GUI 落点）",
	guiLead: [
		"入口：事件回调的 `ctx.ui.gui`（桥挂载后所有事件里可靠可用；纯终端宿主为 `undefined`，**用前必须判空**）。",
		"统一签名：`set*(key, factory | undefined, options?)`，`factory: (gui, theme, ctx) => GuiComponent | GuiNode`；传 `undefined` 清除落点。",
		"`options`: `{ title?: string; order?: number }`（order 缺省 1000 升序）。",
	],
	slotsHeading: "19 个落点",
	servicesHeading: "交互与服务（落点之外）",
	nodesHeading: "六、节点目录（42 种 kind）",
	nodesLead: "GuiNode 是普通可序列化对象 `{ kind, ...字段, children?, id?, actionId? }`。`id` 供事件回灌定位，`actionId` 对应 `gui.command` 注册的处理器。",
	constraintsHeading: "七、硬约束（违反 = 内容被隐藏/降级，不报错）",
	constraintsLead: "排查「为什么我的 UI 没出现」先对照这张表：",
	securityHeading: "八、安全模型（必读）",
	security: ["- 插件运行在 pi 的 Node 进程里，**拥有用户本人的全部权限**（文件、网络、子进程）。", "- PiDeck 不做进程内沙箱；防护靠知情同意——只安装信任来源的插件。", "- UI 侧的声明式约束（tone 色、节点目录、上限）只保护界面，不限制插件代码本身。"],
	debugHeading: "九、调试",
	debug: ["- 桥日志走 pi 进程 stderr（`[pi-deck-gui-bridge]` 前缀，落 PiDeck 日志）：贡献被隐藏的原因都在里面", "- 改完插件 → 重启会话（当前无热重载）", "- 落点贡献被隐藏的常见原因：返回了 React 元素 / 节点超 2000 / factory 抛错 / tone 拼写错"],
	forAiHeading: "十、写给 AI 的实现要求",
	forAi: [
		"1. 产出单文件 TypeScript（默认导出工厂函数），只用上表列出的 API 与节点 kind",
		"2. 每个落点 key 用插件名做前缀（如 `my-plugin.panel`），避免与其他插件冲突",
		"3. 动态内容用 GuiComponent（render 每帧重建）；静态内容可直接返回 GuiNode",
		"4. `ctx.ui.gui` 用前判空；会话结束在 `session_shutdown` 清理落点（传 undefined）",
		"5. 颜色一律用语义 tone；不要在节点里塞函数/React 元素/循环引用",
		"6. 文件头部写注释：插件名、放置目录、演示的能力",
	],
	noPluginHeading: "十一、不用写插件的开放面",
	noPlugin: [
		"不是所有定制都需要插件——以下能力零代码直接可用，优先考虑：",
		"- **自定义主题**：设置 → 外观可导入 JSON 主题（`AI-THEME-GUIDE.md` 是给 AI 的完整规格，同样复制即用）",
		"- **提示词库 / 技能**：设置里的提示词与技能商店，或直接放 SKILL.md 到 `.pi/agent/skills/`",
		"- **模型供应商**：`~/.pi/agent/config.json` 可配任意 OpenAI 兼容端点（含自定义 provider）",
		"- **用量探针**：`usage-probes.json` 可为任意供应商写余额/用量查询",
		"插件适合的是「需要往界面里挂新 UI / 拦截事件 / 加工具」的场景。",
	],
};

const EN: Dict = {
	title: "PiDeck Plugin Development Guide (for AI-assisted authoring)",
	whatIsHeading: "1. What a plugin is",
	whatIs: [
		"A PiDeck plugin = **a pi extension**: one TypeScript file (loaded by pi via jiti — no build step) running inside the pi process.",
		"It can use every native pi extension point (commands, tools, events, providers…), and renders declarative UI into PiDeck through the GUI bridge.",
		"This file is the full spec — hand it to any AI as a prompt and it can write a working plugin.",
	],
	installHeading: "2. Where it goes and how it activates",
	install: [
		"- User scope (all projects): drop the `.ts` file into `{USER_DIR}` (create it if missing)",
		"- Project scope (one project): drop it into `{PROJECT_DIR}`",
		"- Activation: **restart the session** (restart button in the session toolbar). Toggle per-extension from Settings → Extensions",
		"- Multi-file plugins: a subdirectory with an `index.ts` entry; npm deps go in a sibling package.json",
	],
	quickstartHeading: "3. Three-minute quickstart (copy the demo)",
	quickstart: [
		"1. Copy the bundled `{DEMO}` into the directory above (PiDeck → Settings → Extensions → Plugin development → “Copy demo plugin”)",
		"2. Restart the session: a “Demo stats” panel appears in the sidebar (with Hello / pick-file / open buttons) and `/demo` runs. The demo deliberately occupies only the sidebar slot — it never touches the composer or other shared areas",
		"3. The demo exercises all three layers — command, event stats, GUI slots — copy and modify it",
	],
	piApiHeading: "4. Native pi extension points (work in any host)",
	piApiLead: "Default-export a factory that receives `pi: ExtensionAPI`:",
	eventsHeading: "Common events (pi.on)",
	eventsLead: "Handler signature: `(event, ctx) => void | effect`. See pi's official docs/extensions.md for all 39 events.",
	guiHeading: "5. PiDeck-specific: ctx.ui.gui (GUI slots)",
	guiLead: [
		"Entry: `ctx.ui.gui` inside event handlers (reliable on every event once the bridge mounts; `undefined` in a plain terminal — **always guard**).",
		"Uniform signature: `set*(key, factory | undefined, options?)`, `factory: (gui, theme, ctx) => GuiComponent | GuiNode`; pass `undefined` to clear.",
		"`options`: `{ title?: string; order?: number }` (order defaults to 1000, ascending).",
	],
	slotsHeading: "The 19 slots",
	servicesHeading: "Interaction & services (beyond slots)",
	nodesHeading: "6. Node catalog (42 kinds)",
	nodesLead: "A GuiNode is a plain serializable object `{ kind, ...fields, children?, id?, actionId? }`. `id` locates the node on event echo; `actionId` maps to a `gui.command` handler.",
	constraintsHeading: "7. Hard constraints (violations hide/degrade content — no error)",
	constraintsLead: "When “my UI doesn't show up”, check this table first:",
	securityHeading: "8. Security model (read this)",
	security: [
		"- Plugins run inside pi's Node process with **the user's full permissions** (files, network, subprocesses).",
		"- PiDeck has no in-process sandbox; protection is informed consent — install only plugins from sources you trust.",
		"- The declarative UI constraints (tone colors, node catalog, caps) protect the interface only, not plugin code.",
	],
	debugHeading: "9. Debugging",
	debug: ["- Bridge logs go to pi's stderr (`[pi-deck-gui-bridge]` prefix, visible in PiDeck logs): hidden-contribution reasons appear there", "- Edit → restart the session (no hot reload yet)", "- Common hidden-contribution causes: returned a React element / nodes over 2000 / factory threw / tone typo"],
	forAiHeading: "10. Implementation requirements for the AI",
	forAi: [
		"1. Produce a single TypeScript file (default-export factory) using only the APIs and node kinds listed above",
		"2. Prefix every slot key with the plugin name (e.g. `my-plugin.panel`) to avoid collisions",
		"3. Use a GuiComponent for dynamic content (render rebuilds each frame); a bare GuiNode for static content",
		"4. Guard `ctx.ui.gui`; clear slots on `session_shutdown` (pass undefined)",
		"5. Semantic tones only; never embed functions/React elements/cycles in nodes",
		"6. Comment the file header: plugin name, target directory, capabilities demonstrated",
	],
	noPluginHeading: "11. Open surfaces that need no plugin",
	noPlugin: [
		"Not every customization needs a plugin — these are zero-code and should be preferred:",
		"- **Custom themes**: Settings → Appearance imports JSON themes (`AI-THEME-GUIDE.md` is the full AI spec — copy and go)",
		"- **Prompts / skills**: the built-in prompt & skill stores, or drop a SKILL.md into `.pi/agent/skills/`",
		"- **Model providers**: `~/.pi/agent/config.json` accepts any OpenAI-compatible endpoint (custom providers included)",
		"- **Usage probes**: `usage-probes.json` can query balance/usage for any provider",
		"Plugins are for “new UI in the interface / event interception / extra tools” scenarios.",
	],
};

function entryTable(rows: readonly CatalogEntry[], idHeader: string, descHeader: string): string {
	return [`| ${idHeader} | ${descHeader} |`, "| --- | --- |", ...rows.map((row) => `| \`${row.id}\` | ${row.zh} |`)].join("\n");
}

function slotTable(locale: GuideLocale): string {
	const desc = locale === "zh-CN" ? "落点说明" : "What it occupies";
	return [`| Method | Slot id | ${desc} |`, "| --- | --- | --- |", ...GUI_SLOTS.map((slot) => `| \`ctx.ui.gui.${slot.method}()\` | \`${slot.slotId}\` | ${locale === "zh-CN" ? slot.zh : slot.en} |`)].join("\n");
}

function nodeTable(locale: GuideLocale): string {
	return GUI_NODE_GROUPS.map((group) => {
		const rows = GUI_NODE_KINDS.filter((kind) => kind.group === group.id);
		return [`**${locale === "zh-CN" ? group.zh : group.en}**`, "", ["| kind | 说明 / Notes |", "| --- | --- |", ...rows.map((row) => `| \`${row.kind}\` | ${locale === "zh-CN" ? row.zh : row.en} |`)].join("\n")].join("\n");
	}).join("\n\n");
}

/** 生成完整指南 Markdown（双语文案，路径按调用方环境插值）。 */
export function buildPluginDevGuideMarkdown(locale: GuideLocale, paths: PluginDevGuidePaths): string {
	const dict = locale === "zh-CN" ? ZH : EN;
	const label = locale === "zh-CN" ? "说明" : "Notes";
	const userDir = paths.userExtensionsDir;
	const projectDir = paths.projectExtensionsDir ?? (locale === "zh-CN" ? "<项目>/.pi/extensions" : "<project>/.pi/extensions");
	const fill = (lines: string[]): string[] => lines.map((line) => line.replaceAll("{USER_DIR}", userDir).replaceAll("{PROJECT_DIR}", projectDir).replaceAll("{DEMO}", DEMO_PLUGIN_FILENAME));

	return [
		`# ${dict.title}`,
		"",
		`> ${locale === "zh-CN" ? "生成时间无关的规格文档；能力清单与 PiDeck 内部实现由契约测试保证同步。" : "A spec document; the capability catalog is kept in sync with PiDeck internals by contract tests."}`,
		"",
		`## ${dict.whatIsHeading}`,
		"",
		...dict.whatIs,
		"",
		`## ${dict.installHeading}`,
		"",
		...fill(dict.install),
		"",
		`## ${dict.quickstartHeading}`,
		"",
		...fill(dict.quickstart),
		"",
		`## ${dict.piApiHeading}`,
		"",
		dict.piApiLead,
		"",
		entryTable(PI_EXTENSION_APIS, "API", label),
		"",
		`### ${dict.eventsHeading}`,
		"",
		dict.eventsLead,
		"",
		entryTable(PI_COMMON_EVENTS, "Event", label),
		"",
		`## ${dict.guiHeading}`,
		"",
		...dict.guiLead,
		"",
		`### ${dict.slotsHeading}`,
		"",
		slotTable(locale),
		"",
		`### ${dict.servicesHeading}`,
		"",
		entryTable(GUI_SERVICES, "API", label),
		"",
		`## ${dict.nodesHeading}`,
		"",
		dict.nodesLead,
		"",
		nodeTable(locale),
		"",
		`## ${dict.constraintsHeading}`,
		"",
		dict.constraintsLead,
		"",
		entryTable(GUI_CONSTRAINTS, "Constraint", label),
		"",
		`## ${dict.securityHeading}`,
		"",
		...dict.security,
		"",
		`## ${dict.debugHeading}`,
		"",
		...dict.debug,
		"",
		`## ${dict.forAiHeading}`,
		"",
		...dict.forAi,
		"",
		`## ${dict.noPluginHeading}`,
		"",
		...fill(dict.noPlugin),
		"",
	].join("\n");
}
