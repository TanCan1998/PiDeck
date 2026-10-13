import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteSessionHistoryWriter, buildRemoteSessionHistoryChunkWriteCommand } = loadTsCommonJs("src/main/remote/RemoteSessionHistoryWriter.ts");
const execute = promisify(execFile);
const HOST = "11111111-1111-4111-8111-111111111111";
const CHANGED = "REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED";
const { buildRemoteSessionWriteGuardCommand, parseRemoteSessionWriteGuardResult } = loadTsCommonJs("src/main/remote/RemoteSessionWriteGuard.ts");
const POSIX = process.platform !== "win32";

for (const identity of ["uid", "gid"]) {
	test(`temporary ${identity} mismatch is refused before changing mode or source`, { skip: !POSIX }, async (t) => {
		const fixture = await harness(t);
		const common = { nodePath: process.execPath, remotePath: fixture.path, nonce: "abc123def456", maxBytes: 256 * 1024 };
		const snapshot = buildRemoteSessionWriteGuardCommand({ ...common, operation: "snapshot" });
		const marker = snapshot.match(/'snapshot' '([^']+)'/)[1];
		const source = parseRemoteSessionWriteGuardResult((await execute("/bin/sh", ["-c", snapshot])).stdout, marker);
		const temporaryPath = join(fixture.directory, ".probe.abc123def456.pideck-tmp");
		const content = document();
		await writeFile(temporaryPath, content, { mode: 0o600 });
		// 构造归属不一致的反例：必须在 chmod/rename 前拒绝，不能悄悄换成当前默认组。
		const command = buildRemoteSessionWriteGuardCommand({ ...common, operation: "commit", temporaryPath, source: { ...source, [identity]: source[identity] === "0" ? "1" : "0" }, nextDigest: createHash("sha256").update(content).digest("hex"), nextSize: Buffer.byteLength(content) });
		const result = await execute("/bin/sh", ["-c", command]);
		assert.throws(
			() => parseRemoteSessionWriteGuardResult(result.stdout, marker),
			(error) => error.message === "REMOTE_SESSION_HISTORY_WRITER_COMMAND_FAILED",
		);
		assert.equal(await readFile(fixture.path, "utf8"), content);
		assert.equal((await stat(temporaryPath)).mode & 0o7777, 0o600);
	});
}

