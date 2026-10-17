import { quotePosixArgument } from "./RemoteBootstrapContract";
import { readCanonicalBrowseRoot } from "./RemoteBrowseRoot";
import { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } from "./RemoteHelperContract";
import type { RemoteSessionFileRevision } from "./RemoteSessionWriteGuard";

export const REMOTE_PROJECT_TEXT_MAX_BYTES = 256 * 1024;
export const REMOTE_PROJECT_TEXT_READ_CHUNK = 96 * 1024;
export const REMOTE_PROJECT_TEXT_WRITE_CHUNK = 3072;

/** 远端文本入口只接受项目内已有文件，不接受绝对路径、根目录或含逃逸分段的路径。 */
export function validateRemoteProjectTextPath(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 4096 || value.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(value) || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error("REMOTE_FILE_PATH_INVALID");
	return value;
}

// Linux /proc fd 锚定父目录：检查后父目录被换成 symlink，也不能把后续 open/rename 导向项目外。
// 每条命令重新验证 canonical root/逐级非链接目录/目录fd的真实位置，不依赖 UI 或旧 helper 的检查。
//
// 这里是**文件管理（entry/trash）命令与文本命令共用的唯一一份边界实现**：
// - 标识符刻意压短：这段内容会被 squash 后计入每条远程命令的 8192 字符预算与新增脚本的 5120 预算；
// - A(rel) 可多次调用（rename/restore 需要源与目标两个锚点），所有 fd 由 Q() 统一关闭；
// - B()/C() 保留给既有文本命令，语义与旧实现逐字一致（B() 的第一个 fd 即旧 dir）。
export const BOUNDARY_SCRIPT = `
const fs=require("node:fs"),p=require("node:path").posix,O=fs.constants;
const [action,marker,root,relative,raw]=process.argv.slice(1);
const args=JSON.parse(raw),D=[];
function T(c){throw Error(c)}
function R(){if(fs.realpathSync(root)!==root||!fs.lstatSync(root).isDirectory())T("REMOTE_FILE_PATH_INVALID")}
function Q(){for(const d of D){try{fs.closeSync(d)}catch{}}}
function A(rel){
if(process.platform!=="linux"||!Number.isInteger(O.O_NOFOLLOW))T("REMOTE_FILE_PLATFORM_UNSUPPORTED");
R();const q=rel?p.dirname(root+"/"+rel):root;let c=root;
for(const s of p.relative(root,q).split("/").filter(Boolean)){c+="/"+s;if(!fs.lstatSync(c).isDirectory()||fs.lstatSync(c).isSymbolicLink())T("REMOTE_FILE_PATH_INVALID")}
const h=fs.openSync(q,O.O_RDONLY|O.O_DIRECTORY|O.O_NOFOLLOW);D.push(h);const a="/proc/self/fd/"+h;
if(fs.realpathSync(a)!==q)T("REMOTE_FILE_PATH_INVALID");
return{anchor:a,parent:q,file:a+"/"+p.basename(rel)}}
function B(){return A(relative)}
function C(b){R();if(fs.realpathSync(b.anchor)!==b.parent||fs.realpathSync(b.parent)!==b.parent)T("REMOTE_FILE_PATH_INVALID")}
`;
// 已rename后的读回异常只能报结果未确认，不能用提交前冲突码谎称「已拒绝覆盖」。
const CONTROL_SCRIPT =
	BOUNDARY_SCRIPT +
	`
const crypto = require("node:crypto");
function identity(s) { return { mode: Number(s.mode & 4095n), size: Number(s.size), dev: String(s.dev), ino: String(s.ino), uid: String(s.uid), gid: String(s.gid), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) }; }
function read(file) {
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) T("REMOTE_FILE_PATH_INVALID");
  const fd = fs.openSync(file, O.O_RDONLY | O.O_NOFOLLOW);
  try {
    const first = fs.fstatSync(fd, { bigint: true }), before = identity(first);
    if (!first.isFile()) T("REMOTE_FILE_PATH_INVALID");
    if (before.size > 262144) T("REMOTE_FILE_TOO_LARGE");
    const chunks = [], buffer = Buffer.alloc(32768), hash = crypto.createHash("sha256"); let total = 0;
    for (;;) { const n = fs.readSync(fd, buffer, 0, Math.min(32768, 262145 - total), null); if (!n) break; total += n; if (total > 262144) T("REMOTE_FILE_CHANGED"); const chunk = Buffer.from(buffer.subarray(0, n)); hash.update(chunk); chunks.push(chunk); }
    if (total !== before.size || JSON.stringify(identity(fs.fstatSync(fd, { bigint: true }))) !== JSON.stringify(before) || JSON.stringify(identity(fs.lstatSync(file, { bigint: true }))) !== JSON.stringify(before)) T("REMOTE_FILE_CHANGED");
    return { revision: { ...before, digest: hash.digest("hex") }, content: Buffer.concat(chunks) };
  } finally { fs.closeSync(fd); }
}
let result, replacementMade = false;
try {
  const bound = B();
  if (action === "snapshot" || action === "read") {
    const file = read(bound.file); C(bound);
    if (args.source && JSON.stringify(file.revision) !== JSON.stringify(args.source)) T("REMOTE_FILE_CHANGED");
    result = { ok: true, revision: file.revision, ...(action === "read" ? { data: file.content.subarray(args.offset, args.offset + args.count).toString("base64") } : {}) };
  } else if (action === "commit") {
    const temporary = bound.anchor + "/" + args.temporary;
    const upload = read(temporary);
    if (upload.revision.mode !== 384 || upload.revision.size !== args.size || upload.revision.digest !== args.digest) T("REMOTE_FILE_TRANSFER_INVALID");
    if (upload.revision.uid !== args.source.uid || upload.revision.gid !== args.source.gid) T("REMOTE_FILE_PERMISSION_DENIED");
    let source; try { source = read(bound.file); } catch (e) { if (e.code === "ENOENT") T("REMOTE_FILE_CHANGED"); throw e; }
    if (JSON.stringify(source.revision) !== JSON.stringify(args.source)) T("REMOTE_FILE_CHANGED");
    C(bound);
    const fd = fs.openSync(temporary, O.O_RDONLY | O.O_NOFOLLOW); let committed = false;
    try {
      if (JSON.stringify(identity(fs.fstatSync(fd, { bigint: true }))) !== JSON.stringify(identity(fs.lstatSync(temporary, { bigint: true })))) T("REMOTE_FILE_TRANSFER_INVALID");
      fs.fchmodSync(fd, args.source.mode); fs.fsyncSync(fd); C(bound);
      if (String(fs.lstatSync(temporary, { bigint: true }).ino) !== upload.revision.ino) T("REMOTE_FILE_TRANSFER_INVALID");
      fs.renameSync(temporary, bound.file); committed = true; replacementMade = true;
      const after = read(bound.file); C(bound);
      if (after.revision.digest !== args.digest || after.revision.size !== args.size || after.revision.mode !== args.source.mode || after.revision.ino !== upload.revision.ino || after.revision.uid !== args.source.uid || after.revision.gid !== args.source.gid) T("REMOTE_FILE_CHANGED");
      result = { ok: true, revision: after.revision };
    } finally { try { if (!committed) fs.fchmodSync(fd, 384); } finally { fs.closeSync(fd); } }
  } else T("REMOTE_FILE_INPUT_INVALID");
} catch (e) { result = { ok: false, code: replacementMade ? "REMOTE_FILE_COMMAND_FAILED" : /^REMOTE_FILE_[A-Z_]+$/.test(e.message) ? e.message : e.code === "ENOENT" ? "REMOTE_FILE_NOT_FOUND" : e.code === "EACCES" || e.code === "EPERM" ? "REMOTE_FILE_PERMISSION_DENIED" : "REMOTE_FILE_COMMAND_FAILED" }; }
finally { Q(); }
process.stdout.write(marker + JSON.stringify(result));
`;
const UPLOAD_SCRIPT =
	BOUNDARY_SCRIPT +
	`
let result;
try {
  const bound = B(), file = bound.anchor + "/" + args.temporary;
  C(bound);
  const fd = fs.openSync(file, O.O_WRONLY | O.O_NOFOLLOW | (args.first ? O.O_CREAT | O.O_EXCL : O.O_APPEND), 384);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || (s.mode & 4095) !== 384 || s.size + Buffer.from(args.data, "base64").length > 262144) T("REMOTE_FILE_TRANSFER_INVALID");
    C(bound); fs.writeFileSync(fd, Buffer.from(args.data, "base64")); result = { ok: true };
  } finally { fs.closeSync(fd); }
} catch (e) { result = { ok: false, code: /^REMOTE_FILE_[A-Z_]+$/.test(e.message) ? e.message : e.code === "EACCES" || e.code === "EPERM" ? "REMOTE_FILE_PERMISSION_DENIED" : "REMOTE_FILE_COMMAND_FAILED" }; }
finally { Q(); }
process.stdout.write(marker + JSON.stringify(result));
`;

