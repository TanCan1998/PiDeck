import { ipcChannels } from "../../shared/ipc";
import type { ThinkingUpdate } from "../../shared/types";
import { LatestByKeyEmitter } from "./LatestByKeyEmitter";
import { stripAnsi } from "./agentUtils";

/**
 * Live 双通道（thinking / 正文）流式状态机（AgentManager 拆分 Wave 3）。
 *
 * 职责：拥有流式缓冲、节流发射器（LatestByKeyEmitter，50ms）、增量推送基准
 * （lastSent*ByAgent / *PushCountByAgent）与思考段（thinkingSegmentByAgent）生命周期。
 * 消息列表（this.messages）的装配与骨架挂载仍归 AgentManager——本通道只管
 * 「live 累积 → 渲染层直通通道」，终态落盘由 AgentManager 的 finalize/upsert 完成
 * 后调用 finishThinkingChannel / finalizeText 清理。
 *
 * 增量推送治理（两条通道同策略）：正常 append 只发 delta；非 append（重置/ANSI
 * 变化）或距上次全量超过 50 次推送（≈2.5s）时改发全量快照，兜底渲染层 HHR/晚绑定
 * 丢失的增量。
 */
export interface LiveStreamChannelHost {
	emit(channel: string, payload: unknown): void;
	/** emitTextStreamNow 尾部的 isStreaming 补丁（依赖 agents 表，留在 AgentManager）。 */
	onTextStreamPushed(agentId: string): void;
	/** text-stream payload 的 sessionId/runtimeGeneration 三元组（依赖 agents 表）。 */
	streamRuntimeTriple(agentId: string): { sessionId?: string; runtimeGeneration?: number };
	/** 新思考段挂载：beginAssistantMessage + 空骨架 upsert + flush（消息列表操作留在 AgentManager）。 */
	ensureSegmentMount(agentId: string): string | undefined;
}

export interface ThinkingSegmentRecord {
	id: string;
	assistantMessageId: string;
	startedAt: number;
	endedAt: number;
}

export class LiveStreamChannel {
	private readonly host: LiveStreamChannelHost;
	/** live 思考累积（终态一次性落入 messages，delta 阶段不增长消息列表）。 */
	private readonly streamingThinking = new Map<string, string>();
	/** 当前思考段（与 History 同 id 的稳定挂载点，见 ensureThinkingSegment）。 */
	private readonly thinkingSegmentByAgent = new Map<string, ThinkingSegmentRecord>();
	/** live 正文累积：text_delta 唯一热路径，不增长 messages。 */
	private readonly streamingText = new Map<string, string>();
	private readonly lastSentTextByAgent = new Map<string, string>();
	private readonly lastSentThinkingByAgent = new Map<string, string>();
	private readonly textPushCountByAgent = new Map<string, number>();
	private readonly thinkingPushCountByAgent = new Map<string, number>();

	readonly thinkingEmitter = new LatestByKeyEmitter<string, string>(100, (agentId, thinking) => this.emitThinkingNow(agentId, thinking));
	readonly textEmitter = new LatestByKeyEmitter<string, string>(100, (agentId, text) => this.emitTextStreamNow(agentId, text));

	constructor(host: LiveStreamChannelHost) {
		this.host = host;
	}

	// ── 正文通道 ───────────────────────────────────────────────

	/** text_delta：累积后经 textEmitter（50ms）推送，不增长 messages。 */
	accumulateText(agentId: string, nextText: string) {
		this.streamingText.set(agentId, nextText);
		this.textEmitter.push(agentId, stripAnsi(nextText));
	}

	getText(agentId: string): string | undefined {
		return this.streamingText.get(agentId);
	}

	/**
	 * 终态（message_end/settled/顶层 message_update done）：推一次最终累积文本
	 * （done=true，渲染层由历史消息接管）后清整个正文通道。
	 */
	finalizeText(agentId: string) {
		const finalText = this.streamingText.get(agentId);
		if (finalText !== undefined) {
			this.textEmitter.flush(agentId);
			this.emitTextStreamNow(agentId, finalText, true);
		}
		this.clearTextChannel(agentId);
	}

