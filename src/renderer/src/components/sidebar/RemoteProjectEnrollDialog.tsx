import { useAtom, useSetAtom } from "jotai";
import { openSettingsAtom } from "../../atoms";
import { remoteEnrollDialogOpenAtom } from "../../atoms/remote-project-atoms";
import { REMOTE_ENROLL_CONFIRM_EXPIRED, REMOTE_ENROLL_REQUEST_FAILED, REMOTE_HOST_STORE_NEEDS_REPAIR, type RemoteProjectEnrollState, useRemoteProjectEnroll } from "../../hooks/useRemoteProjectEnroll";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { Input } from "../ui-shadcn/input";
import { Label } from "../ui-shadcn/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";

/**
 * 远端项目登记弹框：全应用唯一挂载点（App 装配），侧栏「+」与空态引导只写开关 atom。
 *
 * 产品行为（交接文档 §3 B）：
 * - 第一版是「选主机 → 输入绝对路径 → 展示 canonical 路径确认 → 登记」，**没有**登记前目录树选择器；
 * - 无「已验证且未禁用」主机时引导去设备设置，而不是给一个注定失败的输入框；
 * - 登记成功后由宿主刷新项目清单并选中返回的 projectId，本弹框不创建任何本地会话。
 *
 * 状态机、请求关联与 IPC 错误处理都在 useRemoteProjectEnroll；这里只做呈现与事件转发。
 */
function errorText(state: RemoteProjectEnrollState): string | null {
	if (state.errorCode === null) return null;
	if (state.errorCode === REMOTE_ENROLL_REQUEST_FAILED) return t("sidebar.remoteEnroll.requestFailed");
	if (state.errorCode === REMOTE_ENROLL_CONFIRM_EXPIRED) return t("sidebar.remoteEnroll.expired");
	// 同一 errorCode 在不同阶段含义不同：确认阶段是「回答失败」，路径阶段是「解析失败」。
	if (state.stage === "confirm") return t("sidebar.remoteEnroll.answerFailed", { code: state.errorCode });
	if (state.stage === "unavailable") return t("sidebar.remoteEnroll.loadFailed", { code: state.errorCode });
	return t("sidebar.remoteEnroll.resolveFailed", { code: state.errorCode });
}

/** 不可用态的三类原因分开说：功能未启用 / 存储需修复 / 清单读取失败。 */
function unavailableText(state: RemoteProjectEnrollState): string {
	if (state.errorCode === "REMOTE_FEATURE_DISABLED") return t("sidebar.remoteEnroll.featureDisabled");
	if (state.errorCode === REMOTE_HOST_STORE_NEEDS_REPAIR) return t("sidebar.remoteEnroll.needsRepair");
	return errorText(state) ?? t("sidebar.remoteEnroll.loadFailed", { code: state.errorCode ?? "" });
}

