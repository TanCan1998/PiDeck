import { useAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { remoteSessionTitleByHostAtom } from "../atoms/remote-sessions-atoms";
import { createRemoteSessionTitleController, readTitleResponse, type RemoteSessionTitleEntry } from "../components/session/remoteSessionTitleState";

/**
 * 惰性取远端会话标题（渲染层 H2，配合 H1 的 `remoteSessions.title`）。
 *
 * 惰性：列表先用扫描给的 stem 占位，只有真正需要的那几条（列表展开后进入视口）才发起取标题，
 * 每条只取一次（ready 命中缓存；加载中不重复发起）。缓存按主机写进 Jotai atom，重挂载不重取。
 *
 * 代次：控制器按「主机 + 会话」记账，切主机/卸载作废在途结果；旧主机的迟到标题绝不会落到新主机的会话上。
 *
 * 未接线（H1 handler 还没落地）时端口返回 undefined，状态记成 unavailable：界面继续显示 stem 占位，
 * 不报错、不编造标题；handler 接上后同一调用点自动生效。
 */

export type RemoteSessionTitlePort = (hostId: string, remoteSessionId: string) => Promise<unknown>;

function titleCallOf(hostApi: unknown): ((hostId: string, remoteSessionId: string) => unknown) | undefined {
	try {
		if (typeof hostApi !== "object" || hostApi === null) return undefined;
		const sessions: unknown = Reflect.get(hostApi, "remoteSessions");
		if (typeof sessions !== "object" || sessions === null) return undefined;
		const call: unknown = Reflect.get(sessions, "title");
		if (typeof call !== "function") return undefined;
		return (hostId, remoteSessionId) => call.call(sessions, hostId, remoteSessionId);
	} catch {
		return undefined;
	}
}

/** 收窄出取标题 port；未接线返回 undefined（调用方据此记 unavailable，而不是发一个注定失败的请求）。 */
export function createRemoteSessionTitlePort(hostApi: unknown): RemoteSessionTitlePort | undefined {
	const call = titleCallOf(hostApi);
	if (call === undefined) return undefined;
	return (hostId, remoteSessionId) => Promise.resolve(call(hostId, remoteSessionId));
}

export type RemoteSessionTitlesHandle = {
	/** 某条会话的标题状态；idle/unavailable/failed 时由界面回退到扫描给的 stem。 */
	statusOf: (remoteSessionId: string) => RemoteSessionTitleEntry;
	/** 按需请求一条标题（进入视口/展开时调用）；已 ready 或加载中不会重复发起。 */
	request: (remoteSessionId: string) => void;
};

export function useRemoteSessionTitles(hostApi: unknown, hostId: string): RemoteSessionTitlesHandle {
	const [titlesByHost, setTitlesByHost] = useAtom(remoteSessionTitleByHostAtom);
	// 控制器必须在**首次渲染前**就带上缓存：子行（RemoteSessionRow）的 effect 早于父级 effect 运行，
	// 用 effect 恢复会让「已缓存列表首次渲染」时 hostIdRef 还是空、那几行标题请求被静默丢掉。
	const [controller] = useState(() => {
		const created = createRemoteSessionTitleController();
		created.restore(hostId, titlesByHost[hostId] ?? {});
		return created;
	});
	const titlesRef = useRef(titlesByHost);
	titlesRef.current = titlesByHost;
	// 初始值就是当前主机：第一帧的按需请求不会因为「还没跑 effect」而丢失。
	const hostIdRef = useRef<string | null>(hostId);
	const portRef = useRef<RemoteSessionTitlePort | undefined>(createRemoteSessionTitlePort(hostApi));
	portRef.current = createRemoteSessionTitlePort(hostApi);

	// 切主机：恢复该主机的标题缓存并作废在途结果（首次挂载已在 useState 初始化里恢复过）。
	useEffect(() => {
		if (hostIdRef.current === hostId) return;
		hostIdRef.current = hostId;
		controller.restore(hostId, titlesRef.current[hostId] ?? {});
	}, [controller, hostId]);

	useEffect(
		() => () => {
			controller.reset();
		},
		[controller],
	);

	/** 把控制器里这几条的当前状态写回 atom：atom 才是重挂载后的渲染来源。 */
	const publish = useCallback(
		(target: string, remoteSessionIds: readonly string[]) => {
			setTitlesByHost((previous) => {
				const forHost = { ...(previous[target] ?? {}) };
				for (const remoteSessionId of remoteSessionIds) forHost[remoteSessionId] = controller.statusOf(remoteSessionId);
				return { ...previous, [target]: forHost };
			});
		},
		[controller, setTitlesByHost],
	);

	const request = useCallback(
		(remoteSessionId: string) => {
			const target = hostIdRef.current;
			if (target === null) return;
			const generation = controller.begin(target, remoteSessionId);
			if (generation === null) return;
			// loading 立即可见（界面据此显示「解析中」，而不是假装已有标题）。
			publish(target, [remoteSessionId]);
			const port = portRef.current;
			if (port === undefined) {
				if (controller.settle(generation, target, remoteSessionId, { kind: "unwired" })) publish(target, [remoteSessionId]);
				return;
			}
			void (async () => {
				let raw: unknown;
				try {
					raw = await port(target, remoteSessionId);
				} catch {
					raw = undefined;
				}
				// 代次/主机不符时 settle 返回 false：迟到的标题整体丢弃，不覆盖新状态。
				if (controller.settle(generation, target, remoteSessionId, readTitleResponse(raw))) publish(target, [remoteSessionId]);
			})();
		},
		[controller, publish],
	);

	return { statusOf: (remoteSessionId) => controller.statusOf(remoteSessionId), request };
}
