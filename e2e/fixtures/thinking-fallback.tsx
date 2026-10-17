import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createStore, Provider } from "jotai";
import { AnswerOutput } from "../../src/renderer/src/components/session/AnswerOutput";
import { FinalAnswer } from "../../src/renderer/src/components/session/turn/FinalAnswer";
import { visibleAssistantText } from "../../src/renderer/src/components/session/timeline/editableAnswerTarget";
import { stripThinkingTags } from "../../src/renderer/src/utils/thinkingText";
import type { ChatMessage } from "../../src/shared/types";
import { WebAssistantText } from "../../src/renderer/src/web/WebAssistantText";
import { streamingTextByIdAtom } from "../../src/renderer/src/atoms/session-atoms";
import "../../src/renderer/src/styles.css";

const store = createStore();
const sessionId = "thinking-fallback-fixture";

/** 构造完整历史消息，最终回答直接使用真实组件而非 Markdown 替身。 */
function assistantMessage(text: string): ChatMessage {
	return { id: "thinking-fallback-answer", agentId: "thinking-fallback-agent", role: "assistant", text, timestamp: 1, stopReason: "stop" };
}
// 仅测试夹具暴露纯函数，浏览器测量不含真实会话、模型调用或 React 布局噪声。
Object.defineProperty(window, "fixtureCleanThinking", { value: stripThinkingTags });
const params = new URLSearchParams(location.search);
const initialText = params.get("text") ?? "";
store.set(streamingTextByIdAtom, { [sessionId]: { content: initialText, streaming: true } });

/** 真实正文出口与真实 atom 驱动；只替换消息源，不启动 pi 或读取用户会话。 */
function Fixture() {
	const [text, setText] = useState(initialText);
	const [streaming, setStreaming] = useState(true);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [generation, setGeneration] = useState(0);
	const editAreaRef = useRef<HTMLDivElement>(null);
	function updateText(next: string) {
		setText(next);
		store.set(streamingTextByIdAtom, { [sessionId]: { content: next, streaming } });
	}
	function settle() {
		setStreaming(false);
		store.set(streamingTextByIdAtom, { [sessionId]: { content: text, streaming: false } });
	}
	function startEditing() {
		setEditText(visibleAssistantText(text));
		setEditing(true);
	}
	return (
		<Provider store={store}>
			<main className="mx-auto max-w-3xl space-y-6 p-4">
				<textarea aria-label="Fixture source" className="w-full" value={text} onChange={(event) => updateText(event.target.value)} />
				<button type="button" onClick={settle}>
					Settle fixture
				</button>
				<button type="button" onClick={startEditing}>
					Edit fixture
				</button>
				<button type="button" onClick={() => setGeneration((value) => value + 1)}>
					Remount fixture
				</button>
				<section data-testid="desktop-live">
					<AnswerOutput mode="live" sessionId={sessionId} isStreaming={streaming} onOpenExternal={() => {}} />
				</section>
				<section data-testid="desktop-settled">
					<AnswerOutput mode="settled" text={text} onOpenExternal={() => {}} />
				</section>
				<section data-testid="desktop-final">
					<FinalAnswer
						key={generation}
						message={assistantMessage(text)}
						isStreaming={streaming}
						editing={editing}
						editText={editText}
						editAreaRef={editAreaRef}
						onEditTextChange={setEditText}
						onStartEdit={startEditing}
						onCancelEdit={() => setEditing(false)}
						onSaveEdit={() => {
							updateText(editText);
							setEditing(false);
						}}
						onPreviewImage={() => {}}
						onOpenExternal={() => {}}
					/>
				</section>
				<section data-testid="web-answer">
					<WebAssistantText text={text} isStreaming={streaming} />
				</section>
			</main>
		</Provider>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
