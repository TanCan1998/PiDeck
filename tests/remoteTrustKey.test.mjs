/**
 * 远端 trust key 的契约（P4.4a）。
 *
 * 这些断言钉住三件事：① 路径必须被规范成无歧义的绝对项目根（相对/含单引号一律拒绝）；
 * ② endpoint 身份必须建立在 pin 的密码学事实上（缺了就是 undefined = 不可判定，绝不放行）；
 * ③ key 对同一输入稳定、对任一材料变化敏感（否则会出现「换了机器/项目还能命中旧信任」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { canonicalRemoteRoot, remoteEndpointIdentity, remoteTrustKey } = loadTsCommonJs("src/main/remote/RemoteTrustKey.ts");

const endpoint = {
	hostName: "10.81.2.15",
	user: "zhadainian",
	port: 22,
	routeDigest: "a".repeat(64),
	knownHostsSha256: "b".repeat(64),
	hostKeyFingerprints: ["SHA256:zzz"],
};

test("规范项目根：绝对路径归一（尾斜杠/./..），相对与含引号一律拒绝", () => {
	assert.equal(canonicalRemoteRoot("/srv/app/"), "/srv/app");
	assert.equal(canonicalRemoteRoot("/srv//app"), "/srv/app");
	assert.equal(canonicalRemoteRoot("/srv/app/./sub/../"), "/srv/app");
	assert.equal(canonicalRemoteRoot("/"), "/");
	// 相对路径必须拒绝：它在远端有歧义（pi 的 cwd vs 会话根）
	assert.equal(canonicalRemoteRoot("srv/app"), undefined);
	assert.equal(canonicalRemoteRoot("./srv"), undefined);
	// 单引号/控制字符会破坏「进单引号字面量」的前提
	assert.equal(canonicalRemoteRoot("/srv/it's"), undefined);
	assert.equal(canonicalRemoteRoot("/srv/app\nrm -rf /"), undefined);
	assert.equal(canonicalRemoteRoot(undefined), undefined);
});

test("endpoint 身份：必须有密码学事实，缺失即不可判定（fail-closed）", () => {
	assert.equal(remoteEndpointIdentity(undefined), undefined);
	assert.equal(remoteEndpointIdentity({ hostName: "h", user: "u", port: 22 }), undefined, "只有路由事实不足以判定");
	const identity = remoteEndpointIdentity(endpoint);
	assert.equal(typeof identity, "string");
	assert.ok(identity.includes("SHA256:zzz") && identity.includes("user:zhadainian"));
	// 指纹顺序不影响身份（集合语义）
	const reordered = remoteEndpointIdentity({ ...endpoint, hostKeyFingerprints: [...endpoint.hostKeyFingerprints].reverse() });
	assert.equal(reordered, identity);
	// 主机名大小写不影响身份
	assert.equal(remoteEndpointIdentity({ ...endpoint, hostName: "HOST" }), remoteEndpointIdentity({ ...endpoint, hostName: "host" }));
});

test("trust key：三材料齐才有值，任一变化都要变 key", () => {
	const base = { hostId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", endpointIdentity: remoteEndpointIdentity(endpoint), remoteRoot: "/srv/app/" };
	const key = remoteTrustKey(base);
	assert.equal(typeof key, "string");
	assert.ok(key.startsWith(base.hostId + "::"), "hostId 保持明文便于排障");
	assert.ok(key.endsWith("::/srv/app"), "项目根必须是规范形式");
	// 同一输入稳定
	assert.equal(remoteTrustKey(base), key);
	// 尾斜杠/等价写法不得产生第二个 key
	assert.equal(remoteTrustKey({ ...base, remoteRoot: "/srv/app" }), key);
	// 任一材料变化都要换 key
	assert.notEqual(remoteTrustKey({ ...base, remoteRoot: "/srv/other" }), key);
	assert.notEqual(remoteTrustKey({ ...base, hostId: "9c1d5f7a-2b3e-4c5d-8e9f-0a1b2c3d4e5f" }), key);
	assert.notEqual(remoteTrustKey({ ...base, endpointIdentity: remoteEndpointIdentity({ ...endpoint, hostKeyFingerprints: ["SHA256:other"] }) }), key, "指纹变了就是另一个 endpoint ⇒ 旧 trust 不得命中");
	// 材料缺失 ⇒ 不可判定
	assert.equal(remoteTrustKey({ ...base, endpointIdentity: undefined }), undefined);
	assert.equal(remoteTrustKey({ ...base, hostId: undefined }), undefined);
	assert.equal(remoteTrustKey({ ...base, remoteRoot: "relative/path" }), undefined);
});
