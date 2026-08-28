import fs from 'node:fs/promises';
import path from 'node:path';
import { pollUntil } from '../core/async.js';
import { debugLog } from '../core/logger.js';
import { PRODUCT_EVENT_TYPE_SET } from '../events/constants/events.constants.js';
import type { ProductEvent } from '../events/product-event.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { acquireLock } from '../storage/lock.js';
import { SECRET_FILE_MODE } from '../storage/constants/storage.constants.js';
import type { ReleaseLock } from '../storage/types/storage.types.js';
import {
  ANY_DESTINATION,
  BACKOFF_BASE_MS,
  BACKOFF_JITTER_MIN,
  BACKOFF_JITTER_RANGE,
  BACKOFF_MAX_MS,
  MAX_ISOLATION_SENDS,
  MS_PER_DAY,
  QUEUE_DRAIN_LOCK,
  QUEUE_FILE_SUFFIX,
  RETARGET_LOCK_POLL_MS,
  RETARGET_LOCK_WAIT_MS,
  RE_UNSAFE_QUEUE_NAME
} from './constants/transport.constants.js';
import { queueEntrySchema } from './schemas/queue.schema.js';
import type { DrainStats, DrainStatsRecorder, DueEntry, EventTransport, QueueEntry, QueueOptions } from './types/transport.types.js';

export { ANY_DESTINATION } from './constants/transport.constants.js';
export type { DrainStats, DrainStatsRecorder, QueueEntry, QueueOptions } from './types/transport.types.js';

/**
 * File-per-event offline queue.
 *
 * The filename *is* the deterministic event id, which is what makes enqueueing
 * idempotent: the same event can never be queued twice, however many hooks race
 * to write it.
 */
export class EventQueue {
  private readonly now: () => Date;

