import type { AgentWatchEvent } from '../events/canonical-event.js';
import type { AgentWatchConfig } from '../config/config.js';
import type { Env } from '../core/env.js';
import { debugLog } from '../core/logger.js';
import { gitUserEmail } from '../git/git-context.js';
import { detectBillingMode } from '../billing/billing-mode.js';
import { sanitizeValue } from '../privacy/sanitizer.js';
import { acquireLock } from '../storage/lock.js';
import { sha256Hex } from '../events/event-id.js';
import { TurnStateStore, type ContentEvidence, type TurnRecord, type TurnStateEntry } from './turn-state.js';
import { readTurnUsage, type TurnUsage } from './claude-transcript.js';
import { buildTurnSummary, type TurnSummaryEvent } from './turn-summary.js';

const TOOL_COMPLETION_TYPES = new Set(['tool.completed', 'tool.failed', 'shell.completed', 'mcp.completed', 'file.read', 'file.edited']);

/** Orphaned turn state (crash without Stop/SessionEnd) is deleted after this. */
const TURN_STATE_TTL_MS = 24 * 60 * 60 * 1000;
/** Overlapping Stop hooks serialize only transcript usage allocation. */
const USAGE_LOCK_WAIT_MS = 5_000;
const USAGE_LOCK_POLL_MS = 25;

export interface TrackTurnOptions {
  agentId: string;
  /** Raw provider payload; source of Claude's transcript_path. */
  rawPayload: unknown;
  /** Enriched + sanitized canonical events produced from this payload. */
  events: AgentWatchEvent[];
  config: AgentWatchConfig;
  turnsDir: string;
  locksDir: string;
  env: Env;
  cwd: string;
  /** Preview a Stop without appending, consuming, claiming, or sweeping state. */
  readOnly?: boolean;
}

/**
 * Accumulate turn state across hook invocations and close the turn on
 * `generation.completed`, producing one flat summary event. Best-effort by
 * design: any failure returns "no summary" and never breaks the hook.
 */
export async function trackTurn(options: TrackTurnOptions): Promise<TurnSummaryEvent | undefined> {
  const store = new TurnStateStore(options.turnsDir);
  let summary: TurnSummaryEvent | undefined;

  for (const event of options.events) {
    const sessionId = event.session.id;
    if (!sessionId) continue;
    try {
      const type = event.event.type;
      if (options.readOnly) {
        if (type === 'generation.completed') summary = await closeTurnLocked(store, sessionId, event, options, true);
        continue;
      }
      if (type === 'prompt.submitted') {
        await store.append(sessionId, event.id, promptRecord(event));
      } else if (TOOL_COMPLETION_TYPES.has(type)) {
        await store.append(sessionId, event.id, toolRecord(event));
      } else if (type === 'generation.completed') {
        summary = await closeTurn(store, sessionId, event, options);
        await store.sweep(TURN_STATE_TTL_MS);
      } else if (type === 'session.ended') {
        await store.clear(sessionId);
        await store.sweep(TURN_STATE_TTL_MS);
      }
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
 * Degraded close: a summary built from the Stop event alone — no prompts,
 * tools, or transcript usage. It stays `pending` so the backend finalizes
 * usage from the llm.call ledger (via the turn id when present, else the
 * session-wide ownership join — see aggregate-usage `sessionSummaries`);
 * a thin record beats a missing turn.
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
      response: responseFromStop(stopEvent),
      model: stopEvent.ai?.model,
      endedAt: stopEvent.timestamp
    });
    return sanitizeValue(summary);
  } catch (error) {
    debugLog('fallback turn summary failed:', error);
    return undefined;
  }
}

