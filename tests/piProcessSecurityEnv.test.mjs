import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 沙箱加载 PiProcess：mock spawn 以捕获传入子进程的环境变量，mock locator 让 resolveCommand
 * 返回 "wsl://" 触发 WSL 分支，其余依赖（fs/extensions/logging）给最小桩，避免触碰真实文件系统。
 */
function loadPiProcess(versionResult = { output: "0.82.1\n" }, options = { parkedExtensions: [] }) {
	/** piExtensionFilter 收到的目录，用于验证 denied trust 不触碰项目资源。 */
	const parkedDirectories = [];
	/** spawn 收到的 env/args/windowsHide；mockSpawn 被调用时写入 */
	let captured = null;
	let unparkCalls = 0;
	const mockSpawn = (_command, args, opts) => {
		captured = { env: opts?.env ?? null, args: args ?? null, windowsHide: opts?.windowsHide };
		// 返回一个最小 ChildProcess 形状：PiProcess 后续会 new PiRpcClient(proc.stdin/stdout)
		// 并注册 stderr/error/exit 监听，全部用 stream + noop 满足。
		return {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			on() {},
			kill() {},
			pid: 12345,
		};
	};
	class MockRpcClient {
		on() {
			return this;
		}
		close() {}
		request() {
			return Promise.resolve({ success: true, data: {} });
		}
	}
	// locator 决定 command 是否进入 WSL 分支；createProcessEnv 给空 env 让注入逻辑可观测
	const mockLocator = {
		resolveCommand: () => "wsl://pi",
		createInvocation: (command, args) => ({
			command,
			args,
			shell: false,
			pathPrefix: "",
			wsl: true,
			windowsVerbatimArguments: false,
		}),
		createProcessEnv: () => ({}),
		// 模拟 Windows 上 .cmd 垫片被还原成 node 直启后的通道预算
		// （对应 PiLocator.CREATE_PROCESS_ARG_CHAR_BUDGET）。各通道真实取值由
		// piLocator.test.mjs 覆盖，这里只用于驱动 PiProcess 的「超预算时跳过注入」分支。
		resolveArgCharBudget: () => 26000,
	};
	const load = createTsSandbox({
		stubs: {
			"node:child_process": {
				spawn: mockSpawn,
				// ensureVersionCheck 异步探针：返回 0.82.1（≥ 白名单版本门槛 0.60），
				// 避免低版本触发白名单降级分支影响注入断言
				execFile: (_cmd, _args, _opts, cb) => {
					if (typeof cb !== "function") return;
					queueMicrotask(() => {
						if (versionResult.error) cb(versionResult.error, "");
						else cb(null, versionResult.output);
					});
				},
			},
			// 模拟 Windows 用户 home：停放扩展目录的断言（C:\\Users\\tester\.pi\agent\extensions）建在它上面。
			"node:os": { homedir: () => "C:\\Users\\tester" },
			// 本文件整个都在 Windows 语义下跑（路径拼接/盘符），所以 node:path 给 win32 实现。
			"node:path": path.win32,
			"./PiRpcClient": { PiRpcClient: MockRpcClient },
			"./PiLocator": { PiLocator: class {} },
			// 扩展停放/还原的行为替身：记录停放目录，并按用例返回预设的停放项。
			"./piExtensionFilter": {
				parkBlockedExtensionsInDir: (directory) => {
					parkedDirectories.push(directory);
					return options.parkedExtensions;
				},
				unparkBlockedExtensions: () => {
					unparkCalls += 1;
				},
			},
			"../extensions/builtInExtensions": { appendBuiltInExtensionArgs: (args) => args },
			// 日志共享实例未注册时 getAppLogger 返回 undefined，PiProcess 埋点静默跳过。
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../sessions/sessionProxyPolicy": { applyPiProxyMode: (env) => env },
		},
		// 本文件整篇都是 Windows 场景（cmd.exe 隐藏控制台开关、盘符/UNC 转换）。
		globals: {
			console: { log() {}, warn() {}, error() {} },
			process: { ...process, platform: "win32" },
		},
	});
	// 未打桩的相对 import（LocalPiRuntimeLauncher、PiSpawnHandle、PiRpcClient 的同层依赖、
	// piSpawnFailure、WslPaths、extensionVersionGate、gitProcess…）由加载器按**源文件目录**解析。
	return {
		PiProcess: load("src/main/pi/PiProcess.ts").PiProcess,
		mockLocator,
		getCaptured: () => captured,
		getParkedDirectories: () => parkedDirectories,
		getUnparkCalls: () => unparkCalls,
	};
}

