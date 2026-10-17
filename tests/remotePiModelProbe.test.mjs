import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * RemotePiModelProbe unit suite (Phase 5 row 819): host-only input, ProjectStore -> narrow finder -> live
 * runtime RPC, masked allowlist, bounds/dedupe and the closed-code matrix. All dependencies are fakes; no
 * Electron, SSH, AgentManager or real runtime is involved.
 */

const probeModule = loadTsCommonJs("src/main/pi/RemotePiModelProbe.ts");
const shared = loadTsCommonJs("src/shared/types/remoteModel.ts");
const HOST = "01234567-89ab-4def-8123-456789abcdef";
const OTHER_HOST = "fedcba98-7654-4321-8765-fedcba987654";

function model(index, overrides = {}) {
	return {
		id: "m" + index,
		provider: "p",
		name: "Model " + index,
		contextWindow: 128000,
		maxTokens: 8192,
		reasoning: true,
		input: ["text", "image"],
		images: true,
		// Data the mask must drop: credentials/base URLs/raw provider fields/unknown future fields.
		apiKey: "sk-live-secret",
		baseUrl: "https://secret.example.test",
		thinkingLevels: ["low", "high"],
		thinkingLevelMap: { low: "low" },
		...overrides,
	};
}

function harness(options = {}) {
	const calls = { projects: [], finder: [], models: [] };
	const deps = {
		projectIdsForHost(hostId) {
			calls.projects.push(hostId);
			if (options.projectsThrows) throw new Error("project store unavailable free text");
			return options.projectIds ?? [];
		},
		findLiveAgentId(projectIds) {
			calls.finder.push(projectIds);
			return options.agentId;
		},
		async getAvailableModels(agentId) {
			calls.models.push(agentId);
			if (options.modelsThrows) throw new Error("runtime exploded with secret text");
			if (options.modelsPending) return new Promise(() => undefined);
			return options.models;
		},
		now: () => 1700000000000,
		timeoutMs: options.timeoutMs ?? 1000,
	};
	return { calls, probe: probeModule.createRemotePiModelProbe(deps) };
}

async function codeOf(probe, hostId) {
	const result = JSON.parse(JSON.stringify(await probe.probe(hostId)));
	return result.ok === false ? result.code : "OK";
}

test("invalid host input is refused before any project/finder/runtime call", async () => {
	for (const hostId of [undefined, null, "", "not-a-host", HOST + "x", 42, {}, [], HOST.toUpperCase()]) {
		const h = harness({ projectIds: ["p1"], agentId: "a1", models: [model(1)] });
		const result = JSON.parse(JSON.stringify(await h.probe.probe(hostId)));
		assert.deepEqual(result, { ok: false, code: shared.REMOTE_MODEL_PROBE_CODES.targetInvalid }, String(hostId));
		assert.deepEqual(h.calls, { projects: [], finder: [], models: [] }, "invalid input must perform zero work: " + String(hostId));
	}
});

test("no enrolled remote project -> NO_PROJECT; store failure -> UNAVAILABLE; no live agent -> NO_RUNTIME", async () => {
	const none = harness({ projectIds: [] });
	assert.equal(await codeOf(none.probe, HOST), shared.REMOTE_MODEL_PROBE_CODES.noProject);
	assert.deepEqual(none.calls.finder, []);
	assert.deepEqual(none.calls.models, []);

	const broken = harness({ projectsThrows: true });
	assert.equal(await codeOf(broken.probe, HOST), shared.REMOTE_MODEL_PROBE_CODES.unavailable);
	assert.deepEqual(broken.calls.finder, []);

	const noRuntime = harness({ projectIds: ["p1", "p2"], agentId: undefined, models: [model(1)] });
	assert.equal(await codeOf(noRuntime.probe, HOST), shared.REMOTE_MODEL_PROBE_CODES.noRuntime);
	assert.deepEqual(noRuntime.calls.finder, [["p1", "p2"]], "finder gets exactly the ProjectStore project ids");
	assert.deepEqual(noRuntime.calls.models, [], "no runtime means no get_available_models call");
});

