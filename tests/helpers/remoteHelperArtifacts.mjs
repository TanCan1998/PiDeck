import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * The reviewed helper bundle as the deploy path ships it: several files in one directory, the entry importing
 * its siblings by relative path. Tests that start a real helper process write the whole set, because the entry
 * alone cannot run - that is the point of the split.
 */
const { REMOTE_HELPER_ARTIFACTS, REMOTE_HELPER_ENTRY_FILE_NAME } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");

/** Write every artifact into `directory` (read-only, like the deploy bundle) and answer the entry path. */
export function materializeRemoteHelperArtifacts(directory) {
	for (const artifact of REMOTE_HELPER_ARTIFACTS) writeFileSync(join(directory, artifact.name), artifact.source, { mode: 0o400 });
	return { entryPath: join(directory, REMOTE_HELPER_ENTRY_FILE_NAME), artifacts: REMOTE_HELPER_ARTIFACTS };
}

export { REMOTE_HELPER_ARTIFACTS, REMOTE_HELPER_ENTRY_FILE_NAME };
