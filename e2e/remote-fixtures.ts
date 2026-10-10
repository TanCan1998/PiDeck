import { _electron as electron, test as base, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * 远端主机功能级验收（task-25）的专用 fixture 与纯函数。
 *
 * 与 e2e/fixtures.ts 的两点刻意差异，都是真机验收的必要条件：
 * 1) **不隔离 HOME/USERPROFILE**：产品自身用系统 OpenSSH 连主机，必须能读到真实用户的
 *    ~/.ssh/config 与私钥；只隔离 Electron 的 userData（--user-data-dir + APPDATA/LOCALAPPDATA），
 *    绝不碰开发者的真实应用数据。
 * 2) 启动就带 PIDECK_REMOTE_EXPERIMENTAL=1：远端能力在 main 里受开发态门禁约束
 *    （!app.isPackaged && env=1），e2e 跑的是未打包产物，这里显式打开。
 *
 * 凭据只从环境变量读；仓库里不存在也不允许出现真实主机/指纹字面量。
 */

/** 凭据与超时环境变量的唯一出处：spec、fixture 与守卫测试都从这里取名字。 */
export const REMOTE_ACCEPTANCE_ENV = {
	host: "PIDECK_E2E_REMOTE_HOST",
	user: "PIDECK_E2E_REMOTE_USER",
	fingerprint: "PIDECK_E2E_REMOTE_FINGERPRINT",
	port: "PIDECK_E2E_REMOTE_PORT",
	connectTimeoutMs: "PIDECK_E2E_REMOTE_CONNECT_TIMEOUT_MS",
	helperTimeoutMs: "PIDECK_E2E_REMOTE_HELPER_TIMEOUT_MS",
} as const;

export type RemoteAcceptanceCredentials = { host: string; user: string; fingerprint: string; port: number };
export type RemoteAcceptanceTimeouts = { connectMs: number; helperMs: number };

const DEFAULT_CONNECT_TIMEOUT_MS = 180_000;
const DEFAULT_HELPER_TIMEOUT_MS = 240_000;
/** ED25519 SHA256 指纹形态：恰好一个 SHA256: 前缀 + base64 段（前缀大小写不敏感，正文逐字保留）。 */
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/;

/**
 * 归一化指纹；形态不认识就返回空串（调用方据此当作「没有凭据」而不是「指纹匹配」）。
 *
 * 口径：**前缀大小写不敏感**（env 是用户手输的，sha256:/SHA256: 都接受，统一归一成 SHA256:），
 * base64 正文**逐字保留**（base64 区分大小写，正文放宽才是真的放水）。空正文、双前缀、
 * 无前缀、纯空白一律不可用。
 */
export function normalizeRemoteFingerprint(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 8) return "";
	const prefix = trimmed.slice(0, 7);
	if (prefix.toUpperCase() !== "SHA256:") return "";
	const normalized = "SHA256:" + trimmed.slice(7);
	return FINGERPRINT.test(normalized) ? normalized : "";
}

