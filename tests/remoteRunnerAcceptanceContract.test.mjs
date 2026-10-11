import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * P4.2 真机运行时验收脚本的**断言守卫**（`scripts/verify-remote-runtime.mjs`）。
 *
 * 背景：`docs/remote-phase4-plan.md` §7 的 P4.2 门禁是「真机上一个会话完成 prompt → 至少一个 assistant
 * 事件 → abort → restart 后历史仍在；runner 回收后 `ps` 无残留 pi 进程组」。这条门禁**只能**在真机上跑，
 * 因此脚本本身就是唯一证据来源——而「唯一证据来源」的典型坏结局是把断言放宽到能过：残留进程组改成只打日志、
 * 会话文件删不掉改成提示、assistant 事件退化成「任一 RPC 事件」。
 *
 * 守卫只做真机能跑之后**不能靠人眼复查**的那部分：断言是否还在、失败码是否真的被抛出、清理是否仍在
 * 「先确认归属、再删除、再断言已删」的顺序上。信任路径（pin / 指纹 / keyscan / 共享模块）由
 * `tests/remoteVerifyScriptsContract.test.mjs` 覆盖，这里不重复。
 *
 * 用例不依赖真实主机、不执行脚本（真机部分由人工在宿主终端跑，见脚本头部的输出契约）。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/verify-remote-runtime.mjs";

function scriptSource() {
	return readFileSync(join(repoRoot, SCRIPT), "utf8");
}

/**
 * 去掉注释后只剩可执行代码。
 *
 * 必须这么做：脚本的注释里**应该**提到 `runner.mjs`、`{type:"prompt"}` 这些字面量（它们就在输出契约里），
 * 而这里要禁的是真的去拼/真的去发。字符串字面量保留——命令模板同样能构成行为。
 * 与 `remoteVerifyScriptsContract.test.mjs` 同款算法（那份同样不导出，测试文件之间不互相 import：import 一个
 * 测试文件会把它注册的用例一起带进来）。
 */
function stripComments(source) {
	let code = "";
	let inBlockComment = false;
	let quote = null;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];
		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote !== null) {
			code += char;
			if (char === "\\") {
				code += next ?? "";
				index += 1;
			} else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			code += char;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlockComment = true;
			index += 1;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") index += 1;
			code += "\n";
			continue;
		}
		code += char;
	}
	return code;
}

/** 只扫可执行代码：注释里的字面量不算行为。 */
function scriptCode() {
	return stripComments(scriptSource());
}

/** 断言某段文本**真的被 throw 出去**（而不只是出现在注释或字符串里）。 */
function assertThrows(code, stableCode, what) {
	assert.match(code, new RegExp(`throw\\s+stableFailure\\(\\s*"${stableCode}"`), `${what} (${stableCode}) must be thrown, not merely logged`);
}

test("the acceptance script still fails closed when the remote process group or its lease survives the stop", () => {
	const code = scriptCode();
	// 判定按**本次 lease 的进程组**：只有 pgid 判定才不会误伤用户自己的 pi（脚本同时要能读出这个 pgid）。
	assert.match(code, /LEASE_OK/, "the lease (which carries the pid/pgid pair) must be read and reported");
	assert.match(code, /groups\s*\.\s*has\(\s*pgid\s*\)/, "the group check must be a membership test on the pgid");
	assert.doesNotMatch(code, /--mode\s+rpc[^\n]*match/i, "leak judgement must not be done by matching pi command lines");
	// 有界轮询 + 有界等待：超时必须抛稳定码，不许「等不到就当干净」。
	assert.match(code, /RECLAIM_TIMEOUT_MS/, "the reclamation wait must carry an explicit budget");
	assert.match(code, /RECLAIM_POLL_MS/, "the reclamation wait must be a bounded poll");
	assert.match(code, /Date\s*\.\s*now\(\)\s*>=\s*deadlineAt/, "the poll must compare against its deadline");
	assertThrows(code, "RUNNER_RECLAIM_UNCONFIRMED", "an unreclaimed group/lease");
	// 停之前必须证明「组里有成员」，否则「无残留」是恒真的空断言。
	assert.match(code, /RUNNER_GROUP_NOT_LIVE/, "the pre-stop positive control on the live group must stay");
	assertThrows(code, "RUNNER_GROUP_NOT_LIVE", "the pre-stop positive control");
	// lease 在 ready 之后必须读得到（它是 ready 的前置条件），读不到即失败。
	assertThrows(code, "RUNNER_LEASE_MISSING", "a missing runner lease");
});

test("the acceptance script only deletes the session file pi reported under the remote session root, and asserts it is gone", () => {
	const code = scriptCode();
	// 归属判定：必须在远端 `~/.pi/agent/sessions/` 之下、且是 `.jsonl`，否则清理会误删别人的文件。
	assert.match(code, /\["\.pi",\s*"agent",\s*"sessions"\]/, "the session root segments must stay pinned to ~/.pi/agent/sessions");
	assert.match(code, /startsWith\(\s*prefix\s*\)/, `${SCRIPT} must require the session file to sit under the session root`);
	assert.match(code, /endsWith\(\s*"\.jsonl"\s*\)/, `${SCRIPT} must require a session file name, not an arbitrary path`);
	assertThrows(code, "RUNTIME_SESSION_FILE_INVALID", "a session file outside the remote session root");
	// 删除与断言在同一条命令里：删不掉必须是失败，不是提示。
	assert.match(code, /rm\s+-f\s+\$\{quoted\};[\s\S]{0,40}?test\s+!\s+-e\s+\$\{quoted\}/, `${SCRIPT} must assert the session file is gone in the same remote command that removes it`);
	assertThrows(code, "CLEANUP_SESSION_DELETE_FAILED", "a session file that could not be deleted");
	// CLEANUP_OK 只能在删除成功之后打印。
	const deleteIndex = code.indexOf("await deleteSessionFile(context, sessionFile)");
	const cleanupIndex = code.indexOf('console.log("CLEANUP_OK"');
	assert.ok(deleteIndex >= 0 && cleanupIndex > deleteIndex, "CLEANUP_OK must be printed after the session file was deleted");
});

