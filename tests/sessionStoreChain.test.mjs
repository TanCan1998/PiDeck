/**
 * 会话数据面（Wave 1：Go session-store sidecar 骨架）的链路契约测试。
 *
 * Wave 1 没有 IPC、没有消费者，价值全在「骨架正确 + 接线登记齐全」：
 * - Go 侧协议常量/命令集/忽略目录/行上限与 TS 宿主一一对应（两边手写镜像，靠这些断言钉住）；
 * - 宿主服务的 spawn 形态（argv 只带 statePath，roots 逐请求）与生命周期入口存在；
 * - 装配（二进制定位 + quitCleanup 登记）与构建/CI/打包登记齐全——漏一处就是「装了但拉不起来」。
 * 正则全部空白容忍（biome 重排格式不破坏断言）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");

test("Go 侧协议与快照口径：命令集、版本、忽略目录、行上限", () => {
	const mainSource = read("../native/session-store/main.go");
	assert.match(mainSource, /protocolVersion\s*=\s*1/);
	assert.match(mainSource, /case\s*"list-files",\s*"refresh":/);
	assert.match(mainSource, /logPrefix\s*=\s*"\[session-store\]\s?"/);

	const storeSource = read("../native/session-store/store.go");
	assert.match(storeSource, /snapshotFormatVersion\s*=\s*1/);
	// 与 TS 侧扫描口径一致：成品归档与子代理产物不是可读会话
	assert.match(storeSource, /"\.pideck-archive":\s*true/);
	assert.match(storeSource, /"subagent-artifacts":\s*true/);
	// 原子落盘：先写 .tmp 再改名
	assert.match(storeSource, /tmpPath\s*:=\s*s\.statePath\s*\+\s*"\.tmp"/);

	const scanSource = read("../native/session-store/scan.go");
	// 与 jsonlLineStream.ts 的 MAX_JSONL_LINE_BYTES 同口径
	assert.match(scanSource, /maxScanLineBytes\s*=\s*64\s*\*\s*1024\s*\*\s*1024/);
	// 行边界提交：残行不推进已提交字节数
	assert.match(scanSource, /CommittedSize\s*\+=/);
});

test("宿主服务：argv 只带 statePath，roots 逐请求，生命周期入口齐全", () => {
	const source = read("../src/main/sessions/SessionStoreService.ts");
	assert.match(source, /SESSION_STORE_PROTOCOL_VERSION\s*=\s*1/);
	// 与两个兄弟服务的差异点：roots 不进 spawn 参数，换根不重启进程
	assert.match(source, /spawnFn\(binaryPath,\s*\[this\.statePath\]/);
	assert.match(source, /cmd:\s*"list-files",\s*roots:/);
	assert.match(source, /cmd:\s*"refresh",\s*roots:/);
	assert.match(source, /isReady\(\):\s*boolean/);
	assert.match(source, /warmup\(\):\s*void/);
	assert.match(source, /dispose\(\):\s*void/);
	// fail-open：二进制缺失走 binary-missing（调用方降级到 TS 解析）
	assert.match(source, /reason:\s*"binary-missing"/);
});

test("装配：二进制定位（dev 走 resources/session-store/bin）+ statePath 落 userData + quitCleanup", () => {
	const source = read("../src/main/index.ts");
	assert.match(source, /import\s*\{\s*SessionStoreService\s*\}\s*from\s*"\.\/sessions\/SessionStoreService"/);
	assert.match(source, /new SessionStoreService\(\{/);
	assert.match(source, /statePath:\s*join\(app\.getPath\("userData"\),\s*"session-store",\s*"state\.bin"\)/);
	assert.match(source, /join\(app\.getAppPath\(\),\s*"resources",\s*"session-store",\s*"bin"\)/);
	assert.match(source, /join\(process\.resourcesPath,\s*"session-store"\)/);
	assert.match(source, /quitCleanup\.register\("session-store"/);
});

test("构建与打包登记：build 脚本 fail-open、npm script 进 build 链、产物目录被忽略", () => {
	assert.equal(existsSync(new URL("../native/session-store/go.mod", import.meta.url)), true);
	assert.equal(existsSync(new URL("../resources/session-store/bin/.gitkeep", import.meta.url)), true);

	const script = read("../scripts/build-session-store.mjs");
	assert.match(script, /native",\s*"session-store"/);
	assert.match(script, /resources",\s*"session-store",\s*"bin"/);
	// fail-open：Go 工具链缺失/构建失败只告警，不让 CI 红灯
	assert.match(script, /probe\.error\s*\|\|\s*probe\.status\s*!==\s*0/);
	assert.match(script, /process\.exitCode\s*=\s*0/);
	assert.match(script, /SESSION_STORE_OS/);
	// Wave 1 刻意不进 extraResources（无消费者），注释里写明接线时才补
	assert.match(script, /Wave 1 暂不进 extraResources/);

	const pkg = JSON.parse(read("../package.json"));
	assert.equal(typeof pkg.scripts["build:session-store"], "string");
	assert.match(pkg.scripts.build, /npm run build:session-store/);
	assert.match(read("../.gitignore"), /resources\/session-store\/bin\/\*/);
	assert.match(read("../.gitignore"), /!resources\/session-store\/bin\/\.gitkeep/);
	assert.match(read("../scripts/dev.js"), /npm run build:session-store/);
});

test("CI：三平台都跑 session-store 的 Go 单测并注入交叉编译目标", () => {
	for (const workflow of ["build-linux.yml", "build-windows.yml", "build-macos.yml"]) {
		const source = read(`../.github/workflows/${workflow}`);
		assert.match(source, /go -C native\/session-store test \.\/\.\.\./, `${workflow} 缺 session-store 单测`);
		assert.match(source, /SESSION_STORE_OS:\s*\w+/, `${workflow} 缺 SESSION_STORE_OS`);
		assert.match(source, /SESSION_STORE_ARCH:\s*\$\{\{\s*matrix\.arch\s*\}\}/, `${workflow} 缺 SESSION_STORE_ARCH`);
	}
});