/** 期望指纹是否命中界面上真实展示的指纹集合（逐项归一化比较）。 */
export function matchesRemoteFingerprint(expected: string, observed: readonly string[]): boolean {
	const normalized = normalizeRemoteFingerprint(expected);
	if (normalized === "") return false;
	return observed.some((value) => normalizeRemoteFingerprint(value) === normalized);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readRemoteAcceptanceTimeouts(env: Record<string, string | undefined>): RemoteAcceptanceTimeouts {
	return {
		connectMs: readPositiveInt(env[REMOTE_ACCEPTANCE_ENV.connectTimeoutMs], DEFAULT_CONNECT_TIMEOUT_MS),
		helperMs: readPositiveInt(env[REMOTE_ACCEPTANCE_ENV.helperTimeoutMs], DEFAULT_HELPER_TIMEOUT_MS),
	};
}

/**
 * 解析凭据：三个必需变量缺任意一个（或指纹/端口形态不合法）一律返回 undefined，
 * 即「无凭据 → 整体 skip」。刻意没有半凭据分支，避免以半套配置跑出一个假结论。
 */
export function readRemoteAcceptanceCredentials(env: Record<string, string | undefined>): RemoteAcceptanceCredentials | undefined {
	const host = env[REMOTE_ACCEPTANCE_ENV.host]?.trim() ?? "";
	const user = env[REMOTE_ACCEPTANCE_ENV.user]?.trim() ?? "";
	const fingerprint = normalizeRemoteFingerprint(env[REMOTE_ACCEPTANCE_ENV.fingerprint] ?? "");
	if (host === "" || user === "" || fingerprint === "") return undefined;
	const rawPort = env[REMOTE_ACCEPTANCE_ENV.port]?.trim();
	const port = rawPort === undefined || rawPort === "" ? 22 : Number(rawPort);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
	return { host, user, fingerprint, port };
}

const execFileAsync = promisify(execFile);

/**
 * 在真机上跑一条受限命令（只用于测试前置/恢复：建目录、写会话文件、改名、清理）。
 * BatchMode：绝不允许交互式密码提示把 e2e 挂住；超时由调用方给。
 */
export async function runRemoteCommand(credentials: RemoteAcceptanceCredentials, command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8", "-p", String(credentials.port), credentials.user + "@" + credentials.host, command], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
	return { stdout, stderr };
}

const repoRoot = resolve(__dirname, "..");

export type RemoteAppFixture = { remoteApp: ElectronApplication; remoteWindow: Page; remoteUserDataRoot: string };

export const test = base.extend<RemoteAppFixture & { remoteCredentials: RemoteAcceptanceCredentials }>({
	// 凭据 fixture 先于 remoteApp：缺凭据时先 skip，连临时目录都不会建。
	remoteCredentials: async ({}, use) => {
		const credentials = readRemoteAcceptanceCredentials(process.env);
		if (credentials === undefined) {
			// 缺凭据 = 整体 skip：不建临时目录、不启动 Electron（test.skip 会抛出跳过信号）。
			test.skip(true, "set " + [REMOTE_ACCEPTANCE_ENV.host, REMOTE_ACCEPTANCE_ENV.user, REMOTE_ACCEPTANCE_ENV.fingerprint].join(" / ") + " to run the real-host acceptance test");
			return;
		}
		await use(credentials);
	},
	remoteUserDataRoot: async ({}, use) => {
		const dir = mkdtempSync(join(tmpdir(), "pideck-e2e-remote-"));
		await use(dir);
		await rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
	},
	remoteApp: async ({ remoteUserDataRoot }, use) => {
		// 依赖 remoteCredentials：无凭据时该 fixture 已被 skip，这里根本不会执行（也就不会启动 Electron）。
		const entry = join(repoRoot, "out", "main", "index.js");
		if (!existsSync(entry)) throw new Error("out/main/index.js 不存在：先跑 npm run build:fast（e2e 不负责构建）");
		const profileDir = join(remoteUserDataRoot, "profile");
		mkdirSync(profileDir, { recursive: true });
		// 语言固定 zh-CN，e2e 的按钮/标签选择器才与字典一致（不受宿主机系统语言影响）。
		writeFileSync(join(profileDir, "settings.json"), JSON.stringify({ language: "zh-CN" }));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PIDECK_E2E_USER_DATA_DIR: profileDir,
			// 只隔离 userData；USERPROFILE/HOME 保持真实，OpenSSH 才能读到真用户的 config 与私钥。
			APPDATA: remoteUserDataRoot,
			LOCALAPPDATA: remoteUserDataRoot,
			PIDECK_REMOTE_EXPERIMENTAL: "1",
			PIDECK_E2E: "1",
			CI: "1",
		};
		delete env.ELECTRON_RENDERER_URL;
		const app = await electron.launch({ args: [entry, "--user-data-dir=" + profileDir], env });
		await use(app);
		await app.close();
	},
	remoteWindow: async ({ remoteApp }, use) => {
		const window = await remoteApp.firstWindow();
		await window.waitForLoadState("domcontentloaded");
		// 启动引导弹窗会抢焦点/遮拦点击：与 e2e/fixtures.ts 同一处理（出现即关）。
		await expectBootOverlayGone(window);
		await use(window);
	},
});

/** 启动遮罩消失是后续所有点击的前提；单独抽出来，失败信息比后续点击超时更可读。 */
async function expectBootOverlayGone(window: Page): Promise<void> {
	const overlay = window.locator("#boot-overlay");
	await overlay.waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
}
