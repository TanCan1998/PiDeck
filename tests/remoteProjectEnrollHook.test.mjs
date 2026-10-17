import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const HOST_A = { id: "host-a", label: "Host A", sshHost: "a.example", verified: true, disabled: false };
const HOST_UNVERIFIED = { id: "host-b", label: "Host B", sshHost: "b.example", verified: false, disabled: false };
const HOST_DISABLED = { id: "host-c", label: "Host C", sshHost: "c.example", verified: true, disabled: true };

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 登记域 hook 的确定性宿主：不依赖 DOM/计时器，推送用测试自己触发的 handler 模拟。
 * 拉取与提交的返回值都可替换，用来复现「IPC reject」「迟到推送」这类路径。
 */
function enrollHarness() {
	const host = quickMessageHookHost();
	const confirmHandlers = [];
	const calls = { list: 0, enroll: [], answer: [] };
	const enrolled = [];
	const flags = { closed: 0, settings: 0, open: true };
	let listResult = { ok: true, status: "ready", hosts: [HOST_A, HOST_UNVERIFIED, HOST_DISABLED] };
	let enrollResult = { ok: true, status: "pending", hostId: "host-a", canonicalPath: "/srv/app" };
	let answerResult = { ok: true, enrolled: true, projectId: "project-1" };

	const { useRemoteProjectEnroll } = loadTsCommonJs("src/renderer/src/hooks/useRemoteProjectEnroll.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": {
				desktopApi: {
					remoteHosts: {
						list: async () => {
							calls.list += 1;
							if (listResult instanceof Error) throw listResult;
							return listResult;
						},
						enrollProject: async (hostId, path) => {
							calls.enroll.push({ hostId, path });
							if (enrollResult instanceof Error) throw enrollResult;
							return enrollResult;
						},
						answerProjectEnroll: async (requestId, choice) => {
							calls.answer.push({ requestId, choice });
							if (answerResult instanceof Error) throw answerResult;
							return answerResult;
						},
						onProjectEnrollConfirm: (callback) => {
							confirmHandlers.push(callback);
							return () => {
								const index = confirmHandlers.indexOf(callback);
								if (index >= 0) confirmHandlers.splice(index, 1);
							};
						},
						// 文件管理新增的 create 模式确认通道：本套件只测既有目录登记，但 hook 会同时订阅两条推送，
						// 因此 harness 必须给出形状完整的 no-op（不改变任何既有断言）。
						answerProjectCreate: async () => ({ ok: true, enrolled: false }),
						onProjectCreateConfirm: () => () => undefined,
					},
				},
			},
		},
	});

	const render = () =>
		host.render(() =>
			useRemoteProjectEnroll({
				open: flags.open,
				onClose: () => {
					flags.closed += 1;
				},
				onOpenDeviceSettings: () => {
					flags.settings += 1;
				},
				onEnrolled: (projectId) => enrolled.push(projectId),
			}),
		);

	return {
		render,
		unmount: () => host.unmount(),
		flags,
		calls,
		enrolled,
		subscribeCount: () => confirmHandlers.length,
		pushConfirm: (request) => {
			for (const handler of confirmHandlers) handler(request);
		},
		setListResult: (next) => {
			listResult = next;
		},
		setEnrollResult: (next) => {
			enrollResult = next;
		},
		setAnswerResult: (next) => {
			answerResult = next;
		},
	};
}

test("只列已验证且未禁用的主机，且默认选中第一台", async () => {
	const h = enrollHarness();
	h.render();
	await tick();
	const state = h.render().state;
	assert.equal(state.stage, "path");
	assert.deepEqual(
		state.hosts.map((host) => host.id),
		["host-a"],
	);
	assert.equal(state.hostId, "host-a");
});

test("没有可用主机时进入 no-host 并引导去设备设置，不给输入框", async () => {
	const h = enrollHarness();
	h.setListResult({ ok: true, status: "ready", hosts: [HOST_UNVERIFIED, HOST_DISABLED] });
	h.render();
	await tick();
	const api = h.render();
	assert.equal(api.state.stage, "no-host");
	api.goToDeviceSettings();
	assert.equal(h.flags.settings, 1);
});

