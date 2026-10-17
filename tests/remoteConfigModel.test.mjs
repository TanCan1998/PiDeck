import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Batch B pure renderer model: merge-patch parsing (incl. security addendum A1 reserved keys), the panel state
 * machine (conflict keeps the draft, unconfirmed is terminal, reload keeps the edit), DTO validation and the
 * closed-code copy mapping. No React, no Electron.
 */

const model = loadTsCommonJs("src/renderer/src/config/remoteConfigModel.ts");
const shared = loadTsCommonJs("src/shared/piConfig.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const FILE = "models";
const VERSION = "a".repeat(64);
const SNAPSHOT = () => ({ kind: "remote", hostId: HOST, file: FILE, version: VERSION, sha256: VERSION, data: { providers: { p: { apiKey: "configured" } } }, secrets: [{ path: "providers.p.apiKey", status: "configured" }] });
const READY = () => ({ phase: "ready", snapshot: SNAPSHOT(), patchText: "" });

function reduce(state, ...actions) {
	return actions.reduce((current, action) => model.reduceRemoteConfigPanel(current, action), state);
}

test("merge-patch text accepts only a JSON object and refuses reserved keys recursively", () => {
	assert.equal(model.parseMergePatchText("").reason, "empty");
	assert.equal(model.parseMergePatchText("  ").reason, "empty");
	assert.equal(model.parseMergePatchText("{ not json").reason, "syntax");
	assert.equal(model.parseMergePatchText("[]").reason, "not-object");
	assert.equal(model.parseMergePatchText("42").reason, "not-object");
	assert.equal(model.parseMergePatchText('{"theme":"dark"}').ok, true);
	assert.deepEqual(JSON.parse(JSON.stringify(model.parseMergePatchText('{"theme":"dark"}').patch)), { theme: "dark" });

	// A1: an own __proto__ key survives JSON.parse and would hit the legacy prototype setter during a merge.
	for (const text of ['{"__proto__":{"polluted":true}}', '{"nested":{"__proto__":{}}}', '{"arr":[{"constructor":{"prototype":{}}}]}']) {
		const parsed = model.parseMergePatchText(text);
		assert.equal(parsed.ok, false, text);
		assert.equal(parsed.reason, "reserved-key", text);
	}
	// A2-adjacent: legitimate model capability keys are NOT rejected here (the secret matcher is main/helper-side).
	assert.equal(model.parseMergePatchText('{"providers":{"p":{"maxTokens":32000,"tokenizer":"bpe"}}}').ok, true);
});

test("dirty/editable/save rules follow the draft and phase", () => {
	assert.equal(model.remoteConfigPatchDirty(""), false);
	assert.equal(model.remoteConfigPatchDirty("  {}  "), false);
	assert.equal(model.remoteConfigPatchDirty('{"a":1}'), true);

	const loading = model.initialRemoteConfigPanelState;
	assert.equal(model.remoteConfigCanEdit(loading), false);
	assert.equal(model.remoteConfigCanSave(loading), false);
	const unsupported = model.reduceRemoteConfigPanel(loading, { type: "unsupported" });
	assert.equal(model.remoteConfigCanEdit(unsupported), false);
	const ready = READY();
	assert.equal(model.remoteConfigCanEdit(ready), true);
	assert.equal(model.remoteConfigCanSave(ready), true);
	const saving = reduce(ready, { type: "patchChanged", text: '{"a":1}' }, { type: "saveStarted" });
	assert.equal(saving.phase, "saving");
	assert.equal(model.remoteConfigCanEdit(saving), false);
	assert.equal(model.remoteConfigCanSave(saving), false);
});

test("a version conflict keeps the edit; an explicit reload keeps it and swaps only the baseline", () => {
	const conflict = reduce(READY(), { type: "patchChanged", text: '{"theme":"dark"}' }, { type: "saveStarted" }, { type: "conflict", code: shared.REMOTE_CONFIG_CODES.versionConflict });
	assert.equal(conflict.phase, "conflict");
	assert.equal(conflict.patchText, '{"theme":"dark"}');
	assert.equal(model.remoteConfigCanSave(conflict), true, "the kept draft may be submitted again after an explicit reload");
	assert.equal(model.remoteConfigPatchDirty(conflict.patchText), true);

	const next = { ...SNAPSHOT(), version: "b".repeat(64), sha256: "b".repeat(64) };
	const reloaded = reduce(conflict, { type: "reloadStarted" }, { type: "loaded", snapshot: next });
	assert.equal(reloaded.phase, "ready");
	assert.equal(reloaded.snapshot.version, "b".repeat(64), "reload swaps the baseline version");
	assert.equal(reloaded.patchText, '{"theme":"dark"}', "reload never discards the user's draft");
});

test("RESULT_UNCONFIRMED is terminal for the draft: no retry until an explicit reload", () => {
	const unconfirmed = reduce(READY(), { type: "patchChanged", text: '{"a":1}' }, { type: "saveStarted" }, { type: "unconfirmed", code: shared.REMOTE_CONFIG_CODES.resultUnconfirmed });
	assert.equal(unconfirmed.phase, "unconfirmed");
	assert.equal(unconfirmed.patchText, '{"a":1}');
	assert.equal(model.remoteConfigCanSave(unconfirmed), false, "a possibly-applied write is never retried automatically");
	const retry = model.reduceRemoteConfigPanel(unconfirmed, { type: "saveStarted" });
	assert.equal(retry.phase, "unconfirmed", "saveStarted is ignored outside ready/conflict/failed");
	const reloaded = reduce(unconfirmed, { type: "reloadStarted" }, { type: "loaded", snapshot: { ...SNAPSHOT(), version: "c".repeat(64) } });
	assert.equal(reloaded.phase, "ready");
	assert.equal(model.remoteConfigCanSave(reloaded), true);
});

test("a definite failure keeps the draft and allows retry; save success clears it and reloads", () => {
	const failed = reduce(READY(), { type: "patchChanged", text: '{"a":1}' }, { type: "saveStarted" }, { type: "saveFailed", code: shared.REMOTE_CONFIG_CODES.hostNotReady });
	assert.equal(failed.phase, "failed");
	assert.equal(failed.patchText, '{"a":1}');
	assert.equal(model.remoteConfigCanSave(failed), true, "a definite failure is safe to retry");
	const saved = reduce(READY(), { type: "patchChanged", text: '{"a":1}' }, { type: "saveStarted" }, { type: "saved" });
	assert.equal(saved.phase, "loading", "the panel re-reads after a successful patch");
	assert.equal(saved.patchText, "", "the applied patch is consumed only on success");
	assert.equal(saved.snapshot.version, VERSION, "stale data is not replaced until the re-read lands");
});

test("load results validate the sanitized remote DTO and fail closed on local/foreign shapes", () => {
	assert.equal(model.readRemoteConfigSnapshot({ remote: SNAPSHOT() }, { hostId: HOST, file: FILE }).kind, "remote");
	assert.equal(model.readRemoteConfigSnapshot({ raw: "{}", parsed: {} }, { hostId: HOST, file: FILE }), "unsupported", "a local DTO without remote metadata means the route was not wired");
	assert.equal(model.readRemoteConfigSnapshot({ remote: { ...SNAPSHOT(), hostId: "22222222-2222-4222-8222-222222222222" } }, { hostId: HOST, file: FILE }), "invalid", "host echo must match the request");
	assert.equal(model.readRemoteConfigSnapshot({ remote: { ...SNAPSHOT(), file: "settings" } }, { hostId: HOST, file: FILE }), "invalid", "file echo must match the request");
	assert.equal(model.readRemoteConfigSnapshot({ remote: { ...SNAPSHOT(), version: 1 } }, { hostId: HOST, file: FILE }), "invalid");
	assert.equal(model.readRemoteConfigSnapshot({ remote: { ...SNAPSHOT(), secrets: null } }, { hostId: HOST, file: FILE }), "invalid");
	assert.equal(model.readRemoteConfigSnapshot(null, { hostId: HOST, file: FILE }), "invalid");

	const receipt = { kind: "remote", hostId: HOST, file: FILE, version: VERSION, sha256: VERSION };
	assert.equal(model.readRemoteConfigWriteReceipt({ valid: true, remote: receipt }).version, VERSION);
	assert.equal(model.readRemoteConfigWriteReceipt({ valid: true }), "unsupported");
	assert.equal(model.readRemoteConfigWriteReceipt({ remote: { ...receipt, version: 3 } }), "invalid");
	assert.equal(model.readRemoteConfigWriteReceipt(null), "invalid");
});

test("the closed-code copy mapping covers exactly the eight shared codes", () => {
	const expected = [
		[shared.REMOTE_CONFIG_CODES.targetInvalid, "remoteConfig.errorTargetInvalid"],
		[shared.REMOTE_CONFIG_CODES.hostNotReady, "remoteConfig.errorHostNotReady"],
		[shared.REMOTE_CONFIG_CODES.unavailable, "remoteConfig.errorUnavailable"],
		[shared.REMOTE_CONFIG_CODES.unsupported, "remoteConfig.errorUnsupported"],
		[shared.REMOTE_CONFIG_CODES.fileInvalid, "remoteConfig.errorFileInvalid"],
		[shared.REMOTE_CONFIG_CODES.versionConflict, "remoteConfig.errorVersionConflict"],
		[shared.REMOTE_CONFIG_CODES.resultUnconfirmed, "remoteConfig.errorResultUnconfirmed"],
		[shared.REMOTE_CONFIG_CODES.providerOperationUnsupported, "remoteConfig.errorProviderUnsupported"],
	];
	for (const [code, key] of expected) assert.equal(model.remoteConfigErrorKey(code), key, code);
	assert.equal(model.remoteConfigErrorKey("SOMETHING_ELSE"), undefined);
	// Every mapped key must render in both dictionaries (wiring test pins parity); the mapping is closed.
	assert.equal(new Set(expected.map((entry) => entry[1])).size, expected.length);
});

test("formatting helpers present short digests and pretty JSON without leaking raw bytes", () => {
	assert.equal(model.formatConfigDocument({ a: 1 }), '{\n  "a": 1\n}');
	assert.equal(model.shortConfigDigest(VERSION), VERSION.slice(0, 12) + "…");
	assert.equal(model.shortConfigDigest("abc"), "abc");
	assert.equal(model.shortConfigDigest(undefined), "");
});
