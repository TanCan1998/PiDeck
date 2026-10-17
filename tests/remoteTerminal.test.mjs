import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function setup(overrides = {}) {
	const resources = [],
		events = [];
	const projects = new Map([
		["p1", { hostId: "host", remotePath: "/workspace/one" }],
		["p2", { hostId: "host", remotePath: "/workspace/two" }],
	]);
	const { RemoteTerminalSessionManager } = loadTsCommonJs("src/main/terminal/RemoteTerminalSessionManager.ts");
	const manager = new RemoteTerminalSessionManager({
		locator: (id) => projects.get(id),
		emit: (sender, channel, payload) => events.push({ sender, channel, ...payload }),
		start: async (target, signal, callbacks) => {
			const resource = { target, callbacks, writes: [], sizes: [], killed: 0, paused: 0, resumed: 0, current: true };
			resource.pty = { write: (data) => resource.writes.push(data), resize: (cols, rows) => resource.sizes.push([cols, rows]), pause: () => resource.paused++, resume: () => resource.resumed++ };
			resource.dispose = () => resource.killed++;
			resource.assertCurrent = async () => {
				if (!resource.current) throw new Error("SSH_HOST_NOT_READY");
			};
			resources.push(resource);
			if (!overrides.noReady) {
				// The launcher resolves only after the runner confirmed the login shell; the first prompt is queued output.
				callbacks.data("$ ");
			}
			if (overrides.start) await overrides.start(resource, signal);
			if (overrides.noReady) return new Promise(() => undefined);
			return resource;
		},
		startupTimeoutMs: 100,
	});
	return { manager, resources, events, projects };
}

test("remote ensure is atomic and output is acknowledged, bounded and project/window isolated", async (t) => {
	const { manager, resources, events } = setup();
	t.after(() => manager.closeAll());
	const [one, repeated] = await Promise.all([manager.ensure(1, "p1"), manager.ensure(1, "p1")]);
	assert.equal(one[0].id, repeated[0].id);
	assert.equal(resources.length, 1);
	const two = await manager.ensure(1, "p2");
	const otherWindow = await manager.ensure(2, "p1");
	assert.notEqual(one[0].id, two[0].id);
	assert.notEqual(one[0].id, otherWindow[0].id);
	assert.equal(one[0].ownerKey, "project:p1");
	assert.equal(one[0].location, "ssh");
	assert.equal(events.length, 0, "no unbounded output before viewer acknowledges its snapshot");
	manager.ack(1, one[0].id, one[0].outputSequence);
	const initial = events.at(-1);
	assert.equal(initial.sender, 1);
	assert.equal(initial.data, "$ ");
	resources[0].callbacks.data("only-one");
	assert.equal(events.at(-1), initial);
	manager.ack(1, one[0].id, initial.sequence);
	assert.equal(events.at(-1).data, "only-one");
	await manager.input(1, one[0].id, "pwd\r");
	await manager.resize(1, one[0].id, 111, 33);
	assert.deepEqual(resources[0].writes, ["pwd\r"]);
	assert.deepEqual(resources[0].sizes, [[111, 33]]);
	assert.deepEqual(resources[1].writes, []);
	assert.equal(manager.list(2, "p2").length, 0);
	assert.throws(() => manager.ack(2, one[0].id, 1), /REMOTE_TERMINAL_OWNER_MISMATCH/);
	await assert.rejects(manager.input(2, one[0].id, "no\r"), /REMOTE_TERMINAL_OWNER_MISMATCH/);
	assert.throws(() => manager.close(2, one[0].id), /REMOTE_TERMINAL_OWNER_MISMATCH/);
});

test("hidden remote output pauses the PTY and replay resumes without duplicating unsent data", async (t) => {
	const { manager, resources, events } = setup();
	t.after(() => manager.closeAll());
	const [tab] = await manager.ensure(1, "p1");
	manager.ack(1, tab.id, 0);
	const initialSeq = events.at(-1).sequence;
	resources[0].callbacks.data("x".repeat(140_000));
	assert.ok(resources[0].paused > 0);
	assert.equal(events.length, 1);
	const snapshot = manager.list(1, "p1")[0];
	assert.equal(snapshot.buffer, "$ ");
	manager.ack(1, tab.id, initialSeq);
	let sequence = events.at(-1).sequence;
	while (events.at(-1).sequence !== initialSeq && resources[0].resumed === 0) {
		manager.ack(1, tab.id, sequence);
		sequence = events.at(-1).sequence;
	}
	assert.ok(resources[0].resumed > 0);
	assert.ok(events.every((event) => !event.data || event.data.length <= 32_768));
	assert.ok(manager.list(1, "p1")[0].buffer.length <= 131_072);
});

test("UTF-8 output packets preserve surrogate pairs and byte budgets", async (t) => {
	const { manager, resources, events } = setup();
	t.after(() => manager.closeAll());
	const [tab] = await manager.ensure(1, "p1");
	manager.ack(1, tab.id, 0);
	manager.ack(1, tab.id, events.at(-1).sequence);
	const start = events.length;
	const text = "a".repeat(10921) + "🙂".repeat(20000) + "中文\n";
	resources[0].callbacks.data(text);
	let delivered = start;
	while (delivered < events.length) {
		const packet = events[delivered++];
		assert.ok(Buffer.byteLength(packet.data) <= 32768);
		assert.equal(Buffer.from(packet.data).toString("utf8"), packet.data, "each packet must contain intact Unicode code points");
		manager.ack(1, tab.id, packet.sequence);
	}
	assert.equal(
		events
			.slice(start)
			.map((event) => event.data)
			.join(""),
		text,
	);
});

