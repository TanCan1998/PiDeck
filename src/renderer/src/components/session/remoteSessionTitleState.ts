/**
 * 远端会话标题的纯状态机（渲染层 H2，配合 H1 的 `remote:remote-session-title`）。
 *
 * 惰性：每条会话只在**首次需要**时取一次标题；正在取或已取到就不重复发起。
 * 代次：切主机（或卸载）作废在途结果——旧主机的迟到标题绝不能落到新主机的会话上。
 *
 * H1 的契约是 `{ ok: true; title; titleOrigin: "parsed" | "fallback" } | { ok: false; code }`。
 * `titleOrigin` 必须保留：fallback 时 title 也是非空的 stem，只看「title 非空」会把兜底当解析结果，
 * 界面就没法诚实地标「暂定」。未接线时记成 unavailable，界面继续显示扫描给的 stem 占位。
 */

/** parsed = 解析出的真实名字；fallback = stem 兜底（界面要标「暂定」）。 */
export type RemoteSessionTitleOrigin = "parsed" | "fallback";

export type RemoteSessionTitleOutcome = { kind: "ok"; title: string; origin: RemoteSessionTitleOrigin } | { kind: "unwired" } | { kind: "failed"; code: string } | { kind: "rejected" };

export type RemoteSessionTitleEntry = {
	status: "idle" | "loading" | "ready" | "unavailable" | "failed";
	title: string | null;
	origin: RemoteSessionTitleOrigin | null;
	code: string | null;
};

const IDLE_ENTRY: RemoteSessionTitleEntry = { status: "idle", title: null, origin: null, code: null };

/** 一个码就是一个码，绝不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_TITLE_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 收窄标题响应。ok:true 但 title 不是非空短字符串、或 titleOrigin 缺失/不认识，都算读不懂：
 * 回退扫描给的 stem 占位，绝不把兜底或畸形值当成真实标题。
 */
export function readTitleResponse(raw: unknown): RemoteSessionTitleOutcome {
	if (!isRecord(raw)) return { kind: "rejected" };
	if (raw.ok === false) return typeof raw.code === "string" && STABLE_CODE.test(raw.code) ? { kind: "failed", code: raw.code } : { kind: "rejected" };
	if (raw.ok !== true) return { kind: "rejected" };
	const title = raw.title;
	if (typeof title !== "string" || title.length === 0 || title.length > MAX_TITLE_LENGTH || CONTROL_CHARS.test(title)) return { kind: "rejected" };
	const origin = raw.titleOrigin;
	if (origin !== "parsed" && origin !== "fallback") return { kind: "rejected" };
	return { kind: "ok", title, origin };
}

export type RemoteSessionTitleController = {
	/** 某条会话的标题状态；没请求过就是 idle。 */
	statusOf(remoteSessionId: string): RemoteSessionTitleEntry;
	/**
	 * 发起一次取标题；返回本次代次，或 null 表示**不需要发起**（正在取或已取到）。
	 * 换主机时自动作废旧主机的在途结果与缓存。
	 */
	begin(hostId: string, remoteSessionId: string): number | null;
	/** 落地一次结果；非当前代次/非当前主机返回 false 且不改动任何状态。 */
	settle(generation: number, hostId: string, remoteSessionId: string, outcome: RemoteSessionTitleOutcome): boolean;
	/** 作废在途结果并清空缓存（切主机/卸载）。 */
	reset(): void;
	/**
	 * 用 atom 里的缓存快照恢复（重新挂载/切回该主机）：ready 的命中缓存不再请求；
	 * 上次挂载留下的 loading 没有在途请求，必须丢弃让它重新取，否则会永远停在「解析中」。
	 */
	restore(hostId: string, entries: Readonly<Record<string, RemoteSessionTitleEntry>>): void;
};

export function createRemoteSessionTitleController(): RemoteSessionTitleController {
	let hostId: string | null = null;
	let sequence = 0;
	const entries = new Map<string, RemoteSessionTitleEntry>();
	// 代次必须**按会话 id** 记：一行在途不能因为另一行发起请求而被作废（那是并发行之间的串扰）。
	const generations = new Map<string, number>();
	return {
		statusOf: (remoteSessionId) => entries.get(remoteSessionId) ?? IDLE_ENTRY,
		begin(nextHostId, remoteSessionId) {
			if (hostId !== nextHostId) {
				// 切主机：在途结果全部作废，上一个主机的缓存也不能复用（相对路径可能指向不同文件）。
				hostId = nextHostId;
				generations.clear();
				entries.clear();
			}
			const existing = entries.get(remoteSessionId);
			if (existing !== undefined && (existing.status === "loading" || existing.status === "ready")) return null;
			const generation = ++sequence;
			generations.set(remoteSessionId, generation);
			entries.set(remoteSessionId, { status: "loading", title: null, origin: null, code: null });
			return generation;
		},
		settle(generation, nextHostId, remoteSessionId, outcome) {
			if (nextHostId !== hostId || generations.get(remoteSessionId) !== generation) return false;
			if (outcome.kind === "ok") entries.set(remoteSessionId, { status: "ready", title: outcome.title, origin: outcome.origin, code: null });
			else if (outcome.kind === "unwired") entries.set(remoteSessionId, { status: "unavailable", title: null, origin: null, code: null });
			else if (outcome.kind === "failed") entries.set(remoteSessionId, { status: "failed", title: null, origin: null, code: outcome.code });
			else entries.set(remoteSessionId, { status: "failed", title: null, origin: null, code: null });
			return true;
		},
		reset() {
			hostId = null;
			generations.clear();
			entries.clear();
		},
		restore(nextHostId, restored) {
			hostId = nextHostId;
			generations.clear();
			entries.clear();
			for (const [remoteSessionId, entry] of Object.entries(restored)) {
				if (entry.status === "loading") continue;
				entries.set(remoteSessionId, { ...entry });
			}
		},
	};
}
