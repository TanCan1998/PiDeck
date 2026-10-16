/** Frozen, self-contained Git read program embedded in helper.mjs; no Git engine or runtime dependency is shipped. */
export const REMOTE_GIT_READ_SOURCE = String.raw`function createGitReadProgram(root, fs, path) {
	const cp = process.getBuiltinModule("node:child_process");
	const crypto = process.getBuiltinModule("node:crypto");
	const MAX_STATUS = 1048576, MAX_RESOURCES = 4096, MAX_TEXT = 262144, MAX_STDERR = 65536;
	const MAX_INDEX = 16777216, MAX_METADATA = 20000, MAX_DEPTH = 32, MAX_PATH = 4096;
	const scopes = new Set();
	const stable = new Set(["PATH_OUTSIDE_ROOT", "PATH_NOT_FOUND", "NOT_A_FILE", "PERMISSION_DENIED", "IO_ERROR", "RESULT_TOO_LARGE", "REQUEST_TIMEOUT", "REQUEST_CANCELLED", "REMOTE_CONNECTION_LOST", "GIT_NOT_FOUND", "GIT_VERSION_UNSUPPORTED", "GIT_NOT_REPOSITORY", "GIT_UNSUPPORTED_REPOSITORY", "GIT_PLATFORM_UNSUPPORTED", "GIT_CONFIG_UNSUPPORTED", "GIT_COMMAND_FAILED", "GIT_RESULT_INVALID", "GIT_RESOURCE_CHANGED", "GIT_NOT_TEXT", "GIT_INDEX_LOCKED", "GIT_WRITE_UNSUPPORTED", "GIT_WRITE_RESULT_UNCONFIRMED", "GIT_COMMIT_NOTHING_STAGED", "GIT_COMMIT_MESSAGE_EMPTY", "GIT_COMMIT_IDENTITY_REQUIRED", "GIT_COMMIT_HEAD_CHANGED"]);
	const control = /[\x00-\x1f\x7f]/;
	function failure(code) { return new Error(code); }
	function code(error) {
		if (error && stable.has(error.message)) return error.message;
		if (error && (error.code === "EACCES" || error.code === "EPERM")) return "PERMISSION_DENIED";
		if (error && error.code === "ELOOP") return "GIT_UNSUPPORTED_REPOSITORY";
		return "IO_ERROR";
	}
	function relative(value) {
		if (typeof value !== "string" || !value || Buffer.byteLength(value) > MAX_PATH || control.test(value) || value.startsWith("-") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || /%2e|%2f|%5c/i.test(value) || value.split("/").some(function (part) { return !part || part === "." || part === ".."; })) throw failure("PATH_OUTSIDE_ROOT");
		return value;
	}
	function metadata(stats) { return [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].map(String).join(":"); }
	function kill(child) {
		if (child.pid === undefined) return;
		try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
	}
	function executable() {
		for (const directory of (process.env.PATH || "").split(":")) {
			if (!directory.startsWith("/") || control.test(directory)) continue;
			const candidate = path.join(directory, "git");
			try {
				const resolved = fs.realpathSync(candidate);
				if (root !== null && (resolved === root || resolved.startsWith(root + "/"))) continue;
				if (!fs.statSync(resolved).isFile()) continue;
				fs.accessSync(resolved, fs.constants.X_OK);
				return resolved;
			} catch {}
		}
		throw failure("GIT_NOT_FOUND");
	}
	/* Only the fixed executor controls Git environment overrides; renderer parameters never do. */
	function environment() {
		const env = {};
		for (const key of Object.keys(process.env)) if (!key.startsWith("GIT_") && !["PAGER", "LESS", "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS"].includes(key)) env[key] = process.env[key];
		env.GIT_OPTIONAL_LOCKS = "0"; env.GIT_TERMINAL_PROMPT = "0"; env.GIT_PAGER = "cat"; env.GIT_EXTERNAL_DIFF = "";
		return env;
	}
	function checkedPath(base, value) {
		let current = base;
		const parts = value.split("/");
		for (let i = 0; i < parts.length; i += 1) {
			current += "/" + parts[i];
			let stats;
			try { stats = fs.lstatSync(current); } catch (error) { if (error.code === "ENOENT") throw failure("PATH_NOT_FOUND"); throw error; }
			if (stats.isSymbolicLink()) throw failure("NOT_A_FILE");
			if (i < parts.length - 1 && !stats.isDirectory()) throw failure("NOT_A_FILE");
		}
		return current;
	}
	function readFile(base, value, limit) {
		const absolute = checkedPath(base, value);
		const initial = fs.lstatSync(absolute, { bigint: true });
		if (!initial.isFile()) throw failure("NOT_A_FILE");
		/* NONBLOCK prevents a raced FIFO replacement from blocking the helper event loop before fstat. */
		const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		try {
			const before = fs.fstatSync(fd, { bigint: true });
			if (!before.isFile()) throw failure("NOT_A_FILE");
			if (metadata(initial) !== metadata(before)) throw failure("GIT_RESOURCE_CHANGED");
			if (before.size > BigInt(limit)) throw failure("RESULT_TOO_LARGE");
			const buffer = Buffer.alloc(Number(before.size) + 1);
			let offset = 0;
			while (offset < buffer.length) { const bytes = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (!bytes) break; offset += bytes; }
			if (offset > limit) throw failure("RESULT_TOO_LARGE");
			const after = fs.fstatSync(fd, { bigint: true });
			if (metadata(before) !== metadata(after) || metadata(after) !== metadata(fs.lstatSync(absolute, { bigint: true }))) throw failure("GIT_RESOURCE_CHANGED");
			return buffer.subarray(0, offset);
		} finally { fs.closeSync(fd); }
	}
	function text(buffer) {
		if (buffer.includes(0)) throw failure("GIT_NOT_TEXT");
		try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); } catch { throw failure("GIT_NOT_TEXT"); }
	}
	/* Metadata is walked with a streaming directory cursor, not an unbounded readdir array. */
	async function inspectMetadata(ctx) {
		const queue = [{ absolute: ctx.cwd + "/.git", depth: 0 }];
		let count = 0;
		for (let next = 0; next < queue.length; next += 1) {
			ctx.check();
			const directory = queue[next];
			if (directory.depth > MAX_DEPTH) throw failure("RESULT_TOO_LARGE");
			const handle = fs.opendirSync(directory.absolute);
			try {
				let entry;
				while ((entry = handle.readSync()) !== null) {
					count += 1;
					if (count > MAX_METADATA) throw failure("RESULT_TOO_LARGE");
					const absolute = directory.absolute + "/" + entry.name;
					const stats = fs.lstatSync(absolute);
					if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) || entry.name.endsWith(".promisor")) throw failure("GIT_UNSUPPORTED_REPOSITORY");
					if (stats.isDirectory()) queue.push({ absolute: absolute, depth: directory.depth + 1 });
					if (count % 64 === 0) { await new Promise(function (resolve) { setImmediate(resolve); }); ctx.check(); }
				}
			} finally { handle.closeSync(); }
		}
		for (const forbidden of [".git/commondir", ".git/objects/info/alternates", ".git/objects/info/http-alternates", ".git/shallow", ".gitmodules"]) {
			try { fs.lstatSync(ctx.cwd + "/" + forbidden); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
			throw failure("GIT_UNSUPPORTED_REPOSITORY");
		}
	}
	function snapshot(ctx) {
		ctx.check();
		if (fs.realpathSync(root) !== root || metadata(fs.lstatSync(root, { bigint: true })).split(":").slice(0, 2).join(":") !== ctx.rootIdentity) throw failure("GIT_RESOURCE_CHANGED");
		if (metadata(fs.lstatSync(ctx.cwd + "/.git", { bigint: true })).split(":").slice(0, 2).join(":") !== ctx.gitIdentity) throw failure("GIT_RESOURCE_CHANGED");
		try {
			const stats = fs.lstatSync(ctx.cwd + "/.git/index", { bigint: true });
			const bytes = readFile(ctx.cwd, ".git/index", MAX_INDEX);
			return metadata(stats) + ":" + crypto.createHash("sha256").update(bytes).digest("hex");
		} catch (error) { if (error.message === "PATH_NOT_FOUND" || error.code === "ENOENT") return null; throw error; }
	}
	function execute(ctx, args, limit, allowed) {
		ctx.check();
		const prefix = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "color.ui=false"];
		return new Promise(function (resolve, reject) {
			let child;
			try { child = cp.spawn(ctx.executable, prefix.concat(args), { cwd: ctx.cwd, env: ctx.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }); } catch { reject(failure("GIT_COMMAND_FAILED")); return; }
			ctx.children.add(child);
			let settled = false, bytes = 0, errors = 0;
			const chunks = [];
			function finish(error, result) { if (settled) return; settled = true; ctx.rejectors.delete(abort); if (error) reject(error); else resolve(result); }
			function abort(reason) { kill(child); finish(failure(reason)); }
			ctx.rejectors.add(abort);
			child.stdout.on("data", function (chunk) { bytes += chunk.length; if (bytes > limit) abort("RESULT_TOO_LARGE"); else if (!settled) chunks.push(chunk); });
			child.stderr.on("data", function (chunk) { errors += chunk.length; if (errors > MAX_STDERR) abort("RESULT_TOO_LARGE"); });
			child.once("error", function () { finish(failure("GIT_COMMAND_FAILED")); });
			child.once("close", function (exitCode) { ctx.children.delete(child); if (settled) return; if (exitCode !== 0 && !(allowed || []).includes(exitCode)) finish(failure("GIT_COMMAND_FAILED")); else finish(null, { bytes: Buffer.concat(chunks, bytes), exitCode: exitCode }); });
		});
	}
	/* Porcelain v1 -z is parsed only enough to validate paths and select the requested SCM group. */
	function resources(buffer) {
		let raw;
		try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); } catch { throw failure("GIT_RESULT_INVALID"); }
		if (raw && !raw.endsWith("\0")) throw failure("GIT_RESULT_INVALID");
		const fields = raw ? raw.slice(0, -1).split("\0") : [];
		const result = [];
		for (let i = 0; i < fields.length; i += 1) {
			const line = fields[i];
			if (line.length < 4 || line[2] !== " " || !/^[ MADRCUT?!]{2}$/.test(line.slice(0, 2))) throw failure("GIT_RESULT_INVALID");
			const xy = line.slice(0, 2), value = relative(line.slice(3));
			const oldPath = /[RC]/.test(xy) ? relative(fields[++i]) : null;
			result.push({ xy: xy, path: value, oldPath: oldPath });
			if (result.length > MAX_RESOURCES) throw failure("RESULT_TOO_LARGE");
		}
		return result;
	}
	async function head(ctx) {
		const commit = await execute(ctx, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], 256, [1]);
		const oid = commit.exitCode === 1 ? null : text(commit.bytes).trim();
		if (oid !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw failure("GIT_RESULT_INVALID");
		const ref = await execute(ctx, ["symbolic-ref", "--quiet", "--short", "HEAD"], MAX_PATH, [1]);
		const branch = ref.exitCode === 1 ? null : text(ref.bytes).trim();
		if (branch !== null && (!branch || control.test(branch))) throw failure("GIT_RESULT_INVALID");
		return { head: oid, branch: branch };
	}
	async function rawStatus(ctx) {
		const result = await execute(ctx, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], MAX_STATUS);
		return { bytes: result.bytes, resources: resources(result.bytes) };
	}
	async function validateConfiguration(ctx) {
		const version = text((await execute(ctx, ["--version"], 1024)).bytes);
		const parsed = /\bgit version (\d+)\.(\d+)\./.exec(version);
		if (!parsed || Number(parsed[1]) < 2 || (Number(parsed[1]) === 2 && Number(parsed[2]) < 16)) throw failure("GIT_VERSION_UNSUPPORTED");
		const config = await execute(ctx, ["config", "--null", "--get-regexp", "^(filter\\.|core\\.(worktree|bare|splitindex|sparsecheckout)|index\\.sparse|extensions\\.(worktreeconfig|partialclone)|remote\\..*\\.(promisor|partialclonefilter))"], MAX_STDERR, [1]);
		if (config.exitCode === 0) {
			let fields;
			try { fields = new TextDecoder("utf-8", { fatal: true }).decode(config.bytes).split("\0"); } catch { throw failure("GIT_RESULT_INVALID"); }
			for (const field of fields) if (/^filter\.|^core\.(worktree|splitindex|sparsecheckout)\n|^index\.sparse\n|^extensions\.|^remote\./i.test(field)) throw failure("GIT_CONFIG_UNSUPPORTED");
			if (/core\.bare\ntrue(?:\0|$)/i.test(config.bytes.toString("utf8"))) throw failure("GIT_UNSUPPORTED_REPOSITORY");
		}
		const staged = await execute(ctx, ["ls-files", "--stage", "-z"], MAX_INDEX);
		if (/(?:^|\0)160000 /.test(staged.bytes.toString("utf8"))) throw failure("GIT_UNSUPPORTED_REPOSITORY");
	}
	function belongs(resource, group) {
		const conflict = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(resource.xy);
		if (group === "merge") return conflict;
		if (conflict) return false;
		if (group === "untracked") return resource.xy === "??";
		if (group === "index") return ![" ", "?", "!"].includes(resource.xy[0]);
		return resource.xy === "??" || ![" ", "?", "!"].includes(resource.xy[1]);
	}
	async function blob(ctx, ref) { return text((await execute(ctx, ["show", "--no-ext-diff", "--no-textconv", ref], MAX_TEXT)).bytes); }
	async function readDiff(ctx, params, status, initialHead) {
		const resource = status.resources.find(function (entry) { return entry.path === params.path && belongs(entry, params.group); });
		if (!resource) throw failure("GIT_RESOURCE_CHANGED");
		const xy = resource.xy, current = resource.path, old = resource.oldPath || current;
		let originalContent, modifiedContent;
		if (xy === "??") { originalContent = ""; modifiedContent = text(readFile(ctx.cwd, current, MAX_TEXT)); }
		else if (params.group === "index") {
			originalContent = xy[0] === "A" ? "" : await blob(ctx, initialHead.head + ":" + old);
			modifiedContent = xy[0] === "D" ? "" : await blob(ctx, ":" + current);
		} else if (params.group === "workingTree") {
			originalContent = xy === " A" ? "" : await blob(ctx, ":" + (xy[1] === "R" || xy[1] === "C" ? old : current));
			modifiedContent = xy[1] === "D" ? "" : text(readFile(ctx.cwd, current, MAX_TEXT));
		} else {
			originalContent = ["UA", "DU", "DD"].includes(xy) || initialHead.head === null ? "" : await blob(ctx, initialHead.head + ":" + current);
			modifiedContent = xy === "DD" ? "" : text(readFile(ctx.cwd, current, MAX_TEXT));
		}
		const finalStatus = await rawStatus(ctx);
		if (!finalStatus.bytes.equals(status.bytes)) throw failure("GIT_RESOURCE_CHANGED");
		/* Worktree can change without a different XY flag: compare bytes, not only status. */
		const readsWorktree = xy === "??" || (params.group === "workingTree" && xy[1] !== "D") || (params.group === "merge" && xy !== "DD");
		if (readsWorktree && text(readFile(ctx.cwd, current, MAX_TEXT)) !== modifiedContent) throw failure("GIT_RESOURCE_CHANGED");
		return { originalContent: originalContent, modifiedContent: modifiedContent };
	}
	const writer = createGitWriteProgram(fs, { crypto: crypto, failure: failure, relative: relative, metadata: metadata, readFile: readFile, text: text, execute: execute, rawStatus: rawStatus, snapshot: snapshot, head: head, belongs: belongs, validateConfiguration: validateConfiguration });
	/* Commit identity is read from the repository's own config chain (local wins over global) and never written. */
	async function configValue(ctx, key) {
		const result = await execute(ctx, ["config", "--get", key], 1024, [1]);
		if (result.exitCode !== 0) return null;
		const raw = text(result.bytes);
		return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	}
	async function commitIdentity(ctx) {
		const name = await configValue(ctx, "user.name"), email = await configValue(ctx, "user.email");
		for (const value of [name, email]) if (value === null || value.length === 0 || value.length > 320 || control.test(value) || value.indexOf("<") >= 0 || value.indexOf(">") >= 0) throw failure("GIT_COMMIT_IDENTITY_REQUIRED");
		return { name: name, email: email };
	}
	const committer = createGitCommitProgram(fs, { crypto: crypto, failure: failure, text: text, readFile: readFile, execute: execute, rawStatus: rawStatus, snapshot: snapshot, head: head }, { gates: writer.gates, entries: writer.entries, reaped: writer.reaped, fingerprint: writer.fingerprint }, commitIdentity);
	async function run(ctx, params) {
		ctx.check();
		if (process.platform !== "linux") throw failure("GIT_PLATFORM_UNSUPPORTED");
		if (root === null) throw failure("PATH_OUTSIDE_ROOT");
		const rootStats = fs.lstatSync(root, { bigint: true });
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || fs.realpathSync(root) !== root) throw failure("GIT_RESOURCE_CHANGED");
		ctx.fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		ctx.cwd = "/proc/" + process.pid + "/fd/" + ctx.fd;
		ctx.rootIdentity = [rootStats.dev, rootStats.ino].map(String).join(":");
		const openedRoot = fs.fstatSync(ctx.fd, { bigint: true });
		if ([openedRoot.dev, openedRoot.ino].map(String).join(":") !== ctx.rootIdentity) throw failure("GIT_RESOURCE_CHANGED");
		let gitStats;
		try { gitStats = fs.lstatSync(ctx.cwd + "/.git", { bigint: true }); } catch (error) { if (error.code === "ENOENT") throw failure("GIT_NOT_REPOSITORY"); throw error; }
		if (!gitStats.isDirectory() || gitStats.isSymbolicLink()) throw failure("GIT_UNSUPPORTED_REPOSITORY");
		ctx.gitIdentity = [gitStats.dev, gitStats.ino].map(String).join(":");
		await inspectMetadata(ctx);
		ctx.executable = executable(); ctx.env = environment();
		await validateConfiguration(ctx);
		const first = snapshot(ctx), firstHead = await head(ctx);
		if (params.method === "git.commit") return committer.run(ctx, params, first, firstHead);
		if (params.method === "git.stage" || params.method === "git.unstage") return writer.run(ctx, params, first, firstHead);
		const status = await rawStatus(ctx);
		const result = params.method === "git.status" ? { status: status.bytes.toString("base64"), head: firstHead.head, branch: firstHead.branch, revision: writer.fingerprint(ctx, first, firstHead, status) } : await readDiff(ctx, params, status, firstHead);
		const finalHead = await head(ctx);
		if (snapshot(ctx) !== first || finalHead.head !== firstHead.head || finalHead.branch !== firstHead.branch) throw failure("GIT_RESOURCE_CHANGED");
		ctx.check();
		return result;
	}
	function prepare(method, params) {
		if (root === null) throw failure("PATH_OUTSIDE_ROOT");
		if (params === undefined) params = {};
		if (params === null || typeof params !== "object" || Array.isArray(params)) throw failure("GIT_RESULT_INVALID");
		const keys = Object.keys(params);
		if (method === "git.status") { if (keys.length) throw failure("GIT_RESULT_INVALID"); return { method: method }; }
		if (method === "git.commit") {
			if (keys.length !== 2 || !keys.includes("message") || !keys.includes("expectedRevision") || typeof params.message !== "string" || params.message.indexOf("\u0000") >= 0 || Buffer.byteLength(params.message, "utf8") > 4096 || typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision)) throw failure("GIT_RESULT_INVALID");
			return { method: method, message: params.message, expectedRevision: params.expectedRevision };
		}
		if (method === "git.stage" || method === "git.unstage") {
			if (keys.length !== 3 || !keys.includes("path") || !keys.includes("group") || !keys.includes("expectedRevision") || typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision) || !(method === "git.unstage" ? params.group === "index" : ["workingTree", "untracked"].includes(params.group))) throw failure("GIT_RESULT_INVALID");
			return { method: method, path: relative(params.path), group: params.group, expectedRevision: params.expectedRevision };
		}
		if (keys.length !== 2 || !keys.includes("path") || !keys.includes("group") || !["merge", "index", "workingTree", "untracked"].includes(params.group)) throw failure("GIT_RESULT_INVALID");
		return { method: method, path: relative(params.path), group: params.group };
	}
	function start(params, deadline, done) {
		const ctx = { children: new Set(), rejectors: new Set(), fd: null, stopped: null };
		ctx.check = function () { if (ctx.stopped !== null) throw failure(ctx.stopped); if (Date.now() >= deadline) throw failure("REQUEST_TIMEOUT"); };
		ctx.abort = function (reason) { if (ctx.stopped !== null) return; ctx.stopped = reason; for (const reject of Array.from(ctx.rejectors)) reject(reason); for (const child of ctx.children) kill(child); };
		scopes.add(ctx);
		const timer = setTimeout(function () { ctx.abort("REQUEST_TIMEOUT"); }, Math.max(1, deadline - Date.now()));
		Promise.resolve().then(function () { return run(ctx, params); }).then(function (result) { done(null, result); }, function (error) { done(code(error)); }).finally(function () {
			clearTimeout(timer); for (const child of ctx.children) kill(child); if (ctx.fd !== null) { try { fs.closeSync(ctx.fd); } catch {} } scopes.delete(ctx);
		}).catch(function () { /* A transport shutdown cannot receive another terminal outcome. */ });
		return function () { ctx.abort("REQUEST_CANCELLED"); };
	}
	return { prepare: prepare, start: start, close: function () { for (const ctx of scopes) ctx.abort("REMOTE_CONNECTION_LOST"); } };
}`.replace(/\r?\n[\t ]*/g, "");