const document = () =>
	[
		{ type: "session", id: "s", timestamp: "2026-01-01T00:00:00.000Z" },
		{ type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
		{ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n") + "\n";

/** 只在一次性本机目录模拟远端；执行的正是生产命令，不手写 Node/sh 语义模拟器。 */
async function harness(t, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-write-guard-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "session.jsonl");
	await writeFile(path, options.document ?? document(), { mode: 0o600 });
	await chmod(path, options.mode ?? 0o600);
	const commands = [];
	const writer = createRemoteSessionHistoryWriter({
		resolveNodePath: async () => process.execPath,
		readChunkBytes: options.readChunkBytes,
		writeChunkBytes: 128,
		now: () => 123456,
		transport: {
			async runRemoteCommand({ remoteCommand }) {
				commands.push(remoteCommand);
				await options.before?.({ command: remoteCommand, path, directory, commands });
				let result;
				try {
					const output = await execute("/bin/sh", ["-c", "umask 022; " + remoteCommand], { timeout: 10_000, maxBuffer: 256 * 1024 });
					result = { exitCode: 0, stdout: output.stdout };
				} catch (error) {
					result = { exitCode: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "" };
				}
				await options.after?.({ command: remoteCommand, path, directory, commands });
				return result;
			},
		},
	});
	return { path, directory, commands, mutate: (operation = "edit", newText = "edited reply") => writer.mutate({ hostId: HOST, locator: { kind: "ssh", hostId: HOST, remotePath: path }, operation, messageId: operation === "resend" ? "u" : "a", newText }) };
}
const commits = (command) => command.startsWith("mv -- ") || command.includes(" 'commit' ");
const writes = (command) => command.includes("| base64 -d ");

for (const operation of ["edit", "delete", "resend"]) {
	for (const mode of [0o600, 0o640, 0o644]) {
		test(`${operation} preserves ${mode.toString(8)} mode; every upload chunk is private from creation`, { skip: !POSIX }, async (t) => {
			const temporaryModes = [];
			const fixture = await harness(t, {
				mode,
				after: async ({ command, directory }) => {
					if (writes(command)) for (const name of await readdir(directory)) if (name.endsWith(".pideck-tmp")) temporaryModes.push((await stat(join(directory, name))).mode & 0o7777);
				},
			});
			await fixture.mutate(operation);
			assert.equal((await stat(fixture.path)).mode & 0o7777, mode);
			assert.ok(temporaryModes.length > 1, "must inspect a multi-chunk upload");
			assert.ok(
				temporaryModes.every((value) => value === 0o600),
				"no partial session content may become group/world readable",
			);
			assert.notEqual(await readFile(fixture.path, "utf8"), document());
			assert.deepEqual(await readdir(fixture.directory), ["session.jsonl"]);
		});
	}
}

for (const change of ["same-size content", "append", "replace with identical bytes", "permissions", "delete"]) {
	test(`commit refuses external ${change} changes without overwriting or retrying`, { skip: !POSIX }, async (t) => {
		let altered = false;
		let external;
		const fixture = await harness(t, {
			before: async ({ command, path }) => {
				if (!commits(command) || altered) return;
				altered = true;
				external = document();
				if (change === "same-size content") external = document().replace("reply", "other");
				if (change === "append") external += JSON.stringify({ type: "message", id: "extra", parentId: "a", message: { role: "user", content: "external" } }) + "\n";
				if (change === "replace with identical bytes") {
					await writeFile(path + ".external", external, { mode: 0o600 });
					await rename(path + ".external", path);
				} else if (change === "permissions") await chmod(path, 0o640);
				else if (change === "delete") await unlink(path);
				else await writeFile(path, external);
			},
		});
		await assert.rejects(fixture.mutate(), (error) => error.message === CHANGED);
		assert.equal(fixture.commands.filter(commits).length, 1, "no destructive retry");
		if (change === "delete") await assert.rejects(readFile(fixture.path), { code: "ENOENT" });
		else assert.equal(await readFile(fixture.path, "utf8"), external);
		if (change === "permissions") assert.equal((await stat(fixture.path)).mode & 0o7777, 0o640);
		for (const name of await readdir(fixture.directory)) if (name.endsWith(".pideck-tmp")) assert.equal((await stat(join(fixture.directory, name))).mode & 0o7777, 0o600);
	});
}

test("a same-length change during chunked reads is rejected before creating any temporary file", { skip: !POSIX }, async (t) => {
	let changed = false;
	const external = document().replace("reply", "other");
	const fixture = await harness(t, {
		readChunkBytes: 64,
		after: async ({ command, path }) => {
			if (changed || !command.includes("tail -c +")) return;
			changed = true;
			await writeFile(path, external);
		},
	});
	await assert.rejects(fixture.mutate(), (error) => error.message === CHANGED);
	assert.equal(fixture.commands.filter(writes).length, 0);
	assert.equal(await readFile(fixture.path, "utf8"), external);
	assert.deepEqual(await readdir(fixture.directory), ["session.jsonl"]);
});

test("upload-time source changes are rejected at commit", { skip: !POSIX }, async (t) => {
	let changed = false;
	const external = document().replace("reply", "other");
	const fixture = await harness(t, {
		after: async ({ command, path }) => {
			if (changed || !writes(command)) return;
			changed = true;
			await writeFile(path, external);
		},
	});
	await assert.rejects(fixture.mutate(), (error) => error.message === CHANGED);
	assert.equal(await readFile(fixture.path, "utf8"), external);
});

for (const existing of ["file", "symlink"]) {
	test(`first chunk cannot overwrite a pre-existing temporary ${existing}`, { skip: !POSIX }, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "pideck-temp-collision-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const target = join(directory, "victim.jsonl");
		const temporary = join(directory, ".session.deadbeef.pideck-tmp");
		await writeFile(target, "do not overwrite", { mode: 0o600 });
		if (existing === "symlink") await symlink(target, temporary);
		else await writeFile(temporary, "do not overwrite", { mode: 0o600 });
		const command = buildRemoteSessionHistoryChunkWriteCommand({ remotePath: temporary, chunk: Buffer.from("replacement").toString("base64") });
		await assert.rejects(execute("/bin/sh", ["-c", command]));
		assert.equal(await readFile(temporary, "utf8"), "do not overwrite");
		assert.equal(await readFile(target, "utf8"), "do not overwrite");
	});
}

test("symlink source is rejected without reading or changing its referent", { skip: !POSIX }, async (t) => {
	const fixture = await harness(t);
	const real = fixture.path + ".real";
	await rename(fixture.path, real);
	await symlink(real, fixture.path);
	await assert.rejects(fixture.mutate());
	assert.equal(await readFile(real, "utf8"), document());
	assert.equal(fixture.commands.filter(writes).length, 0);
});

test("same-size temporary content tampering is rejected before replacing source", { skip: !POSIX }, async (t) => {
	const fixture = await harness(t, {
		before: async ({ command, directory }) => {
			if (!commits(command)) return;
			const name = (await readdir(directory)).find((file) => file.endsWith(".pideck-tmp"));
			const path = join(directory, name);
			await writeFile(path, (await readFile(path, "utf8")).replace("edited reply", "other! reply"));
		},
	});
	await assert.rejects(fixture.mutate(), (error) => error.message === "REMOTE_SESSION_HISTORY_WRITER_TRANSFER_INVALID");
	assert.equal(await readFile(fixture.path, "utf8"), document());
});

test("an oversized replacement fails before upload, not after writing unbounded temp data", { skip: !POSIX }, async (t) => {
	const fixture = await harness(t);
	await assert.rejects(fixture.mutate("edit", "x".repeat(256 * 1024)), (error) => error.message === "REMOTE_SESSION_HISTORY_WRITER_FILE_TOO_LARGE");
	assert.equal(fixture.commands.filter(writes).length, 0);
	assert.equal(await readFile(fixture.path, "utf8"), document());
});

test("rename failure restores residual temporary permissions to 0600", { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
	const fixture = await harness(t, {
		mode: 0o644,
		before: async ({ command, directory }) => {
			if (commits(command)) await chmod(directory, 0o555);
		},
	});
	try {
		await assert.rejects(fixture.mutate(), (error) => error.message === "REMOTE_SESSION_HISTORY_WRITER_COMMAND_FAILED");
		assert.equal(await readFile(fixture.path, "utf8"), document());
		assert.equal((await stat(fixture.path)).mode & 0o7777, 0o644);
		for (const name of await readdir(fixture.directory)) if (name.endsWith(".pideck-tmp")) assert.equal((await stat(join(fixture.directory, name))).mode & 0o7777, 0o600);
	} finally {
		await chmod(fixture.directory, 0o755);
	}
});
