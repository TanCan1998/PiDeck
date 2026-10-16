/**
 * 文件树 Git 状态着色（IDEA 风格）：
 * 1. 路径键归一——分隔符/大小写/尾斜杠，Windows 反斜杠必须能对上树节点的键；
 * 2. GitStatus → 着色状态映射——untracked 红、added 绿、冲突琥珀、其余（修改/重命名/删除）蓝；
 * 3. 查找表构建——文件行取自身状态（暂存+未暂存并存时 added 胜出）、目录行聚合子树
 *    （含未跟踪文件时红优先，呼应「没进 git 管理」的核心诉求）、祖先只标到项目根；
 * 4. 颜色映射——状态 → Tailwind 语义 token utility（不写死色值，暗色/皮肤自动适配）；
 * 5. 多仓合并——根仓与嵌套仓的状态合并后走同一套优先级规则；
 * 6. 接线契约——文件树行名按查表结果叠加着色类、活跃编辑器行不叠加、刷新按钮重拉着色。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const load = (relativePath) => loadTsCommonJs(`${ROOT}/${relativePath}`);
const readSource = (relativePath) => readFileSync(`${ROOT}/${relativePath}`, "utf8");

const { GitStatus } = load("src/shared/types/git.ts");
const { buildFileTreeGitStatusMap, dropNestedRepoUntrackedPlaceholders, fileTreeGitKey, fileTreeGitStatusClass, fileTreeGitStatusOf, mergeGitResourceGroups } = load("src/renderer/src/utils/fileTreeGitStatus.ts");

/** 最小 GitResourceGroups 工厂：只喂 merge/index/workingTree/untracked 四组 */
const groups = ({ merge = [], index = [], workingTree = [], untracked = [] } = {}) => ({ merge, index, workingTree, untracked });
const resource = (path, status) => ({ path, status, letter: "M" });

test("fileTreeGitKey：反斜杠归一、大小写不敏感、尾斜杠剔除", () => {
	assert.equal(fileTreeGitKey("C:\\Repo\\Src\\A.ts"), "c:/repo/src/a.ts", "Windows 反斜杠要归一成 POSIX 并转小写");
	assert.equal(fileTreeGitKey("C:/REPO/Src/a.ts"), "c:/repo/src/a.ts", "盘符与大小写不一致时仍能命中同一键");
	assert.equal(fileTreeGitKey("/home/x/proj/"), "/home/x/proj", "尾部斜杠不参与键");
});

test("fileTreeGitStatusOf：IDEA 语义的状态映射", () => {
	assert.equal(fileTreeGitStatusOf(GitStatus.UNTRACKED), "untracked");
	assert.equal(fileTreeGitStatusOf(GitStatus.INDEX_ADDED), "added");
	assert.equal(fileTreeGitStatusOf(GitStatus.INTENT_TO_ADD), "added");
	assert.equal(fileTreeGitStatusOf(GitStatus.MODIFIED), "modified");
	assert.equal(fileTreeGitStatusOf(GitStatus.INDEX_MODIFIED), "modified");
	assert.equal(fileTreeGitStatusOf(GitStatus.INDEX_RENAMED), "modified");
	assert.equal(fileTreeGitStatusOf(GitStatus.DELETED), "modified");
	for (const status of [GitStatus.ADDED_BY_US, GitStatus.ADDED_BY_THEM, GitStatus.DELETED_BY_US, GitStatus.DELETED_BY_THEM, GitStatus.BOTH_ADDED, GitStatus.BOTH_DELETED, GitStatus.BOTH_MODIFIED]) {
		assert.equal(fileTreeGitStatusOf(status), "conflict");
	}
});

test("查找表：未跟踪文件标红，祖先目录同色（用户核心诉求：没进 git 管理一眼可辨）", () => {
	const map = buildFileTreeGitStatusMap(groups({ untracked: [resource("/proj/notes/draft.md", GitStatus.UNTRACKED)] }), "/proj");
	assert.equal(map.get("/proj/notes/draft.md"), "untracked", "文件行取自身状态");
	assert.equal(map.get("/proj/notes"), "untracked", "父目录聚合子树状态");
	assert.equal(map.get("/proj"), undefined, "项目根不是树节点，不标记");
	assert.equal(map.has("/"), false, "项目根之外的祖先不标记");
});

