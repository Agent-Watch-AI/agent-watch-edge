import crypto from 'node:crypto';
import { readJsonFile } from '../storage/json-file.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { SECRET_FILE_MODE } from '../storage/constants/storage.constants.js';
import type { AgentWatchPaths } from '../storage/types/storage.types.js';
import { defaultConfig } from './config.js';
import { configSchema } from './schemas/config.schema.js';
import type { AgentWatchConfig, ConfigLoadResult } from './types/config.types.js';

export type { ConfigLoadResult } from './types/config.types.js';

/**
 * Read the global config.
 *
 * Never throws and never returns without a usable config: hooks run inside the
 * coding agent, and a broken config file must degrade behaviour, not break the
 * agent. The caller distinguishes the three outcomes to decide what to *say*
 * about it.
 *
 * @param paths - Resolved AgentWatch paths.
 * @returns The load state and a config to run with.
 */
export async function loadConfig(paths: AgentWatchPaths): Promise<ConfigLoadResult> {
  const result = await readJsonFile(paths.configFile);

  if (result.state === 'missing') return { state: 'missing', config: fallbackConfig() };

  if (result.state === 'invalid') return { state: 'invalid', error: result.error, config: fallbackConfig() };

  const parsed = configSchema.safeParse(result.value);

  if (!parsed.success) return { state: 'invalid', error: describeIssues(parsed.error.issues), config: fallbackConfig() };

  return { state: 'ok', config: parsed.data };
}

/**
 * Persist the global config atomically.
 *
 * @param paths - Resolved AgentWatch paths.
 * @param config - Config to write.
 */
export async function saveConfig(paths: AgentWatchPaths, config: AgentWatchConfig): Promise<void> {
  // 0600: the file may contain a backend token.
  await writeFileAtomic(paths.configFile, JSON.stringify(config, null, 2) + '\n', SECRET_FILE_MODE);
}

/**
 * The config with an installation id, generating one on first use.
 *
 * @param config - Config to complete.
 * @returns The same config, or a copy carrying a fresh id.
 */
export function ensureInstallationId(config: AgentWatchConfig): AgentWatchConfig {
  if (config.installationId) return config;

  return { ...config, installationId: crypto.randomUUID() };
}

/**
 * Fail-safe runtime config for a missing or corrupt file.
 *
 * Hooks keep running, but content capture is OFF: an accidental config wipe
 * must not silently start collecting prompts and tool I/O. Deliberately
 * different from `defaultConfig()`, which is what setup writes when the user
 * asked for an install.
 *
 * @returns A metadata-only config.
 */
function fallbackConfig(): AgentWatchConfig {
  const config = defaultConfig();

  return {
    ...config,
    capture: { ...config.capture, prompts: false, responses: false, toolInput: false, toolOutput: false }
  };
}

/**
 * Render schema issues as one human-readable line.
 *
 * @param issues - Zod issues from a failed parse.
 * @returns The joined description.
 */
function describeIssues(issues: readonly { path: (string | number)[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}
