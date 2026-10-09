/**
 * 远端项目 root 复核状态的收窄（渲染层，设计 (i) 的呈现端）。
 *
 * `rootStatus(projectId)` 是只读查询：ok → 项目级状态；needs-attention → 侧栏给「需处理」提示 + 稳定码。
 * 读不懂就按 unavailable 记：不显示提示，也不编一个码（宁可不打扰，也不能谎报目录已漂移）。
 */

export type RemoteProjectRootStatusView = { status: "ok" | "needs-attention" | "unavailable"; code: string | null };

/** 一个码就是一个码，绝不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCode(value: unknown): string | null {
	return typeof value === "string" && STABLE_CODE.test(value) ? value : null;
}

export function readRootStatusResponse(raw: unknown): RemoteProjectRootStatusView {
	if (!isRecord(raw)) return { status: "unavailable", code: null };
	if (raw.ok === false) return { status: "unavailable", code: readCode(raw.code) };
	if (raw.ok !== true) return { status: "unavailable", code: null };
	// code 缺失（或不是稳定码）不影响提示本身：状态才是需要行动的信号，码只是 hint。
	if (raw.status === "ok") return { status: "ok", code: null };
	if (raw.status === "needs-attention") return { status: "needs-attention", code: readCode(raw.code) };
	return { status: "unavailable", code: null };
}
