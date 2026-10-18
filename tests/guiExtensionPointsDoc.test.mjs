/**
 * docs/gui-extension-points.md 镜像契约：参考文档必须包含能力目录（pluginDevCatalog）
 * 的全部落点 slotId、节点 kind、约束 id、事件 id 与两个镜像源文件名。
 * 目录更新而文档没跟上时这里红——遵守仓库源码/文档扫描契约的空白容忍写法。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const repoRoot = join(import.meta.dirname, "..");
const catalog = await loadTsCommonJs(join(repoRoot, "src/shared/pluginDevCatalog.ts"));
const doc = readFileSync(join(repoRoot, "docs/gui-extension-points.md"), "utf8");

test("扩展点文档含全部 GUI 落点 slotId 与方法名", () => {
	for (const slot of catalog.GUI_SLOTS) {
		assert.ok(doc.includes(`\`${slot.slotId}\``), `文档缺落点 ${slot.slotId}`);
		assert.ok(doc.includes(slot.method), `文档缺落点方法名 ${slot.method}`);
	}
});

test("扩展点文档含全部节点 kind（42）", () => {
	assert.equal(catalog.GUI_NODE_KINDS.length, 42);
	for (const k of catalog.GUI_NODE_KINDS) {
		assert.ok(doc.includes(`\`${k.kind}\``), `文档缺 kind ${k.kind}`);
	}
});

test("扩展点文档含全部硬约束 id 与常用事件", () => {
	for (const c of catalog.GUI_CONSTRAINTS) {
		assert.ok(doc.includes(`\`${c.id}\``), `文档缺约束 ${c.id}`);
	}
	for (const e of catalog.PI_COMMON_EVENTS) {
		assert.ok(doc.includes(`\`${e.id}\``), `文档缺事件 ${e.id}`);
	}
});

test("扩展点文档声明镜像源与事实源（维护者导航）", () => {
	assert.ok(doc.includes("pluginDevCatalog"), "文档必须指向单一事实源 pluginDevCatalog");
	assert.ok(doc.includes("pi-deck-gui-bridge-gui-spec.ts"), "文档必须声明落点镜像源");
	assert.ok(doc.includes("pi-deck-gui-bridge-types.ts"), "文档必须声明 kind 镜像源");
	assert.ok(doc.includes("guiExtensionPointsDoc.test.mjs"), "文档必须声明本契约测试");
});
