import path from 'node:path';
import type { Env } from '../core/env.js';
import {
  AGENTWATCH_DIR_NAME,
  AGENTWATCH_HOME_DIR_NAME,
  BACKUPS_DIR_NAME,
  CHECKOUTS_DIR_NAME,
  CONFIG_DIR_VAR,
  CONFIG_FILE_NAME,
  DATA_DIR_VAR,
  INSTALL_STATE_FILE_NAME,
  LOCAL_APP_DATA_VAR,
  LOCKS_DIR_NAME,
  POSIX_DATA_FALLBACK,
  QUEUE_DIR_NAME,
  SNAPSHOTS_DIR_NAME,
  TURNS_DIR_NAME,
  XDG_DATA_HOME_VAR
} from './constants/storage.constants.js';
import type { AgentWatchPaths } from './types/storage.types.js';

export type { AgentWatchPaths } from './types/storage.types.js';

/**
 * Every path AgentWatch reads or writes, derived from the environment alone.
 *
 * Config and data are deliberately separate roots: config is small, precious
 * and backed up by the user, while data (queue, locks, per-turn state) is
 * disposable and follows the platform's cache/state conventions.
 *
 * @param env - Environment supplying HOME, the platform and any overrides.
 * @returns The resolved path set.
 */
export function resolvePaths(env: Env): AgentWatchPaths {
  const configDir = env.vars[CONFIG_DIR_VAR] ?? path.join(env.home, AGENTWATCH_HOME_DIR_NAME);
  const dataDir = env.vars[DATA_DIR_VAR] ?? defaultDataDir(env);

  return {
    configDir,
    configFile: path.join(configDir, CONFIG_FILE_NAME),
    installStateFile: path.join(configDir, INSTALL_STATE_FILE_NAME),
    dataDir,
    queueDir: path.join(dataDir, QUEUE_DIR_NAME),
    locksDir: path.join(dataDir, LOCKS_DIR_NAME),
    backupsDir: path.join(dataDir, BACKUPS_DIR_NAME),
    turnsDir: path.join(dataDir, TURNS_DIR_NAME),
    snapshotsDir: path.join(dataDir, SNAPSHOTS_DIR_NAME),
    checkoutsDir: path.join(dataDir, CHECKOUTS_DIR_NAME)
  };
}

/**
 * Platform-conventional location for disposable state.
 *
 * @param env - Environment supplying the platform and HOME.
 * @returns Absolute data directory.
 */
function defaultDataDir(env: Env): string {
  const localAppData = env.vars[LOCAL_APP_DATA_VAR];

  if (env.platform === 'win32' && localAppData) return path.join(localAppData, AGENTWATCH_DIR_NAME);

  const xdg = env.vars[XDG_DATA_HOME_VAR];

  if (xdg) return path.join(xdg, AGENTWATCH_DIR_NAME);

  return path.join(env.home, POSIX_DATA_FALLBACK, AGENTWATCH_DIR_NAME);
}
