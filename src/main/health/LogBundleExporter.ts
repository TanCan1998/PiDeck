import { app, dialog } from "electron";
import { open, readFile, writeFile } from "node:fs/promises";
import type { AppLogger } from "../logging/AppLogger";
import { parseLogLine } from "../logging/logQuery";
import type { HealthExportResult } from "../../shared/types";
import { createPathMasker, redactSecrets, truncateText } from "./redact";
import { buildZip, type ZipEntry } from "./zipStore";

/** 报告/JSON 的体积上限：防止异常大的输入把保存流程拖死（约 2MB 文本，远超正常报告）。 */
const MAX_MARKDOWN_CHARS = 2_000_000;
const MAX_JSON_CHARS = 2_000_000;
/** 单个日志文件进入 zip 的字节上限：超过时只取末尾部分（最近的日志才有诊断价值）。 */
const MAX_LOG_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LINE_CHARS = 400;

export type LogBundleExporterDeps = {
	appLogger: AppLogger;
};

export type HealthExportInput = {
	/** 渲染层生成的 Markdown 报告原文 */
	markdown: string;
	/** 结构化体检数据的 JSON 字符串（写进 zip 的 environment.json） */
	reportJson: string;
};

function stamp(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 诊断产物导出器：把报告和日志写到用户选择的路径。
 *
 * 隐私边界：zip 里的日志**不是原文件拷贝**，而是逐行解析后只保留
 * time/level/scope/message 并做脱敏——原始日志的 detail 字段可能含完整路径、
 * 请求体或用户文件内容，绝不能随包外发。
 */
export class LogBundleExporter {
	constructor(private readonly deps: LogBundleExporterDeps) {}

	/** 把 Markdown 报告存成 .md 文件。 */
	async exportReport(input: HealthExportInput | { markdown: string; reportJson?: string }): Promise<HealthExportResult> {
		const markdown = this.validateMarkdown(input.markdown);
		const { canceled, filePath } = await dialog.showSaveDialog({
			defaultPath: `pideck-diagnostics-${stamp()}.md`,
			filters: [{ name: "Markdown", extensions: ["md"] }],
		});
		if (canceled || !filePath) return { ok: false, canceled: true };
		try {
			await writeFile(filePath, markdown, "utf8");
			// 诊断产物写到应用目录之外，属数据出域动作，留痕便于事后确认外发了什么
			void this.deps.appLogger.info("diagnostics", "Diagnostics report exported", { path: filePath, bytes: markdown.length });
			return { ok: true, canceled: false, path: filePath };
		} catch (error) {
			return { ok: false, canceled: false, error: this.describeError(error) };
		}
	}

	/** 打包完整日志 + 报告 + 环境 JSON 为 zip。 */
	async exportBundle(input: HealthExportInput): Promise<HealthExportResult> {
		const markdown = this.validateMarkdown(input.markdown);
		const reportJson = this.validateJson(input.reportJson);
		const { canceled, filePath } = await dialog.showSaveDialog({
			defaultPath: `pideck-diagnostics-${stamp()}.zip`,
			filters: [{ name: "ZIP", extensions: ["zip"] }],
		});
		if (canceled || !filePath) return { ok: false, canceled: true };
		try {
			const entries: ZipEntry[] = [
				{ name: "diagnostics/report.md", data: Buffer.from(markdown, "utf8"), modifiedAt: new Date() },
				{ name: "diagnostics/environment.json", data: Buffer.from(reportJson, "utf8"), modifiedAt: new Date() },
			];
			const files = await this.deps.appLogger.listFiles();
			for (const file of files) {
				const text = await this.readRedactedLogFile(file.path, file.sizeBytes);
				if (!text) continue;
				entries.push({
					name: `diagnostics/logs/${file.name}`,
					data: Buffer.from(text, "utf8"),
					modifiedAt: new Date(file.modifiedAt),
				});
			}
			await writeFile(filePath, buildZip(entries));
			void this.deps.appLogger.info("diagnostics", "Log bundle exported (redacted logs included)", { path: filePath, files: entries.length });
			return { ok: true, canceled: false, path: filePath };
		} catch (error) {
			return { ok: false, canceled: false, error: this.describeError(error) };
		}
	}

	private validateMarkdown(value: unknown): string {
		if (typeof value !== "string" || !value.trim()) {
			throw new Error("Report content is empty.");
		}
		return value.slice(0, MAX_MARKDOWN_CHARS);
	}

	private validateJson(value: unknown): string {
		if (typeof value !== "string" || !value.trim()) return "{}";
		return value.slice(0, MAX_JSON_CHARS);
	}

	/** 读日志并按行脱敏；超大文件只取末尾（最新日志更有诊断价值）。 */
	private async readRedactedLogFile(path: string, sizeBytes: number): Promise<string> {
		if (sizeBytes <= MAX_LOG_FILE_BYTES) {
			return this.redactLogText(await readFile(path, "utf8"));
		}
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(MAX_LOG_FILE_BYTES);
			await handle.read(buffer, 0, MAX_LOG_FILE_BYTES, sizeBytes - MAX_LOG_FILE_BYTES);
			return this.redactLogText(buffer.toString("utf8"));
		} finally {
			await handle.close();
		}
	}

	/**
	 * 逐行解析 JSONL 并只保留诊断必需的四个字段。
	 * 解析失败的行（含被截断的半行）直接丢弃，保证导出物始终是合法 JSONL。
	 */
	private redactLogText(raw: string): string {
		const maskPath = createPathMasker(app.getPath("home"));
		const out: string[] = [];
		for (const line of raw.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const entry = parseLogLine(line);
			if (!entry) continue;
			out.push(
				JSON.stringify({
					time: entry.time,
					level: entry.level,
					scope: truncateText(entry.scope, 40),
					message: truncateText(redactSecrets(maskPath(entry.message)), MAX_LINE_CHARS),
				}),
			);
		}
		return out.length > 0 ? `${out.join("\n")}\n` : "";
	}

	private describeError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
