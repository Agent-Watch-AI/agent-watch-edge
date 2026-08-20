import type { AgentWatchEvent, ContentEvidence, EventGit, FeatureCandidate, UsageBillingMode } from '../../events/types/events.types.js';
import type { PromptRecord, ToolRecord } from './turn-state.types.js';
import type { TurnUsage } from './transcript.types.js';

/**
 * Usage attributed to one agent inside a turn — the main agent, or one of the
 * child agents it spawned — derived from the same call ledger as the totals.
 */
export interface AgentUsageSummary {
  readonly agent_id?: string;
  readonly parent_agent_id?: string;
  readonly agent_type?: string;
  readonly llm_calls: number;
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly total_tokens?: number;
  readonly cost_usd?: number;
}

/**
 * How much of the turn's usage is settled.
 *
 * `pending` — nothing yet. `provisional` — read from the agent's transcript,
 * good enough to show. `partial` — the llm.call ledger has spoken but more
 * batches may still arrive. `complete` — the backend has decided none can.
 */
export type TurnUsageStatus = 'pending' | 'provisional' | 'complete' | 'partial';

/**
 * One prompt→response turn, flattened for direct backend consumption: who
 * (developer), where (repo/branch/commit/ticket), what (prompt, response,
 * tools, files) and how much it cost.
 *
 * The only product record the hook path emits; the backend finalizes its usage
 * from the atomic llm.call rows.
 */
export interface TurnSummaryEvent extends AgentWatchEvent<'turn.summary'> {
  readonly provider: string;
  readonly surface: string;
  readonly session_id?: string;
  readonly turn_id?: string;
  readonly developer_id?: string;
  readonly repository?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly jira_ids?: readonly string[];
  /** Working-tree changes reported by git at the end of the turn. */
  readonly files_changed?: readonly string[];
  /** Files edited by the agent's tools during this turn (repo-relative). */
  readonly files_touched?: readonly string[];
  /** Files the agent's tools only read during this turn (repo-relative). */
  readonly files_read?: readonly string[];
  readonly prompt?: string;
  readonly prompt_evidence?: ContentEvidence;
  readonly response?: string;
  readonly response_evidence?: ContentEvidence;
  readonly tool_calls: number;
  readonly tools_used: Readonly<Record<string, number>>;
  readonly model?: string;
  /** subscription (flat plan) vs api (per-token billing); see billing-mode.ts. */
  readonly billing_mode?: UsageBillingMode;
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly total_tokens?: number;
  readonly cost_usd?: number;
  /** Filled by the backend from unique llm.call records. */
  readonly llm_calls?: number;
  /** Main-agent and child-agent usage, derived from the same call ledger. */
  readonly agent_usage?: readonly AgentUsageSummary[];
  /** Hook summaries start pending/provisional; only backend aggregation is complete. */
  readonly usage_status: TurnUsageStatus;
  readonly started_at?: string;
  readonly ended_at: string;
}

/** The response the user actually saw, however the provider delivered it. */
export interface TurnResponse {
  readonly text?: string;
  readonly evidence?: ContentEvidence;
}

export interface BuildTurnSummaryInput {
  /** Internal provider id ('claude' | 'codex' | ...); mapped to the public label. */
  readonly provider: string;
  readonly surface: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly developerId?: string;
  readonly installationId?: string;
  readonly git?: EventGit;
  readonly featureCandidates?: readonly FeatureCandidate[];
  readonly prompts: readonly PromptRecord[];
  readonly tools: readonly ToolRecord[];
  readonly response?: TurnResponse;
  readonly usage?: TurnUsage;
  readonly model?: string;
  readonly billingMode?: UsageBillingMode;
  readonly endedAt: string;
}

/** Files the turn's tools read versus modified. */
export interface TouchedFiles {
  readonly toolsUsed: Readonly<Record<string, number>>;
  readonly filesTouched: readonly string[];
  readonly filesRead: readonly string[];
}