test("a live runtime answer is masked to the allowlist and never leaks credentials or raw runtime data", async () => {
	const h = harness({ projectIds: ["p1", "p2"], agentId: "agent-live-1", models: [model(2, { id: "gpt-x", provider: "z-provider", name: "GPT X" }), model(1, { provider: "a-provider" })] });
	const result = JSON.parse(JSON.stringify(await h.probe.probe(HOST)));
	assert.equal(result.ok, true);
	assert.equal(result.hostId, HOST);
	assert.equal(result.count, 2);
	assert.deepEqual(result.providers, ["a-provider", "z-provider"], "providers are sorted");
	assert.equal(result.at, 1700000000000);
	assert.deepEqual(h.calls.projects, [HOST]);
	assert.deepEqual(h.calls.finder, [["p1", "p2"]]);
	assert.deepEqual(h.calls.models, ["agent-live-1"], "exactly one bounded runtime attempt");
	// Masked entries contain only the documented picker fields.
	const allowed = ["id", "name", "provider", "contextWindow", "maxTokens", "reasoning", "input", "images"];
	for (const entry of result.models) {
		for (const key of Object.keys(entry)) assert.ok(allowed.includes(key), "unexpected masked field: " + key);
	}
	const serialized = JSON.stringify(result);
	for (const secret of ["sk-live-secret", "https://secret.example.test", "thinkingLevels", "thinkingLevelMap", "agent-live-1", "apiKey", "baseUrl"]) {
		assert.equal(serialized.includes(secret), false, "masked answer must not contain " + secret);
	}
	assert.equal("agentId" in result, false);
});

test("dedupe by provider+id keeps the first entry; same id under another provider is kept", async () => {
	const h = harness({
		projectIds: ["p1"],
		agentId: "a1",
		models: [model(1, { name: "First" }), model(1, { name: "Second" }), model(1, { provider: "other", name: "Other" }), model(2)],
	});
	const result = JSON.parse(JSON.stringify(await h.probe.probe(HOST)));
	assert.equal(result.count, 3);
	const keys = result.models.map((entry) => entry.provider + ":" + entry.id).sort();
	assert.deepEqual(keys, ["other:m1", "p:m1", "p:m2"]);
	assert.equal(result.models.find((entry) => entry.provider === "p" && entry.id === "m1").name, "First");
});

test("the catalog is capped at 1000 rows and stays deterministic", async () => {
	const models = [];
	for (let index = 0; index < 1200; index += 1) models.push(model(index, { id: "id" + String(index).padStart(4, "0"), provider: index % 2 === 0 ? "a" : "b" }));
	const h = harness({ projectIds: ["p1"], agentId: "a1", models });
	const result = JSON.parse(JSON.stringify(await h.probe.probe(HOST)));
	assert.equal(result.count, shared.REMOTE_MODEL_PROBE_MAX_MODELS);
	assert.equal(result.models.length, shared.REMOTE_MODEL_PROBE_MAX_MODELS);
	assert.equal(new Set(result.models.map((entry) => entry.provider + ":" + entry.id)).size, shared.REMOTE_MODEL_PROBE_MAX_MODELS);
	assert.deepEqual(result.providers, ["a", "b"]);
	// Provider-major, id-minor deterministic ordering.
	const again = JSON.parse(JSON.stringify(await h.probe.probe(HOST)));
	assert.deepEqual(
		again.models.map((entry) => entry.provider + ":" + entry.id),
		result.models.map((entry) => entry.provider + ":" + entry.id),
	);
});

test("malformed answers are FAILED (not silently empty) and the single attempt is never retried", async () => {
	const nonArray = harness({ projectIds: ["p1"], agentId: "a1", models: { models: [model(1)] } });
	assert.equal(await codeOf(nonArray.probe, HOST), shared.REMOTE_MODEL_PROBE_CODES.failed);
	assert.equal(nonArray.calls.models.length, 1);

	const allInvalid = harness({ projectIds: ["p1"], agentId: "a1", models: [null, {}, "x", model(1, { id: "" }), model(2, { provider: 42 })] });
	assert.equal(await codeOf(allInvalid.probe, HOST), shared.REMOTE_MODEL_PROBE_CODES.failed);

	const partiallyInvalid = harness({ projectIds: ["p1"], agentId: "a1", models: [null, model(1), { id: "bad" }] });
	const partial = JSON.parse(JSON.stringify(await partiallyInvalid.probe.probe(HOST)));
	assert.equal(partial.ok, true);
	assert.equal(partial.count, 1, "invalid rows are dropped, valid rows survive");

	const throws = harness({ projectIds: ["p1"], agentId: "a1", modelsThrows: true });
	assert.equal(await codeOf(throws.probe, HOST), shared.REMOTE_MODEL_PROBE_CODES.failed);
	assert.equal(throws.calls.models.length, 1, "no automatic retry on failure");
	const serialized = JSON.stringify(await throws.probe.probe(HOST));
	assert.equal(serialized.includes("secret text"), false, "runtime error text never crosses the boundary");
});

