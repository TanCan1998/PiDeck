/**
 * 远端项目 trust 的存储与四态（P4.4b）。
 *
 * 这组用例锁的是「决策怎么存、怎么读、什么时候算作废、主机没了怎么清理」——全部走
 * `RemoteProjectTrustService` 的公开接口（不碰私有函数），持久化用真端口语义的替身：
 * 一个 `{ read(), write() }` 对象就是 settings.json 里那一段，重建 service 即等价于「重启后仍在」。
 *
 * 关键判据（对应 docs/remote-trust-plan.md §2 / §3 决策 2/4/5）：
 * - 未决策 / 材料缺失 / endpoint 变更（作废）⇒ `trustOverride()` 返回 undefined ⇒ spawn 一个 flag 都不加；
 * - 同 host + 同根但 endpoint 变了要能被**检测出来并说明原因**（stale + reason），不是悄悄变回未决策；
 * - 主机被移除/退役 ⇒ 该主机的条目被清掉（与 pin 清理同一位置，见 RemoteHostStore 的 onHostRetired）；
 * - 旧配置缺这一段 = 空表（自然兼容，没有迁移脚本）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteProjectTrustService } = loadTsCommonJs("src/main/remote/RemoteProjectTrustService.ts");
const { REMOTE_PROJECT_TRUST_MAX_ENTRIES } = loadTsCommonJs("src/main/remote/RemoteProjectTrust.ts");

const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_HOST_ID = "9c1d5f7a-2b3e-4c5d-8e9f-0a1b2c3d4e5f";
const ROOT = "/srv/app";
const OTHER_ROOT = "/srv/other";

/** endpoint 身份材料（pin 的密码学事实 + 路由事实）；`fingerprint` 一变就是「另一台 endpoint」。 */
const endpoint = (fingerprint = "SHA256:zzz") => ({
	hostName: "10.81.2.15",
	user: "zhadainian",
	port: 22,
	pinAlias: `pideck-${HOST_ID}`,
	routeDigest: "a".repeat(64),
	knownHostsSha256: "b".repeat(64),
	hostKeyFingerprints: [fingerprint],
});

/**
 * settings.json 那一段的替身：`raw` 就是落盘值（undefined = 旧文件缺这一段）。
 * `write` 之后重新构造 service 即「重启应用」。
 */
function createSettingsSection(initial) {
	const state = { raw: initial };
	return {
		port: {
			read: () => state.raw,
			write: async (records) => {
				// 深拷一份：与真实 SettingsStore 一样，写盘的是快照而不是可变引用。
				state.raw = JSON.parse(JSON.stringify(records));
			},
		},
		raw: () => state.raw,
	};
}

/** 主机目录替身：只给 service 需要的那一个入口。 */
function createHostFacts(hosts, options = {}) {
	return {
		async catalog() {
			if (options.unavailable === true) return undefined;
			const retired = options.retired ?? [];
			return {
				hosts: hosts.map((host) => ({
					hostId: host.hostId,
					label: host.label,
					...(host.endpoint === undefined ? {} : { endpoint: host.endpoint }),
				})),
				retired,
				complete: options.complete ?? true,
			};
		},
	};
}

const verifiedHost = (hostId, label, fingerprint) => ({ hostId, label, endpoint: endpoint(fingerprint) });

/**
 * 沙箱（vm）里造出来的数组/对象与测试文件的原型不是同一个（`deepStrictEqual` 会比较 prototype）：
 * 要比较结构时先复制成本地值，比较的是内容而不是「谁创建的」。
 */
const local = (value) => JSON.parse(JSON.stringify(value));

function createService(settings, hosts, options = {}) {
	return createRemoteProjectTrustService({
		settings: settings.port,
		hostFacts: createHostFacts(hosts, options),
		now: () => Date.parse("2026-10-01T00:00:00.000Z"),
	});
}

