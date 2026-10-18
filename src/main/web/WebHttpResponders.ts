/**
 * Web 服务的 HTTP 响应与请求体工具（从 WebServiceManager 按域迁出）。
 *
 * 这里只放无状态纯函数：不持有 token、不持有连接、不读 manager 字段。
 * 需要 manager 状态的能力（鉴权、事件推送、静态产物）留在各自的协作者模块里，
 * 避免把「工具库」退化成第二个 god object。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { replaceExpandedRefBlocksWithLabels } from "../../shared/expandedRefBlocks";
import { webEnUS } from "./WebI18n";

/** /api JSON 请求体逻辑上限：超出后丢弃剩余数据并回 413（合法 payload 都是短 JSON，见 memo H3） */
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
/** 硬上限：超过即断开连接，阻断无界上传占带宽/触发内存峰值 */
const HARD_BODY_ABORT_BYTES = 16 * 1024 * 1024;

/** readJson 超限的哨兵错误：由 createServer 的统一 catch 映射为 413 */
export class WebBodyTooLargeError extends Error {
	constructor() {
		super("WEB_SERVICE_BODY_TOO_LARGE");
		this.name = "WebBodyTooLargeError";
	}
}

/** readJson 遇到非法 JSON 的哨兵错误：由统一 catch 映射为 400（客户端错）而非 500 */
export class WebInvalidJsonError extends Error {
	constructor() {
		super("WEB_SERVICE_INVALID_JSON");
		this.name = "WebInvalidJsonError";
	}
}

/** 有界读文件：先 stat 校验大小再读，超过 maxBytes 抛错（避免把超大文件拉进内存）。 */
export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
	const info = await stat(path);
	if (!info.isFile() || info.size > maxBytes) {
		throw new Error(`WEB_SERVICE_FILE_TOO_LARGE_OR_MISSING: ${info.size} > ${maxBytes}`);
	}
	return readFile(path);
}

export function serializePublicWebPayload(body: unknown): string {
	return JSON.stringify(body, function (key, value) {
		if (key === "debugDetails" || key === "stack") return undefined;
		if (key === "error" && typeof value === "string" && this && typeof this === "object" && typeof (this as { i18nKey?: unknown }).i18nKey === "string") {
			const i18nKey = (this as { i18nKey: string }).i18nKey;
			return (webEnUS as Record<string, string>)[i18nKey] ?? webEnUS["webError.internal"];
		}
		return value;
	});
}

export async function readJson<T>(request: IncomingMessage, maxBytes: number = MAX_JSON_BODY_BYTES) {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	let oversized = false;
	for await (const chunk of request) {
		totalBytes += chunk.length;
		if (totalBytes > HARD_BODY_ABORT_BYTES) {
			// 硬上限：直接断连（此分支下 413 可能来不及送达，属预期）
			request.destroy();
			throw new WebBodyTooLargeError();
		}
		if (totalBytes > maxBytes) {
			// 逻辑上限：丢弃超限 chunk 但继续排空连接，保证 413 响应能送达客户端
			oversized = true;
			continue;
		}
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	if (oversized) throw new WebBodyTooLargeError();
	if (chunks.length === 0) return {} as T;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
	} catch {
		// 非法 JSON 是客户端错误，回 400 而不是 500（外层 handler 统一映射该异常类型）。
		throw new WebInvalidJsonError();
	}
}

export async function sendFile(filePath: string, response: ServerResponse): Promise<void> {
	const body = await readFile(filePath);
	response.writeHead(200, {
		"content-type": contentType(filePath),
		// HTML 入口（index.html / web.html）必须 no-store：PWA/SW 发新版后不能拿到旧壳引用旧 bundle；
		// sw.js 主脚本浏览器按规范绕过 HTTP 缓存检查更新，不受 immutable 影响
		"cache-control": filePath.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
	});
	response.end(body);
}

export function sendHtml(response: ServerResponse, html: string): void {
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(html);
}

export function contentType(filePath: string): string {
	switch (extname(filePath).toLowerCase()) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".ico":
			return "image/x-icon";
		case ".webmanifest":
			return "application/manifest+json; charset=utf-8";
		default:
			return "application/octet-stream";
	}
}

export function sendJson(response: ServerResponse, body: unknown): void {
	response.writeHead(200, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"access-control-allow-origin": "*",
	});
	response.end(serializePublicWebPayload(body));
}

export function sendError(response: ServerResponse, statusCode: number, code: string, error: string, params?: Record<string, string | number>): void {
	// headersSent 防护：流式路由（如 restart 进度 SSE）已写头后再失败时，不能再
	// writeHead——那公抛 ERR_HTTP_HEADERS_SENT 并升级为 unhandledRejection；
	// 尽力往已开的流里写一行 JSON 错误行后直接 end。
	if (response.headersSent) {
		try {
			response.end(`\n${JSON.stringify({ code, error, ...(params ? { params } : {}) })}\n`);
		} catch {
			try {
				response.end();
			} catch {
				/* 连接已断，无可-write */
			}
		}
		return;
	}
	response.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"access-control-allow-origin": "*",
	});
	response.end(
		JSON.stringify({
			code,
			error,
			...(params ? { params } : {}),
		}),
	);
}

export function sendNoContent(response: ServerResponse): void {
	response.writeHead(204, {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type",
	});
	response.end();
}
