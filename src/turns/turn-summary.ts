import { compact } from '../core/object.js';
import { FAIL_OPEN_REASONS } from '../enforcement/constants/enforcement.constants.js';
import type { FailOpenReason } from '../enforcement/types/enforcement.types.js';
import { deriveEventId, sha256Hex } from '../events/event-id.js';
import { EVENT_SCHEMA_VERSION } from '../events/constants/events.constants.js';
import type { FeatureCandidate } from '../events/types/events.types.js';
import { MAX_TURN_FILES, MAX_TURN_TOOL_INPUTS, PROVIDER_LABELS, UNKNOWN_TOOL_NAME } from './constants/turns.constants.js';
import type { PromptRecord, ToolInputSummary, ToolRecord } from './types/turn-state.types.js';
import type { BuildTurnSummaryInput, TouchedFiles, TurnSummaryEvent } from './types/turn-summary.types.js';

export type {
  AgentUsageSummary,
  BuildTurnSummaryInput,
  TouchedFiles,
  TurnSummaryEvent,
  TurnUsageStatus,
  WorkEvidence
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
    developer_name: input.developerName,
    repository: input.git?.repository,
    branch: input.git?.branch,
    commit: input.git?.commit,
    jira_ids: jiraIds.length > 0 ? jiraIds : undefined,
    files_changed: input.git?.changedFiles,
    work_evidence: input.git?.repository ? input.workEvidence : undefined,
    files_touched: files.filesTouched.length > 0 ? files.filesTouched : undefined,
    files_read: files.filesRead.length > 0 ? files.filesRead : undefined,
    external_files_touched: files.externalTouched.length > 0 ? files.externalTouched : undefined,
    external_files_read: files.externalRead.length > 0 ? files.externalRead : undefined,
    prompt_evidence: input.prompts[0]?.evidence,
    prompt_text: input.prompts[0]?.text,
    tool_inputs: files.toolInputs.length > 0 ? files.toolInputs : undefined,
    response_evidence: input.response,
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
    enforcement_fail_open_reason: failOpenReasonOf(input.prompts, input.endedAt),
    started_at: startedAt,
    ended_at: input.endedAt
  });
}

/**
 * Tool call counts, the files the turn read versus modified, and its tool inputs.
 *
 * One pass over the records: tool counting, the file lists and the inputs come
 * from the same iteration rather than chained filter/maps (STYLEGUIDE 3.3).
 * Each list stops growing at its cap, which is what keeps a file-heavy turn a
 * summary with a truncated list rather than a summary the backend refuses whole.
 *
 * @param tools - The turn's tool records.
 * @returns Per-tool counts, the file lists and the inputs.
 */
function collectToolUsage(tools: readonly ToolRecord[]): TouchedFiles {
  const toolsUsed: Record<string, number> = {};
  const filesTouched = new Set<string>();
  const filesRead = new Set<string>();
  const externalTouched = new Set<string>();
  const externalRead = new Set<string>();
  const toolInputs: ToolInputSummary[] = [];

  for (const tool of tools) {
    const name = tool.tool ?? UNKNOWN_TOOL_NAME;

    toolsUsed[name] = (toolsUsed[name] ?? 0) + 1;

    if (tool.input && toolInputs.length < MAX_TURN_TOOL_INPUTS) toolInputs.push(tool.input);

    // files_touched is documented as files the agent MODIFIED; pure reads get
    // their own list. Legacy records without an access marker stay in
    // files_touched (the historical behavior) rather than being dropped.
    const read = tool.access === 'read';

    if (tool.externalPath) addCapped(read ? externalRead : externalTouched, tool.externalPath);

    if (tool.filePath) addCapped(read ? filesRead : filesTouched, tool.filePath);
  }

  return {
    toolsUsed,
    filesTouched: [...filesTouched],
    filesRead: [...filesRead],
    externalTouched: [...externalTouched],
    externalRead: [...externalRead],
    toolInputs
  };
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
 * Why the turn ran unchecked, if the prompt that opened it did.
 *
 * The newest prompt submitted before this Stop, and only that one. Without a
 * turn id a Stop collects every record the session left: one from a prompt
 * interrupted before its own Stop, and one from the next prompt racing in
 * before this close. Neither prompt's fail-open is a fact about this turn.
 *
 * Read back from a file on disk, so checked against the closed set rather than
 * trusted: an unrecognised value is dropped, not sent. Sending nothing is the
 * contract's word for "no reason known".
 *
 * @param prompts - The turn's prompt records, oldest first.
 * @param endedAt - The Stop's timestamp; ISO strings, compared as the tracker sorts them.
 * @returns The recognised reason, or undefined.
 */
function failOpenReasonOf(prompts: readonly PromptRecord[], endedAt: string): FailOpenReason | undefined {
  // A turn holds a prompt or two, so a reversed copy costs nothing.
  for (const prompt of [...prompts].reverse()) {
    if (prompt.at > endedAt) continue;

    if (prompt.failOpenReason === undefined || !FAIL_OPEN_REASONS.has(prompt.failOpenReason)) return undefined;

    return prompt.failOpenReason;
  }

  return undefined;
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
