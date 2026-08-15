import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PRODUCT_EVENT_TYPES } from '../events/canonical-event.js';
import type { ProductEvent } from '../events/product-event.js';
import type { EventTransport } from './transport.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { acquireLock } from '../storage/lock.js';
import { debugLog } from '../core/logger.js';

/**
 * Destination for events queued before any endpoint is configured: they are
 * explicitly waiting for whatever backend `setup` configures first. Legacy
 * entries without a destination have the same pre-setup behavior.
 */
export const ANY_DESTINATION = '*';

const queueEntrySchema = z
  .object({
    event: z.record(z.unknown()),
    attempts: z.number().int().nonnegative().default(0),
    firstQueuedAt: z.string(),
    nextAttemptAt: z.string(),
    /** Events URL this entry was queued for; absent on pre-destination entries. */
    destination: z.string().optional()
  })
  .passthrough();

export interface QueueOptions {
  queueDir: string;
  locksDir: string;
  maxEvents: number;
  maxAttempts: number;
  maxEventAgeDays: number;
  now?: () => Date;
}

export interface DrainStats {
  sent: number;
  failed: number;
  dropped: number;
  /** Events the backend accepted the batch for but rejected individually. */
  rejected: number;
  skipped: boolean;
}

/**
 * Bound on individual poison-isolation sends per drain pass. Drain runs on
 * the coding agent's hook critical path and each send may cost the full
 * transport timeout, so isolation must never stack up enough sends to trip
 * the agent's own hook timeout.
 */
const MAX_ISOLATION_SENDS = 3;

/**
 * File-per-event offline queue. The filename is the deterministic event id,
 * which makes enqueueing idempotent: the same event never queues twice.
 */
export class EventQueue {
  private readonly now: () => Date;

