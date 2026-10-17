import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Pure renderer model for the remote model catalog action: DTO validation, provider grouping, phase reducer and
 * closed-code copy mapping. No React/DOM.
 */

const model = loadTsCommonJs("src/renderer/src/config/remoteModelCatalogModel.ts");
const shared = loadTsCommonJs("src/shared/types/remoteModel.ts");
const HOST = "01234567-89ab-4def-8123-456789abcdef";
const plain = (value) => JSON.parse(JSON.stringify(value));

function entry(provider, id, overrides = {}) {
	return { id, provider, name: "Name " + id, contextWindow: 128000, maxTokens: 8192, reasoning: true, input: ["text"], images: false, ...overrides };
}

function okResult(models, overrides = {}) {
	return { ok: true, hostId: HOST, models, providers: [...new Set(models.map((item) => item.provider))].sort(), count: models.length, at: 1700000000000, ...overrides };
}

function reduce(...actions) {
	return actions.reduce((state, action) => model.reduceRemoteModelCatalog(state, action), model.initialRemoteModelCatalogState);
}

test("grouping is provider-sorted and preserves each provider's deterministic model order", () => {
	const groups = model.groupRemoteModelsByProvider([entry("z", "m3"), entry("a", "m2"), entry("z", "m1"), entry("a", "m1")]);
	assert.deepEqual(plain(groups.map((group) => group.provider)), ["a", "z"]);
	assert.deepEqual(plain(groups.map((group) => group.models.map((item) => item.id))), [
		["m2", "m1"],
		["m3", "m1"],
	]);
	assert.deepEqual(plain(model.groupRemoteModelsByProvider([])), []);
});

test("the reducer walks idle -> loading -> ready and never renders an in-flight answer as ready", () => {
	assert.equal(reduce().phase, "idle");
	const loading = reduce({ type: "started" });
	assert.equal(loading.phase, "loading");
	assert.equal(reduce({ type: "started" }, { type: "started" }).phase, "loading", "double click is ignored while loading");
	const ready = reduce({ type: "started" }, { type: "succeeded", result: okResult([entry("p", "m1"), entry("p", "m2")]) });
	assert.equal(ready.phase, "ready");
	assert.deepEqual(plain(ready.providers), ["p"]);
	assert.equal(ready.count, 2);
	assert.equal(ready.at, 1700000000000);
	assert.equal(ready.code, undefined);
});

test("EMPTY is a neutral empty state; other closed errors map to the error state", () => {
	const empty = reduce({ type: "started" }, { type: "succeeded", result: { ok: false, code: shared.REMOTE_MODEL_PROBE_CODES.empty } });
	assert.equal(empty.phase, "empty");
	assert.equal(empty.code, shared.REMOTE_MODEL_PROBE_CODES.empty);
	assert.equal(empty.count, 0);
	for (const code of [shared.REMOTE_MODEL_PROBE_CODES.targetInvalid, shared.REMOTE_MODEL_PROBE_CODES.noProject, shared.REMOTE_MODEL_PROBE_CODES.noRuntime, shared.REMOTE_MODEL_PROBE_CODES.unavailable, shared.REMOTE_MODEL_PROBE_CODES.failed]) {
		const state = reduce({ type: "started" }, { type: "succeeded", result: { ok: false, code } });
		assert.equal(state.phase, "error", code);
		assert.equal(state.code, code, code);
		assert.equal(state.count, 0, code);
	}
});

test("copy mapping covers the five error codes and keeps EMPTY out of the red error copy", () => {
	const expected = new Map([
		[shared.REMOTE_MODEL_PROBE_CODES.targetInvalid, "remoteModel.errorTargetInvalid"],
		[shared.REMOTE_MODEL_PROBE_CODES.noProject, "remoteModel.errorNoProject"],
		[shared.REMOTE_MODEL_PROBE_CODES.noRuntime, "remoteModel.errorNoRuntime"],
		[shared.REMOTE_MODEL_PROBE_CODES.unavailable, "remoteModel.errorUnavailable"],
		[shared.REMOTE_MODEL_PROBE_CODES.failed, "remoteModel.errorFailed"],
	]);
	for (const [code, key] of expected) assert.equal(model.remoteModelProbeErrorKey(code), key, code);
	assert.equal(new Set(expected.values()).size, 5);
});

test("malformed/foreign probe answers fail closed instead of being rendered as data", () => {
	const invalid = [
		null,
		"nope",
		{ ok: "yes" },
		{ ok: true, hostId: HOST, models: [], providers: [], count: 0 },
		{ ok: true, hostId: HOST, models: "nope", providers: [], count: 0, at: 1 },
		{ ok: true, hostId: HOST, models: [{ id: "m1" }], providers: ["p"], count: 1, at: 1 },
		{ ok: true, hostId: HOST, models: [{ id: "m1", provider: "p" }], providers: [1], count: 1, at: 1 },
		{ ok: false, code: "REMOTE_MODEL_PROBE_MADE_UP" },
		{ ok: false },
	];
	for (const value of invalid) {
		assert.equal(model.readRemoteModelProbeResult(value), undefined, JSON.stringify(value));
		const state = reduce({ type: "started" }, { type: "succeeded", result: value });
		assert.equal(state.phase, "error", JSON.stringify(value));
		assert.equal(state.code, shared.REMOTE_MODEL_PROBE_CODES.unavailable, JSON.stringify(value));
	}
	// Valid shapes are accepted (ok:false closed code and ok:true catalog).
	assert.equal(model.readRemoteModelProbeResult({ ok: false, code: shared.REMOTE_MODEL_PROBE_CODES.noRuntime }).code, shared.REMOTE_MODEL_PROBE_CODES.noRuntime);
	const valid = model.readRemoteModelProbeResult(okResult([entry("p", "m1")]));
	assert.equal(valid.ok, true);
	assert.equal(valid.models.length, 1);
});

test("a transport-level failure and reset keep the state honest", () => {
	const failed = reduce({ type: "started" }, { type: "failed", code: shared.REMOTE_MODEL_PROBE_CODES.unavailable });
	assert.equal(failed.phase, "error");
	assert.equal(failed.code, shared.REMOTE_MODEL_PROBE_CODES.unavailable);
	assert.equal(reduce({ type: "started" }, { type: "succeeded", result: okResult([entry("p", "m1")]) }, { type: "reset" }).phase, "idle");
	// A malformed ok answer with zero models still becomes empty, not ready-with-fake-data.
	const zero = reduce({ type: "started" }, { type: "succeeded", result: okResult([]) });
	assert.equal(zero.phase, "empty");
});

test("token display formatting is deterministic and integer-bounded", () => {
	assert.equal(model.formatModelTokenCount(128000), "128000");
	assert.equal(model.formatModelTokenCount(200000.9), "200000");
});
