import { GitStatus } from "../../shared/types/git";
import type { LocalGitResource } from "./localGitTypes";

/**
 * 解析 git status --porcelain -z 输出，映射为 VS Code Status 枚举。
 * 复刻 VS Code repository.ts Resource 类的状态分类逻辑。
 */
export function parsePorcelainStatus(raw: string): LocalGitResource[] {
	const result: LocalGitResource[] = [];
	const fields = raw.split("\0").filter(Boolean);

	for (let index = 0; index < fields.length; ) {
		const line = fields[index++]!;
		if (line.length < 3) continue;

		const x = line[0]!; // index status
		const y = line[1]!; // working tree status
		const filePath = line.slice(3);
		// porcelain -z 的 rename/copy 顺序是“当前路径\0原路径\0”，与普通可读格式相反。
		const oldPath = x === "R" || x === "C" || y === "R" || y === "C" ? fields[index++] : undefined;
		const push = (status: GitStatus, letter: string, includeOldPath = false) => {
			result.push({
				path: filePath,
				status,
				letter,
				...(includeOldPath && oldPath ? { oldPath } : {}),
			});
		};

		// 未解决冲突是一条独立资源，不能再同时拆入 index/workingTree。
		if (x === "U" && y === "U") {
			push(GitStatus.BOTH_MODIFIED, "!");
			continue;
		}
		if (x === "A" && y === "A") {
			push(GitStatus.BOTH_ADDED, "!");
			continue;
		}
		if (x === "D" && y === "D") {
			push(GitStatus.BOTH_DELETED, "!");
			continue;
		}
		if (x === "A" && y === "U") {
			push(GitStatus.ADDED_BY_US, "!");
			continue;
		}
		if (x === "U" && y === "A") {
			push(GitStatus.ADDED_BY_THEM, "!");
			continue;
		}
		if (x === "D" && y === "U") {
			push(GitStatus.DELETED_BY_US, "!");
			continue;
		}
		if (x === "U" && y === "D") {
			push(GitStatus.DELETED_BY_THEM, "!");
			continue;
		}
		if (x === "?" && y === "?") {
			push(GitStatus.UNTRACKED, "U");
			continue;
		}
		if (x === "!" && y === "!") {
			push(GitStatus.IGNORED, "I");
			continue;
		}

		// X 与 Y 必须分别生成资源：同一文件可以同时含“已暂存”和“未暂存”修改。
		if (x === "M") push(GitStatus.INDEX_MODIFIED, "M");
		else if (x === "A") push(GitStatus.INDEX_ADDED, "A");
		else if (x === "D") push(GitStatus.INDEX_DELETED, "D");
		else if (x === "R") push(GitStatus.INDEX_RENAMED, "R", true);
		else if (x === "C") push(GitStatus.INDEX_COPIED, "C", true);
		else if (x === "T") push(GitStatus.INDEX_TYPE_CHANGED, "T");

		if (y === "M") push(GitStatus.MODIFIED, "M");
		else if (y === "D") push(GitStatus.DELETED, "D");
		else if (y === "R" || y === "C") push(GitStatus.INTENT_TO_RENAME, "R", true);
		else if (y === "T") push(GitStatus.TYPE_CHANGED, "T");
	}

	return result;
}