  constructor(private readonly options: QueueOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(events: ProductEvent[], destination?: string): Promise<void> {
    if (events.length === 0) return;
    await fs.mkdir(this.options.queueDir, { recursive: true });
    for (const event of events) {
      const file = this.fileFor(event.id);
      if (await exists(file)) continue; // dedup by deterministic id
      const entry = {
        event,
        attempts: 0,
        firstQueuedAt: this.now().toISOString(),
        nextAttemptAt: this.now().toISOString(),
        destination
      };
      await writeFileAtomic(file, JSON.stringify(entry), 0o600);
    }
    await this.enforceBound();
  }

  async pendingCount(): Promise<number> {
    return (await this.listFiles()).length;
  }

  async oldestPendingAgeMs(): Promise<number | undefined> {
    const files = await this.listFiles();
    if (files.length === 0) return undefined;
    let oldest: number | undefined;
    for (const file of files) {
      const entry = await this.readEntry(path.join(this.options.queueDir, file));
      if (!entry) continue;
      const queuedAt = Date.parse(entry.firstQueuedAt);
      if (Number.isFinite(queuedAt) && (oldest === undefined || queuedAt < oldest)) oldest = queuedAt;
    }
    return oldest === undefined ? undefined : this.now().getTime() - oldest;
  }

  /**
   * Send due queued events through the transport. Serialized by a lock so
   * concurrent hook invocations don't double-send; bounded by maxBatch.
   *
   * `statsRecorder.recordRejected` must not throw; failures must be swallowed
   * by the implementation — drain runs on the coding agent's hook critical
   * path and is not wrapped against recorder errors.
   */
  async drain(
    transport: EventTransport,
    maxBatch: number,
    statsRecorder?: { recordRejected(count: number): Promise<void> }
  ): Promise<DrainStats> {
    const release = await acquireLock(this.options.locksDir, 'queue-drain', this.now);
    if (!release) return { sent: 0, failed: 0, dropped: 0, rejected: 0, skipped: true };
    try {
      const stats: DrainStats = { sent: 0, failed: 0, dropped: 0, rejected: 0, skipped: false };
      const nowMs = this.now().getTime();
      const due: { file: string; entry: z.infer<typeof queueEntrySchema> }[] = [];

      for (const name of await this.listFiles()) {
        const file = path.join(this.options.queueDir, name);
        const entry = await this.readEntry(file);
        if (!entry) {
          await fs.rm(file, { force: true });
          stats.dropped++;
          continue;
        }
        if (this.isExpired(entry, nowMs)) {
          await fs.rm(file, { force: true });
          stats.dropped++;
          continue;
        }
        if (!isProductEntry(entry)) {
          // Backlog written by a pre-product release may hold internal
          // lifecycle events. The backend only accepts llm.call and
          // turn.summary; draining anything else would poison every batch
          // the legacy entry rides in.
          await fs.rm(file, { force: true });
          stats.dropped++;
          continue;
        }
        if (!matchesDestination(entry.destination, transport.destination)) {
          continue;
        }
        if (Date.parse(entry.nextAttemptAt) <= nowMs) {
          due.push({ file, entry });
        }
      }
      // Oldest first: hash-ordered filenames would otherwise let a large
      // backlog defer the same late-sorting entries on every drain.
      due.sort((a, b) => Date.parse(a.entry.firstQueuedAt) - Date.parse(b.entry.firstQueuedAt));
      const batch = due.slice(0, maxBatch);
      if (batch.length === 0) return stats;

      const events = batch.map(({ entry }) => entry.event as unknown as ProductEvent);
      const result = await transport.send(events);
      if (result.ok) {
        await Promise.all(batch.map(({ file }) => fs.rm(file, { force: true })));
        stats.sent = batch.length;
        const rejected = result.counters?.rejected ?? 0;
        if (rejected > 0) {
          stats.rejected += rejected;
          debugLog(`backend permanently rejected ${rejected} event(s) from the drained batch`);
          await statsRecorder?.recordRejected(rejected);
        }
        return stats;
      }

      debugLog('queue drain failed', result.error ?? `status ${result.status}`);
      if (!result.retryable && batch.length > 1) {
        // The backend rejected the batch outright, but that verdict belongs
        // to at most a few events. Retry entries alone so one poison record
        // cannot take its healthy co-batched neighbors down with it. The
        // probes are capped: drain runs inside the agent's hook process and
        // each send can cost the full transport timeout, so the remainder
        // keeps its backoff and is probed on later drains instead.
        let probes = 0;
        for (const { file, entry } of batch) {
          if (probes >= MAX_ISOLATION_SENDS) {
            await this.recordFailure(file, entry, nowMs, stats);
            continue;
          }
          probes++;
          const single = await transport.send([entry.event as unknown as ProductEvent]);
          if (single.ok) {
            await fs.rm(file, { force: true });
            stats.sent++;
            const rejected = single.counters?.rejected ?? 0;
            if (rejected > 0) {
              stats.rejected += rejected;
              debugLog(`backend permanently rejected ${rejected} event(s) from an isolation probe`);
              await statsRecorder?.recordRejected(rejected);
            }
          } else {
            await this.recordFailure(file, entry, nowMs, stats);
          }
        }
        return stats;
      }
      for (const { file, entry } of batch) {
        await this.recordFailure(file, entry, nowMs, stats);
      }
      return stats;
    } finally {
      await release();
    }
  }

  /**
   * Re-pin entries queued for `previousDestination` to `destination`. Setup
   * calls this — with the user's explicit consent — after the backend URL
   * changes, so the backlog follows instead of expiring pinned to a URL
   * nothing will ever drain. Entries pinned to any other backend stay
   * untouched: this re-routes one reconfigured destination, it is not a
   * license to replay one backend's data to another. Runs under the drain
   * lock so a concurrent drain cannot resurrect the old destination from a
   * stale in-memory copy; returns false when the lock never freed.
   */
  async retarget(destination: string, previousDestination: string): Promise<boolean> {
    const release = await this.waitForDrainLock();
    if (!release) return false;
    try {
      for (const name of await this.listFiles()) {
        const file = path.join(this.options.queueDir, name);
        const entry = await this.readEntry(file);
        if (!entry || entry.destination !== previousDestination) continue;
        await writeFileAtomic(file, JSON.stringify({ ...entry, destination }), 0o600);
      }
      return true;
    } finally {
      await release();
    }
  }

  /** Entries pinned to exactly this destination (legacy/ANY entries excluded). */
  async pendingFor(destination: string): Promise<number> {
    let count = 0;
    for (const name of await this.listFiles()) {
      const entry = await this.readEntry(path.join(this.options.queueDir, name));
      if (entry?.destination === destination) count++;
    }
    return count;
  }

  private async waitForDrainLock(maxWaitMs = 10_000): Promise<(() => Promise<void>) | undefined> {
    // Real-time deadline on purpose: an injected test clock may be frozen.
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() <= deadline) {
      const release = await acquireLock(this.options.locksDir, 'queue-drain', this.now);
      if (release) return release;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }

  /**
   * Rejected events back off and retry: even a "permanent" HTTP status can be
   * a transient route/schema mismatch on the backend, so an entry is dropped
   * only once maxAttempts (or the age bound) is exhausted — never on the
   * first refusal.
   */
  private async recordFailure(file: string, entry: z.infer<typeof queueEntrySchema>, nowMs: number, stats: DrainStats): Promise<void> {
    const attempts = entry.attempts + 1;
    if (attempts >= this.options.maxAttempts) {
      await fs.rm(file, { force: true });
      stats.dropped++;
      return;
    }
    const next = new Date(nowMs + backoffMs(attempts)).toISOString();
    await writeFileAtomic(file, JSON.stringify({ ...entry, attempts, nextAttemptAt: next }), 0o600);
    stats.failed++;
  }

  private fileFor(eventId: string): string {
    const safe = eventId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.options.queueDir, `${safe}.json`);
  }

