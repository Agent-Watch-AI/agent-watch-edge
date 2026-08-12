import type { LlmCallEvent } from '../events/llm-call.js';
import type { AgentUsageSummary, TurnSummaryEvent, TurnUsageStatus } from './turn-summary.js';

export interface AggregateTurnUsageOptions {
  /**
   * True only when the backend has decided no further OTLP batches can arrive
   * for this turn (watermark / quiet period / session end). OTLP delivery is
   * asynchronous and retried, so the first non-empty batch proves nothing
   * about completeness — without this explicit terminal signal the summary is
   * finalized as 'partial', never 'complete'.
   */
  complete?: boolean;
  /**
   * All turn summaries of the same session, including the one being
   * finalized. With this context every window-joined call is attributed to
   * exactly one summary of the session — the best-matching owner — so
   * overlapping windows cannot double-count and degraded summaries without
   * a started_at can still be finalized. Without it there is no window join
   * at all: per-summary containment alone cannot arbitrate overlapping
   * windows, and letting each summary claim every contained call would
   * double-count usage and cost across successive finalizations. Calls then
   * match only through an exact turn id.
   */
  sessionSummaries?: readonly TurnSummaryEvent[];
}

/**
 * Finalize a turn exclusively from its atomic llm.call ledger. Calls are
 * deduplicated before summing, so OTLP retries cannot inflate usage.
 */
export function aggregateTurnUsage(
  summary: TurnSummaryEvent,
  calls: readonly LlmCallEvent[],
  options: AggregateTurnUsageOptions = {}
): TurnSummaryEvent {
  const unique = new Map<string, LlmCallEvent>();
  for (const call of calls) {
    if (summary.session_id && call.session_id !== summary.session_id) continue;
    if (summary.turn_id && call.turn_id && call.turn_id !== summary.turn_id) continue;
    // Without an exact turn match on both sides (session-only correlation,
    // legacy records) the call joins through the turn's time window; skipping
    // it outright would leave its usage attributed to no turn at all.
    if ((!summary.turn_id || !call.turn_id) && !ownsWindowJoin(summary, call, options.sessionSummaries)) continue;
    const key = `${call.provider}:${call.call_id}`;
    const previous = unique.get(key);
    unique.set(key, previous ? mergeCallObservations(previous, call) : call);
  }

  const accepted = [...unique.values()];
  // No matching ledger rows means the turn is not finalized yet. Preserve
  // pending/provisional usage rather than replacing it with an empty total
  // and incorrectly declaring it complete.
  if (accepted.length === 0) return summary;

  const totals = sumCalls(accepted);
  const groups = new Map<string, LlmCallEvent[]>();
  for (const call of accepted) {
    const key = call.agent_id ? `id:${call.agent_id}` : call.agent_type ? `type:${call.agent_type}` : 'unattributed';
    const group = groups.get(key) ?? [];
    group.push(call);
    groups.set(key, group);
  }

  const agentUsage: AgentUsageSummary[] = [...groups.values()].map((group) => {
    const first = group[0]!;
    return compact({
      agent_id: first.agent_id,
      parent_agent_id: first.parent_agent_id,
      agent_type: first.agent_type,
      llm_calls: group.length,
      ...sumCalls(group)
    });
  });

  // The call ledger is authoritative only once it actually carries usage.
  // Matched calls without any token/cost data (failed requests, token-less
  // telemetry) must not erase provisional transcript totals or stamp a
  // completeness the ledger cannot back. 'complete' additionally requires the
  // caller's explicit terminal signal — a first batch says nothing about
  // whether more are coming.
  const ledgerHasUsage = Object.keys(totals).length > 0;
  const usageStatus: TurnUsageStatus = ledgerHasUsage ? (options.complete === true ? 'complete' : 'partial') : options.complete === false ? 'partial' : summary.usage_status;
  const usageOverride = ledgerHasUsage
    ? {
        // Replace provisional transcript totals wholesale; mixing sources
        // per field would produce sums no single ledger can explain.
        input_tokens: totals.input_tokens,
        cached_input_tokens: totals.cached_input_tokens,
        cache_creation_input_tokens: totals.cache_creation_input_tokens,
        output_tokens: totals.output_tokens,
        reasoning_output_tokens: totals.reasoning_output_tokens,
        total_tokens: totals.total_tokens,
        cost_usd: totals.cost_usd
      }
    : {};
  return compact({
    ...summary,
    ...usageOverride,
    llm_calls: accepted.length,
    agent_usage: agentUsage.length > 0 ? agentUsage : undefined,
    usage_status: usageStatus
  });
}

