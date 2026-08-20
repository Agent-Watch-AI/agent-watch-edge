import { readJsonFile } from './json-file.js';
import { writeFileAtomic } from './atomic-file.js';
import { SECRET_FILE_MODE } from './constants/storage.constants.js';
import { installStateSchema } from './schemas/storage.schema.js';
import type { AgentWatchPaths, InstallState } from './types/storage.types.js';

export type { AgentInstallState, InstallState } from './types/storage.types.js';

/**
 * Read what setup previously wrote into agent configs.
 *
 * Never fails: a missing or corrupt state file degrades to "nothing
 * installed", which makes the next setup re-register hooks rather than leave
 * the user with an agent nobody is watching.
 *
 * @param paths - Resolved AgentWatch paths.
 * @returns The stored state, or an empty one.
 */
export async function loadInstallState(paths: AgentWatchPaths): Promise<InstallState> {
  const result = await readJsonFile(paths.installStateFile);

  if (result.state !== 'ok') return emptyInstallState();

  const parsed = installStateSchema.safeParse(result.value);

  if (!parsed.success) return emptyInstallState();

  return parsed.data;
}

/**
 * Persist install state atomically.
 *
 * @param paths - Resolved AgentWatch paths.
 * @param state - State to write.
 */
export async function saveInstallState(paths: AgentWatchPaths, state: InstallState): Promise<void> {
  await writeFileAtomic(paths.installStateFile, JSON.stringify(state, null, 2) + '\n', SECRET_FILE_MODE);
}

/**
 * A state file describing no installation at all.
 *
 * @returns A fresh empty state.
 */
function emptyInstallState(): InstallState {
  return { schemaVersion: 1, agents: {} };
}
