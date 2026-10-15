import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, readdirSync, unlinkSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, successful, options } from "./helpers/remoteGitFixture.mjs";

function baseline(f) {
	writeFileSync(join(f.root, "one.txt"), "base\n");
	writeFileSync(join(f.root, "two.txt"), "other\n");
	f.git("add", "--", "one.txt", "two.txt");
	f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
}
async function mutate(f, method, path, group, expected) {
	const state = expected ?? successful(await f.request("git.status")).revision;
	assert.match(state, /^[a-f0-9]{64}$/);
	return f.request(method, { path, group, expectedRevision: state });
}
function noScratch(f) {
	assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
	assert.deepEqual(
		readdirSync(join(f.root, ".git")).filter((name) => name.startsWith("pideck-index-")),
		[],
	);
}

test("remote Git stages only the selected whole text file; unstage keeps worktree and unrelated staged blob", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "one.txt"), "latest\r\n");
	writeFileSync(join(f.root, "two.txt"), "unrelated staged\n");
	f.git("add", "--", "two.txt");
	const other = f.git("rev-parse", ":two.txt");
	const head = f.git("rev-parse", "HEAD");
	const mode = statSync(join(f.root, ".git/index")).mode & 0o777;
	assert.deepEqual(successful(await mutate(f, "git.stage", "one.txt", "workingTree")), { applied: true });
	assert.equal(f.git("show", ":one.txt"), "latest\r\n");
	assert.equal(f.git("rev-parse", ":two.txt"), other);
	assert.deepEqual(successful(await mutate(f, "git.unstage", "one.txt", "index")), { applied: true });
	assert.equal(f.git("show", ":one.txt"), "base\n");
	assert.equal(readFileSync(join(f.root, "one.txt"), "utf8"), "latest\r\n");
	assert.equal(f.git("rev-parse", ":two.txt"), other);
	assert.equal(f.git("rev-parse", "HEAD"), head);
	assert.equal(statSync(join(f.root, ".git/index")).mode & 0o777, mode);
	noScratch(f);
});

test("remote Git unborn stage/unstage retains the new file and an unrelated index entry", options, async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.root, "中文 [file].txt"), "new\n");
	writeFileSync(join(f.root, "two.txt"), "other\n");
	f.git("add", "--", "two.txt");
	successful(await mutate(f, "git.stage", "中文 [file].txt", "untracked"));
	successful(await mutate(f, "git.unstage", "中文 [file].txt", "index"));
	assert.equal(f.git("ls-files"), "two.txt\n");
	assert.equal(readFileSync(join(f.root, "中文 [file].txt"), "utf8"), "new\n");
	noScratch(f);
});

test("remote Git unstage rename derives both paths, but staging edits of the staged rename touches only its new path", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	f.git("mv", "--", "one.txt", "renamed.txt");
	writeFileSync(join(f.root, "renamed.txt"), "edited\n");
	successful(await mutate(f, "git.stage", "renamed.txt", "workingTree"));
	assert.equal(f.git("show", ":renamed.txt"), "edited\n");
	// Restore identical content so native status identifies a rename for the two-path unstage.
	writeFileSync(join(f.root, "renamed.txt"), "base\n");
	f.git("add", "--", "renamed.txt");
	successful(await mutate(f, "git.unstage", "renamed.txt", "index"));
	assert.equal(f.git("show", ":one.txt"), "base\n");
	assert.equal(f.git("ls-files", "--", "renamed.txt"), "");
	assert.equal(readFileSync(join(f.root, "renamed.txt"), "utf8"), "base\n");
	noScratch(f);
});

test("remote Git stale index/HEAD/status revision refuses without replacing index", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "one.txt"), "changed\n");
	const initial = successful(await f.request("git.status"));
	writeFileSync(join(f.root, "two.txt"), "external\n");
	f.git("add", "--", "two.txt");
	const before = readFileSync(join(f.root, ".git/index"));
	const result = await mutate(f, "git.stage", "one.txt", "workingTree", initial.revision);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "GIT_RESOURCE_CHANGED");
	assert.deepEqual(readFileSync(join(f.root, ".git/index")), before);
	noScratch(f);
});

test("remote Git never removes an existing official index lock", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	writeFileSync(join(f.root, "one.txt"), "changed\n");
	const lock = join(f.root, ".git/index.lock");
	writeFileSync(lock, "owned by another writer\n");
	const before = readFileSync(join(f.root, ".git/index"));
	const result = await mutate(f, "git.stage", "one.txt", "workingTree");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "GIT_INDEX_LOCKED");
	assert.equal(readFileSync(lock, "utf8"), "owned by another writer\n");
	assert.deepEqual(readFileSync(join(f.root, ".git/index")), before);
});

