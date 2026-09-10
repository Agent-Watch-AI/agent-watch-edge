import fs from 'node:fs';
import path from 'node:path';
import { compact } from '../core/object.js';
import { sameEndpoint } from './destination.js';
import { ROOT_URL_FIELDS } from './constants/config.constants.js';
import type { AgentWatchConfig, RootedConfig, RootOverride } from './types/config.types.js';

/**
 * Pick the project root governing a directory.
 *
 * Longest match wins: a checkout nested inside a workspace overrides the
 * workspace, which is the only ordering that lets one machine hold both.
 * Matching is on path segments, never on the raw string, so `/dev/trip` does
 * not claim `/dev/tripPlanner`; and on real paths, so a checkout reached
 * through a symlink (`~/work` -> `/Volumes/dev/work`, `/tmp` -> `/private/tmp`)
 * still lands in its tenant rather than falling through to the machine default.
 *
 * @param roots - Configured roots, keyed by absolute path.
 * @param cwd - Directory the payload came from.
 * @returns The winning root path and its overrides, or undefined.
 */
export function selectRoot(roots: Readonly<Record<string, RootOverride>> | undefined, cwd: string): RootedConfig['root'] {
  if (!roots) return undefined;

  const target = canonicalRoot(cwd);
  let bestKey: string | undefined;
  let bestLength = -1;

  for (const key of Object.keys(roots)) {
    // A relative root would resolve against whatever directory the hook
    // happened to start in, which is not a decision anyone can predict.
    if (!path.isAbsolute(key)) continue;

    const candidate = canonicalRoot(key);

    if (!contains(candidate, target) || candidate.length <= bestLength) continue;

    bestKey = key;
    bestLength = candidate.length;
  }

  if (bestKey === undefined) return undefined;

  // Named as configured, so `agentwatch config` shows the root the user wrote.
  return { path: path.resolve(bestKey), override: roots[bestKey]! };
}

/**
 * Whether this machine sends as more than one identity.
 *
 * The offline queue asks this before it adopts a backlog that records no
 * identity: with a second bearer configured, an unattributed entry may belong to
 * the other tenant, and adopting it would deliver that tenant's usage under the
 * wrong token. Counted by distinct tokens, not by the presence of a `roots`
 * block: a root that only changes the developer email is the same identity.
 *
 * @param config - The machine's global config, before roots are stripped.
 * @returns True when two different bearers are configured here.
 */
export function servesMultipleIdentities(config: AgentWatchConfig): boolean {
  const tokens = new Set([config.token, ...Object.values(config.roots ?? {}).map((root) => root.token)]);

  tokens.delete(undefined);

  return tokens.size > 1;
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
  const { roots: _roots, ...withoutRoots } = config;

  if (!selected) return { config: withoutRoots };

  // Undefined-valued keys in the override would erase the global value, so
  // only the keys actually present are laid over it.
  return { config: { ...withoutDestination(withoutRoots, selected.override), ...compact(selected.override) }, root: selected };
}

/**
 * A root shares telemetry routes only when it names no different destination.
 * Refusal never establishes sharing. Route-only roots retain the machine base
 * for enforcement, but cannot derive an unnamed telemetry route from it.
 * A root with its own base derives enforcement there instead of leaking its
 * bearer to an explicit machine enforcement service.
 */
function withoutDestination<T extends AgentWatchConfig>(config: Omit<T, 'roots'>, override: RootOverride): Omit<T, 'roots'> {
  const named = ROOT_URL_FIELDS.some((field) => {
    const key = field as keyof RootOverride & keyof typeof config;
    const value = override[key];

    if (value === undefined) return false;

    if (key === 'endpoint') return !sameEndpoint(value, config[key]);

    return value === null || value !== config[key];
  });

  if (!named) return config;

  const ownBase = override.endpoint !== undefined;
  const route = ownBase ? undefined : null;

  return { ...config, eventsUrl: route, otlpUrl: route, enforcementUrl: ownBase && !sameEndpoint(override.endpoint, config.endpoint) ? undefined : config.enforcementUrl };
}

/**
 * The real, absolute form of a path — or its resolved form when it does not
 * exist yet, which is still comparable to another path that does not exist.
 *
 * @param value - Path as configured or as reported by the agent.
 * @returns The canonical path.
 */
export function canonicalRoot(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
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
