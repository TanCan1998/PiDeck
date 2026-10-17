import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";
import { materializeRemoteHelperArtifacts } from "./remoteHelperArtifacts.mjs";
const HOST_ID = "01234567-89ab-4def-8123-456789abcdef";
/** Drive the deployed helper bytes, with an isolated HOME and an owned repository only. */
function fixture(t, initialize = true, helperEnv = {}, rootName = "project") {
	const directory = mkdtempSync(join(tmpdir(), "pideck-remote-git-read-"));
	const root = join(directory, rootName);
	const home = join(directory, "home");
	const templates = join(directory, "templates");
	for (const path of [root, home, templates]) mkdirSync(path);
	const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: templates };
	// The test process must not let a developer's alternate index or worktree redirect its fixture.
	for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_CONFIG_NOSYSTEM" && key !== "GIT_TEMPLATE_DIR") delete env[key];
	const git = (...args) => execFileSync("git", args, { cwd: root, env, timeout: 5_000, encoding: "utf8", maxBuffer: 1024 * 1024 });
	if (initialize) git("init", "-q");
	// The bundle is several files; the entry imports its siblings, so all of them are written.
	const entry = materializeRemoteHelperArtifacts(directory).entryPath;
	const overrides = typeof helperEnv === "function" ? helperEnv({ directory, root }) : helperEnv;
	const child = spawn(process.execPath, [entry, "--root", root], { env: { ...env, ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
	const lines = createInterface({ input: child.stdout });
	const pending = new Map();
	let sequence = 0;
	const failPending = (error) => {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
	};
	lines.on("line", (line) => {
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			failPending(new Error("helper emitted a non-protocol line"));
			return;
		}
		const request = pending.get(frame.id);
		if (!request) return;
		clearTimeout(request.timer);
		pending.delete(frame.id);
		request.resolve(frame);
	});
	child.on("error", failPending);
	child.on("exit", () => failPending(new Error("helper exited before response")));
	// Drain diagnostics without exposing paths or content in a failure message; an explicit opt-in forwards
	// them, because a stable code alone is often not enough to tell a helper bug from a fixture mistake.
	child.stderr.on("data", (chunk) => {
		if (process.env.PIDECK_TEST_HELPER_STDERR === "1") process.stderr.write("[helper] " + String(chunk));
	});
	t.after(() => {
		failPending(new Error("fixture closed"));
		lines.close();
		child.kill();
		rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
	// `repo` is the optional G5d read scope: absent/empty is the project root, so every existing caller keeps the
	// exact frame it sent before.
	const request = (method, params = {}, timeoutMs = 3_000, onId = () => undefined, repo = "") =>
		new Promise((resolve, reject) => {
			const id = `git-read-${++sequence}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("bounded helper request expired"));
			}, 5_000);
			pending.set(id, { resolve, reject, timer });
			onId(id);
			child.stdin.write(`${JSON.stringify({ v: 1, hostId: HOST_ID, generation: 1, id, method, timeoutMs, params, ...(repo === "" ? {} : { repo }) })}\n`);
		});
	return { root, git, request, directory, child };
}

/** A result must come from a successful protocol response, never from an empty fallback. */
function successful(frame) {
	assert.equal(frame.ok, true, frame.error?.code);
	assert.equal(frame.hostId, HOST_ID);
	assert.equal(frame.generation, 1);
	return frame.result;
}

const options = { timeout: 15_000, skip: process.platform !== "linux" };

export { fixture, successful, options };
