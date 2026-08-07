import crypto from 'node:crypto';
import { configSchema, defaultConfig, type AgentWatchConfig } from './config.js';
import { readJsonFile } from '../storage/json-file.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import type { AgentWatchPaths } from '../storage/paths.js';

export type ConfigLoadResult =
  | { state: 'ok'; config: AgentWatchConfig }
  | { state: 'missing'; config: AgentWatchConfig }
  | { state: 'invalid'; error: string; config: AgentWatchConfig };

/** Never throws: hooks must run even with a broken config file. */
export async function loadConfig(paths: AgentWatchPaths): Promise<ConfigLoadResult> {
  const result = await readJsonFile(paths.configFile);
  if (result.state === 'missing') return { state: 'missing', config: defaultConfig() };
  if (result.state === 'invalid') return { state: 'invalid', error: result.error, config: defaultConfig() };
  const parsed = configSchema.safeParse(result.value);
  if (!parsed.success) {
    return { state: 'invalid', error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), config: defaultConfig() };
  }
  return { state: 'ok', config: parsed.data };
}

export async function saveConfig(paths: AgentWatchPaths, config: AgentWatchConfig): Promise<void> {
  // 0o600: the file may contain a backend token.
  await writeFileAtomic(paths.configFile, JSON.stringify(config, null, 2) + '\n', 0o600);
}

export function ensureInstallationId(config: AgentWatchConfig): AgentWatchConfig {
  if (config.installationId) return config;
  return { ...config, installationId: crypto.randomUUID() };
}
