import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentChangedEvent, AgentMarketSettings, AgentProfile, AgentProfileSnapshot, BindAgentSessionInput, CreateAgentProfileInput, UpdateAgentMarketSettingsInput } from "../../shared/types";
import {
	applyAgentProfilePatch,
	createEmptyState,
	MAX_SESSION_AGENT_BINDINGS,
	normalizeBindingId,
	normalizeCreateInput,
	normalizePersistedState,
	normalizeSettings,
	resolveSelectionAgent,
	resolveSessionBindings,
	sanitizeSettingsPatch,
	seedMissingBuiltins,
	uniqueCopyName,
	type AgentProfilePatch,
	type PersistedAgentProfileState,
} from "./agentProfileNormalize";
import { createBuiltinAgentProfile, getBuiltinSeed } from "./builtinAgents";

export type { AgentProfilePatch } from "./agentProfileNormalize";

/**
 * 智能体市场的唯一状态源：<userData>/agent-profiles.json（路径由装配层注入，便于测试）。
 *
 * 与 AutomationStore 同一套骨架（串行写队列 + revision + onChanged + 读盘归一化），
 * 差异是它承载「用户可编辑的提示词预设」，所以：
 * - 内置智能体只在 id 缺失时补种，绝不用种子覆盖用户改过的内容；
 * - 读盘归一化在前向兼容模块里（钳长度、白名单分类、丢弃坏模型、去重 id），坏文件退化成空状态 + 种子；
 * - 所有读接口都返回深拷贝，调用方改返回值不会污染内存态。
 *
 * 写盘串行化：mutate() 先同步改内存再入队写盘，await 的 Promise 覆盖「状态已落盘」，
 * 因此并发调用（如调用计数与编辑器保存同时发生）不会出现旧快照覆盖新快照。
 */
export class AgentProfileStore {
	private state: PersistedAgentProfileState = createEmptyState();
	private saveQueue: Promise<void> = Promise.resolve();
	private readonly listeners = new Set<(event: AgentChangedEvent) => void>();

	constructor(private readonly filePath: string) {}

	async load(now = Date.now()): Promise<AgentProfileSnapshot> {
		let shouldRepair = false;
		try {
			const raw = await readFile(this.filePath, "utf8");
			const normalized = normalizePersistedState(JSON.parse(raw) as unknown, now);
			this.state = normalized.state;
			shouldRepair = normalized.changed;
		} catch {
			// 文件缺失 / 被截断 / 手工改坏都走这里：市场是可选功能，解析失败不能拖垮启动，
			// 直接丢弃坏数据重建（种子在下面补回），并把修复结果写回磁盘。
			this.state = createEmptyState();
			shouldRepair = true;
		}
		const seeded = seedMissingBuiltins(this.state.agents);
		if (seeded.length !== this.state.agents.length) {
			this.state.agents = seeded;
			shouldRepair = true;
		}
		// 默认智能体与会话绑定都可能指向已被删除的 id；补种之后再校验，避免刚种回的内置智能体被误清空。
		const settings = resolveSessionBindings(resolveSelectionAgent(this.state.settings, this.state.agents), this.state.agents);
		const settingsChanged = settings.selectionToolAgentId !== this.state.settings.selectionToolAgentId || JSON.stringify(settings.sessionAgentBindings) !== JSON.stringify(this.state.settings.sessionAgentBindings);
		if (settingsChanged) {
			this.state.settings = settings;
			shouldRepair = true;
		}
		// 修复不推进 revision、也不发变更事件：加载发生在窗口创建前，没有更旧的观察者需要同步。
		if (shouldRepair) await this.persist();
		return this.getSnapshot();
	}

	getSnapshot(): AgentProfileSnapshot {
		return cloneSerializable({ revision: this.state.revision, agents: this.state.agents, settings: this.state.settings });
	}

	get(id: string): AgentProfile | undefined {
		const agent = this.state.agents.find((candidate) => candidate.id === id);
		return agent ? cloneSerializable(agent) : undefined;
	}

	list(): AgentProfile[] {
		return cloneSerializable(this.state.agents);
	}

