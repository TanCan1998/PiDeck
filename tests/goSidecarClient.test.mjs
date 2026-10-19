/**
 * GoSidecarClient（四个 Go sidecar 共用的 NDJSON stdio 传输层）回归测试。
 *
 * 各服务的业务测试（sessionIndexService/fileIndexService/sessionStoreService/
 * xueIndexService）覆盖复用键、命令形状与 ready 字段；这里只锁定共享层自己的
 * 边界：非法行、stdout 溢出、stdin 管道错误、运行期协议版本漂移、dispose 结算。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { GoSidecarClient } = loadTsCommonJs("src/main/sidecar/GoSidecarClient.ts");

function createHarness() {
	const stdout = new PassThrough();
	const child = new EventEmitter();
	const writes = [];
	child.stdout = stdout;
	child.stderr = new PassThrough();
	child.stdin = new EventEmitter();
	child.stdin.destroyed = false;
	child.stdin.write = (chunk) => {
		writes.push(String(chunk));
		return true;
	};
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		return true;
	};
	return {
		child,
		writes,
		commands: () => writes.map((line) => JSON.parse(line)),
		emitLine: (message) => stdout.write(`${JSON.stringify(message)}\n`),
	};
}

const SILENT_LOGGER = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const MESSAGES = {
	binaryMissing: "missing",
	spawnFailed: "spawn failed",
	bootFailed: "boot failed",
	processError: "process error",
	processExited: (code) => `exited ${code ?? "null"}`,
	requestTimeout: "request timeout",
	requestFailed: (error) => error ?? "request failed",
	childUnavailable: "unavailable",
	writeFailed: "write failed",
	pipeClosed: "pipe closed",
	protocolMismatch: "protocol mismatch",
	responseOverflow: "overflow",
	disposed: "disposed",
	keyChanged: "key changed",
};

function createClient(overrides = {}) {
	const harnesses = [];
	const client = new GoSidecarClient({
		name: "test-sidecar",
		resolveBinaryPath: () => "/fake/test-sidecar",
		spawnFn: () => {
			const harness = createHarness();
			harnesses.push(harness);
			return harness.child;
		},
		logger: SILENT_LOGGER,
		timeouts: { boot: overrides.bootTimeout ?? 5_000, request: overrides.requestTimeout ?? 5_000 },
		protocolVersion: 1,
		maxLineChars: overrides.maxLineChars ?? 4 * 1024 * 1024,
		messages: MESSAGES,
	});
	return { client, harnesses, latest: () => harnesses.at(-1) };
}

async function bootAndSend(client, latest) {
	const ready = client.ensureReady("key", ["arg"]);
	await new Promise((resolve) => setImmediate(resolve));
	latest().emitLine({ type: "ready", protocolVersion: 1 });
	await ready;
	const pending = client.request({ cmd: "do", value: 7 });
	await new Promise((resolve) => setImmediate(resolve));
	return { pending, command: latest().commands()[0] };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("请求 id 配对：正常响应回传 result，非法行忽略后仍能结算", async () => {
	const { client, latest } = createClient();
	const { pending, command } = await bootAndSend(client, latest);
	latest().child.stdout.write("not-json\n");
	latest().emitLine({ type: "response", id: command.id, ok: true, result: { value: 42 } });
	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.value.value, 42);
	client.dispose();
});

test("运行期协议版本漂移：结算在途请求为 protocol 并回收进程", async () => {
	const { client, latest } = createClient();
	const { pending } = await bootAndSend(client, latest);
	latest().emitLine({ type: "ready", protocolVersion: 99 });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(latest().child.killed, true);
	client.dispose();
});

test("stdout 行缓冲溢出：判定协议异常、杀进程并结算 pending", async () => {
	const { client, latest } = createClient({ maxLineChars: 128 });
	const { pending } = await bootAndSend(client, latest);
	latest().child.stdout.write("x".repeat(256));
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(latest().child.killed, true);
	client.dispose();
});

test("stdin 管道错误：结算 pending 为 protocol 并回收进程", async () => {
	const { client, latest } = createClient();
	const { pending } = await bootAndSend(client, latest);
	latest().child.stdin.emit("error", new Error("EPIPE"));
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(latest().child.killed, true);
	client.dispose();
});

test("stdin 写入抛错：单请求结算为 protocol，不悬挂也不崩主进程", async () => {
	const { client, latest } = createClient();
	const ready = client.ensureReady("key", ["arg"]);
	await tick();
	latest().emitLine({ type: "ready", protocolVersion: 1 });
	await ready;
	latest().child.stdin.write = () => {
		throw new Error("EPIPE");
	};
	const result = await client.request({ cmd: "fail" });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	client.dispose();
});

test("dispose：结算在途请求、杀进程；之后的 ensureReady 直接 boot-failed", async () => {
	const { client, latest } = createClient();
	const { pending } = await bootAndSend(client, latest);
	client.dispose();
	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "protocol");
	assert.equal(latest().child.killed, true);
	const after = await client.ensureReady("key", ["arg"]);
	assert.equal(after.ok, false);
	assert.equal(after.reason, "boot-failed");
});