test("功能未启用/存储需修复/清单读取失败分别带稳定码，IPC reject 不当成业务结论", async () => {
	const disabled = enrollHarness();
	disabled.setListResult({ ok: false, code: "REMOTE_FEATURE_DISABLED" });
	disabled.render();
	await tick();
	assert.equal(disabled.render().state.stage, "unavailable");
	assert.equal(disabled.render().state.errorCode, "REMOTE_FEATURE_DISABLED");

	const repairing = enrollHarness();
	repairing.setListResult({ ok: true, status: "needs-repair", hosts: [HOST_A] });
	repairing.render();
	await tick();
	assert.equal(repairing.render().state.errorCode, "REMOTE_HOST_STORE_NEEDS_REPAIR");

	const rejected = enrollHarness();
	rejected.setListResult(new Error("ipc down"));
	rejected.render();
	await tick();
	const state = rejected.render().state;
	assert.equal(state.stage, "unavailable");
	assert.equal(state.errorCode, "REMOTE_ENROLL_REQUEST_FAILED");
});

test("提交后按 hostId 认领确认推送，只回答该 requestId，批准后回执 projectId", async () => {
	const h = enrollHarness();
	h.render();
	await tick();
	const api = h.render();
	api.setPath("/srv/app");
	const submitted = api.submit();
	// main 先推送确认、再返回 pending：推送到达时 invoke 还没 resolve。
	h.pushConfirm({ requestId: "req-1", expiresAt: Date.now() + 60_000, hostId: "host-a", label: "/srv/app", requestedPath: "/srv/app", canonicalPath: "/srv/app" });
	await submitted;
	assert.deepEqual(h.calls.enroll, [{ hostId: "host-a", path: "/srv/app" }]);
	const confirming = h.render().state;
	assert.equal(confirming.stage, "confirm");
	assert.equal(confirming.request.requestId, "req-1");
	assert.equal(confirming.busy, false);
	await h.render().answer("approve");
	assert.deepEqual(h.calls.answer, [{ requestId: "req-1", choice: "approve" }]);
	const done = h.render().state;
	assert.equal(done.stage, "enrolled");
	assert.equal(done.projectId, "project-1");
	assert.deepEqual(h.enrolled, ["project-1"]);
});

test("拒绝确认是正常结果：回到路径态且不报错", async () => {
	const h = enrollHarness();
	h.render();
	await tick();
	const api = h.render();
	api.setPath("/srv/app");
	h.setAnswerResult({ ok: true, enrolled: false });
	const submitted = api.submit();
	h.pushConfirm({ requestId: "req-deny", expiresAt: Date.now() + 60_000, hostId: "host-a", label: "/srv/app", requestedPath: "/srv/app", canonicalPath: "/srv/app" });
	await submitted;
	await h.render().answer("deny");
	const state = h.render().state;
	assert.equal(state.stage, "path");
	assert.equal(state.errorCode, null);
	assert.equal(state.request, null);
	assert.deepEqual(h.enrolled, []);
});

test("只认领当前提交主机的推送；已认领的 requestId 不被后续推送覆盖", async () => {
	const h = enrollHarness();
	h.render();
	await tick();
	const api = h.render();
	api.setPath("/srv/app");
	const submitted = api.submit();
	// 别的 hostId：不是这次提交的确认，不能弹出来让用户确认别的目录。
	h.pushConfirm({ requestId: "req-other", expiresAt: Date.now() + 60_000, hostId: "host-z", label: "/other", requestedPath: "/other", canonicalPath: "/other" });
	assert.equal(h.render().state.stage, "path");
	await submitted;
	h.pushConfirm({ requestId: "req-1", expiresAt: Date.now() + 60_000, hostId: "host-a", label: "/srv/app", requestedPath: "/srv/app", canonicalPath: "/srv/app" });
	h.pushConfirm({ requestId: "req-2", expiresAt: Date.now() + 60_000, hostId: "host-a", label: "/srv/app", requestedPath: "/srv/app", canonicalPath: "/srv/app" });
	const state = h.render().state;
	assert.equal(state.stage, "confirm");
	assert.equal(state.request.requestId, "req-1");
});

