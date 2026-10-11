import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * `AgentManager` 的远端项目路由（Phase 4 P4.2）。
 *
 * 这组用例锁的是**产品路由的分叉边界**（pipeline 的远端实现各自另有套件）：
 * 1. 远端项目 + 注入的远端运行时端口 ⇒ 走远端分支：plan 的 cwd 是 `locator.remotePath`、
 *    启动器来自端口、远端 pi 报回来的会话文件**不被本机规则改写**；
 * 2. 本地专属准备（项目 trust、会话文件修复、会话路径归一化）**一次都不碰**——它们被 stub 成
 *    「一调用就抛」，所以「没调用」这件事是硬的，不是靠断言调用次数的软证据；
 * 3. 缺端口 / catalog 绑定会话 ⇒ 稳定码 fail-closed，绝不把远端 cwd 当本机路径跑；
 * 4. 远端 runtime 的本机专属操作（终端 cwd、checkpoint 的 git）在守卫处拒绝，本地行为不变。
 */

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { createRemoteRuntimePort, REMOTE_RUNTIME_CODES } = loadTsCommonJs("src/main/pi/remoteRuntimePort.ts");

const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_HOST_ID = "9c1d5f7a-2b3e-4c5d-8e9f-0a1b2c3d4e5f";
const REMOTE_CWD = "/srv/remote-app";
const REMOTE_SESSION_FILE = "/home/dev/.pi/agent/sessions/-srv-remote-app/2026-01-02T03-04-05_deadbeef.jsonl";
const NODE_PATH = "/usr/local/bin/node";
const PI_PATH = "/usr/local/bin/pi";
const RUNNER_PATH = "/home/dev/.pideck/remote-host/bundles/deadbeef/runner.mjs";

const remoteProject = (id, hostId) => ({ id, name: `app-${id}`, locator: { kind: "ssh", hostId, remotePath: REMOTE_CWD } });
const localProject = { id: "project-local", name: "Local App", path: "C:/projects/local-app" };

/**
 * 一条假的远端 pi：三根流由用例摆布，`get_state` 按真实 RPC 帧形状应答。
 *
 * 应答必须带匹配的 request id（`PiRpcClient` 按 id 认领响应），否则握手会等到超时。
 */
function createFakeRemoteHandle() {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const state = { stops: [], requests: [] };
	let buffer = "";
	stdin.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line.trim()) continue;
			const request = JSON.parse(line);
			state.requests.push(request);
			if (request.type === "get_state") {
				stdout.write(
					`${JSON.stringify({
						id: request.id,
						type: "response",
						command: "get_state",
						success: true,
						data: { sessionId: "pi-session-remote", sessionFile: REMOTE_SESSION_FILE, sessionName: "远端会话" },
					})}\n`,
				);
			}
		}
	});
	return {
		state,
		handle: {
			stdin,
			stdout,
			stderr,
			pid: 4242,
			stop(reason) {
				state.stops.push(reason);
				return Promise.resolve();
			},
			onExit() {
				return () => undefined;
			},
			onSpawnError() {
				return () => undefined;
			},
		},
	};
}

/** 假连接服务：只实现端口用到的那两个方法（事实探测 + 配对启动器）。 */
function createFakeService(record) {
	return {
		async remotePiRuntimeFacts(hostId) {
			record.facts.push(hostId);
			return { nodePath: NODE_PATH, piPath: PI_PATH, version: "1.0.4", runnerPath: RUNNER_PATH };
		},
		createPiRuntimeLauncher() {
			return {
				async launch(plan) {
					const fake = createFakeRemoteHandle();
					record.launches.push(plan);
					record.handles.push(fake);
					return fake.handle;
				},
			};
		},
	};
}

/**
 * 构造被测 AgentManager。位置参数按构造器顺序给：远端端口在**末尾**（本批新增的那个可选参数），
 * 本地专属依赖（configManager 的 trust 面、repairSessionFile）一律 stub 成「一调用就抛」——
 * 远端分支一旦碰它们，用例当场红而不是静默走错。
 */
