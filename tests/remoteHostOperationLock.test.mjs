import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteHostOperationLock } = loadTsCommonJs("src/main/remote/RemoteHostOperationLock.ts");

const deferred = () => {
	const box = {};
	box.promise = new Promise((resolve, reject) => {
		box.resolve = resolve;
		box.reject = reject;
	});
	return box;
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("operations of one key run one at a time in arrival order", async () => {
	const lock = createRemoteHostOperationLock();
	const order = [];
	const first = lock.run("host-a", async () => {
		order.push("first:start");
		await settle();
		order.push("first:end");
	});
	const second = lock.run("host-a", async () => {
		order.push("second:start");
		order.push("second:end");
	});
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("a rejected operation releases the key and the next waiter still runs", async () => {
	const lock = createRemoteHostOperationLock();
	const failing = lock.run("host-a", async () => {
		throw new Error("SSH_CONNECTION_FAILED");
	});
	await assert.rejects(failing, /SSH_CONNECTION_FAILED/);
	const next = await lock.run("host-a", async () => "ok");
	assert.equal(next, "ok");
	assert.equal(lock.isBusy("host-a"), false, "key must be dropped once nothing waits on it");
});

test("different keys never block each other", async () => {
	const lock = createRemoteHostOperationLock();
	const gate = deferred();
	const running = lock.run("host-a", async () => {
		await gate.promise;
	});
	// host-b is not behind host-a, even though host-a's operation is still running.
	const other = await lock.run("host-b", async () => "b");
	assert.equal(other, "b");
	gate.resolve();
	await running;
});

test("the key is dropped when the last waiter finishes, so the map cannot grow without bound", async () => {
	const lock = createRemoteHostOperationLock();
	assert.equal(lock.isBusy("host-a"), false);
	const gate = deferred();
	const running = lock.run("host-a", async () => {
		await gate.promise;
		return 1;
	});
	const queued = lock.run("host-a", async () => 2);
	assert.equal(lock.isBusy("host-a"), true);
	gate.resolve();
	assert.deepEqual(await Promise.all([running, queued]), [1, 2]);
	assert.equal(lock.isBusy("host-a"), false);
});

test("the caller's error travels, and it is not the lock that fails", async () => {
	const lock = createRemoteHostOperationLock();
	await assert.rejects(
		lock.run("host-a", async () => {
			throw new Error("SSH_HOST_NOT_READY");
		}),
		(error) => error.message === "SSH_HOST_NOT_READY",
	);
	assert.equal(lock.isBusy("host-a"), false);
});
