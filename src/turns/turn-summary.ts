import type { AgentWatchEvent, FeatureCandidate, UsageBillingMode } from '../events/canonical-event.js';
import { deriveEventId, sha256Hex } from '../events/event-id.js';
import type { ContentEvidence, TurnRecord } from './turn-state.js';
import type { TurnUsage } from './claude-transcript.js';

/**
 * One prompt→response turn, flattened for direct backend consumption:
 * who (developer), where (repo/branch/commit/ticket), what (prompt, response,
 * tools, files) and provisional usage. It is the only hook-path product
 * record; the backend finalizes it from atomic llm.call rows.
 */
export interface AgentUsageSummary {
  agent_id?: string;
  parent_agent_id?: string;
  agent_type?: string;
  llm_calls: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
}

export type TurnUsageStatus = 'pending' | 'provisional' | 'complete' | 'partial';

export interface TurnSummaryEvent extends AgentWatchEvent<'turn.summary'> {
  provider: string;
  surface: string;
  session_id?: string;
  turn_id?: string;
  developer_id?: string;
  repository?: string;
  branch?: string;
  commit?: string;
  jira_ids?: string[];
  /** Working-tree changes reported by git at the end of the turn. */
  files_changed?: string[];
  /** Files edited by the agent's tools during this turn (repo-relative). */
  files_touched?: string[];
  /** Files the agent's tools only read during this turn (repo-relative). */
  files_read?: string[];
  prompt?: string;
  prompt_evidence?: ContentEvidence;
  response?: string;
  response_evidence?: ContentEvidence;
  tool_calls: number;
  tools_used: Record<string, number>;
  model?: string;
  /** subscription (flat plan) vs api (per-token billing); see billing-mode.ts. */
  billing_mode?: UsageBillingMode;
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  /** Filled by the backend from unique llm.call records. */
  llm_calls?: number;
  /** Main-agent and child-agent usage, derived from the same call ledger. */
  agent_usage?: AgentUsageSummary[];
  /** Hook summaries start pending/provisional; only backend aggregation is complete. */
  usage_status: TurnUsageStatus;
  started_at?: string;
  ended_at: string;
}

export interface BuildTurnSummaryInput {
  /** Internal provider id ('claude' | 'codex'); mapped to the public label. */
  provider: string;
  surface: string;
  sessionId?: string;
  turnId?: string;
  developerId?: string;
  installationId?: string;
  git?: AgentWatchEvent['git'];
  featureCandidates?: FeatureCandidate[];
  prompts: Extract<TurnRecord, { kind: 'prompt' }>[];
  tools: Extract<TurnRecord, { kind: 'tool' }>[];
  response?: { text?: string; evidence?: ContentEvidence };
  usage?: TurnUsage;
  model?: string;
  billingMode?: UsageBillingMode;
  endedAt: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  cursor: 'cursor'
};

export function buildTurnSummary(input: BuildTurnSummaryInput): TurnSummaryEvent {
  const toolsUsed: Record<string, number> = {};
  const filesTouched = new Set<string>();
  const filesRead = new Set<string>();
  for (const tool of input.tools) {
    const name = tool.tool ?? 'unknown';
    toolsUsed[name] = (toolsUsed[name] ?? 0) + 1;
    if (!tool.filePath) continue;
    // files_touched is documented as files the agent MODIFIED; pure reads get
    // their own list. Legacy records without an access marker stay in
    // files_touched (the historical behavior) rather than being dropped.
    if (tool.access === 'read') filesRead.add(tool.filePath);
    else filesTouched.add(tool.filePath);
  }

  const promptText = joinDefined(input.prompts.map((prompt) => prompt.text));
  const startedAt = input.prompts[0]?.at;
  const turnId = input.turnId ?? input.prompts.find((prompt) => prompt.turnId)?.turnId;
  const jiraIds = (input.featureCandidates ?? []).filter((candidate) => candidate.type === 'ticket').map((candidate) => candidate.value);
  const provider = PROVIDER_LABELS[input.provider] ?? input.provider;

  const summary: TurnSummaryEvent = {
    schemaVersion: '1',
    id: deriveEventId({
      provider: input.provider,
      providerEventType: 'turn.summary',
      sessionId: input.sessionId,
      turnId,
      timestamp: input.endedAt,
      payloadFingerprint: sha256Hex(JSON.stringify([startedAt, input.prompts.length, input.tools.length]))
    }),
    timestamp: input.endedAt,
    event: { type: 'turn.summary', providerEventType: 'turn.summary' },
    agent: { provider, name: provider },
    session: { id: input.sessionId, providerId: input.sessionId, turnId },
    developer: input.installationId ? { installationId: input.installationId } : undefined,

    provider,
    surface: input.surface,
    session_id: input.sessionId,
    turn_id: turnId,
    developer_id: input.developerId,
    repository: input.git?.repository,
    branch: input.git?.branch,
    commit: input.git?.commit,
    jira_ids: jiraIds.length > 0 ? jiraIds : undefined,
    files_changed: input.git?.changedFiles,
    files_touched: filesTouched.size > 0 ? [...filesTouched] : undefined,
    files_read: filesRead.size > 0 ? [...filesRead] : undefined,
    prompt: promptText,
    prompt_evidence: input.prompts[0]?.evidence,
    response: input.response?.text,
    response_evidence: input.response?.evidence,
    tool_calls: input.tools.length,
    tools_used: toolsUsed,
    model: input.usage?.model ?? input.model,
    billing_mode: input.billingMode && input.billingMode !== 'unknown' ? input.billingMode : undefined,
    input_tokens: input.usage?.inputTokens,
    cached_input_tokens: input.usage?.cachedInputTokens,
    cache_creation_input_tokens: input.usage?.cacheCreationInputTokens,
    output_tokens: input.usage?.outputTokens,
    usage_status: input.usage ? 'provisional' : 'pending',
    started_at: startedAt,
    ended_at: input.endedAt
  };
  return compact(summary);
}

function joinDefined(texts: (string | undefined)[]): string | undefined {
  const present = texts.filter((text): text is string => typeof text === 'string' && text.length > 0);
  if (present.length === 0) return undefined;
  return present.join('\n---\n');
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
