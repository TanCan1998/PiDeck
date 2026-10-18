/**
 * 桥「宿主原生服务」的执行器（service-call 协议的 PiDeck 侧实现）。
 *
 * 拆出 BridgeServer 的原因：BridgeServer 保持纯 node:http（测试不依赖 Electron），
 * 这里把「参数校验」与「能力调用」分开 —— 校验是纯函数可直接单测，
 * dialog/shell 依赖由 AgentManager 注入（构造时传真实 Electron API，测试传桩）。
 *
 * 安全边界（AGENTS.md「输入校验在边界」「路径安全」）：
 * - 扩展侧数据一律不可信，先校验形状与上限再碰 Electron API；
 * - filePicker：扩展只能「描述」要选什么（标题/多选/目录/过滤器），不能指定起始路径
 *   （否则等于把任意目录枚举能力交给扩展，用户看到的只是「选文件」）；
 * - openPath：只接受绝对本地路径，拒绝 URL/相对路径/超长输入 —— 与用户双击文件等价。
 */

import type { BridgeServiceName } from "../../../shared/types/bridge";

/** filePicker 参数（扩展侧 gui.filePicker 的 opts）。 */
export type FilePickerArgs = {
	title?: string;
	multiple?: boolean;
	directory?: boolean;
	filters?: { name: string; extensions: string[] }[];
};

/** showOpenDialog 的最小依赖面（注入 electron.dialog.showOpenDialog 同形函数）。 */
export type ShowOpenDialogFn = (options: { title?: string; properties: ("openFile" | "openDirectory" | "multiSelections")[]; filters?: { name: string; extensions: string[] }[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;

/** shell.openPath 的最小依赖面（返回空串=成功，否则为错误消息）。 */
export type OpenPathFn = (path: string) => Promise<string>;

/** 上限（防扩展构造巨型对话框描述刷爆主进程）。 */
const MAX_TITLE_CHARS = 200;
const MAX_FILTERS = 10;
const MAX_FILTER_NAME_CHARS = 100;
const MAX_EXTENSIONS_PER_FILTER = 20;
const MAX_EXTENSION_CHARS = 16;
const MAX_PATH_CHARS = 2048;
/** 扩展名白名单正则。必须 new RegExp 插值上限常量 —— 正则字面量里的 {1,MAX_EXTENSION_CHARS} 不会被 TS 替换，是字面文本（测试抓到的真 bug）。 */
const EXTENSION_PATTERN = new RegExp(`^[A-Za-z0-9]{1,${MAX_EXTENSION_CHARS}}$`);

/** 校验 filePicker 参数；非法返回 null（调用方回错误，不碰 dialog）。 */
export function parseFilePickerArgs(args: unknown): FilePickerArgs | null {
	if (args === undefined || args === null) return {};
	if (typeof args !== "object") return null;
	const raw = args as Record<string, unknown>;
	const parsed: FilePickerArgs = {};
	if (raw.title !== undefined) {
		if (typeof raw.title !== "string" || raw.title.length > MAX_TITLE_CHARS) return null;
		parsed.title = raw.title;
	}
	if (raw.multiple !== undefined) {
		if (typeof raw.multiple !== "boolean") return null;
		parsed.multiple = raw.multiple;
	}
	if (raw.directory !== undefined) {
		if (typeof raw.directory !== "boolean") return null;
		parsed.directory = raw.directory;
	}
	if (raw.filters !== undefined) {
		if (!Array.isArray(raw.filters) || raw.filters.length > MAX_FILTERS) return null;
		const filters: { name: string; extensions: string[] }[] = [];
		for (const filter of raw.filters) {
			if (filter === null || typeof filter !== "object") return null;
			const { name, extensions } = filter as { name?: unknown; extensions?: unknown };
			if (typeof name !== "string" || name.length > MAX_FILTER_NAME_CHARS) return null;
			if (!Array.isArray(extensions) || extensions.length === 0 || extensions.length > MAX_EXTENSIONS_PER_FILTER) return null;
			for (const ext of extensions) {
				// 扩展名只允许字母数字（zip/png/json…），杜绝把控制字符塞进系统对话框
				if (typeof ext !== "string" || !EXTENSION_PATTERN.test(ext)) return null;
			}
			filters.push({ name, extensions: extensions as string[] });
		}
		parsed.filters = filters;
	}
	return parsed;
}

/** 校验 openPath 参数：绝对本地路径（盘符或 UNC 开头），拒绝 URL/相对路径。 */
export function parseOpenPathArgs(args: unknown): { path: string } | null {
	if (args === null || typeof args !== "object") return null;
	const raw = args as Record<string, unknown>;
	if (typeof raw.path !== "string" || !raw.path) return null;
	const path = raw.path;
	if (path.length > MAX_PATH_CHARS) return null;
	if (path.includes("://")) return null; // URL 一律拒绝（openPath 只开本地文件/目录）
	// Windows 盘符（C:\ 或 C:/）或 UNC（\\server\share）；posix 绝对路径（/…）也放行
	const isAbsolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(path);
	if (!isAbsolute) return null;
	return { path };
}

/**
 * 组装服务执行器。返回的函数抛错 = 服务失败（BridgeServer 捕获后回 ok:false）；
 * 正常返回值即 service-result 的 result 字段：
 * - filePicker → `string[] | null`（null = 用户取消）
 * - openPath → `boolean`（true = 成功）
 */
export function createBridgeServiceHandler(deps: { showOpenDialog: ShowOpenDialogFn; openPath: OpenPathFn }): (service: BridgeServiceName, args: unknown) => Promise<unknown> {
	return async (service, args) => {
		if (service === "filePicker") {
			const parsed = parseFilePickerArgs(args);
			if (!parsed) throw new Error("invalid filePicker args");
			const properties: ("openFile" | "openDirectory" | "multiSelections")[] = [parsed.directory ? "openDirectory" : "openFile"];
			if (parsed.multiple) properties.push("multiSelections");
			const result = await deps.showOpenDialog({ title: parsed.title, properties, filters: parsed.filters });
			return result.canceled || result.filePaths.length === 0 ? null : result.filePaths;
		}
		if (service === "openPath") {
			const parsed = parseOpenPathArgs(args);
			if (!parsed) throw new Error("invalid openPath args");
			const errorMessage = await deps.openPath(parsed.path);
			return errorMessage === "" ? true : false;
		}
		throw new Error(`unknown service: ${service}`);
	};
}
