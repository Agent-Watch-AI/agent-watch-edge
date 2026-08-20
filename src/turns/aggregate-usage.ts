import { compact } from '../core/object.js';
import { sumPresent } from '../core/number.js';
import type { LlmCallEvent } from '../events/types/llm-call.types.js';
import type { AggregateTurnUsageOptions, UsageTotals } from './types/aggregate-usage.types.js';
import type { AgentUsageSummary, TurnSummaryEvent, TurnUsageStatus } from './types/turn-summary.types.js';

export type { AggregateTurnUsageOptions, UsageTotals } from './types/aggregate-usage.types.js';

/**
 * Finalize a turn exclusively from its atomic llm.call ledger.
 *
 * Three rules make the result trustworthy. Calls are deduplicated by
 * (provider, call_id) before summing, so OTLP retries cannot inflate usage. A
 * call is attributed to exactly one turn — by turn id, or by the arbitrated
 * window join — so overlapping turns cannot double-count. And a ledger that
 * matched calls but carries no usage never overwrites provisional transcript
 * totals or claims a completeness it cannot back.
 *
 * @param summary - The turn summary to finalize.
 * @param calls - Ledger rows to consider; may span the whole session.
 * @param options - Terminal signal and the session's other summaries.
 * @returns The finalized summary, or the original when no rows matched.
 */
export function aggregateTurnUsage(
  summary: TurnSummaryEvent,
  calls: readonly LlmCallEvent[],
  options: AggregateTurnUsageOptions = {}
): TurnSummaryEvent {
  const accepted = acceptCalls(summary, calls, options);

  // No matching ledger rows means the turn is not finalized yet. Preserve
  // pending/provisional usage rather than replacing it with an empty total and
  // incorrectly declaring it complete.
  if (accepted.length === 0) return summary;

  const totals = sumCalls(accepted);
  const ledgerHasUsage = reportsAnyUsage(totals);

  return compact({
    ...summary,
    // Spread whether or not each field is present: the ledger replaces
    // provisional transcript totals wholesale, so a class the ledger does not
    // report has to be *removed*, not left at its transcript value.
    ...(ledgerHasUsage ? totals : {}),
    llm_calls: accepted.length,
    agent_usage: perAgentUsage(accepted),
    usage_status: resolveUsageStatus(summary.usage_status, ledgerHasUsage, options.complete)
  });
}

/**
 * The ledger rows that belong to this turn, deduplicated.
 *
 * @param summary - The turn being finalized.
 * @param calls - Candidate rows.
 * @param options - Session context for the window join.
 * @returns One row per unique call.
 */
function acceptCalls(summary: TurnSummaryEvent, calls: readonly LlmCallEvent[], options: AggregateTurnUsageOptions): LlmCallEvent[] {
  const unique = new Map<string, LlmCallEvent>();

  for (const call of calls) {
    if (!belongsToTurn(summary, call, options)) continue;

    const key = `${call.provider}:${call.call_id}`;
    const previous = unique.get(key);

    unique.set(key, previous ? mergeCallObservations(previous, call) : call);
  }

  return [...unique.values()];
}

/**
 * Whether one ledger row is this turn's.
 *
 * @param summary - The turn being finalized.
 * @param call - Candidate row.
 * @param options - Session context for the window join.
 * @returns True when the row belongs to this turn.
 */
function belongsToTurn(summary: TurnSummaryEvent, call: LlmCallEvent, options: AggregateTurnUsageOptions): boolean {
  if (summary.session_id && call.session_id !== summary.session_id) return false;

  if (summary.turn_id && call.turn_id && call.turn_id !== summary.turn_id) return false;

  // Both sides carry the same turn id: an exact match, nothing to arbitrate.
  if (summary.turn_id && call.turn_id) return true;

  // Without an exact turn match on both sides (session-only correlation,
  // legacy records) the call joins through the turn's time window; skipping it
  // outright would leave its usage attributed to no turn at all.
  return ownsWindowJoin(summary, call, options.sessionSummaries);
}

/**
 * Decide whether `summary` is the turn a window-joined call belongs to.
 *
 * The owner is the containing summary with the latest start — matching the
 * transcript path, which attributes an ambiguous overlap to the newer prompt —
 * and summaries without a lower bound only claim calls no bounded summary
 * contains. Ownership can only be arbitrated across the session's full summary
 * set: a lone summary claiming every call its window contains would
 * double-count overlapping turns, so without `sessionSummaries` the window
 * join is disabled entirely.
 *
 * @param summary - The turn being finalized.
 * @param call - Candidate row.
 * @param sessionSummaries - Every summary of the session.
 * @returns True when this summary owns the call.
 */
function ownsWindowJoin(summary: TurnSummaryEvent, call: LlmCallEvent, sessionSummaries?: readonly TurnSummaryEvent[]): boolean {
  if (!sessionSummaries || sessionSummaries.length === 0) return false;

  const callAt = Date.parse(call.ended_at);

  // A call with an unusable timestamp cannot be placed in any window; it can
  // still reach a summary through an exact turn_id match.
  if (!Number.isFinite(callAt)) return false;

  if (!containsCall(summary, callAt)) return false;

  const pool = sessionSummaries.some((candidate) => candidate.id === summary.id) ? sessionSummaries : [...sessionSummaries, summary];

  // A call carrying a turn id joins its own turn exactly; it must not also be
  // window-claimed by a summary that lacks one.
  if (call.turn_id && pool.some((candidate) => candidate.turn_id === call.turn_id)) return false;

  const owner = pool.filter((candidate) => containsCall(candidate, callAt)).sort(compareOwnership)[0];

  return owner !== undefined && owner.id === summary.id;
}

