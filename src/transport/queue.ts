import fs from 'node:fs/promises';
import path from 'node:path';
import { pollUntil } from '../core/async.js';
import { debugLog } from '../core/logger.js';
import { isProductEvent, type EventTypeCarrier, type ProductEvent } from '../events/product-event.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { acquireLock } from '../storage/lock.js';
import { claimSweep } from '../storage/sweep-marker.js';
import { SECRET_FILE_MODE, SWEEP_MARKER_FILE } from '../storage/constants/storage.constants.js';
import type { ReleaseLock } from '../storage/types/storage.types.js';
import type { BackendAuthBlock } from './auth-block.js';
import {
  ANY_DESTINATION,
  AUTH_REJECTED_STATUSES,
  BACKOFF_BASE_MS,
  BACKOFF_JITTER_MIN,
  BACKOFF_JITTER_RANGE,
  BACKOFF_MAX_MS,
  MAX_ISOLATION_SENDS,
  MS_PER_DAY,
  QUEUE_DRAIN_LOCK,
  QUEUE_FILE_SUFFIX,
  QUEUE_SCAN_CURSOR_FILE,
  QUEUE_SWEEP_INTERVAL_MS,
  RETARGET_LOCK_POLL_MS,
  RETARGET_LOCK_WAIT_MS,
  RE_UNSAFE_QUEUE_NAME
} from './constants/transport.constants.js';
import { sendEvents } from './send.js';
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
   * @param authBlock - Optional sink for a refused credential, so a rejected
   *   bearer suspends sending instead of spending the backlog's attempts on it.
   * @returns What the pass sent, failed, dropped and had rejected.
   */
  async drain(transport: EventTransport, maxBatch: number, statsRecorder?: DrainStatsRecorder, authBlock?: BackendAuthBlock): Promise<DrainStats> {
    const release = await acquireLock(this.options.locksDir, QUEUE_DRAIN_LOCK, this.now);

    if (!release) return { sent: 0, failed: 0, dropped: 0, rejected: 0, skipped: true };

    try {
      const nowMs = this.now().getTime();
      const swept = await this.sweepUnsendable(nowMs);
      const collected = await this.collectDue(transport, nowMs, maxBatch);
      // Oldest first among what was scanned: hash-ordered filenames would
      // otherwise let a large backlog defer the same late-sorting entries.
      const batch = collected.due
        .slice()
        .sort((a, b) => Date.parse(a.entry.firstQueuedAt) - Date.parse(b.entry.firstQueuedAt))
        .slice(0, maxBatch);
      const sent = batch.length === 0 ? EMPTY_DELTA : await this.sendBatch(transport, batch, nowMs, authBlock);
      const stats: DrainStats = { ...mergeDeltas(mergeDeltas(swept, collected.delta), sent), skipped: false };

      await report(statsRecorder, stats);

      return stats;
    } finally {
      await release();
    }
  }

  /**
   * Enforce retention across the whole partition, without sending anything.
   *
   * `drain` sweeps too, but every early return in `deliverEvents` skips a drain
   * — a tripped cooldown, and a credential the backend is refusing — and those
   * are precisely the multi-day outages the age bound exists for. A block has no
   * timer at all, so a revoked token used to mean nothing aged out until someone
   * fixed the credential, while `enforceBound` quietly shed the oldest records
   * at the ceiling. Sharing the marker with the drain's own sweep, so a hook
   * that does reach a drain still pays for only one pass.
   *
   * Takes no lock: every removal is idempotent, which is the same reason
   * `claimSweep` is unlocked.
   *
   * @param statsRecorder - Optional sink for what aged out.
   * @returns How many entries were removed.
   */
  async sweep(statsRecorder?: DrainStatsRecorder): Promise<number> {
    const { dropped } = await this.sweepUnsendable(this.now().getTime());

    if (dropped > 0) await statsRecorder?.recordDropped(dropped);

    return dropped;
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
   * step of the same decision the user just made. The entry is re-pinned in
   * place and then renamed, so a crash mid-move leaves one copy, never two — at
   * worst re-pinned but still in the old partition, where the next setup finds
   * it again.
   *
   * Runs under the drain lock so a concurrent drain cannot resurrect the old
   * destination from a stale in-memory copy.
   *
   * @param destination - The new events URL.
   * @param previousDestination - The URL being replaced.
   * @param targetDir - Partition of the identity that will send the re-pinned
   *   entries; this queue's own directory when the identity did not change.
   * @returns False when the lock never freed and nothing was re-pinned.
   */
  async retarget(destination: string, previousDestination: string, targetDir: string): Promise<boolean> {
    const release = await this.waitForDrainLock();

    if (!release) return false;

    try {
      await fs.mkdir(targetDir, { recursive: true });

      for (const name of await this.listFiles()) {
        const file = path.join(this.options.queueDir, name);
        const entry = await this.readEntry(file);

        if (!entry || entry.destination !== previousDestination) continue;

        await writeFileAtomic(file, JSON.stringify({ ...entry, destination }), SECRET_FILE_MODE);

        if (targetDir !== this.options.queueDir) await fs.rename(file, path.join(targetDir, name));
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
   * Reads at most `maxBatch` entries, whatever the backlog holds and whatever it
   * finds in them. Reading and zod-parsing the whole partition to find the few
   * entries a pass may send is what made an outage cost the developer up to
   * `maxQueueEvents` file reads on every hook, which AGENTS.md §3 forbids
   * outright. The bound is on entries *read*, not on entries found due: a
   * backlog where nothing is due — every entry in backoff, or every entry
   * pinned to a destination this identity no longer sends to, which is what a
   * changed endpoint leaves behind for a week — is exactly the case that would
   * otherwise walk all of it and send nothing.
   *
   * A hard read bound needs the scan to move, or the head of the sorted list
   * would be re-read on every pass and the tail never reached. So the scan
   * starts where the last one stopped and wraps around: every entry is examined
   * within `ceil(backlog / maxBatch)` passes, which is what FR-009 asks for —
   * no entry deferred forever. Losing the cursor costs one pass starting at the
   * head again.
   *
   * The batch is therefore the oldest of what this pass *scanned*, not of the
   * whole backlog. Global oldest-first would need a due-time index, which is
   * separate work.
   *
   * @param transport - Where the pass will send.
   * @param nowMs - This pass's clock reading.
   * @param maxBatch - Entries this pass may read; also its ceiling on sends.
   * @returns The due entries and what collecting them dropped.
   */
  private async collectDue(transport: EventTransport, nowMs: number, maxBatch: number): Promise<CollectedEntries> {
    const names = await this.listFiles();
    const start = await this.scanStart(names);
    const scan = [...names.slice(start), ...names.slice(0, start)].slice(0, maxBatch);
    const due: DueEntry[] = [];
    let dropped = 0;

    for (const name of scan) {
      const file = path.join(this.options.queueDir, name);
      const entry = await this.readEntry(file);

      if (!entry || this.isExpired(entry, nowMs) || !isProductEvent(entry.event as EventTypeCarrier)) {
        // Unreadable, aged out, or — for a backlog written by a pre-product
        // release — an internal lifecycle event the backend does not accept.
        // Draining one of those would poison every batch it rides in. Entries
        // past the scan are the throttled sweep's business, not this pass's.
        await fs.rm(file, { force: true });
        dropped += 1;
        continue;
      }

      if (!matchesDestination(entry.destination, transport.destination)) continue;

      if (Date.parse(entry.nextAttemptAt) <= nowMs) due.push({ file, entry });
    }

    const last = scan.at(-1);

    if (last !== undefined) await this.rememberScan(last);

    return { due, delta: { ...EMPTY_DELTA, dropped } };
  }

  /**
   * Index the next bounded scan starts at.
   *
   * The first name *after* the one last scanned, so an entry that was sent and
   * deleted in the meantime does not send the scan back to the head.
   *
   * @param names - This pass's sorted entry names.
   * @returns The starting index; zero when there is no cursor to resume from.
   */
  private async scanStart(names: readonly string[]): Promise<number> {
    const last = await this.lastScanned();

    if (last === undefined) return 0;

    const next = names.findIndex((name) => name > last);

    return next === -1 ? 0 : next;
  }

  /**
   * The entry name the previous pass stopped on.
   *
   * @returns The name, or undefined when nothing has scanned yet.
   */
  private async lastScanned(): Promise<string | undefined> {
    try {
      return (await fs.readFile(this.cursorFile(), 'utf8')) || undefined;
    } catch {
      // No cursor, or one we cannot read: start at the head. This is a hint for
      // fairness, not state anything depends on.
      return undefined;
    }
  }

  /**
   * Record where this pass stopped.
   *
   * @param name - The last entry name it read.
   */
  private async rememberScan(name: string): Promise<void> {
    try {
      // The same write as every other file in the partition, for the same
      // reason: it renames a 0600 temp file over the target, so a cursor
      // somebody pre-created as a symlink is replaced rather than followed.
      await writeFileAtomic(this.cursorFile(), name, SECRET_FILE_MODE);
    } catch {
      // Same rule as the sweep marker: the drain runs on the hook path, and
      // failing to remember a position must never fail the agent's turn.
    }
  }

  /**
   * Where the scan cursor lives.
   *
   * Not a `.json` name, so the entry listing never sees it.
   *
   * @returns Absolute path to the cursor file.
   */
  private cursorFile(): string {
    return path.join(this.options.queueDir, QUEUE_SCAN_CURSOR_FILE);
  }

  /**
   * Remove everything that can never be sent, wherever it sits in the partition.
   *
   * The bounded scan only ever sees the head of the backlog, so the retention
   * bound needs a pass that sees all of it. Throttled by a marker, because that
   * pass is the expensive one — and it is an improvement on what it replaces:
   * expiry used to be enforced only inside a drain, and a drain is skipped for
   * the whole cooldown window, so during a backend outage nothing aged out at
   * all. That was precisely the week-long case the bound exists for.
   *
   * @param nowMs - This pass's clock reading.
   * @returns What the sweep dropped, or nothing when it was not due.
   */
  private async sweepUnsendable(nowMs: number): Promise<DrainDelta> {
    // `Date.now()`, not `nowMs`: the throttle is a marker file's mtime, which is
    // real wall-clock time, and `nowMs` comes from the injectable clock. Compared
    // against each other a fixed test clock — or a backward NTP step in
    // production — makes `nowMs - last` negative forever, which reads as "not
    // due" and silences the retention pass for good. `TurnStateStore.sweep`
    // passes the wall clock here for the same reason. Expiry below still uses
    // `nowMs`, because that is a judgement about the entries, not about when this
    // process last swept.
    if (!(await claimSweep(path.join(this.options.queueDir, SWEEP_MARKER_FILE), QUEUE_SWEEP_INTERVAL_MS, Date.now()))) return EMPTY_DELTA;

    let dropped = 0;

    for (const name of await this.listFiles()) {
      const file = path.join(this.options.queueDir, name);
      const entry = await this.readEntry(file);

      if (entry && !this.isExpired(entry, nowMs) && isProductEvent(entry.event as EventTypeCarrier)) continue;

      await fs.rm(file, { force: true });
      dropped += 1;
    }

    return { ...EMPTY_DELTA, dropped };
  }

  /**
   * Send one batch, isolating a poison entry when the backend refuses it.
   *
   * @param transport - Where to send.
   * @param batch - Entries to send.
   * @param nowMs - This pass's clock reading.
   * @param authBlock - Optional sink for a refused credential.
   * @returns What the send accomplished and cost.
   */
  private async sendBatch(transport: EventTransport, batch: readonly DueEntry[], nowMs: number, authBlock?: BackendAuthBlock): Promise<DrainDelta> {
    const result = await sendEvents(transport, batch.map(({ entry }) => entry.event as unknown as ProductEvent));

    if (result.ok) {
      await Promise.all(batch.map(({ file }) => fs.rm(file, { force: true })));

      return { ...EMPTY_DELTA, sent: batch.length, rejected: reportRejected(result.counters?.rejected, 'the drained batch') };
    }

    if (result.deferred) return { ...EMPTY_DELTA, failed: batch.length };

    debugLog('queue drain failed', result.error ?? `status ${result.status}`);

    if (result.status !== undefined && AUTH_REJECTED_STATUSES.has(result.status)) {
      // The credential was refused, so nothing in this batch is at fault and
      // nothing about it may change: an attempt spent here would walk the whole
      // backlog to maxAttempts and delete it, which is the one thing the queue
      // exists to prevent. Raise the block instead and leave every entry due.
      if (authBlock && transport.destination) await authBlock.raise(transport.destination, result.status);

      return { ...EMPTY_DELTA, failed: batch.length };
    }

    if (!result.retryable && batch.length > 1) return this.isolateBatch(transport, batch, nowMs, authBlock);

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
   * @param authBlock - Persisted refusal, including one received by a single probe.
   * @returns What the probes accomplished and cost.
   */
  private async isolateBatch(transport: EventTransport, batch: readonly DueEntry[], nowMs: number, authBlock?: BackendAuthBlock): Promise<DrainDelta> {
    let delta = EMPTY_DELTA;
    let probes = 0;

    for (const { file, entry } of batch) {
      if (probes >= MAX_ISOLATION_SENDS) {
        delta = mergeDeltas(delta, await this.recordFailure(file, entry, nowMs));
        continue;
      }

      probes += 1;
      const single = await sendEvents(transport, [entry.event as unknown as ProductEvent]);

      if (single.deferred || (single.status !== undefined && AUTH_REJECTED_STATUSES.has(single.status))) {
        if (!single.deferred && single.status !== undefined && authBlock && transport.destination) await authBlock.raise(transport.destination, single.status);

        return mergeDeltas(delta, { ...EMPTY_DELTA, failed: batch.length - probes + 1 });
      }

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
  private listFiles(): Promise<string[]> {
    return listQueueFiles(this.options.queueDir);
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
   *
   * Reported through `options.stats`, like every other permanent loss: these
   * deletions used to be the one kind that left `totalDropped` at zero, so a
   * machine steadily shedding records at the bound looked, in `status`, exactly
   * like one that had never lost any.
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

    if (doomed.length > 0) await this.options.stats?.recordDropped(doomed.length);
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

/**
 * Queue entry filenames directly in a directory, sorted. Sub-directories are
 * other identities' partitions and never entries.
 *
 * @param dir - Directory to list.
 * @returns The names, or an empty list when the directory is absent.
 */
export async function listQueueFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((name) => name.endsWith(QUEUE_FILE_SUFFIX)).sort();
  } catch {
    return [];
  }
}