	onChanged(listener: (event: AgentChangedEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async create(input: CreateAgentProfileInput, now = Date.now()): Promise<AgentProfile> {
		const agent: AgentProfile = {
			id: randomUUID(),
			...normalizeCreateInput(input),
			createdAt: now,
			updatedAt: now,
			usageCount: 0,
		};
		await this.mutate(() => {
			this.state.agents.push(agent);
		});
		return cloneSerializable(agent);
	}

	async update(id: string, patch: AgentProfilePatch, now = Date.now()): Promise<AgentProfile> {
		const index = this.state.agents.findIndex((candidate) => candidate.id === id);
		if (index < 0) throw new Error(`Agent not found: ${id}`);
		const next = applyAgentProfilePatch(this.state.agents[index], patch, now);
		await this.mutate(() => {
			this.state.agents[index] = next;
		});
		return cloneSerializable(next);
	}

	/**
	 * 删除自定义智能体。
	 * 返回 false 的两种情况都不抛错、也不写盘：id 不存在（并发删除/旧快照），或目标是内置智能体
	 * （市场与划词默认值的地基，只允许编辑与「恢复内置设定」）——渲染层用 false 区分「不可删」。
	 */
	async delete(id: string): Promise<boolean> {
		const index = this.state.agents.findIndex((candidate) => candidate.id === id);
		if (index < 0) return false;
		if (this.state.agents[index].builtin === true) return false;
		await this.mutate(() => {
			this.state.agents = this.state.agents.filter((candidate) => candidate.id !== id);
			// 删除后默认划词智能体与会话绑定都可能悬空：同一次写入里清掉，避免渲染层拿到死链、
			// 已绑定的会话每次发送都解析不到角色设定而静默退化。
			const bindings = pruneAgentBindings(this.state.settings.sessionAgentBindings, id);
			if (this.state.settings.selectionToolAgentId === id || bindings !== this.state.settings.sessionAgentBindings) {
				this.state.settings = { ...this.state.settings, selectionToolAgentId: this.state.settings.selectionToolAgentId === id ? null : this.state.settings.selectionToolAgentId, sessionAgentBindings: bindings };
			}
		});
		return true;
	}

	async resetBuiltin(id: string, now = Date.now()): Promise<AgentProfile> {
		const index = this.state.agents.findIndex((candidate) => candidate.id === id);
		if (index < 0) throw new Error(`Agent not found: ${id}`);
		const seed = getBuiltinSeed(id);
		if (!seed) throw new Error(`Agent is not builtin: ${id}`);
		const current = this.state.agents[index];
		// 恢复的是「内置出厂内容」：角色设定/文案/分类/模型回到种子，创建时间保持固定常量；
		// 使用统计属于用户历史，不随恢复内置而清零。
		const restored: AgentProfile = {
			...createBuiltinAgentProfile(seed),
			usageCount: current.usageCount,
			updatedAt: now,
			...(current.lastUsedAt === undefined ? {} : { lastUsedAt: current.lastUsedAt }),
		};
		await this.mutate(() => {
			this.state.agents[index] = restored;
		});
		return cloneSerializable(restored);
	}

	async duplicate(id: string, now = Date.now()): Promise<AgentProfile> {
		const source = this.state.agents.find((candidate) => candidate.id === id);
		if (!source) throw new Error(`Agent not found: ${id}`);
		// 副本是用户的智能体：丢掉内置身份与调用统计，从零开始计数，名字保证不与他人重名。
		const copy: AgentProfile = {
			id: randomUUID(),
			name: uniqueCopyName(source.name, this.state.agents),
			description: source.description,
			icon: source.icon,
			systemPrompt: source.systemPrompt,
			category: source.category,
			...(source.model ? { model: { ...source.model } } : {}),
			...(source.backend ? { backend: source.backend } : {}),
			createdAt: now,
			updatedAt: now,
			usageCount: 0,
		};
		await this.mutate(() => {
			this.state.agents.push(copy);
		});
		return cloneSerializable(copy);
	}

	async updateSettings(patch: UpdateAgentMarketSettingsInput): Promise<AgentMarketSettings> {
		// 会话绑定只能经 bindSession 改：patch 先收敛到可写字段，绑定表沿用内存态，
		// 否则一次设置保存（渲染层拿着旧快照）会把全部绑定覆盖成旧值。
		const settings = normalizeSettings({ ...this.state.settings, ...sanitizeSettingsPatch(patch), sessionAgentBindings: this.state.settings.sessionAgentBindings }, this.state.agents);
		await this.mutate(() => {
			this.state.settings = settings;
		});
		return cloneSerializable(settings);
	}

	/**
	 * 绑定/解绑会话与智能体（「使用」智能体时写入；agentId=null 解绑）。
	 * - 非 null 的 agentId 必须存在：不存在的绑定会让会话发送时静默丢角色设定，宁可抛错让 UI 提示；
	 * - 同一次写入里顺带清掉悬空绑定（手工改文件/旧版本残留），与 load 的 resolveSessionBindings 同语义；
	 * - 绑定数达到 MAX_SESSION_AGENT_BINDINGS 后拒绝「新」绑定（更新已有绑定、解绑不受限），
	 *   保证设置文件与 IPC 快照有界；
	 * - 返回完整 AgentMarketSettings（渲染层直接替换 atom，不必再拉一次快照）。
	 */
	async bindSession(input: BindAgentSessionInput): Promise<AgentMarketSettings> {
		const sessionId = normalizeBindingId(input.sessionId);
		if (!sessionId) throw new Error("Invalid session id");
		const agentId = input.agentId === null ? null : normalizeBindingId(input.agentId);
		if (agentId === undefined) throw new Error("Invalid agent id");
		if (agentId !== null && !this.state.agents.some((agent) => agent.id === agentId)) throw new Error(`Agent not found: ${agentId}`);
		const bindings = { ...this.state.settings.sessionAgentBindings };
		const known = new Set(this.state.agents.map((agent) => agent.id));
		for (const [boundSessionId, boundAgentId] of Object.entries(bindings)) {
			if (!known.has(boundAgentId)) delete bindings[boundSessionId];
		}
		if (agentId === null) {
			delete bindings[sessionId];
		} else {
			if (!Object.hasOwn(bindings, sessionId) && Object.keys(bindings).length >= MAX_SESSION_AGENT_BINDINGS) {
				throw new Error(`Session binding limit reached: ${MAX_SESSION_AGENT_BINDINGS}`);
			}
			bindings[sessionId] = agentId;
		}
		await this.mutate(() => {
			this.state.settings = { ...this.state.settings, sessionAgentBindings: bindings };
		});
		return cloneSerializable(this.state.settings);
	}

	/**
	 * 会话绑定的智能体（发送时注入角色设定用）：未绑定或悬空返回 undefined。
	 * 返回深拷贝，调用方改字段不会污染内存态；找不到绑定不会写盘/推进 revision。
	 */
	getBoundAgent(sessionId: string): AgentProfile | undefined {
		const agentId = this.state.settings.sessionAgentBindings[sessionId];
		return agentId ? this.get(agentId) : undefined;
	}

	/**
	 * 一次性调用计数。best-effort：未知 id 直接忽略（调用方拿到的是旧快照），
	 * 写盘失败才抛出——由调用方决定是否吞掉，不该让已经成功的翻译报错。
	 */
	async recordUsage(id: string, now = Date.now()): Promise<void> {
		const index = this.state.agents.findIndex((candidate) => candidate.id === id);
		if (index < 0) return;
		await this.mutate(() => {
			const agent = this.state.agents[index];
			agent.usageCount += 1;
			agent.lastUsedAt = now;
		});
	}

	private async mutate(mutator: () => void): Promise<void> {
		mutator();
		this.state.revision += 1;
		await this.persist();
		this.emitChanged();
	}

	private persist(): Promise<void> {
		// 先同步序列化再入队：写队列里的每一帧都是「调用那一刻」的完整状态，
		// 不会因为后面又有新改动而写出半新半旧的 JSON。
		const snapshot = JSON.stringify(this.state, null, 2);
		this.saveQueue = this.saveQueue
			.catch(() => undefined)
			.then(async () => {
				await mkdir(dirname(this.filePath), { recursive: true });
				await writeFile(this.filePath, snapshot, "utf8");
			});
		return this.saveQueue;
	}

	private emitChanged(): void {
		const event: AgentChangedEvent = { revision: this.state.revision };
		for (const listener of this.listeners) listener(event);
	}
}

/**
 * 删除智能体后剪掉指向它的会话绑定；无变化时返回原对象，
 * 调用方据此判断「设置是否真的需要替换」（load 的修复判定同语义）。
 */
function pruneAgentBindings(bindings: Record<string, string>, agentId: string): Record<string, string> {
	const entries = Object.entries(bindings).filter(([, boundAgentId]) => boundAgentId !== agentId);
	if (entries.length === Object.keys(bindings).length) return bindings;
	return Object.fromEntries(entries);
}

/** 深拷贝返回值：IPC 快照与渲染层共享结构，调用方改字段不会污染内存态。 */
function cloneSerializable<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
