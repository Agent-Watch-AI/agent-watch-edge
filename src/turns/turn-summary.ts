import { compact } from '../core/object.js';
import { deriveEventId, sha256Hex } from '../events/event-id.js';
import { EVENT_SCHEMA_VERSION } from '../events/constants/events.constants.js';
import type { FeatureCandidate } from '../events/types/events.types.js';
import { contentEvidence } from '../providers/shared/tooling.js';
import { MAX_TURN_FILES, PROMPT_JOIN_SEPARATOR, PROVIDER_LABELS, UNKNOWN_TOOL_NAME } from './constants/turns.constants.js';
import type { PromptRecord, ToolRecord } from './types/turn-state.types.js';
import type { BuildTurnSummaryInput, TouchedFiles, TurnSummaryEvent } from './types/turn-summary.types.js';

export type {
  AgentUsageSummary,
  BuildTurnSummaryInput,
  TouchedFiles,
  TurnResponse,
  TurnSummaryEvent,
  TurnUsageStatus
} from './types/turn-summary.types.js';

/**
 * Flatten one turn's accumulated state into the single product record the hook
 * path emits.
 *
 * Everything here is derived from the input: the same prompts, tools and usage
 * always produce the same summary, including its id. That is what makes a
 * duplicate Stop harmless.
 *
 * @param input - The turn's accumulated state.
 * @returns The summary, with absent fields omitted rather than null.
 */
export function buildTurnSummary(input: BuildTurnSummaryInput): TurnSummaryEvent {
  const files = collectToolUsage(input.tools);
  const promptText = joinPrompts(input.prompts);
  const startedAt = input.prompts[0]?.at;
  const turnId = input.turnId ?? input.prompts.find((prompt) => prompt.turnId)?.turnId;
  const jiraIds = ticketValues(input.featureCandidates);
  const provider = PROVIDER_LABELS[input.provider] ?? input.provider;

  return compact({
    schemaVersion: EVENT_SCHEMA_VERSION,
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
    files_touched: files.filesTouched.length > 0 ? files.filesTouched : undefined,
    files_read: files.filesRead.length > 0 ? files.filesRead : undefined,
    prompt: promptText,
    prompt_evidence: input.prompts[0]?.evidence,
    response: input.response?.text,
    response_evidence: input.response?.evidence,
    tool_calls: input.tools.length,
    tools_used: files.toolsUsed,
    model: input.usage?.model ?? input.model,
    // 'unknown' is the absence of a verdict, not a billing mode.
    billing_mode: input.billingMode && input.billingMode !== 'unknown' ? input.billingMode : undefined,
    input_tokens: input.usage?.inputTokens,
    cached_input_tokens: input.usage?.cachedInputTokens,
    cache_creation_input_tokens: input.usage?.cacheCreationInputTokens,
    output_tokens: input.usage?.outputTokens,
    usage_status: input.usage ? 'provisional' : 'pending',
    started_at: startedAt,
    ended_at: input.endedAt
  });
}

/**
 * Recompute content evidence from the text that is actually transmitted.
 *
 * Evidence is captured before sanitization, but the sanitizer truncates and
 * redacts; a backend verifying length or hash against the received text would
 * then reject honest events. When the text is absent (capture disabled), the
 * capture-time evidence still describes the content the developer saw, and is
 * kept as the only description there is.
 *
 * @param summary - Summary about to be sent.
 * @returns A copy whose evidence matches its own text.
 */
export function alignContentEvidence(summary: TurnSummaryEvent): TurnSummaryEvent {
  return {
    ...summary,
    prompt_evidence: typeof summary.prompt === 'string' ? contentEvidence(summary.prompt) : summary.prompt_evidence,
    response_evidence: typeof summary.response === 'string' ? contentEvidence(summary.response) : summary.response_evidence
  };
}

/**
 * Tool call counts and the files the turn read versus modified.
 *
 * One pass over the records: tool counting and both file lists come from the
 * same iteration rather than three filter/map chains (STYLEGUIDE 3.3). Each
 * list stops growing at {@link MAX_TURN_FILES}, which is what keeps a
 * file-heavy turn a summary with a truncated list rather than a summary the
 * backend refuses whole.
 *
 * @param tools - The turn's tool records.
 * @returns Per-tool counts and the two file lists.
 */
function collectToolUsage(tools: readonly ToolRecord[]): TouchedFiles {
  const toolsUsed: Record<string, number> = {};
  const filesTouched = new Set<string>();
  const filesRead = new Set<string>();

  for (const tool of tools) {
    const name = tool.tool ?? UNKNOWN_TOOL_NAME;

    toolsUsed[name] = (toolsUsed[name] ?? 0) + 1;

    if (!tool.filePath) continue;

    // files_touched is documented as files the agent MODIFIED; pure reads get
    // their own list. Legacy records without an access marker stay in
    // files_touched (the historical behavior) rather than being dropped.
    if (tool.access === 'read') {
      addCapped(filesRead, tool.filePath);
      continue;
    }

    addCapped(filesTouched, tool.filePath);
  }

  return { toolsUsed, filesTouched: [...filesTouched], filesRead: [...filesRead] };
}

/**
 * Record a path while the list still has room for one.
 *
 * A path already in the set is not a new entry, so it is re-added rather than
 * counted against the cap.
 *
 * @param paths - The list being built.
 * @param filePath - Path this tool call named.
 */
function addCapped(paths: Set<string>, filePath: string): void {
  if (paths.size >= MAX_TURN_FILES && !paths.has(filePath)) return;

  paths.add(filePath);
}

/**
 * The turn's prompt text, joining several submissions into one.
 *
 * @param prompts - The turn's prompt records.
 * @returns The joined text, or undefined when none was captured.
 */
function joinPrompts(prompts: readonly PromptRecord[]): string | undefined {
  const present: string[] = [];

  for (const prompt of prompts) {
    if (typeof prompt.text === 'string' && prompt.text.length > 0) present.push(prompt.text);
  }

  if (present.length === 0) return undefined;

  return present.join(PROMPT_JOIN_SEPARATOR);
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