test("Windows 下启动 pi 进程时隐藏 cmd.exe 控制台窗口", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator);

	await proc.start(undefined, undefined, true);

	assert.equal(getCaptured()?.windowsHide, true);
});

test("WSL 模式下 PIDECK_SESSION_ID（UUID 身份 key）原样注入，不经 Linux 路径转换", async () => {
	// 回归：临时会话 deckSessionId 是新生成的 UUID（无 sessionPath 兜底），
	// 旧代码把它当 Windows 路径喂给 toWslLinuxPath——UUID 既非 UNC/盘符/绝对 Linux 路径，
	// WslPaths 必抛 INVALID_WSL_PATH，导致 WSL 下临时会话起不来（spawn 之前就崩）。
	// 但 PIDECK_SESSION_ID 对扩展只是 sessionLevels 字典查表 key（不 fs 打开），
	// 任何模式都应原样注入；只有 securitySnapshotPath（真实 Windows 路径，扩展要 fs 读）才需要转换。
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const uuid = "550e8400-e29b-41d4-a716-446655440000";
	const snapshotPath = "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json";

	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", piRpcNoExtensions: true, piRpcOffline: true }, mockLocator, { securitySnapshotPath: snapshotPath, securitySessionId: uuid });

	// noSession=true：临时会话不传 sessionPath，securitySessionId 仅剩 UUID（最易触发 bug 的路径）
	await proc.start(undefined, undefined, true);

	const captured = getCaptured();
	assert.ok(captured?.env, "spawn 应被调用并捕获到 env");
	// 身份 key 原样透传：扩展按它命中 sessionLevels 覆盖
	assert.equal(captured.env.PIDECK_SESSION_ID, uuid);
	// snapshotPath 是真实 Windows 路径（扩展需 fs 打开），WSL 下仍要转成 /mnt/c/...
	assert.equal(captured.env.PIDECK_SECURITY_CONFIG, "/mnt/c/Users/tester/AppData/Roaming/PiDeck-dev/security-policy.json");
});

test("默认（未开启总开关）且存在禁用项时注入 --no-extensions + -e 白名单", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		resolveEnabledExtensionPaths: () => ["C:\\ext\\a.ts", "C:\\ext\\b.ts"],
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	const idx = captured.args.indexOf("--no-extensions");
	assert.ok(idx >= 0, "白名单模式应注入 --no-extensions");
	assert.equal(captured.args[idx + 1], "--extension");
	// WSL 模式：-e 后的扩展路径被转换为 distro 内 Linux 路径（最终交给 pi 在 distro 内加载）
	assert.equal(captured.args[idx + 2], "/mnt/c/ext/a.ts");
	assert.equal(captured.args[idx + 3], "--extension");
	assert.equal(captured.args[idx + 4], "/mnt/c/ext/b.ts");
});

test("自动标题设置以显式环境标志注入 pi 进程", async () => {
	const disabled = loadPiProcess();
	const disabledProc = new disabled.PiProcess("C:\\proj", { autoSessionTitle: false, wslEnabled: true, wslDistro: "Ubuntu", wslUser: "root" }, disabled.mockLocator);
	await disabledProc.start(undefined, undefined, true);
	assert.equal(disabled.getCaptured()?.env?.PIDECK_AUTO_SESSION_TITLE, "0");

	const enabled = loadPiProcess();
	const enabledProc = new enabled.PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "root" }, enabled.mockLocator);
	await enabledProc.start(undefined, undefined, true);
	assert.equal(enabled.getCaptured()?.env?.PIDECK_AUTO_SESSION_TITLE, "1");
});

test("白名单总开关 disableExtensionWhitelist=true 时不再注入 --no-extensions/-e", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	// resolver 返回白名单路径（模拟存在禁用项），但总开关开启时应整体忽略白名单
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", disableExtensionWhitelist: true }, mockLocator, {
		resolveEnabledExtensionPaths: () => ["C:\\ext\\a.ts"],
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-extensions"), "总开关开启时不应注入 --no-extensions");
	assert.ok(!captured.args.includes("--extension"), "总开关开启时不应注入 --extension");
});

