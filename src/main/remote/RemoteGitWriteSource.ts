/** Managed index writes: native Git runs in an owned private metadata context, never with live hooks/filters. */
export const REMOTE_GIT_WRITE_SOURCE = String.raw`function createGitWriteProgram(fs, port) {
	const crypto = port.crypto;
	const fail = port.failure, MAX_INDEX = 16777216, MAX_TEXT = 262144;
	const CONFIG = "^(core\\.(hookspath|attributesfile|excludesfile|repositoryformatversion|filemode|ignorecase|autocrlf|eol|safecrlf|symlinks|ignorestat|trustctime|checkstat|protecthfs|protectntfs|quotepath)|commit\\.gpgsign|index\\.version|extensions\\.objectformat|status\\.renames|diff\\.(renames|renamelimit))$";
	function utf8(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	function optional(base, name, limit) { try { return port.readFile(base, name, limit); } catch (error) { if (error.message === "PATH_NOT_FOUND") return null; throw error; } }
	function identity(stats) { return [stats.dev, stats.ino, stats.uid, stats.gid].map(String).join(":"); }
	function owned(path, expected) { try { const stats = fs.lstatSync(path, { bigint: true }); return stats.isFile() && !stats.isSymbolicLink() && identity(stats) === expected; } catch { return false; } }
	function fingerprint(ctx, first, head, status) { return crypto.createHash("sha256").update(JSON.stringify([ctx.rootIdentity, ctx.gitIdentity, first, head, status.bytes.toString("base64")])).digest("hex"); }
	async function gates(ctx) {
		for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "BISECT_START", "rebase-apply", "rebase-merge", "sequencer"]) {
			try { fs.lstatSync(ctx.cwd + "/.git/" + name); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
			throw fail("GIT_WRITE_UNSUPPORTED");
		}
		for (const name of [".git/info/sparse-checkout"]) { try { fs.lstatSync(ctx.cwd + "/" + name); } catch (error) { if (error.code === "ENOENT") continue; throw error; } throw fail("GIT_WRITE_UNSUPPORTED"); }
		const metadata = fs.opendirSync(ctx.cwd + "/.git");
		try { let entry; while ((entry = metadata.readSync()) !== null) if (entry.name.startsWith("sharedindex.")) throw fail("GIT_WRITE_UNSUPPORTED"); } finally { metadata.closeSync(); }
		const flags = utf8((await port.execute(ctx, ["ls-files", "-v", "-z"], MAX_INDEX)).bytes);
		for (const entry of flags.split("\0")) if (entry && !entry.startsWith("H ")) throw fail("GIT_WRITE_UNSUPPORTED");
		const hooks = ctx.cwd + "/.git/hooks";
		try {
			const directory = fs.opendirSync(hooks);
			try { let entry, count = 0; while ((entry = directory.readSync()) !== null) { if (++count > 4096) throw fail("RESULT_TOO_LARGE"); const stats = fs.lstatSync(hooks + "/" + entry.name); if (!entry.name.endsWith(".sample") && (!stats.isFile() || (stats.mode & 73) !== 0)) throw fail("GIT_WRITE_UNSUPPORTED"); } } finally { directory.closeSync(); }
		} catch (error) { if (error.code !== "ENOENT") throw error; }
		const result = await port.execute(ctx, ["config", "--null", "--get-regexp", CONFIG], 65536, [1]);
		const raw = utf8(result.bytes), config = [];
		for (const field of raw.split("\0")) {
			if (!field) continue;
			const at = field.indexOf("\n"), key = field.slice(0, at).toLowerCase(), value = field.slice(at + 1);
			if (at < 1 || /^(?:core\.(?:hookspath|attributesfile|excludesfile))$/.test(key)) throw fail("GIT_WRITE_UNSUPPORTED");
			if (key === "commit.gpgsign") { if (!/^(?:false|no|off|0)$/i.test(value)) throw fail("GIT_WRITE_UNSUPPORTED"); continue; }
			if (!/^[a-z0-9 .+-]{0,64}$/i.test(value)) throw fail("GIT_WRITE_UNSUPPORTED");
			const dot = key.indexOf("."); config.push("[" + key.slice(0, dot) + "]\n" + key.slice(dot + 1) + " = " + JSON.stringify(value) + "\n");
		}
		return { raw: raw, config: config.join("") };
	}
	async function entries(ctx) {
		const bytes = (await port.execute(ctx, ["ls-files", "--stage", "-z"], MAX_INDEX)).bytes;
		const value = utf8(bytes), result = new Map();
		for (const field of value.split("\0")) {
			if (!field) continue;
			const parsed = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t(.+)$/.exec(field);
			if (!parsed || parsed[3] !== "0") throw fail("GIT_WRITE_UNSUPPORTED");
			result.set(port.relative(parsed[4]), field);
		}
		return result;
	}
	function worktree(ctx, paths) {
		const result = [];
		for (const name of paths) {
			const bytes = optional(ctx.cwd, name, MAX_TEXT);
			if (bytes !== null) port.text(bytes);
			let meta = null;
			if (bytes !== null) meta = port.metadata(fs.lstatSync(ctx.cwd + "/" + name, { bigint: true }));
			result.push([name, bytes === null ? null : bytes.toString("base64"), meta]);
		}
		return JSON.stringify(result);
	}
	function attributes(ctx, target) {
		const parts = target.split("/"); if (parts.length > 32) throw fail("RESULT_TOO_LARGE");
		const names = [".git/info/attributes", ".gitattributes"]; let prefix = "";
		for (const part of parts.slice(0, -1)) { prefix += part + "/"; names.push(prefix + ".gitattributes"); }
		let total = 0;
		return JSON.stringify(names.map(function (name) { const value = optional(ctx.cwd, name, MAX_TEXT); total += value === null ? 0 : value.length; if (total > 1048576) throw fail("RESULT_TOO_LARGE"); return [name, value === null ? null : value.toString("base64")]; }));
	}
	/* Wait for killed native processes before touching their scratch; an unreaped writer leaves its lock for inspection. */
	async function reaped(ctx) {
		if (ctx.children.size === 0) return true;
		let timer;
		try { return await Promise.race([Promise.all(Array.from(ctx.children, function (child) { return new Promise(function (resolve) { child.once("close", resolve); }); })).then(function () { return true; }), new Promise(function (resolve) { timer = setTimeout(function () { resolve(false); }, 1000); })]); } finally { clearTimeout(timer); }
	}
	async function run(ctx, params, first, firstHead) {
		const configured = await gates(ctx);
		const gitFd = fs.openSync(ctx.cwd + "/.git", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		const base = "/proc/" + process.pid + "/fd/" + gitFd;
		let lockFd = null, lockIdentity = null, scratch = null, scratchIdentity = null, published = false, safeCleanup = true;
		const files = new Map(), directories = [];
		function put(name, bytes) { const file = scratch + "/" + name; const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); try { fs.writeFileSync(fd, bytes); files.set(name, identity(fs.fstatSync(fd, { bigint: true }))); } finally { fs.closeSync(fd); } }
		function directory(name) { fs.mkdirSync(scratch + "/" + name, { mode: 448 }); directories.push(name); }
		function held() { if (lockFd === null || !owned(base + "/index.lock", lockIdentity) || identity(fs.fstatSync(lockFd, { bigint: true })) !== lockIdentity) throw fail("GIT_RESOURCE_CHANGED"); }
		try {
			if ([fs.fstatSync(gitFd, { bigint: true }).dev, fs.fstatSync(gitFd, { bigint: true }).ino].map(String).join(":") !== ctx.gitIdentity) throw fail("GIT_RESOURCE_CHANGED");
			try { lockFd = fs.openSync(base + "/index.lock", fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); } catch (error) { if (error.code === "EEXIST") throw fail("GIT_INDEX_LOCKED"); throw error; }
			const lockStats = fs.fstatSync(lockFd, { bigint: true }); lockIdentity = identity(lockStats);
			const source = optional(base, "index", MAX_INDEX), sourceStats = source === null ? null : fs.lstatSync(base + "/index", { bigint: true });
			if (sourceStats !== null && (sourceStats.uid !== lockStats.uid || sourceStats.gid !== lockStats.gid || (sourceStats.mode & 3584n) !== 0n)) throw fail("GIT_WRITE_UNSUPPORTED");
			if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			scratch = base + "/pideck-index-" + crypto.randomBytes(16).toString("hex"); fs.mkdirSync(scratch, { mode: 448 }); scratchIdentity = identity(fs.lstatSync(scratch, { bigint: true }));
			directory("refs"); directory("objects"); directory("info"); directory("hooks");
			put("HEAD", firstHead.head === null ? "ref: refs/heads/pideck-shadow\n" : firstHead.head + "\n");
			put("config", configured.config + "[core]\nbare = false\nfsmonitor = false\nuntrackedCache = false\n");
			const attrs = attributes(ctx, params.path);
			if (source !== null) put("index", source);
			const info = optional(ctx.cwd, ".git/info/attributes", MAX_TEXT); if (info !== null) put("info/attributes", info);
			/* A private metadata context freezes safe configuration and has no executable hooks/filter definitions.
			Effective real hooks/config are refused before AND after; no existing gate is bypassed to publish. */
			const env = Object.assign({}, ctx.env, { GIT_DIR: scratch, GIT_INDEX_FILE: scratch + "/index", GIT_WORK_TREE: ctx.cwd, GIT_OBJECT_DIRECTORY: base + "/objects", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
			const shadow = Object.assign({}, ctx, { env: env });
			const status = await port.rawStatus(shadow);
			if (fingerprint(ctx, first, firstHead, status) !== params.expectedRevision) throw fail("GIT_RESOURCE_CHANGED");
			if (status.resources.some(function (entry) { return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(entry.xy); })) throw fail("GIT_WRITE_UNSUPPORTED");
			const resource = status.resources.find(function (entry) { return entry.path === params.path && port.belongs(entry, params.group); });
			if (!resource) throw fail("GIT_RESOURCE_CHANGED");
			const paths = [resource.path]; if ((params.method === "git.unstage" || /[RC]/.test(resource.xy[1])) && resource.oldPath && !paths.includes(resource.oldPath)) paths.push(resource.oldPath);
			const before = await entries(shadow), tree = worktree(ctx, paths);
			for (const name of paths) if (before.has(name) && !/^100(?:644|755) /.test(before.get(name))) throw fail("GIT_WRITE_UNSUPPORTED");
			const args = params.method === "git.stage" ? ["add", "--"].concat(paths) : firstHead.head === null ? ["rm", "--cached", "--ignore-unmatch", "--"].concat(paths) : ["reset", "-q", firstHead.head, "--"].concat(paths);
			await port.execute(shadow, args, 65536);
			const after = await entries(shadow);
			for (const name of new Set(Array.from(before.keys()).concat(Array.from(after.keys())))) {
				if (!paths.includes(name) && before.get(name) !== after.get(name)) throw fail("GIT_RESOURCE_CHANGED");
				if (paths.includes(name) && after.has(name) && !/^100(?:644|755) /.test(after.get(name))) throw fail("GIT_WRITE_UNSUPPORTED");
				if (paths.includes(name) && after.has(name)) port.text((await port.execute(shadow, ["show", "--no-ext-diff", "--no-textconv", ":" + name], MAX_TEXT)).bytes);
			}
			if (!paths.some(function (name) { return before.get(name) !== after.get(name); }) && !(params.method === "git.stage" && resource.xy === " A")) throw fail("GIT_RESOURCE_CHANGED");
			const updated = port.readFile(scratch, "index", MAX_INDEX); files.set("index", identity(fs.lstatSync(scratch + "/index", { bigint: true })));
			if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			await port.validateConfiguration(ctx);
			const finalConfig = await gates(ctx), finalHead = await port.head(ctx);
			if (finalConfig.raw !== configured.raw || port.snapshot(ctx) !== first || JSON.stringify(finalHead) !== JSON.stringify(firstHead) || worktree(ctx, paths) !== tree || attributes(ctx, params.path) !== attrs) throw fail("GIT_RESOURCE_CHANGED");
			held(); ctx.check();
			if (fs.fstatSync(lockFd, { bigint: true }).size !== 0n) throw fail("GIT_RESOURCE_CHANGED");
			let offset = 0; while (offset < updated.length) { const count = fs.writeSync(lockFd, updated, offset, updated.length - offset, offset); if (!count) throw fail("IO_ERROR"); offset += count; }
			fs.fchmodSync(lockFd, sourceStats === null ? 384 : Number(sourceStats.mode & 511n)); fs.fsyncSync(lockFd);
			held(); if (!port.readFile(base, "index.lock", MAX_INDEX).equals(updated) || port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			ctx.check(); fs.renameSync(base + "/index.lock", base + "/index"); published = true; fs.fsyncSync(gitFd);
			if (!owned(base + "/index", lockIdentity) || !port.readFile(base, "index", MAX_INDEX).equals(updated)) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			ctx.check(); return { applied: true };
		} catch (error) { if (published) throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); throw error; }
		finally {
			safeCleanup = await reaped(ctx);
			if (safeCleanup && scratch !== null) {
				try {
					const stats = fs.lstatSync(scratch, { bigint: true });
					if (stats.isDirectory() && !stats.isSymbolicLink() && identity(stats) === scratchIdentity) {
						for (const pair of files) if (owned(scratch + "/" + pair[0], pair[1])) fs.unlinkSync(scratch + "/" + pair[0]);
						for (const name of directories.reverse()) { try { fs.rmdirSync(scratch + "/" + name); } catch {} }
						try { fs.rmdirSync(scratch); } catch {}
					}
				} catch { /* Unknown or externally replaced artifacts are retained, never recursively removed. */ }
			}
			if (safeCleanup && lockFd !== null && !published && owned(base + "/index.lock", lockIdentity)) { try { fs.unlinkSync(base + "/index.lock"); } catch {} }
			if (lockFd !== null) fs.closeSync(lockFd); fs.closeSync(gitFd);
		}
	}
	return { run: run, fingerprint: fingerprint, gates: gates, entries: entries, reaped: reaped };
}
/* Managed commit: the tree comes from the verified index, the ref move is a native compare-and-swap.
Errors before the CAS publish nothing; after the CAS the ref is the only thing that moved, so a failure
there is reported as an unconfirmed result instead of a refusal that pretends nothing happened.
Identity comes from the repository's own config chain (read-only); PiDeck never writes Git config. */
function createGitCommitProgram(fs, port, shared, identityOf) {
	const fail = port.failure, MAX_INDEX = 16777216, MAX_TEXT = 262144, ZERO = "0".repeat(40), HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
	function utf8(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	function optional(base, name, limit) { try { return port.readFile(base, name, limit); } catch (error) { if (error.message === "PATH_NOT_FOUND") return null; throw error; } }
	function identity(stats) { return [stats.dev, stats.ino, stats.uid, stats.gid].map(String).join(":"); }
	function owned(path, expected) { try { const stats = fs.lstatSync(path, { bigint: true }); return stats.isFile() && !stats.isSymbolicLink() && identity(stats) === expected; } catch { return false; } }
	function reflogLine(message) { return "commit: " + message.split("\n")[0].replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80); }
	/* One run: gates, verified index copy, write-tree, commit-tree, ref CAS, read-back. */
	async function run(ctx, params, first, firstHead) {
		const message = params.message;
		if (typeof message !== "string" || message.length === 0 || message.trim().length === 0 || message.indexOf("\u0000") >= 0 || Buffer.byteLength(message, "utf8") > 4096) throw fail("GIT_COMMIT_MESSAGE_EMPTY");
		const configured = await shared.gates(ctx);
		const gitFd = fs.openSync(ctx.cwd + "/.git", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		const base = "/proc/" + process.pid + "/fd/" + gitFd;
		let lockFd = null, lockIdentity = null, scratch = null, scratchIdentity = null, moved = false, safeCleanup = true;
		const files = new Map(), directories = [];
		function put(name, bytes) { const file = scratch + "/" + name; const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); try { fs.writeFileSync(fd, bytes); files.set(name, identity(fs.fstatSync(fd, { bigint: true }))); } finally { fs.closeSync(fd); } }
		function directory(name) { fs.mkdirSync(scratch + "/" + name, { mode: 448 }); directories.push(name); }
		function held() { if (lockFd === null || !owned(base + "/index.lock", lockIdentity) || identity(fs.fstatSync(lockFd, { bigint: true })) !== lockIdentity) throw fail("GIT_RESOURCE_CHANGED"); }
		try {
			if ([fs.fstatSync(gitFd, { bigint: true }).dev, fs.fstatSync(gitFd, { bigint: true }).ino].map(String).join(":") !== ctx.gitIdentity) throw fail("GIT_RESOURCE_CHANGED");
			try { lockFd = fs.openSync(base + "/index.lock", fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); } catch (error) { if (error.code === "EEXIST") throw fail("GIT_INDEX_LOCKED"); throw error; }
			const lockStats = fs.fstatSync(lockFd, { bigint: true }); lockIdentity = identity(lockStats);
			/* The index is only read here: the commit publishes no index bytes, because the index the user confirmed
			already describes the tree that is about to become HEAD. */
			const source = optional(base, "index", MAX_INDEX), sourceStats = source === null ? null : fs.lstatSync(base + "/index", { bigint: true });
			if (sourceStats !== null && (sourceStats.uid !== lockStats.uid || sourceStats.gid !== lockStats.gid || (sourceStats.mode & 3584n) !== 0n)) throw fail("GIT_WRITE_UNSUPPORTED");
			if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			scratch = base + "/pideck-index-" + port.crypto.randomBytes(16).toString("hex"); fs.mkdirSync(scratch, { mode: 448 }); scratchIdentity = identity(fs.lstatSync(scratch, { bigint: true }));
			directory("refs"); directory("objects"); directory("info"); directory("hooks");
			put("HEAD", firstHead.head === null ? "ref: refs/heads/pideck-shadow\n" : firstHead.head + "\n");
			put("config", configured.config + "[core]\nbare = false\nfsmonitor = false\nuntrackedCache = false\n");
			if (source !== null) put("index", source);
			const attributes = optional(ctx.cwd, ".git/info/attributes", MAX_TEXT); if (attributes !== null) put("info/attributes", attributes);
			put("message", Buffer.from(message, "utf8"));
			const env = Object.assign({}, ctx.env, { GIT_DIR: scratch, GIT_INDEX_FILE: scratch + "/index", GIT_WORK_TREE: ctx.cwd, GIT_OBJECT_DIRECTORY: base + "/objects", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
			const shadow = Object.assign({}, ctx, { env: env });
			const status = await port.rawStatus(shadow);
			if (shared.fingerprint(ctx, first, firstHead, status) !== params.expectedRevision) throw fail("GIT_RESOURCE_CHANGED");
			if (status.resources.some(function (entry) { return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(entry.xy); })) throw fail("GIT_WRITE_UNSUPPORTED");
			const before = await shared.entries(shadow);
			if (firstHead.head === null && before.size === 0) throw fail("GIT_COMMIT_NOTHING_STAGED");
			const tree = utf8((await port.execute(shadow, ["write-tree"], 256)).bytes).trim();
			if (!HASH.test(tree)) throw fail("GIT_RESULT_INVALID");
			/* write-tree records its cache tree in the index, so the owned copy is a new inode now. The scratch
			directory is 0700 with a random name only this run knows; re-recording is what lets cleanup remove
			that file instead of retaining the whole directory. */
			files.set("index", identity(fs.lstatSync(scratch + "/index", { bigint: true })));
			if (firstHead.head !== null) {
				const headTree = utf8((await port.execute(shadow, ["rev-parse", firstHead.head + "^{tree}"], 256)).bytes).trim();
				if (!HASH.test(headTree)) throw fail("GIT_RESULT_INVALID");
				if (headTree === tree) throw fail("GIT_COMMIT_NOTHING_STAGED");
			}
			const target = firstHead.branch === null ? "HEAD" : "refs/heads/" + firstHead.branch;
			if (firstHead.branch !== null && (await port.execute(shadow, ["check-ref-format", target], 256, [1])).exitCode !== 0) throw fail("GIT_RESULT_INVALID");
			/* Identity is only needed once there is something to commit: a missing identity never masks "nothing staged". */
			const person = await identityOf(ctx);
			const commitEnv = Object.assign({}, env, { GIT_AUTHOR_NAME: person.name, GIT_AUTHOR_EMAIL: person.email, GIT_COMMITTER_NAME: person.name, GIT_COMMITTER_EMAIL: person.email });
			const commitCtx = Object.assign({}, ctx, { env: commitEnv });
			const args = firstHead.head === null ? ["commit-tree", tree, "-F", scratch + "/message"] : ["commit-tree", tree, "-p", firstHead.head, "-F", scratch + "/message"];
			const head = utf8((await port.execute(commitCtx, args, 256)).bytes).trim();
			if (!HASH.test(head)) throw fail("GIT_RESULT_INVALID");
			/* The commit we just created must be a child of exactly the HEAD the user confirmed. */
			const line = utf8((await port.execute(shadow, ["rev-list", "--parents", "-n", "1", head], 256)).bytes).trim().split(" ");
			const parents = firstHead.head === null ? [head] : [head, firstHead.head];
			if (line.length !== parents.length || line[0] !== head || (firstHead.head !== null && line[1] !== firstHead.head)) throw fail("GIT_RESULT_INVALID");
			/* Native compare-and-swap on the real ref: only a ref that still equals the confirmed value moves. */
			try { await port.execute(ctx, ["update-ref", "-m", reflogLine(message), target, head, firstHead.head === null ? ZERO : firstHead.head], 65536); }
			catch (error) {
				/* A killed process may have moved the ref anyway: read the real ref instead of guessing. */
				const now = await port.head(ctx);
				if (now.head === head) { moved = true; throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); }
				if (error.message !== "GIT_COMMAND_FAILED") throw error;
				throw fail(now.head === firstHead.head && now.branch === firstHead.branch ? "GIT_WRITE_UNSUPPORTED" : "GIT_COMMIT_HEAD_CHANGED");
			}
			moved = true;
			const finalHead = await port.head(ctx);
			if (finalHead.head !== head || finalHead.branch !== firstHead.branch) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			ctx.check();
			return { applied: true, head: head, tree: tree };
		} catch (error) { if (moved) throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); throw error; }
		finally {
			safeCleanup = await shared.reaped(ctx);
			if (safeCleanup && scratch !== null) {
				try {
					const stats = fs.lstatSync(scratch, { bigint: true });
					if (stats.isDirectory() && !stats.isSymbolicLink() && identity(stats) === scratchIdentity) {
						for (const pair of files) if (owned(scratch + "/" + pair[0], pair[1])) fs.unlinkSync(scratch + "/" + pair[0]);
						for (const name of directories.reverse()) { try { fs.rmdirSync(scratch + "/" + name); } catch {} }
						try { fs.rmdirSync(scratch); } catch {}
					}
				} catch { /* Unknown or externally replaced artifacts are retained, never recursively removed. */ }
			}
			/* Unlike a stage, a successful commit never renames this lock onto the real index: it is simply released. */
			if (safeCleanup && lockFd !== null && owned(base + "/index.lock", lockIdentity)) { try { fs.unlinkSync(base + "/index.lock"); } catch {} }
			if (lockFd !== null) fs.closeSync(lockFd); fs.closeSync(gitFd);
		}
	}
	return { run: run };
}
/* G3b branch write face. Creating a branch is one native compare-and-swap on refs/heads/<name> with a zero
old value, so it can only ever create a branch that does not exist yet and can never move HEAD; a name is
first asked of Git itself (check-ref-format --branch) and then held to this protocol's own rules, because
that command accepts "@" on its own. Switching runs native git switch and nothing else: it refuses a
conflicting worktree instead of forcing it, and a post-checkout hook is a refusal, not something to skip. */
function createGitBranchProgram(fs, port, gates) {
	const fail = port.failure, HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
	function utf8(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	function validName(value) {
		if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 1024 || /[\u0000-\u001f\u007f\\]/.test(value) || value === "@" || value.indexOf("@{") >= 0) throw fail("GIT_RESULT_INVALID");
		return value;
	}
	/* A branch name must be accepted by Git and must not read as a full ref, an object id or a revision. */
	async function checked(ctx, value) {
		/* Measured: git answers 1 or 128 for a name it refuses (for example 128 for a leading dash), and any of
		those means the same thing to us - an invalid name, refused before any ref exists. */
		const result = await port.execute(ctx, ["check-ref-format", "--branch", value], 1024, [1, 128]);
		if (result.exitCode !== 0) throw fail("GIT_RESULT_INVALID");
		if (/^(?:HEAD|FETCH_HEAD|ORIG_HEAD)$/.test(value) || value.indexOf("refs/") === 0 || HASH.test(value)) throw fail("GIT_RESULT_INVALID");
		return value;
	}
	async function branchHead(ctx, target) {
		const probe = await port.execute(ctx, ["rev-parse", "--verify", "--quiet", target], 256, [1, 128]);
		if (probe.exitCode !== 0) return null;
		const oid = utf8(probe.bytes).trim();
		if (!HASH.test(oid)) throw fail("GIT_RESULT_INVALID");
		return oid;
	}
	async function run(ctx, params, first, firstHead) {
		const name = await checked(ctx, validName(params.name));
		if (params.expectedHead !== null && !HASH.test(String(params.expectedHead))) throw fail("GIT_RESULT_INVALID");
		const expected = params.expectedHead;
		/* A caller that confirmed nothing has confirmed an unborn repository: that is only true when there is
		really no HEAD, and it is never a state a switch can start from. */
		if (expected === null && params.method === "git.createBranch") throw fail("GIT_COMMIT_HEAD_CHANGED");
		if (params.method === "git.createBranch") {
			if (expected !== null && firstHead.head !== expected) throw fail("GIT_COMMIT_HEAD_CHANGED");
			const target = "refs/heads/" + name;
			if (await branchHead(ctx, target)) throw fail("GIT_REF_EXISTS");
			const configured = await gates(ctx);
			if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			/* Zero old value: create-only, so a branch that appeared meanwhile is refused by Git itself. */
			try { await port.execute(ctx, ["update-ref", "-m", "branch: created " + name, target, expected, "0".repeat(40)], 65536); }
			catch (error) {
				const now = await branchHead(ctx, target);
				if (now === expected) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
				if (now !== null) throw fail("GIT_REF_EXISTS");
				const after = await port.head(ctx);
				if (after.head !== firstHead.head || after.branch !== firstHead.branch) throw fail("GIT_COMMIT_HEAD_CHANGED");
				throw error.message === "GIT_COMMAND_FAILED" ? fail("GIT_WRITE_UNSUPPORTED") : error;
			}
			if ((await branchHead(ctx, target)) !== expected) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			const finalHead = await port.head(ctx);
			if (finalHead.head !== firstHead.head || finalHead.branch !== firstHead.branch) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (JSON.stringify(await gates(ctx)) !== JSON.stringify(configured)) throw fail("GIT_RESOURCE_CHANGED");
			ctx.check();
			return { applied: true, branch: name };
		}
		const target = "refs/heads/" + name;
		const existing = await branchHead(ctx, target);
		if (existing === null) throw fail("GIT_REF_NOT_FOUND");
		/* Existence is answered first: in an unborn repository no branch can exist, and that is the honest reason.
		A caller that confirmed "unborn" (null) while a real HEAD exists is exactly as stale as a wrong oid. */
		if (firstHead.head !== expected) throw fail("GIT_COMMIT_HEAD_CHANGED");
		const current = await port.head(ctx);
		if (current.branch === name) return { applied: true, branch: name, head: existing };
		if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
		/* Effective hooks/config first: a post-checkout hook runs during a real switch, so a repository that
		has one is refused before switch is ever called, never run with hooks silently skipped. */
		await gates(ctx);
		/* Native switch: a conflicting worktree is refused by Git (rc != 0) and nothing is forced. */
		try { await port.execute(ctx, ["switch", "--", name], 65536); }
		catch (error) {
			const after = await port.head(ctx);
			if (after.branch === name && after.head === existing) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (after.branch !== firstHead.branch || after.head !== firstHead.head) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (error.message !== "GIT_COMMAND_FAILED") throw error;
			throw fail("GIT_SWITCH_CONFLICT");
		}
		const after = await port.head(ctx);
		if (after.branch !== name || after.head !== existing) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		/* The working tree is re-read through Git itself: whatever the checkout produced must be the branch's tree. */
		const status = await port.rawStatus(ctx);
		if (status.resources.some(function (entry) { return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(entry.xy); })) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		if ((await port.execute(ctx, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"], 1024, [1])).exitCode !== 0) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		ctx.check();
		return { applied: true, branch: name, head: existing };
	}
	return { run: run };
}`.replace(/\r?\n[\t ]*/g, "");
