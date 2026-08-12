import fs from 'node:fs/promises';
import { sha256Hex } from '../events/event-id.js';
import type { ReadTurnUsageRetry, TurnUsage } from './claude-transcript.js';

/**
 * Forward-compatible token usage from Cursor's transcript JSONL.
 *
 * Today (verified 2026-08) Cursor transcript rows carry only role/message with
 * tool_use blocks — no usage, no timestamps, no message ids — so this reader
 * returns undefined and Cursor turn summaries stay usage_status=pending.
 * Cursor has logged the enrichment request; the parser already accepts
 * `usage` / `message.usage` objects with Anthropic-style token fields, so
 * tokens appear here without a code change once the format grows them.
 *
 * Rows have no timestamps, so unlike the Claude reader there is no time
 * window: a turn claims every not-yet-claimed usage row, and exactly-once
 * attribution rests entirely on the persisted message-id ledger
 * (excludeMessageIds). Rows without an id claim through a stable content hash.
 */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

export async function readCursorTurnUsage(
  transcriptPath: string,
  retry?: ReadTurnUsageRetry,
  excludeMessageIds?: ReadonlySet<string>
): Promise<TurnUsage | undefined> {
  const attempts = Math.max(1, retry?.attempts ?? 1);
  const delayMs = retry?.delayMs ?? 0;
  const minSettleMs = retry?.minSettleMs ?? 0;
  let previous: TurnUsage | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const usage = await readOnce(transcriptPath, excludeMessageIds);
    // Today's Cursor format has no usage rows at all: retrying cannot change
    // that, and the settle loop would add attempts×delay of pure latency to
    // every Stop. Wait out the flush only once usage rows actually exist.
    if (usage === undefined && previous === undefined) return undefined;
    const settled = attempt * delayMs >= minSettleMs;
    if (settled && usage && previous && JSON.stringify(usage) === JSON.stringify(previous)) return usage;
    previous = usage;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return previous;
}

async function readOnce(transcriptPath: string, excludeMessageIds?: ReadonlySet<string>): Promise<TurnUsage | undefined> {
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

  const byMessageId = new Map<string, { model?: string; usage: Record<string, unknown> }>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = asRecord(entry['message']);
    const usage = asRecord(entry['usage']) ?? asRecord(message?.['usage']);
    if (!usage) continue;
    const rawId = firstStringOf(message?.['id'], entry['id'], entry['message_id']);
    const id = rawId ?? `anon-${sha256Hex(line)}`;
    if (excludeMessageIds?.has(id)) continue;
    const model = firstStringOf(message?.['model'], entry['model']);
    byMessageId.set(id, { model, usage });
  }
  if (byMessageId.size === 0) return undefined;

  const result: TurnUsage = {};
  const modelTokens = new Map<string, number>();
  for (const { model, usage } of byMessageId.values()) {
    result.inputTokens = add(result.inputTokens, usage['input_tokens']);
    result.outputTokens = add(result.outputTokens, usage['output_tokens']);
    result.cachedInputTokens = add(result.cachedInputTokens, usage['cache_read_input_tokens']);
    result.cacheCreationInputTokens = add(result.cacheCreationInputTokens, usage['cache_creation_input_tokens']);
    if (model) {
      const weight = finiteOrZero(usage['input_tokens']) + finiteOrZero(usage['output_tokens']) + finiteOrZero(usage['cache_read_input_tokens']) + finiteOrZero(usage['cache_creation_input_tokens']);
      modelTokens.set(model, (modelTokens.get(model) ?? 0) + weight);
    }
  }
  let dominantTokens = -1;
  for (const [model, tokens] of modelTokens) {
    if (tokens > dominantTokens) {
      result.model = model;
      dominantTokens = tokens;
    }
  }
  result.messageIds = [...byMessageId.keys()];
  return result;
}

function firstStringOf(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function add(current: number | undefined, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return current;
  return (current ?? 0) + value;
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
