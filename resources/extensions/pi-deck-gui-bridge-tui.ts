/**
 * pi-deck-gui-bridge —— pi-tui **路径**定位器（只解析路径，不加载模块）。
 *
 * ## 为什么不再加载 pi-tui 模块
 *
 * 序列化层（pi-deck-gui-bridge-serialize.ts）早期靠 `createRequire` 加载
 * **与 pi 同一份**的 pi-tui 模块做 `instanceof` 判别——这是桥对 pi 内部
 * 布局的硬耦合：要猜中安装位置、要同名包还在、要没被打进 bundle。
 *
 * 现在组件识别改为**沿实例原型链收集构造器名**（见 serialize 的 `hasKind`）：
 * 类名直接读自活对象自己，天然同实例、天然覆盖子类（`Loader extends Text`），
 * 不需要加载任何 pi 内部模块。本文件因此只剩一个职责：
 *
 * ## 现在的唯一职责：给「需要 pi 安装路径」的功能提供解析基点
 *
 * - ext-points 扩展要从 pi 的 `dist/core/extensions/types.d.ts` 运行时推导
 *   扩展点清单，需要一个位于 pi 安装树内的种子路径；
 * - 桥启动时打一条诊断日志（定位成功与否、走了哪条路径）。
 *
 * 定位失败不抛错、不影响桥与 pi —— 调用方各自降级（fail-safe）。
 *
 * ## 为什么解析路径也不能静态 import
 *
 * pi 扩展由 jiti 加载，裸 import 会从**扩展文件所在目录向上**找 node_modules。
 * 本仓库（以及 <userData>/builtin-extensions 覆盖层）里都没有 pi-tui，
 * 静态 import 会直接 MODULE_NOT_FOUND → pi 启动失败。因此仍是
 * 「先定位 pi 自己的安装位置，再从那里解析」。
 *
 * ⚠️ 这里**刻意不用 `import.meta.url` / `require.main`**：
 * 扩展既可能被 jiti 按 ESM 加载，也可能被测试按 CJS 转译执行，
 * 两者对 `import.meta` / `require` 的可用性相反。只用 `process.*` 才两边都安全。
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** pi-tui 组件的最小结构（只依赖公开契约，不依赖完整 .d.ts）。 */
export type PiTuiComponent = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	dispose?(): void;
	constructor?: { name?: string };
};

/** 定位结果：成功给出路径与来源，失败给出原因（供日志，不影响 pi）。 */
export type PiTuiLocateResult = { path: string; via: string } | { path: null; error: string };

let cached: PiTuiLocateResult | null = null;

/**
 * 收集「pi 安装位置」的候选锚点文件。
 *
 * 按可靠性排序：
 * 1. `PIDECK_BRIDGE_PI_PATH` —— PiDeck spawn pi 时注入，最可靠（不猜）；
 * 2. `process.argv` 里任何形似 pi 安装路径的条目 —— 真实 pi 进程里
 *    `argv[1]` 是 `<pi>/dist/bundle/cli.js`；WSL / 自定义启动器下可能是别的下标；
 * 3. `process.execPath` 同级的 npm 全局 node_modules —— 兜底（全局安装布局）。
 *
 * 每个锚点只用于 `createRequire` 的解析基点，**不要求它本身存在**：
 * `createRequire` 只用它的目录去向上找 node_modules（已实测）。
 */
