import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import type { PiEnvironmentGuide } from "../../hooks/usePiEnvironmentGuide";
import { detectRendererPlatform } from "../../lib/detectRendererPlatform";

/**
 * pi 环境引导面板：Node → npm → pi 三步引导。
 *
 * 步骤推进逻辑（关键业务规则）：
 * - Node 步：系统 node 存在或便携副本已装 → 该步完成（绿色 ✓）；
 * - npm 步：node 完成后才可检测 npm（npm 随 Node 分发，前置不满足时检测必然失败）；
 * - pi 步：npm 就绪后可安装；安装成功后提示「重新检测」完成整个链路。
 * 每一步只展示当前需要的操作，已完成步骤折叠为一行状态，避免信息过载。
 */
export function EnvironmentGuidePanel(props: { guide: PiEnvironmentGuide }) {
	const { guide } = props;
	const platform = detectRendererPlatform();

	// 步骤完成判定：Node 步看系统 node 或便携副本；npm 步看检测结果；pi 步看安装结果。
	const nodeStepDone = Boolean(guide.nodeStatus?.installed || guide.nodeStatus?.systemNodeAvailable);
	const npmStepDone = Boolean(guide.npmVersion);
	const piStepDone = guide.piInstallDone;

	// 当前应聚焦的步骤：第一个未完成的步骤（引导用户从上到下推进）。
	const activeStep = !nodeStepDone ? 0 : !npmStepDone ? 1 : 2;

	return (
		<div className="env-guide">
			{/* 步骤标题行 */}
			<strong>{t("environment.guideStepsTitle")}</strong>

			{/* 步 1：Node */}
			<div className={`env-guide-step ${nodeStepDone ? "done" : ""} ${activeStep === 0 ? "active" : ""}`}>
				<div className="env-guide-step-head">
					<span className="env-guide-step-mark">{nodeStepDone ? "✓" : "1"}</span>
					<b>{t("environment.guideStepNode")}</b>
					{nodeStepDone && guide.nodeStatus?.systemNodeVersion && <small className="env-guide-step-state">{t("environment.guideNodeSystemFound", { version: guide.nodeStatus.systemNodeVersion })}</small>}
					{nodeStepDone && !guide.nodeStatus?.systemNodeVersion && guide.nodeStatus?.version && <small className="env-guide-step-state">{t("environment.guideNodePortableFound", { version: guide.nodeStatus.version })}</small>}
				</div>
				{!nodeStepDone && (
					<div className="env-guide-step-body">
						<small>{guide.nodeStatus?.installSupported === false ? t("environment.guideNodeUnsupported") : t("environment.guideNodeDesc")}</small>
						{guide.nodeStatus?.installSupported !== false && (
							<div className="env-guide-step-actions">
								<Button variant="default" size="sm" className="h-auto rounded-md px-4 py-[7px] text-xs shadow-none" onClick={() => void guide.installNode()} disabled={guide.nodeInstalling || guide.nodeChecking}>
									{guide.nodeInstalling ? t("environment.guideNodeInstalling") : t("environment.guideNodeInstall")}
								</Button>
							</div>
						)}
						{guide.nodeStatus?.installSupported === false && (
							<Button variant="outline" size="sm" className="h-auto rounded-md px-4 py-[7px] text-xs shadow-none" onClick={() => window.piDesktop.app.openExternal("https://nodejs.org/zh-cn/download/", true)}>
								{t("environment.openNodejsOrg")}
							</Button>
						)}
						{guide.nodeInstallResult && (
							<div className={`env-guide-result ${guide.nodeInstallResult.ok ? "success" : "error"}`}>
								{guide.nodeInstallResult.ok ? "✓ " : "✗ "}
								{guide.nodeInstallResult.message}
							</div>
						)}
					</div>
				)}
			</div>

			{/* 步 2：npm（node 就绪后才展示操作） */}
			<div className={`env-guide-step ${npmStepDone ? "done" : ""} ${activeStep === 1 ? "active" : ""} ${activeStep < 1 ? "locked" : ""}`}>
				<div className="env-guide-step-head">
					<span className="env-guide-step-mark">{npmStepDone ? "✓" : "2"}</span>
					<b>{t("environment.guideStepNpm")}</b>
					{npmStepDone && <small className="env-guide-step-state">{t("environment.guideNpmVersionFound", { version: guide.npmVersion ?? "" })}</small>}
				</div>
				{!npmStepDone && activeStep === 1 && (
					<div className="env-guide-step-body">
						<small>{t("environment.guideNpmDesc")}</small>
						<div className="env-guide-step-actions">
							<Button variant="default" size="sm" className="h-auto rounded-md px-4 py-[7px] text-xs shadow-none" onClick={() => void guide.checkNpmForGuide()} disabled={guide.npmChecking}>
								{guide.npmChecking ? t("environment.checking") : t("environment.guideNpmCheck")}
							</Button>
						</div>
						{guide.npmError && <div className="env-guide-result error">✗ {guide.npmError}</div>}
					</div>
				)}
			</div>

			{/* 步 3：pi（npm 就绪后才展示操作） */}
			<div className={`env-guide-step ${piStepDone ? "done" : ""} ${activeStep === 2 ? "active" : ""} ${activeStep < 2 ? "locked" : ""}`}>
				<div className="env-guide-step-head">
					<span className="env-guide-step-mark">{piStepDone ? "✓" : "3"}</span>
					<b>{t("environment.guideStepPi")}</b>
				</div>
				{!piStepDone && activeStep === 2 && (
					<div className="env-guide-step-body">
						{/* 主进程拦住安装时的现场：本机已有 pi。不再展示安装按钮——用户没有东西可装 */}
						{guide.piAlreadyInstalled.length > 0 ? (
							<>
								<div className="env-guide-result success">✓ {t("environment.guidePiAlreadyInstalled")}</div>
								<ul className="m-0 flex list-none flex-col gap-1 p-0">
									{guide.piAlreadyInstalled.map((item) => (
										<li key={item.path} className="text-text-secondary text-caption">
											{item.version ? `v${item.version} · ` : ""}
											{item.path}
										</li>
									))}
								</ul>
								<small>{t("environment.guidePiAlreadyInstalledHint")}</small>
							</>
						) : (
							<>
								<small>{t("environment.guidePiDesc")}</small>
								<div className="env-guide-step-actions">
									<Button variant="outline" size="sm" className={`env-mirror-btn ${guide.piUseMirror ? "active" : ""} h-auto rounded-md px-4 py-[7px] text-xs shadow-none`} onClick={() => guide.setPiUseMirror((prev) => !prev)} disabled={guide.piInstalling}>
										{guide.piUseMirror ? t("environment.guidePiRemoveMirror") : t("environment.guidePiUseMirror")}
									</Button>
									<Button variant="default" size="sm" className="h-auto rounded-md px-4 py-[7px] text-xs shadow-none" onClick={() => void guide.installPiForGuide()} disabled={guide.piInstalling}>
										{guide.piInstalling ? t("environment.guidePiInstalling") : t("environment.guidePiInstall")}
									</Button>
								</div>
								{guide.piInstallResult && (
									<div className={`env-guide-result ${guide.piInstallResult.success ? "success" : "error"}`}>{guide.piInstallResult.success ? `✓ ${t("environment.guidePiDone")}` : `✗ ${t("environment.guidePiFailed")}：${guide.piInstallResult.stderr?.slice(0, 300) || guide.piInstallResult.stdout?.slice(0, 300)}`}</div>
								)}
							</>
						)}
					</div>
				)}
				{piStepDone && (
					<div className="env-guide-step-body">
						<div className="env-guide-result success">✓ {t("environment.guidePiDone")}</div>
						<small>{t("environment.guideCompletedHint")}</small>
					</div>
				)}
			</div>

			{/* 全部完成：给一个明确的重启出口（提示「要重启，记得提醒用户」的落地）。
			    platform 仅用于未来按平台差异化提示；当前三平台行为一致。 */}
			{piStepDone && platform && (
				<Button variant="default" size="sm" className="h-auto rounded-md px-4 py-2.5 text-control shadow-none" onClick={() => window.piDesktop.app.restart()}>
					{t("environment.guideRestartNow")}
				</Button>
			)}
		</div>
	);
}
