import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";

const { createSshClientRuntime } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");
const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { buildPinnedSshInvocation } = loadTsCommonJs("src/main/remote/SshVerifiedConnection.ts");
const { fingerprintSshHostKey } = loadTsCommonJs("src/main/remote/SshHostVerifier.ts");
const { bootstrapPinnedHost, BootstrapReadyUnconfirmedError, resolveRemoteNodeExecutable } = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts");
const { createSshProcessLauncher } = loadTsCommonJs("src/main/remote/SshProcessLauncher.ts");

/**
 * 取该主机上报的 host key（仅作**候选**）。
 *
 * 指纹本身由调用方**独立核验**（来自服务器控制台），随后会断言这里的观测值与它逐字节一致，
 * 因此 keyscan 是否可信不影响结论：对不上就 fail-closed。选择哪个 keyscan 二进制同样不影响强度。
 * Windows 上 System32 的 ssh-keyscan 对某些服务端 KEX 协商失败（实测 Ubuntu OpenSSH_8.9p1 的
 * sntrup761x25519-sha512@openssh.com 会 choose_kex 报错），故退到 Git for Windows 自带的较新 OpenSSH。
 */
function scanHostKey(host, primary) {
	const candidates = [primary];
	if (process.platform === "win32") {
		const programFiles = process.env.ProgramFiles;
		if (typeof programFiles === "string" && programFiles.length > 0) candidates.push(join(programFiles, "Git", "usr", "bin", "ssh-keyscan.exe"));
	}
	let lastError;
	for (const candidate of candidates) {
		try {
			return execFileSync(candidate, ["-T", "8", "-t", "ed25519", host], { encoding: "utf8", timeout: 12_000, stdio: ["ignore", "pipe", "ignore"] });
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError ?? new Error("KEYSCAN_FAILED");
}

/** Disposable real-host smoke: no profile or key is written to PiDeck's userData. */
async function verifyRemoteHost(host, user, fingerprint, bootstrap) {
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || !/^[a-z_][a-z0-9_-]*$/.test(user) || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error("SMOKE_INPUT_INVALID");
	const directory = await mkdtemp(join(tmpdir(), "pideck-real-pinned-e2e-"));
	let pinStore;
	try {
		// POSIX 客户端刻意显式绑定 /usr/bin/ssh；Windows 必须让运行时自己解析——它会挑
		// System32\OpenSSH\ssh.exe 并拒绝脚本 shim。此前这里硬编码 POSIX 路径，导致 Windows
		// 客户端跑真机验收直接抛 SSH_CLIENT_SCRIPT_SHIM（脚本的平台缺口，不是产品缺口）。
		const client = process.platform === "win32" ? createSshClientRuntime() : createSshClientRuntime({ sshPath: "/usr/bin/ssh" });
		// ssh-keyscan 必须与选定的 ssh 同目录：Windows 上是 System32\OpenSSH\ssh-keyscan.exe。
		const sshKeyscanPath = join(dirname(client.sshPath), process.platform === "win32" ? "ssh-keyscan.exe" : "ssh-keyscan");
		pinStore = new SshHostPinStore(directory, { client });
		const store = await RemoteHostStore.open(directory, { pinStore });
		const profile = await store.createDraft({ label: "remote-smoke", sshHost: host, user, port: 22, connectTimeoutMs: 10_000 }, 0);
		const scanned = scanHostKey(host, sshKeyscanPath);
		const lines = scanned
			.trim()
			.split("\n")
			.filter((line) => line && !line.startsWith("#"));
		if (lines.length !== 1) throw new Error("KEYSCAN_AMBIGUOUS");
		const [reportedHost, algorithm, blob] = lines[0].split(/\s+/);
		if (reportedHost !== host || algorithm !== "ssh-ed25519" || !blob) throw new Error("KEYSCAN_INVALID");
		const alias = `pideck-${profile.id}`;
		const trusted = { knownHostsBytes: Buffer.from(`${alias} ssh-ed25519 ${blob}\n`), fingerprint };
		if (fingerprintSshHostKey(trusted.knownHostsBytes, alias) !== fingerprint) throw new Error("HOST_FINGERPRINT_MISMATCH");
		const offer = await store.offerPin(profile.id, 1, 1, trusted);
		if (offer.hostKeyFingerprints.length !== 1 || offer.hostKeyFingerprints[0] !== fingerprint) throw new Error("HOST_OFFER_MISMATCH");
		await store.confirmPin({ requestId: offer.requestId, hostId: profile.id, senderId: 1, choice: "approve" }, 1);
		// Resolve the node the way this host's user would, through their login shell. `command -v node` is
		// not enough: non-interactive SSH does not load shell init, so nvm is invisible and the answer is
		// whatever the system packaged — on `serve` that was /usr/bin/node v12.22.9 while the same user's
		// login shell had v24.11.0. Anything under 14.18 dies at the frozen entry's first statement
		// (`require("node:fs")`, outside its try) with stderr, exit 1 and no frame, which is
		// indistinguishable from a broken entry. The resolver also applies the 22.3 gate itself, so a
		// rejection here happens before any bootstrap or SCP work.
		const resolved = await resolveRemoteNodeExecutable({ userDataDir: directory, hostId: profile.id, client, sentinel: randomBytes(16).toString("hex") });
		const nodePath = resolved.nodePath;
		// Resolve a cheap invocation only to report the client version this smoke ran under; the version
		// gate above already ran on the pinned route.
		const routeInvocation = await buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client });
		console.log("PINNED_PROFILE_OK", "NODE_PATH", nodePath, "VER", routeInvocation.openSshVersion);
		console.log("REMOTE_NODE_VERSION_OK", resolved.version, "probed", resolved.probed);
		if (bootstrap) {
			try {
				const activated = await bootstrapPinnedHost({ userDataDir: directory, hostId: profile.id, generation: 1, nonce: randomBytes(16).toString("hex"), nodePath, client, launcher: createSshProcessLauncher() });
				console.log("BOOTSTRAP_FINALIZED", activated.bundleSha256, activated.active);
			} catch (error) {
				if (error instanceof BootstrapReadyUnconfirmedError) console.error("BOOTSTRAP_NO_READY", error.exitKind, error.exitCode ?? "none", error.stderrSeen ? "stderr-present" : "no-stderr");
				throw error;
			}
		}
	} finally {
		pinStore?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

const [host, user, fingerprint, option] = process.argv.slice(2);
if (process.argv.length !== 5 && (process.argv.length !== 6 || option !== "--bootstrap")) throw new Error("Usage: node scripts/verify-remote-host.mjs <IPv4> <user> <independently-verified-ED25519-SHA256-fingerprint> [--bootstrap]");
try {
	await verifyRemoteHost(host, user, fingerprint, option === "--bootstrap");
} catch (error) {
	// The stable code is the whole message on purpose (diagnosticCodeFromError only recognises that
	// shape), so the actionable detail rides on the error and has to be printed explicitly here.
	const nodePath = error?.nodePath;
	const observedVersion = error?.observedVersion;
	if (typeof nodePath === "string" || typeof observedVersion === "string") console.error("REJECTED_NODE", nodePath ?? "unknown", observedVersion ?? "unknown");
	throw error;
}
