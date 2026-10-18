/**
 * GitRefsWatcher 单元测试（stat 签名轮询版）。
 *
 * 两个关键契约：
 * 1. 签名覆盖全部「角标相关」变化（HEAD / 当前分支引用 / 上游引用 / packed-refs / config），
 *    且**不含 index**——`git status` 自己会改写 index，收进签名就是「刷新 → status →
 *    index → 再刷新」的自激循环。
 * 2. 零句柄：不创建 fs.watch（Windows 上任何仓库子树内的监听句柄都会让项目目录无法
 *    重命名，正是弃用 fs.watch 的原因）。
 *
 * 仓库用「手工造的 .git 目录」而不是真实 git：不依赖外部命令、CI 上完全确定；
 * 文件内容特意用不同长度，避免低分辨率文件系统上 mtime 相同导致漏检。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { GitRefsWatcher, readBranchUpstream, readRefsSignature, resolveGitDir } = loadTsCommonJs("src/main/git/GitRefsWatcher.ts");

const temps = [];
function makeTempDir() {
	const dir = mkdtempSync(join(tmpdir(), "pideck-refs-"));
	temps.push(dir);
	return dir;
}
test.after(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** 手工造普通仓库：<root>/.git/{HEAD,config,index,refs/...}，可选带 upstream 配置 */
function createRepo({ head = "ref: refs/heads/main", upstream = null } = {}) {
	const root = makeTempDir();
	const gitDir = join(root, ".git");
	mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
	mkdirSync(join(gitDir, "refs", "remotes", "origin"), { recursive: true });
	writeFileSync(join(gitDir, "HEAD"), `${head}\n`);
	writeFileSync(join(gitDir, "refs", "heads", "main"), `${"0".repeat(40)}\n`);
	writeFileSync(join(gitDir, "index"), "index-v1");
	if (upstream) {
		writeFileSync(join(gitDir, "config"), `[core]\n\trepositoryformatversion = 0\n[branch "main"]\n\tremote = ${upstream.remote}\n\tmerge = ${upstream.merge}\n`);
		writeFileSync(join(gitDir, "refs", "remotes", "origin", "main"), `${"1".repeat(40)}\n`);
	} else {
		writeFileSync(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n");
	}
	return { root, gitDir };
}

/** 假定时器：测试手动推进采样，不需要等真实时间 */
function createTimerHarness() {
	const timers = [];
	return {
		setTimer(handler, intervalMs) {
			const token = { handler, intervalMs, cleared: false };
			timers.push(token);
			return token;
		},
		clearTimer(token) {
			if (token) token.cleared = true;
		},
		live() {
			return timers.filter((token) => !token.cleared);
		},
		clearCalls() {
			return timers.filter((token) => token.cleared).length;
		},
		/** 推进一轮采样 */
		tick() {
			for (const token of [...timers]) if (!token.cleared) token.handler();
		},
	};
}

function createWatcher(overrides = {}) {
	const timers = createTimerHarness();
	const warnings = [];
	const watcher = new GitRefsWatcher({
		logger: { warn: (scope, message, detail) => warnings.push({ scope, message, detail }) },
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		// 默认把订阅路径当作 toplevel：这些用例的临时目录本身就是仓库根；
		// 「项目根是仓库子目录」的解析分支由专门用例注入 resolver。
		resolveRepoRoot: async (cwd) => cwd,
		...overrides,
	});
	return { watcher, timers, warnings };
}

/** 登记是两段式的（先按 watchId 记账，toplevel 解析完成后才起轮询），断言前先冲掉微任务。 */
async function flushResolution() {
	await new Promise((done) => setImmediate(done));
}

test("resolveGitDir 解析普通仓库、worktree 的 .git 文件与 commondir", () => {
	const plain = createRepo();
	const plainRoots = resolveGitDir(plain.root);
	assert.equal(plainRoots.gitDir, join(plain.root, ".git"));
	assert.equal(plainRoots.commonDir, join(plain.root, ".git"), "普通仓库的公共目录就是 .git 本身");

	const superRoot = makeTempDir();
	const mainGit = join(superRoot, ".git");
	const worktreeGitDir = join(mainGit, "worktrees", "wt");
	mkdirSync(worktreeGitDir, { recursive: true });
	writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
	const worktreeRoot = makeTempDir();
	writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`);
	const worktreeRoots = resolveGitDir(worktreeRoot);
	assert.equal(worktreeRoots.gitDir, worktreeGitDir);
	assert.equal(worktreeRoots.commonDir, mainGit, "worktree 的 refs 必须指向主仓库公共目录");

	// .git 文件写相对路径时按工作区目录解析
	const relativeRoot = makeTempDir();
	writeFileSync(join(relativeRoot, ".git"), "gitdir: ../pideck-relative-gitdir\n");
	assert.equal(resolveGitDir(relativeRoot).gitDir, resolve(relativeRoot, "../pideck-relative-gitdir"));

	assert.equal(resolveGitDir(makeTempDir()), null, "非仓库返回 null（调用方静默降级）");
});

test("readBranchUpstream 只解析目标分支的 remote/merge，特殊字符分支名也能匹配", () => {
	const config = ["[core]", "\trepositoryformatversion = 0", '[branch "main"]', "\tremote = origin", "\tmerge = refs/heads/main", '[branch "other"]', "\tremote = upstream", "\tmerge = refs/heads/dev"].join("\n");
	const main = readBranchUpstream(config, "main");
	assert.equal(main.remote, "origin");
	assert.equal(main.merge, "refs/heads/main");
	assert.equal(readBranchUpstream(config, "other").remote, "upstream", "section 必须隔离，不能串到别的分支");
	assert.equal(readBranchUpstream(config, "missing"), null);

	// 分支名里的点号必须按字面匹配（否则会误配到别的 section）
	const dotted = '[branch "a.b"]\n\tremote = fork\n\tmerge = refs/heads/a.b\n[branch "axb"]\n\tremote = wrong\n\tmerge = refs/heads/axb\n';
	assert.equal(readBranchUpstream(dotted, "a.b").remote, "fork");
});

test("签名覆盖分支引用 / 上游引用 / packed-refs / HEAD / config，且不受 index 影响", () => {
	const repo = createRepo({ upstream: { remote: "origin", merge: "refs/heads/main" } });
	const base = readRefsSignature(repo.root);
	assert.ok(base && base.length > 0);
	assert.equal(readRefsSignature(repo.root), base, "同一状态连续采样必须相等，否则每轮都会误报");

	// git status / git add 会改写 index：它必须不在签名里
	writeFileSync(join(repo.gitDir, "index"), "index-v2-longer");
	assert.equal(readRefsSignature(repo.root), base, "index 变化不得影响签名（否则刷新自激）");

	// commit / reset / push：当前分支引用
	writeFileSync(join(repo.gitDir, "refs", "heads", "main"), `${"2".repeat(41)}\n`);
	const afterBranch = readRefsSignature(repo.root);
	assert.notEqual(afterBranch, base, "当前分支引用变化必须被检出");

	// fetch / push：上游远程跟踪引用
	writeFileSync(join(repo.gitDir, "refs", "remotes", "origin", "main"), `${"3".repeat(42)}\n`);
	const afterUpstream = readRefsSignature(repo.root);
	assert.notEqual(afterUpstream, afterBranch, "上游引用变化必须被检出");

	// gc / pack-refs：松散引用被搬进 packed-refs
	writeFileSync(join(repo.gitDir, "packed-refs"), `# pack-refs with: peeled\n${"4".repeat(43)} refs/heads/main\n`);
	const afterPacked = readRefsSignature(repo.root);
	assert.notEqual(afterPacked, afterUpstream, "packed-refs 变化必须被检出");

	// 切分支：HEAD
	writeFileSync(join(repo.gitDir, "HEAD"), "ref: refs/heads/feature\n");
	const afterHead = readRefsSignature(repo.root);
	assert.notEqual(afterHead, afterPacked, "HEAD 变化必须被检出");

	// git push -u / branch --set-upstream-to：config
	writeFileSync(join(repo.gitDir, "config"), `[core]\n\trepositoryformatversion = 0\n[branch "feature"]\n\tremote = origin\n\tmerge = refs/heads/feature\n`);
	assert.notEqual(readRefsSignature(repo.root), afterHead, "upstream 配置变化必须被检出");
});

test("worktree：分支引用落在 commondir 里也要盯住", () => {
	const superRoot = makeTempDir();
	const mainGit = join(superRoot, ".git");
	mkdirSync(join(mainGit, "refs", "heads"), { recursive: true });
	writeFileSync(join(mainGit, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(mainGit, "packed-refs"), "# pack-refs with: peeled\n");
	writeFileSync(join(mainGit, "config"), "[core]\n\trepositoryformatversion = 0\n");
	const worktreeGitDir = join(mainGit, "worktrees", "wt");
	mkdirSync(worktreeGitDir, { recursive: true });
	writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
	writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/wt\n");
	const worktreeRoot = makeTempDir();
	writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`);
	writeFileSync(join(mainGit, "refs", "heads", "wt"), `${"5".repeat(40)}\n`);

	const before = readRefsSignature(worktreeRoot);
	assert.ok(before);
	writeFileSync(join(mainGit, "refs", "heads", "wt"), `${"6".repeat(44)}\n`);
	assert.notEqual(readRefsSignature(worktreeRoot), before, "worktree 的分支引用在 commondir，必须被检出");
});

test("轮询零句柄：不创建任何 fs.watch（Windows 上句柄会让项目目录无法重命名）", () => {
	const source = readFileSync("src/main/git/GitRefsWatcher.ts", "utf8");
	assert.doesNotMatch(source, /from "node:fs"[\s\S]{0,200}?\bwatch\b/, "不得再从 node:fs 引入 watch");
	assert.doesNotMatch(source, /\bwatch\(/, "不得调用 fs.watch（会占用项目目录）");
	assert.doesNotMatch(source, /FSWatcher/, "FSWatcher 句柄类型应已完全移除");
	assert.match(source, /const DEFAULT_POLL_INTERVAL_MS = 1500;/, "默认轮询间隔必须是 1.5 秒");
});

test("acquire 先取基线：未变化不通知，变化只通知一次", async () => {
	const repo = createRepo();
	const { watcher, timers } = createWatcher();
	const seen = [];
	const stop = watcher.on((watchId) => seen.push(watchId));
	const watchId = watcher.acquire("p1", repo.root);
	await flushResolution();

	assert.equal(timers.live().length, 1, "acquire 后应开始轮询");
	// 默认间隔 1.5 秒：用户抱怨的是「5 秒太久」，延迟上限就是这个值
	assert.equal(timers.live()[0].intervalMs, 1500);

	timers.tick();
	assert.deepEqual([...seen], [], "只有基线、没有变化时不得通知");

	writeFileSync(join(repo.gitDir, "HEAD"), "ref: refs/heads/feature\n");
	timers.tick();
	assert.deepEqual([...seen], [watchId], "变化后通知一次");

	timers.tick();
	assert.deepEqual([...seen], [watchId], "状态没有继续变化时不得重复通知");
	stop();
});

test("同一仓库复用 watchId，计数归零才停轮询", async () => {
	const repo = createRepo();
	const { watcher, timers } = createWatcher();
	const first = watcher.acquire("p1", repo.root);
	const second = watcher.acquire("p1", repo.root);
	await flushResolution();
	assert.equal(first, second, "同一 (projectId, repoPath) 必须复用 watchId");
	assert.equal(watcher.activeRepoCount, 1);
	assert.equal(timers.live().length, 1, "分屏/多面板共用一份轮询");

	watcher.release(first);
	assert.equal(watcher.activeRepoCount, 1);
	assert.equal(timers.clearCalls(), 0, "还有订阅者时不得停轮询");

	watcher.release(second);
	assert.equal(watcher.activeRepoCount, 0);
	assert.equal(timers.clearCalls(), 1, "最后一个订阅者退出必须停掉定时器");

	watcher.release("unknown::watch-id");
	assert.equal(timers.clearCalls(), 1, "未知 id 退订必须安全且不产生副作用");
});

test("多仓库各自独立：只有发生变化的仓库被通知", async () => {
	const repoA = createRepo();
	const repoB = createRepo();
	const { watcher, timers } = createWatcher();
	const seen = [];
	watcher.on((watchId) => seen.push(watchId));
	const idA = watcher.acquire("pA", repoA.root);
	const idB = watcher.acquire("pB", repoB.root);
	await flushResolution();
	assert.notEqual(idA, idB);

	writeFileSync(join(repoA.gitDir, "refs", "heads", "main"), `${"9".repeat(45)}\n`);
	timers.tick();
	assert.deepEqual([...seen], [idA], "只应通知发生变化的那个仓库");
});

test("单个订阅者抛错不影响其它订阅者与后续轮询", async () => {
	const repo = createRepo();
	const { watcher, timers, warnings } = createWatcher();
	const accepted = [];
	const stopThrowing = watcher.on(() => {
		throw new Error("Object has been destroyed");
	});
	const stopAccepted = watcher.on((watchId) => accepted.push(watchId));
	const watchId = watcher.acquire("p1", repo.root);
	await flushResolution();

	writeFileSync(join(repo.gitDir, "HEAD"), "ref: refs/heads/two\n");
	timers.tick();
	assert.deepEqual([...accepted], [watchId], "一个订阅者抛错不能吞掉其它订阅者的通知");
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].scope, "git");
	assert.match(String(warnings[0].detail.error), /Object has been destroyed/);
	stopThrowing();
	stopAccepted();
});

test("签名读取抛错只记 warn，不打断轮询也不误报变化", async () => {
	const { watcher, timers, warnings } = createWatcher({
		readSignature: () => {
			throw new Error("EPERM: operation not permitted");
		},
	});
	const seen = [];
	watcher.on((watchId) => seen.push(watchId));
	watcher.acquire("p1", "/not/readable");
	await flushResolution();
	timers.tick();

	assert.ok(warnings.length >= 1);
	assert.ok(
		warnings.every((entry) => entry.scope === "git"),
		"降级日志必须走 git scope",
	);
	assert.deepEqual([...seen], [], "读不到签名不得当作「有变化」去打扰渲染层");
});

test("非 git 目录静默降级：返回 id、记一次 warn、永远不通知", async () => {
	const bare = makeTempDir();
	const { watcher, timers, warnings } = createWatcher();
	const seen = [];
	watcher.on((watchId) => seen.push(watchId));
	const watchId = watcher.acquire("p1", bare);
	await flushResolution();

	assert.equal(typeof watchId, "string");
	assert.equal(watcher.activeRepoCount, 1);
	assert.equal(warnings.length, 1, "降级只记 warn，不抛给调用方");
	assert.equal(warnings[0].scope, "git");
	assert.equal(readRefsSignature(bare), null, "非仓库的签名必须是 null");

	timers.tick();
	assert.deepEqual([...seen], []);
});

test("disposeAll 停轮询并清空订阅（退出清理路径）", async () => {
	const repoA = createRepo();
	const repoB = createRepo();
	const { watcher, timers } = createWatcher();
	const seen = [];
	watcher.on((watchId) => seen.push(watchId));
	watcher.acquire("p1", repoA.root);
	watcher.acquire("p2", repoB.root);
	await flushResolution();
	assert.equal(watcher.activeRepoCount, 2);

	watcher.disposeAll();
	assert.equal(watcher.activeRepoCount, 0);
	assert.equal(timers.clearCalls(), 1, "退出时必须停掉定时器");
	writeFileSync(join(repoA.gitDir, "HEAD"), "ref: refs/heads/after-dispose\n");
	timers.tick();
	assert.deepEqual([...seen], [], "disposeAll 后不再通知");
});

// ── 项目根 ≠ 仓库根 ─────────────────────────────────────────────────────────
// 背景：订阅方传下来的是「项目内仓库根」，它可能只是仓库的子目录（monorepo 子包、项目根
// 下才另有仓库）。refs 文件在仓库 toplevel 的 .git 下，按项目根拼路径必然落空 → 签名恒为
// null → 永不通告，着色/角标全部退化成只靠 5 秒轮询。修法是先解析 toplevel 再按它轮询。

test("项目根是仓库子目录时按解析出的 toplevel 采样（原来这里签名恒为 null）", async () => {
	const repo = createRepo();
	const projectRoot = join(repo.root, "packages", "app");
	mkdirSync(projectRoot, { recursive: true });
	const sampled = [];
	const { watcher, timers } = createWatcher({
		resolveRepoRoot: async (cwd) => (cwd === projectRoot ? repo.root : cwd),
		readSignature: (repoPath) => {
			sampled.push(repoPath);
			return readRefsSignature(repoPath);
		},
	});
	const seen = [];
	watcher.on((watchId) => seen.push(watchId));
	const watchId = watcher.acquire("p1", projectRoot);
	await flushResolution();

	assert.deepEqual(sampled, [repo.root], "必须用 toplevel 采样，不能拿项目根去拼 .git");
	assert.equal(readRefsSignature(projectRoot), null, "反证：项目根自身的签名恒为 null（就是原缺陷）");

	writeFileSync(join(repo.gitDir, "HEAD"), "ref: refs/heads/feature\n");
	timers.tick();
	assert.deepEqual([...seen], [watchId], "子目录项目根也必须收到 refs 变化");
	assert.deepEqual(sampled, [repo.root, repo.root], "轮询同样按 toplevel 采样");
});

test("同一仓库的两个项目根共用一份轮询（计数为 2，逐个通告）", async () => {
	const repo = createRepo();
	const projectA = join(repo.root, "packages", "a");
	const projectB = join(repo.root, "apps", "b");
	mkdirSync(projectA, { recursive: true });
	mkdirSync(projectB, { recursive: true });
	const { watcher, timers } = createWatcher({ resolveRepoRoot: async () => repo.root });
	const seen = [];
	watcher.on((watchId) => seen.push(watchId));
	const idA = watcher.acquire("pA", projectA);
	const idB = watcher.acquire("pB", projectB);
	await flushResolution();

	assert.notEqual(idA, idB, "两个调用方各有自己的 watchId（unwatch 只拿得到自己的 id，得能反查到轮询）");
	assert.equal(watcher.activeRepoCount, 1, "同一 toplevel 只跑一份轮询");
	assert.equal(timers.live().length, 1);

	writeFileSync(join(repo.gitDir, "HEAD"), "ref: refs/heads/feature\n");
	timers.tick();
	assert.deepEqual([...seen].sort(), [idA, idB].sort(), "共用轮询的每个订阅者都要被通告，否则其中一个面板不刷新");

	watcher.release(idA);
	assert.equal(watcher.activeRepoCount, 1, "引用计数 2 → 1：还有订阅者时不得停轮询");
	assert.equal(timers.clearCalls(), 0);
	watcher.release(idB);
	assert.equal(watcher.activeRepoCount, 0);
	assert.equal(timers.clearCalls(), 1, "最后一个订阅者退出必须停掉定时器");
});

test("解析完成前退订不留孤儿；迟到的解析回调不得污染新一代登记", async () => {
	const repo = createRepo();
	const deferred = [];
	const { watcher, timers } = createWatcher({ resolveRepoRoot: () => new Promise((done) => deferred.push(done)) });
	const first = watcher.acquire("p1", repo.root);
	assert.equal(timers.live().length, 0, "toplevel 还没解析出来时不得起轮询（否则会拿没校验的路径采样）");

	watcher.release(first);
	assert.equal(watcher.pendingRepoCount, 0, "退订必须摘掉解析中的登记");
	deferred[0](repo.root);
	await flushResolution();
	assert.equal(watcher.activeRepoCount, 0, "解析迟到时不得留下孤儿仓库条目");
	assert.equal(timers.live().length, 0, "解析迟到时不得起孤儿定时器");

	// 退订后立刻又挂载（同 watchId）：旧解析回调回来时不能把新一代的登记当自己的
	const second = watcher.acquire("p1", repo.root);
	assert.equal(second, first, "同一 (projectId, repoPath) 的 watchId 稳定");
	assert.equal(deferred.length, 2, "重新订阅必须发起一次新的解析");
	deferred[0](repo.root);
	await flushResolution();
	assert.equal(watcher.pendingRepoCount, 1, "旧解析回调不得摘掉新一代的登记");
	assert.equal(watcher.activeRepoCount, 0);
	deferred[1](repo.root);
	await flushResolution();
	assert.equal(watcher.activeRepoCount, 1);
	assert.equal(timers.live().length, 1, "新一代解析完成后正常起轮询");
	watcher.release(second);
	assert.equal(timers.clearCalls(), 1);

	// 应用退出（disposeAll）时解析还在飞：回调回来同样不得再登记
	watcher.acquire("p2", repo.root);
	watcher.disposeAll();
	deferred[2](repo.root);
	await flushResolution();
	assert.equal(watcher.activeRepoCount, 0, "退出清理后在飞的解析不得重新登记");
	assert.equal(watcher.pendingRepoCount, 0);
	assert.equal(timers.live().length, 0);
});

test("toplevel 解析失败静默降级：不抛、不误报，退订照常", async () => {
	const bare = makeTempDir();
	const variants = [
		{ name: "解析返回 null（不在工作树里）", resolveRepoRoot: async () => null },
		{
			// 同步抛错：注入点/未来改造可能就直接 throw，acquire 不得把它漏给 IPC（包一层 promise 结算）
			name: "解析抛错（git 未安装 / 超时）",
			resolveRepoRoot: () => {
				throw new Error("spawn git ENOENT");
			},
		},
	];
	for (const variant of variants) {
		const { watcher, timers, warnings } = createWatcher({ resolveRepoRoot: variant.resolveRepoRoot });
		const seen = [];
		watcher.on((watchId) => seen.push(watchId));
		const watchId = watcher.acquire("p1", bare);
		await flushResolution();

		assert.equal(typeof watchId, "string", `${variant.name}：必须照常返回 watchId，不许把异常抛给 IPC`);
		assert.equal(watcher.activeRepoCount, 1, `${variant.name}：退回订阅路径继续盯着（签名 null 只是不通知）`);
		assert.ok(warnings.length >= 2, `${variant.name}：解析失败与非仓库签名各记一条 warn`);
		assert.ok(
			warnings.every((entry) => entry.scope === "git"),
			`${variant.name}：降级日志必须走 git scope`,
		);
		assert.match(String(warnings[0].detail.error), /not a git work tree|ENOENT/, `${variant.name}：warn 要带上失败原因`);

		timers.tick();
		assert.deepEqual([...seen], [], `${variant.name}：降级不得误报成「有变化」`);

		watcher.release(watchId);
		assert.equal(watcher.activeRepoCount, 0, `${variant.name}：降级后仍能正常退订`);
		assert.equal(timers.clearCalls(), 1);
	}
});

test("toplevel 解析复用收口：execGit + toHostGitOutputPath（WSL 路径不另写一套转换）", () => {
	const source = readFileSync("src/main/git/gitRun.ts", "utf8");
	const start = source.indexOf("export async function resolveGitToplevel");
	const end = source.indexOf("function runWslGit");
	assert.ok(start > 0 && end > start, "resolveGitToplevel 必须留在 gitRun 收口里");
	const fn = source.slice(start, end);
	// 空白容忍：格式化改缩进不能让契约测试误红
	assert.match(fn, /execGit\(\s*\["rev-parse", "--show-toplevel"\]\s*,\s*\{\s*cwd,\s*timeoutMs\s*\}/, "必须经 execGit（WSL 仓库由它分流到发行版内 git）");
	assert.match(fn, /toHostGitOutputPath\(\s*toplevel\s*,\s*resolveWslGitTarget\(\s*cwd\s*\)\s*\)/, "WSL 分支输出的是 Linux 路径，必须复用 gitWsl 的回译函数");
	assert.match(fn, /\} catch \{\s*return null;/, "失败一律返回 null（静默降级），不能把异常抛给订阅方");

	const watcherSource = readFileSync("src/main/git/GitRefsWatcher.ts", "utf8");
	assert.match(watcherSource, /import\s*\{\s*resolveGitToplevel\s*\}\s*from\s*"\.\/gitRun"/, "默认 resolver 必须是 gitRun 的收口实现");
	assert.match(watcherSource, /this\.resolveRepoRootFn = deps\.resolveRepoRoot \?\? resolveGitToplevel;/, "注入点默认值不能漏接");
});
