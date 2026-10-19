/**
 * 远端实验面的唯一门禁判据（纯函数，便于单测；装配点在 src/main/index.ts 的 registerIpc）。
 *
 * 三档语义：
 * - stable 发布包（isPackaged 且非 dev 通道）：**恒 false**。即使外部设置了
 *   PIDECK_REMOTE_EXPERIMENTAL=1 也不开——远端（SSH 主机/项目/会话/Git/终端）仍是实验能力，
 *   正式包不提供这条后门。
 * - 未打包开发态（npm run dev）：仍要求显式 PIDECK_REMOTE_EXPERIMENTAL=1，与历史行为完全一致，
 *   开发机上不会因为改了一行就默认连上测试主机。
 * - dev 通道打包构建（PIDECK_DEV_BUILD=1 的 PiDeck Dev 包）：默认开启，供真机验收；
 *   它和 stable 发布包是两个品牌/两个 appId，不影响正式用户。
 */
export function resolveRemoteExperimentEnabled(input: {
	/** app.isPackaged：正式打包为 true（electron-builder 产物）。 */
	isPackaged: boolean;
	/** 编译期通道标记 __PIDECK_DEV_BUILD__：为 true 表示 dev 品牌包。 */
	devBuild: boolean;
	/** 运行期环境变量 PIDECK_REMOTE_EXPERIMENTAL 的原值。 */
	experimentalEnv: string | undefined;
}): boolean {
	// 与 channelIdentity.isDevChannelBuild() 同口径：未打包或 dev 通道打包都算开发通道。
	const isDevChannel = !input.isPackaged || input.devBuild;
	if (!isDevChannel) return false;
	return input.devBuild || input.experimentalEnv === "1";
}