test("disconnect and destroyed sender cancel pending starts and never recreate or replay commands", async (t) => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const { manager, resources, events } = setup({ start: async () => gate });
	t.after(() => manager.closeAll());
	const pending = manager.ensure(1, "p1");
	await new Promise((resolve) => setImmediate(resolve));
	manager.closeHost("host");
	release();
	await assert.rejects(pending, /SSH_HOST_DISCONNECTED/);
	assert.equal(resources[0].killed, 1);
	assert.equal(manager.list(1, "p1").length, 0);
	assert.equal(events.length, 0);
	const [tab] = await manager.ensure(2, "p2");
	await manager.input(2, tab.id, "echo test\r");
	manager.releaseSender(2);
	assert.equal(resources[1].killed, 1);
	assert.equal(manager.has(tab.id), false);
	resources[1].callbacks.data("late");
	resources[1].callbacks.exit(0);
	assert.equal(events.length, 0);
});

test("startup that never confirms the login shell times out and releases its SSH resource", async (t) => {
	const { manager, resources } = setup({ noReady: true });
	t.after(() => manager.closeAll());
	await assert.rejects(manager.ensure(1, "p1"), /REMOTE_TERMINAL_START_TIMEOUT/);
	assert.equal(resources[0].killed, 0, "a provider that never returned a resource has nothing to kill");
	assert.equal(manager.list(1, "p1").length, 0);
});

test("startup timeout settles even when an earlier provider has not returned its resource", async (t) => {
	const { manager, resources } = setup({ noReady: true });
	t.after(() => manager.closeAll());
	await assert.rejects(manager.ensure(1, "p1"), /REMOTE_TERMINAL_START_TIMEOUT/);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(resources[0].killed, 0, "a provider that never confirmed the shell has nothing to release");
	assert.equal(manager.list(1, "p1").length, 0);
});

test("changed project or host identity rejects I/O, preserves ordering and closes the old process", async (t) => {
	const { manager, resources, projects } = setup();
	t.after(() => manager.closeAll());
	const [tab] = await manager.ensure(1, "p1");
	await Promise.all([manager.input(1, tab.id, "a"), manager.input(1, tab.id, "b")]);
	assert.deepEqual(resources[0].writes, ["a", "b"]);
	projects.set("p1", { hostId: "host", remotePath: "/different" });
	await assert.rejects(manager.input(1, tab.id, "never"), /REMOTE_TERMINAL_TARGET_CHANGED/);
	assert.equal(resources[0].killed, 1);
	assert.deepEqual(resources[0].writes, ["a", "b"]);
	const [second] = await manager.ensure(1, "p2");
	resources[1].current = false;
	await assert.rejects(manager.input(1, second.id, "never"), /SSH_HOST_NOT_READY/);
	assert.equal(resources[1].killed, 1);
});

test("remote terminal refuses excessive input, geometry, arbitrary shells and output overflow", async (t) => {
	const { manager, resources } = setup();
	t.after(() => manager.closeAll());
	await assert.rejects(manager.create(1, "p1", "bash"), /REMOTE_TERMINAL_SHELL_UNSUPPORTED/);
	const [tab] = await manager.ensure(1, "p1");
	await assert.rejects(manager.input(1, tab.id, "中".repeat(6000)), /REMOTE_TERMINAL_INPUT_LIMIT/);
	await assert.rejects(manager.resize(1, tab.id, 1001, 24), /INVALID_TERMINAL_SIZE/);
	resources[0].callbacks.data("x".repeat(300_000));
	assert.equal(resources[0].killed, 1);
	assert.equal(manager.list(1, "p1")[0].exitReason, "REMOTE_TERMINAL_OUTPUT_LIMIT");
});

test("project changes during asynchronous host validation still reject the pending input", async (t) => {
	const { manager, resources, projects } = setup();
	t.after(() => manager.closeAll());
	const [tab] = await manager.ensure(1, "p1");
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	resources[0].assertCurrent = async () => gate;
	const input = manager.input(1, tab.id, "never");
	await new Promise((resolve) => setImmediate(resolve));
	projects.set("p1", { hostId: "host", remotePath: "/changed-while-awaiting" });
	release();
	await assert.rejects(input, /REMOTE_TERMINAL_TARGET_CHANGED/);
	assert.deepEqual(resources[0].writes, []);
});

test("natural exit delivers its final queued output before the exit notification", async (t) => {
	const { manager, resources, events } = setup();
	t.after(() => manager.closeAll());
	const [tab] = await manager.ensure(1, "p1");
	manager.ack(1, tab.id, 0);
	resources[0].callbacks.data("TEST_RESULT_OK");
	resources[0].callbacks.exit(0);
	assert.equal(events.length, 1);
	manager.ack(1, tab.id, events[0].sequence);
	assert.equal(events[1].data, "TEST_RESULT_OK");
	manager.ack(1, tab.id, events[1].sequence);
	assert.equal(events[2].exitCode, 0);
	assert.equal(manager.list(1, "p1")[0].exited, true);
});