	/** 清正文通道（end/settled/abort/markIdle 兜底路径共用；不做最终推送）。 */
	clearTextChannel(agentId: string) {
		this.textEmitter.cancel(agentId);
		this.streamingText.delete(agentId);
		this.lastSentTextByAgent.delete(agentId);
		this.textPushCountByAgent.delete(agentId);
	}

	/**
	 * 推送独立流式正文通道（agents:text-stream），渲染层写入 streamingTextByIdAtom。
	 * done=true 表示本轮回答结束（message_end），渲染层据此把 streaming 置 false。
	 * 顺带同步 isStreaming 补丁：text_delta 走独立通道后不再触发 flushMessageEmit，
	 * 若仍只在 flush 里推 patch，渲染层拿不到 isStreaming=true，气泡不会渲染。
	 */
	emitTextStreamNow(agentId: string, text: string, done = false) {
		const lastSent = this.lastSentTextByAgent.get(agentId) ?? "";
		const pushCount = (this.textPushCountByAgent.get(agentId) ?? 0) + 1;
		const sendFull = !text.startsWith(lastSent) || pushCount >= 50;
		const payload: {
			agentId: string;
			sessionId?: string;
			runtimeGeneration?: number;
			text?: string;
			delta?: string;
			done: boolean;
		} = {
			agentId,
			...this.host.streamRuntimeTriple(agentId),
			...(!sendFull ? { delta: text.slice(lastSent.length) } : { text }),
			done,
		};
		this.lastSentTextByAgent.set(agentId, text);
		this.textPushCountByAgent.set(agentId, sendFull ? 0 : pushCount);
		if (done) {
			this.lastSentTextByAgent.delete(agentId);
			this.textPushCountByAgent.delete(agentId);
		}
		this.host.emit(ipcChannels.agentsTextStream, payload);
		this.host.onTextStreamPushed(agentId);
	}

	// ── 思考通道 ───────────────────────────────────────────────

	getThinking(agentId: string): string | undefined {
		return this.streamingThinking.get(agentId);
	}

	setThinking(agentId: string, text: string) {
		this.streamingThinking.set(agentId, text);
	}

	getSegment(agentId: string): ThinkingSegmentRecord | undefined {
		return this.thinkingSegmentByAgent.get(agentId);
	}

	hasSegment(agentId: string): boolean {
		return this.thinkingSegmentByAgent.has(agentId);
	}

	/** thinking_delta：确保段存在 → 累积 → 经 thinkingEmitter（50ms）推送。 */
	pushThinkingDelta(agentId: string, delta: string) {
		this.ensureThinkingSegment(agentId);
		const prev = this.streamingThinking.get(agentId) ?? "";
		const next = prev + delta;
		this.streamingThinking.set(agentId, next);
		this.thinkingEmitter.push(agentId, stripAnsi(next));
	}

	/** 首 thinking_delta：铸造与 History 相同的稳定段 id（msg-thinking-${assistantMessageId}）。 */
	ensureThinkingSegment(agentId: string): ThinkingSegmentRecord {
		const existing = this.thinkingSegmentByAgent.get(agentId);
		if (existing) return existing;
		// 新段开始：重置思考 delta 基准（上一段的末尾文本可能碰巧是下一段前缀，
		// 直接续 delta 会让新段在渲染层缺头，直到 2.5s 快照自愈）。
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
		const assistantMessageId = this.host.ensureSegmentMount(agentId);
		if (!assistantMessageId) {
			throw new Error(`ensureThinkingSegment: missing assistant message id for ${agentId}`);
		}
		const segment: ThinkingSegmentRecord = {
			id: `msg-thinking-${assistantMessageId}`,
			assistantMessageId,
			startedAt: Date.now(),
			endedAt: 0,
		};
		this.thinkingSegmentByAgent.set(agentId, segment);
		return segment;
	}

