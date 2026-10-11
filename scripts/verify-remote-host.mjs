import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";
import { pinVerifiedHost } from "./remoteVerifyPinnedHost.mjs";

const { resolveVerifiedSshClient } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");
const { buildPinnedSshInvocation } = loadTsCommonJs("src/main/remote/SshVerifiedConnection.ts");
const { bootstrapPinnedHost, BootstrapReadyUnconfirmedError, resolveRemoteNodeExecutable } = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts");
const { createSshProcessLauncher } = loadTsCommonJs("src/main/remote/SshProcessLauncher.ts");

/**
 * Disposable real-host smoke: no profile or key is written to PiDeck's userData.
 *
 * 候选 host key → 独立指纹比对 → pin 的整段理由（含 keyscan 为什么被移除）在
 * `./remoteVerifyPinnedHost.mjs`：三个真机脚本共用那一份，脚本这里不再自己认证一次。
 */
async function verifyRemoteHost(host, user, fingerprint, bootstrap) {
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || !/^[a-z_][a-z0-9_-]*$/.test(user) || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error("SMOKE_INPUT_INVALID");
	const directory = await mkdtemp(join(tmpdir(), "pideck-real-pinned-e2e-"));
	let pinStore;
	try {
		// 平台判断只留在 `resolveVerifiedSshClient` 里：Windows 走自带 OpenSSH（拒绝脚本 shim），
		// 其它平台走已验证发现（自带版本与 `-G` 形状自检）。此前这里硬编码 POSIX 路径，导致 Windows
		// 客户端跑真机验收直接抛 SSH_CLIENT_SCRIPT_SHIM（脚本的平台缺口，不是产品缺口）。
		const client = await resolveVerifiedSshClient();
		const pinned = await pinVerifiedHost({ directory, client, host, user, fingerprint, label: "remote-smoke" });
		pinStore = pinned.pinStore;
		const hostId = pinned.hostId;
		// Resolve the node the way this host's user would, through their login shell. `command -v node` is
		// not enough: non-interactive SSH does not load shell init, so nvm is invisible and the answer is
		// whatever the system packaged — on `serve` that was /usr/bin/node v12.22.9 while the same user's
		// login shell had v24.11.0. Anything under 14.18 dies at the frozen entry's first statement
		// (`require("node:fs")`, outside its try) with stderr, exit 1 and no frame, which is
		// indistinguishable from a broken entry. The resolver also applies the 22.3 gate itself, so a
		// rejection here happens before any bootstrap or SCP work.
		const resolved = await resolveRemoteNodeExecutable({ userDataDir: directory, hostId, client, sentinel: randomBytes(16).toString("hex") });
		const nodePath = resolved.nodePath;
		// Resolve a cheap invocation only to report the client version this smoke ran under; the version
		// gate above already ran on the pinned route.
		const routeInvocation = await buildPinnedSshInvocation(directory, hostId, "ssh-batch", { client });
		console.log("PINNED_PROFILE_OK", "NODE_PATH", nodePath, "VER", routeInvocation.openSshVersion);
		console.log("REMOTE_NODE_VERSION_OK", resolved.version, "probed", resolved.probed);
		if (bootstrap) {
			try {
				const activated = await bootstrapPinnedHost({ userDataDir: directory, hostId, generation: 1, nonce: randomBytes(16).toString("hex"), nodePath, client, launcher: createSshProcessLauncher() });
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
