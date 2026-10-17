/**
 * 远端 Pi 模型目录 IPC（Phase 5 row 819）。单条通道：`remote:pi-models`。
 *
 * 边界：
 * - 渲染层只能传 hostId；服务内部校验 host 形状并在非法时零依赖调用返回稳定码；
 * - 功能门禁与其它 remote 域一致（正式包/未开启实验时连「有这条路」都不暴露），门禁关闭返回 UNAVAILABLE；
 * - handler 只做门禁与转发，不做 project/agent 解析，也不把自由文本错误跨边界。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { REMOTE_MODEL_PROBE_CODES, type RemoteModelProbeResult } from "../../shared/types/remoteModel";
import type { RemotePiModelProbe } from "../pi/RemotePiModelProbe";

export function registerRemotePiModelIpc(input: { enabled: boolean; probe?: RemotePiModelProbe }): void {
	ipcMain.handle(ipcChannels.remotePiModels, async (_event, hostId: unknown): Promise<RemoteModelProbeResult> => {
		if (!input.enabled || input.probe === undefined) return { ok: false, code: REMOTE_MODEL_PROBE_CODES.unavailable };
		try {
			return await input.probe.probe(hostId);
		} catch {
			// Last-resort boundary: even an unexpected service throw must be one of the closed codes, never a raw IPC rejection.
			return { ok: false, code: REMOTE_MODEL_PROBE_CODES.failed };
		}
	});
}
