/**
 * 远端会话标题的纯状态机（渲染层 H2，配合 H1 的 `remote:remote-session-title`）。
 *
 * 惰性：每条会话只在**首次需要**时取一次标题；正在取或已取到就不重复发起。
 * 代次：切主机（或卸载）作废在途结果——旧主机的迟到标题绝不能落到新主机的会话上。
 *
 * 契约是 `{ ok: true; title; titleOrigin } | { ok: false; code }`，其中 titleOrigin 三档（I1 口径冻结）：
 * `"authoritative"` = 名字字段里的真实名字（session_info / 旧版私有 sessionName 行）、
 * `"inferred"` = 首条消息派生的弱兜底、`"fallback"` = 文件名 stem 兜底。
 * `titleOrigin` 必须保留：后两档 title 也是非空字符串，只看「title 非空」会把兜底当解析结果，
 * 界面就没法诚实地标「暂定」。未接线时记成 unavailable，界面继续显示扫描给的 stem 占位。
 */

/** 三档：authoritative = 真实名字；inferred = 内容派生弱兜底；fallback = stem 兜底（后两档标「暂定」）。 */
export type RemoteSessionTitleOrigin = "authoritative" | "inferred" | "fallback";

/**
 * 「暂定」判据的唯一出处：**只有 authoritative 是会话的真实名字**，另外两档都要标暂定。
 * 放在这里而不是各组件里各写一遍，是因为这个判断与 origin 的档位词表同生命周期。
 */
export function isProvisionalTitleOrigin(origin: RemoteSessionTitleOrigin | null): boolean {
	// null = 还没取到（loading/idle/unavailable/failed）：那当然按「暂定」处理，列表先显示扫描给的 stem。
	return origin !== "authoritative";
}

/**
 * 「尾窗口没读到」判据（K2-3），与 `isProvisionalTitleOrigin` 是**两个独立**判据，不得合并：
 * - 暂定说的是「标题不是权威来源」（inferred/fallback/未取到）；
 * - 降级说的是「这次没看到文件尾，权威名可能在尾部」——标题本身仍可能是 authoritative。
 * entry 在 begin/settle/restore 都归一过 tailDegraded，所以这里只可能是 boolean。
 */
export function isTitleTailDegraded(entry: RemoteSessionTitleEntry): boolean {
	return entry.tailDegraded === true;
}

export type RemoteSessionTitleOutcome =
	| {
			kind: "ok";
			title: string;
			origin: RemoteSessionTitleOrigin;
			/**
			 * K2-3：主进程尾窗口读取失败时会带这个标记——标题仍是头部窗口那份（诚实降级），
			 * 但「没看到文件尾」这件事必须留在状态里，界面才有机会如实提示。缺省即正常。
			 */
			tailDegraded: boolean;
	  }
	| { kind: "unwired" }
	| { kind: "failed"; code: string }
	| { kind: "rejected" };

export type RemoteSessionTitleEntry = {
	status: "idle" | "loading" | "ready" | "unavailable" | "failed";
	title: string | null;
	origin: RemoteSessionTitleOrigin | null;
	code: string | null;
	/** 已降级（尾窗口没读到）：`ready` 时才有意义；其余状态恒为 false。 */
	tailDegraded: boolean;
};

const IDLE_ENTRY: RemoteSessionTitleEntry = { status: "idle", title: null, origin: null, code: null, tailDegraded: false };

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
	if (origin !== "authoritative" && origin !== "inferred" && origin !== "fallback") return { kind: "rejected" };
	// tailDegraded 是可选布尔：缺省=false；别的类型属于读不懂（不猜、也不静默降级）。
	const tailDegraded = raw.tailDegraded;
	if (tailDegraded !== undefined && typeof tailDegraded !== "boolean") return { kind: "rejected" };
	return { kind: "ok", title, origin, tailDegraded: tailDegraded === true };
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
			entries.set(remoteSessionId, { status: "loading", title: null, origin: null, code: null, tailDegraded: false });
			return generation;
		},
		settle(generation, nextHostId, remoteSessionId, outcome) {
			if (nextHostId !== hostId || generations.get(remoteSessionId) !== generation) return false;
			if (outcome.kind === "ok") entries.set(remoteSessionId, { status: "ready", title: outcome.title, origin: outcome.origin, code: null, tailDegraded: outcome.tailDegraded === true });
			else if (outcome.kind === "unwired") entries.set(remoteSessionId, { status: "unavailable", title: null, origin: null, code: null, tailDegraded: false });
			else if (outcome.kind === "failed") entries.set(remoteSessionId, { status: "failed", title: null, origin: null, code: outcome.code, tailDegraded: false });
			else entries.set(remoteSessionId, { status: "failed", title: null, origin: null, code: null, tailDegraded: false });
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
				// 快照可能来自旧版本（没有 tailDegraded 字段）：缺省归一成 false，绝不让它变成 undefined。
				entries.set(remoteSessionId, { ...entry, tailDegraded: entry.tailDegraded === true });
			}
		},
	};
}
