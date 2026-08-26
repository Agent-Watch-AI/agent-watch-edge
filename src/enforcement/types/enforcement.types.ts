import type { AgentWatchConfig } from '../../config/types/config.types.js';
import type { AgentWatchPaths } from '../../storage/types/storage.types.js';

/**
 * These types are hand-written and the validators in `schemas/` are annotated
 * with them — the reverse of the `schemas -> types` direction AGENTS.md states,
 * and deliberately so: the annotation is a compile-time check that the union
 * here and the schema there describe the same thing, which `z.infer` cannot give
 * for `readonly` fields. See the schema file's header before "fixing" it.
 */

/**
 * What the platform answered, reduced to what the hook path acts on.
 *
 * A union rather than one shape with an optional message, for the reason the
 * platform's own contract gives: a refusal always carries the sentence that
 * explains it, and an allow has nothing to say. Written as optionals, a refusal
 * with nothing to show the developer would type-check.
 */
export type EnforcementDecision = { readonly decision: 'allow' } | { readonly decision: 'block'; readonly message: string };

/** One decision as the local cache holds it, with the deadline it expires at. */
export interface CachedDecision {
  readonly decision: EnforcementDecision;
  readonly expiresAt: number;
}

/** One request to the decision endpoint. */
export interface DecisionRequest {
  readonly url: string;
  readonly token: string;
  /** The same identity `turn.summary.developer_id` carries. */
  readonly developerId: string;
  readonly installationId?: string;
  readonly timeoutMs: number;
  /** Injected by tests; the real fetch otherwise. */
  readonly fetchFn?: typeof fetch;
}

/** Everything the check needs to answer without touching ambient state. */
export interface EnforcementOptions {
  readonly config: AgentWatchConfig;
  readonly paths: AgentWatchPaths;
  /** The identity to ask about, or undefined when this machine has none. */
  readonly developerId?: string;
  readonly now: () => Date;
  readonly fetchFn?: typeof fetch;
}
