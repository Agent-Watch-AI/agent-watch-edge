import { pollUntil } from '../core/async.js';
import { debugLog } from '../core/logger.js';
import { asRecord } from '../core/object.js';
import { detectBillingMode } from '../billing/billing-mode.js';
import type { AgentWatchEvent, ContentEvidence, UsageBillingMode } from '../events/types/events.types.js';
import { sha256Hex } from '../events/event-id.js';
import { developerIdentity } from '../git/git-context.js';
import { sanitizeValue } from '../privacy/sanitizer.js';
import { acquireLock } from '../storage/lock.js';
import type { ReleaseLock } from '../storage/types/storage.types.js';
import type { Env } from '../core/types/core.types.js';
import { readTurnUsage } from './claude-transcript.js';
import { readCursorTurnUsage } from './cursor-transcript.js';
import {
  CLAUDE_ENTRYPOINT_VAR,
  DEFAULT_SURFACE,
  FILE_PATH_KEY,
  IDE_SURFACE,
  IDE_SURFACE_PROVIDERS,
  LOCK_KEY_HASH_LENGTH,
  PROMPT_EVIDENCE_KEY,
  PROMPT_TEXT_KEY,
  RESPONSE_EVIDENCE_KEY,
  RESPONSE_TEXT_KEY,
  TOOL_COMPLETION_TYPES,
  TRANSCRIPT_PATH_KEY,
  TURN_STATE_TTL_MS,
  USAGE_LOCK_POLL_MS,
  USAGE_LOCK_WAIT_MS,
  USAGE_RETRY
} from './constants/turns.constants.js';
import { TurnStateStore } from './turn-state.js';
import { alignContentEvidence, buildTurnSummary } from './turn-summary.js';
import type { PromptRecord, ResponseRecord, ToolRecord, TurnRecord, TurnStateEntry } from './types/turn-state.types.js';
import type { TranscriptReader, TurnUsage } from './types/transcript.types.js';
import type { TurnResponse, TurnSummaryEvent } from './types/turn-summary.types.js';
import type { TrackTurnOptions, TurnWindow } from './types/turn-tracker.types.js';

export type { TrackTurnOptions } from './types/turn-tracker.types.js';

/**
 * Providers whose transcript can be read for token usage.
 *
 * Claude windows by message timestamps; Cursor rows carry none, so its reader
 * relies solely on the exactly-once message-id ledger (today Cursor rows also
 * carry no usage — the reader returns undefined and the summary stays pending).
 */
const TRANSCRIPT_READERS: Readonly<Record<string, TranscriptReader>> = {
  claude: (transcriptPath, startedAt, untilIso, excludeMessageIds) => readTurnUsage(transcriptPath, startedAt, USAGE_RETRY, untilIso, excludeMessageIds),
  cursor: (transcriptPath, _startedAt, _untilIso, excludeMessageIds) => readCursorTurnUsage(transcriptPath, USAGE_RETRY, excludeMessageIds)
};

/**
 * Accumulate turn state across hook invocations and close the turn on
 * `generation.completed`, producing one flat summary.
 *
 * Best-effort by design: hooks run inside the coding agent, so every failure
 * path here ends in "no summary" or a degraded one, never in a thrown error.
 *
 * @param options - The payload's events, config, paths and clock.
 * @returns The turn summary when this payload closed a turn.
 */
export async function trackTurn(options: TrackTurnOptions): Promise<TurnSummaryEvent | undefined> {
  const store = new TurnStateStore(options.turnsDir);
  let summary: TurnSummaryEvent | undefined;

  for (const event of options.events) {
    const sessionId = event.session.id;

    if (!sessionId) continue;

    try {
      summary = (await processEvent(store, sessionId, event, options)) ?? summary;
    } catch (error) {
      debugLog('turn tracking failed:', error);

      // Closing failed (corrupt turn state, unreadable transcript, IO error):
      // the turn must still reach the backend rather than silently vanish.
      if (event.event.type === 'generation.completed' && !summary) {
        summary = fallbackSummary(sessionId, event, options);
      }
    }
  }

  return summary;
}

/**
 * Apply one canonical event to the accumulator.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param event - The event to apply.
 * @param options - Tracking options.
 * @returns A summary when this event closed a turn.
 */
