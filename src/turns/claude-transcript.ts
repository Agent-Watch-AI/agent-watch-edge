import fs from 'node:fs/promises';
import { sha256Hex } from '../events/event-id.js';

export interface TurnUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Transcript message ids summed into this usage; used for the exactly-once ledger. */
  messageIds?: string[];
}

/**
 * Only the tail is read: the turn's entries are at the end of the JSONL, and
 * the retry loop re-reads the file several times per Stop — parsing tens of
 * megabytes each pass would be pure waste on long sessions.
 */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

export interface ReadTurnUsageRetry {
  /** Total read attempts, including the first one. */
  attempts: number;
  delayMs: number;
  /**
   * A stable snapshot is only trusted after this much time has passed:
   * early usage in a multi-tool turn stabilizes instantly while the final
   * entry may still be seconds away.
   */
  minSettleMs?: number;
}

/**
 * Authoritative per-turn token usage from Claude Code's transcript JSONL.
 * Sums the usage of assistant messages recorded at/after the turn start,
 * deduplicating by message id (multi-block messages repeat the same usage on
 * every line). Any read/parse problem degrades to "no usage", never throws.
 *
 * Claude Code flushes the transcript asynchronously, so the final assistant
 * entry may not be on disk yet when the Stop hook fires — and in a turn with
 * tool calls, earlier entries ARE already there, so stopping at the first hit
 * would systematically undercount. `retry` therefore re-reads until two
 * consecutive reads agree (a stable snapshot) or attempts run out.
 */
export async function readTurnUsage(
  transcriptPath: string,
  sinceIso: string,
  retry?: ReadTurnUsageRetry,
  untilIso?: string,
  excludeMessageIds?: ReadonlySet<string>
): Promise<TurnUsage | undefined> {
  const attempts = Math.max(1, retry?.attempts ?? 1);
  const delayMs = retry?.delayMs ?? 0;
  const minSettleMs = retry?.minSettleMs ?? 0;
  let previous: TurnUsage | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const usage = await readTurnUsageOnce(transcriptPath, sinceIso, untilIso, excludeMessageIds);
    const settled = attempt * delayMs >= minSettleMs;
    if (settled && usage && previous && JSON.stringify(usage) === JSON.stringify(previous)) return usage;
    previous = usage;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return previous;
}

async function readTurnUsageOnce(
  transcriptPath: string,
  sinceIso: string,
  untilIso?: string,
  excludeMessageIds?: ReadonlySet<string>
): Promise<TurnUsage | undefined> {
  let raw: string;
  try {
    const stat = await fs.stat(transcriptPath);
    if (stat.size > TRANSCRIPT_TAIL_BYTES) {
      const handle = await fs.open(transcriptPath, 'r');
      try {
        const buffer = Buffer.alloc(TRANSCRIPT_TAIL_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, TRANSCRIPT_TAIL_BYTES, stat.size - TRANSCRIPT_TAIL_BYTES);
        raw = buffer.subarray(0, bytesRead).toString('utf8');
        // Drop the first, almost certainly partial, line.
        raw = raw.slice(raw.indexOf('\n') + 1);
      } finally {
        await handle.close();
      }
    } else {
      raw = await fs.readFile(transcriptPath, 'utf8');
    }
  } catch {
    return undefined;
  }
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return undefined;
  // Entries after `until` belong to the next prompt racing into the same
  // file; a late FLUSH of this turn's entry still passes (its message
  // timestamp predates the Stop).
  const until = untilIso !== undefined ? Date.parse(untilIso) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(until)) return undefined;

  const byMessageId = new Map<string, { model?: string; usage: Record<string, unknown> }>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry['type'] !== 'assistant') continue;
    const timestamp = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN;
    if (Number.isNaN(timestamp) || timestamp < since || timestamp > until) continue;
    const message = entry['message'] as Record<string, unknown> | undefined;
    const usage = message?.['usage'] as Record<string, unknown> | undefined;
    if (!usage) continue;
    // Some transcript variants omit message.id. A content hash is stable
    // across retries/processes, so anonymous entries can still participate in
    // the persisted exactly-once claim ledger. Identical anonymous lines are
    // indistinguishable and intentionally deduplicate.
    const id = typeof message?.['id'] === 'string' ? (message['id'] as string) : `anon-${sha256Hex(line)}`;
    // Messages already claimed by another turn's summary are never re-counted.
    if (excludeMessageIds?.has(id)) continue;
    byMessageId.set(id, { model: typeof message?.['model'] === 'string' ? (message['model'] as string) : undefined, usage });
  }
  if (byMessageId.size === 0) return undefined;

  const result: TurnUsage = {};
  for (const { model, usage } of byMessageId.values()) {
    if (model) result.model = model;
    result.inputTokens = add(result.inputTokens, usage['input_tokens']);
    result.outputTokens = add(result.outputTokens, usage['output_tokens']);
    result.cachedInputTokens = add(result.cachedInputTokens, usage['cache_read_input_tokens']);
    result.cacheCreationInputTokens = add(result.cacheCreationInputTokens, usage['cache_creation_input_tokens']);
  }
  result.messageIds = [...byMessageId.keys()];
  return result;
}

function add(current: number | undefined, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return current;
  return (current ?? 0) + value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
