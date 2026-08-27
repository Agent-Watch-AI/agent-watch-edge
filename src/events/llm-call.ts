import { compact } from '../core/object.js';
import { deriveEventId, sha256Hex } from './event-id.js';
import { EVENT_SCHEMA_VERSION } from './constants/events.constants.js';
import type { BuildLlmCallInput, LlmCallEvent } from './types/llm-call.types.js';
import type { FeatureCandidate } from './types/events.types.js';

export type { BuildLlmCallInput, LlmCallCorrelation, LlmCallEvent, LlmCallStatus, LlmCallUsage } from './types/llm-call.types.js';

/**
 * Build the atomic usage record for one provider request.
 *
 * Called by whoever decodes agent telemetry — the edge's own OTLP
 * normalizer, or a backend using `@agentwatch-ai/edge/llm-call` directly.
 * Both the flat `*_tokens` fields and the nested canonical `session` block are
 * populated from the same input, so a consumer can read whichever it models.
 *
 * @param input - Everything known about the call.
 * @returns The llm.call event, with absent fields omitted rather than null.
 */
export function buildLlmCall(input: BuildLlmCallInput): LlmCallEvent {
  const jiraIds = ticketValues(input.featureCandidates);
  const providerRequestId = input.providerRequestId ?? input.callId;

  return compact({
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: deriveEventId({
      provider: input.provider,
      providerEventType: 'llm.call',
      sessionId: input.sessionId,
      turnId: input.turnId,
      payloadFingerprint: sha256Hex(providerRequestId)
    }),
    timestamp: input.endedAt,
    event: { type: 'llm.call', providerEventType: 'llm.call' },
    agent: { provider: input.provider, name: input.provider },
    session: {
      id: input.sessionId,
      providerId: input.sessionId,
      turnId: input.turnId,
      generationId: input.callId,
      agentId: input.agentId
    },
    provider: input.provider,
    surface: input.surface,
    call_id: input.callId,
    provider_request_id: input.providerRequestId,
    provider_session_id: input.providerSessionId,
    provider_turn_id: input.providerTurnId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    agent_id: input.agentId,
    parent_agent_id: input.parentAgentId,
    agent_type: input.agentType,
    model: input.model,
    // 'unknown' is the absence of a verdict, not a billing mode; emitting it
    // would make the field look answered.
    billing_mode: input.billingMode && input.billingMode !== 'unknown' ? input.billingMode : undefined,
    status: input.status ?? 'completed',
    correlation: input.correlation,
    input_tokens: input.usage?.inputTokens,
    cached_input_tokens: input.usage?.cachedInputTokens,
    cache_creation_input_tokens: input.usage?.cacheCreationInputTokens,
    output_tokens: input.usage?.outputTokens,
    reasoning_output_tokens: input.usage?.reasoningOutputTokens,
    total_tokens: input.usage?.totalTokens,
    cost_usd: input.costUsd,
    duration_ms: input.durationMs,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    repository: input.git?.repository,
    branch: input.git?.branch,
    commit: input.git?.commit,
    jira_ids: jiraIds.length > 0 ? jiraIds : undefined
  });
}

/**
 * Ticket keys out of mixed feature evidence.
 *
 * @param candidates - Evidence collected during enrichment.
 * @returns The ticket values, in order.
 */
function ticketValues(candidates: readonly FeatureCandidate[] | undefined): string[] {
  const tickets: string[] = [];

  for (const candidate of candidates ?? []) {
    if (candidate.type !== 'ticket') continue;

    tickets.push(candidate.value);
  }

  return tickets;
}
