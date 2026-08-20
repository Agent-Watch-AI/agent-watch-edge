import { asRecord, firstStringOf } from '../core/object.js';
import { accumulateUsage, messageIdFor, parseJsonLine, readTranscriptTail, readUntilSettled } from './transcript.js';
import type { ReadTurnUsageRetry, TranscriptUsageEntry, TurnUsage } from './types/transcript.types.js';

/**
 * Forward-compatible token usage from Cursor's transcript JSONL.
 *
 * Today (verified 2026-08) Cursor transcript rows carry only role/message with
 * tool_use blocks — no usage, no timestamps, no message ids — so this reader
 * returns undefined and Cursor turn summaries stay usage_status=pending. Cursor
 * has logged the enrichment request; the parser already accepts `usage` and
 * `message.usage` objects with Anthropic-style token fields, so tokens will
 * appear here without a code change once the format grows them.
 *
 * Rows have no timestamps, so unlike the Claude reader there is no time window:
 * a turn claims every not-yet-claimed usage row, and exactly-once attribution
 * rests entirely on the persisted message-id ledger.
 *
 * @param transcriptPath - Path Cursor reported in the hook payload.
 * @param retry - How long to wait for the transcript flush to settle.
 * @param excludeMessageIds - Rows another turn already claimed.
 * @returns The turn's usage, or undefined while the format carries none.
 */
export async function readCursorTurnUsage(
  transcriptPath: string,
  retry?: ReadTurnUsageRetry,
  excludeMessageIds?: ReadonlySet<string>
): Promise<TurnUsage | undefined> {
  return readUntilSettled(() => readOnce(transcriptPath, excludeMessageIds), retry, { bailOnFirstEmpty: true });
}

/**
 * One pass over the transcript tail.
 *
 * @param transcriptPath - Transcript file.
 * @param excludeMessageIds - Rows another turn already claimed.
 * @returns The usage found in this pass.
 */
async function readOnce(transcriptPath: string, excludeMessageIds?: ReadonlySet<string>): Promise<TurnUsage | undefined> {
  const raw = await readTranscriptTail(transcriptPath);

  if (raw === undefined) return undefined;

  const byMessageId = new Map<string, TranscriptUsageEntry>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;

    const entry = usageRow(line, excludeMessageIds);

    if (entry) byMessageId.set(entry.id, entry.value);
  }

  return accumulateUsage(byMessageId);
}

/** A usable transcript row, reduced to what the accumulator needs. */
interface IdentifiedEntry {
  readonly id: string;
  readonly value: TranscriptUsageEntry;
}

/**
 * The usage of one transcript row, when it reports any and no other turn has
 * claimed it.
 *
 * @param line - Verbatim JSONL line.
 * @param excludeMessageIds - Rows another turn already claimed.
 * @returns The entry, or undefined when the row carries no usage.
 */
function usageRow(line: string, excludeMessageIds?: ReadonlySet<string>): IdentifiedEntry | undefined {
  const entry = parseJsonLine(line);

  if (!entry) return undefined;

  const message = asRecord(entry['message']);
  const usage = asRecord(entry['usage']) ?? asRecord(message?.['usage']);

  if (!usage) return undefined;

  const id = messageIdFor(firstStringOf(message?.['id'], entry['id'], entry['message_id']), line);

  if (excludeMessageIds?.has(id)) return undefined;

  return { id, value: { model: firstStringOf(message?.['model'], entry['model']), usage } };
}
