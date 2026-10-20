import { readFile, stat } from "node:fs/promises";
import { localImageMimeType } from "../../shared/localImage";
import { canonicalizeRoots, classifyLocalImagePath, isInsideAnyRoot, isLocalImageSizeAllowed } from "./localImageAccess";
import { nativeRealpath } from "./nativeRealpath";

/**
 * 本地图片字节读取（保存/复制用）。
 *
 * 为什么存在：展示走 `pideck-file://` 协议（`<img>` 直接加载）；但「保存/复制」要在渲染层拿到
 * **字节**，而 `fetch("pideck-file://…")` 在该 scheme 上不可用——`corsEnabled: false` 的
 * 自定义 scheme 会让渲染层 fetch 直接 `TypeError: Failed to fetch`（2026-10-20 e2e 实测：
 * 保存按钮只会弹失败提示）。所以这条读取走 IPC，判定逻辑与协议**完全复用**：
 * 形态闸 → native realpath → 白名单根 → 体积闸。
 *
 * 读不到返回 null（不抛给渲染层）：保存/复制统一降级成「失败提示」。
 */

function safeRealpath(path: string): string | null {
	try {
		return nativeRealpath(path);
	} catch {
		return null;
	}
}

export type LocalImageBytesResult = { bytes: Buffer; mimeType: string } | null;

/**
 * 读一张白名单内的本地图片。
 * @param rawPath 渲染层给的绝对路径（不可信输入：所有闸门在这里重判一遍，不信任渲染层）。
 * @param resolveRoots 白名单根（与 `pideck-file://` 协议共用一个提供者）。
 */
export async function readLocalImageBytes(rawPath: string, resolveRoots: () => readonly string[]): Promise<LocalImageBytesResult> {
	const shape = classifyLocalImagePath(rawPath);
	if (!shape.ok) return null;
	const realPath = safeRealpath(shape.path);
	if (!realPath) return null;
	const roots = await canonicalizeRoots(resolveRoots(), async (root) => safeRealpath(root) ?? root);
	if (!isInsideAnyRoot(realPath, roots)) return null;
	const info = await stat(realPath).catch(() => null);
	if (!info?.isFile() || !isLocalImageSizeAllowed(info.size)) return null;
	const mimeType = localImageMimeType(realPath);
	if (!mimeType) return null;
	const bytes = await readFile(realPath).catch(() => null);
	return bytes ? { bytes, mimeType } : null;
}
