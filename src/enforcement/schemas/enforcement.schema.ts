import { z } from 'zod';
import { DECISION_ALLOW, DECISION_BLOCK } from '../constants/enforcement.constants.js';
import type { CachedDecision, EnforcementDecision } from '../types/enforcement.types.js';

/**
 * The two boundaries a decision crosses: the wire and the cache file.
 *
 * Both are parsed, never asserted. A refusal is the one thing this package
 * produces that costs the developer their turn, so it may only ever come from a
 * body that validates completely — a `block` with no message, an unknown
 * decision, or a hand-edited cache entry has to read as "no answer", which the
 * caller turns into an allow.
 *
 * Each schema is annotated with the vocabulary type it must produce: if the
 * unions in `enforcement.types.ts` and these validators stop describing the same
 * thing, this file stops compiling.
 */

/** What the platform may answer. */
export const decisionSchema: z.ZodType<EnforcementDecision> = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal(DECISION_ALLOW) }),
  z.object({ decision: z.literal(DECISION_BLOCK), message: z.string().trim().min(1) })
]);

/**
 * The freshness the platform asked for, if it asked for anything usable.
 *
 * Its own schema, parsed on its own, and never combined with `decisionSchema`
 * into one shape: an intersection would make a nonsense TTL invalidate the
 * refusal beside it, so `{"decision":"block","message":"…","cache_ttl_ms":"bad"}`
 * would read as no answer at all and allow the turn. The decision is the thing
 * that costs a developer their turn; advice about how long to keep it is not
 * allowed a vote on whether it is readable.
 */
export const cacheTtlSchema = z.number().finite().nonnegative();

/** One cache entry: a decision plus the moment it stops being usable. */
export const cachedDecisionSchema: z.ZodType<CachedDecision> = z.object({
  decision: decisionSchema,
  expiresAt: z.number().finite()
});