test("查找表：目录里未跟踪 + 已修改并存时，目录红优先于蓝", () => {
	const map = buildFileTreeGitStatusMap(
		groups({
			workingTree: [resource("/proj/src/old.ts", GitStatus.MODIFIED)],
			untracked: [resource("/proj/src/new.ts", GitStatus.UNTRACKED)],
		}),
		"/proj",
	);
	assert.equal(map.get("/proj/src/old.ts"), "modified", "已跟踪改动文件行保持蓝");
	assert.equal(map.get("/proj/src/new.ts"), "untracked", "未跟踪文件行保持红");
	assert.equal(map.get("/proj/src"), "untracked", "目录聚合：红提示「有东西没进 git」");
});

test("查找表：同一文件暂存新增后又改（index+workingTree 并存），文件行 added 胜出", () => {
	const map = buildFileTreeGitStatusMap(
		groups({
			index: [resource("/proj/a.ts", GitStatus.INDEX_ADDED)],
			workingTree: [resource("/proj/a.ts", GitStatus.MODIFIED)],
		}),
		"/proj",
	);
	assert.equal(map.get("/proj/a.ts"), "added", "新文件信息量最大：绿（IDEA 同款）");
});

test("查找表：冲突资源走琥珀，且优先级高于其他状态", () => {
	const map = buildFileTreeGitStatusMap(
		groups({
			merge: [resource("/proj/conflict.ts", GitStatus.BOTH_MODIFIED)],
			workingTree: [resource("/proj/conflict.ts", GitStatus.MODIFIED)],
		}),
		"/proj",
	);
	assert.equal(map.get("/proj/conflict.ts"), "conflict");
	assert.equal(map.get("/proj"), undefined, "根目录仍不标记");
});

test("查找表：Windows 路径形态与树节点对齐（反斜杠 + 大小写差异）", () => {
	const map = buildFileTreeGitStatusMap(groups({ untracked: [resource("C:\\MyRepo\\src\\Draft.ts", GitStatus.UNTRACKED)] }), "C:/myrepo");
	assert.equal(map.get("c:/myrepo/src"), "untracked", "键已归一：大小写与分隔符不敏感");
	assert.equal(map.get(fileTreeGitKey("C:\\MYREPO\\src")), "untracked", "树节点查询前同样归一，能命中");
});

test("查找表：删除文件按新路径标记——文件不在树上，着色落在父目录", () => {
	const map = buildFileTreeGitStatusMap(groups({ workingTree: [resource("/proj/src/gone.ts", GitStatus.DELETED)] }), "/proj");
	assert.equal(map.get("/proj/src/gone.ts"), "modified", "文件键仍标记（树外节点查不到，无害）");
	assert.equal(map.get("/proj/src"), "modified", "目录确有变更：蓝");
});

test("多仓：嵌套仓目录的「外层仓未跟踪」占位被丢弃，改按嵌套仓自己的状态上色", () => {
	// 场景：根仓把嵌套仓目录当未跟踪（git 不递归进另一个仓），嵌套仓自己报一条已暂存新增
	const rootRepo = groups({ untracked: [resource("/proj/packages/app", GitStatus.UNTRACKED)] });
	const nestedRepo = groups({ index: [resource("/proj/packages/app/main.ts", GitStatus.INDEX_ADDED)] });
	const nestedRoots = ["/proj/packages/app"];
	const merged = mergeGitResourceGroups([dropNestedRepoUntrackedPlaceholders(rootRepo, nestedRoots), dropNestedRepoUntrackedPlaceholders(nestedRepo, nestedRoots)]);
	assert.equal(merged.untracked.length, 0, "嵌套仓根目录的未跟踪占位被丢掉");
	assert.equal(merged.index.length, 1);
	const map = buildFileTreeGitStatusMap(merged, "/proj");
	assert.equal(map.get("/proj/packages/app/main.ts"), "added", "嵌套仓文件按自己仓库的状态上色");
	assert.equal(map.get("/proj/packages/app"), "added", "嵌套仓目录取子树聚合，不再被外层仓标成未跟踪");
	assert.equal(map.get("/proj/packages"), "added", "祖先目录同步聚合");
});