function collectAnchorCandidates(): { anchor: string; via: string }[] {
	const anchors: { anchor: string; via: string }[] = [];
	const seen = new Set<string>();
	const push = (anchor: string, via: string): void => {
		const normalized = anchor.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		anchors.push({ anchor: normalized, via });
	};

	const explicit = process.env.PIDECK_BRIDGE_PI_PATH?.trim();
	if (explicit) push(explicit, "PIDECK_BRIDGE_PI_PATH");

	// argv 里任何指向 pi 包的路径都是好锚点：优先含 "pi-coding-agent" 的，
	// 再退到 argv[1]（常规启动器下就是 pi 的 CLI 入口）。
	const argvEntries = process.argv.slice(1).filter((arg): arg is string => typeof arg === "string" && arg.length > 0);
	for (const entry of argvEntries) {
		if (/pi-coding-agent/.test(entry)) push(entry, `process.argv（含 pi-coding-agent）`);
	}
	if (argvEntries[0]) push(argvEntries[0], "process.argv[1]");

	// 兜底：node 可执行文件同级的 npm 全局布局
	// （Windows: <node>/../npm/node_modules；Unix: <node>/../lib/node_modules）
	try {
		const execDir = dirname(process.execPath);
		for (const rel of [
			join(execDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
			join(execDir, "..", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
			join(execDir, "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
		]) {
			if (existsSync(rel)) push(rel, `execPath 兜底: ${rel}`);
		}
	} catch {
		// 忽略
	}

	// 兜底：npm 全局前缀的**标准位置**。
	// Windows 的 npm 全局前缀是 `%APPDATA%\npm`（不在 node 安装目录旁边），
	// 只查 execPath 同级会漏掉 —— 这是最常见的一种漏检。
	try {
		const globalRoots: (string | null)[] = [];
		const appData = process.env.APPDATA;
		if (appData) globalRoots.push(join(appData, "npm", "node_modules"));
		const home = process.env.USERPROFILE || process.env.HOME;
		if (home) globalRoots.push(join(home, ".npm-global", "lib", "node_modules"));
		for (const root of globalRoots) {
			if (!root) continue;
			const rel = join(root, "@earendil-works", "pi-coding-agent", "package.json");
			if (existsSync(rel)) push(rel, `npm 全局前缀: ${rel}`);
		}
	} catch {
		// 忽略
	}

	// 最后兜底：以 cwd 为基点（pi 的 cwd 常是项目目录，node_modules 可能在其上层）
	push(join(process.cwd(), "__pideck_bridge_anchor__.js"), "cwd 兜底");

	return anchors;
}

/**
 * 从某锚点解析 pi-tui 的绝对路径；失败返回 null。
 *
 * 三条路径依次尝试：
 * 1. 直接 `resolve("@earendil-works/pi-tui")` —— 常见布局（pi-tui 有 require 条件）；
 * 2. 先解析 pi-coding-agent 再由它解析 —— 处理 pi-tui 未提升的布局；
 *    ⚠️ pi-coding-agent 是 **ESM-only**（`exports` 只有 `import` 条件），
 *    CJS 的 `resolve` 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，故这条常失败；
 * 3. **文件系统探测**：锚点目录向上逐级找 `node_modules/@earendil-works/pi-tui/package.json`。
 *    不依赖任何 resolve 语义，对 ESM-only / 各种提升布局都成立 —— 这是最可靠的一条。
 */
function resolveFromAnchor(anchor: string): string | null {
	// 1) 直接解析 pi-tui
	try {
		const req = createRequire(anchor);
		return req.resolve("@earendil-works/pi-tui");
	} catch {
		// 继续
	}
	// 2) 经 pi-coding-agent 解析
	try {
		const req = createRequire(anchor);
		const piBase = req.resolve("@earendil-works/pi-coding-agent");
		const piReq = createRequire(piBase);
		return piReq.resolve("@earendil-works/pi-tui");
	} catch {
		// 继续
	}
	// 3) 文件系统探测：从锚点目录向上找 pi-tui 的 package.json
	try {
		let dir = dirname(anchor);
		for (let depth = 0; depth < 12; depth += 1) {
			const candidate = join(dir, "node_modules", "@earendil-works", "pi-tui", "package.json");
			if (existsSync(candidate)) return candidate;
			// 也接受「锚点本身就在 node_modules 里」的布局：
			// <root>/node_modules/@earendil-works/pi-coding-agent/... → <root>/node_modules/@earendil-works/pi-tui
			const sibling = join(dir, "@earendil-works", "pi-tui", "package.json");
			if (existsSync(sibling)) return sibling;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		// 忽略
	}
	return null;
}

/** 逐个锚点尝试，返回首个成功的解析结果。 */
function resolvePiTuiPath(): { path: string; via: string } | null {
	for (const { anchor, via } of collectAnchorCandidates()) {
		const resolved = resolveFromAnchor(anchor);
		if (resolved) return { path: resolved, via: `${via} → ${resolved}` };
	}
	return null;
}

/**
 * 定位 pi-tui 的安装路径（进程内只解析一次，结果缓存）。
 *
 * 返回 `{ path: null }` 表示定位失败：桥与序列化不受影响，
 * 只有 ext-points 的 types.d.ts 种子少一路（它还有 argv 兜底）。
 */
export function locatePiTui(): PiTuiLocateResult {
	if (cached) return cached;
	const resolved = resolvePiTuiPath();
	if (!resolved) {
		cached = { path: null, error: "无法定位 @earendil-works/pi-tui（已尝试 env / argv / execPath / npm 全局前缀 / cwd 兜底）" };
		return cached;
	}
	cached = resolved;
	return cached;
}

/** 已定位到的 pi-tui 路径（仅用于 ext-points 种子与诊断日志；未定位时为 null）。 */
export function piTuiResolvedPath(): string | null {
	if (!cached || !cached.path) return null;
	return cached.path;
}

/** 已定位来源描述（诊断用）。 */
export function piTuiResolvedVia(): string | null {
	if (!cached || !cached.path) return null;
	return cached.via;
}

/** 仅测试用：清空缓存。 */
export function resetPiTuiCacheForTests(): void {
	cached = null;
}