/**
 * Whether a call's timestamp falls inside a summary's window.
 *
 * Open lower bound: a summary without started_at contains anything earlier.
 *
 * @param summary - Candidate owner.
 * @param callAt - Call timestamp, epoch ms.
 * @returns True when the window contains it.
 */
function containsCall(summary: TurnSummaryEvent, callAt: number): boolean {
  const endedAt = Date.parse(summary.ended_at);

  if (!Number.isFinite(endedAt) || callAt > endedAt) return false;

  const startedAt = summary.started_at ? Date.parse(summary.started_at) : NaN;

  return !Number.isFinite(startedAt) || callAt >= startedAt;
}

/**
 * Ordering that puts the best owner of an ambiguous call first.
 *
 * Latest start wins; then the earliest stop; then id, so the outcome is
 * deterministic whatever order the summaries arrived in.
 *
 * @param a - One summary.
 * @param b - The other.
 * @returns Standard comparator result.
 */
function compareOwnership(a: TurnSummaryEvent, b: TurnSummaryEvent): number {
  const aStart = a.started_at ? Date.parse(a.started_at) : Number.NEGATIVE_INFINITY;
  const bStart = b.started_at ? Date.parse(b.started_at) : Number.NEGATIVE_INFINITY;

  if (aStart !== bStart) return bStart - aStart;

  const aEnd = Date.parse(a.ended_at);
  const bEnd = Date.parse(b.ended_at);

  if (aEnd !== bEnd) return aEnd - bEnd;

  return a.id.localeCompare(b.id);
}

/**
 * Combine two observations of one request.
 *
 * A request may appear in both an API-request log and a completion log, each
 * carrying part of the picture.
 *
 * @param first - Earlier observation.
 * @param latest - Later observation, which wins per field.
 * @returns The merged row.
 */
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

/**
 * Usage broken down per agent that took part in the turn.
 *
 * @param calls - Accepted ledger rows.
 * @returns One entry per agent, or undefined when there is nothing to report.
 */
function perAgentUsage(calls: readonly LlmCallEvent[]): AgentUsageSummary[] | undefined {
  const groups = new Map<string, LlmCallEvent[]>();

  for (const call of calls) {
    const key = agentKey(call);
    const group = groups.get(key);

    if (group) {
      group.push(call);
      continue;
    }

    groups.set(key, [call]);
  }

  const usage: AgentUsageSummary[] = [];

  for (const group of groups.values()) {
    const first = group[0]!;

    usage.push(
      compact({
        agent_id: first.agent_id,
        parent_agent_id: first.parent_agent_id,
        agent_type: first.agent_type,
        llm_calls: group.length,
        ...sumCalls(group)
      })
    );
  }

  return usage.length > 0 ? usage : undefined;
}

/**
 * Grouping key for per-agent usage: a concrete instance when the provider gave
 * one, else its role, else the unattributed bucket.
 *
 * @param call - Ledger row.
 * @returns The group key.
 */
function agentKey(call: LlmCallEvent): string {
  if (call.agent_id) return `id:${call.agent_id}`;

  if (call.agent_type) return `type:${call.agent_type}`;

  return 'unattributed';
}

/**
 * How settled the turn's usage is after this aggregation.
 *
 * 'complete' requires the caller's explicit terminal signal: a first batch
 * says nothing about whether more are coming.
 *
 * @param current - Status the summary arrived with.
 * @param ledgerHasUsage - Whether the matched rows carried any usage.
 * @param complete - The caller's terminal signal, when it has one.
 * @returns The status to stamp.
 */
function resolveUsageStatus(current: TurnUsageStatus, ledgerHasUsage: boolean, complete: boolean | undefined): TurnUsageStatus {
  if (ledgerHasUsage) return complete === true ? 'complete' : 'partial';

  if (complete === false) return 'partial';

  return current;
}

/**
 * Token and cost totals across a set of calls.
 *
 * Every field is present, undefined when no call reported that class: callers
 * spread this over a summary to replace its usage wholesale, and a missing key
 * would silently leave a stale transcript value in place.
 *
 * @param calls - Ledger rows to sum.
 * @returns The totals, one entry per token class.
 */
function sumCalls(calls: readonly LlmCallEvent[]): UsageTotals {
  return {
    input_tokens: sumPresent(calls.map((call) => call.input_tokens)),
    cached_input_tokens: sumPresent(calls.map((call) => call.cached_input_tokens)),
    cache_creation_input_tokens: sumPresent(calls.map((call) => call.cache_creation_input_tokens)),
    output_tokens: sumPresent(calls.map((call) => call.output_tokens)),
    reasoning_output_tokens: sumPresent(calls.map((call) => call.reasoning_output_tokens)),
    total_tokens: sumPresent(calls.map((call) => call.total_tokens)),
    cost_usd: sumPresent(calls.map((call) => call.cost_usd))
  };
}

/**
 * Whether the ledger actually carried usage.
 *
 * Matched calls without any token or cost data (failed requests, token-less
 * telemetry) must not erase provisional transcript totals or stamp a
 * completeness the ledger cannot back.
 *
 * @param totals - Summed totals.
 * @returns True when at least one class was reported.
 */
function reportsAnyUsage(totals: UsageTotals): boolean {
  for (const value of Object.values(totals)) {
    if (value !== undefined) return true;
  }

  return false;
}