test("the acceptance script keeps the flow's evidence lines, in the P4.2 contract order", () => {
	const code = scriptCode();
	const ordered = ["NODE_OK", "BOOTSTRAP_FINALIZED", "RUNNER_PATH", "PI_OK", "RUNTIME_READY", "PROMPT_SENT", "ASSISTANT_EVENT", "ABORT_OK", "RUNTIME_STOPPED", "RESTART_OK", "CLEANUP_OK", "RUNTIME_E2E_OK"];
	let previous = -1;
	for (const line of ordered) {
		const index = code.indexOf(`console.log("${line}"`);
		assert.ok(index > previous, `${line} must be printed by the script, after the previous step`);
		previous = index;
	}
	// HOST_HANDSHAKE_OK 由共享 pin 模块打印：脚本自己打一条就等于伪造握手成功。
	assert.doesNotMatch(code, /console\s*\.\s*log\(\s*"HOST_HANDSHAKE_OK"/, `${SCRIPT} must not print HOST_HANDSHAKE_OK itself`);
	// restart 之后必须证明「同一个会话文件 + 文件里还有历史」，而不是只证明进程起来了。
	assert.match(code, /restartedState\.data\?\.sessionFile\s*!==\s*sessionFile/, `${SCRIPT} must compare the restarted session file with the first one`);
	assertThrows(code, "RESTART_SESSION_MISMATCH", "a restart that opened another session");
	assert.match(code, /history\.messages\s*<\s*2/, `${SCRIPT} must require at least a user and an assistant entry in the restored history`);
	assertThrows(code, "RESTART_HISTORY_EMPTY", "an empty restored history");
});

test("the acceptance run stays bounded and spends exactly one real model call", () => {
	const code = scriptCode();
	assert.match(code, /TOTAL_BUDGET_MS\s*=\s*[0-9_\s*]+/, "the whole run needs a total budget");
	assertThrows(code, "RUNTIME_E2E_TIMEOUT", "a run that outlived its total budget");
	// 只有一条 prompt，且正文是最小代价的那一条：任何新增的模型调用都必须被这一条挡下来。
	const prompts = code.match(/type:\s*"prompt"/g) ?? [];
	assert.equal(prompts.length, 1, `exactly one prompt may be sent (found ${prompts.length})`);
	assert.match(code, /const PROMPT_TEXT = "[^"]{1,32}";/, "the prompt must stay a short literal");
	// 没有「跳过检查仍算通过」的开关。
	assert.doesNotMatch(code, /ALLOW_FAILURE|EXPECT_FAIL|IGNORE_[A-Z_]+|SKIP_[A-Z_]+/, `${SCRIPT} must not carry a switch that turns a failed assertion into a pass`);
});

test("the acceptance script reuses the product's remote launch path instead of hand-rolling the runner handshake", () => {
	const code = scriptCode();
	assert.match(code, /createSshPiRuntimeLauncher\s*\(/, `${SCRIPT} must launch through the product's launcher`);
	assert.match(code, /buildRemotePiRuntimePlan\s*\(/, `${SCRIPT} must build the plan through the product's plan builder`);
	assert.match(code, /deployedRunnerPath\s*\(/, `${SCRIPT} must take the runner path from the deployment result`);
	assert.match(code, /new\s+PiRpcClient\s*\(/, `${SCRIPT} must speak RPC through the product's JSONL client`);
	assert.match(code, /buildPinnedSshInvocation\s*\(/, `${SCRIPT} must build every remote command through the pinned invocation`);
	// 自己拼 runner 命令/init 帧就等于绕开契约：脚本里不允许出现这些字面量。
	assert.doesNotMatch(code, /op\s*:\s*"start"/, `${SCRIPT} must not build the runner init frame itself`);
	assert.doesNotMatch(code, /\brunner\.mjs\b/, `${SCRIPT} must not assemble the runner path itself`);
	// 第二条通信通道（尤其裸 ssh/子进程）一律不允许。
	assert.doesNotMatch(code, /node:child_process|execSync|spawnSync/, `${SCRIPT} must not spawn anything locally`);
	assert.doesNotMatch(code, /["']ssh["']|["']\/usr\/bin\/ssh["']/, `${SCRIPT} must not name an ssh binary itself`);
});

test("the acceptance script carries no real-host credentials", () => {
	// 凭据卫生看**原文**：注释里也不允许出现真实主机/用户/指纹。
	const code = scriptSource();
	assert.ok(!code.includes("10.81.2.15"), `${SCRIPT} must not contain the real host`);
	assert.ok(!code.includes("zhadainian"), `${SCRIPT} must not contain the real user`);
	assert.ok(!code.includes("a/qeVMKmlbe47KuxZlAzT2rcUTwtHPNNPqnS5uij"), `${SCRIPT} must not contain the real fingerprint`);
	assert.ok(!/SHA256:[A-Za-z0-9+/]{43}/.test(code), `${SCRIPT} must not contain a literal fingerprint`);
});
