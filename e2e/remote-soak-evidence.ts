import type { ElectronApplication, Page } from "@playwright/test";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";
import type { SoakHelper, SoakLocal, SoakProcess } from "./remote-soak-policy";

export function quoteSoakArgument(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Harness probes open their own ssh connection on every cycle. The acceptance host is a shared, normally loaded
 * machine (load 2–6.5, ten users), and OpenSSH can be accepted-but-not-served for longer than a short budget: a
 * real smoke run was ended by exactly that, with empty stderr and `killed:true, signal:SIGTERM` — a transport
 * condition, never a repository finding. The budget is a bounded 60 s and each probe names itself when the budget
 * is what ended it, so the next failure cannot be misread as product residue. Assertions stay unchanged.
 */
export const SOAK_PROBE_TIMEOUT_MS = 60_000;
export async function soakProbe(label: string, run: () => Promise<{ stdout: string }>): Promise<string> {
	const started = Date.now();
	try {
		const result = await run(),
			elapsedMs = Date.now() - started;
		if (elapsedMs > 5_000) console.log(`[remote-git-soak] slow-probe=${label} ms=${elapsedMs}`);
		return result.stdout;
	} catch (error) {
		const killed = typeof error === "object" && error !== null && Reflect.get(error, "killed") === true,
			signal: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "signal") : undefined;
		if (killed || typeof signal === "string") throw new Error(`SOAK_PROBE_TRANSPORT_TIMEOUT(${label})`);
		throw error;
	}
}

/** FD targets of one sampled process, bucketed by subsystem so the journal stays bounded but still names what grew. */
export function readSoakFdKinds(pid: number, limit = 512): Record<string, number> {
	const kinds: Record<string, number> = {};
	let entries: string[];
	try {
		entries = readdirSync(`/proc/${pid}/fd`);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return kinds;
		throw error;
	}
	for (const entry of entries) {
		let target: string;
		try {
			target = readlinkSync(`/proc/${pid}/fd/${entry}`);
		} catch {
			continue;
		}
		const key = target.startsWith("pipe:")
			? "pipe"
			: target.startsWith("socket:")
				? "socket"
				: target.startsWith("anon_inode:")
					? "anon_inode:" + target.slice(11, 32)
					: /^\/dev\/shm\/\.org\.chromium\.chromium\./i.test(target)
						? "chromium-shm"
						: target.startsWith("/memfd:")
							? "memfd:" + target.slice(7).replace(/ \(deleted\)$/, "")
							: target.startsWith("/dev/shm/")
								? "shm:other"
								: /\/DawnGraphiteCache\/data_\d+$/.test(target)
									? "dawn-graphite-cache"
									: target.length > 120
										? "..." + target.slice(-117)
										: target;
		kinds[key] = (kinds[key] ?? 0) + 1;
	}
	const ranked = Object.entries(kinds).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
	return Object.fromEntries(ranked.slice(0, limit));
}

