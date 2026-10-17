import { createHash } from "node:crypto";
import { ipcMain, type WebContents } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteProjectCreateAnswerResult, RemoteProjectCreateRequest, RemoteProjectEnrollResult } from "../../shared/types/remoteHost";
import type { SshClientRuntime } from "../remote/SshClientRuntime";
import { resolveRemoteBrowseRoot } from "../remote/RemoteBrowseRoot";
import { buildRemoteProjectCreateMkdirCommand, buildRemoteProjectCreateProbeCommand, remoteProjectCreateMkdirCode, remoteProjectCreateProbeCode, runRemoteProjectCreateCommand, splitRemoteProjectCreatePath } from "../remote/RemoteProjectCreateCommands";
import { PendingConfirmationBroker } from "../security/PendingConfirmationBroker";

/** 从 PendingConfirmationBroker 的拒绝里取稳定码；未知一律折叠成 create failed。 */
function codeOf(error: unknown, fallback: string): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : fallback;
}
function senderIdOf(sender: WebContents): number | undefined {
	const id = sender?.id;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * 「新建空远端项目」的独立确认流程（Phase 5 文件面 §7）。
 *
 * 与「使用已有目录」共用 remote:project-enroll 的发起通道（mode=create），但确认/回答/推送完全独立：
 * 独立 broker action、独立 pending 表与 remote:project-create-confirm 推送，两者可同时挂起互不串扰。
 * 命令数固定 3：确认前探针（父 canonical + 父是目录 + 叶不存在）→ 批准后复核同一探针 → mkdir。
 * 目录一旦创建但复核/登记失败，如实返回 ROOT_CHANGED/CREATE_UNCONFIRMED，不删除已创建目录、不重试。
 */
export function registerRemoteProjectCreateFlow(input: {
	enabled: boolean;
	userDataDir: string;
	projects?: { enroll: (input: { hostId: string; canonicalRemotePath: string }) => Promise<{ projectId: string }> };
	/** 回答确认时解析连接服务（与发起登记同一懒构建工厂；失败即稳定码）。 */
	resolveService: () => Promise<{ client: SshClientRuntime } | { code: string }>;
}): {
	begin(sender: WebContents, service: { client: SshClientRuntime }, hostId: string, pathValue: string): Promise<RemoteProjectEnrollResult>;
} {
	const offers = new Map<string, { subjectId: string; digest: string }>();
	const broker = new PendingConfirmationBroker<{ hostId: string; path: string }>({
		onRemoved: (requestId) => {
			offers.delete(requestId);
		},
	});
	const action = "remote:project-create";
	const digestOf = (hostId: string, path: string): string =>
		createHash("sha256")
			.update(JSON.stringify(["pideck-project-create-v1", hostId, path, "create"]), "utf8")
			.digest("hex");
	const probe = async (service: { client: SshClientRuntime }, hostId: string, path: string): Promise<ReturnType<typeof splitRemoteProjectCreatePath>> => {
		const parsed = splitRemoteProjectCreatePath(path);
		let result: { exitCode: number; stdout: string };
		try {
			result = await runRemoteProjectCreateCommand({ userDataDir: input.userDataDir, hostId, client: service.client, command: buildRemoteProjectCreateProbeCommand(parsed) });
		} catch {
			throw new Error("REMOTE_BROWSE_ROOT_PROBE_FAILED");
		}
		const code = remoteProjectCreateProbeCode(result.exitCode);
		if (code !== undefined) throw new Error(code);
		return parsed;
	};

	ipcMain.handle(ipcChannels.remoteProjectCreateAnswer, async (event, requestId: unknown, choice: unknown): Promise<RemoteProjectCreateAnswerResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (input.projects === undefined) return { ok: false, code: "REMOTE_PROJECT_ENROLL_UNAVAILABLE" };
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		if (choice !== "approve" && choice !== "deny") return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
		const offered = offers.get(requestId);
		if (offered === undefined) return { ok: false, code: "REMOTE_PROJECT_ENROLL_CONFIRMATION_REQUIRED" };
		try {
			const payload = broker.answer({ requestId, senderId, action, subjectId: offered.subjectId, stateDigest: offered.digest, choice });
			if (payload === null) return { ok: true, enrolled: false };
			const resolvedService = await input.resolveService();
			if ("code" in resolvedService) return { ok: false, code: resolvedService.code };
			const service = resolvedService;
			const parsed = await probe(service, payload.hostId, payload.path);
			let mkdirResult: { exitCode: number; stdout: string };
			try {
				mkdirResult = await runRemoteProjectCreateCommand({ userDataDir: input.userDataDir, hostId: payload.hostId, client: service.client, command: buildRemoteProjectCreateMkdirCommand(parsed) });
			} catch {
				return { ok: false, code: "REMOTE_PROJECT_CREATE_UNCONFIRMED" };
			}
			const mkdirCode = remoteProjectCreateMkdirCode(mkdirResult.exitCode);
			if (mkdirCode !== "REMOTE_PROJECT_CREATE_OK") return { ok: false, code: mkdirCode };
			try {
				const resolved = await resolveRemoteBrowseRoot({ userDataDir: input.userDataDir, hostId: payload.hostId, client: service.client, userPath: parsed.path });
				if (resolved.canonicalPath !== parsed.path) return { ok: false, code: "REMOTE_PROJECT_ROOT_CHANGED" };
			} catch (error) {
				return { ok: false, code: codeOf(error, "REMOTE_PROJECT_ROOT_CHANGED") };
			}
			try {
				const { projectId } = await input.projects.enroll({ hostId: payload.hostId, canonicalRemotePath: parsed.path });
				return { ok: true, enrolled: true, projectId };
			} catch (error) {
				return { ok: false, code: codeOf(error, "REMOTE_PROJECT_TARGET_INVALID") };
			}
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_CREATE_FAILED") };
		}
	});

	return {
		async begin(sender, service, hostId, pathValue) {
			try {
				const parsed = await probe(service, hostId, pathValue);
				const digest = digestOf(hostId, parsed.path);
				const senderId = senderIdOf(sender);
				if (senderId === undefined) return { ok: false, code: "REMOTE_PROJECT_TARGET_INVALID" };
				const { requestId, expiresAt } = broker.begin({ senderId, action, subjectId: hostId, stateDigest: digest, payload: { hostId, path: parsed.path } });
				offers.set(requestId, { subjectId: hostId, digest });
				if (!sender.isDestroyed()) sender.send(ipcChannels.remoteProjectCreateConfirm, { requestId, expiresAt, hostId, requestedPath: parsed.path, parentPath: parsed.parent, leaf: parsed.leaf } satisfies RemoteProjectCreateRequest);
				return { ok: true, status: "pending", hostId };
			} catch (error) {
				return { ok: false, code: codeOf(error, "REMOTE_PROJECT_CREATE_FAILED") };
			}
		},
	};
}
