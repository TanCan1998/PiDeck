import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const local = { id: "project", path: "/local", name: "local" };
const remote = { id: "project", locator: { kind: "ssh", hostId: "host", remotePath: "/remote" }, name: "remote" };
const empty = () => null;

function drawer(project, collapsed = false, enabled = true) {
	const mounts = [];
	const { DrawerSurface } = loadTsCommonJs("src/renderer/src/components/workspace/DrawerSurface.tsx", {
		stubs: {
			"./GitDrawerHost": {
				GitDrawerHost: () => {
					mounts.push("native");
					return React.createElement("div", null, "native");
				},
			},
			"./RemoteGitPanel": {
				RemoteGitPanel: () => {
					mounts.push("remote");
					return React.createElement("div", null, "remote");
				},
			},
			"../session/RemoteProjectPanel": { RemoteProjectPanel: empty },
			"./BrowserSurface": { BrowserSurface: empty },
			"./RewindPanel": { RewindPanel: empty },
			"../app/AppParts": { DrawerContent: empty },
			"../session/trajectory/SessionTrajectoryPanel": { SessionTrajectoryPanel: empty },
			"../../hooks/useLazyComponent": { LazyWrapper: empty },
			"../../i18n": { t: (key) => key },
		},
	});
	renderToStaticMarkup(React.createElement(DrawerSurface, { drawer: "git", drawerCollapsed: collapsed, git: { activeProjectId: project.id, enableGitManagement: enabled }, files: { activeProject: project }, chrome: {}, browser: {} }));
	return mounts;
}

test("SSH drawer mounts only the read-only panel, never native repo/history/watch effects", () => {
	assert.deepEqual(drawer(remote), ["remote"]);
	assert.deepEqual(drawer(local), ["native"]);
	assert.deepEqual(drawer(remote, true), []);
	assert.deepEqual(drawer(remote, false, false), []);
});