async function closeTurn(store: TurnStateStore, sessionId: string, stopEvent: AgentWatchEvent, options: TrackTurnOptions): Promise<TurnSummaryEvent | undefined> {
  // Serialize closing per turn: Claude can fire duplicate Stops, and two
  // unserialized closers would read the same snapshot and emit twice. Keyed
  // by session+turn so different prompts of one session close independently.
  const lockKey = sha256Hex(`${sessionId}::${stopEvent.session.turnId ?? ''}`).slice(0, 16);
  const release = await acquireLock(options.locksDir, `turn-close-${lockKey}`, options.env.now);
  if (!release) return undefined;
  try {
    return await closeTurnLocked(store, sessionId, stopEvent, options);
  } finally {
    await release();
  }
}

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
  // Stop. Nothing to summarize (e.g. a repeated Stop after a stop hook
  // continued the turn) → no empty duplicate.
  const all = await store.collectEntries(sessionId);
  const firstPass = filterTurn(all, stopTurnId);
  if (firstPass.length === 0) return undefined;
  const startedAt = firstPass.find(({ record }) => record.kind === 'prompt')?.record.at;

  // Overlap guard: transcript entries carry no prompt id, so if another
  // prompt started inside our window, entries after its start are ambiguous.
  // Cut our window there — those tokens belong to (and are counted by) the
  // other turn, keeping attribution exactly-once instead of doubled.
  const mineSet = new Set(firstPass);
  const otherPromptStart = all
    .filter((entry) => !mineSet.has(entry) && entry.record.kind === 'prompt' && startedAt !== undefined && entry.record.at > startedAt)
    .map((entry) => entry.record.at)
    .sort()[0];
  const untilIso = otherPromptStart !== undefined && otherPromptStart < stopEvent.timestamp ? otherPromptStart : stopEvent.timestamp;

  const usage = await resolveAndClaimUsage(store, sessionId, stopEvent, options, startedAt, untilIso, readOnly);
  const billingMode = await detectBillingMode(options.agentId, options.env);

  // Re-collect after the settle wait: a tool completion that landed while we
  // watched the transcript still belongs to this turn.
  const mine = filterTurn(await store.collectEntries(sessionId), stopTurnId);
  const records = mine.map((entry) => entry.record);
  const prompts = records.filter((record): record is Extract<TurnRecord, { kind: 'prompt' }> => record.kind === 'prompt');
  const tools = records.filter((record): record is Extract<TurnRecord, { kind: 'tool' }> => record.kind === 'tool');

  // Mirror usage onto the raw Stop event so the event stream carries token
  // cost on its own; session.id + provider.promptId correlate it with the
  // rest of the turn.
  if (usage) applyUsage(stopEvent, usage);
  if (billingMode !== 'unknown') stopEvent.ai = { ...stopEvent.ai, billingMode };
  const developerId = options.config.developerEmail ?? (await gitUserEmail(options.cwd, { home: options.env.home }));

  const summary = buildTurnSummary({
    provider: stopEvent.agent.provider,
    surface: resolveSurface(stopEvent.agent.provider, options.env),
    sessionId,
    turnId: stopEvent.session.turnId,
    developerId,
    installationId: options.config.installationId,
    git: stopEvent.git,
    featureCandidates: stopEvent.feature?.candidates,
    prompts,
    tools,
    response: responseFromStop(stopEvent),
    usage,
    model: stopEvent.ai?.model,
    billingMode,
    endedAt: stopEvent.timestamp
  });

  // Consume exactly what went into the summary; other prompts' records stay.
  if (!readOnly) await store.remove(mine.map((entry) => entry.file));
  return sanitizeValue(summary);
}

/**
 * Stop can fire before Claude Code flushes the final assistant entry to the
 * transcript; keep re-reading briefly so token usage is (almost) always there.
 * The settle window guards multi-tool turns, where early usage entries look
 * stable long before the final one lands.
 */
const USAGE_RETRY = { attempts: 6, delayMs: 250, minSettleMs: 500 };

/**
 * Allocate transcript messages exactly once across overlapping turns.
 *
 * Per-turn close locks prevent duplicate Stops for one prompt, but different
 * prompts close concurrently. The session usage lock therefore covers the
 * complete read-claims -> settle/read-transcript -> persist-claim transaction.
 * If the bounded wait expires we omit best-effort transcript usage rather
 * than risk double attribution; native OTel remains authoritative.
 */