test("关闭弹框后迟到的确认推送不再改变状态，卸载时退订", async () => {
	const h = enrollHarness();
	h.render();
	await tick();
	const api = h.render();
	api.setPath("/srv/app");
	const submitted = api.submit();
	h.flags.open = false;
	h.render();
	h.pushConfirm({ requestId: "req-late", expiresAt: Date.now() + 60_000, hostId: "host-a", label: "/srv/app", requestedPath: "/srv/app", canonicalPath: "/srv/app" });
	await submitted;
	const state = h.render().state;
	assert.equal(state.request, null);
	assert.equal(state.stage, "loading");
	assert.equal(h.subscribeCount(), 1);
	h.unmount();
	assert.equal(h.subscribeCount(), 0);
});

test("IPC reject 后 busy 一定结束并可重试；回答失败保留确认态与 requestId", async () => {
	const h = enrollHarness();
	h.render();
	await tick();
	const api = h.render();
	api.setPath("/srv/app");
	h.setEnrollResult(new Error("ipc down"));
	await api.submit();
	let state = h.render().state;
	assert.equal(state.busy, false);
	assert.equal(state.errorCode, "REMOTE_ENROLL_REQUEST_FAILED");
	// 重试成功：main 返回 pending，随后推送确认。
	h.setEnrollResult({ ok: true, status: "pending", hostId: "host-a", canonicalPath: "/srv/app" });
	const retry = h.render().submit();
	h.pushConfirm({ requestId: "req-9", expiresAt: Date.now() + 60_000, hostId: "host-a", label: "/srv/app", requestedPath: "/srv/app", canonicalPath: "/srv/app" });
	await retry;
	assert.equal(h.render().state.stage, "confirm");
	h.setAnswerResult(new Error("ipc down"));
	await h.render().answer("approve");
	state = h.render().state;
	assert.equal(state.stage, "confirm");
	assert.equal(state.busy, false);
	assert.equal(state.errorCode, "REMOTE_ENROLL_REQUEST_FAILED");
	assert.equal(state.request.requestId, "req-9");
	h.setAnswerResult({ ok: true, enrolled: true, projectId: "project-2" });
	await h.render().answer("approve");
	assert.equal(h.render().state.stage, "enrolled");
});

test("过期的确认推送不进入确认态，而是要求重新解析", async () => {
	const h = enrollHarness();
	h.render();
	await tick();
	const api = h.render();
	api.setPath("/srv/app");
	const submitted = api.submit();
	h.pushConfirm({ requestId: "req-expired", expiresAt: Date.now() - 1, hostId: "host-a", label: "/srv/app", requestedPath: "/srv/app", canonicalPath: "/srv/app" });
	await submitted;
	const state = h.render().state;
	assert.equal(state.stage, "path");
	assert.equal(state.errorCode, "REMOTE_PROJECT_ENROLL_CONFIRMATION_EXPIRED");
});

test("没有待回答确认（或已被回答）时，answer 不会再发第二次请求", async () => {
	const h = enrollHarness();
	h.render();
	await tick();
	// 还没有任何确认请求：answer 必须是 no-op，不能凭空的 requestId 回答。
	await h.render().answer("approve");
	assert.equal(h.calls.answer.length, 0);

	const api = h.render();
	api.setPath("/srv/app");
	const submitted = api.submit();
	h.pushConfirm({ requestId: "req-1", expiresAt: Date.now() + 60_000, hostId: "host-a", label: "/srv/app", requestedPath: "/srv/app", canonicalPath: "/srv/app" });
	await submitted;
	await h.render().answer("approve");
	assert.deepEqual(h.calls.answer, [{ requestId: "req-1", choice: "approve" }]);
	// 已回答（已 enrolled）：requestId 已作废，再点一次不能重复提交。
	await h.render().answer("deny");
	assert.equal(h.calls.answer.length, 1);
	assert.equal(h.render().state.stage, "enrolled");
});
