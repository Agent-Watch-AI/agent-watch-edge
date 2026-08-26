import path from 'node:path';
import { omitKeys } from '../core/object.js';
import type { UnknownRecord } from '../core/types/core.types.js';
import { ROOTS_KEY } from './constants/config.constants.js';
import type { AgentWatchConfig, RootedConfig, RootOverride } from './types/config.types.js';

/**
 * Pick the project root governing a directory.
 *
 * Longest match wins: a checkout nested inside a workspace overrides the
 * workspace, which is the only ordering that lets one machine hold both.
 * Matching is on path segments, never on the raw string, so `/dev/trip` does
 * not claim `/dev/tripPlanner`.
 *
 * @param roots - Configured roots, keyed by absolute path.
 * @param cwd - Directory the payload came from.
 * @returns The winning root path and its overrides, or undefined.
 */
export function selectRoot(roots: Readonly<Record<string, RootOverride>> | undefined, cwd: string): RootedConfig['root'] {
  if (!roots) return undefined;

  const target = path.resolve(cwd);
  let bestPath: string | undefined;
  let bestOverride: RootOverride | undefined;

  for (const key of Object.keys(roots)) {
    // A relative root would resolve against whatever directory the hook
    // happened to start in, which is not a decision anyone can predict.
    if (!path.isAbsolute(key)) continue;

    const candidate = path.resolve(key);

    if (!contains(candidate, target)) continue;

    if (bestPath !== undefined && candidate.length <= bestPath.length) continue;

    bestPath = candidate;
    bestOverride = roots[key];
  }

  if (bestPath === undefined || bestOverride === undefined) return undefined;

  return { path: bestPath, override: bestOverride };
}

/**
 * Apply the matching project root's identity to the global config.
 *
 * The `roots` block itself is stripped from the result: every consumer
 * downstream wants one identity, and `agentwatch config` would otherwise print
 * every other tenant's token next to the one it redacts.
 *
 * @param config - The machine's global config.
 * @param cwd - Directory the payload came from.
 * @returns The config for this directory, and the root that produced it.
 */
export function applyRootOverride(config: AgentWatchConfig, cwd: string): RootedConfig {
  const selected = selectRoot(config.roots, cwd);
  const withoutRoots = omitKeys(config as UnknownRecord, new Set([ROOTS_KEY])) as AgentWatchConfig;

  if (!selected) return { config: withoutRoots };

  // Undefined-valued keys in the override would erase the global value, so
  // only the keys actually present are laid over it.
  return { config: { ...withoutRoots, ...definedOnly(selected.override) }, root: selected };
}

/**
 * Whether a directory is at or beneath a root.
 *
 * @param root - Resolved candidate root.
 * @param target - Resolved directory under test.
 * @returns True when target is the root or inside it.
 */
function contains(root: string, target: string): boolean {
  if (target === root) return true;

  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  return target.startsWith(prefix);
}

/**
 * Drop keys explicitly set to undefined, which spread would otherwise use to
 * overwrite a perfectly good global value.
 *
 * @param override - One root's overrides.
 * @returns The same object without its undefined entries.
 */
function definedOnly(override: RootOverride): UnknownRecord {
  const defined: UnknownRecord = {};

  for (const key of Object.keys(override)) {
    const value = (override as UnknownRecord)[key];

    if (value === undefined) continue;

    defined[key] = value;
  }

  return defined;
}
