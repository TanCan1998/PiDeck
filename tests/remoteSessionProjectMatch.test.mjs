import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 会话归属判定（R2）：同主机多项目时，导入的会话必须落到它**实际所在**的项目，而不是「列表里第一个」。
 *
 * 真机 e2e 现象：从项目 A 导入会话后回执说成功、主区域也切过去了，但项目 A 的清单里没有它，那条记录的
 * 「已导入」标记也不显示（标记正是从该清单推出来的）。根因是装配按「该主机上第一个 ssh 项目」归属。
 */
const { encodePiSessionDirectory, matchRemoteSessionProject } = loadTsCommonJs("src/main/remote/remoteSessionProjectMatch.ts");

test("the directory encoding matches pi's own rule", () => {
	// pi 1.0.4 dist/core/session-manager.js:286-295 的原文：去掉开头斜杠，把 / \\ : 换成 -，两侧各加 --
	assert.equal(encodePiSessionDirectory("/home/dev/proj-a"), "--home-dev-proj-a--");
	// 用 join 构造，避免测试源码里的反斜杠转义歧义。注意 pi 的规则把 `:` 与 `\` **各自**换成 `-`，
	// 而 Windows 路径里这两者相邻，所以 `C:\Users` 会变成 `C--Users`（双横线是忠实结果，不是笔误）。
	assert.equal(encodePiSessionDirectory(["C:", "Users", "dev", "proj"].join("\\")), "--C--Users-dev-proj--");
});

test("a session under project B resolves to B, not to the first candidate", () => {
	const candidates = [
		{ id: "project-a", remotePath: "/home/dev/proj-a" },
		{ id: "project-b", remotePath: "/home/dev/proj-b" },
	];
	assert.equal(matchRemoteSessionProject(candidates, "--home-dev-proj-b--/2026-01-01T00-00-00-000Z_abc.jsonl"), "project-b");
	assert.equal(matchRemoteSessionProject(candidates, "--home-dev-proj-a--/2026-01-01T00-00-00-000Z_abc.jsonl"), "project-a");
});

test("an unresolvable session fails closed instead of guessing", () => {
	const candidates = [
		{ id: "project-a", remotePath: "/home/dev/proj-a" },
		{ id: "project-b", remotePath: "/home/dev/proj-b" },
	];
	// 编码对不上（例如别的 cwd 的会话）⇒ 不猜
	assert.equal(matchRemoteSessionProject(candidates, "--home-dev-elsewhere--/x.jsonl"), undefined);
	// 自定义 sessionDir 是平铺的（没有 encoded-cwd 段）⇒ 多候选时同样不猜
	assert.equal(matchRemoteSessionProject(candidates, "flat.jsonl"), undefined);
});

test("a single project keeps working even when the encoding cannot match", () => {
	const only = [{ id: "project-a", remotePath: "/home/dev/proj-a" }];
	// 只有一个候选时维持旧行为：不因编码差异（或平铺布局）退化
	assert.equal(matchRemoteSessionProject(only, "flat.jsonl"), "project-a");
	assert.equal(matchRemoteSessionProject(only, "--home-dev-proj-a--/x.jsonl"), "project-a");
});
