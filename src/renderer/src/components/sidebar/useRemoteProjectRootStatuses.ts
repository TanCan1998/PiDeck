import { useAtom } from "jotai";
import { useEffect, useRef } from "react";
import { isRemoteProject } from "../../../../shared/projectLocation";
import type { Project } from "../../../../shared/types";
import { remoteProjectRootStatusAtom } from "../../atoms/remote-sessions-atoms";
import { createRequestGate } from "../session/remoteRequestGate";
import { readRootStatusResponse, type RemoteProjectRootStatusView } from "./remoteProjectStatusState";

/**
 * 远端项目 root 复核状态（设计 (i) 的呈现端，项目级）。
 *
 * `remoteHosts.rootStatus(projectId)` 是只读查询（不建会话、无 helper 请求），所以可以随项目清单渲染
 * 按需批量查询；但**必须走请求代次闸门**：项目清单刷新（或卸载）会作废整批在途结果，旧批次绝不能
 * 覆盖新批次——否则一次刷新后，旧状态可能盖到同名项目的新状态上。
 *
 * 状态写进 Jotai atom 由侧栏标签读取；这里只负责查询与落地，不渲染任何东西。
 */

/** 未接线的稳定码：只可能出现在 preload 尚未暴露 rootStatus 时。 */
export const REMOTE_PROJECT_ROOT_STATUS_UNWIRED_CODE = "REMOTE_PROJECT_ROOT_STATUS_UNWIRED";

export type RemoteProjectRootStatusPort = (projectId: string) => Promise<unknown>;

function unwiredPort(): RemoteProjectRootStatusPort {
	return async () => ({ ok: false, code: REMOTE_PROJECT_ROOT_STATUS_UNWIRED_CODE });
}

/** 逐层结构收窄 `desktopApi.remoteHosts.rootStatus`；任何一层不是函数就是「未接线」。 */
export function createRemoteProjectRootStatusPort(hostApi: unknown): RemoteProjectRootStatusPort {
	try {
		if (typeof hostApi !== "object" || hostApi === null) return unwiredPort();
		const hosts: unknown = Reflect.get(hostApi, "remoteHosts");
		if (typeof hosts !== "object" || hosts === null) return unwiredPort();
		const call: unknown = Reflect.get(hosts, "rootStatus");
		if (typeof call !== "function") return unwiredPort();
		return (projectId) => Promise.resolve(call.call(hosts, projectId));
	} catch {
		return unwiredPort();
	}
}

/**
 * 随项目清单变化，为每个远端项目查询一次 root 状态。
 *
 * 查询是「尽力而为」：失败/未接线一律记成 unavailable（界面不显示提示、不报警），因为这条提示的
 * 唯一目的是把需要用户处理的目录显式呈现出来，而不是制造噪音。
 */
export function useRemoteProjectRootStatuses(hostApi: unknown, projects: readonly Project[]): void {
	const [, setStatuses] = useAtom(remoteProjectRootStatusAtom);
	const gateRef = useRef(createRequestGate());
	const portRef = useRef<RemoteProjectRootStatusPort>(createRemoteProjectRootStatusPort(hostApi));
	portRef.current = createRemoteProjectRootStatusPort(hostApi);

	useEffect(() => {
		const gate = gateRef.current;
		const port = portRef.current;
		const remoteProjects = projects.filter(isRemoteProject);
		if (remoteProjects.length === 0) {
			setStatuses({});
			return;
		}
		const generation = gate.begin();
		const settled = new Map<string, RemoteProjectRootStatusView>();
		for (const project of remoteProjects) {
			void (async () => {
				let view: RemoteProjectRootStatusView;
				try {
					view = readRootStatusResponse(await port(project.id));
				} catch {
					view = { status: "unavailable", code: null };
				}
				// 旧批次（刷新/卸载）的迟到结果整体丢弃。
				if (!gate.isCurrent(generation)) return;
				settled.set(project.id, view);
				setStatuses((previous) => {
					// 只保留当前清单里的项目：被移除的项目不能留下幽灵提示；未落地的沿用上一次的值。
					const next: Record<string, RemoteProjectRootStatusView> = {};
					for (const candidate of remoteProjects) {
						const value = settled.get(candidate.id) ?? previous[candidate.id];
						if (value !== undefined) next[candidate.id] = value;
					}
					return next;
				});
			})();
		}
		return () => {
			// 清单刷新/卸载：作废本批次在途结果。
			gate.invalidate();
		};
	}, [projects, setStatuses]);
}
