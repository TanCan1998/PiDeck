// P0 诊断探针：分段测量 pi RPC 冷启动耗时（spawn → get_state 就绪）。
// 用法: node scripts/probePiStartup.mjs [iterations]
// 输出三种配置各 N 次的分段计时：node+pi 模块图（--version）、pi 核心 RPC 引导（--no-extensions）、全量扩展。
// 目的：定位「激活 8.4s」的构成，为 standby 池与独立优化提供数据。
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT_DIR = path.join(ROOT, "resources", "extensions");
const PI_CMD = process.platform === "win32" ? "pi.cmd" : "pi";
const ITER = Math.max(1, Number(process.argv[2]) || 2);
// 探针只关心启动耗时，不进入真实项目目录，避免扫描项目资源带来的波动。
const CWD = ROOT;

function hrtimeMsSince(t0) {
	return Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;
}

/** 单次 RPC 引导计时：spawn 后立刻发 get_state，记录 pid 分配/首行响应两个里程碑。 */
function probeRpc(args, label) {
	return new Promise((resolve) => {
		const t0 = process.hrtime.bigint();
		const child = spawn(PI_CMD, args, { cwd: CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });
		let pidMs = -1;
		let firstLineMs = -1;
		let buf = "";
		const fail = (reason) => {
			resolve({ label, pidMs, firstLineMs, error: reason });
			try {
				child.kill();
			} catch {
				/* noop */
			}
		};
		const timer = setTimeout(() => fail("timeout 30s"), 30_000);
		let stderrBuf = "";
		child.on("spawn", () => {
			pidMs = hrtimeMsSince(t0);
			child.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");
		});
		child.stdout.on("data", (chunk) => {
			if (firstLineMs < 0) firstLineMs = hrtimeMsSince(t0);
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				clearTimeout(timer);
				const line = buf.slice(0, nl);
				let ok = false;
				try {
					ok = JSON.parse(line)?.type === "response";
				} catch {
					/* noop */
				}
				child.kill();
				resolve({ label, pidMs, firstLineMs, ok });
			}
		});
		child.stderr.on("data", (chunk) => {
			stderrBuf += chunk.toString("utf8");
			if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-2000);
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			fail(err.message);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (firstLineMs < 0) fail(`exit ${code} before response; stderr: ${stderrBuf.trim().slice(0, 500)}`);
		});
	});
}

/** pi --version 计时：node 引导 + pi 模块图加载的下限。 */
function probeVersion() {
	return new Promise((resolve) => {
		const t0 = process.hrtime.bigint();
		const child = spawn(PI_CMD, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: process.platform === "win32" });
		child.on("error", () => resolve(-1));
		child.on("exit", () => resolve(hrtimeMsSince(t0)));
		child.stdout.on("data", () => {
			/* drain */
		});
	});
}

// 只传真正导出 factory 的入口扩展；gui-bridge 的支撑模块（types/serialize/...）由入口内部 import，
// 误传给 -e 会因「没有默认导出」直接让 pi 启动失败（已踩过）。
const extFiles = readdirSync(EXT_DIR)
	.filter((f) => f.endsWith(".ts") && readFileSync(path.join(EXT_DIR, f), "utf8").includes("export default"))
	.map((f) => path.join(EXT_DIR, f));
const baseArgs = ["--mode", "rpc", "--no-themes", "--offline"];
const coreArgs = [...baseArgs, "--no-extensions", "--no-skills"];
const fullArgs = [...baseArgs, ...extFiles.flatMap((f) => ["-e", f])];

const mode = process.argv[3] || "summary";
console.log(`pi extensions under probe: ${extFiles.length}, iterations: ${ITER}, mode: ${mode}`);
if (mode === "each") {
	// 逐个扩展测增量：core+单个 -e，定位大头扩展。
	for (const ext of extFiles) {
		const name = path.basename(ext);
		const one = await probeRpc([...baseArgs, "-e", ext], name);
		console.log(`${name}: ${one.error ? `ERROR(${one.error.slice(0, 200)})` : `ready+${one.firstLineMs}ms`}`);
	}
} else {
	for (let i = 0; i < ITER; i++) {
		const versionMs = await probeVersion();
		const core = await probeRpc(coreArgs, "core ");
		const full = await probeRpc(fullArgs, "full ");
		const fmt = (r) => (r.error ? `ERROR(${r.error})` : `pid+${r.pidMs}ms ready+${r.firstLineMs}ms`);
		console.log(`#${i + 1} --version=${versionMs}ms | core: ${fmt(core)} | full: ${fmt(full)} | extDelta=${core.error || full.error ? "?" : full.firstLineMs - core.firstLineMs}ms`);
	}
}
