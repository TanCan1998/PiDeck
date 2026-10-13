import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { bindRemoteUserMessageTimestamp } = loadTsCommonJs("src/main/pi/remoteMessageTimestamp.ts");
const { StoppedMessageIdentityCache } = loadTsCommonJs("src/main/pi/stoppedMessageIdentity.ts");
const live = (id = "request-1") => ({ id, role: "user", text: "hello", timestamp: 1_700_000_010_000, meta: { requestId: id } });
const persisted = { id: "viewer-history-u1", role: "user", text: "hello", timestamp: 1_700_000_000_000, meta: { entryId: "u1" } };

test("remote event timestamps survive stop despite clock skew while UI identity/time remain unchanged", () => {
	const messages = [live()];
	assert.equal(bindRemoteUserMessageTimestamp(messages, persisted), 0);
	assert.equal(messages[0].timestamp, 1_700_000_010_000);
	assert.equal(messages[0].id, "request-1");
	assert.equal(messages[0].meta.requestId, "request-1");
	const cache = new StoppedMessageIdentityCache();
	cache.capture("remote-key", messages);
	const identity = cache.get("remote-key", "request-1");
	assert.equal(identity.timestamp, persisted.timestamp);
	assert.equal("text" in identity, false);
});

test("duplicate pending messages, mismatched images and invalid events cannot claim a timestamp", () => {
	for (const messages of [[live("one"), live("two")], [{ ...live(), images: [{ type: "image", mimeType: "image/png", data: "AAAA" }] }]]) {
		assert.equal(bindRemoteUserMessageTimestamp(messages, persisted), undefined);
		assert.equal(messages[0].meta.persistedTimestamp, undefined);
	}
	for (const message of [undefined, { ...persisted, role: "assistant" }, { ...persisted, timestamp: NaN }, { ...persisted, text: "different" }]) {
		const messages = [live()];
		assert.equal(bindRemoteUserMessageTimestamp(messages, message), undefined);
		assert.equal(messages[0].meta.persistedTimestamp, undefined);
	}
});

test("a claimed previous prompt and projected history cannot absorb the next identical prompt event", () => {
	const messages = [live("old")];
	assert.equal(bindRemoteUserMessageTimestamp(messages, persisted), 0);
	messages.push({ ...persisted }, live("new"));
	assert.equal(bindRemoteUserMessageTimestamp(messages, { ...persisted, timestamp: persisted.timestamp + 1000 }), 2);
	assert.equal(messages[0].meta.persistedTimestamp, persisted.timestamp);
	assert.equal(messages[2].meta.persistedTimestamp, persisted.timestamp + 1000);
	assert.equal(bindRemoteUserMessageTimestamp(messages, persisted), undefined);
});

test("invalid persisted meta timestamps do not poison local identity capture", () => {
	for (const timestamp of [undefined, NaN, Infinity, "not a number"]) {
		const cache = new StoppedMessageIdentityCache();
		const message = { ...live(), meta: { persistedTimestamp: timestamp } };
		cache.capture("local", [message]);
		assert.equal(cache.get("local", message.id).timestamp, message.timestamp);
	}
});
