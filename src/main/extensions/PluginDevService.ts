/**
 * 插件开发支持：把内置 demo 插件复制进用户扩展目录、生成 AI 开发指南。
 * 目录约定与 ExtensionManager.scanLocalExtensions 一致：~/.pi/agent/extensions/
 * （WSL 环境下 homeDir 由装配层传入，与扩展列表同一来源，保证「复制进去的文件
 * 一定出现在扩展页」）。不依赖 electron API，保持 node --test 可直接加载。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppLogger } from "../logging/sharedLogger";
import { buildPluginDevGuideMarkdown, DEMO_PLUGIN_FILENAME, PLUGIN_DEV_GUIDE_FILENAME, type PluginDevGuidePaths } from "../../shared/pluginDevGuide";
import type { GuideLocale } from "../../shared/pluginDevCatalog";
import type { BuiltInExtensionPathRoots } from "./builtInExtensions";

export type PluginDevStatus = {
	/** 用户级扩展目录（demo/指南的落点，也是指南里让 AI 放插件的地方） */
	userExtensionsDir: string;
	/** demo 插件是否已在用户目录（已存在时复制按钮提示覆盖确认） */
	demoInstalled: boolean;
	/** 指南是否已写入（存在即可在 AI 对话里直接引用路径） */
	guideInstalled: boolean;
};

export type CopyDemoResult = { status: "copied" | "exists"; path: string };

/** 内置 demo 源文件路径：开发态随仓库 resources/，打包态随 extraResources 的 plugin-dev/。 */
export function resolveDemoPluginSourcePath(roots: BuiltInExtensionPathRoots): string {
	return join(roots.isDev ? join(roots.appPath, "resources", "plugin-dev") : join(roots.resourcesPath, "plugin-dev"), DEMO_PLUGIN_FILENAME);
}

export class PluginDevService {
	constructor(
		private readonly roots: BuiltInExtensionPathRoots,
		/** 用户 home（WSL 时传发行版侧 home 的 Windows 视角路径，与 ExtensionManager.homeDir 同源）。 */
		private readonly getHomeDir: () => string,
	) {}

	/** 用户级扩展目录：demo/指南/用户自写插件的统一落点。 */
	userExtensionsDir(): string {
		return join(this.getHomeDir(), ".pi", "agent", "extensions");
	}

	status(): PluginDevStatus {
		const dir = this.userExtensionsDir();
		return {
			userExtensionsDir: dir,
			demoInstalled: existsSync(join(dir, DEMO_PLUGIN_FILENAME)),
			guideInstalled: existsSync(join(dir, PLUGIN_DEV_GUIDE_FILENAME)),
		};
	}

	/**
	 * 把 AI 开发指南写入用户扩展目录（覆盖旧版本，指南是生成物、无用户编辑价值）。
	 * 返回文件路径；IPC 层负责在资源管理器定位。
	 */
	async writeGuide(locale: GuideLocale): Promise<string> {
		const dir = this.userExtensionsDir();
		await mkdir(dir, { recursive: true });
		const paths: PluginDevGuidePaths = { userExtensionsDir: dir };
		const file = join(dir, PLUGIN_DEV_GUIDE_FILENAME);
		await writeFile(file, buildPluginDevGuideMarkdown(locale, paths), "utf8");
		getAppLogger()?.info("pluginDev", "Plugin dev guide written", { file });
		return file;
	}

	/**
	 * 复制内置 demo 插件到用户扩展目录。
	 * 目标已存在时不覆盖（可能是用户改过的起步模板），返回 exists 让 UI 提示。
	 */
	async copyDemoPlugin(): Promise<CopyDemoResult> {
		const dir = this.userExtensionsDir();
		const target = join(dir, DEMO_PLUGIN_FILENAME);
		if (existsSync(target)) return { status: "exists", path: target };
		const source = resolveDemoPluginSourcePath(this.roots);
		const content = await readFile(source, "utf8").catch(() => null);
		if (content === null) {
			// 打包缺资源属于发布缺陷：明确报错而不是静默失败，便于安装包 smoke 时发现
			throw new Error(`Demo plugin source missing: ${source}`);
		}
		await mkdir(dir, { recursive: true });
		await writeFile(target, content, "utf8");
		getAppLogger()?.info("pluginDev", "Demo plugin copied", { target });
		return { status: "copied", path: target };
	}
}
