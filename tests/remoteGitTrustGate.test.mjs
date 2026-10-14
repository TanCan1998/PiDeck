import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const project = { id: "project", locator: { kind: "ssh", hostId: "host", remotePath: "/verified/root" } };
function fixture(result = Promise.resolve({ ok: true })) {
	const calls = [];
	let cleanup;
	let approved = 0;
	const { RemoteGitTrustGate } = loadTsCommonJs("src/renderer/src/components/workspace/RemoteGitTrustGate.tsx", {
		stubs: {
			react: {
				useState: (value) => [value, () => {}],
				useRef: (value) => ({ current: value }),
				useEffect: (fn) => {
					cleanup = fn();
				},
			},
			"../../hooks/useRemoteProjectTrust": {
				useRemoteProjectTrust: () => ({
					decide: (...args) => {
						calls.push(args);
						return result;
					},
				}),
			},
			"../../i18n": { t: (key) => key },
			"../ui-shadcn/button": { Button: () => null },
		},
	});
	const element = RemoteGitTrustGate({
		project,
		onApproved: () => {
			approved++;
		},
	});
	const button = element.props.children.find((child) => child?.props?.onClick);
	return { calls, button, cleanup: () => cleanup(), approved: () => approved };
}

test("Git trust gate discloses pi resources and cannot grant a decision before the explicit button", async () => {
	const f = fixture();
	assert.equal(f.calls.length, 0);
	assert.equal(f.button.props.children, "remoteGit.trustApprove");
	f.button.props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0][0].hostId, project.locator.hostId);
	assert.equal(f.calls[0][0].remoteRoot, project.locator.remotePath);
	assert.equal(f.calls[0][1], "approve");
	assert.equal(f.approved(), 1);
});

test("late trust result after project unmount never refreshes a different Git view", async () => {
	let resolve;
	const f = fixture(
		new Promise((accept) => {
			resolve = accept;
		}),
	);
	f.button.props.onClick();
	f.cleanup();
	resolve({ ok: true });
	await new Promise((accept) => setImmediate(accept));
	assert.equal(f.approved(), 0);
});
