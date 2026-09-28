import type { EnforcementDecision } from '../types/enforcement.types.js';

/** The two decisions, as both the wire and the cache file spell them. */
export const DECISION_ALLOW = 'allow';
export const DECISION_BLOCK = 'block';

/**
 * The answer every failure degrades to.
 *
 * Shared as one frozen value so no code path can build an "allow" that carries
 * anything else.
 */
export const ALLOW: EnforcementDecision = Object.freeze({ decision: DECISION_ALLOW });

/** Local cache file under the data directory. */
export const ENFORCEMENT_CACHE_FILE_NAME = 'enforcement-cache.json';

/**
 * The enforcement breaker's file, in the identity's state directory beside the
 * delivery breaker and never the same file: an outage on one path is not an
 * outage on the other, and the two are tripped by different signals. Suffixed
 * with a digest of the decision URL, because what the breaker records is that
 * one endpoint did not answer.
 */
export const ENFORCEMENT_COOLDOWN_FILE_PREFIX = 'enforcement-cooldown-';
export const ENFORCEMENT_COOLDOWN_FILE_SUFFIX = '.json';
export const ENFORCEMENT_COOLDOWN_URL_CHARS = 12;

/**
 * How long turns skip the check after the platform failed to answer one: 30 s.
 *
 * Only a submitted prompt asks, so this is measured against how often a person
 * presses enter. Inside the 5 s window it would expire between almost every pair
 * of turns and save nothing — every turn of an outage would pay the timeout
 * again, which is what `edge-resilience` §1 forbids. Longer is not free: a turn
 * the breaker skips is not checked, so after a blip clears a tenant over its cap
 * can run for up to this long. That is at most a turn or two at human pace, it
 * is the same outcome the failed request itself already produced, and each
 * skipped turn is a fail-open like any other, with the breaker as its reason.
 * Half the delivery breaker's 60 s because an unchecked turn costs a
 * tenant money and a late event costs nothing.
 */
export const ENFORCEMENT_COOLDOWN_MS = 30_000;

/**
 * Entries kept in the cache file.
 *
 * A machine has one backend token and, through per-repository git identities, a
 * handful of developer ids; the cap exists so a pathological setup cannot grow
 * the file without bound, not because 16 is ever reached.
 */
export const MAX_CACHE_ENTRIES = 16;

/** Query parameter the endpoint reads the identity from. */
export const DEVELOPER_ID_PARAM = 'developer_id';

/** And the checkout, which is what lets a cap on a feature be judged. */
export const REPOSITORY_PARAM = 'repository';
export const BRANCH_PARAM = 'branch';

/** And the model, which is what lets a cap on one model be judged. */
export const MODEL_PARAM = 'model';
