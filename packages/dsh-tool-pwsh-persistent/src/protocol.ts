/**
 * 持久 pwsh 的 marker 协议（纯函数，无 node-pty / import.meta）。
 *
 * 单测走 CJS transpile，不能加载带 import.meta.url 的入口。
 */

const SHELL_PROMPT = "__DSH_PERSISTENT_PWSH_PROMPT__";

/** CSI / OSC / 其他 ANSI 控制序列剥离（pwsh 在 PTY 下输出光标移动、标题、模式切换等）。 */
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;

export function stripPwshControl(text: string): string {
	return text.replace(ANSI_RE, "");
}

/** 提示符是否已完成（viewport 去控制序列后以提示符结尾 = shell 空闲）。 */
export function pwshPromptCompleted(viewport: string): boolean {
	const clean = stripPwshControl(viewport);
	return clean.endsWith(SHELL_PROMPT) || clean.endsWith(`${SHELL_PROMPT}\n`) || clean.endsWith(`${SHELL_PROMPT}\r\n`);
}

/**
 * 双引号字符串转义（PowerShell 双引号字面量内用反引号转义）。
 *
 * 为什么不用单引号字符串 + `''`：命令文本会原样写进 ConPTY 输入，
 * node-pty/ConPTY 的行输入会吞掉 LF（实测多行命令被压成一行，
 * `$a = 1\n$b = 2` 变成 `1$b` 报错），而单引号字符串又不允许字面换行，
 * 双重失效。官方 dsh-tool-pwsh-persistent 同用本方案。
 *
 * 转义顺序必须反引号优先（保证本函数插入的转义不再被二次转义），
 * 然后 `$`（防 wrapper 构建期展开）、`\r`（删除）、`\n`→`n``、
 * ESC→`` `e ``。这样多行命令和原始控制字符都落在**一条物理输入行**上，
 * 交给 Invoke-Expression 执行时再还原为真正的多行脚本。
 */
export function quoteForPwsh(value: string): string {
	return value
		.replaceAll("`", "``")
		.replaceAll('"', '`"')
		.replaceAll("$", "`$")
		.replaceAll("\r", "")
		.replaceAll("\n", "`n")
		.replaceAll("\x1B", "`e");
}

/**
 * 包装命令：start marker → Invoke-Expression 执行 → end marker + 退出码。
 * 退出码语义：原生命令（git 等）取 $LASTEXITCODE；cmdlet 终止错误 catch 置 1；
 * 其余按 $?（上一条命令成败）归一。
 *
 * 命令体经 quoteForPwsh 压成单行物理输入后包进双引号字符串：
 * ConPTY 行输入会吞换行，所有命令必须落在一条输入行上（见 quoteForPwsh 注释）。
 *
 * conpty 折行鲁棒性：end marker 与退出码用两条独立语句输出——即使被拆开，
 * 解析端也能在 end marker 之后取到数字退出码。
 */
export function wrapPwshCommand(command: string, marker: { start: string; end: string }): string {
	const escaped = quoteForPwsh(command);
	return [
		`Write-Output '${marker.start}'`,
		"$global:LASTEXITCODE = $null",
		`try { Invoke-Expression -Command "${escaped}" } catch { Write-Error $_; $global:LASTEXITCODE = 1 }`,
		"if ($null -eq $global:LASTEXITCODE) { $global:LASTEXITCODE = if ($?) { 0 } else { 1 } }",
		`Write-Output '${marker.end}'`,
		"Write-Output $global:LASTEXITCODE",
	].join("; ");
}

/**
 * 从滚动缓冲提取命令结果：end marker 前的最后一个 start marker 起（排除命令回显）。
 * ConPTY 会在 marker 中插入 ANSI 序列，也会把退出码的换行合并成紧随其后的 prompt；
 * 先去控制序列，再以换行或完整 prompt 定界，不能把分块到达的半个数字当成最终退出码。
 */
export function parsePwshCommandOutput(text: string, marker: { start: string; end: string }): { text: string; exitCode: number } | undefined {
	const clean = stripPwshControl(text);
	const end = clean.lastIndexOf(marker.end);
	if (end < 0) return undefined;
	const status = new RegExp(`^\\r?\\n?(\\d+)(?:\\r?\\n|${SHELL_PROMPT})`).exec(clean.slice(end + marker.end.length))?.[1];
	if (status === undefined) return undefined;
	const startMarker = clean.lastIndexOf(marker.start, end);
	const start = startMarker < 0 ? 0 : startMarker + marker.start.length;
	return {
		text: clean.slice(start, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "").replace(/\r\n/g, "\n"),
		exitCode: Number(status),
	};
}

export { SHELL_PROMPT };
