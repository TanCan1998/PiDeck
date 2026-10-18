/**
 * Web 端会话内消息搜索（第二批）：Ctrl+K / 头部按钮打开。
 *
 * 只搜已加载消息（见 webSearch.ts 说明）；命中项点击后滚动定位到消息并闪烁高亮。
 * 高亮锚点由父组件提供 scrollToMessage(id)。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { UIMessage } from "ai";
import { t } from "@/i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Input } from "@/components/ui-shadcn/input";
import { searchWebMessages } from "./webSearch";

export function WebSearchDialog({ open, onOpenChange, messages, onJump }: { open: boolean; onOpenChange: (open: boolean) => void; messages: UIMessage[]; onJump: (messageId: string) => void }) {
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) {
			setQuery("");
			// 打开后聚焦输入框（移动端弹键盘，桌面端直接可输入）
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [open]);

	// 250ms 防抖：避免流式期间每个按键都全量扫描
	const [deferredQuery, setDeferredQuery] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setDeferredQuery(query), 250);
		return () => clearTimeout(timer);
	}, [query]);

	const hits = useMemo(() => searchWebMessages(messages, deferredQuery), [messages, deferredQuery]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Search className="size-4" />
						{t("web.searchTitle")}
					</DialogTitle>
				</DialogHeader>
				<Input ref={inputRef} value={query} placeholder={t("web.searchPlaceholder")} onChange={(event) => setQuery(event.target.value)} className="h-9" />
				<div className="max-h-[50dvh] overflow-y-auto">
					{deferredQuery && hits.length === 0 ? (
						<p className="py-6 text-center text-sm text-text-muted">{t("web.searchEmpty")}</p>
					) : (
						<ul className="flex flex-col gap-1">
							{hits.map((hit) => (
								<li key={hit.id}>
									<button
										type="button"
										onClick={() => {
											onJump(hit.id);
											onOpenChange(false);
										}}
										className="w-full rounded-md border border-transparent px-2.5 py-2 text-left hover:border-border hover:bg-bg-active"
									>
										<span className={`mr-1.5 text-[10px] ${hit.role === "user" ? "text-primary" : "text-text-muted"}`}>{hit.role === "user" ? "≫" : "≪"}</span>
										<span className="line-clamp-2 text-xs leading-relaxed">{hit.snippet}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
				{deferredQuery ? <p className="text-micro text-text-muted">{t("web.searchScopeHint")}</p> : null}
			</DialogContent>
		</Dialog>
	);
}