test("存在禁用技能时注入 --no-skills + 逐条 --skill 白名单", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		// 模拟技能白名单解析器：存在禁用项 → 返回启用技能路径
		resolveEnabledSkillPaths: () => ["C:\\Users\\tester\\skills\\a\\SKILL.md", "C:\\Users\\tester\\skills\\b\\SKILL.md"],
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	const idx = captured.args.indexOf("--no-skills");
	assert.ok(idx >= 0, "技能白名单模式应注入 --no-skills");
	assert.equal(captured.args[idx + 1], "--skill");
	// WSL 模式：--skill 后的路径同样被转换为 distro 内 Linux 路径
	assert.equal(captured.args[idx + 2], "/mnt/c/Users/tester/skills/a/SKILL.md");
	assert.equal(captured.args[idx + 3], "--skill");
	assert.equal(captured.args[idx + 4], "/mnt/c/Users/tester/skills/b/SKILL.md");
	// 预算内的少量注入不记录跳过信息（UI 不该打扰用户）
	assert.equal(proc.getDiagnostics()?.whitelistSkipped, undefined);
});

test("技能数量超出启动通道的命令行预算时整体跳过白名单注入，并在诊断中记录", async () => {
	// 回归：白名单逐条 --skill 注入，命令行长度 O(技能数)。Windows 上即便走了 node 直启
	// （CreateProcess 32767），千级技能仍会撑爆；超预算必须整体放弃注入（pi 走默认发现，
	// 禁用不生效但能启动）。500 个 Windows 绝对路径 ≈ 29.5k 字符 > 26000 预算。
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const manySkills = Array.from({ length: 500 }, (_, i) => `C:\\Users\\tester\\.pi\\agent\\skills\\skill-${String(i).padStart(3, "0")}\\SKILL.md`);
	assert.ok(manySkills[0].length > 40, "构造的技能路径应接近真实 Windows 长度");

	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		resolveEnabledSkillPaths: () => manySkills,
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-skills"), "超预算时不应注入 --no-skills");
	assert.ok(!captured.args.includes("--skill"), "超预算时不应注入 --skill");

	const skipped = proc.getDiagnostics()?.whitelistSkipped?.find((entry) => entry.kind === "skills");
	assert.ok(skipped, "应记录 whitelistSkipped(skills) 供启动诊断提示用户");
	assert.equal(skipped.count, 500);
	assert.equal(skipped.budget, 26000, "诊断应带上本次通道的实际预算");
	assert.ok(skipped.chars > skipped.budget, "估算字符数应超过预算");
});

test("数百个技能在 node 直启通道下不再被误拦（旧的一刀切 5000 预算会跳过）", async () => {
	// 用户场景：300 个技能全是启用状态，但残留的禁用项让白名单开启；旧实现用最坏通道
	// （cmd.exe 8191 → 预算 5000）一刀切，≈17.7k 字符直接越过 5000 被误判为「超预算」。
	// 按实际通道（node 直启 26000）判定后应照常注入，禁用功能继续生效。
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const manySkills = Array.from({ length: 300 }, (_, i) => `C:\\Users\\tester\\.pi\\agent\\skills\\skill-${String(i).padStart(3, "0")}\\SKILL.md`);

	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		resolveEnabledSkillPaths: () => manySkills,
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(captured.args.includes("--no-skills"), "预算内应照常注入 --no-skills");
	assert.equal(captured.args.filter((a) => a === "--skill").length, 300, "300 个技能应逐条注入（禁用功能保持生效）");
	assert.equal(proc.getDiagnostics()?.whitelistSkipped, undefined, "预算内不得记录跳过信息（否则会误报给用户）");
});

test("扩展数量超出命令行预算时同样整体跳过白名单注入", async () => {
	// 回归：预算守卫最初只覆盖技能，扩展/提示词漏在外面——逐条 --extension 的注入量与
	// 技能同阶（命令行长度 O(条数)），漏守卫就会撑爆 Windows 命令行导致启动失败。
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const manyExtensions = Array.from({ length: 600 }, (_, i) => `C:\\Users\\tester\\.pi\\agent\\extensions\\extension-${String(i).padStart(3, "0")}.ts`);

	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		resolveEnabledExtensionPaths: () => manyExtensions,
		resolveBuiltInExtensionPaths: () => ["C:\\app\\resources\\extensions\\pi-deck-todo.ts"],
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-extensions"), "超预算时不应注入 --no-extensions");
	assert.ok(!captured.args.includes("--extension"), "超预算时不应注入 --extension");

	const skipped = proc.getDiagnostics()?.whitelistSkipped?.find((entry) => entry.kind === "extensions");
	assert.ok(skipped, "应记录 extensions 的跳过信息（不清空禁用，但必须可追溯）");
	assert.equal(skipped.count, 600);
	assert.equal(skipped.budget, 26000);
	assert.ok(skipped.chars > skipped.budget);
});

