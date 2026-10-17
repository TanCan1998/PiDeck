import type { ChatMessage } from "../../../../../shared/types";
import { replaceExpandedRefBlocksWithLabels } from "../../../../../shared/expandedRefBlocks";
import { cleanAnswerText } from "./answerText.ts";

/** 多选纯文本复制与助手气泡同口径；用户原话不当思考清理，原始 Markdown 导出不经此入口。 */
export function plainTextCopySource(message: Pick<ChatMessage, "role" | "text">): string {
	const text = replaceExpandedRefBlocksWithLabels(message.text);
	return (message.role === "assistant" ? cleanAnswerText(text) : text).replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "").replace(/<skill\s+name="[^"]*"[^>]*>[\s\S]*?<\/skill>/gi, "");
}
