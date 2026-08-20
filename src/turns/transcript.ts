import fs from 'node:fs/promises';
import { add, finiteOrZero } from '../core/number.js';
import { asRecord } from '../core/object.js';
import { sleep } from '../core/async.js';
import { sha256Hex } from '../events/event-id.js';
import {
  ANONYMOUS_MESSAGE_ID_PREFIX,
  TRANSCRIPT_CACHE_CREATION_TOKENS,
  TRANSCRIPT_CACHE_READ_TOKENS,
  TRANSCRIPT_INPUT_TOKENS,
  TRANSCRIPT_OUTPUT_TOKENS,
  TRANSCRIPT_TAIL_BYTES,
  TRANSCRIPT_TOKEN_FIELDS
} from './constants/turns.constants.js';
import type { ReadTurnUsageRetry, TranscriptUsageEntry, TurnUsage } from './types/transcript.types.js';

/** One read pass over a transcript. */
export type TranscriptPass = () => Promise<TurnUsage | undefined>;

/** How the settle loop should treat a transcript that reports no usage at all. */
export interface SettleOptions {
  /**
   * Stop immediately when the very first pass finds nothing.
   *
   * For a provider whose transcript format carries no usage today, retrying
   * cannot change the answer, and the settle loop would add attempts×delay of
   * pure latency to every Stop.
   */
  readonly bailOnFirstEmpty?: boolean;
}

/**
 * Re-read until two consecutive passes agree, or the attempts run out.
 *
 * Agents flush their transcript asynchronously, so the final assistant entry
 * may not be on disk when Stop fires — and in a turn with tool calls the
 * *earlier* entries already are, so stopping at the first hit would
 * systematically undercount. Agreement between two passes, no earlier than the
 * settle window, is the signal that the flush is done.
 *
 * @param pass - Reads the transcript once.
 * @param retry - Attempt count, delay and settle window.
 * @param options - Provider-specific early-exit behaviour.
 * @returns The settled usage, or the last thing read.
 */
export async function readUntilSettled(pass: TranscriptPass, retry?: ReadTurnUsageRetry, options: SettleOptions = {}): Promise<TurnUsage | undefined> {
  const attempts = Math.max(1, retry?.attempts ?? 1);
  const delayMs = retry?.delayMs ?? 0;
  const minSettleMs = retry?.minSettleMs ?? 0;
  let previous: TurnUsage | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const usage = await pass();

    if (options.bailOnFirstEmpty && usage === undefined && previous === undefined) return undefined;

    const settled = attempt * delayMs >= minSettleMs;

    if (settled && usage && previous && sameUsage(usage, previous)) return usage;

    previous = usage;

    if (attempt < attempts - 1) await sleep(delayMs);
  }

  return previous;
}

/**
 * Read the tail of a transcript file.
 *
 * Only the tail: the turn's entries are at the end of the JSONL and the settle
 * loop re-reads the file several times per Stop, so parsing a whole
 * multi-megabyte session each pass would be waste (STYLEGUIDE 3.3).
 *
 * @param transcriptPath - Path the provider reported.
 * @returns The tail text, or undefined when the file cannot be read.
 */
export async function readTranscriptTail(transcriptPath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(transcriptPath);

    if (stat.size <= TRANSCRIPT_TAIL_BYTES) return await fs.readFile(transcriptPath, 'utf8');

    return await readTailBytes(transcriptPath, stat.size);
  } catch {
    return undefined;
  }
}

/**
 * Stable identity for a transcript entry.
 *
 * Some transcript variants omit the message id. A content hash is stable
 * across retries and processes, so anonymous entries can still take part in
 * the persisted exactly-once claim ledger. Identical anonymous lines are
 * indistinguishable and intentionally deduplicate.
 *
 * @param rawId - The provider's own id, when it has one.
 * @param line - The verbatim line, used for the fallback hash.
 * @returns The id to key this entry by.
 */
export function messageIdFor(rawId: string | undefined, line: string): string {
  if (rawId) return rawId;

  return `${ANONYMOUS_MESSAGE_ID_PREFIX}${sha256Hex(line)}`;
}

/**
 * Sum the usage of deduplicated transcript entries.
 *
 * A turn's window can mix models (subagents, title generation), so the model
 * reported is the one that produced the most tokens — last-write-wins would
 * let a tiny side-call mislabel the whole turn and misprice it downstream.
 *
 * @param entries - Usage entries keyed by message id.
 * @returns The turn's usage, or undefined when there is nothing to report.
 */
export function accumulateUsage(entries: ReadonlyMap<string, TranscriptUsageEntry>): TurnUsage | undefined {
  if (entries.size === 0) return undefined;

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  const modelTokens = new Map<string, number>();

  for (const { model, usage } of entries.values()) {
    inputTokens = add(inputTokens, usage[TRANSCRIPT_INPUT_TOKENS]);
    outputTokens = add(outputTokens, usage[TRANSCRIPT_OUTPUT_TOKENS]);
    cachedInputTokens = add(cachedInputTokens, usage[TRANSCRIPT_CACHE_READ_TOKENS]);
    cacheCreationInputTokens = add(cacheCreationInputTokens, usage[TRANSCRIPT_CACHE_CREATION_TOKENS]);

    if (model) modelTokens.set(model, (modelTokens.get(model) ?? 0) + entryWeight(usage));
  }

  return {
    model: dominantModel(modelTokens),
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    messageIds: [...entries.keys()]
  };
}

/**
 * Read the last TRANSCRIPT_TAIL_BYTES of a file, dropping the partial first
 * line.
 *
 * @param transcriptPath - File to read.
 * @param size - Its current size.
 * @returns The tail text.
 */
async function readTailBytes(transcriptPath: string, size: number): Promise<string> {
  const handle = await fs.open(transcriptPath, 'r');

  try {
    const buffer = Buffer.alloc(TRANSCRIPT_TAIL_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TRANSCRIPT_TAIL_BYTES, size - TRANSCRIPT_TAIL_BYTES);
    const raw = buffer.subarray(0, bytesRead).toString('utf8');

    // Drop the first, almost certainly partial, line.
    return raw.slice(raw.indexOf('\n') + 1);
  } finally {
    await handle.close();
  }
}

/**
 * Decode one JSONL line.
 *
 * Unparseable lines are skipped rather than failing the read: a transcript
 * being appended to concurrently routinely ends mid-line.
 *
 * @param line - The line text.
 * @returns The object, or undefined when the line is not one.
 */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/**
 * Total tokens one entry accounts for, used to weight its model.
 *
 * @param usage - The entry's usage block.
 * @returns The token weight.
 */
function entryWeight(usage: Readonly<Record<string, unknown>>): number {
  let weight = 0;

  for (const field of TRANSCRIPT_TOKEN_FIELDS) weight += finiteOrZero(usage[field]);

  return weight;
}

/**
 * The model that produced the most tokens.
 *
 * @param modelTokens - Token weight per model.
 * @returns The dominant model, or undefined when none was named.
 */
function dominantModel(modelTokens: ReadonlyMap<string, number>): string | undefined {
  let dominant: string | undefined;
  let best = -1;

  for (const [model, tokens] of modelTokens) {
    if (tokens <= best) continue;

    dominant = model;
    best = tokens;
  }

  return dominant;
}

/**
 * Whether two passes read the same usage.
 *
 * @param left - One pass.
 * @param right - The other.
 * @returns True when they are equal.
 */
function sameUsage(left: TurnUsage, right: TurnUsage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
