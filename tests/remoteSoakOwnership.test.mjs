import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Only this fake /proc tree can be signaled: the test never touches a real SSH connection. */
function fixture({ descendant = true, pin = "/owned/profile", root = "/owned/repo", ticks = "100", executable = "/usr/bin/ssh", denyStat = false } = {}) {
	const kills = [],
		fields = Array(20).fill("0");
	fields[0] = "S";
	fields[1] = "10";
	fields[19] = ticks;
	const module = loadTsCommonJs("e2e/remote-soak-evidence.ts", {
		stubs: {
			"./remote-fixtures": {
				runRemoteCommand: () => {
					throw new Error("no network in ownership unit tests");
				},
			},
			"node:fs": {
				readFileSync: (path) => {
					if (path === "/proc/10/task/10/children") return descendant ? "11" : "";
					if (path === "/proc/11/task/11/children") return "";
					if (path === "/proc/11/stat") {
						if (denyStat) throw Object.assign(new Error("denied"), { code: "EACCES" });
						return "11 (ssh) " + fields.join(" ");
					}
					if (path === "/proc/11/status") return "VmRSS:\t8192 kB\n";
					if (path === "/proc/11/cmdline") return ["ssh", "-o", "UserKnownHostsFile=" + pin + "/pins/host", "--", "fixture", "'/verified/node' '/verified/helper.mjs' --root '" + root + "'", ""].join("\0");
					throw new Error("unexpected read: " + path);
				},
				readdirSync: (path) => {
					assert.equal(path, "/proc/11/fd");
					return ["0", "1", "2"];
				},
				readlinkSync: (path) => {
					assert.equal(path, "/proc/11/exe");
					return executable;
				},
			},
		},
		globals: { process: { kill: (...args) => kills.push(args) } },
	});
	return { ...module, kills, signal: () => module.interruptSoakConnection(10, "/owned/profile", ["/owned/repo"], { pid: 11, startTicks: "100", rssKiB: 8192, fdCount: 3 }) };
}

test("soak interruption signals only the current app descendant with its private pin, helper root and start ticks", () => {
	const f = fixture();
	f.signal();
	assert.deepEqual(f.kills, [[11, "SIGTERM"]]);
});

for (const [name, input] of [
	["not a descendant", { descendant: false }],
	["another profile's pin", { pin: "/another/profile" }],
	["another root", { root: "/another/repo" }],
	["PID reused", { ticks: "200" }],
	["not SSH executable", { executable: "/usr/bin/node" }],
])
	test("soak refuses interruption: " + name, () => {
		const f = fixture(input);
		assert.throws(f.signal, /SOAK_SSH_IDENTITY_CHANGED/);
		assert.deepEqual(f.kills, []);
	});

test("resource permission errors are not converted to a fake zero/absent process", () => {
	const f = fixture({ denyStat: true });
	assert.throws(f.signal, /denied/);
	assert.deepEqual(f.kills, []);
});