function createHarness({ projects, record, remoteRuntime }) {
	const manager = new AgentManager(
		(id) => projects.get(id),
		() => null,
		{ get: () => ({}) },
		{
			ensureTrustedDirectory: async (cwd) => {
				record.forbidden.push(`ensureTrustedDirectory:${cwd}`);
				throw new Error("LOCAL_TRUST_MUST_NOT_RUN_FOR_REMOTE");
			},
			getProjectTrustDecision: async (cwd) => {
				record.forbidden.push(`getProjectTrustDecision:${cwd}`);
				throw new Error("LOCAL_TRUST_MUST_NOT_RUN_FOR_REMOTE");
			},
		},
		undefined,
		undefined,
		undefined,
		undefined,
		() => record.beforeSpawn++,
		undefined,
		async (sessionPath) => {
			record.forbidden.push(`repairSessionFile:${sessionPath}`);
			throw new Error("LOCAL_SESSION_REPAIR_MUST_NOT_RUN_FOR_REMOTE");
		},
		undefined,
		undefined,
		undefined,
		undefined,
		remoteRuntime,
	);
	// 本机路径归一化必须对远端**不可见**：直接让这个方法炸，远端分支一旦调用它就会炸在用例里。
	const prototype = Object.getPrototypeOf(manager);
	const original = prototype.normalizeSessionPathFromPi;
	prototype.normalizeSessionPathFromPi = function patched(...args) {
		record.forbidden.push("normalizeSessionPathFromPi");
		return original.apply(this, args);
	};
	return {
		manager,
		restore: () => {
			prototype.normalizeSessionPathFromPi = original;
		},
	};
}

function createRecord() {
	return { facts: [], launches: [], handles: [], prepares: [], forbidden: [], beforeSpawn: 0, launcherRequests: 0 };
}

function createPort(record, service) {
	return createRemoteRuntimePort({
		resolveService: () => service,
		settings: () => ({}),
	});
}

test("远端项目 + 注入端口：走远端分支（plan 用 locator.remotePath、launcher 来自端口），本机 trust/repair/normalize 一次都不碰", async () => {
	const record = createRecord();
	const service = createFakeService(record);
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, service) });
	const { manager, restore } = harness;
	try {
		// WSL 打开：远端会话身份仍必须是 native（远端路径不是 WSL 路径）。
		manager.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: "\\\\wsl.localhost\\Ubuntu\\home\\dev" });
		const tab = await manager.create({ projectId: "remote", title: "远端会话", environment: "wsl" });

		assert.equal(record.facts.length, 1, "远端事实必须来自端口（一次 prepare = 一次事实探测）");
		assert.equal(record.facts[0], HOST_ID);
		assert.equal(record.launches.length, 1, "启动必须经端口给出的 launcher");
		const plan = record.launches[0];
		assert.equal(plan.kind, "remote-ssh");
		assert.equal(plan.hostId, HOST_ID);
		assert.equal(plan.cwd, REMOTE_CWD, "plan 的 cwd 必须是远端项目根（locator.remotePath）");
		assert.equal(plan.nodePath, NODE_PATH);
		assert.equal(plan.runnerPath, RUNNER_PATH);

		assert.equal(tab.cwd, REMOTE_CWD, "tab.cwd 是远端路径");
		assert.equal(tab.status, "idle");
		assert.equal(tab.sessionEnvironment, "native", "远端会话身份不套 WSL");
		// pi 报回来的会话文件在远端：原样采用，不得被本机规则改写（本机转换会把 /home/... 拼成盘符路径）。
		assert.equal(tab.sessionPath, REMOTE_SESSION_FILE);
		assert.equal(tab.sessionId, "pi-session-remote");

		assert.deepEqual(record.forbidden, [], "远端分支不得调用 trust / repairSessionFile / 本机路径归一化");
		// 远端历史不在本机：不自动加载（本机 reader 不参与），消息列表保持为空。
		// 注意：这些数组来自被加载模块自己的 realm，不能与测试 realm 的 [] 做 deepStrictEqual。
		assert.equal(manager.messages.get(tab.id).length, 0);
		// 本机 pi 的模型目录刷新与本次 cwd 无关，仍按本地语义执行（远端模型目录属 P4.3）。
		assert.equal(record.beforeSpawn, 1);
		return { manager, tab, record, service, restore };
	} catch (error) {
		restore();
		throw error;
	}
});