  /**
   * Bind the queue to its directories and bounds.
   *
   * @param options - Directories, bounds and the clock.
   */
  constructor(private readonly options: QueueOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Persist events for a later attempt.
   *
   * @param events - Events to keep.
   * @param destination - Events URL they are pinned to, when one is configured.
   */
  async enqueue(events: readonly ProductEvent[], destination?: string): Promise<void> {
    if (events.length === 0) return;

    await fs.mkdir(this.options.queueDir, { recursive: true });

    for (const event of events) {
      const file = this.fileFor(event.id);

      if (await exists(file)) continue; // dedup by deterministic id

      const at = this.now().toISOString();

      // 0600: a queued turn summary holds prompt and response text.
      await writeFileAtomic(file, JSON.stringify({ event, attempts: 0, firstQueuedAt: at, nextAttemptAt: at, destination }), SECRET_FILE_MODE);
    }

    await this.enforceBound();
  }

  /**
   * How many events are waiting.
   *
   * @returns The entry count.
   */
  async pendingCount(): Promise<number> {
    return (await this.listFiles()).length;
  }

  /**
   * Age of the oldest waiting event.
   *
   * @returns Milliseconds, or undefined when the queue is empty.
   */
  async oldestPendingAgeMs(): Promise<number | undefined> {
    let oldest: number | undefined;

    for (const name of await this.listFiles()) {
      const entry = await this.readEntry(path.join(this.options.queueDir, name));
      const queuedAt = entry ? Date.parse(entry.firstQueuedAt) : NaN;

      if (!Number.isFinite(queuedAt)) continue;

      if (oldest === undefined || queuedAt < oldest) oldest = queuedAt;
    }

    if (oldest === undefined) return undefined;

    return this.now().getTime() - oldest;
  }

  /**
   * Send due queued events through the transport.
   *
   * Serialized by a lock so concurrent hook invocations cannot double-send, and
   * bounded by maxBatch because this runs inside the agent's hook process.
   *
   * The recorder's methods must not throw: failures have to be swallowed by the
   * implementation, because drain is on the critical path and is not wrapped
   * against recorder errors.
   *
   * @param transport - Where to send.
   * @param maxBatch - Ceiling on events sent in one pass.
   * @param statsRecorder - Optional sink for what this pass lost.
   * @returns What the pass sent, failed, dropped and had rejected.
   */
  async drain(transport: EventTransport, maxBatch: number, statsRecorder?: DrainStatsRecorder): Promise<DrainStats> {
    const release = await acquireLock(this.options.locksDir, QUEUE_DRAIN_LOCK, this.now);

    if (!release) return { sent: 0, failed: 0, dropped: 0, rejected: 0, skipped: true };

    try {
      const nowMs = this.now().getTime();
      const collected = await this.collectDue(transport, nowMs);
      // Oldest first: hash-ordered filenames would otherwise let a large
      // backlog defer the same late-sorting entries on every drain.
      const batch = collected.due
        .slice()
        .sort((a, b) => Date.parse(a.entry.firstQueuedAt) - Date.parse(b.entry.firstQueuedAt))
        .slice(0, maxBatch);
      const sent = batch.length === 0 ? EMPTY_DELTA : await this.sendBatch(transport, batch, nowMs);
      const stats: DrainStats = { ...mergeDeltas(collected.delta, sent), skipped: false };

      await report(statsRecorder, stats);

      return stats;
    } finally {
      await release();
    }
  }

  /**
   * Re-pin entries queued for one destination to another, and hand them to the
   * identity that will send them.
   *
   * Setup calls this — with the user's explicit consent — after the backend URL
   * changes, so the backlog follows instead of expiring pinned to a URL nothing
   * will ever drain. Entries pinned to any *other* backend stay untouched: this
   * re-routes one reconfigured destination, it is not a license to replay one
   * backend's data to another.
   *
   * `targetDir` exists because re-enrolling usually changes the token too, and
   * a queue is partitioned by identity: leaving the entries where they are would
   * re-pin a backlog no partition drains. Moving them is a second consent-gated
   * step of the same decision the user just made, and the new copy is written
   * before the old one is removed, so a crash mid-move duplicates rather than
   * loses — and the deterministic filename makes the duplicate a no-op.
   *
   * Runs under the drain lock so a concurrent drain cannot resurrect the old
   * destination from a stale in-memory copy.
   *
   * @param destination - The new events URL.
   * @param previousDestination - The URL being replaced.
   * @param targetDir - Partition to move the re-pinned entries into; defaults to
   *   this queue's own, which is what an unchanged identity wants.
   * @returns False when the lock never freed and nothing was re-pinned.
   */
  async retarget(destination: string, previousDestination: string, targetDir?: string): Promise<boolean> {
    const release = await this.waitForDrainLock();

    if (!release) return false;

    const home = targetDir ?? this.options.queueDir;

    try {
      await fs.mkdir(home, { recursive: true });

      for (const name of await this.listFiles()) {
        const file = path.join(this.options.queueDir, name);
        const entry = await this.readEntry(file);

        if (!entry || entry.destination !== previousDestination) continue;

        const moved = path.join(home, name);

        await writeFileAtomic(moved, JSON.stringify({ ...entry, destination }), SECRET_FILE_MODE);

        if (moved !== file) await fs.rm(file, { force: true });
      }

      return true;
    } finally {
      await release();
    }
  }

  /**
   * Entries pinned to exactly this destination; legacy and ANY entries are not
   * counted, because they are not stranded.
   *
   * @param destination - Events URL to count for.
   * @returns The entry count.
   */
  async pendingFor(destination: string): Promise<number> {
    let count = 0;

    for (const name of await this.listFiles()) {
      const entry = await this.readEntry(path.join(this.options.queueDir, name));

      if (entry?.destination === destination) count++;
    }

    return count;
  }

  /**
   * Entries due for this transport, dropping the ones that can never be sent.
   *
   * @param transport - Where the pass will send.
   * @param nowMs - This pass's clock reading.
   * @returns The due entries and what collecting them dropped.
   */
  private async collectDue(transport: EventTransport, nowMs: number): Promise<CollectedEntries> {
    const due: DueEntry[] = [];
    let dropped = 0;

    for (const name of await this.listFiles()) {
      const file = path.join(this.options.queueDir, name);
      const entry = await this.readEntry(file);

      if (!entry || this.isExpired(entry, nowMs) || !isProductEntry(entry)) {
        // Unreadable, aged out, or — for a backlog written by a pre-product
        // release — an internal lifecycle event the backend does not accept.
        // Draining one of those would poison every batch it rides in.
        await fs.rm(file, { force: true });
        dropped += 1;
        continue;
      }

      if (!matchesDestination(entry.destination, transport.destination)) continue;

      if (Date.parse(entry.nextAttemptAt) <= nowMs) due.push({ file, entry });
    }

    return { due, delta: { ...EMPTY_DELTA, dropped } };
  }

  /**
   * Send one batch, isolating a poison entry when the backend refuses it.
   *
   * @param transport - Where to send.
   * @param batch - Entries to send.
   * @param nowMs - This pass's clock reading.
   * @returns What the send accomplished and cost.
   */
  private async sendBatch(transport: EventTransport, batch: readonly DueEntry[], nowMs: number): Promise<DrainDelta> {
    const result = await transport.send(batch.map(({ entry }) => entry.event as unknown as ProductEvent));

    if (result.ok) {
      await Promise.all(batch.map(({ file }) => fs.rm(file, { force: true })));

      return { ...EMPTY_DELTA, sent: batch.length, rejected: reportRejected(result.counters?.rejected, 'the drained batch') };
    }

    debugLog('queue drain failed', result.error ?? `status ${result.status}`);

    if (!result.retryable && batch.length > 1) return this.isolateBatch(transport, batch, nowMs);

    let delta = EMPTY_DELTA;

    for (const { file, entry } of batch) {
      delta = mergeDeltas(delta, await this.recordFailure(file, entry, nowMs));
    }

    return delta;
  }

  /**
   * Retry a refused batch one entry at a time.
   *
   * The backend rejected the batch outright, but that verdict belongs to at most
   * a few events. Sending entries alone stops one poison record taking its
   * healthy co-batched neighbours down with it. The probes are capped: drain runs
   * inside the agent's hook process and each send can cost the full transport
   * timeout, so the remainder keeps its backoff and is probed on a later drain.
   *
   * @param transport - Where to send.
   * @param batch - Entries the batch send refused.
   * @param nowMs - This pass's clock reading.
   * @returns What the probes accomplished and cost.
   */
  private async isolateBatch(transport: EventTransport, batch: readonly DueEntry[], nowMs: number): Promise<DrainDelta> {
    let delta = EMPTY_DELTA;
    let probes = 0;

    for (const { file, entry } of batch) {
      if (probes >= MAX_ISOLATION_SENDS) {
        delta = mergeDeltas(delta, await this.recordFailure(file, entry, nowMs));
        continue;
      }

      probes += 1;
      const single = await transport.send([entry.event as unknown as ProductEvent]);

      if (!single.ok) {
        delta = mergeDeltas(delta, await this.recordFailure(file, entry, nowMs));
        continue;
      }

      await fs.rm(file, { force: true });
      delta = mergeDeltas(delta, { ...EMPTY_DELTA, sent: 1, rejected: reportRejected(single.counters?.rejected, 'an isolation probe') });
    }

    return delta;
  }

  /**
   * Acquire the drain lock, waiting a bounded time.
   *
   * @returns The release function, or undefined on timeout.
   */
  private waitForDrainLock(): Promise<ReleaseLock | undefined> {
    return pollUntil(() => acquireLock(this.options.locksDir, QUEUE_DRAIN_LOCK, this.now), RETARGET_LOCK_WAIT_MS, RETARGET_LOCK_POLL_MS);
  }

  /**
   * Back a failed entry off, or drop it once its budget is spent.
   *
   * Even a "permanent" HTTP status can be a transient route or schema mismatch
   * on the backend, so an entry is dropped only once maxAttempts (or the age
   * bound) is exhausted — never on the first refusal.
   *
   * @param file - The entry's file.
   * @param entry - The entry.
   * @param nowMs - This pass's clock reading.
   * @returns Whether the entry was backed off or lost.
   */
  private async recordFailure(file: string, entry: QueueEntry, nowMs: number): Promise<DrainDelta> {
    const attempts = entry.attempts + 1;

    if (attempts >= this.options.maxAttempts) {
      // Out of attempts: the event is gone for good, which is exactly what the
      // dropped counter has to survive to say.
      debugLog(`dropping a queued event after ${attempts} failed attempt(s)`);
      await fs.rm(file, { force: true });

      return { ...EMPTY_DELTA, dropped: 1 };
    }

    const nextAttemptAt = new Date(nowMs + backoffMs(attempts)).toISOString();

    await writeFileAtomic(file, JSON.stringify({ ...entry, attempts, nextAttemptAt }), SECRET_FILE_MODE);

    return { ...EMPTY_DELTA, failed: 1 };
  }

  /**
   * File one event is queued in.
   *
   * @param eventId - The deterministic event id.
   * @returns Absolute file path.
   */
  private fileFor(eventId: string): string {
    return path.join(this.options.queueDir, `${eventId.replace(RE_UNSAFE_QUEUE_NAME, '_')}${QUEUE_FILE_SUFFIX}`);
  }

  /**
   * Queue filenames, sorted.
   *
   * @returns The names, or an empty list when the directory is absent.
   */
  private async listFiles(): Promise<string[]> {
    try {
      const names = await fs.readdir(this.options.queueDir);

      return names.filter((name) => name.endsWith(QUEUE_FILE_SUFFIX)).sort();
    } catch {
      return [];
    }
  }

  /**
   * Read and validate one entry.
   *
   * @param file - Entry file.
   * @returns The entry, or undefined when it cannot be used.
   */
  private async readEntry(file: string): Promise<QueueEntry | undefined> {
    try {
      const parsed = queueEntrySchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));

      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether an entry has outlived the age bound.
   *
   * @param entry - The entry.
   * @param nowMs - This pass's clock reading.
   * @returns True when it should be dropped.
   */
  private isExpired(entry: QueueEntry, nowMs: number): boolean {
    return nowMs - Date.parse(entry.firstQueuedAt) > this.options.maxEventAgeDays * MS_PER_DAY;
  }

  /**
   * Keep the queue bounded, sacrificing the entries that have waited longest.
   *
   * The oldest are the least likely to still be deliverable, and an unbounded
   * queue on a developer machine is a disk-space bug.
   */
  private async enforceBound(): Promise<void> {
    const files = await this.listFiles();
    const excess = files.length - this.options.maxEvents;

    if (excess <= 0) return;

    const dated: { full: string; queuedAt: number }[] = [];

    for (const name of files) {
      const full = path.join(this.options.queueDir, name);
      const queuedAt = await this.queuedAt(full);

      if (queuedAt !== undefined) dated.push({ full, queuedAt });
    }

    const doomed = dated.sort((a, b) => a.queuedAt - b.queuedAt).slice(0, excess);

    for (const { full } of doomed) {
      await fs.rm(full, { force: true });
    }
  }

  /**
   * When an entry was first queued, falling back to the file clock.
   *
   * An unreadable entry still has to age out, or it would pin the queue at its
   * bound forever.
   *
   * @param full - Entry file.
   * @returns Epoch milliseconds, or undefined when the file vanished.
   */
  private async queuedAt(full: string): Promise<number | undefined> {
    const entry = await this.readEntry(full);

    if (entry) return Date.parse(entry.firstQueuedAt);

    try {
      return (await fs.stat(full)).mtimeMs;
    } catch {
      return undefined;
    }
  }
}

/** What one step of a drain pass accomplished and cost. */
type DrainDelta = Omit<DrainStats, 'skipped'>;

/** Due entries, plus what collecting them already dropped. */
interface CollectedEntries {
  readonly due: readonly DueEntry[];
  readonly delta: DrainDelta;
}

const EMPTY_DELTA: DrainDelta = { sent: 0, failed: 0, dropped: 0, rejected: 0 };

/**
 * Combine what two steps of a pass accomplished.
 *
 * @param left - One step's delta.
 * @param right - The next step's delta.
 * @returns Their sum.
 */
function mergeDeltas(left: DrainDelta, right: DrainDelta): DrainDelta {
  return {
    sent: left.sent + right.sent,
    failed: left.failed + right.failed,
    dropped: left.dropped + right.dropped,
    rejected: left.rejected + right.rejected
  };
}

/**
 * Log events the backend permanently refused inside an accepted batch.
 *
 * @param rejected - Count the backend reported.
 * @param source - What to name in the diagnostic.
 * @returns The count, normalized to a number.
 */
function reportRejected(rejected: number | undefined, source: string): number {
  if (!rejected || rejected <= 0) return 0;

  debugLog(`backend permanently rejected ${rejected} event(s) from ${source}`);

  return rejected;
}

/**
 * Persist what this pass lost.
 *
 * Called once per drain rather than at each drop site: the stats file is
 * lock-serialized, and one write per pass keeps drain off the critical path.
 *
 * @param recorder - Sink, when the caller supplied one.
 * @param stats - What the pass lost.
 */
async function report(recorder: DrainStatsRecorder | undefined, stats: DrainStats): Promise<void> {
  if (!recorder) return;

  if (stats.rejected > 0) await recorder.recordRejected(stats.rejected);

  if (stats.dropped > 0) await recorder.recordDropped(stats.dropped);
}

/**
 * Whether an entry may be sent to this transport.
 *
 * Entries pinned to another backend are never re-routed at drain time; they wait
 * for their own backend, or for `retarget` when setup reconfigures the URL.
 * Legacy entries without destination metadata predate pinning, so they flow to
 * the first configured backend just like ANY_DESTINATION entries.
 *
 * @param entry - The entry's pinned destination.
 * @param transport - The transport's destination.
 * @returns True when the entry belongs to this transport.
 */
function matchesDestination(entry: string | undefined, transport: string | undefined): boolean {
  if (entry === undefined || entry === ANY_DESTINATION) return true;

  return entry === transport;
}

/**
 * Whether a queued record is one the backend still accepts.
 *
 * @param entry - The entry.
 * @returns True for an llm.call or turn.summary.
 */
function isProductEntry(entry: QueueEntry): boolean {
  const type = (entry.event as { event?: { type?: unknown } }).event?.type;

  return typeof type === 'string' && PRODUCT_EVENT_TYPE_SET.has(type);
}

/**
 * Backoff for the nth attempt, with jitter.
 *
 * The jitter matters: without it every entry of a refused batch retries in the
 * same millisecond, so the backend gets the same thundering herd it just failed.
 *
 * @param attempts - Attempts made so far, including this failure.
 * @returns Delay in milliseconds.
 */
function backoffMs(attempts: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);

  return Math.floor(base * (BACKOFF_JITTER_MIN + Math.random() * BACKOFF_JITTER_RANGE));
}

/**
 * Whether a file exists.
 *
 * @param file - Path to test.
 * @returns True when it does.
 */
async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);

    return true;
  } catch {
    return false;
  }
}
