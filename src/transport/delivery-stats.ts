import fs from 'node:fs/promises';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { acquireLock } from '../storage/lock.js';

export interface DeliveryStatsSnapshot {
  totalRejected: number;
  lastRejectedCount: number;
  lastRejectedAt: string;
  /** Events abandoned after maxAttempts or the age bound: real data loss. */
  totalDropped: number;
  lastDroppedCount: number;
  lastDroppedAt: string;
  /** Last non-retryable HTTP status the backend answered with, if any. */
  lastRefusalStatus: number;
  lastRefusalAt: string;
}

const LOCK_POLL_MS = 25;
/** Bounded: recordRejected runs on the hook path and must never stall it. */
const LOCK_MAX_WAIT_MS = 300;

/**
 * Persisted tally of everything the local queue lost, and why.
 *
 * Three separate outcomes, because they need three different fixes:
 *
 * - `rejected` — the backend accepted the batch and refused the event inside
 *   it. Never resent: the schema said no.
 * - `dropped` — the entry ran out of attempts or aged out. This is the one
 *   that used to be invisible: `drain` counted it and the caller threw the
 *   count away, so a backend answering 400 or 422 to everything looked exactly
 *   like a healthy queue right up to the moment the events were gone.
 * - `refusal` — the last non-retryable status seen. Without it a developer
 *   watching a growing backlog has no way to tell a dead endpoint from a
 *   rejected token from a schema mismatch.
 *
 * `agentwatch status` surfaces all three.
 */
export class DeliveryStats {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
    /** Serializes the read-modify-write across concurrent hook processes. */
    private readonly locksDir?: string
  ) {}

  async read(): Promise<DeliveryStatsSnapshot | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<DeliveryStatsSnapshot>;
      // A file written before the dropped/refusal counters existed still reads.
      if (typeof raw.totalRejected !== 'number' && typeof raw.totalDropped !== 'number' && typeof raw.lastRefusalStatus !== 'number') {
        return undefined;
      }
      return {
        totalRejected: numberOr(raw.totalRejected, 0),
        lastRejectedCount: numberOr(raw.lastRejectedCount, 0),
        lastRejectedAt: stringOr(raw.lastRejectedAt),
        totalDropped: numberOr(raw.totalDropped, 0),
        lastDroppedCount: numberOr(raw.lastDroppedCount, 0),
        lastDroppedAt: stringOr(raw.lastDroppedAt),
        lastRefusalStatus: numberOr(raw.lastRefusalStatus, 0),
        lastRefusalAt: stringOr(raw.lastRefusalAt)
      };
    } catch {
      return undefined;
    }
  }

  /** Never throws: stats are diagnostics and must not break the hook path. */
  async recordRejected(count: number): Promise<void> {
    await this.record(count, (current, at) => ({
      totalRejected: (current?.totalRejected ?? 0) + count,
      lastRejectedCount: count,
      lastRejectedAt: at
    }));
  }

  /** Events the queue gave up on. Never throws, for the same reason. */
  async recordDropped(count: number): Promise<void> {
    await this.record(count, (current, at) => ({
      totalDropped: (current?.totalDropped ?? 0) + count,
      lastDroppedCount: count,
      lastDroppedAt: at
    }));
  }

  /** A status the transport will not retry. Never throws. */
  async recordRefusal(status: number | undefined): Promise<void> {
    if (status === undefined) return;
    await this.record(1, (_current, at) => ({ lastRefusalStatus: status, lastRefusalAt: at }));
  }

  private async record(count: number, patch: (current: DeliveryStatsSnapshot | undefined, at: string) => Partial<DeliveryStatsSnapshot>): Promise<void> {
    if (count <= 0) return;
    // Two hooks can finish sends concurrently; without the lock one
    // increment of the read-modify-write below is silently lost. The lock is
    // polled for a bounded interval (the hook path must never stall); when it
    // still cannot be acquired — or locking itself fails — the write proceeds
    // unlocked best-effort: a rare lost increment beats losing the record
    // entirely. The guarantee is bounded-wait serialization, not mutual
    // exclusion under arbitrary contention.
    const release = await this.waitForLock();
    try {
      const current = await this.read();
      const next: DeliveryStatsSnapshot = { ...emptySnapshot(), ...current, ...patch(current, this.now().toISOString()) };
      await writeFileAtomic(this.file, JSON.stringify(next), 0o600);
    } catch {
      // Stats are diagnostics; failing to persist them must not break the hook.
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // The stale-lock breaker reclaims an unreleased lock after 30s.
        }
      }
    }
  }

  /** Poll for the lock up to LOCK_MAX_WAIT_MS; undefined means write unlocked. */
  private async waitForLock(): Promise<(() => Promise<void>) | undefined> {
    if (!this.locksDir) return undefined;
    // Real-time deadline on purpose: an injected test clock may be frozen.
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    for (;;) {
      try {
        const release = await acquireLock(this.locksDir, 'delivery-stats', this.now);
        if (release) return release;
      } catch {
        return undefined; // locking machinery failed; fall back to unlocked
      }
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

function emptySnapshot(): DeliveryStatsSnapshot {
  return {
    totalRejected: 0,
    lastRejectedCount: 0,
    lastRejectedAt: '',
    totalDropped: 0,
    lastDroppedCount: 0,
    lastDroppedAt: '',
    lastRefusalStatus: 0,
    lastRefusalAt: ''
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function stringOr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
