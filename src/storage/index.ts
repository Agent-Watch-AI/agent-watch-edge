/**
 * Durable local state: where it lives, and how it is read and written without
 * ever leaving a half-file or clobbering something we could not parse.
 */
export type { AgentInstallState, AgentWatchPaths, InstallState, JsonReadResult, ReleaseLock } from './types/storage.types.js';

export { resolvePaths } from './paths.js';
export { readJsonFile } from './json-file.js';
export { backupFile, writeFileAtomic } from './atomic-file.js';
export { acquireLock } from './lock.js';
export { loadInstallState, saveInstallState } from './install-state.js';