test("远端会话：能停（stop 打到远端句柄）、能重启（第二次 plan 带 --session 重开同一远端会话）", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		const tab = await manager.create({ projectId: "remote", title: "远端会话" });
		const handle = record.handles[0];

		const restarted = await manager.restart(tab.id);
		assert.equal(record.launches.length, 2, "重启必须重新准备并拉起一次远端运行");
		const secondPlan = record.launches[1];
		assert.equal(secondPlan.cwd, REMOTE_CWD);
		assert.equal(secondPlan.nonce !== record.launches[0].nonce, true, "每次运行有自己的 nonce");
		const sessionIndex = secondPlan.args.indexOf("--session");
		assert.notEqual(sessionIndex, -1, "重启同一会话必须带 --session");
		assert.equal(secondPlan.args[sessionIndex + 1], REMOTE_SESSION_FILE, "--session 用的是 pi 报回来的远端会话文件");
		assert.equal(restarted.cwd, REMOTE_CWD);
		assert.equal(restarted.sessionPath, REMOTE_SESSION_FILE);

		await manager.stop(restarted.id);
		assert.deepEqual(handle.state.stops, ["shutdown"], "停止必须真的打到远端句柄上");
		assert.deepEqual(record.forbidden, []);
	} finally {
		restore();
	}
});

test("匿名远端会话（noSession）：plan 追加 --no-session，且不带 --session", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		await manager.create({ projectId: "remote", title: "匿名", noSession: true });
		const plan = record.launches[0];
		assert.equal(plan.args.includes("--no-session"), true, "匿名会话不能让远端 pi 落一个 PiDeck 不认的会话文件");
		assert.equal(plan.args.includes("--session"), false);
	} finally {
		restore();
	}
});

test("远端项目 + 未注入端口：仍旧 UNSUPPORTED_PROJECT_LOCATION（fail-closed，不静默当本地跑）", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record });
	const { manager, restore } = harness;
	try {
		await assert.rejects(() => manager.create({ projectId: "remote", title: "远端会话" }), /UNSUPPORTED_PROJECT_LOCATION/);
		assert.deepEqual(record.forbidden, [], "拒绝必须发生在任何本机准备之前");
	} finally {
		restore();
	}
});

test("服务拿不到（门禁关闭/尚未装配/建服务失败）：REMOTE_RUNTIME_UNAVAILABLE 落到会话错误卡，不静默回退本机", async () => {
	for (const resolveService of [() => undefined, () => Promise.reject(new Error("SSH_CLIENT_UNAVAILABLE")), () => Promise.reject(new Error("something went sideways"))]) {
		const record = createRecord();
		const port = createRemoteRuntimePort({ resolveService, settings: () => ({}) });
		const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: port });
		const { manager, restore } = harness;
		try {
			const tab = await manager.create({ projectId: "remote", title: "远端会话" });
			// 与本地「pi 起不来」同一条路径：tab 是终态 error + 会话内错误卡（带稳定码），不是静默成功。
			assert.equal(tab.status, "error");
			assert.equal(
				manager.list().some((candidate) => candidate.id === tab.id),
				true,
				"错误卡必须落在一条能显示出来的 tab 上",
			);
			const card = manager.messages.get(tab.id).at(-1);
			assert.equal(card.role, "error");
			const code = String(card.meta?.debugDetails ?? "");
			// 服务自己带的稳定码（如 ssh 客户端缺失）原样转述，不带稳定码的折叠成 REMOTE_RUNTIME_UNAVAILABLE。
			assert.match(code, /SSH_CLIENT_UNAVAILABLE|REMOTE_RUNTIME_UNAVAILABLE/);
			assert.equal(record.launches.length, 0, "拿不到服务时绝不能有任何远端或本地启动动作");
			assert.deepEqual(record.forbidden, []);
		} finally {
			restore();
		}
	}
});

test("准备失败的占位 runtime：不会被当成可启动 runtime 去起本机 pi", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, undefined) });
	const { manager, restore } = harness;
	try {
		const tab = await manager.create({ projectId: "remote", title: "远端会话" });
		assert.equal(tab.status, "error");
		// 直接推它进入 spawn 路径（模拟任何未来“重连/重试”误用）：必须稳定码拒绝，而不是本地起 pi。
		await assert.rejects(() => manager.handshakePiProcess(tab.id, { projectPath: REMOTE_CWD, onExit: () => undefined }), new RegExp(REMOTE_RUNTIME_CODES.unavailable));
		assert.equal(record.launches.length, 0);
	} finally {
		restore();
	}
});