/** ENOENT is a normal sampled child exit; permission/parse failures must not be reported as zero usage. */
export function readSoakProcess(pid: number): SoakProcess | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8"),
			fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (fields[0] === "Z") return undefined;
		const rss = /^VmRSS:\s*(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
		if (!rss || !/^\d+$/.test(fields[19])) throw new Error("SOAK_PROCESS_FACTS_INVALID");
		return { pid, startTicks: fields[19], rssKiB: Number(rss[1]), fdCount: readdirSync(`/proc/${pid}/fd`).length };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function children(pid: number): number[] {
	try {
		return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

export function readSoakDescendants(pid: number): SoakProcess[] {
	const result: SoakProcess[] = [],
		queue = children(pid),
		visited = new Set<number>();
	while (queue.length) {
		const child = queue.shift();
		if (child === undefined || visited.has(child)) continue;
		visited.add(child);
		if (visited.size > 128) throw new Error("SOAK_CHILDREN_OVER_BUDGET");
		const fact = readSoakProcess(child);
		if (fact) {
			result.push(fact);
			queue.push(...children(child));
		}
	}
	return result;
}

/** The kill target must still be this application's descendant and use its private pinned-host file/root. */
export function ownedSoakSsh(appPid: number, profile: string, roots: readonly string[]): SoakProcess[] {
	return readSoakDescendants(appPid).filter((fact) => {
		try {
			const args = readFileSync(`/proc/${fact.pid}/cmdline`, "utf8").split("\0"),
				executable = readlinkSync(`/proc/${fact.pid}/exe`);
			return executable.endsWith("/ssh") && args.some((arg) => arg.startsWith("UserKnownHostsFile=" + profile + "/")) && roots.some((root) => args.some((arg) => arg.includes("helper.mjs") && arg.includes("--root " + quoteSoakArgument(root))));
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
	});
}

export async function sampleSoakLocal(app: ElectronApplication, window: Page, profile: string, roots: readonly string[]): Promise<SoakLocal> {
	const appPid = app.process().pid;
	if (!appPid) throw new Error("SOAK_MAIN_PID_MISSING");
	const chromium = await app.evaluate(({ BrowserWindow }) => ({ rendererPid: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(), heap: process.memoryUsage().heapUsed }));
	const rendererHeapBytes = await window.evaluate(() => {
		const memory: unknown = Reflect.get(performance, "memory");
		if (typeof memory !== "object" || memory === null || !("usedJSHeapSize" in memory) || typeof memory.usedJSHeapSize !== "number") throw new Error("SOAK_RENDERER_HEAP_UNAVAILABLE");
		return memory.usedJSHeapSize;
	});
	const main = readSoakProcess(appPid),
		renderer = readSoakProcess(chromium.rendererPid);
	if (!main || !renderer) throw new Error("SOAK_LOCAL_PROCESS_MISSING");
	return { main, renderer, mainHeapBytes: chromium.heap, rendererHeapBytes, ssh: ownedSoakSsh(appPid, profile, roots), descendantCount: readSoakDescendants(appPid).length, mainFdKinds: readSoakFdKinds(appPid) };
}

/** ES5 oracle runs on the server's existing node, independently of the product's verified Node/helper. */
export async function sampleSoakRemote(credentials: RemoteAcceptanceCredentials, roots: readonly string[]): Promise<SoakHelper[]> {
	const script = `var fs=require('fs'),crypto=require('crypto'),roots=${JSON.stringify(roots)},out=[];fs.readdirSync('/proc').forEach(function(id){if(!/^\\d+$/.test(id))return;var d='/proc/'+id,a;try{if(fs.statSync(d).uid!==process.getuid())return;a=fs.readFileSync(d+'/cmdline','utf8').split('\\0');}catch(e){if(e.code==='ENOENT'||e.code==='EACCES')return;throw e;}if(a[2]!=='--root'||roots.indexOf(a[3])<0||!a[1]||a[1].slice(-11)!=='/helper.mjs')return;var st=fs.readFileSync(d+'/stat','utf8'),f=st.slice(st.lastIndexOf(')')+2).split(' '),m=/^VmRSS:\\s*(\\d+)\\s+kB$/m.exec(fs.readFileSync(d+'/status','utf8'));if(!m||!/^\\d+$/.test(f[19]))throw Error('SOAK_REMOTE_FACTS_INVALID');if(fs.statSync(a[1]).size>70000)throw Error('SOAK_HELPER_ENTRY_OVER_BUDGET');out.push({pid:Number(id),startTicks:f[19],fdCount:fs.readdirSync(d+'/fd').length,rssKiB:Number(m[1]),rootIndex:roots.indexOf(a[3]),entryHash:crypto.createHash('sha256').update(fs.readFileSync(a[1])).digest('hex')});});process.stdout.write(JSON.stringify(out));`;
	const result: unknown = JSON.parse(await soakProbe("remote-sample", () => runRemoteCommand(credentials, "node -e " + quoteSoakArgument(script), SOAK_PROBE_TIMEOUT_MS)));
	if (!Array.isArray(result)) throw new Error("SOAK_REMOTE_RESULT_INVALID");
	const helpers: SoakHelper[] = [];
	const integerField = (item: object, name: string): number => {
		const value: unknown = Reflect.get(item, name);
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("SOAK_REMOTE_RESULT_INVALID");
		return value;
	};
	for (const value of result) {
		const item: unknown = value;
		if (typeof item !== "object" || item === null) throw new Error("SOAK_REMOTE_RESULT_INVALID");
		const pid = integerField(item, "pid"),
			fdCount = integerField(item, "fdCount"),
			rssKiB = integerField(item, "rssKiB"),
			rootIndex = integerField(item, "rootIndex");
		const startTicks: unknown = Reflect.get(item, "startTicks"),
			entryHash: unknown = Reflect.get(item, "entryHash");
		if (pid <= 1 || fdCount < 1 || rssKiB < 1 || rootIndex >= roots.length || typeof startTicks !== "string" || !/^\d+$/.test(startTicks) || typeof entryHash !== "string" || !/^[a-f0-9]{64}$/.test(entryHash)) throw new Error("SOAK_REMOTE_RESULT_INVALID");
		helpers.push({ pid, startTicks, fdCount, rssKiB, rootIndex, entryHash });
	}
	return helpers;
}

/** Worktree metadata ignores atime; readonly oracle Git commands cannot refresh the real index. */
export async function soakGitOracle(credentials: RemoteAcceptanceCredentials, root: string): Promise<string> {
	return soakProbe("git-oracle", () =>
		runRemoteCommand(
			credentials,
			"set -eu; cd " +
				quoteSoakArgument(root) +
				"; git --no-optional-locks rev-parse HEAD; git --no-optional-locks ls-files --stage -z | base64 -w0; printf '\\n'; find . -path './.git' -prune -o -type f -exec sha256sum {} + | sort; find . -path './.git' -prune -o -type f -printf '%m %s %i %T@ %C@ %p\\n' | sort; if test -e .git/index.lock; then printf 'SOAK_INDEX_LOCK_PRESENT\\n' >&2; exit 1; fi; if test -n \"$(find .git -maxdepth 1 -name 'pideck-index-*' -print)\"; then printf 'SOAK_SCRATCH_PRESENT\\n' >&2; find .git -maxdepth 3 -path './.git/pideck-index-*' -printf '%y %m %s %i %p\\n' >&2; exit 1; fi",
			SOAK_PROBE_TIMEOUT_MS,
		),
	);
}

export async function soakIndexIdentity(credentials: RemoteAcceptanceCredentials, root: string): Promise<string> {
	return soakProbe("index-identity", () => runRemoteCommand(credentials, "set -eu; cd " + quoteSoakArgument(root) + "; sha256sum .git/index; stat -c '%i %s %a %y %z' .git/index", SOAK_PROBE_TIMEOUT_MS));
}

/** Scope/start-ticks are rechecked immediately before signaling only the test application's SSH client. */
export function interruptSoakConnection(appPid: number, profile: string, roots: readonly string[], expected: SoakProcess): void {
	const current = ownedSoakSsh(appPid, profile, roots).find((fact) => fact.pid === expected.pid && fact.startTicks === expected.startTicks);
	if (!current) throw new Error("SOAK_SSH_IDENTITY_CHANGED");
	process.kill(current.pid, "SIGTERM");
}