test("提示词模板数量超出命令行预算时同样整体跳过白名单注入，且与技能跳过分开记录", async () => {
	// 三类白名单共用同一条命令行预算，可同时被跳过；诊断必须逐类记录，
	// 否则用户只能看到「技能被跳过」而不知提示词也没生效。
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const manyPrompts = Array.from({ length: 400 }, (_, i) => `C:\\Users\\tester\\.pi\\agent\\prompts\\prompt-${String(i).padStart(3, "0")}.md`);
	const manySkills = Array.from({ length: 900 }, (_, i) => `C:\\Users\\tester\\.pi\\agent\\skills\\skill-${String(i).padStart(3, "0")}\\SKILL.md`);

	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		resolveEnabledSkillPaths: () => manySkills,
		resolveEnabledPromptPaths: () => manyPrompts,
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-prompt-templates"), "超预算时不应注入 --no-prompt-templates");
	assert.ok(!captured.args.includes("--prompt-template"), "超预算时不应注入 --prompt-template");

	// 用本 realm 的 Array.from 重建：whitelistSkipped 是 vm 沙箱数组，跨 realm 直接
	// deepEqual 会因原型不同而失败（内容一样也报错）。
	const kinds = Array.from(proc.getDiagnostics()?.whitelistSkipped ?? [], (entry) => entry.kind).sort();
	assert.deepEqual(kinds, ["prompts", "skills"], "两类超预算应各记一条，不互相遮蔽");
});

test("WSL 家目录的 --skill 白名单路径（UNC）转换为 distro 内 Linux 路径", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		// 模拟 WSL 场景：解析器经 \\wsl.localhost 扫到 Linux 家目录技能（issue #203）
		resolveEnabledSkillPaths: () => ["\\\\wsl.localhost\\Ubuntu-24.04\\root\\.agents\\skills\\wsl-skill\\SKILL.md", "\\\\wsl.localhost\\Ubuntu-24.04\\root\\.pi\\agent\\skills\\wsl-pi-skill\\SKILL.md"],
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	const idx = captured.args.indexOf("--no-skills");
	assert.ok(idx >= 0, "技能白名单模式应注入 --no-skills");
	assert.equal(captured.args[idx + 1], "--skill");
	// UNC（\\wsl.localhost\<distro>\...）必须转成 distro 内原生 Linux 路径，
	// 否则 WSL 里的 pi 打不开 Windows UNC 形式的技能文件
	assert.equal(captured.args[idx + 2], "/root/.agents/skills/wsl-skill/SKILL.md");
	assert.equal(captured.args[idx + 3], "--skill");
	assert.equal(captured.args[idx + 4], "/root/.pi/agent/skills/wsl-pi-skill/SKILL.md");
});

test("无禁用技能（resolver 返回 null）时不注入 --no-skills/--skill", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		resolveEnabledSkillPaths: () => null,
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-skills"), "无禁用项时不应注入 --no-skills");
	assert.ok(!captured.args.includes("--skill"), "无禁用项时不应注入 --skill");
});

test("存在禁用模板时注入 --no-prompt-templates + 逐条 --prompt-template 白名单", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		// 模拟模板白名单解析器：存在禁用项 → 返回启用模板路径
		resolveEnabledPromptPaths: () => ["C:\\Users\\tester\\prompts\\a.md", "C:\\Users\\tester\\prompts\\b.md"],
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	const idx = captured.args.indexOf("--no-prompt-templates");
	assert.ok(idx >= 0, "模板白名单模式应注入 --no-prompt-templates");
	assert.equal(captured.args[idx + 1], "--prompt-template");
	// WSL 模式：--prompt-template 后的路径同样被转换为 distro 内 Linux 路径
	assert.equal(captured.args[idx + 2], "/mnt/c/Users/tester/prompts/a.md");
	assert.equal(captured.args[idx + 3], "--prompt-template");
	assert.equal(captured.args[idx + 4], "/mnt/c/Users/tester/prompts/b.md");
});

