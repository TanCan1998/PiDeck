/**
 * PluginDevService 行为测试：demo 复制（不覆盖已存在）、指南落盘、源缺失报错、status 聚合。
 * 用临时目录伪造 home 与 dev 资源根（isDev: true 走 appPath/resources/plugin-dev），
 * 不碰真实 ~/.pi 与打包资源。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const mod = await loadTsCommonJs(join(import.meta.dirname, "../src/main/extensions/PluginDevService.ts"));
const { PluginDevService } = mod;

const DEMO_NAME = "pi-deck-demo-plugin.ts";
const GUIDE_NAME = "AI-PLUGIN-GUIDE.md";

function makeFixture() {
	const home = mkdtempSync(join(tmpdir(), "pideck-plugindev-"));
	const appPath = mkdtempSync(join(tmpdir(), "pideck-plugindev-app-"));
	const srcDir = join(appPath, "resources", "plugin-dev");
	mkdirSync(srcDir, { recursive: true });
	writeFileSync(join(srcDir, DEMO_NAME), "// demo fixture\nexport function activate() {}\n");
	const svc = () => new PluginDevService({ isDev: true, appPath, resourcesPath: appPath }, () => home);
	return {
		home,
		appPath,
		svc,
		cleanup: () => {
			rmSync(home, { recursive: true, force: true });
			rmSync(appPath, { recursive: true, force: true });
		},
	};
}

test("copyDemoPlugin：首次复制到用户扩展目录，内容一致", async () => {
	const fx = makeFixture();
	try {
		const copied = await fx.svc().copyDemoPlugin();
		assert.equal(copied.status, "copied");
		assert.equal(copied.path, join(fx.home, ".pi", "agent", "extensions", DEMO_NAME));
		assert.equal(readFileSync(copied.path, "utf8"), "// demo fixture\nexport function activate() {}\n");
	} finally {
		fx.cleanup();
	}
});

test("copyDemoPlugin：已存在不覆盖（用户改过的模板不能被冲掉）", async () => {
	const fx = makeFixture();
	try {
		const targetDir = join(fx.home, ".pi", "agent", "extensions");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, DEMO_NAME), "// user modified\n");
		const copied = await fx.svc().copyDemoPlugin();
		assert.equal(copied.status, "exists");
		assert.equal(readFileSync(copied.path, "utf8"), "// user modified\n");
	} finally {
		fx.cleanup();
	}
});

test("copyDemoPlugin：源缺失（打包漏资源）必须显式抛错而非静默成功", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-plugindev-empty-"));
	const appPath = mkdtempSync(join(tmpdir(), "pideck-plugindev-app2-"));
	try {
		const svc = new PluginDevService({ isDev: true, appPath, resourcesPath: appPath }, () => home);
		await assert.rejects(() => svc.copyDemoPlugin(), /missing/i);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(appPath, { recursive: true, force: true });
	}
});

test("writeGuide：生成指南到用户扩展目录并覆盖旧版（返回路径）", async () => {
	const fx = makeFixture();
	try {
		const en = await fx.svc().writeGuide("en-US");
		assert.ok(en.endsWith(GUIDE_NAME));
		assert.ok(readFileSync(en, "utf8").includes("What it occupies"), "应生成英文指南");
		const zh = await fx.svc().writeGuide("zh-CN");
		assert.equal(zh, en);
		assert.ok(readFileSync(zh, "utf8").includes("落点说明"), "覆盖为中文指南（生成物不备份）");
	} finally {
		fx.cleanup();
	}
});

test("status：聚合目录路径与安装状态", async () => {
	const fx = makeFixture();
	try {
		const svc = fx.svc();
		// loadTsCommonJs 走 vm，返回对象是跨 realm 的：deepStrictEqual 会因原型不同误报，逐字段断言
		const st = svc.status();
		assert.equal(st.userExtensionsDir, join(fx.home, ".pi", "agent", "extensions"));
		assert.equal(st.demoInstalled, false);
		assert.equal(st.guideInstalled, false);
		await svc.copyDemoPlugin();
		assert.equal(svc.status().demoInstalled, true);
		assert.equal(svc.status().guideInstalled, false);
	} finally {
		fx.cleanup();
	}
});
