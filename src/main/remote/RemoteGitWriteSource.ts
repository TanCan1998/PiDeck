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
	return { run: run, fingerprint: fingerprint };
}`.replace(/\r?\n[\t ]*/g, "");
