import path from 'node:path';
import { enforcementUrl } from '../config/config.js';
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
  if (!options.config.enforcement.enabled || !url || !token || !developerId) return ALLOW;

  try {
    return await decideThroughCache(options, url, token, developerId);
  } catch (error) {
    debugLog('enforcement: check threw; allowing:', error);

    return ALLOW;
  }
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
 * @param token - Bridge token.
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
  const key = decisionKey(url, token, developerId);
  const cached = await cache.read(key);

  if (cached) return cached;

  const answered = await requestDecision({
    url,
    token,
    developerId,
    installationId: options.config.installationId,
    timeoutMs: options.config.enforcement.timeoutMs,
    fetchFn: options.fetchFn
  });

  if (!answered) return ALLOW;

  await cache.write(key, answered, options.config.enforcement.cacheTtlMs);

  return answered;
}
