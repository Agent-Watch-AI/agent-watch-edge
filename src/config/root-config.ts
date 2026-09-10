import fs from 'node:fs';
import path from 'node:path';
import { compact } from '../core/object.js';
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

  const target = canonical(cwd);
  let bestKey: string | undefined;
  let bestLength = -1;

  for (const key of Object.keys(roots)) {
    // A relative root would resolve against whatever directory the hook
    // happened to start in, which is not a decision anyone can predict.
    if (!path.isAbsolute(key)) continue;

    const candidate = canonical(key);

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
 * The global config with its derived routes cleared, when the root names a
 * destination of its own.
 *
 * `eventsUrl()` and `otlpBaseUrl()` prefer their own field and only fall back
 * to `endpoint`, so a machine that splits its routes across hosts laid two
 * explicit strings under every root, and they won before the root's own
 * `endpoint` was consulted: that root's prompts went to the machine's ingest
 * under the root's own bearer, refused or not. `otel-headers` compares the two
 * OTLP bases to decide whether the agent's exporter may carry the root's
 * bearer, and they compared equal for the same reason. The value that has to
 * stop being read is on the global side of the merge, which is why no accessor
 * can fix it.
 *
 * Only the two route fields are cleared, never `endpoint`. `enforcementUrl` has
 * no `roots[]` field of its own and derives from `endpoint`, and no decision
 * URL means `ALLOW` — so clearing `endpoint` would silently switch every
 * `block` cap off under a root that named nothing but its own ingest. They are
 * cleared to `null` rather than absent when the root names no `endpoint` of its
 * own, so "from nothing" survives the fallback to the machine's.
 *
 * "Names a destination of its own" is a *different* value, not merely a present
 * key: `setup --root` always writes `endpoint`, the machine's own unless
 * `--endpoint` says otherwise, so every root enrolled through the CLI names one.
 * Keying on presence took the machine's split routes away from an existing
 * second seat on upgrade — its events to a host that is not an ingest route,
 * its exporter unauthenticated — with nothing in the file changed to explain it.
 *
 * @param config - The machine's global config, roots already stripped.
 * @param override - The winning root's overrides.
 * @returns The config to lay the override over.
 */
function withoutDestination<T extends AgentWatchConfig>(config: Omit<T, 'roots'>, override: RootOverride): Omit<T, 'roots'> {
  const named = ROOT_URL_FIELDS.some((field) => {
    const key = field as keyof RootOverride & keyof typeof config;

    // A refusal is never "the same destination as the machine's", and two
    // refusals compare equal: with the machine's own endpoint refused as well
    // — the state these releases made survivable rather than fatal — a value
    // comparison alone read the root as a second seat and handed it every
    // global route. A field the developer wrote that the edge will not send to
    // is the strongest statement there is that this root has a backend of its
    // own.
    return key in override && (override[key] === null || override[key] !== config[key]);
  });

  if (!named) return config;

  // `null`, not `undefined`, unless the root names an `endpoint` to derive
  // from. `endpoint` stays — enforcement has nothing else to derive from — and
  // both route accessors fall back to it, so clearing to `undefined` was a
  // no-op for whichever of the two fields the root did not name: its events
  // went to the machine's ingest, or its bearer to the machine's collector,
  // under the root's own token. `null` is the refused sentinel every accessor
  // already honours, and `compact` still lays the root's own field over it.
  const own = 'endpoint' in override ? undefined : null;

  return { ...config, eventsUrl: own, otlpUrl: own };
}

/**
 * The real, absolute form of a path — or its resolved form when it does not
 * exist yet, which is still comparable to another path that does not exist.
 *
 * @param value - Path as configured or as reported by the agent.
 * @returns The canonical path.
 */
function canonical(value: string): string {
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