test("旧配置缺这一段 ⇒ 空表；未决策时一个 flag 都不加", async () => {
	const settings = createSettingsSection(undefined);
	const service = createService(settings, [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")]);
	assert.deepEqual(local(await service.list()), []);
	assert.equal(await service.trustOverride({ hostId: HOST_ID, remoteRoot: ROOT }), undefined);
	assert.equal(settings.raw(), undefined, "只读路径不得写盘");
});

test("记录决策后：清单可见、落盘、重启后仍在，且 override 就位", async () => {
	const settings = createSettingsSection(undefined);
	const hosts = [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")];
	const service = createService(settings, hosts);

	const entry = await service.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "approve" });
	assert.equal(entry.status, "active");
	assert.equal(entry.decision, "approve");
	assert.equal(entry.hostLabel, "Build box", "清单只展示主机显示名，不带任何 endpoint 材料");
	assert.equal(entry.canonicalRoot, ROOT);
	assert.equal(entry.decidedAt, "2026-10-01T00:00:00.000Z");
	assert.equal(entry.staleReason, undefined);
	// 渲染层可见的条目里不得出现 trust key / endpoint 摘要。
	assert.deepEqual(Object.keys(entry).sort(), ["canonicalRoot", "decidedAt", "decision", "hostId", "hostLabel", "status"]);

	// 落盘形态：key + 三个零件都在（后三者让「同 host+同根但 endpoint 变了」可被检测）。
	const persisted = settings.raw();
	assert.equal(persisted.length, 1);
	assert.equal(persisted[0].hostId, HOST_ID);
	assert.equal(persisted[0].canonicalRoot, ROOT);
	assert.equal(persisted[0].endpointDigest.length, 32);
	assert.equal(persisted[0].trustKey, `${HOST_ID}::${persisted[0].endpointDigest}::${ROOT}`);

	// 「重启」：同一段配置 + 同一份主机事实 ⇒ 决策还在，override 生效。
	const restarted = createService(settings, hosts);
	assert.equal(await restarted.trustOverride({ hostId: HOST_ID, remoteRoot: ROOT }), "approve");
	assert.equal((await restarted.list())[0].status, "active");
});

test("拒绝也是一种决策：override = no-approve，清单状态是已拒绝", async () => {
	const settings = createSettingsSection(undefined);
	const hosts = [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")];
	const service = createService(settings, hosts);
	const entry = await service.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "deny" });
	assert.equal(entry.decision, "deny");
	assert.equal(await service.trustOverride({ hostId: HOST_ID, remoteRoot: ROOT }), "no-approve");
});

test("同 host + 同根但 endpoint 变更 ⇒ 视为未决策，并且能说出「已作废」与原因", async () => {
	const settings = createSettingsSection(undefined);
	const service = createService(settings, [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")]);
	await service.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "approve" });

	// 换机 / 指纹变 / 用户端口变都落在「endpoint 身份」里；这里用指纹变化代表整类变化。
	const afterChange = createService(settings, [verifiedHost(HOST_ID, "Build box", "SHA256:other")]);
	assert.equal(await afterChange.trustOverride({ hostId: HOST_ID, remoteRoot: ROOT }), undefined, "endpoint 变更后旧决策不得命中（fail-closed，不自动继承）");
	const [entry] = await afterChange.list();
	assert.equal(entry.status, "stale");
	assert.equal(entry.staleReason, "endpoint-changed", "作废必须带可解释的原因，而不是只消失");
	assert.equal(entry.decision, "approve", "旧决策如实留在清单里供审计");
});

test("换 endpoint 后重新决策：同一 (host, 根) 只留一条（覆盖已作废的那条）", async () => {
	const settings = createSettingsSection(undefined);
	const service = createService(settings, [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")]);
	await service.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "approve" });
	const afterChange = createService(settings, [verifiedHost(HOST_ID, "Build box", "SHA256:other")]);
	await afterChange.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "deny" });

	const entries = await afterChange.list();
	assert.equal(entries.length, 1, "同一主机同一项目根只留当前决策，否则清单会同时显示「已作废」与「已拒绝」");
	assert.equal(entries[0].status, "active");
	assert.equal(entries[0].decision, "deny");
	assert.equal(settings.raw().length, 1);
});