  private async listFiles(): Promise<string[]> {
    try {
      const names = await fs.readdir(this.options.queueDir);
      return names.filter((name) => name.endsWith('.json')).sort();
    } catch {
      return [];
    }
  }

  private async readEntry(file: string): Promise<z.infer<typeof queueEntrySchema> | undefined> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = queueEntrySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private isExpired(entry: z.infer<typeof queueEntrySchema>, nowMs: number): boolean {
    const ageMs = nowMs - Date.parse(entry.firstQueuedAt);
    return ageMs > this.options.maxEventAgeDays * 24 * 60 * 60 * 1000;
  }

  /** Keep the queue bounded: entries that have waited longest are sacrificed first. */
  private async enforceBound(): Promise<void> {
    const files = await this.listFiles();
    const excess = files.length - this.options.maxEvents;
    if (excess <= 0) return;
    const withAge = await Promise.all(
      files.map(async (name) => {
        const full = path.join(this.options.queueDir, name);
        const entry = await this.readEntry(full);
        if (entry) return { full, queuedAt: Date.parse(entry.firstQueuedAt) };
        try {
          // Unreadable entry: fall back to the file clock so it still ages out.
          const stat = await fs.stat(full);
          return { full, queuedAt: stat.mtimeMs };
        } catch {
          return undefined;
        }
      })
    );
    const sorted = withAge
      .filter((file): file is { full: string; queuedAt: number } => Boolean(file))
      .sort((a, b) => a.queuedAt - b.queuedAt);
    for (const { full } of sorted.slice(0, excess)) {
      await fs.rm(full, { force: true });
    }
  }
}

/**
 * Entries pinned to another backend are never re-routed at drain time; they
 * wait for their own backend, or for `retarget` when setup reconfigures the
 * URL. Legacy entries without destination metadata predate destination
 * pinning, so they flow to the first configured backend just like
 * ANY_DESTINATION entries.
 */
function matchesDestination(entry: string | undefined, transport: string | undefined): boolean {
  if (entry === undefined || entry === ANY_DESTINATION) return true;
  return entry === transport;
}

function isProductEntry(entry: z.infer<typeof queueEntrySchema>): boolean {
  const type = (entry.event as { event?: { type?: unknown } }).event?.type;
  return typeof type === 'string' && (PRODUCT_EVENT_TYPES as readonly string[]).includes(type);
}

function backoffMs(attempts: number): number {
  const base = Math.min(5000 * 2 ** (attempts - 1), 6 * 60 * 60 * 1000);
  return Math.floor(base * (0.75 + Math.random() * 0.5));
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