test("多仓：未跟踪占位过滤只打嵌套仓根目录，仓内真未跟踪文件与子模块 gitlink 都保留", () => {
	const outer = groups({
		workingTree: [resource("/proj/packages/app", GitStatus.MODIFIED)],
		untracked: [resource("/proj/packages/app", GitStatus.UNTRACKED), resource("/proj/packages/app/src/new.ts", GitStatus.UNTRACKED), resource("/proj/packages/app2", GitStatus.UNTRACKED)],
	});
	const filtered = dropNestedRepoUntrackedPlaceholders(outer, ["/proj/packages/app"]);
	assert.deepEqual(
		Array.from(filtered.untracked, (r) => r.path),
		["/proj/packages/app/src/new.ts", "/proj/packages/app2"],
		"只丢「恰好等于嵌套仓根目录的未跟踪项」",
	);
	assert.equal(filtered.workingTree.length, 1, "子模块 gitlink 的已跟踪改动保留（git 报的是 M 不是 untracked）");
	assert.equal(dropNestedRepoUntrackedPlaceholders(outer, []), outer, "没有嵌套仓时原样返回（免重建）");
});

test("多仓合并：空数组不产生任何条目，原分组不被修改", () => {
	const single = groups({ workingTree: [resource("/proj/a.ts", GitStatus.MODIFIED)] });
	const before = JSON.stringify(single);
	const merged = mergeGitResourceGroups([single, groups()]);
	assert.equal(merged.workingTree.length, 1);
	assert.equal(JSON.stringify(single), before, "合并必须是纯函数：不得改动入参分组");
	assert.equal(mergeGitResourceGroups([]).workingTree.length, 0);
});

test("查找表：空分组返回空表", () => {
	const map = buildFileTreeGitStatusMap(groups(), "/proj");
	assert.equal(map.size, 0);
});

test("着色类映射：四个状态各映射到语义 token utility，未命中不染色", () => {
	// 必须走 utility 而非写死色值：暗色与各皮肤经 token 自动适配（AGENTS.md CSS 双轨）
	assert.equal(fileTreeGitStatusClass("modified"), "text-info");
	assert.equal(fileTreeGitStatusClass("added"), "text-success");
	assert.equal(fileTreeGitStatusClass("untracked"), "text-danger");
	assert.equal(fileTreeGitStatusClass("conflict"), "text-warning");
	assert.equal(fileTreeGitStatusClass(undefined), undefined, "未命中（干净文件/非仓库）不加类");
});

test("接线契约：文件树行名按查表结果叠加着色类，刷新按钮重拉着色", () => {
	const surface = readSource("src/renderer/src/components/session/WorkspaceSurface.tsx");
	assert.match(surface, /cn\("file-node-name",\s*gitStatusClass\)/, "文件与目录行名都按同一份着色类渲染");
	assert.match(surface, /isActiveFile\s*\?\s*undefined\s*:\s*fileTreeGitStatusClass/, "活跃编辑器行的选中高亮优先于 Git 着色");
	assert.match(surface, /void\s+gitStatus\.refresh\(\)/, "手动刷新同步重拉 Git 状态");
	assert.match(surface, /useFileTreeGitStatus\(\{\s*projectId:\s*props\.projectId,\s*projectRoot:\s*props\.projectRoot\s*\}\)/, "着色数据源接项目 id 与项目根（路径归一要靠根裁剪祖先）");
	// 颜色只走 utility：legacy 样式表不得再为文件树写状态色
	const css = readSource("src/renderer/src/styles/timeline.css");
	assert.doesNotMatch(css, /file-tree-git-|data-git-status/, "不得新增手写状态色规则（CSS 双轨：新改动走 Tailwind）");
});
