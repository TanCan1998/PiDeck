import { useEffect, useMemo } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { sessionCommandsAtomFamily } from "../atoms/session-commands-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { desktopApi } from "../desktopApi";
import { mergeCommands } from "../components/app/AppUtils";
import { requireSessionCommand, toSessionRuntimeTarget } from "../utils/sessionCommands";

const NO_SESSION = "";
const EMPTY_NAMES: Set<string> = new Set<string>();

/**
 * 加载某会话的 runtime 命令名单（历史消息 `/命令` chip 白名单）。
 *
 * - 按 sessionId 订阅 atom family，分屏/多栏各拿各的，不读全局聚焦态；
 * - runtime（agentId + generation）变化时重拉，迟到结果用 current 标志丢弃；
 * - 无会话/无 runtime/加载失败一律空集合（chip 白名单为空 = 按纯文本渲染，行为安全）。
 */
export function useSessionCommandNames(sessionId: string | undefined): Set<string> {
	const key = sessionId ?? NO_SESSION;
	const commands = useAtomValue(sessionCommandsAtomFamily(key));
	const setCommands = useSetAtom(sessionCommandsAtomFamily(key));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(key));

	useEffect(() => {
		const target = toSessionRuntimeTarget(key, runtime);
		if (!target) {
			setCommands([]);
			return;
		}
		let current = true;
		void desktopApi.sessions
			.listRuntimeCommands(target)
			.then((result) => {
				if (current) setCommands(requireSessionCommand(result).value);
			})
			.catch(() => {
				if (current) setCommands([]);
			});
		return () => {
			current = false;
		};
	}, [key, runtime, setCommands]);

	return useMemo(() => (commands.length === 0 ? EMPTY_NAMES : new Set(mergeCommands(commands).map((command) => command.name))), [commands]);
}