async function processEvent(
  store: TurnStateStore,
  sessionId: string,
  event: AgentWatchEvent,
  options: TrackTurnOptions
): Promise<TurnSummaryEvent | undefined> {
  const type = event.event.type;

  // A dry run previews the close and touches nothing: no appends, no consumed
  // records, no usage claims, no sweep.
  if (options.readOnly) {
    if (type !== 'generation.completed') return undefined;

    return closeTurnLocked(store, sessionId, event, options, true);
  }

  const record = recordFor(event);

  if (record) await store.append(sessionId, recordKeyFor(event), record);

  if (type === 'generation.completed') {
    const summary = await closeTurn(store, sessionId, event, options);

    await store.sweep(TURN_STATE_TTL_MS);

    return summary;
  }

  if (type === 'session.ended') {
    await store.clear(sessionId);
    await store.sweep(TURN_STATE_TTL_MS);
  }

  return undefined;
}

/**
 * The turn record one event should be persisted as, if any.
 *
 * @param event - Canonical event.
 * @returns The record, or undefined when the event carries no turn state.
 */
function recordFor(event: AgentWatchEvent): TurnRecord | undefined {
  const type = event.event.type;

  if (type === 'prompt.submitted') return promptRecord(event);

  if (TOOL_COMPLETION_TYPES.has(type)) return toolRecord(event);

  // Cursor delivers the response text in its own hook (afterAgentResponse)
  // instead of on Stop; keep it as turn state until the turn closes.
  if (type === 'agent.other' && responseFrom(event) !== undefined) return responseRecord(event);

  return undefined;
}

/**
 * Filename an event's record is stored under.
 *
 * Event ids are payload-derived, so on old Claude versions without a prompt id
 * two identical prompts share one id. Without a turn id the record file must
 * therefore be distinct per submission, or the second append overwrites the
 * first and the second turn closes with no state at all. With a turn id the id
 * already separates turns, and collapsing repeats inside one turn is exactly
 * right: Antigravity has no prompt hook, so the prompt is recorded from the
 * execution's first invocation and a re-fired invocation must not append it
 * twice.
 *
 * @param event - Canonical event.
 * @returns The record key.
 */
function recordKeyFor(event: AgentWatchEvent): string {
  if (event.event.type === 'prompt.submitted' && event.session.turnId) return event.id;

  if (event.event.type === 'prompt.submitted' || event.event.type === 'agent.other') {
    return `${event.id}-${event.timestamp}`;
  }

  return event.id;
}

/**
 * Close a turn under a per-turn lock.
 *
 * Claude can fire duplicate Stops, and two unserialized closers would read the
 * same snapshot and emit the summary twice. Keyed by session+turn so different
 * prompts of one session still close independently.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param stopEvent - The closing event.
 * @param options - Tracking options.
 * @returns The summary, or undefined when another closer holds the lock.
 */
async function closeTurn(
  store: TurnStateStore,
  sessionId: string,
  stopEvent: AgentWatchEvent,
  options: TrackTurnOptions
): Promise<TurnSummaryEvent | undefined> {
  const lockKey = sha256Hex(`${sessionId}::${stopEvent.session.turnId ?? ''}`).slice(0, LOCK_KEY_HASH_LENGTH);
  const release = await acquireLock(options.locksDir, `turn-close-${lockKey}`, options.env.now);

  if (!release) return undefined;

  try {
    return await closeTurnLocked(store, sessionId, stopEvent, options);
  } finally {
    await release();
  }
}

/**
 * Build the summary for a closing turn.
 *
 * Reads as the sequence it is: pick this turn's records, work out the usage
 * window, claim transcript usage, re-collect what landed while we waited, then
 * flatten it all into one summary.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param stopEvent - The closing event.
 * @param options - Tracking options.
 * @param readOnly - Preview only: consume and claim nothing.
 * @returns The summary, or undefined when there is nothing to summarize.
 */
