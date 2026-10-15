import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { GitStatus } = loadTsCommonJs("src/shared/types/git.ts");
const primitive = ({ children, ...props }) => React.createElement("div", props, children);
const { FileTree } = loadTsCommonJs("src/renderer/src/components/app/git/GitResourceTree.tsx", {
	stubs: {
		"../../../i18n": { t: (key) => key },
		"../../../fileIcons": { getFileIconColor: () => "", getFileIconSeti: () => "file" },
		"../../ui-shadcn/button": { Button: ({ children, ...props }) => React.createElement("button", props, children) },
		"../../ui-shadcn/context-menu": { ContextMenu: primitive, ContextMenuContent: primitive, ContextMenuItem: primitive, ContextMenuTrigger: primitive },
	},
});

function render(readOnly, groupType, managed = false) {
	const projectId = "project";
	const target = { projectId, relativePath: "file.txt" };
	return renderToStaticMarkup(
		React.createElement(FileTree, {
			resources: [{ path: "file.txt", target, displayPath: "file.txt", status: groupType === "index" ? GitStatus.INDEX_MODIFIED : GitStatus.MODIFIED, letter: "M" }],
			groupType,
			readOnly,
			indexActionsOnly: managed,
			stageDir: managed ? () => undefined : undefined,
			discardDir: managed ? () => undefined : undefined,
			deleteFile: managed ? () => undefined : undefined,
			stageFile: () => undefined,
			unstageFile: () => undefined,
			discardFile: () => undefined,
			mutating: false,
			collapsedDirs: new Set(),
			onToggleDir: () => undefined,
			onOpenWorkspaceFileDiff: () => undefined,
		}),
	);
}

test("read-only Git resource rows omit stage, unstage and discard actions", () => {
	for (const group of ["index", "workingTree"]) {
		const html = render(true, group);
		assert.doesNotMatch(html, /git\.(?:stage|unstage|discardChanges)/);
		assert.match(html, /file\.txt/);
	}
});

test("managed index capability shows single-row stage/unstage but never discard, delete or directory mutations", () => {
	assert.match(render(false, "index", true), /git\.unstage/);
	assert.match(render(false, "workingTree", true), /git\.stage/);
	for (const group of ["index", "workingTree", "untracked", "merge"]) assert.doesNotMatch(render(false, group, true), /git\.(?:discardChanges|stageDirectory|discardDirectory|deleteFile)/);
});

test("local Git resource rows retain their supplied mutation actions", () => {
	assert.match(render(false, "index"), /git\.unstage/);
	assert.match(render(false, "workingTree"), /git\.stage/);
	assert.match(render(false, "workingTree"), /git\.discardChanges/);
});
