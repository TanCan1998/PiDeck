import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { beginRemoteFileLoad, updateRemoteFileDraft, completeRemoteFileSave, remoteFileDraftKey, remoteFileDraftDirty, editRemoteFileDraft } = loadTsCommonJs("src/renderer/src/utils/remoteFileDrafts.ts");
function opened(map, project, path, content = "disk") {
	const next = beginRemoteFileLoad(map, project, path);
	const key = remoteFileDraftKey(project, path);
	return updateRemoteFileDraft(next, key, next.get(key).generation, (draft) => ({ ...draft, phase: "ready", version: "opaque", content, savedContent: content }));
}

test("same-name files in two projects never mix; reopening a dirty draft does not reread or reset it", () => {
	let map = opened(new Map(), "a", "code.ts", "a disk");
	const key = remoteFileDraftKey("a", "code.ts");
	map = updateRemoteFileDraft(map, key, 1, (draft) => ({ ...draft, content: "a draft" }));
	map = opened(map, "b", "code.ts", "b disk");
	map = beginRemoteFileLoad(map, "a", "code.ts");
	assert.equal(map.get(key).content, "a draft");
	assert.equal(map.get(remoteFileDraftKey("b", "code.ts")).content, "b disk");
	assert.equal(remoteFileDraftDirty(map.get(key)), true);
});

test("save completion advances only the baseline and preserves edits made while saving", () => {
	const map = opened(new Map(), "a", "code.ts");
	const draft = map.get(remoteFileDraftKey("a", "code.ts"));
	const completed = completeRemoteFileSave({ ...draft, phase: "saving", content: "newer draft" }, "submitted", "next token");
	assert.equal(completed.content, "newer draft");
	assert.equal(completed.savedContent, "submitted");
	assert.equal(completed.version, "next token");
	assert.equal(remoteFileDraftDirty(completed), true);
});

test("conflict preserves complete draft; reload failure also keeps it; late results cannot cross generations", () => {
	const key = remoteFileDraftKey("a", "code.ts");
	let map = opened(new Map(), "a", "code.ts");
	map = updateRemoteFileDraft(map, key, 1, (draft) => ({ ...draft, content: "my unsaved changes", errorCode: "REMOTE_FILE_CHANGED", blocked: true }));
	map = beginRemoteFileLoad(map, "a", "code.ts", true);
	assert.equal(map.get(key).content, "my unsaved changes");
	map = updateRemoteFileDraft(map, key, 1, (draft) => ({ ...draft, content: "stale result" }));
	assert.equal(map.get(key).content, "my unsaved changes");
	map = updateRemoteFileDraft(map, key, 2, (draft) => ({ ...draft, phase: "failed", errorCode: "SSH_HOST_NOT_READY", blocked: true }));
	assert.equal(map.get(key).content, "my unsaved changes");
	assert.equal(remoteFileDraftDirty(map.get(key)), true);
});

test("draft budget refuses a sixth dirty file; it may evict only clean ready documents", () => {
	let map = new Map();
	for (let index = 0; index < 5; index++) {
		map = opened(map, "a", `${index}.ts`);
		const key = remoteFileDraftKey("a", `${index}.ts`);
		map = updateRemoteFileDraft(map, key, 1, (draft) => ({ ...draft, content: "dirty" }));
	}
	assert.throws(() => beginRemoteFileLoad(map, "b", "six.ts"), /REMOTE_FILE_DRAFT_LIMIT/);
	assert.equal(map.size, 5);
	const key = remoteFileDraftKey("a", "0.ts");
	map = updateRemoteFileDraft(map, key, 1, (draft) => completeRemoteFileSave(draft, "dirty", "saved"));
	const next = beginRemoteFileLoad(map, "b", "six.ts");
	assert.equal(next.size, 5);
	assert.equal(next.has(key), false);
	assert.equal(next.get(remoteFileDraftKey("a", "1.ts")).content, "dirty");
});

test("oversized input is not retained and the existing draft/version survive", () => {
	const draft = opened(new Map(), "a", "code.ts").get(remoteFileDraftKey("a", "code.ts"));
	const rejected = editRemoteFileDraft(draft, "x".repeat(262145));
	assert.equal(rejected.content, "disk");
	assert.equal(rejected.version, "opaque");
	assert.equal(rejected.errorCode, "REMOTE_FILE_DRAFT_TOO_LARGE");
	assert.equal(rejected.rejectedEdits, 1);
	assert.equal(editRemoteFileDraft(rejected, "x".repeat(262145)).rejectedEdits, 2);
	assert.equal(editRemoteFileDraft(rejected, "small input").errorCode, undefined);
});

test("failed opens with no user draft do not permanently exhaust the five-file budget", () => {
	let map = new Map();
	for (let index = 0; index < 5; index++) {
		map = beginRemoteFileLoad(map, "a", `${index}.bin`);
		const key = remoteFileDraftKey("a", `${index}.bin`);
		map = updateRemoteFileDraft(map, key, 1, (draft) => ({ ...draft, phase: "failed", errorCode: "REMOTE_FILE_NOT_TEXT" }));
	}
	const next = beginRemoteFileLoad(map, "a", "code.ts");
	assert.equal(next.size, 5);
	assert.ok(next.has(remoteFileDraftKey("a", "code.ts")));
});

test("reload cannot supersede a pending save", () => {
	let map = opened(new Map(), "a", "code.ts");
	const key = remoteFileDraftKey("a", "code.ts");
	map = updateRemoteFileDraft(map, key, 1, (draft) => ({ ...draft, phase: "saving" }));
	assert.throws(() => beginRemoteFileLoad(map, "a", "code.ts", true), /REMOTE_FILE_BUSY/);
});