async function closeTurnLocked(
  store: TurnStateStore,
  sessionId: string,
  stopEvent: AgentWatchEvent,
  options: TrackTurnOptions,
  readOnly = false
): Promise<TurnSummaryEvent | undefined> {
  const stopTurnId = stopEvent.session.turnId;
  // Consume only this prompt's records: a racing next prompt keeps its state
  // for its own Stop. Records without a turn id are legacy and belong to any
  // Stop. Nothing to summarize (a repeated Stop after a stop hook continued
  // the turn) means no empty duplicate.
  const all = await store.collectEntries(sessionId);
  const firstPass = filterTurn(all, stopTurnId);

  if (firstPass.length === 0) return undefined;

  const window = resolveWindow(all, firstPass, stopEvent.timestamp);
  const usage = await resolveAndClaimUsage(store, sessionId, stopEvent, options, window, readOnly);
  const billingMode = await detectBillingMode(options.agentId, options.env);

  // Re-collect after the settle wait: a tool completion that landed while we
  // watched the transcript still belongs to this turn.
  const mine = filterTurn(await store.collectEntries(sessionId), stopTurnId);
  const records = mine.map((entry) => entry.record);
  // Usage is mirrored onto a *copy* of the Stop event: the summary's model
  // should come from the transcript when the transcript knows better, and
  // rewriting an event another stage may still be reading is not an option.
  const resolvedStop = withResolvedUsage(stopEvent, usage, billingMode);

  const summary = buildTurnSummary({
    provider: stopEvent.agent.provider,
    surface: resolveSurface(stopEvent.agent.provider, options.env),
    sessionId,
    turnId: stopTurnId,
    developerId: await developerIdentity(options.config.developerEmail, options.cwd, { home: options.env.home }),
    installationId: options.config.installationId,
    git: stopEvent.git,
    featureCandidates: stopEvent.feature?.candidates,
    prompts: recordsOfKind<PromptRecord>(records, 'prompt'),
    tools: recordsOfKind<ToolRecord>(records, 'tool'),
    response: resolveResponse(stopEvent, records),
    usage,
    model: resolvedStop.ai?.model,
    billingMode,
    endedAt: stopEvent.timestamp
  });

  // Consume exactly what went into the summary; other prompts' records stay.
  if (!readOnly) await store.remove(mine.map((entry) => entry.file));

  return alignContentEvidence(sanitizeValue(summary));
}

/**
 * Degraded close: a summary built from the Stop event alone.
 *
 * No prompts, tools, or transcript usage, and it stays `pending` so the backend
 * finalizes usage from the llm.call ledger — via the turn id when present, else
 * the session-wide ownership join. A thin record beats a missing turn.
 *
 * @param sessionId - Provider session id.
 * @param stopEvent - The closing event.
 * @param options - Tracking options.
 * @returns The degraded summary, or undefined when even that failed.
 */
function fallbackSummary(sessionId: string, stopEvent: AgentWatchEvent, options: TrackTurnOptions): TurnSummaryEvent | undefined {
  try {
    const summary = buildTurnSummary({
      provider: stopEvent.agent.provider,
      surface: resolveSurface(stopEvent.agent.provider, options.env),
      sessionId,
      turnId: stopEvent.session.turnId,
      developerId: options.config.developerEmail,
      installationId: options.config.installationId,
      git: stopEvent.git,
      featureCandidates: stopEvent.feature?.candidates,
      prompts: [],
      tools: [],
      response: responseFrom(stopEvent),
      model: stopEvent.ai?.model,
      endedAt: stopEvent.timestamp
    });

    return alignContentEvidence(sanitizeValue(summary));
  } catch (error) {
    debugLog('fallback turn summary failed:', error);

    return undefined;
  }
}

/**
 * The window this turn may claim transcript usage from.
 *
 * Transcript entries carry no prompt id, so if another prompt started inside
 * our window every entry after its start is ambiguous. The window is cut
 * there: those tokens belong to — and are counted by — the other turn, which is
 * what keeps attribution exactly-once instead of doubled.
 *
 * @param all - Every record of the session.
 * @param mine - This turn's records.
 * @param stopAt - Timestamp of the closing event.
 * @returns The window bounds.
 */
function resolveWindow(all: readonly TurnStateEntry[], mine: readonly TurnStateEntry[], stopAt: string): TurnWindow {
  const startedAt = mine.find(({ record }) => record.kind === 'prompt')?.record.at;

  if (startedAt === undefined) return { startedAt, untilIso: stopAt };

  const mineSet = new Set(mine);
  let nextPromptAt: string | undefined;

  for (const entry of all) {
    if (mineSet.has(entry) || entry.record.kind !== 'prompt' || entry.record.at <= startedAt) continue;

    if (nextPromptAt === undefined || entry.record.at < nextPromptAt) nextPromptAt = entry.record.at;
  }

  const untilIso = nextPromptAt !== undefined && nextPromptAt < stopAt ? nextPromptAt : stopAt;

  return { startedAt, untilIso };
}

/**
 * Read transcript usage for this turn and persist the claim.
 *
 * Per-turn close locks prevent duplicate Stops for one prompt, but *different*
 * prompts close concurrently. The session usage lock therefore covers the whole
 * read-claims → read-transcript → persist-claim transaction. When the bounded
 * wait expires the transcript usage is omitted rather than risking double
 * attribution; native OTel remains authoritative either way.
 *
 * @param store - Per-session state store.
 * @param sessionId - Provider session id.
 * @param stopEvent - The closing event.
 * @param options - Tracking options.
 * @param window - Bounds this turn may claim from.
 * @param readOnly - Preview only: read claims but never write one.
 * @returns The usage, or undefined when none could be claimed.
 */