/**
 * Decide whether `summary` is the turn a window-joined call belongs to.
 *
 * The owner is the containing summary with the latest start — matching the
 * transcript path, which attributes an ambiguous overlap to the newer
 * prompt — and summaries without a lower bound only claim calls no bounded
 * summary contains. Ownership can only be arbitrated across the session's
 * full summary set: a lone summary claiming every call its window contains
 * would double-count overlapping turns, so without `sessionSummaries` the
 * window join is disabled entirely.
 */
function ownsWindowJoin(summary: TurnSummaryEvent, call: LlmCallEvent, sessionSummaries?: readonly TurnSummaryEvent[]): boolean {
  if (!sessionSummaries || sessionSummaries.length === 0) return false;
  const callAt = Date.parse(call.ended_at);
  // A call with an unusable timestamp cannot be placed in any window; it can
  // still reach a summary through an exact turn_id match.
  if (!Number.isFinite(callAt)) return false;

  if (!containsCall(summary, callAt)) return false;
  const pool = sessionSummaries.some((candidate) => candidate.id === summary.id) ? sessionSummaries : [...sessionSummaries, summary];
  // A call carrying a turn id joins its own turn exactly; it must not also
  // be window-claimed by a summary that lacks one.
  if (call.turn_id && pool.some((candidate) => candidate.turn_id === call.turn_id)) return false;
  const owner = pool.filter((candidate) => containsCall(candidate, callAt)).sort(compareOwnership)[0];
  return owner !== undefined && owner.id === summary.id;
}

/** Open lower bound: a summary without started_at contains anything earlier. */
function containsCall(summary: TurnSummaryEvent, callAt: number): boolean {
  const endedAt = Date.parse(summary.ended_at);
  if (!Number.isFinite(endedAt) || callAt > endedAt) return false;
  const startedAt = summary.started_at ? Date.parse(summary.started_at) : NaN;
  return !Number.isFinite(startedAt) || callAt >= startedAt;
}

/** Latest start wins; then the earliest stop; then id for determinism. */
function compareOwnership(a: TurnSummaryEvent, b: TurnSummaryEvent): number {
  const aStart = a.started_at ? Date.parse(a.started_at) : Number.NEGATIVE_INFINITY;
  const bStart = b.started_at ? Date.parse(b.started_at) : Number.NEGATIVE_INFINITY;
  if (aStart !== bStart) return bStart - aStart;
  const aEnd = Date.parse(a.ended_at);
  const bEnd = Date.parse(b.ended_at);
  if (aEnd !== bEnd) return aEnd - bEnd;
  return a.id.localeCompare(b.id);
}

/** A request may appear in both an API-request log and a completion log. */
function mergeCallObservations(first: LlmCallEvent, latest: LlmCallEvent): LlmCallEvent {
  return compact({
    ...first,
    ...latest,
    event: { ...first.event, ...latest.event },
    agent: { ...first.agent, ...latest.agent },
    session: { ...first.session, ...latest.session },
    git: first.git || latest.git ? { ...first.git, ...latest.git } : undefined,
    feature: first.feature || latest.feature ? { ...first.feature, ...latest.feature } : undefined
  });
}

function sumCalls(calls: readonly LlmCallEvent[]): Omit<AgentUsageSummary, 'agent_id' | 'parent_agent_id' | 'agent_type' | 'llm_calls'> {
  return compact({
    input_tokens: sumPresent(calls.map((call) => call.input_tokens)),
    cached_input_tokens: sumPresent(calls.map((call) => call.cached_input_tokens)),
    cache_creation_input_tokens: sumPresent(calls.map((call) => call.cache_creation_input_tokens)),
    output_tokens: sumPresent(calls.map((call) => call.output_tokens)),
    reasoning_output_tokens: sumPresent(calls.map((call) => call.reasoning_output_tokens)),
    total_tokens: sumPresent(calls.map((call) => call.total_tokens)),
    cost_usd: sumPresent(calls.map((call) => call.cost_usd))
  });
}

function sumPresent(values: (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