test("撤销：删掉该 (host, 根) 的决策（含已作废的），再撤销返回 removed=false", async () => {
	const settings = createSettingsSection(undefined);
	const hosts = [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")];
	const service = createService(settings, hosts);
	await service.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "approve" });
	assert.equal(await service.revoke({ hostId: HOST_ID, remoteRoot: ROOT }), true);
	assert.deepEqual(local(await service.list()), []);
	assert.equal(await createService(settings, hosts).trustOverride({ hostId: HOST_ID, remoteRoot: ROOT }), undefined, "撤销在下一次解析即生效，不需要重启");
	assert.equal(await service.revoke({ hostId: HOST_ID, remoteRoot: ROOT }), false);

	// 已作废的条目同样可撤销（用户不必先重新决策再撤销）。
	await service.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "approve" });
	const afterChange = createService(settings, [verifiedHost(HOST_ID, "Build box", "SHA256:other")]);
	assert.equal((await afterChange.list())[0].status, "stale");
	assert.equal(await afterChange.revoke({ hostId: HOST_ID, remoteRoot: ROOT }), true);
	assert.deepEqual(settings.raw(), []);
});

test("主机退役清理：该主机的条目清掉，其它主机保留", async () => {
	const settings = createSettingsSection(undefined);
	const hosts = [verifiedHost(HOST_ID, "Build box", "SHA256:zzz"), verifiedHost(OTHER_HOST_ID, "Laptop", "SHA256:yyy")];
	const service = createService(settings, hosts);
	await service.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "approve" });
	await service.decide({ hostId: OTHER_HOST_ID, remoteRoot: OTHER_ROOT, decision: "deny" });

	// 主机删除的落点接上（RemoteHostStore.retire / pruneRetiredPins 的 onHostRetired 钩子）。
	await service.forgetHost(HOST_ID);
	const entries = await service.list();
	assert.deepEqual(
		local(entries).map((entry) => [entry.hostId, entry.canonicalRoot]),
		[[OTHER_HOST_ID, OTHER_ROOT]],
	);
	assert.equal(settings.raw().length, 1, "清理必须落盘，否则下次启动又会出现");
	// 幂等：再清一次不写盘、不报错。
	const before = JSON.stringify(settings.raw());
	await service.forgetHost(HOST_ID);
	assert.equal(JSON.stringify(settings.raw()), before);
});

test("清单对账：目录可信时丢弃「已退役 / 目录里没有」的条目；目录不可信时不删", async () => {
	const settings = createSettingsSection(undefined);
	const hosts = [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")];
	const service = createService(settings, hosts);
	await service.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "approve" });

	// 目录可信 + 该 host 已退役 ⇒ 条目丢弃并落盘（崩溃留下的残留在这里补清）。
	const retiredView = createService(settings, [], { retired: [HOST_ID] });
	assert.deepEqual(local(await retiredView.list()), []);
	assert.deepEqual(settings.raw(), [], "对账结果必须落盘");

	// 目录不可信（needs-repair 的回退视图）⇒ 一个条目都不删。
	await service.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "approve" });
	const untrusted = createService(settings, [], { complete: false });
	assert.equal((await untrusted.list()).length, 1, "不可信目录不得被当成「主机没了」");
	assert.equal(settings.raw().length, 1, "不可信目录下写盘也不允许（列表只读）");
});

test("材料缺失（主机目录读不出来 / 该主机未验证）⇒ 未决策；decide 抛稳定码且不落盘", async () => {
	const settings = createSettingsSection(undefined);
	const unavailable = createService(settings, [], { unavailable: true });
	assert.equal(await unavailable.trustOverride({ hostId: HOST_ID, remoteRoot: ROOT }), undefined);
	assert.deepEqual(local(await unavailable.list()), []);
	await assert.rejects(() => unavailable.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "approve" }), /REMOTE_PROJECT_TRUST_ENDPOINT_UNVERIFIED/);
	assert.equal(settings.raw(), undefined, "拿不到 pin 事实时不得写入一条永远命中不了的条目");

	// 主机在目录里但未验证（没有 verifiedEndpoint）同样不可判定。
	const unverified = createService(settings, [{ hostId: HOST_ID, label: "Draft box" }]);
	assert.equal(await unverified.trustOverride({ hostId: HOST_ID, remoteRoot: ROOT }), undefined);
	await assert.rejects(() => unverified.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "approve" }), /REMOTE_PROJECT_TRUST_ENDPOINT_UNVERIFIED/);
});