async function resolveAndClaimUsage(
  store: TurnStateStore,
  sessionId: string,
  stopEvent: AgentWatchEvent,
  options: TrackTurnOptions,
  window: TurnWindow,
  readOnly: boolean
): Promise<TurnUsage | undefined> {
  if (!TRANSCRIPT_READERS[options.agentId] || window.startedAt === undefined) return undefined;

  if (readOnly) {
    return readTranscriptUsage(options, window, await store.claimedMessageIds(sessionId));
  }

  const lockName = `turn-usage-${sha256Hex(sessionId).slice(0, LOCK_KEY_HASH_LENGTH)}`;
  const release = await waitForUsageLock(options, lockName);

  if (!release) {
    debugLog('turn usage lock timed out; omitting transcript usage');

    return undefined;
  }

  try {
    const claimed = await store.claimedMessageIds(sessionId);
    const usage = await readTranscriptUsage(options, window, claimed);

    if (usage?.messageIds && usage.messageIds.length > 0) {
      // Old Claude versions have no prompt id; the Stop event id still gives
      // every completed turn a distinct ledger file.
      await store.claimUsage(sessionId, stopEvent.session.turnId ?? stopEvent.id, usage.messageIds);
    }

    return usage;
  } finally {
    await release();
  }
}

/**
 * Acquire the session usage lock, waiting a bounded time.
 *
 * @param options - Tracking options supplying the locks directory and clock.
 * @param lockName - Session-scoped lock name.
 * @returns The release function, or undefined on timeout.
 */
function waitForUsageLock(options: TrackTurnOptions, lockName: string): Promise<ReleaseLock | undefined> {
  return pollUntil(() => acquireLock(options.locksDir, lockName, options.env.now), USAGE_LOCK_WAIT_MS, USAGE_LOCK_POLL_MS);
}

/**
 * Run this provider's transcript reader over the turn's window.
 *
 * @param options - Tracking options carrying the raw payload.
 * @param window - Bounds this turn may claim from.
 * @param excludeMessageIds - Messages other turns already claimed.
 * @returns The usage, or undefined when the provider reports none.
 */
async function readTranscriptUsage(
  options: TrackTurnOptions,
  window: TurnWindow,
  excludeMessageIds: ReadonlySet<string>
): Promise<TurnUsage | undefined> {
  const reader = TRANSCRIPT_READERS[options.agentId];
  const transcriptPath = asRecord(options.rawPayload)?.[TRANSCRIPT_PATH_KEY];

  if (!reader || window.startedAt === undefined || typeof transcriptPath !== 'string') return undefined;

  return reader(transcriptPath, window.startedAt, window.untilIso, excludeMessageIds);
}

/**
 * The records of one kind, narrowed.
 *
 * @param records - Every record of the turn.
 * @param kind - Kind to keep.
 * @returns The matching records, in order.
 */
function recordsOfKind<T extends TurnRecord>(records: readonly TurnRecord[], kind: T['kind']): T[] {
  return records.filter((record): record is T => record.kind === kind);
}

/**
 * This turn's records out of the session's.
 *
 * @param entries - Every entry of the session.
 * @param stopTurnId - Turn id of the closing event, when it has one.
 * @returns The entries this Stop owns.
 */
function filterTurn(entries: readonly TurnStateEntry[], stopTurnId: string | undefined): TurnStateEntry[] {
  return entries.filter(({ record }) => stopTurnId === undefined || record.turnId === undefined || record.turnId === stopTurnId);
}

/**
 * The response the user saw.
 *
 * A Stop-supplied response (Claude) wins; otherwise the turn's last recorded
 * response event (Cursor's afterAgentResponse) is the answer that was shown.
 *
 * @param stopEvent - The closing event.
 * @param records - The turn's records.
 * @returns The response, or undefined when none was captured.
 */
function resolveResponse(stopEvent: AgentWatchEvent, records: readonly TurnRecord[]): TurnResponse | undefined {
  const fromStop = responseFrom(stopEvent);

  if (fromStop) return fromStop;

  const last = recordsOfKind<ResponseRecord>(records, 'response').at(-1);

  if (!last) return undefined;

  return { text: last.text, evidence: last.evidence };
}

