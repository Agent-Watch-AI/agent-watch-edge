/**
 * The pre-turn budget check: one question to the platform before a developer's
 * agent starts a turn, and a refusal only when the platform explicitly says so.
 *
 * `resolveEnforcement` is the whole contract, and `enforcementWouldAsk` is the
 * question a caller asks before paying for anything the check needs. The client, the cache and the
 * validators are how it keeps that contract, not part of it; tests reach for
 * them directly.
 */
export { enforcementWouldAsk, resolveEnforcement } from './enforcement.js';
export { DECISION_BLOCK, ENFORCEMENT_CACHE_FILE_NAME } from './constants/enforcement.constants.js';
export type { EnforcementDecision, EnforcementOptions } from './types/enforcement.types.js';
