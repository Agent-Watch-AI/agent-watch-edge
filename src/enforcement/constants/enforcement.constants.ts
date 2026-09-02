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