test("无禁用模板（resolver 返回 null）时不注入 --no-prompt-templates/--prompt-template", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		resolveEnabledPromptPaths: () => null,
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	assert.ok(!captured.args.includes("--no-prompt-templates"), "无禁用项时不应注入 --no-prompt-templates");
	assert.ok(!captured.args.includes("--prompt-template"), "无禁用项时不应注入 --prompt-template");
});

test("piRpcNoSkills 总开关开启时不注入技能白名单", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess();
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", piRpcNoSkills: true }, mockLocator, {
		resolveEnabledSkillPaths: () => ["C:\\Users\\tester\\skills\\a\\SKILL.md"],
		securitySnapshotPath: "C:\\Users\\tester\\AppData\\Roaming\\PiDeck-dev\\security-policy.json",
	});
	await proc.start(undefined, undefined, true);
	const captured = getCaptured();
	assert.ok(captured?.args, "spawn 应被调用");
	// piRpcNoSkills 分支已注入 --no-skills（总开关）；技能白名单不应再注入 --skill
	assert.ok(captured.args.includes("--no-skills"), "总开关应注入 --no-skills");
	assert.ok(!captured.args.includes("--skill"), "总开关开启时不应注入 --skill");
});

test("resolver failure before spawn restores temporarily parked extensions", async () => {
	const parked = [
		{
			dir: "C:\\Users\\tester\\.pi\\agent\\extensions",
			name: "codeisland.ts",
			originalPath: "C:\\Users\\tester\\.pi\\agent\\extensions\\codeisland.ts",
			parkedPath: "C:\\Users\\tester\\.pi\\agent\\extensions\\codeisland.ts.pideck-disabled",
		},
	];
	const { PiProcess, mockLocator, getCaptured, getUnparkCalls } = loadPiProcess({ output: "0.82.1\n" }, { parkedExtensions: parked });
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator, {
		resolveEnabledExtensionPaths: () => {
			throw new Error("resolver failed");
		},
	});
	await assert.rejects(proc.start(undefined, undefined, true), /resolver failed/);
	assert.equal(getCaptured(), null);
	assert.equal(getUnparkCalls(), 1);
});

test("--no-approve 会通知所有资源 resolver 排除项目层并传给受支持的 pi", async () => {
	const { PiProcess, mockLocator, getCaptured, getParkedDirectories } = loadPiProcess();
	const observed = [];
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root", disableExtensionWhitelist: true }, mockLocator, {
		resolveBuiltInExtensionPaths: (_settings, includeProjectResources) => {
			observed.push(["built-in", includeProjectResources]);
			return [];
		},
		resolveEnabledExtensionPaths: (_settings, _cwd, includeProjectResources) => {
			observed.push(["extension", includeProjectResources]);
			return [];
		},
		resolveEnabledSkillPaths: (_settings, _cwd, includeProjectResources) => {
			observed.push(["skill", includeProjectResources]);
			return [];
		},
		resolveEnabledPromptPaths: (_settings, _cwd, includeProjectResources) => {
			observed.push(["prompt", includeProjectResources]);
			return [];
		},
	});
	await proc.start(undefined, "no-approve", true);
	assert.ok(getCaptured()?.args?.includes("--no-approve"));
	assert.ok(getCaptured()?.args?.includes("--no-extensions"), "denied trust overrides the whitelist diagnostic switch");
	assert.deepEqual(getParkedDirectories(), ["C:\\Users\\tester\\.pi\\agent\\extensions"]);
	assert.deepEqual(observed, [
		["extension", false],
		["built-in", false],
		["skill", false],
		["prompt", false],
	]);
});

test("拒绝 trust 时版本探测失败会阻止 spawn", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess({ error: new Error("missing pi") });
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator);
	await assert.rejects(proc.start(undefined, "no-approve", true), /Cannot start an untrusted project safely/);
	assert.equal(getCaptured(), null, "版本不可验证时绝不能启动可能加载项目代码的进程");
});

test("拒绝 trust 时旧版 pi 会阻止 spawn", async () => {
	const { PiProcess, mockLocator, getCaptured } = loadPiProcess({ output: "0.78.0\n" });
	const proc = new PiProcess("C:\\proj", { wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }, mockLocator);
	await assert.rejects(proc.start(undefined, "no-approve", true), /Cannot start an untrusted project safely/);
	assert.equal(getCaptured(), null);
});
