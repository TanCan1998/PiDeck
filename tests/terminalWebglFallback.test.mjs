import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * xterm WebGL 渲染器的装配契约（2026-10 dev 合并后回归，实机复现）。
 *
 * WebglAddon 的 activate() 要等终端挂到 DOM 才跑，且它在拿不到 WebGL2 时**同步 throw**
 * （如 Windows 旧驱动 / `--disable-gpu`）。这个 throw 发生在 xterm 的事件派发里：
 *   - 在 open() 之前 loadAddon，try/catch 只包住 loadAddon 本身 → activate 的异常逃逸成未捕获错误，
 *     renderer 直接崩在 commitPassiveMountEffect（真机日志："Uncaught Error: WebGL2 not supported"）；
 *   - 正确姿势是「open() 之后装配 + 整段 try/catch」，失败只留在 xterm 内置 DOM 渲染器上。
 *
 * 本测试钉住三件事：装配点在 open() 之后、装配代码在 try 块内、失败路径回退而非抛出。
 */

const source = readFileSync("src/renderer/src/components/terminal/TerminalDock.tsx", "utf8");

/** 去掉行注释与块注释：契约断言只认代码，不能被解释性注释里的同名标识符假绿。 */
function stripComments(value) {
	return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/.*$/gm, "");
}

test("WebGL 渲染器在 terminal.open() 之后才装配（activate 需要挂到 DOM 的终端）", () => {
	const code = stripComments(source);
	const openIndex = code.indexOf("terminal.open(");
	const webglIndex = code.indexOf("new WebglAddon(");
	assert.ok(openIndex >= 0, "必须仍然调用 terminal.open()");
	assert.ok(webglIndex >= 0, "必须仍然装配 WebglAddon（GPU 渲染是默认路径）");
	assert.ok(webglIndex > openIndex, "WebglAddon 必须在 terminal.open() 之后装配，否则 activate 的 throw 逃出 try/catch 并崩 renderer");
});

test("WebglAddon 装配被 try/catch 包住，取不到 WebGL2 时静默回退 DOM 渲染器", () => {
	const code = stripComments(source);
	const webglIndex = code.indexOf("new WebglAddon(");
	const tryIndex = code.lastIndexOf("try {", webglIndex);
	assert.ok(tryIndex >= 0, "装配点之前必须有 try 块");
	// try 块必须真的包含装配语句：取 try 起点到装配点之间不含 catch/finally 即说明没被提前关闭。
	const between = code.slice(tryIndex, webglIndex);
	assert.doesNotMatch(between, /\bcatch\b/, "try 块在装配之前就结束了，等于没包住");
	// 失败路径必须是降级而不是重新抛出。
	const after = code.slice(webglIndex);
	assert.match(after, /catch\s*\(/, "装配失败必须有 catch 兜底");
	assert.match(after, /console\.warn\(/, "回退时必须打一条 warn（便于现场诊断），但不向用户报错");
	assert.doesNotMatch(after.slice(0, after.indexOf("} catch")), /throw\b/, "装配段不得把异常抛给上层");
});
