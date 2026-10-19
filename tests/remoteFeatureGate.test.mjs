import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveRemoteExperimentEnabled } = loadTsCommonJs("src/main/remote/remoteFeatureGate.ts");

/**
 * 远端实验门三档语义（唯一判据是纯函数，装配点在 registerIpc）。
 *
 * 为什么不能「直接放开」：远端 SSH 面（主机/项目/会话/Git/终端）仍是实验能力，
 * 正式发布包必须恒关——即使外部设置 PIDECK_REMOTE_EXPERIMENTAL=1。
 * 为什么 dev 品牌包默认开：它和 stable 是两个品牌/两个 appId 的构建，只用于真机验收，
 * 用户侧双击即用，不该再要求手设环境变量。
 */

test("stable 发布包（已打包且非 dev 品牌）：恒关，环境变量也不开", () => {
	for (const experimentalEnv of [undefined, "0", "1", ""]) {
		assert.equal(resolveRemoteExperimentEnabled({ isPackaged: true, devBuild: false, experimentalEnv }), false, `experimentalEnv=${String(experimentalEnv)} 时正式包仍必须关闭`);
	}
});

test("未打包开发态：只有显式 PIDECK_REMOTE_EXPERIMENTAL=1 才开（历史行为不变）", () => {
	assert.equal(resolveRemoteExperimentEnabled({ isPackaged: false, devBuild: false, experimentalEnv: undefined }), false);
	assert.equal(resolveRemoteExperimentEnabled({ isPackaged: false, devBuild: false, experimentalEnv: "0" }), false);
	assert.equal(resolveRemoteExperimentEnabled({ isPackaged: false, devBuild: false, experimentalEnv: "" }), false);
	assert.equal(resolveRemoteExperimentEnabled({ isPackaged: false, devBuild: false, experimentalEnv: "1" }), true);
});

test("dev 品牌打包构建：默认开启，供真机验收（不要求运行期环境变量）", () => {
	for (const experimentalEnv of [undefined, "0", "", "1"]) {
		assert.equal(resolveRemoteExperimentEnabled({ isPackaged: true, devBuild: true, experimentalEnv }), true, `experimentalEnv=${String(experimentalEnv)} 时 dev 品牌包都应开启`);
	}
});

test("判据来源唯一：装配点不得自己写 !app.isPackaged 布尔表达式", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	assert.match(main, /remoteExperimentEnabled\s*=\s*resolveRemoteExperimentEnabled\(\{/);
	assert.doesNotMatch(main, /remoteExperimentEnabled\s*=\s*!app\.isPackaged/, "门禁表达式必须留在纯函数里，装配点只喂输入");
	// dev 品牌标记必须来自 channelIdentity（编译期 define 只在那里 declare），否则 index.ts 拿不到 __PIDECK_DEV_BUILD__。
	const channel = readFileSync("src/main/update/channelIdentity.ts", "utf8");
	assert.match(channel, /export function isDevBrandBuild\(\)[\s\S]{0,80}return __PIDECK_DEV_BUILD__/);
	assert.match(main, /devBuild:\s*isDevBrandBuild\(\)/);
});