/**
 * A copy of the closing event carrying the usage we resolved for it.
 *
 * @param stopEvent - The closing event; left untouched.
 * @param usage - Transcript usage, when any was claimed.
 * @param billingMode - Detected billing mode.
 * @returns The event with `ai` filled in.
 */
function withResolvedUsage(stopEvent: AgentWatchEvent, usage: TurnUsage | undefined, billingMode: UsageBillingMode): AgentWatchEvent {
  if (!usage && billingMode === 'unknown') return stopEvent;

  return {
    ...stopEvent,
    ai: {
      ...stopEvent.ai,
      model: usage?.model ?? stopEvent.ai?.model,
      billingMode: billingMode === 'unknown' ? stopEvent.ai?.billingMode : billingMode,
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            source: 'transcript'
          }
        : stopEvent.ai?.usage
    }
  };
}

/**
 * A prompt record from a prompt event.
 *
 * @param event - The prompt event.
 * @returns The record.
 */
function promptRecord(event: AgentWatchEvent): PromptRecord {
  const metadata = event.metadata ?? {};

  return {
    kind: 'prompt',
    at: event.timestamp,
    turnId: event.session.turnId,
    text: typeof metadata[PROMPT_TEXT_KEY] === 'string' ? (metadata[PROMPT_TEXT_KEY] as string) : undefined,
    evidence: asEvidence(metadata[PROMPT_EVIDENCE_KEY])
  };
}

/**
 * A tool record from a tool-completion event.
 *
 * @param event - The tool event.
 * @returns The record.
 */
function toolRecord(event: AgentWatchEvent): ToolRecord {
  const filePath = event.metadata?.[FILE_PATH_KEY];

  return {
    kind: 'tool',
    at: event.timestamp,
    turnId: event.session.turnId,
    tool: event.tool?.name,
    filePath: typeof filePath === 'string' ? filePath : undefined,
    access: accessFor(event.event.type)
  };
}

/**
 * Whether a tool event read or modified its file.
 *
 * Reads and edits are different product signals: files the agent merely read
 * must not appear in the summary's files_touched (modified) list.
 *
 * @param type - Canonical event type.
 * @returns The access kind, or undefined when the event implies neither.
 */
function accessFor(type: AgentWatchEvent['event']['type']): ToolRecord['access'] {
  if (type === 'file.read') return 'read';

  if (type === 'file.edited') return 'edit';

  return undefined;
}

/**
 * A response record from an out-of-band response event.
 *
 * @param event - The response-bearing event.
 * @returns The record.
 */
function responseRecord(event: AgentWatchEvent): ResponseRecord {
  const response = responseFrom(event);

  return {
    kind: 'response',
    at: event.timestamp,
    turnId: event.session.turnId,
    text: response?.text,
    evidence: response?.evidence
  };
}

/**
 * Response text and evidence carried on an event's metadata.
 *
 * @param event - Any canonical event.
 * @returns The response, or undefined when the event carries none.
 */
function responseFrom(event: AgentWatchEvent): TurnResponse | undefined {
  const metadata = event.metadata ?? {};
  const text = typeof metadata[RESPONSE_TEXT_KEY] === 'string' ? (metadata[RESPONSE_TEXT_KEY] as string) : undefined;
  const evidence = asEvidence(metadata[RESPONSE_EVIDENCE_KEY]);

  if (text === undefined && evidence === undefined) return undefined;

  return { text, evidence };
}

/**
 * Content evidence out of an untrusted metadata value.
 *
 * @param value - Metadata value of unknown shape.
 * @returns The evidence, or undefined when the shape does not match.
 */
function asEvidence(value: unknown): ContentEvidence | undefined {
  const record = asRecord(value);

  if (typeof record?.['length'] !== 'number' || typeof record['sha256'] !== 'string') return undefined;

  return { length: record['length'], sha256: record['sha256'] };
}

/**
 * Which surface the turn happened on.
 *
 * @param provider - Internal provider id.
 * @param env - Environment; Claude Code reports its own entrypoint there.
 * @returns The surface label.
 */
function resolveSurface(provider: string, env: Env): string {
  if (provider === 'claude') {
    const entrypoint = env.vars[CLAUDE_ENTRYPOINT_VAR];

    if (entrypoint) return entrypoint;
  }

  // Cursor and Antigravity hooks fire from an editor agent. Cursor's
  // is_background_agent is only available on sessionStart, not on Stop, so v1
  // reports a single surface for them.
  if (IDE_SURFACE_PROVIDERS.has(provider)) return IDE_SURFACE;

  return DEFAULT_SURFACE;
}