async function resolveAndClaimUsage(
  store: TurnStateStore,
  sessionId: string,
  stopEvent: AgentWatchEvent,
  options: TrackTurnOptions,
  startedAt: string | undefined,
  untilIso: string,
  readOnly: boolean
): Promise<TurnUsage | undefined> {
  if (options.agentId !== 'claude' || !startedAt) return undefined;
  if (readOnly) {
    const claimed = await store.claimedMessageIds(sessionId);
    return resolveUsage(options, startedAt, untilIso, claimed);
  }
  const lockName = `turn-usage-${sha256Hex(sessionId).slice(0, 16)}`;
  const release = await waitForLock(options.locksDir, lockName, options.env.now, USAGE_LOCK_WAIT_MS);
  if (!release) {
    debugLog('turn usage lock timed out; omitting transcript usage');
    return undefined;
  }
  try {
    const claimed = await store.claimedMessageIds(sessionId);
    const usage = await resolveUsage(options, startedAt, untilIso, claimed);
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

async function waitForLock(
  locksDir: string,
  name: string,
  now: () => Date,
  maxWaitMs: number
): Promise<(() => Promise<void>) | undefined> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() <= deadline) {
    const release = await acquireLock(locksDir, name, now);
    if (release) return release;
    await sleep(USAGE_LOCK_POLL_MS);
  }
  return undefined;
}

async function resolveUsage(
  options: TrackTurnOptions,
  startedAt: string | undefined,
  untilIso: string,
  excludeMessageIds: ReadonlySet<string>
): Promise<TurnUsage | undefined> {
  if (options.agentId !== 'claude' || !startedAt) return undefined;
  const transcriptPath = (options.rawPayload as Record<string, unknown> | undefined)?.['transcript_path'];
  if (typeof transcriptPath !== 'string') return undefined;
  // `until` = the Stop timestamp keeps the next prompt's entries (racing into
  // the same transcript) out of this turn's totals.
  return readTurnUsage(transcriptPath, startedAt, USAGE_RETRY, untilIso, excludeMessageIds);
}

function filterTurn(entries: TurnStateEntry[], stopTurnId: string | undefined): TurnStateEntry[] {
  return entries.filter(({ record }) => stopTurnId === undefined || record.turnId === undefined || record.turnId === stopTurnId);
}

function applyUsage(event: AgentWatchEvent, usage: TurnUsage): void {
  event.ai = {
    ...event.ai,
    model: usage.model ?? event.ai?.model,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      source: 'transcript'
    }
  };
}

function promptRecord(event: AgentWatchEvent): TurnRecord {
  const metadata = event.metadata ?? {};
  return {
    kind: 'prompt',
    at: event.timestamp,
    turnId: event.session.turnId,
    text: typeof metadata['promptText'] === 'string' ? (metadata['promptText'] as string) : undefined,
    evidence: asEvidence(metadata['prompt'])
  };
}

function toolRecord(event: AgentWatchEvent): TurnRecord {
  const filePath = event.metadata?.['filePath'];
  return {
    kind: 'tool',
    at: event.timestamp,
    turnId: event.session.turnId,
    tool: event.tool?.name,
    filePath: typeof filePath === 'string' ? filePath : undefined
  };
}

function responseFromStop(stopEvent: AgentWatchEvent): { text?: string; evidence?: ContentEvidence } | undefined {
  const metadata = stopEvent.metadata ?? {};
  const text = typeof metadata['responseText'] === 'string' ? (metadata['responseText'] as string) : undefined;
  const evidence = asEvidence(metadata['response']);
  if (text === undefined && evidence === undefined) return undefined;
  return { text, evidence };
}

function asEvidence(value: unknown): ContentEvidence | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['length'] === 'number' && typeof record['sha256'] === 'string') {
    return { length: record['length'], sha256: record['sha256'] };
  }
  return undefined;
}

function resolveSurface(provider: string, env: Env): string {
  if (provider === 'claude') {
    const entrypoint = env.vars['CLAUDE_CODE_ENTRYPOINT'];
    if (entrypoint) return entrypoint;
  }
  return 'cli';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
