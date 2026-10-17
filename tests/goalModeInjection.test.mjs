import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// pi-deck-goal-mode.ts 只使用 type import（编译后消失），空沙箱即可加载；
// 行为通过扩展注册的 handler 与注入的 pi api 替身断言。
const extensionPath = "resources/extensions/pi-deck-goal-mode.ts";
const marker = "__PI_DECK_GOAL_MODE__";

function loadGoalExtension() {
	const source = readFileSync(extensionPath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: extensionPath,
	}).outputText;
	const module2 = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module: module2,
			exports: module2.exports,
			require: (specifier) => {
				throw new Error(`pi-deck-goal-mode must stay dependency-free, got require("${specifier}")`);
			},
			__filename: "C:/PiDeck/resources/extensions/pi-deck-goal-mode.ts",
			console,
		},
		{ filename: extensionPath },
	);
	return module2.exports.default;
}

function createHarness() {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const widgets = new Map();
	const appendedEntries = [];
	const sentMessages = [];

	const api = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		appendEntry(customType, data) {
			appendedEntries.push({ type: "custom", customType, data });
		},
		sendMessage(message, options) {
			sentMessages.push({ message, options });
		},
	};

	const context = {
		hasUI: true,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setWidget(key, lines) {
				if (lines?.length) widgets.set(key, [...lines]);
				else widgets.delete(key);
			},
		},
		sessionManager: {
			getEntries() {
				return [...appendedEntries];
			},
		},
	};

	loadGoalExtension()(api);

	return {
		handlers,
		context,
		async runInput(text) {
			return handlers.get("input")({ text }, context);
		},
		async runBeforeAgentStart(event = {}) {
			return handlers.get("before_agent_start")(event, context);
		},
	};
}

test("goal 模式静态规则进系统提示 section，Objective/Round 留在消息里（issue #365-10）", async () => {
	const harness = createHarness();
	await harness.runInput(`${marker}\n把测试跑绿`);

	const sections = { pi_deck_earlier: "keep me" };
	const result = await harness.runBeforeAgentStart({ systemPromptOptions: { sections } });

	assert.match(sections.pi_deck_goal_mode, /^Rules:\n- Work toward the objective/);
	assert.ok(sections.pi_deck_goal_mode.includes("GOAL_COMPLETE"));
	assert.equal(sections.pi_deck_earlier, "keep me", "前序扩展写入的 section 必须保留");

	// 每轮变化的 Objective/Round 仍走消息，且不再重复整块静态规则。
	assert.ok(result?.message?.content?.includes("[GOAL MODE ACTIVE]"));
	assert.ok(result.message.content.includes("Objective: 把测试跑绿"));
	assert.ok(result.message.content.includes("Round: 1/32"));
	assert.equal(result.message.content.includes("Rules:"), false);
});

test("旧宿主（无 systemPromptOptions）保留整块目标上下文", async () => {
	const harness = createHarness();
	await harness.runInput(`${marker}\n把测试跑绿`);

	const result = await harness.runBeforeAgentStart({});
	const content = result?.message?.content ?? "";
	assert.ok(content.includes("[GOAL MODE ACTIVE]"));
	assert.ok(content.includes("Objective: 把测试跑绿"));
	assert.ok(content.includes("Round: 1/32"));
	assert.ok(content.includes("Rules:"));
	assert.ok(content.includes("GOAL_COMPLETE"));
});
