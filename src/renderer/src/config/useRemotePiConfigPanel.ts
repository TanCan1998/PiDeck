import { useCallback, useEffect, useReducer, useRef } from "react";
import { REMOTE_CONFIG_CODES, remotePiConfigCodeFromError, type PiConfigFileKey } from "../../../shared/piConfig";
import { desktopApi } from "../desktopApi";
import { initialRemoteConfigPanelState, parseMergePatchText, readRemoteConfigSnapshot, readRemoteConfigWriteReceipt, reduceRemoteConfigPanel, remoteConfigCanSave, remoteConfigPatchDirty } from "./remoteConfigModel";

/**
 * Owner of the remote config panel state (Batch B). Views only render state and forward events; every read and
 * write goes through an injectable port so tests can drive the state machine without Electron.
 *
 * Invariants kept here (not in the view):
 * - reads are generation-guarded: a late answer for an old host/file is ignored;
 * - a write always carries the version of the snapshot currently displayed, never a guessed/stale one;
 * - after a successful patch the panel re-reads to show the sanitized result of what actually landed;
 * - RESULT_UNCONFIRMED is terminal for this draft: only an explicit reload may continue.
 */

export type RemoteConfigPanelPorts = {
	read: (input: { hostId: string; file: PiConfigFileKey }) => Promise<unknown>;
	save: (input: { hostId: string; file: PiConfigFileKey; expectedVersion: string; patch: Record<string, unknown> }) => Promise<unknown>;
};

/** Production ports: the four existing config methods, now accepting the shared target options (no new channels). */
export const remoteConfigDesktopPorts: RemoteConfigPanelPorts = {
	read: ({ hostId, file }) => {
		const target = { kind: "ssh" as const, hostId };
		return file === "models" ? desktopApi.config.getModels({ target }) : desktopApi.config.getSettings({ target });
	},
	save: ({ hostId, file, expectedVersion, patch }) => {
		const options = { target: { kind: "ssh" as const, hostId }, expectedVersion, patch };
		// The legacy body argument is ignored on the ssh route (main routes before ConfigManager); it exists only
		// because Batch A kept the four channel signatures. Sending an empty artifact shape is deliberate: if the
		// remote route were ever absent, main fails closed instead of writing this body to the local file.
		return file === "models" ? desktopApi.config.saveModels({ providers: {} }, options) : desktopApi.config.saveSettings({}, options);
	},
};

export type RemoteConfigSaveOutcome = "saved" | "conflict" | "unconfirmed" | "failed" | "unsupported" | "blocked" | "invalid-patch";

function codeOf(error: unknown): string {
	return remotePiConfigCodeFromError(error) ?? REMOTE_CONFIG_CODES.unavailable;
}

export function useRemotePiConfigPanel(input: { hostId: string; file: PiConfigFileKey; ports?: RemoteConfigPanelPorts; onDirtyChange?: (dirty: boolean) => void }) {
	const { hostId, file, onDirtyChange } = input;
	const ports = input.ports ?? remoteConfigDesktopPorts;
	const [state, dispatch] = useReducer(reduceRemoteConfigPanel, initialRemoteConfigPanelState);
	const generation = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			generation.current += 1;
		};
	}, []);

	const load = useCallback(async () => {
		const request = generation.current + 1;
		generation.current = request;
		dispatch({ type: "reloadStarted" });
		try {
			const response = await ports.read({ hostId, file });
			if (!mounted.current || request !== generation.current) return;
			const snapshot = readRemoteConfigSnapshot(response, { hostId, file });
			if (snapshot === "unsupported") dispatch({ type: "unsupported" });
			else if (snapshot === "invalid") dispatch({ type: "loadFailed", code: REMOTE_CONFIG_CODES.fileInvalid });
			else dispatch({ type: "loaded", snapshot });
		} catch (error) {
			if (!mounted.current || request !== generation.current) return;
			dispatch({ type: "loadFailed", code: codeOf(error) });
		}
	}, [hostId, file, ports]);

	useEffect(() => {
		void load();
	}, [load]);

	const reload = useCallback(() => {
		void load();
	}, [load]);

	const setPatchText = useCallback((text: string) => dispatch({ type: "patchChanged", text }), []);
	const resetPatch = useCallback(() => dispatch({ type: "resetPatch" }), []);

	const save = useCallback(async (): Promise<RemoteConfigSaveOutcome> => {
		if (!remoteConfigCanSave(state) || state.snapshot === undefined) return "blocked";
		const parsed = parseMergePatchText(state.patchText);
		if (!parsed.ok) return "invalid-patch";
		dispatch({ type: "saveStarted" });
		try {
			const response = await ports.save({ hostId, file, expectedVersion: state.snapshot.version, patch: parsed.patch });
			if (!mounted.current) return "blocked";
			const receipt = readRemoteConfigWriteReceipt(response);
			if (receipt === "unsupported") {
				dispatch({ type: "saveFailed", code: REMOTE_CONFIG_CODES.unsupported });
				return "unsupported";
			}
			if (receipt === "invalid") {
				dispatch({ type: "saveFailed", code: REMOTE_CONFIG_CODES.fileInvalid });
				return "failed";
			}
			dispatch({ type: "saved" });
			// Re-read so the pane shows the sanitized bytes that actually landed, not a guessed local merge.
			void load();
			return "saved";
		} catch (error) {
			if (!mounted.current) return "blocked";
			const code = codeOf(error);
			if (code === REMOTE_CONFIG_CODES.versionConflict) dispatch({ type: "conflict", code });
			else if (code === REMOTE_CONFIG_CODES.resultUnconfirmed) dispatch({ type: "unconfirmed", code });
			else dispatch({ type: "saveFailed", code });
			return code === REMOTE_CONFIG_CODES.versionConflict ? "conflict" : code === REMOTE_CONFIG_CODES.resultUnconfirmed ? "unconfirmed" : "failed";
		}
	}, [hostId, file, ports, state, load]);

	const dirty = remoteConfigPatchDirty(state.patchText);
	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(
		() => () => {
			onDirtyChange?.(false);
		},
		[onDirtyChange],
	);

	return { state, dirty, reload, save, setPatchText, resetPatch };
}
