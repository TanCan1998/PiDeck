import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { X, FolderOpen } from "lucide-react";
import { ConfirmDialog as ShadcnConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import type { AppInfo, Project, PiInstallation, PiInstallStatus, PiInstallExecResult } from "../../../../shared/types";
import { Input } from "../ui-shadcn/input";
import { Label } from "../../components/ui-shadcn/label";
import { EnvironmentGuidePanel } from "./EnvironmentGuidePanel";
import { PiCommandSourcePanel } from "../app/PiCommandSourcePanel";
import { shouldOfferInstallationChoice } from "../../utils/piInstallationOptions";
import type { PiEnvironmentGuide } from "../../hooks/usePiEnvironmentGuide";

export function EnvironmentDialog(props: {
	status: PiInstallStatus | null;
	checking: boolean;
	onClose: () => void;
	onRecheck: () => void;
	onOpenInstallDocs: () => void;
	/** pi 环境引导（Node→npm→pi 三步）的域状态与命令；未传 = 不展示引导面板（旧调用方兼容） */
	guide?: PiEnvironmentGuide;
	/** 用户手动输入的 pi 路径 */
	customPath: string;
	/** 正在校验自定义路径 */
	customPathValidating: boolean;
	/** 自定义路径校验结果 */
	customPathResult: PiInstallStatus | null;
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
	/** npm 可用性 */
	npmAvailable: boolean | null;
	npmVersion?: string;
	npmChecking: boolean;
	/**
	 * 探测到的全部 pi 安装。多份时弹窗不再自动关闭，必须让用户先选一份——
	 * 静默用其中一份正是「终端里能用、PiDeck 用的是另一份」的根源。
	 */
	installations?: PiInstallation[];
	/** 正在校验的安装路径（行内 loading） */
	applyingInstallationPath?: string | null;
	onChooseInstallation?: (path: string) => void;
	/** 反查交互式登录 shell 再找一次（zsh/自定义 PATH 场景） */
	onShellProbeInstallations?: () => void;
	shellProbingInstallations?: boolean;
	/** 系统文件选择器挑 pi 可执行文件（稀有/自定义安装） */
	onBrowsePiPath: () => void;
	browsingPiPath: boolean;
	/** 当前安装命令文本 */
	installCommand: string;
	/** 是否使用国内镜像源 */
	installUseMirror: boolean;
	/** 是否正在执行安装 */
	installExecuting: boolean;
	/** 安装执行结果 */
	installResult: PiInstallExecResult | null;
	/** 安装是否已成功完成 */
	installCompleted: boolean;
	onCheckNpm: () => void;
	onInstallCommandChange: (cmd: string) => void;
	onToggleInstallMirror: () => void;
	onExecInstall: () => void;
	onRestartApp: () => void;
	/** 重置 piEnvironmentChecked 标记，使下次启动重新触发环境检测 */
	onClearCheckFlag?: () => void;
}) {
	const installed = props.status?.installed || props.customPathResult?.installed;
	const searchedDirs = props.status?.searchedDirs.slice(0, 16) ?? [];
	const errorText = props.status?.error ?? props.customPathResult?.error;
	const steps = [t("environment.stepInstall"), t("environment.stepPath"), t("environment.stepPermission"), t("environment.stepDone")];
	const activeStep = props.checking ? 0 : installed ? 3 : 1;

	// Windows 统一使用 CMD 查找 .cmd/.exe shim，不再引导用户使用 PowerShell 的 .ps1 入口。
	const refCmd = "where pi";

	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))] max-h-[calc(100vh-48px)]", "environment-dialog")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("environment.title")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="environment-body">
					<div className="env-stepper" aria-label={t("environment.title")}>
						{steps.map((step, index) => (
							<div key={step} className={`env-step ${index < activeStep ? "done" : ""} ${index === activeStep ? "active" : ""}`}>
								<span>{index < activeStep ? "✓" : index + 1}</span>
								<b>{step}</b>
							</div>
						))}
					</div>

					{props.checking && (
						<div className="env-card env-loading-card">
							<div className="loader animate-pideck-spin" />
							<span>{t("environment.checking")}</span>
						</div>
					)}

					{!props.checking && installed && (
						<>
							<div className="env-card env-success-card">
								<div className="env-success-icon">✓</div>
								<div className="env-success-info">
									<strong>{t("environment.passed")}</strong>
									<span>
										{t("environment.path")}：{(props.customPathResult || props.status)?.command}
									</span>
									{(props.customPathResult || props.status)?.version && (
										<span>
											{t("environment.version")}：{(props.customPathResult || props.status)!.version}
										</span>
									)}
									{/* 多份安装时不能承诺自动关闭：用户得先在这里选一份 */}
									{!shouldOfferInstallationChoice(props.installations ?? []) && <small>{t("environment.autoClose")}</small>}
								</div>
							</div>

							{/* 多份 pi 安装：列出全部（含官方安装器那份）让用户自己选 */}
							{shouldOfferInstallationChoice(props.installations ?? []) && props.onChooseInstallation && (
								<div className="env-card">
									<PiCommandSourcePanel
										variant="dialog"
										installations={props.installations ?? []}
										applyingPath={props.applyingInstallationPath}
										onChoose={props.onChooseInstallation}
										onShellProbe={props.onShellProbeInstallations}
										shellProbing={props.shellProbingInstallations}
										onBrowse={props.onBrowsePiPath}
										browsing={props.browsingPiPath}
									/>
								</div>
							)}
						</>
					)}

					{!props.checking && !installed && (
						<>
							{/* 置顶提示：已装 pi 的用户直接配路径即可，不要重复走安装流程 */}
							<div className="env-card env-already-installed-card">
								<strong>{t("environment.guideAlreadyInstalledTitle")}</strong>
								<small>{t("environment.guideAlreadyInstalledDesc")}</small>
							</div>

							{/* 状态说明卡片 */}
							<div className="env-card env-status-card">
								<strong>{t("environment.notFoundTitle")}</strong>
								<small>{t("environment.notFoundDesc")}</small>
							</div>

							{/* 自动检测错误信息（如有） */}
							{errorText && (
								<div className="env-card env-error-card">
									<strong>{t("environment.errorDetails")}</strong>
									<pre className="env-error-pre">{errorText}</pre>
								</div>
							)}

							{/* 手动输入 pi 路径卡片：已装用户的主路径，提前到安装引导之前 */}
							<div className="env-card env-custom-card">
								<strong>{t("environment.customPathTitle")}</strong>
								<small>{t("environment.customPathDesc")}</small>
								<div className="ref-commands">
									<div className="ref-command-item">
										<span className="ref-label">{t("environment.commandLabel")}</span>
										<code>{refCmd}</code>
									</div>
								</div>
								<div className="custom-path-input-row">
									<Input type="text" placeholder="D:\mise-data\installs\node\24.13.0\pi.cmd" value={props.customPath} onChange={(e) => props.onCustomPathChange(e.target.value)} disabled={props.customPathValidating} />
									<Button variant="outline" size="sm" className="h-auto gap-1.5 rounded-md px-4 py-[7px] text-xs shadow-none" onClick={props.onBrowsePiPath} disabled={props.browsingPiPath || props.customPathValidating}>
										<FolderOpen size={13} strokeWidth={2} aria-hidden="true" />
										{t("environment.installsBrowse")}
									</Button>
									<Button variant="default" size="sm" className="h-auto rounded-md px-4 py-[7px] text-xs shadow-none" onClick={props.onValidateCustomPath} disabled={!props.customPath.trim() || props.customPathValidating}>
										{props.customPathValidating ? t("environment.validatingPath") : t("environment.validatePath")}
									</Button>
								</div>
								{props.customPathResult && (
									<div className={`custom-path-result ${props.customPathResult.installed ? "success" : "error"}`}>
										{props.customPathResult.installed ? `✓ ${t("environment.validatePassed", { value: props.customPathResult.version ?? "pi" })}` : `✗ ${t("environment.validateFailed", { value: props.customPathResult.error ?? t("environment.unableToRun") })}`}
									</div>
								)}
							</div>

							{/* pi 环境引导：Node→npm→pi 三步；guide 未传时退回旧的 npm 安装卡片 */}
							{props.guide ? (
								<div className="env-card env-guide-card">
									<EnvironmentGuidePanel guide={props.guide} />
								</div>
							) : (
								<div className="env-card env-npm-install-card">
									<strong>{t("environment.installCardTitle")}</strong>
									<small>{t("environment.installCardDesc")}</small>
									<small>
										{t("environment.installDesc")}{" "}
										<a
											className="env-inline-link"
											href="#"
											onClick={(e) => {
												e.preventDefault();
												props.onOpenInstallDocs();
											}}
										>
											{t("environment.openInstallDocs")}
										</a>
									</small>

									{/* npm 可用性检测 */}
									{props.npmAvailable === null && !props.npmChecking && (
										<Button variant="outline" size="sm" className="h-auto rounded-md px-4 py-[7px] text-xs shadow-none" onClick={props.onCheckNpm}>
											{t("environment.stepInstall")}
										</Button>
									)}

									{props.npmChecking && (
										<div className="env-install-loading">
											<div className="loader animate-pideck-spin" />
											<span>{t("environment.checking")}</span>
										</div>
									)}

									{/* npm 可用时：显示安装命令和操作 */}
									{props.npmAvailable === true && !props.npmChecking && (
										<div className="env-install-area">
											{props.npmVersion && <div className="env-install-npm-version">npm {props.npmVersion}</div>}
											<div className="env-install-command-row">
												<Label className="env-install-command-label">{t("environment.installCommandLabel")}</Label>
												<Input type="text" className="env-install-command-input" value={props.installCommand} onChange={(e) => props.onInstallCommandChange(e.target.value)} disabled={props.installExecuting} placeholder="npm install -g @earendil-works/pi-coding-agent" />
											</div>
											<div className="env-install-actions">
												<Button variant="outline" size="sm" className={`env-mirror-btn ${props.installUseMirror ? "active" : ""} h-auto rounded-md px-4 py-[7px] text-xs shadow-none`} onClick={props.onToggleInstallMirror} disabled={props.installExecuting} title={t("environment.installUseMirror")}>
													{props.installUseMirror ? t("environment.installRemoveMirror") : t("environment.installUseMirror")}
												</Button>
												<Button variant="default" size="sm" className="h-auto rounded-md px-4 py-[7px] text-xs shadow-none" onClick={props.onExecInstall} disabled={props.installExecuting || !props.installCommand.trim()}>
													{props.installExecuting ? t("environment.installExecuting") : t("environment.installExec")}
												</Button>
											</div>

											{/* 安装进行中：显示进度 */}
											{props.installExecuting && (
												<div className="env-install-progress">
													<div className="loader animate-pideck-spin" />
													<span>{t("environment.installExecuting")}</span>
												</div>
											)}

											{/* 安装完成 */}
											{props.installCompleted && (
												<div className="env-install-success">
													<div className="env-success-icon">✓</div>
													<div className="env-success-info">
														<strong>{t("environment.installSuccess")}</strong>
														<small>{t("environment.installRestartHint")}</small>
													</div>
													<Button variant="default" size="sm" className="h-auto rounded-md px-4 py-[7px] text-xs shadow-none" onClick={props.onRestartApp}>
														{t("environment.restartApp")}
													</Button>
												</div>
											)}

											{/* 安装结果输出 */}
											{props.installResult && (
												<div className={`env-install-result ${props.installResult.success ? "success" : "error"}`}>
													<strong>
														{props.installResult.success ? t("environment.installCompleted") : t("environment.installFailed")}
														{t("environment.installExitCode")}：{props.installResult.exitCode}
													</strong>
													{props.installResult.stdout && (
														<>
															<span>{t("environment.installOutput")}</span>
															<pre className="env-install-output-pre">{props.installResult.stdout}</pre>
														</>
													)}
													{props.installResult.stderr && <pre className="env-install-output-pre env-install-stderr">{props.installResult.stderr}</pre>}
												</div>
											)}
										</div>
									)}

									{/* npm 不可用：引导安装 Node.js */}
									{props.npmAvailable === false && !props.npmChecking && (
										<div className="env-install-npm-missing">
											<strong>{t("environment.npmNotFoundTitle")}</strong>
											<small>{t("environment.npmNotFoundDesc")}</small>
											<Button
												variant="outline"
												size="sm"
												className="h-auto rounded-md px-4 py-[7px] text-xs shadow-none"
												onClick={() =>
													// 环境引导是弹框（Dialog），链接强制系统浏览器：内置浏览器面板在 Dialog 下层不可见
													window.piDesktop.app.openExternal("https://nodejs.org/zh-cn/download/", true)
												}
											>
												{t("environment.openNodejsOrg")}
											</Button>
										</div>
									)}
								</div>
							)}

							{/* 检测路径卡片 */}
							{searchedDirs.length > 0 && (
								<div className="env-card env-dirs-card">
									<strong>{t("environment.searchedDirs")}</strong>
									<small>{t("environment.searchedDirsDesc")}</small>
									<ul className="env-dirs-list">
										{searchedDirs.map((dir) => (
											<li key={dir}>{dir}</li>
										))}
									</ul>
								</div>
							)}
						</>
					)}
				</div>

				<div className="environment-footer">
					<Button variant="default" size="sm" className="h-auto rounded-sm px-4 py-2.5 text-control" onClick={props.onRecheck} disabled={props.checking || props.customPathValidating}>
						{t("environment.recheck")}
					</Button>
					{props.onClearCheckFlag && (
						<Button variant="ghost" size="sm" className="env-clear-flag-btn h-auto rounded-sm px-4 py-2.5 text-control" onClick={props.onClearCheckFlag} title={t("environment.clearCheckFlagHint")}>
							{t("environment.clearCheckFlag")}
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function ConfirmDialog(props: { title: string; message: string; onConfirm: () => void; onCancel: () => void; confirmLabel?: string; danger?: boolean }) {
	// 实现已收敛到 ui-shadcn/ConfirmDialog（AlertDialog），此处仅保留兼容转发。
	return <ShadcnConfirmDialog {...props} />;
}
