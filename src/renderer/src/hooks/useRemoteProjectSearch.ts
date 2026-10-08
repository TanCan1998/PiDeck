import { useCallback, useEffect, useMemo, useState } from "react";
import { createRemoteProjectSearchController, readSearchResponse, type RemoteProjectSearchState, type RemoteSearchOutcome } from "../components/session/remoteProjectSearchState";

/**
 * 远端项目文件名搜索（渲染层，F2）。
 *
 * 状态机在 `remoteProjectSearchState`（纯函数，可离开 React 单测）；这里只做三件事：
 * 把主进程能力收窄成一个窄 port、按代次落地结果、在切项目/卸载时作废在途结果。
 *
 * port 的取值是**结构探测**而不是类型断言：F5 接线之前 preload 上没有 `searchProject`，
 * 这时宁可报「未接线」稳定码，也不假装成功、也不崩溃。接线落地后同一个调用点自然生效。
 */
export type RemoteProjectSearchPort = (projectId: string, path: string, query: string) => Promise<unknown>;

/** 未接线的稳定码：只可能出现在 F5 接线前，界面据此给出「搜索不可用」而不是编一个远端错误。 */
export const REMOTE_SEARCH_UNWIRED_CODE = "REMOTE_PROJECT_SEARCH_UNWIRED";

/**
 * 逐层结构收窄 `desktopApi.remoteHosts.searchProject`。
 *
 * 用 `Reflect.get` 逐层取值，是为了在 preload 尚未暴露该方法（或整个 api 是「未装载 preload」的
 * 抛错 Proxy）时不带断言地安全失败；任何一层不是预期的函数就是「未接线」。
 */
function searchProjectOf(api: unknown): RemoteProjectSearchPort | undefined {
	try {
		if (typeof api !== "object" || api === null) return undefined;
		const hosts: unknown = Reflect.get(api, "remoteHosts");
		if (typeof hosts !== "object" || hosts === null) return undefined;
		const call: unknown = Reflect.get(hosts, "searchProject");
		if (typeof call !== "function") return undefined;
		return (projectId, path, query) => Promise.resolve(call.call(hosts, projectId, path, query));
	} catch {
		// 未装载 preload 时的 Proxy 会在取值时抛错；那是「不可用」，不是崩溃。
		return undefined;
	}
}

/** 把宿主 api 收窄成搜索 port；未接线时返回一个恒定的「未接线」失败。 */
export function createRemoteProjectSearchPort(api: unknown): RemoteProjectSearchPort {
	const call = searchProjectOf(api);
	if (call === undefined) return async () => ({ ok: false, code: REMOTE_SEARCH_UNWIRED_CODE });
	return call;
}

export type RemoteProjectSearchHandle = {
	state: RemoteProjectSearchState;
	/** 发起一次搜索（query 由主进程边界重新校验；这里只保证不发空查询）。 */
	run: (query: string) => Promise<void>;
	/** 清除结果并回到 idle。 */
	reset: () => void;
};

export function useRemoteProjectSearch(hostApi: unknown, projectId: string): RemoteProjectSearchHandle {
	const [controller] = useState(createRemoteProjectSearchController);
	const [state, setState] = useState<RemoteProjectSearchState>(() => controller.getState());
	const port = useMemo(() => createRemoteProjectSearchPort(hostApi), [hostApi]);

	const run = useCallback(
		async (query: string) => {
			if (query.length === 0) return;
			const generation = controller.start(query);
			setState(controller.getState());
			let outcome: RemoteSearchOutcome;
			try {
				// 相对项目根的搜索路径：渲染层这一层把根拼成空串，IPC 边界把它翻成 helper 的 "."（既有约定）。
				outcome = readSearchResponse(await port(projectId, "", query));
			} catch {
				// IPC reject：连失败形状都没有，只能报「请求失败」，不编造远端码。
				outcome = { kind: "rejected" };
			}
			// 代次已作废时整体丢弃：迟到的结果绝不能覆盖新查询或新项目。
			if (controller.settle(generation, outcome)) setState(controller.getState());
		},
		[controller, port, projectId],
	);

	const reset = useCallback(() => {
		controller.reset();
		setState(controller.getState());
	}, [controller]);

	// 切项目：作废上一个项目的在途结果。
	useEffect(() => {
		reset();
	}, [projectId, reset]);

	// 卸载：只作废，不再 setState。
	useEffect(
		() => () => {
			controller.reset();
		},
		[controller],
	);

	return { state, run, reset };
}