test("项目根必须规范化：等价写法命中同一条决策，相对路径与畸形 hostId 被拒绝", async () => {
	const settings = createSettingsSection(undefined);
	const hosts = [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")];
	const service = createService(settings, hosts);
	await service.decide({ hostId: HOST_ID, remoteRoot: "/srv/app/./sub/../", decision: "approve" });
	const [entry] = await service.list();
	assert.equal(entry.canonicalRoot, ROOT, "落盘的项目根必须是规范形式（与 trust key 同源）");
	assert.equal(await service.trustOverride({ hostId: HOST_ID, remoteRoot: "/srv//app/" }), "approve");

	await assert.rejects(() => service.decide({ hostId: HOST_ID, remoteRoot: "srv/app", decision: "approve" }), /REMOTE_PROJECT_TRUST_ROOT_INVALID/);
	await assert.rejects(() => service.decide({ hostId: "not-a-host-id", remoteRoot: ROOT, decision: "approve" }), /REMOTE_PROJECT_TRUST_HOST_INVALID/);
	await assert.rejects(() => service.decide({ hostId: HOST_ID, remoteRoot: ROOT, decision: "maybe" }), /REMOTE_PROJECT_TRUST_DECISION_INVALID/);
});

test("脏配置条目逐条丢弃：非数组 / 字段畸形 / key 与零件不自洽都不生效", async () => {
	const goodRecord = {
		trustKey: "",
		hostId: HOST_ID,
		canonicalRoot: ROOT,
		endpointDigest: "c".repeat(32),
		decision: "approve",
		decidedAt: "2026-10-01T00:00:00.000Z",
	};
	goodRecord.trustKey = `${HOST_ID}::${goodRecord.endpointDigest}::${ROOT}`;
	const dirty = [
		goodRecord,
		// 非对象
		"approve",
		// key 与零件不自洽（手工塞一条「信任」不该生效）
		{ ...goodRecord, trustKey: `${HOST_ID}::${"d".repeat(32)}::${ROOT}` },
		// 非法 decision
		{ ...goodRecord, decision: "allow" },
		// 非规范项目根
		{ ...goodRecord, canonicalRoot: "/srv/app/" },
		// 非法时间
		{ ...goodRecord, decidedAt: "not-a-date" },
		// 非法 hostId
		{ ...goodRecord, hostId: "nope" },
	];
	const settings = createSettingsSection(dirty);
	const service = createService(settings, [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")]);
	const entries = await service.list();
	assert.equal(entries.length, 1, "只有自洽的那一条留下");
	assert.equal(entries[0].canonicalRoot, ROOT);
	assert.equal(entries[0].status, "stale", "endpoint 摘要对不上 ⇒ 作废（fail-closed）");

	// 非数组（手工改坏成对象）⇒ 空表，不抛错。
	const broken = createService(createSettingsSection({ nope: true }), [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")]);
	assert.deepEqual(local(await broken.list()), []);
});

test("条目上限：只防无限膨胀，超限丢最旧", async () => {
	const records = [];
	for (let index = 0; index <= REMOTE_PROJECT_TRUST_MAX_ENTRIES; index += 1) {
		const digest = index.toString(16).padStart(32, "0");
		const root = `/srv/p${index}`;
		records.push({ trustKey: `${HOST_ID}::${digest}::${root}`, hostId: HOST_ID, canonicalRoot: root, endpointDigest: digest, decision: "approve", decidedAt: "2026-10-01T00:00:00.000Z" });
	}
	const settings = createSettingsSection(records);
	const service = createService(settings, [verifiedHost(HOST_ID, "Build box", "SHA256:zzz")]);
	const entries = await service.list();
	assert.equal(entries.length, REMOTE_PROJECT_TRUST_MAX_ENTRIES);
	const next = await service.decide({ hostId: HOST_ID, remoteRoot: "/srv/new", decision: "approve" });
	assert.equal(next.canonicalRoot, "/srv/new");
	assert.equal(settings.raw().length, REMOTE_PROJECT_TRUST_MAX_ENTRIES);
	assert.equal(
		settings.raw().some((record) => record.canonicalRoot === "/srv/p0"),
		false,
		"丢最旧",
	);
});