test("a hung runtime is cut off by the single bounded attempt and reported FAILED", async () => {
	const h = harness({ projectIds: ["p1"], agentId: "a1", modelsPending: true, timeoutMs: 20 });
	const started = Date.now();
	assert.equal(await codeOf(h.probe, HOST), shared.REMOTE_MODEL_PROBE_CODES.failed);
	assert.ok(Date.now() - started >= 15, "the timeout must actually bound the attempt");
	assert.equal(h.calls.models.length, 1, "timeout is not retried");
});

test("an answered empty catalog is EMPTY (a neutral state), while all-invalid rows are FAILED", async () => {
	const empty = harness({ projectIds: ["p1"], agentId: "a1", models: [] });
	assert.equal(await codeOf(empty.probe, HOST), shared.REMOTE_MODEL_PROBE_CODES.empty);
	const allInvalid = harness({ projectIds: ["p1"], agentId: "a1", models: [{ id: 1 }, { provider: 2 }] });
	assert.equal(await codeOf(allInvalid.probe, HOST), shared.REMOTE_MODEL_PROBE_CODES.failed);
});

test("entry fields are type/length bounded; invalid optional fields are dropped rather than echoed", async () => {
	const h = harness({
		projectIds: ["p1"],
		agentId: "a1",
		models: [
			model(1, {
				id: "x".repeat(513),
			}),
			model(2, {
				provider: "p".repeat(257),
			}),
			model(3, {
				name: "bad\u0000name",
				contextWindow: "128000",
				maxTokens: -1,
				reasoning: "yes",
				input: ["text", "audio"],
				images: "yes",
			}),
			model(4, {
				name: "ok",
				contextWindow: 200000.9,
				maxTokens: Number.POSITIVE_INFINITY,
				input: ["image", "text", "image"],
				images: false,
			}),
		],
	});
	const result = JSON.parse(JSON.stringify(await h.probe.probe(HOST)));
	assert.equal(result.ok, true);
	assert.equal(result.count, 2, "over-long id/provider rows are dropped");
	const badOptional = result.models.find((entry) => entry.id === "m3");
	assert.equal(badOptional.name, undefined, "control characters in name are refused, not displayed");
	assert.equal(badOptional.contextWindow, undefined, "string contextWindow is not coerced");
	assert.equal(badOptional.maxTokens, undefined);
	assert.equal(badOptional.reasoning, undefined);
	assert.equal(badOptional.input, undefined);
	assert.equal(badOptional.images, undefined);
	const good = result.models.find((entry) => entry.id === "m4");
	assert.equal(good.name, "ok");
	assert.equal(good.contextWindow, 200000, "finite token counts are floored");
	assert.equal(good.maxTokens, undefined);
	assert.deepEqual(good.input, ["image", "text"]);
	assert.equal(good.images, false);
});

test("unknown future model fields are not forwarded (allowlist, not denylist)", async () => {
	const h = harness({ projectIds: ["p1"], agentId: "a1", models: [model(1, { futureSecretField: "zzz", nested: { raw: true } })] });
	const result = JSON.parse(JSON.stringify(await h.probe.probe(HOST)));
	assert.equal(result.ok, true);
	const serialized = JSON.stringify(result);
	assert.equal(serialized.includes("futureSecretField"), false);
	assert.equal(serialized.includes("zzz"), false);
	assert.equal(serialized.includes("nested"), false);
});

test("the shared closed-code vocabulary is exactly the documented set", () => {
	assert.deepEqual(Object.values(shared.REMOTE_MODEL_PROBE_CODES).sort(), ["REMOTE_MODEL_PROBE_EMPTY", "REMOTE_MODEL_PROBE_FAILED", "REMOTE_MODEL_PROBE_NO_PROJECT", "REMOTE_MODEL_PROBE_NO_RUNTIME", "REMOTE_MODEL_PROBE_TARGET_INVALID", "REMOTE_MODEL_PROBE_UNAVAILABLE"]);
	for (const code of Object.values(shared.REMOTE_MODEL_PROBE_CODES)) assert.ok(shared.REMOTE_MODEL_PROBE_CODE_SET.has(code));
	assert.equal(shared.REMOTE_MODEL_PROBE_MAX_MODELS, 1000);
	assert.equal(shared.REMOTE_MODEL_PROBE_TIMEOUT_MS, 60_000);
});
