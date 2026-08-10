import type { AgentWatchEvent, FeatureCandidate, UsageBillingMode } from './canonical-event.js';
import { deriveEventId, sha256Hex } from './event-id.js';

export type LlmCallStatus = 'completed' | 'failed';
export type LlmCallCorrelation = 'exact' | 'turn' | 'session';

/**
 * One provider request that can consume tokens. This is the atomic usage
 * ledger record: retries are separate calls when the provider reports them
 * separately, and turn/feature totals must be derived from unique call ids.
 */
export interface LlmCallEvent extends AgentWatchEvent<'llm.call'> {
  provider: string;
  surface: string;
  call_id: string;
  provider_request_id?: string;
  /** Native scope before a child-agent trace is joined to its root turn. */
  provider_session_id?: string;
  provider_turn_id?: string;
  session_id?: string;
  turn_id?: string;
  /** Concrete child-agent instance when the provider exposes it. */
  agent_id?: string;
  parent_agent_id?: string;
  /** Provider role/name such as Explore, reviewer, or repl_main_thread. */
  agent_type?: string;
  model?: string;
  billing_mode?: UsageBillingMode;
  status: LlmCallStatus;
  correlation: LlmCallCorrelation;
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  duration_ms?: number;
  started_at?: string;
  ended_at: string;
  repository?: string;
  branch?: string;
  commit?: string;
  jira_ids?: string[];
}

export interface BuildLlmCallInput {
  provider: string;
  surface: string;
  callId: string;
  providerRequestId?: string;
  providerSessionId?: string;
  providerTurnId?: string;
  sessionId?: string;
  turnId?: string;
  agentId?: string;
  parentAgentId?: string;
  agentType?: string;
  model?: string;
  billingMode?: UsageBillingMode;
  status?: LlmCallStatus;
  correlation: LlmCallCorrelation;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    totalTokens?: number;
  };
  costUsd?: number;
  durationMs?: number;
  startedAt?: string;
  endedAt: string;
  git?: AgentWatchEvent['git'];
  featureCandidates?: FeatureCandidate[];
}

/** Build the normalized record after a backend OTLP consumer decodes it. */
export function buildLlmCall(input: BuildLlmCallInput): LlmCallEvent {
  const jiraIds = (input.featureCandidates ?? []).filter((candidate) => candidate.type === 'ticket').map((candidate) => candidate.value);
  const providerRequestId = input.providerRequestId ?? input.callId;
  return compact({
    schemaVersion: '1',
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

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
