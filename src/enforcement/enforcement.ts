import path from 'node:path';
import { enforcementUrl } from '../config/config.js';
import type { AgentWatchConfig } from '../config/types/config.types.js';
import { debugLog } from '../core/logger.js';
import { ALLOW, ENFORCEMENT_CACHE_FILE_NAME } from './constants/enforcement.constants.js';
import { DecisionCache, decisionKey } from './decision-cache.js';
import { requestDecision } from './decision-client.js';
import type { EnforcementDecision, EnforcementOptions } from './types/enforcement.types.js';

/**
 * Whether this developer may start a turn right now.
 *
 * The single rule of this module: only an explicit `block` from the platform,
 * carrying the sentence that explains it, is a refusal. Not configured, turned
 * off, nobody to ask about, a timeout, a network error, any other status, a body
 * this code cannot read — every one of them allows the turn. The check sits in
 * front of every developer's tooling, so a check that failed closed would turn
 * an alerts-service hiccup into an outage for a whole engineering organization.
 *
 * Never throws: a caller on the hook path has to answer the agent either way.
 *
 * @param options - Effective config, paths, the identity to ask about, clock.
 * @returns The decision to act on.
 */
export async function resolveEnforcement(options: EnforcementOptions): Promise<EnforcementDecision> {
  const url = enforcementUrl(options.config);
  const token = options.config.token;
  const developerId = options.developerId;

  // Nothing was asked, so nobody said no.
  if (!enforcementWouldAsk(options.config) || !url || !token || !developerId) return ALLOW;

  try {
    return await decideThroughCache(options, url, token, developerId);
  } catch (error) {
    debugLog('enforcement: check threw; allowing:', error);

    return ALLOW;
  }
}

/**
 * Whether a decision would be asked for at all, from configuration alone.
 *
 * Exported because the caller has to know before it pays for anything the
 * question needs. Working out where a prompt is happening costs a walk of the
 * working copy and, on a cold checkout, a git process; spending that on a
 * machine that will not ask is the one cost this feature must not add to the
 * gate.
 *
 * Identity is not part of it: resolving that is the caller's own decision, and
 * it is already paid for elsewhere.
 *
 * @param config - Effective configuration.
 * @returns True when a configured, enabled check would reach the platform.
 */
export function enforcementWouldAsk(config: AgentWatchConfig): boolean {
  return config.enforcement.enabled && Boolean(config.token) && Boolean(enforcementUrl(config));
}

/**
 * The decision, from the local cache when it holds a live one.
 *
 * A miss asks the platform and stores whatever it answered. A *failure* is not
 * stored: it is not a decision, and caching it as an allow would extend one
 * unreachable moment across the whole TTL.
 *
 * @param options - As given to {@link resolveEnforcement}.
 * @param url - The decision endpoint.
 * @param token - Edge token.
 * @param developerId - Identity to ask about.
 * @returns The decision to act on.
 */
async function decideThroughCache(
  options: EnforcementOptions,
  url: string,
  token: string,
  developerId: string
): Promise<EnforcementDecision> {
  const cache = new DecisionCache(path.join(options.paths.dataDir, ENFORCEMENT_CACHE_FILE_NAME), options.now);
  const key = decisionKey(url, token, developerId, options.checkout);
  const cached = await cache.read(key);

  if (cached) return cached;

  const answered = await requestDecision({
    url,
    token,
    developerId,
    checkout: options.checkout,
    installationId: options.config.installationId,
    timeoutMs: options.config.enforcement.timeoutMs,
    fetchFn: options.fetchFn
  });

  if (!answered) return ALLOW;

  const { cacheTtlMs, ...decision } = answered;
  const ttlMs = effectiveTtlMs(cacheTtlMs, options.config.enforcement.cacheTtlMs);

  // Zero is the platform saying "do not keep this", which it says to every tenant
  // that has a feature cap: which feature a branch belongs to is a fact about one
  // checkout, and this cache is keyed on the developer. Written anyway the entry
  // would already be expired — but it would still be a file write per gated
  // prompt for something nothing can ever read.
  if (ttlMs > 0) {
    await cache.write(key, decision, ttlMs);

    return decision;
  }

  // Writing is also what prunes, so an answer that must not be kept still has to
  // sweep what an earlier one left behind.
  await cache.prune();

  return decision;
}

/**
 * How long this answer may be reused.
 *
 * The platform asks for a TTL because it is the side that knows how close the
 * scope came to its cap; this side clamps it to what the machine's owner allowed
 * and never above. So the platform can make an answer fresher — which is what a
 * developer approaching a cap needs — and cannot make one last longer than the
 * configured ceiling, which is what keeps the setting meaningful.
 *
 * No advice means the configured value, which is what a platform that predates
 * the field produces.
 *
 * @param asked - What the platform asked for, if anything.
 * @param configured - This machine's own TTL, and its ceiling.
 * @returns The TTL to store the entry with.
 */
function effectiveTtlMs(asked: number | undefined, configured: number): number {
  if (asked === undefined) return configured;

  return Math.min(asked, configured);
}
