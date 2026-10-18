/**
 * 插件开发契约测试：能力目录（pluginDevCatalog）镜像桥实现 + 指南（pluginDevGuide）内容。
 *
 * 镜像源：
 * - 15 落点 ← resources/extensions/pi-deck-gui-bridge-gui-spec.ts 的 GUI_SLOT_METHODS
 * - 42 节点 kind ← resources/extensions/pi-deck-gui-bridge-types.ts 的 UINode 联合
 * 目录抄漏/抄错这里会红——桥新增落点或 kind 时必须同步目录，防文档漂移。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const repoRoot = join(import.meta.dirname, "..");
const catalog = await loadTsCommonJs(join(repoRoot, "src/shared/pluginDevCatalog.ts"));
const guide = await loadTsCommonJs(join(repoRoot, "src/shared/pluginDevGuide.ts"));

const specSource = readFileSync(join(repoRoot, "resources/extensions/pi-deck-gui-bridge-gui-spec.ts"), "utf8");
const bridgeTypesSource = readFileSync(join(repoRoot, "resources/extensions/pi-deck-gui-bridge-types.ts"), "utf8");

/** 提取 GUI_SLOT_METHODS 的 method→slotId 映射（空白容忍：键值可跨行）。 */
function parseSlotMethods(source) {
	const block = source.match(/GUI_SLOT_METHODS\s*=\s*\{([\s\S]*?)\}\s*as const/);
	assert.ok(block, "GUI_SLOT_METHODS block not found in gui-spec.ts");
	const entries = new Map();
	for (const m of block[1].matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) entries.set(m[1], m[2]);
	return entries;
}

test("能力目录的 19 个落点与桥 gui-spec 的 GUI_SLOT_METHODS 双向一致", () => {
	const bridge = parseSlotMethods(specSource);
	assert.equal(catalog.GUI_SLOTS.length, 19, "落点总数（新增落点时同步文档与 AGENTS 速查行）");
	assert.equal(catalog.GUI_SLOTS.length, bridge.size, "目录落点数与桥实现不一致");
	for (const slot of catalog.GUI_SLOTS) {
		assert.ok(bridge.has(slot.method), `目录有而桥没有的落点方法: ${slot.method}`);
		assert.equal(bridge.get(slot.method), slot.slotId, `落点 slotId 与桥不一致: ${slot.method}`);
		assert.ok(slot.zh && slot.en, `落点缺双语文案: ${slot.method}`);
	}
});

test("能力目录的节点 kind 与桥 UINode 联合双向一致（42 种）", () => {
	const bridgeKinds = new Set([...bridgeTypesSource.matchAll(/kind:\s*"([a-z-]+)"/g)].map((m) => m[1]));
	const catalogKinds = new Set(catalog.GUI_NODE_KINDS.map((k) => k.kind));
	assert.deepEqual([...catalogKinds].sort(), [...bridgeKinds].sort(), "目录与桥的 kind 集合必须互为镜像");
	assert.equal(catalogKinds.size, 42, "kind 总数（新增 kind 时同步这里的预期与文档）");
	const groups = new Set(catalog.GUI_NODE_GROUPS.map((g) => g.id));
	for (const k of catalog.GUI_NODE_KINDS) {
		assert.ok(groups.has(k.group), `kind ${k.group ? k.kind : k.kind} 引用了不存在的分组: ${k.group}`);
		assert.ok(k.zh && k.en, `kind 缺双语文案: ${k.kind}`);
	}
});

test("指南双语生成：包含全部落点/kind/约束/事件与目录插值", () => {
	const userDir = join("X:", "home", "demo", ".pi", "agent", "extensions");
	for (const locale of ["zh-CN", "en-US"]) {
		const md = guide.buildPluginDevGuideMarkdown(locale, { userExtensionsDir: userDir });
		assert.ok(md.length > 4000, `${locale} 指南过短，疑似表格缺失`);
		for (const slot of catalog.GUI_SLOTS) {
			assert.ok(md.includes(`\`${slot.slotId}\``), `${locale} 指南缺落点 ${slot.slotId}`);
		}
		for (const k of catalog.GUI_NODE_KINDS) {
			assert.ok(md.includes(`\`${k.kind}\``), `${locale} 指南缺 kind ${k.kind}`);
		}
		for (const c of catalog.GUI_CONSTRAINTS) {
			assert.ok(md.includes(`\`${c.id}\``), `${locale} 指南缺约束 ${c.id}`);
		}
		for (const e of catalog.PI_COMMON_EVENTS) {
			assert.ok(md.includes(`\`${e.id}\``), `${locale} 指南缺事件 ${e.id}`);
		}
		assert.ok(md.includes(userDir), `${locale} 指南未插值用户扩展目录`);
		assert.ok(md.includes(catalog.DEMO_PLUGIN_FILENAME), `${locale} 指南未提及 demo 文件名`);
		// 安全模型与判空约束必须出现在两个语种里（AI 最容易踩的两点）
		assert.match(md, /tone/i);
		assert.match(md, /MAX_NODES=2000/);
	}
	const zh = guide.buildPluginDevGuideMarkdown("zh-CN", { userExtensionsDir: userDir });
	const en = guide.buildPluginDevGuideMarkdown("en-US", { userExtensionsDir: userDir });
	assert.notEqual(zh, en, "双语指南不应相同");
});

test("常量与目录声明一致：指南文件名常量被 guide 模块再导出", () => {
	assert.equal(guide.PLUGIN_DEV_GUIDE_FILENAME, catalog.PLUGIN_DEV_GUIDE_FILENAME);
	assert.equal(guide.DEMO_PLUGIN_FILENAME, catalog.DEMO_PLUGIN_FILENAME);
	assert.equal(catalog.PLUGIN_DEV_GUIDE_FILENAME, "AI-PLUGIN-GUIDE.md");
	assert.equal(catalog.DEMO_PLUGIN_FILENAME, "pi-deck-demo-plugin.ts");
});
