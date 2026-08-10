import fs from 'node:fs/promises';
import path from 'node:path';
import { configSchema, type AgentWatchConfig } from './config.js';
import { loadConfig } from './config-store.js';
import { readJsonFile } from '../storage/json-file.js';
import { debugLog } from '../core/logger.js';
import type { AgentWatchPaths } from '../storage/paths.js';

/** Repository-level overrides file, found by walking up from the working directory. */
export const REPO_CONFIG_NAME = '.agentwatch.json';

/**
 * Keys a repo file may not set: it is committed and shared, so secrets and
 * per-machine identity stay in the global ~/.agentwatch/config.json only.
 * Delivery destinations are global-only too — a repo file that redirected
 * them would exfiltrate the global bearer token and the telemetry.
 */
const GLOBAL_ONLY_KEYS = ['token', 'installationId', 'developerEmail', 'endpoint', 'eventsUrl', 'otlpUrl'] as const;

/** Nested blocks merged field-by-field instead of replaced wholesale. */
const MERGE_BLOCKS = ['capture', 'emit'] as const;

const MAX_WALK_DEPTH = 32;

export interface MergedConfig {
  config: AgentWatchConfig;
  warnings: string[];
}

export interface EffectiveConfig extends MergedConfig {
  /** Path of the applied repo overrides file, when one was found. */
  repoConfigFile?: string;
}

/** Locate the nearest .agentwatch.json at or above `startDir`. */
export async function findRepoConfigFile(startDir: string): Promise<string | undefined> {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const candidate = path.join(dir, REPO_CONFIG_NAME);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Overlay repository overrides on the global config. Secrets are refused,
 * nested blocks merge per field, and an invalid result degrades to the global
 * config — a broken repo file must never disable telemetry or break hooks.
 */
export function mergeRepoConfig(global: AgentWatchConfig, repoValue: unknown): MergedConfig {
  const warnings: string[] = [];
  if (typeof repoValue !== 'object' || repoValue === null || Array.isArray(repoValue)) {
    return { config: global, warnings: [`${REPO_CONFIG_NAME}: expected a JSON object`] };
  }
  const repo = { ...(repoValue as Record<string, unknown>) };

  for (const key of GLOBAL_ONLY_KEYS) {
    if (key in repo) {
      warnings.push(`${REPO_CONFIG_NAME}: "${key}" is global-only and was ignored`);
      delete repo[key];
    }
  }

  // Delivery tuning governs the machine-global offline queue (size bound,
  // retry budget, age limit): a committed repo file could truncate every
  // other repo's backlog through it, so the whole block stays global-only.
  if ('delivery' in repo) {
    warnings.push(`${REPO_CONFIG_NAME}: "delivery" is global-only and was ignored`);
    delete repo['delivery'];
  }

  // OTLP signal selection is materialized into machine-global agent config
  // (Claude settings.json / Codex config.toml) at setup time, so a repo file
  // could never apply it — and must not be able to silence the usage ledger.
  if ('otel' in repo) {
    warnings.push(`${REPO_CONFIG_NAME}: "otel" is global-only and was ignored`);
    delete repo['otel'];
  }

  // Emission toggles are machine-level: llm.call is the mandatory usage
  // ledger and turn.summary is the only hook-path usage record. A committed
  // repo file may narrow *capture* (prompts, responses, files) but must never
  // be able to silence usage telemetry for everyone who clones the repo.
  if (typeof repo['emit'] === 'object' && repo['emit'] !== null && !Array.isArray(repo['emit'])) {
    const repoEmit = { ...(repo['emit'] as Record<string, unknown>) };
    for (const key of ['llmCalls', 'turnSummaries'] as const) {
      if (key in repoEmit) {
        warnings.push(`${REPO_CONFIG_NAME}: "emit.${key}" is mandatory/global-only and was ignored`);
        delete repoEmit[key];
      }
    }
    repo['emit'] = repoEmit;
  }

  const merged: Record<string, unknown> = { ...(global as Record<string, unknown>), ...repo };
  for (const block of MERGE_BLOCKS) {
    if (typeof repo[block] === 'object' && repo[block] !== null) {
      merged[block] = { ...(global[block] as Record<string, unknown>), ...(repo[block] as Record<string, unknown>) };
    }
  }

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    warnings.push(`${REPO_CONFIG_NAME}: invalid overrides ignored (${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')})`);
    return { config: global, warnings };
  }
  return { config: parsed.data, warnings };
}

/**
 * Global config + nearest repo overrides for `cwd`. Tolerant end to end:
 * any failure yields the global config.
 */
export async function loadEffectiveConfig(paths: AgentWatchPaths, cwd: string): Promise<EffectiveConfig> {
  const loaded = await loadConfig(paths);
  const global = loaded.config;
  // Fail-safe stays closed: with the global config missing or corrupt the
  // runtime runs metadata-only, and a committed repo file must not be able to
  // re-enable content capture on top of that.
  if (loaded.state !== 'ok') {
    const warning = `global config ${loaded.state}; repo overrides ignored`;
    debugLog(warning);
    return { config: global, warnings: [warning] };
  }
  let repoConfigFile: string | undefined;
  try {
    repoConfigFile = await findRepoConfigFile(cwd);
  } catch {
    repoConfigFile = undefined;
  }
  if (!repoConfigFile) return { config: global, warnings: [] };

  const read = await readJsonFile(repoConfigFile);
  if (read.state !== 'ok') {
    const warning = read.state === 'invalid' ? `${repoConfigFile}: ${read.error}` : undefined;
    if (warning) debugLog(warning);
    return { config: global, warnings: warning ? [warning] : [], repoConfigFile };
  }

  const merged = mergeRepoConfig(global, read.value);
  for (const warning of merged.warnings) debugLog(warning);
  return { ...merged, repoConfigFile };
}