type FileCommand = { operation: "snapshot" } | { operation: "read"; source: RemoteSessionFileRevision; offset: number; count: number } | { operation: "upload"; temporary: string; data: string; first: boolean } | { operation: "commit"; temporary: string; source: RemoteSessionFileRevision; size: number; digest: string };

/** 固定脚本+独立POSIX argv，不把路径或文本当 shell 源码；沿用8192字符命令预算。 */
export function buildRemoteProjectFileCommand(input: { nodePath: string; root: string; relative: string; nonce: string; command: FileCommand }): { command: string; marker: string } {
	validateRemoteProjectTextPath(input.relative);
	try {
		if (readCanonicalBrowseRoot(input.root).canonicalPath !== input.root || readCanonicalBrowseRoot(input.nodePath).canonicalPath !== input.nodePath) throw new Error();
	} catch {
		throw new Error("REMOTE_FILE_PATH_INVALID");
	}
	if (!input.nodePath.endsWith("/node") || !/^[a-f0-9]{32}$/.test(input.nonce)) throw new Error("REMOTE_FILE_INPUT_INVALID");
	const args = input.command;
	if ("temporary" in args && !/^\.[a-f0-9]{32}\.pideck-tmp$/.test(args.temporary)) throw new Error("REMOTE_FILE_INPUT_INVALID");
	if (args.operation === "upload" && (!/^[A-Za-z0-9+/=]*$/.test(args.data) || args.data.length > 5464)) throw new Error("REMOTE_FILE_INPUT_INVALID");
	const marker = "PIDECK_FILE_" + input.nonce;
	const script = (args.operation === "upload" ? UPLOAD_SCRIPT : CONTROL_SCRIPT).replace(/\s+/g, " ").trim();
	const command = [input.nodePath, "-e", script, args.operation, marker, input.root, input.relative, JSON.stringify(args)].map(quotePosixArgument).join(" ");
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) throw new Error("REMOTE_FILE_INPUT_INVALID");
	return { command, marker };
}
