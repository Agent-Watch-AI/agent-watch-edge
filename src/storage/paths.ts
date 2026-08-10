import path from 'node:path';
import type { Env } from '../core/env.js';

export interface AgentWatchPaths {
  /** Configuration (endpoint, token, capture flags). */
  configDir: string;
  configFile: string;
  /** Record of exactly what setup wrote into agent configs. */
  installStateFile: string;
  /** Mutable state: queue, locks, backups. */
  dataDir: string;
  queueDir: string;
  locksDir: string;
  backupsDir: string;
  /** Per-session accumulator state for turn summaries. */
  turnsDir: string;
}

export function resolvePaths(env: Env): AgentWatchPaths {
  const configDir = env.vars['AGENTWATCH_CONFIG_DIR'] ?? path.join(env.home, '.agentwatch');
  const dataDir = env.vars['AGENTWATCH_DATA_DIR'] ?? defaultDataDir(env);
  return {
    configDir,
    configFile: path.join(configDir, 'config.json'),
    installStateFile: path.join(configDir, 'install-state.json'),
    dataDir,
    queueDir: path.join(dataDir, 'queue'),
    locksDir: path.join(dataDir, 'locks'),
    backupsDir: path.join(dataDir, 'backups'),
    turnsDir: path.join(dataDir, 'turns')
  };
}

function defaultDataDir(env: Env): string {
  if (env.platform === 'win32') {
    const localAppData = env.vars['LOCALAPPDATA'];
    if (localAppData) return path.join(localAppData, 'agentwatch');
  }
  const xdg = env.vars['XDG_DATA_HOME'];
  if (xdg) return path.join(xdg, 'agentwatch');
  return path.join(env.home, '.local', 'share', 'agentwatch');
}
