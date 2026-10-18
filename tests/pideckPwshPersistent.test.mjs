import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parsePwshCommandOutput, pwshPromptCompleted, stripPwshControl, wrapPwshCommand } = loadTsCommonJs("packages/dsh-tool-pwsh-persistent/src/protocol.ts");
const { candidatePwshPaths, formatPwshStartupError, resolvePwshPath } = loadTsCommonJs("packages/dsh-tool-pwsh-persistent/src/pwshResolver.ts", {
	stubs: {
		"@deepseek-ai/dsh-pwsh-local": {
			resolvePwshPath: (configured, env, platform) => {
				// 官方 resolver 的纯逻辑代理：configured 优先；win32 委托候选扫描。
				if (configured !== undefined && configured.length > 0) return configured;
				if (platform === "win32") return "win32-resolved";
				return "pwsh";
			},
			candidatePwshPaths: (env) => {
				// 与官方同序的纯函数：标准 PS7 → PATH 每个绝对 pwsh.exe → PS5.1
				const programs = env.ProgramFiles ?? "C:\\Program Files";
				const system = env.SystemRoot ?? "C:\\Windows";
				const candidates = [`${programs}\\PowerShell\\7\\pwsh.exe`];
				for (const entry of (env.PATH ?? "").split(";")) {
					const trimmed = entry.trim().replace(/^"|"$/g, "");
					if (trimmed.length > 0) candidates.push(`${trimmed}\\pwsh.exe`);
				}
				candidates.push(`${system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
				return candidates;
			},
		},
	},
});

test("resolvePwshPath：显式配置优先且委托官方 resolver 不读磁盘", () => {
	const configuredPath = "D:\\portable\\pwsh.exe";
	assert.equal(resolvePwshPath({ configuredPath, platform: "win32" }), configuredPath);
});

test("resolvePwshPath：win32 委托官方 resolver", () => {
	assert.equal(resolvePwshPath({ platform: "win32" }), "win32-resolved");
});

test("resolvePwshPath：非 Windows 平台委托官方返回 pwsh", () => {
	assert.equal(resolvePwshPath({ platform: "linux" }), "pwsh");
});

test("candidatePwshPaths：按 PS7、PATH 和 Windows PowerShell 5.1 的顺序构造绝对候选", () => {
	assert.deepEqual(
		[
			...candidatePwshPaths({
				ProgramFiles: "C:\\Program Files",
				PATH: ' C:\\tools ;"C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps";;',
				SystemRoot: "C:\\Windows",
			}),
		],
		["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\tools\\pwsh.exe", "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
	);
});

test("resolvePwshPath：显式配置空串时回退官方解析", () => {
	assert.equal(resolvePwshPath({ configuredPath: "  ", platform: "win32" }), "win32-resolved");
});

test("formatPwshStartupError：启动失败包含实际路径和 winget 修复命令", () => {
	const error = formatPwshStartupError(new Error("spawn pwsh ENOENT"), "pwsh");
	assert.match(error.message, /pwshPath: pwsh/);
	assert.match(error.message, /spawn pwsh ENOENT/);
	assert.match(error.message, /winget install --id Microsoft\.PowerShell --source winget/);
});

test("wrapPwshCommand：start/end marker + Invoke-Expression 包裹 + 双引号转义", () => {
	const marker = { start: "__DSH_PWSH_START_x__", end: "__DSH_PWSH_END_x:" };
	const wrapped = wrapPwshCommand("Write-Output 'hello'", marker);
	assert.match(wrapped, new RegExp(`Write-Output '${marker.start}'`));
	assert.match(wrapped, /Invoke-Expression -Command "Write-Output 'hello'"/);
	// end marker 与退出码用独立语句输出（conpty 折行鲁棒：拆开也能解析）
	assert.match(wrapped, new RegExp(`Write-Output '${marker.end}'`));
	assert.match(wrapped, /Write-Output \$global:LASTEXITCODE$/);
	// 退出码归一：$LASTEXITCODE 空时按 $? 归一
	assert.match(wrapped, /if \(\$null -eq \$global:LASTEXITCODE\) \{ \$global:LASTEXITCODE = if \(\$\?\) \{ 0 \} else \{ 1 \} \}/);
});

test("wrapPwshCommand：双引号字符串转义（$ 不展开、双引号/反引号保留字面）", () => {
	const marker = { start: "S", end: "E:" };
	const wrapped = wrapPwshCommand('git log --format="%h" $HOME it\'s', marker);
	// 单引号在双引号字符串内是字面量、无需转义；$ 与 " 必须反引号转义
	assert.match(wrapped, /Invoke-Expression -Command "git log --format=`"%h`" `\$HOME it's"/);
});

test("wrapPwshCommand：多行命令压成单行物理输入（换行转义为 `n）", () => {
	// 回归：ConPTY 行输入会吞掉字面 LF（实测 `$a = 1\n$b = 2` 被压成 `1$b` 报错），
	// wrapper 必须不含任何字面换行，多行脚本经 `n 转义后交由 Invoke-Expression 还原。
	const marker = { start: "S", end: "E:" };
	const wrapped = wrapPwshCommand("$a = 1\n$b = 2\n$a + $b", marker);
	assert.ok(!wrapped.includes("\n"), "wrapper 不得包含字面换行");
	assert.ok(!wrapped.includes("\r"), "wrapper 不得包含字面回车");
	assert.match(wrapped, /`\$a = 1`n`\$b = 2`n`\$a \+ `\$b/);
	assert.ok(wrapped.includes("`$a = 1`n`$b = 2`n`$a + `$b"), "换行已转义为 `n、$ 已转义为 `$");
});

test("wrapPwshCommand：CR 删除、ESC 转义为 `e（控制字符不落进 ConPTY 输入）", () => {
	const marker = { start: "S", end: "E:" };
	const wrapped = wrapPwshCommand('Write-Output "a\rb\x1b[c"', marker);
	assert.ok(!wrapped.includes("\r"));
	assert.ok(wrapped.includes('Write-Output `"ab`e[c`"'), "双引号/ESC 均反引号转义且 CR 被删除");
});

test("parsePwshCommandOutput：提取 start~end 区间文本与退出码", () => {
	const marker = { start: "__S__", end: "__E__:" };
	const buffer = `\r\n__S__\r\nhello\r\nworld\r\n__E__:0\r\n`;
	const parsed = parsePwshCommandOutput(buffer, marker);
	assert.ok(parsed);
	assert.equal(parsed.exitCode, 0);
	assert.equal(parsed.text, "hello\nworld");
});

test("parsePwshCommandOutput：非零退出码与未完成命令", () => {
	const marker = { start: "__S__", end: "__E__:" };
	const parsed = parsePwshCommandOutput(`__S__\r\nboom\r\n__E__:7\r\n`, marker);
	assert.equal(parsed?.exitCode, 7);
	// 命令未结束（无 end marker）→ undefined
	assert.equal(parsePwshCommandOutput(`__S__\r\nrunning...`, marker), undefined);
	// 回显里的 end marker（后无数字）不算完成
	assert.equal(parsePwshCommandOutput(`echo __E__: echo __S__\r\n__S__\r\nok\r\n__E__:0\r\n`, marker)?.exitCode, 0, "取最后一个 end marker（真实输出），回显里的被跳过");
	// 退出码独立行（end marker 后换行再数字）：conpty 折行/独立语句输出形态
	const wrapped = parsePwshCommandOutput(`__S__\r\nout\r\n__E__:\r\n0\r\n`, marker);
	assert.equal(wrapped?.exitCode, 0);
	assert.equal(wrapped?.text, "out");
});

test("parsePwshCommandOutput：命令回显行（含 start 文本）被 lastIndexOf 跳过", () => {
	// PTY 交互回显 = 输入的 wrapped 命令原文（含 start marker），执行输出里 start marker 在后
	const marker = { start: "__S__", end: "__E__:" };
	const buffer = `\x1b[93m__S__\x1b[37m（回显的完整命令）\r\n__S__\r\nreal output\r\n__E__:0\r\n`;
	const parsed = parsePwshCommandOutput(buffer, marker);
	assert.equal(parsed?.text, "real output", "取最后一个 start marker 之后的内容，回显被排除");
});

test("parsePwshCommandOutput：退出码直接拼接提示符时完成，不等待五分钟超时", () => {
	const marker = { start: "__S__", end: "__E__:" };
	const parsed = parsePwshCommandOutput(`__S__\r\nhello\r\n__E__:\r\n0__DSH_PERSISTENT_PWSH_PROMPT__`, marker);
	assert.equal(parsed?.text, "hello");
	assert.equal(parsed?.exitCode, 0);
});

test("parsePwshCommandOutput：ConPTY 的控制序列插入 marker 和退出码也能解析", () => {
	const marker = { start: "__S__", end: "__E__:" };
	const parsed = parsePwshCommandOutput(`__S__\r\n\x1b[32mhello\x1b[m\r\n__E\x1b[?25l__:\r\n\x1b[7m7\x1b[m__DSH_PERSISTENT_PWSH_PROMPT__\x1b[1C`, marker);
	assert.equal(parsed?.text, "hello");
	assert.equal(parsed?.exitCode, 7);
});

test("parsePwshCommandOutput：分块到达的退出码必须有完整终止符，不能提前报告成功", () => {
	const marker = { start: "__S__", end: "__E__:" };
	const prefix = `__S__\r\nhello\r\n__E__:\r\n`;
	for (const tail of ["", "1", "12", "12\r", "12__DSH_PERSISTENT_PWSH_"]) {
		assert.equal(parsePwshCommandOutput(prefix + tail, marker), undefined);
	}
	assert.equal(parsePwshCommandOutput(`${prefix}12__DSH_PERSISTENT_PWSH_PROMPT__`, marker)?.exitCode, 12);
	assert.equal(parsePwshCommandOutput(`${prefix}12\r\n`, marker)?.exitCode, 12);
});

test("parsePwshCommandOutput：只有命令回显或未完成 ANSI 序列时不算结束", () => {
	const marker = { start: "__S__", end: "__E__:" };
	assert.equal(parsePwshCommandOutput(wrapPwshCommand("Write-Output hi", marker), marker), undefined);
	assert.equal(parsePwshCommandOutput(`__S__\r\nhello\r\n__E__:\r\n0\x1b[`, marker), undefined);
});

test("stripPwshControl：剥离 CSI/OSC/模式切换序列（pwsh PTY 提示符输出）", () => {
	const raw = "\x1b[?9001h\x1b[?25l\x1b[2J\x1b[m\x1b[H__DSH_PERSISTENT_PWSH_PROMPT__\x1b[1C\x1b]0;title\x07\x1b[?25h";
	const clean = stripPwshControl(raw);
	assert.equal(clean, "__DSH_PERSISTENT_PWSH_PROMPT__");
});

test("pwshPromptCompleted：提示符完成判定（去控制序列后以提示符结尾）", () => {
	const promptTail = "__DSH_PERSISTENT_PWSH_PROMPT__\x1b[1C\x1b]0;x\x07";
	assert.equal(pwshPromptCompleted(`hello\r\n${promptTail}`), true);
	assert.equal(pwshPromptCompleted("hello\r\nPS C:\\work> "), false, "默认提示符不算完成");
	assert.equal(pwshPromptCompleted(""), false);
});
