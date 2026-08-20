import fs from 'node:fs/promises';
import path from 'node:path';
import { asRecord, omitKeys } from '../core/object.js';
import type { UnknownRecord } from '../core/types/core.types.js';
import { debugLog } from '../core/logger.js';
import { readJsonFile } from '../storage/json-file.js';
import type { AgentWatchPaths } from '../storage/types/storage.types.js';
import { loadConfig } from './config-store.js';
import {
  GLOBAL_ONLY_BLOCKS,
  GLOBAL_ONLY_EMIT_KEYS,
  GLOBAL_ONLY_KEYS,
  MAX_WALK_DEPTH,
  MERGE_BLOCKS,
  REPO_CONFIG_NAME
} from './constants/config.constants.js';
import { configSchema } from './schemas/config.schema.js';
import type { AgentWatchConfig, EffectiveConfig, MergedConfig } from './types/config.types.js';

export { REPO_CONFIG_NAME } from './constants/config.constants.js';
export type { EffectiveConfig, MergedConfig } from './types/config.types.js';

/**
 * Locate the nearest `.agentwatch.json` at or above a directory.
 *
 * @param startDir - Directory to start the upward walk from.
 * @returns The file path, or undefined when none is found.
 */
export async function findRepoConfigFile(startDir: string): Promise<string | undefined> {
  let dir = path.resolve(startDir);

  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const candidate = path.join(dir, REPO_CONFIG_NAME);

    if (await isFile(candidate)) return candidate;

    const parent = path.dirname(dir);

    if (parent === dir) return undefined;

    dir = parent;
  }

  return undefined;
}

/**
 * Overlay repository overrides on the global config.
 *
 * A repo file is committed and shared, which is what every rule here follows
 * from: it may narrow what is captured, and it may not touch identity,
 * credentials, delivery destinations or the usage ledger. Anything refused is
 * reported rather than silently dropped, and an invalid *result* degrades to
 * the global config — a broken repo file must never disable telemetry or break
 * a hook.
 *
 * @param global - The machine's global config.
 * @param repoValue - Raw decoded contents of the repo file.
 * @returns The effective config and every override that was refused.
 */
export function mergeRepoConfig(global: AgentWatchConfig, repoValue: unknown): MergedConfig {
  const repo = asRecord(repoValue);

  if (!repo) return { config: global, warnings: [`${REPO_CONFIG_NAME}: expected a JSON object`] };

  const permitted = withoutGlobalOnly(repo);
  const merged = overlay(global, permitted.value);
  const parsed = configSchema.safeParse(merged);

  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

    return { config: global, warnings: [...permitted.warnings, `${REPO_CONFIG_NAME}: invalid overrides ignored (${detail})`] };
  }

  return { config: parsed.data, warnings: permitted.warnings };
}

/**
 * Global config plus the nearest repo overrides for a directory.
 *
 * Tolerant end to end: any failure yields the global config, because the
 * caller is a hook that has to answer the agent either way.
 *
 * @param paths - Resolved AgentWatch paths.
 * @param cwd - Directory the payload came from.
 * @returns The effective config, its warnings, and the file that produced it.
 */
export async function loadEffectiveConfig(paths: AgentWatchPaths, cwd: string): Promise<EffectiveConfig> {
  const loaded = await loadConfig(paths);
  const global = loaded.config;

  // The fail-safe stays closed: with the global config missing or corrupt the
  // runtime is already metadata-only, and a committed repo file must not be
  // able to re-enable content capture on top of that.
  if (loaded.state !== 'ok') {
    const warning = `global config ${loaded.state}; repo overrides ignored`;

    debugLog(warning);

    return { config: global, warnings: [warning] };
  }

  const repoConfigFile = await findRepoConfigFileSafely(cwd);

  if (!repoConfigFile) return { config: global, warnings: [] };

  const read = await readJsonFile(repoConfigFile);

  if (read.state !== 'ok') {
    const warnings = read.state === 'invalid' ? [`${repoConfigFile}: ${read.error}`] : [];

    for (const warning of warnings) debugLog(warning);

    return { config: global, warnings, repoConfigFile };
  }

  const merged = mergeRepoConfig(global, read.value);

  for (const warning of merged.warnings) debugLog(warning);

  return { ...merged, repoConfigFile };
}

/** A repo override set with the global-only parts removed. */
interface PermittedOverrides {
  readonly value: UnknownRecord;
  readonly warnings: readonly string[];
}

/**
 * Strip every override a committed file is not allowed to set.
 *
 * Keys are removed by building a new object rather than deleting from one, so
 * the result stays monomorphic (STYLEGUIDE 3.4).
 *
 * @param repo - Raw repo overrides.
 * @returns The permitted subset and one warning per refusal.
 */
function withoutGlobalOnly(repo: UnknownRecord): PermittedOverrides {
  const warnings: string[] = [];
  const refused = new Set<string>();

  for (const key of Object.keys(repo)) {
    if (GLOBAL_ONLY_KEYS.has(key)) {
      warnings.push(`${REPO_CONFIG_NAME}: "${key}" is global-only and was ignored`);
      refused.add(key);
    }
  }

  for (const block of GLOBAL_ONLY_BLOCKS) {
    if (!(block in repo)) continue;

    warnings.push(`${REPO_CONFIG_NAME}: "${block}" is global-only and was ignored`);
    refused.add(block);
  }

  const value = omitKeys(repo, refused);
  const emit = asRecord(value['emit']);

  if (!emit) return { value, warnings };

  const refusedEmitKeys = new Set<string>();

  for (const key of Object.keys(emit)) {
    if (!GLOBAL_ONLY_EMIT_KEYS.has(key)) continue;

    warnings.push(`${REPO_CONFIG_NAME}: "emit.${key}" is mandatory/global-only and was ignored`);
    refusedEmitKeys.add(key);
  }

  return { value: { ...value, emit: omitKeys(emit, refusedEmitKeys) }, warnings };
}

/**
 * Combine global and repo values, merging the per-field blocks.
 *
 * Top-level keys replace; `capture` and `emit` merge field-by-field, so a repo
 * file turning off one capture flag does not reset the others to their
 * defaults.
 *
 * @param global - Global config.
 * @param repo - Permitted repo overrides.
 * @returns The unvalidated merge, ready for the schema.
 */
function overlay(global: AgentWatchConfig, repo: UnknownRecord): UnknownRecord {
  const merged: UnknownRecord = { ...(global as UnknownRecord), ...repo };

  for (const block of MERGE_BLOCKS) {
    const repoBlock = asRecord(repo[block]);

    if (!repoBlock) continue;

    merged[block] = { ...(global[block] as UnknownRecord), ...repoBlock };
  }

  return merged;
}

/**
 * Locate the repo config, treating any failure as "there is none".
 *
 * @param cwd - Directory to search upward from.
 * @returns The file path, or undefined.
 */
async function findRepoConfigFileSafely(cwd: string): Promise<string | undefined> {
  try {
    return await findRepoConfigFile(cwd);
  } catch {
    return undefined;
  }
}

/**
 * Whether a path exists and is a regular file.
 *
 * @param candidate - Path to test.
 * @returns True when it is a file.
 */
async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    // Missing, or a directory we may not read; keep walking.
    return false;
  }
}
