/**
 * 主机退役 ⇒ 远端 trust 决策清理（P4.4b）。
 *
 * 接线的落点是 `RemoteHostStore` 的退役清理位置（与 pin 删除同一处、同一重试语义）：
 * `retire()` 提交快照后调一次 `onHostRetired`，`open()`/`refresh()` 对 `retiredHostIds` 再调一次。
 * 这组用例用**真 store + 真 pin store + 真 trust 服务 + 真主机事实入口**验证这条链路，
 * 替身只有「配置文件那一段」与「引用扫描」（后者与 trust 清理无关，只是 retire 的前置条件）。
 *
 * 为什么必须补清：残留的 trust 条目永远不会再命中（host id 永不复用），但它会在设置页清单里变成
 * 一行指向不存在主机的决策——「主机没了，决策还挂着」正是本批要求消灭的状态。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");
const { createRemoteProjectTrustHostFacts } = loadTsCommonJs("src/main/remote/RemoteProjectTrustHostFacts.ts");
const { createRemoteProjectTrustService } = loadTsCommonJs("src/main/remote/RemoteProjectTrustService.ts");

const REMOTE_ROOT = "/srv/app";
const NOW = () => Date.parse("2026-10-01T00:00:00.000Z");

/** 沙箱里造的数组/对象与测试文件原型不同（`deepStrictEqual` 会比较 prototype）：比较前复制成本地值。 */
const local = (value) => JSON.parse(JSON.stringify(value));

function sshString(text) {
	const value = Buffer.isBuffer(text) ? text : Buffer.from(text);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(value.length);
	return Buffer.concat([size, value]);
}

/** 与 remoteHostStoreLifecycle.test.mjs 同款的已验证 pin 候选（含真指纹与 known_hosts 摘要）。 */
function authenticatedCandidate(id) {
	const pinAlias = `pideck-${id}`;
	const key = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 29))]);
	const bytes = Buffer.from(`${pinAlias} ssh-ed25519 ${key.toString("base64")}\n`);
	return {
		hostName: "pi.example.invalid",
		user: "alice",
		port: 2222,
		pinAlias,
		routeDigest: createHash("sha256").update("route-retire-trust").digest("hex"),
		knownHostsSha256: createHash("sha256").update(bytes).digest("hex"),
		knownHostsBase64: bytes.toString("base64"),
		hostKeyFingerprints: [`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`],
	};
}

/** 配置文件那一段的替身（`raw` 就是落盘值，undefined = 旧文件缺这一段）。 */
function createSettingsSection() {
	const state = { raw: undefined };
	return {
		port: {
			read: () => state.raw,
			write: async (records) => {
				state.raw = JSON.parse(JSON.stringify(records));
			},
		},
		raw: () => state.raw,
	};
}

/**
 * 一台已验证的主机 + 真 trust 服务 + 退役钩子，全部共用同一个 userData 目录。
 * `onHostRetired` 可被用例替换，用来模拟「清理这一步失败」。
 */
async function verifiedHostWithTrust(t, onHostRetired) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-host-retire-trust-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const verifier = async (_route, alias) => authenticatedCandidate(alias.slice("pideck-".length));
	const pinStore = new SshHostPinStore(directory, { verifier });
	t.after(() => pinStore.dispose());
	const references = { referencedHostIds: async () => new Set() };
	const settings = createSettingsSection();
	const service = createRemoteProjectTrustService({ settings: settings.port, hostFacts: createRemoteProjectTrustHostFacts({ userDataDir: directory }), now: NOW });
	const store = await RemoteHostStore.open(directory, {
		pinStore,
		references,
		onHostRetired: onHostRetired ?? ((hostId) => service.forgetHost(hostId)),
	});

	const profile = await store.createDraft({ label: "Build Pi", sshHost: "build-pi", user: "alice", port: 2222, connectTimeoutMs: 15000 }, 0);
	const offer = await store.offerPin(profile.id, 7, 1);
	await store.confirmPin({ hostId: profile.id, senderId: 7, requestId: offer.requestId, choice: "approve" }, 1);
	return { directory, store, pinStore, references, settings, service, profile, verifier };
}

test("退役一台主机：它的 trust 决策同时消失，且清单不再出现该主机", async (t) => {
	const { store, settings, service, profile } = await verifiedHostWithTrust(t);

	// 决策用的 endpoint 事实来自真实目录（已验证 pin 的 verifiedEndpoint），不是手搓的替身。
	const entry = await service.decide({ hostId: profile.id, remoteRoot: REMOTE_ROOT, decision: "approve" });
	assert.equal(entry.status, "active");
	assert.equal(entry.hostLabel, "Build Pi", "主机显示名来自目录");
	assert.equal(await service.trustOverride({ hostId: profile.id, remoteRoot: REMOTE_ROOT }), "approve");

	// 退役：disable 成墓碑 → retire 压缩成 retired id。
	await store.disable(profile.id, store.getSnapshot().revision);
	await store.retire(profile.id, store.getSnapshot().revision);
	assert.deepEqual([...store.getSnapshot().retiredHostIds], [profile.id], "主机已退役");

	assert.deepEqual(settings.raw(), [], "该主机的 trust 决策必须随主机一起清掉（且落盘）");
	assert.deepEqual(local(await service.list()), []);
	assert.equal(await service.trustOverride({ hostId: profile.id, remoteRoot: REMOTE_ROOT }), undefined);
});

test("提交成功但清理这一步失败 ⇒ 下一次 open 的重试链路补清（与残留 pin 同一条路）", async (t) => {
	const { directory, store, pinStore, references, settings, service, profile, verifier } = await verifiedHostWithTrust(t, async () => {
		// 模拟清理失败（写盘失败 / 进程被杀）：钩子抛错必须被吞掉，不能反过来把目录打成 needs-repair。
		throw new Error("cleanup failed");
	});
	await service.decide({ hostId: profile.id, remoteRoot: REMOTE_ROOT, decision: "approve" });
	await store.disable(profile.id, store.getSnapshot().revision);
	await store.retire(profile.id, store.getSnapshot().revision);
	assert.equal(settings.raw().length, 1, "这一次清理没成功：决策还在（真实失败形态）");
	assert.equal(store.getSnapshot().status, "ready", "钩子抛错不得影响主机目录的状态");

	// 下一次打开目录（带真钩子）时，pruneRetiredPins 的同一趟重试把残留清掉。
	const reopenedPinStore = new SshHostPinStore(directory, { verifier });
	t.after(() => reopenedPinStore.dispose());
	await RemoteHostStore.open(directory, { pinStore: reopenedPinStore, references, onHostRetired: (hostId) => service.forgetHost(hostId) });
	assert.deepEqual(settings.raw(), [], "残留决策在下一次 open 被补清");
	// pinStore 变量只是为了让 fixture 的生命周期显式（dispose 由 t.after 登记）。
	assert.ok(pinStore !== undefined);
});