test("catalog 绑定的远端会话：远端身份无法表达成本批的 ssh locator ⇒ 稳定码 fail-closed，且不半启动运行", async () => {
	const record = createRecord();
	const harness = createHarness({ projects: new Map([["remote", remoteProject("remote", HOST_ID)]]), record, remoteRuntime: createPort(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		// deckSessionId = 这条会话已经属于一条 catalog 记录（协调器随后会把 tab 身份写进 catalog）。
		await assert.rejects(() => manager.create({ projectId: "remote", title: "远端会话", deckSessionId: "11111111-2222-4333-8444-555555555555" }), new RegExp(REMOTE_RUNTIME_CODES.catalogIdentityUnsupported));
		assert.deepEqual(record.facts, [], "拒绝必须发生在探测/拉起之前（不留半启动的远端进程）");
		assert.equal(record.launches.length, 0);
	} finally {
		restore();
	}
});

test("会话身份 key 带 hostId：同路径不同主机不互相顶掉，同主机同会话复用既有 runtime", async () => {
	const record = createRecord();
	const projects = new Map([
		["remote-a", remoteProject("remote-a", HOST_ID)],
		["remote-b", remoteProject("remote-b", OTHER_HOST_ID)],
	]);
	const harness = createHarness({ projects, record, remoteRuntime: createPort(record, createFakeService(record)) });
	const { manager, restore } = harness;
	try {
		const first = await manager.create({ projectId: "remote-a", title: "A", sessionPath: REMOTE_SESSION_FILE });
		const reused = await manager.create({ projectId: "remote-a", title: "A", sessionPath: REMOTE_SESSION_FILE });
		assert.equal(reused.id, first.id, "同一主机 + 同一远端会话文件必须复用既有 runtime");
		assert.equal(record.launches.length, 1);

		const other = await manager.create({ projectId: "remote-b", title: "B", sessionPath: REMOTE_SESSION_FILE });
		assert.notEqual(other.id, first.id, "同一路径在另一台主机上是另一个会话，不得复用 A 的 runtime");
		assert.equal(record.launches.length, 2);
		assert.deepEqual(record.forbidden, []);
	} finally {
		restore();
	}
});

test("远端 runtime 的本机专属操作在守卫处拒绝；本机 runtime 行为不变", async () => {
	const record = createRecord();
	const projects = new Map([
		["remote", remoteProject("remote", HOST_ID)],
		["local", localProject],
	]);
	const harness = createHarness({ projects, record });
	const { manager, restore } = harness;
	try {
		const tab = (id, projectId, cwd) => ({
			id,
			projectId,
			cwd,
			title: id,
			status: "idle",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		});
		manager.agents.set("agent-remote", { tab: tab("agent-remote", "remote", REMOTE_CWD), process: { client: { request: async () => ({ success: true, data: {} }) } } });
		manager.agents.set("agent-local", { tab: tab("agent-local", "local", "C:/projects/local-app"), process: { client: { request: async () => ({ success: true, data: {} }) } } });

		// 终端（node-pty cwd）与 checkpoint（本机 git ref）都是本机实现：远端必须当场拒绝。
		assert.throws(() => manager.getCwd("agent-remote"), new RegExp(REMOTE_RUNTIME_CODES.localOperationUnsupported));
		await assert.rejects(() => manager.listCheckpoints("agent-remote"), new RegExp(REMOTE_RUNTIME_CODES.localOperationUnsupported));
		await assert.rejects(() => manager.reload("agent-remote"), new RegExp(REMOTE_RUNTIME_CODES.localOperationUnsupported));
		// 远端历史读取不参与本机文件：loadMessages 直接返回内存消息。
		assert.equal((await manager.loadMessages("agent-remote")).length, 0);

		// 本机 runtime 一字不变：cwd 照常返回（本地项目仍以 project.path 为工作目录）。
		assert.equal(manager.getCwd("agent-local"), "C:/projects/local-app");
	} finally {
		restore();
	}
});
