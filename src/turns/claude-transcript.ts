import { asRecord } from '../core/object.js';
import { accumulateUsage, messageIdFor, parseJsonLine, readTranscriptTail, readUntilSettled } from './transcript.js';
import type { ReadTurnUsageRetry, TranscriptUsageEntry, TurnUsage } from './types/transcript.types.js';

export type { ReadTurnUsageRetry, TranscriptUsageEntry, TurnUsage } from './types/transcript.types.js';

/**
 * Authoritative per-turn token usage from Claude Code's transcript JSONL.
 *
 * Sums the usage of assistant messages recorded inside the turn's window,
 * deduplicating by message id — a multi-block message repeats the same usage on
 * every line, and counting those twice would double the turn's cost. Any
 * read or parse problem degrades to "no usage"; it never throws.
 *
 * @param transcriptPath - Path Claude Code reported in the hook payload.
 * @param sinceIso - When the turn started; earlier entries are another turn's.
 * @param retry - How long to wait for the transcript flush to settle.
 * @param untilIso - Upper bound, keeping a racing next prompt's entries out.
 * @param excludeMessageIds - Messages another turn already claimed.
 * @returns The turn's usage, or undefined when the transcript reports none.
 */
export async function readTurnUsage(
  transcriptPath: string,
  sinceIso: string,
  retry?: ReadTurnUsageRetry,
  untilIso?: string,
  excludeMessageIds?: ReadonlySet<string>
): Promise<TurnUsage | undefined> {
  return readUntilSettled(() => readOnce(transcriptPath, sinceIso, untilIso, excludeMessageIds), retry);
}

/**
 * One pass over the transcript tail.
 *
 * @param transcriptPath - Transcript file.
 * @param sinceIso - Lower bound of the turn's window.
 * @param untilIso - Upper bound, or undefined for "no upper bound".
 * @param excludeMessageIds - Messages another turn already claimed.
 * @returns The usage found in this pass.
 */
async function readOnce(
  transcriptPath: string,
  sinceIso: string,
  untilIso?: string,
  excludeMessageIds?: ReadonlySet<string>
): Promise<TurnUsage | undefined> {
  const since = Date.parse(sinceIso);

  if (Number.isNaN(since)) return undefined;

  // Entries after `until` belong to the next prompt racing into the same file.
  // A late FLUSH of *this* turn's entry still passes, because its own message
  // timestamp predates the Stop.
  const until = untilIso === undefined ? Number.POSITIVE_INFINITY : Date.parse(untilIso);

  if (Number.isNaN(until)) return undefined;

  const raw = await readTranscriptTail(transcriptPath);

  if (raw === undefined) return undefined;

  const byMessageId = new Map<string, TranscriptUsageEntry>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;

    const entry = assistantUsageEntry(line, since, until, excludeMessageIds);

    if (entry) byMessageId.set(entry.id, entry.value);
  }

  return accumulateUsage(byMessageId);
}

/** A usable transcript line, reduced to what the accumulator needs. */
interface IdentifiedEntry {
  readonly id: string;
  readonly value: TranscriptUsageEntry;
}

/**
 * The usage of one transcript line, when it is an assistant message inside the
 * window that no other turn has claimed.
 *
 * @param line - Verbatim JSONL line.
 * @param since - Window lower bound, epoch ms.
 * @param until - Window upper bound, epoch ms.
 * @param excludeMessageIds - Messages another turn already claimed.
 * @returns The entry, or undefined when the line does not qualify.
 */
function assistantUsageEntry(
  line: string,
  since: number,
  until: number,
  excludeMessageIds?: ReadonlySet<string>
): IdentifiedEntry | undefined {
  const entry = parseJsonLine(line);

  if (!entry || entry['type'] !== 'assistant') return undefined;

  const timestamp = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN;

  if (Number.isNaN(timestamp) || timestamp < since || timestamp > until) return undefined;

  const message = asRecord(entry['message']);
  const usage = asRecord(message?.['usage']);

  if (!usage) return undefined;

  const rawId = typeof message?.['id'] === 'string' ? (message['id'] as string) : undefined;
  const id = messageIdFor(rawId, line);

  if (excludeMessageIds?.has(id)) return undefined;

  const model = typeof message?.['model'] === 'string' ? (message['model'] as string) : undefined;

  return { id, value: { model, usage } };
}