	/** thinking_end / 转正文：标 endedAt 并 flush live，不写 messages。幂等（endedAt>0 时跳过）。 */
	markThinkingSegmentEnded(agentId: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		if (!segment) return;
		// 已结束后勿在每个 text_delta 上重复 flush/emit。
		if (segment.endedAt > 0) return;
		segment.endedAt = Date.now();
		this.thinkingSegmentByAgent.set(agentId, segment);
		const text = this.streamingThinking.get(agentId) ?? "";
		this.thinkingEmitter.flush(agentId);
		this.emitThinkingNow(agentId, stripAnsi(text));
	}

	/** 重载后身份重定向：把段的 assistantMessageId 从 fromId 改到 toId（仅当匹配；fromId 可为 undefined，等价无操作）。 */
	rebindSegmentFrom(agentId: string, fromAssistantId: string | undefined, toAssistantId: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		if (!segment || segment.assistantMessageId !== fromAssistantId) return;
		segment.assistantMessageId = toAssistantId;
		segment.id = `msg-thinking-${toAssistantId}`;
	}

	/** finalize 重绑定：无条件把段指到新 assistantMessageId（finalizeThinkingIntoMessage 的迟到身份修正）。 */
	rebindSegmentTo(agentId: string, assistantMessageId: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		if (!segment) return;
		segment.assistantMessageId = assistantMessageId;
		segment.id = `msg-thinking-${assistantMessageId}`;
	}

	/** 发 done 并清 live 思考通道；须在 finalizeThinkingIntoMessage + flushMessageEmit 之后调用。 */
	finishThinkingChannel(agentId: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		const text = stripAnsi(this.streamingThinking.get(agentId) ?? "");
		this.thinkingEmitter.cancel(agentId);
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
		if (segment) {
			const update: ThinkingUpdate = {
				agentId,
				id: segment.id,
				text,
				startedAt: segment.startedAt,
				endedAt: segment.endedAt > 0 ? segment.endedAt : Date.now(),
				done: true,
			};
			this.host.emit(ipcChannels.agentsThinking, update);
		}
		this.streamingThinking.delete(agentId);
		this.thinkingSegmentByAgent.delete(agentId);
	}

	/** 节流推送 live 思考（done=false）；无段身份时丢弃。 */
	emitThinkingNow(agentId: string, text: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		if (!segment) return;
		// 增量推送（同正文通道治理）：只发上次快照之后的新字符；非 append
		// （重置/ANSI 变化）或距上次快照超过 50 次推送（≈2.5s）时补一次全量，
		// 兜底渲染层 HMR/晚绑定丢失的增量。
		const lastSent = this.lastSentThinkingByAgent.get(agentId) ?? "";
		const pushCount = (this.thinkingPushCountByAgent.get(agentId) ?? 0) + 1;
		const sendFull = !text.startsWith(lastSent) || pushCount >= 50;
		const update: ThinkingUpdate = {
			agentId,
			id: segment.id,
			...(!sendFull ? { delta: text.slice(lastSent.length) } : { text }),
			startedAt: segment.startedAt,
			endedAt: segment.endedAt,
			done: false,
		};
		this.lastSentThinkingByAgent.set(agentId, text);
		this.thinkingPushCountByAgent.set(agentId, sendFull ? 0 : pushCount);
		this.host.emit(ipcChannels.agentsThinking, update);
	}

	// ── 生命周期清理 ───────────────────────────────────────────

	/** 仅取消节流发射与基准（clearStreamGate 用）：不动累积缓冲与段身份，与 clearThinkingChannelState 区分。 */
	cancelThinkingPush(agentId: string) {
		this.thinkingEmitter.cancel(agentId);
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
	}

	/** clearAgentState（stop/restart/closed）兜底：清思考段与基准，不发 done。 */
	clearThinkingChannelState(agentId: string) {
		this.streamingThinking.delete(agentId);
		this.thinkingSegmentByAgent.delete(agentId);
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
	}

	/** 双通道全清（clearAgentState 用）。 */
	clearAll(agentId: string) {
		this.clearThinkingChannelState(agentId);
		this.clearTextChannel(agentId);
	}
}