test("remote Git stage deletion and intent-to-add are precise and keep HEAD/worktree unchanged", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	unlinkSync(join(f.root, "one.txt"));
	successful(await mutate(f, "git.stage", "one.txt", "workingTree"));
	assert.equal(f.git("ls-files", "--", "one.txt"), "");
	successful(await mutate(f, "git.unstage", "one.txt", "index"));
	assert.equal(f.git("show", ":one.txt"), "base\n");
	assert.equal(existsSync(join(f.root, "one.txt")), false);
	writeFileSync(join(f.root, "intent.txt"), "intent\n");
	f.git("add", "-N", "--", "intent.txt");
	successful(await mutate(f, "git.stage", "intent.txt", "workingTree"));
	assert.equal(f.git("show", ":intent.txt"), "intent\n");
	noScratch(f);
});

test("remote Git refuses a symlink resource and preserves both index and outside target", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const outside = join(f.directory, "outside");
	writeFileSync(outside, "outside\n");
	symlinkSync(outside, join(f.root, "link.txt"));
	const before = readFileSync(join(f.root, ".git/index"));
	const result = await mutate(f, "git.stage", "link.txt", "untracked");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "NOT_A_FILE");
	assert.deepEqual(readFileSync(join(f.root, ".git/index")), before);
	assert.equal(readFileSync(outside, "utf8"), "outside\n");
	noScratch(f);
});

test("remote Git refuses a FIFO replacement without blocking helper cancellation/control", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	unlinkSync(join(f.root, "one.txt"));
	execFileSync("mkfifo", [join(f.root, "one.txt")], { timeout: 1000 });
	const state = successful(await f.request("git.status"));
	const before = readFileSync(join(f.root, ".git/index"));
	const result = await f.request("git.stage", { path: "one.txt", group: "workingTree", expectedRevision: state.revision }, 1000);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "NOT_A_FILE");
	assert.equal(successful(await f.request("echo", { text: "responsive" })).text, "responsive");
	assert.deepEqual(readFileSync(join(f.root, ".git/index")), before);
	noScratch(f);
});

test("remote Git native autocrlf conversion is preserved without invoking project filters", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	f.git("config", "core.autocrlf", "true");
	writeFileSync(join(f.root, "one.txt"), "converted\r\n");
	successful(await mutate(f, "git.stage", "one.txt", "workingTree"));
	assert.equal(f.git("show", ":one.txt"), "converted\n");
	assert.equal(readFileSync(join(f.root, "one.txt"), "utf8"), "converted\r\n");
	noScratch(f);
});

