import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 引导 nonce 必须**永远**满足契约：服务自己生成、自己校验，生成器不合约就是偶发连接失败。
 *
 * 真机 e2e 抓到过一次 `REMOTE_CONNECTION_NONCE_INVALID`（第 5 次运行卡在「连接到达 ready」）。根因：
 * 生成器用 base64url，而契约（与冻结 helper 共用）要求首字符为字母数字 —— base64url 的 64 个字符里
 * `-`/`_` 占 2 个，约 3.1% 的生成结果会被自己的校验拒掉。
 */
const { createBootstrapNonce } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;

test("every generated bootstrap nonce satisfies the shared contract", () => {
	for (let index = 0; index < 2000; index += 1) {
		const nonce = createBootstrapNonce();
		assert.match(nonce, NONCE, "生成的 nonce 必须满足契约（首字符字母数字）");
	}
});

test("the nonce keeps enough entropy to stay unguessable", () => {
	const seen = new Set();
	for (let index = 0; index < 200; index += 1) seen.add(createBootstrapNonce());
	assert.equal(seen.size, 200, "200 次生成不应出现重复");
	assert.ok(createBootstrapNonce().length >= 32, "至少 32 个字符（128 位熵）");
});
