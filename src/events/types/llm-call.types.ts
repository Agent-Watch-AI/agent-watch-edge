import type { AgentWatchEvent, EventGit, FeatureCandidate, UsageBillingMode } from './events.types.js';

export type LlmCallStatus = 'completed' | 'failed';

/**
 * How confidently a call was joined to a product turn: by an exact turn id,
 * through the turn's time window, or only by session.
 */
export type LlmCallCorrelation = 'exact' | 'turn' | 'session';

/**
 * One provider request that can consume tokens. This is the atomic usage
 * ledger record: retries are separate calls when the provider reports them
 * separately, and turn/feature totals must be derived from unique call ids.
 */
export interface LlmCallEvent extends AgentWatchEvent<'llm.call'> {
  readonly provider: string;
  readonly surface: string;
  readonly call_id: string;
  readonly provider_request_id?: string;
  /** Native scope before a child-agent trace is joined to its root turn. */
  readonly provider_session_id?: string;
  readonly provider_turn_id?: string;
  readonly session_id?: string;
  readonly turn_id?: string;
  /** Concrete child-agent instance when the provider exposes it. */
  readonly agent_id?: string;
  readonly parent_agent_id?: string;
  /** Provider role/name such as Explore, reviewer, or repl_main_thread. */
  readonly agent_type?: string;
  readonly model?: string;
  readonly billing_mode?: UsageBillingMode;
  readonly status: LlmCallStatus;
  readonly correlation: LlmCallCorrelation;
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly total_tokens?: number;
  readonly cost_usd?: number;
  readonly duration_ms?: number;
  readonly started_at?: string;
  readonly ended_at: string;
  readonly repository?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly jira_ids?: readonly string[];
}

/** Token counts as the caller measured them, before name flattening. */
export interface LlmCallUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
}

export interface BuildLlmCallInput {
  readonly provider: string;
  readonly surface: string;
  readonly callId: string;
  readonly providerRequestId?: string;
  readonly providerSessionId?: string;
  readonly providerTurnId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly agentType?: string;
  readonly model?: string;
  readonly billingMode?: UsageBillingMode;
  readonly status?: LlmCallStatus;
  readonly correlation: LlmCallCorrelation;
  readonly usage?: LlmCallUsage;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly startedAt?: string;
  readonly endedAt: string;
  readonly git?: EventGit;
  readonly featureCandidates?: readonly FeatureCandidate[];
}