export function RemoteProjectEnrollDialog(props: { onEnrolled: (projectId: string) => void }) {
	const [open, setOpen] = useAtom(remoteEnrollDialogOpenAtom);
	const openSettings = useSetAtom(openSettingsAtom);
	const enroll = useRemoteProjectEnroll({
		open,
		onClose: () => setOpen(false),
		// 引导去设备设置：关掉弹框再深链到「连接」页，避免两个弹层叠在一起。
		onOpenDeviceSettings: () => {
			setOpen(false);
			openSettings({ tab: "connections" });
		},
		onEnrolled: props.onEnrolled,
	});
	const { state } = enroll;
	if (!open) return null;
	const error = errorText(state);
	const formLocked = state.busy || state.stage === "awaiting-confirm";
	const hostLabel = state.request === null ? "" : (state.hosts.find((host) => host.id === state.request?.hostId)?.label ?? state.request.hostId);
	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next) enroll.close();
			}}
		>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{state.stage === "confirm" ? t("sidebar.remoteEnroll.confirmTitle") : t("sidebar.remoteEnroll.title")}</DialogTitle>
					<DialogDescription>{state.stage === "confirm" ? t("sidebar.remoteEnroll.confirmHint") : t("sidebar.remoteEnroll.hint")}</DialogDescription>
				</DialogHeader>
				{state.stage === "loading" ? <p className="py-3 text-body text-muted-foreground">{t("sidebar.remoteEnroll.loading")}</p> : null}

				{state.stage === "unavailable" ? (
					<div className="flex flex-col gap-3 py-1">
						<p className="text-body text-muted-foreground">{unavailableText(state)}</p>
						<Button variant="secondary" size="sm" className="self-start" onClick={enroll.goToDeviceSettings}>
							{t("sidebar.remoteEnroll.openDeviceSettings")}
						</Button>
					</div>
				) : null}

				{/* 无可用主机不是错误，是一条「先去设置」的路径：不给注定失败的输入框。 */}
				{state.stage === "no-host" ? (
					<div className="flex flex-col gap-3 py-1">
						<p className="text-body text-muted-foreground">{t("sidebar.remoteEnroll.noHost")}</p>
						<Button variant="secondary" size="sm" className="self-start" onClick={enroll.goToDeviceSettings}>
							{t("sidebar.remoteEnroll.openDeviceSettings")}
						</Button>
					</div>
				) : null}

				{state.stage === "path" || state.stage === "awaiting-confirm" ? (
					<div className="flex flex-col gap-3 py-1">
						<div className="grid gap-1.5">
							<Label htmlFor="remote-enroll-host">{t("sidebar.remoteEnroll.host")}</Label>
							<Select value={state.hostId ?? ""} onValueChange={enroll.selectHost} disabled={formLocked}>
								<SelectTrigger id="remote-enroll-host">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{state.hosts.map((host) => (
										<SelectItem key={host.id} value={host.id}>
											{host.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="remote-enroll-path">{t("sidebar.remoteEnroll.path")}</Label>
							<Input id="remote-enroll-path" placeholder={t("sidebar.remoteEnroll.pathPlaceholder")} value={state.path} disabled={formLocked} onChange={(event) => enroll.setPath(event.target.value)} />
						</div>
						{state.stage === "awaiting-confirm" ? <p className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.awaitingConfirm")}</p> : null}
						{error !== null ? <p className="text-label text-muted-foreground">{error}</p> : null}
						<DialogFooter>
							<Button variant="ghost" onClick={enroll.close}>
								{t("common.cancel")}
							</Button>
							<Button disabled={formLocked || state.hostId === undefined || state.path.trim() === ""} onClick={() => void enroll.submit()}>
								{t("sidebar.remoteEnroll.resolve")}
							</Button>
						</DialogFooter>
					</div>
				) : null}

				{state.stage === "confirm" && state.request !== null ? (
					<div className="flex flex-col gap-3 py-1">
						<div className="flex items-center justify-between gap-3 text-body">
							<span className="text-muted-foreground">{t("sidebar.remoteEnroll.host")}</span>
							<span className="font-medium">{hostLabel}</span>
						</div>
						<div className="flex flex-col gap-0.5">
							<span className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.requested")}</span>
							<span className="select-all break-all font-mono text-label">{state.request.requestedPath}</span>
						</div>
						{/* canonical 才是真正会被 confinement 的目录，两者不同时必须让用户看见。 */}
						<div className="flex flex-col gap-0.5">
							<span className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.canonical")}</span>
							<span className="select-all break-all font-mono text-label">{state.request.canonicalPath}</span>
						</div>
						{state.request.canonicalPath !== state.request.requestedPath ? <p className="text-label text-muted-foreground">{t("sidebar.remoteEnroll.redirected")}</p> : null}
						{error !== null ? <p className="text-label text-muted-foreground">{error}</p> : null}
						<DialogFooter>
							<Button variant="ghost" disabled={state.busy} onClick={() => void enroll.answer("deny")}>
								{t("common.cancel")}
							</Button>
							<Button disabled={state.busy} onClick={() => void enroll.answer("approve")}>
								{t("sidebar.remoteEnroll.confirmUse")}
							</Button>
						</DialogFooter>
					</div>
				) : null}

				{state.stage === "enrolled" ? (
					<div className="flex flex-col gap-3 py-1">
						<p className="text-body font-medium text-foreground">{t("sidebar.remoteEnroll.enrolled")}</p>
						<p className="text-body text-muted-foreground">{t("sidebar.remoteEnroll.enrolledHint")}</p>
						<DialogFooter>
							<Button onClick={enroll.close}>{t("sidebar.remoteEnroll.done")}</Button>
						</DialogFooter>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