for (const scenario of ["cancel", "timeout", "eof", "externalIndex", "externalHead", "lateHook", "lateWorktree", "lateAttributes"]) {
	test(`remote Git write ${scenario} leaves real index/worktree safe and reaps owned native processes`, options, async (t) => {
		const actualGit = realpathSync(
			process.env.PATH.split(":")
				.map((part) => join(part, "git"))
				.find(existsSync),
		);
		let marker, hold;
		const f = fixture(t, true, ({ directory }) => {
			const bin = join(directory, "bin");
			mkdirSync(bin);
			marker = join(directory, "writer.pid");
			hold = join(directory, "hold");
			writeFileSync(hold, "hold");
			const script = `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); const run = () => { const child = require('node:child_process').spawnSync(${JSON.stringify(actualGit)}, args, { env: process.env, stdio: 'inherit' }); process.exit(child.status ?? 1); }; if (args.includes('add') && process.env.GIT_INDEX_FILE?.includes('pideck-index-')) { fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(hold)})) { clearInterval(timer); run(); } }, 10); } else run();\n`;
			writeFileSync(join(bin, "git"), script);
			chmodSync(join(bin, "git"), 0o700);
			return { PATH: bin + ":" + process.env.PATH };
		});
		baseline(f);
		writeFileSync(join(f.root, "one.txt"), "changed\n");
		const initial = successful(await f.request("git.status")),
			before = readFileSync(join(f.root, ".git/index"));
		let id;
		const pending = f.request("git.stage", { path: "one.txt", group: "workingTree", expectedRevision: initial.revision }, scenario === "timeout" ? 1600 : 3000, (value) => {
			id = value;
		});
		const observation = pending.catch(() => undefined);
		const wait = async (predicate) => {
			const until = Date.now() + 4000;
			while (Date.now() < until) {
				if (predicate()) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.fail("bounded write/process observation expired");
		};
		await wait(() => existsSync(marker));
		const pid = Number(readFileSync(marker, "utf8"));
		let expected = before;
		if (scenario === "cancel") successful(await f.request("cancel", { requestId: id }));
		else if (scenario === "eof") f.child.stdin.end();
		else if (scenario === "externalIndex") {
			const bytes = Buffer.concat([before, Buffer.from("external")]);
			writeFileSync(join(f.root, ".git/index"), bytes);
			expected = bytes;
			unlinkSync(hold);
		} else if (scenario === "externalHead") {
			f.git("symbolic-ref", "HEAD", "refs/heads/other-unborn");
			unlinkSync(hold);
		} else if (scenario === "lateHook") {
			mkdirSync(join(f.root, ".git/hooks"), { recursive: true });
			const hook = join(f.root, ".git/hooks/post-index-change");
			writeFileSync(hook, "#!/bin/sh\nexit 1\n");
			chmodSync(hook, 0o755);
			unlinkSync(hold);
		} else if (scenario === "lateWorktree") {
			writeFileSync(join(f.root, "one.txt"), "external edit\n");
			unlinkSync(hold);
		} else if (scenario === "lateAttributes") {
			writeFileSync(join(f.root, ".gitattributes"), "one.txt text eol=lf\n");
			unlinkSync(hold);
		}
		const result = await observation;
		if (scenario !== "eof") {
			assert.equal(result.ok, false);
			assert.equal(result.error.code, scenario === "cancel" ? "REQUEST_CANCELLED" : scenario === "timeout" ? "REQUEST_TIMEOUT" : scenario === "lateHook" ? "GIT_WRITE_UNSUPPORTED" : "GIT_RESOURCE_CHANGED");
		}
		await wait(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch (error) {
				return error.code === "ESRCH";
			}
		});
		await wait(() => !existsSync(join(f.root, ".git/index.lock")));
		assert.deepEqual(readFileSync(join(f.root, ".git/index")), expected);
		assert.equal(readFileSync(join(f.root, "one.txt"), "utf8"), scenario === "lateWorktree" ? "external edit\n" : "changed\n");
		if (scenario !== "eof") assert.equal(successful(await f.request("echo", { text: "alive" })).text, "alive");
	});
}

for (const gate of ["hook", "hooksPath", "globalHooksPath", "signing", "merge", "binary", "skipWorktree", "splitIndex"]) {
	test(`remote Git ${gate} write gate refuses, keeps the real index, and never runs a hook`, options, async (t) => {
		const f = fixture(t);
		baseline(f);
		writeFileSync(join(f.root, "one.txt"), gate === "binary" ? Buffer.from([0, 1, 2]) : "changed\n");
		const marker = join(f.directory, "must-not-exist");
		if (gate === "hook") {
			mkdirSync(join(f.root, ".git/hooks"), { recursive: true });
			const hook = join(f.root, ".git/hooks/post-index-change");
			writeFileSync(hook, `#!/bin/sh\nprintf 'executed' > '${marker}'\n`);
			chmodSync(hook, 0o755);
		}
		if (gate === "globalHooksPath") writeFileSync(join(f.directory, "home/.gitconfig"), "[core]\nhooksPath = /not-authorized/hooks\n");
		if (gate === "hooksPath") f.git("config", "core.hooksPath", "other-hooks");
		if (gate === "signing") f.git("config", "commit.gpgSign", "true");
		if (gate === "merge") writeFileSync(join(f.root, ".git/MERGE_HEAD"), f.git("rev-parse", "HEAD"));
		if (gate === "skipWorktree") f.git("update-index", "--skip-worktree", "two.txt");
		if (gate === "splitIndex") f.git("update-index", "--split-index");
		const before = readFileSync(join(f.root, ".git/index"));
		const result = await mutate(f, "git.stage", "one.txt", "workingTree");
		assert.equal(result.ok, false);
		assert.equal(result.error.code, gate === "binary" ? "GIT_NOT_TEXT" : "GIT_WRITE_UNSUPPORTED");
		assert.deepEqual(readFileSync(join(f.root, ".git/index")), before);
		assert.equal(existsSync(marker), false);
		noScratch(f);
	});
}
