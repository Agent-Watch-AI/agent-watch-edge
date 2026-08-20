import type { TurnSummaryEvent } from './turn-summary.types.js';

export interface AggregateTurnUsageOptions {
  /**
   * True only when the backend has decided no further OTLP batches can arrive
   * for this turn (watermark / quiet period / session end). OTLP delivery is
   * asynchronous and retried, so the first non-empty batch proves nothing
   * about completeness — without this explicit terminal signal the summary is
   * finalized as 'partial', never 'complete'.
   */
  readonly complete?: boolean;
  /**
   * All turn summaries of the same session, including the one being finalized.
   *
   * With this context every window-joined call is attributed to exactly one
   * summary of the session — the best-matching owner — so overlapping windows
   * cannot double-count and degraded summaries without a started_at can still
   * be finalized. Without it there is no window join at all: per-summary
   * containment alone cannot arbitrate overlapping windows, and letting each
   * summary claim every contained call would double-count usage and cost
   * across successive finalizations. Calls then match only through an exact
   * turn id.
   */
  readonly sessionSummaries?: readonly TurnSummaryEvent[];
}

/** Token and cost totals, as summed from a set of calls. */
export type UsageTotals = Pick<
  TurnSummaryEvent,
  'input_tokens' | 'cached_input_tokens' | 'cache_creation_input_tokens' | 'output_tokens' | 'reasoning_output_tokens' | 'total_tokens' | 'cost_usd'
>;
