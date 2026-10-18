import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const queue = loadTsCommonJs("src/renderer/src/utils/cuaApprovalQueue.ts");

test("enqueue appends FIFO and peek returns the head", () => {
	const q0 = [];
	const q1 = queue.enqueueApproval(q0, { requestId: "a" });
	const q2 = queue.enqueueApproval(q1, { requestId: "b" });

	assert.strictEqual(q0.length, 0, "input queue is not mutated");
	assert.deepStrictEqual(
		[...q2].map((item) => item.requestId),
		["a", "b"],
	);
	assert.strictEqual(queue.peekApproval(q2).requestId, "a");
});

test("enqueue drops the oldest request beyond the capacity cap", () => {
	let q = [];
	for (let i = 0; i < 40; i += 1) {
		q = queue.enqueueApproval(q, { requestId: String(i) });
	}
	assert.strictEqual(q.length, queue.MAX_PENDING_APPROVALS ?? 32, "queue length is capped");
	assert.strictEqual(q[0].requestId, "8", "oldest requests are dropped first");
	assert.strictEqual(q.at(-1).requestId, "39", "newest request survives");
});

test("dequeue removes only the head", () => {
	const q = [{ requestId: "a" }, { requestId: "b" }, { requestId: "c" }];
	const next = queue.dequeueApproval(q);
	assert.deepStrictEqual(
		next.map((item) => item.requestId),
		["b", "c"],
	);
	assert.deepStrictEqual(
		["a", "b"].map((id) => id),
		["a", "b"],
	);
	assert.strictEqual(queue.peekApproval([]), undefined);
});
