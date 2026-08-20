import fs from 'node:fs/promises';
import { pollUntil } from '../core/async.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { acquireLock } from '../storage/lock.js';
import { SECRET_FILE_MODE } from '../storage/constants/storage.constants.js';
import type { ReleaseLock } from '../storage/types/storage.types.js';
import { DELIVERY_STATS_LOCK, STATS_LOCK_MAX_WAIT_MS, STATS_LOCK_POLL_MS } from './constants/transport.constants.js';
import type { DeliveryStatsSnapshot } from './types/transport.types.js';

export type { DeliveryStatsSnapshot } from './types/transport.types.js';

/** Builds the fields one record call changes. */
type SnapshotPatch = (current: DeliveryStatsSnapshot | undefined, at: string) => Partial<DeliveryStatsSnapshot>;

/**
 * Persisted tally of everything the local queue lost, and why.
 *
 * See {@link DeliveryStatsSnapshot} for what the three outcomes mean and why
 * they are counted separately. `agentwatch status` surfaces all of them.
 */
export class DeliveryStats {
  /**
   * Bind the tally to its file and lock directory.
   *
   * @param file - Where the tally is persisted.
   * @param now - Clock, injectable for tests.
   * @param locksDir - Serializes the read-modify-write across hook processes.
   */
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
    private readonly locksDir?: string
  ) {}

  /**
   * Read the tally.
   *
   * @returns The snapshot, or undefined when there is nothing recorded.
   */
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

  /**
   * Note events the backend refused inside an accepted batch. Never throws.
   *
   * @param count - How many were refused.
   */
  async recordRejected(count: number): Promise<void> {
    await this.record(count, (current, at) => ({
      totalRejected: (current?.totalRejected ?? 0) + count,
      lastRejectedCount: count,
      lastRejectedAt: at
    }));
  }

  /**
   * Note events the queue gave up on. Never throws, for the same reason.
   *
   * @param count - How many were lost.
   */
  async recordDropped(count: number): Promise<void> {
    await this.record(count, (current, at) => ({
      totalDropped: (current?.totalDropped ?? 0) + count,
      lastDroppedCount: count,
      lastDroppedAt: at
    }));
  }

  /**
   * Note a status the transport will not retry. Never throws.
   *
   * @param status - The refusing HTTP status, when there was one.
   */
  async recordRefusal(status: number | undefined): Promise<void> {
    if (status === undefined) return;

    await this.record(1, (_current, at) => ({ lastRefusalStatus: status, lastRefusalAt: at }));
  }

  /**
   * Apply one patch to the persisted tally.
   *
   * Two hooks can finish sends concurrently, and without the lock one increment
   * of this read-modify-write is silently lost. The lock is polled for a bounded
   * interval — the hook path must never stall — and when it still cannot be
   * acquired the write proceeds unlocked: a rare lost increment beats losing the
   * record entirely. The guarantee is bounded-wait serialization, not mutual
   * exclusion under arbitrary contention.
   *
   * @param count - How many events this call is about; zero is a no-op.
   * @param patch - Builds the fields to change.
   */
  private async record(count: number, patch: SnapshotPatch): Promise<void> {
    if (count <= 0) return;

    const release = await this.waitForLock();

    try {
      const current = await this.read();
      const next: DeliveryStatsSnapshot = { ...emptySnapshot(), ...current, ...patch(current, this.now().toISOString()) };

      await writeFileAtomic(this.file, JSON.stringify(next), SECRET_FILE_MODE);
    } catch {
      // Stats are diagnostics; failing to persist them must not break the hook.
    } finally {
      await releaseQuietly(release);
    }
  }

  /**
   * Acquire the stats lock, waiting a bounded time.
   *
   * @returns The release function, or undefined to write unlocked.
   */
  private async waitForLock(): Promise<ReleaseLock | undefined> {
    if (!this.locksDir) return undefined;

    try {
      return await pollUntil(() => acquireLock(this.locksDir!, DELIVERY_STATS_LOCK, this.now), STATS_LOCK_MAX_WAIT_MS, STATS_LOCK_POLL_MS);
    } catch {
      // The locking machinery itself failed; fall back to unlocked.
      return undefined;
    }
  }
}

/**
 * Release a lock without letting the failure escape.
 *
 * @param release - The release function, when one was acquired.
 */
async function releaseQuietly(release: ReleaseLock | undefined): Promise<void> {
  if (!release) return;

  try {
    await release();
  } catch {
    // The stale-lock breaker reclaims an unreleased lock after 30s.
  }
}

/**
 * A tally with nothing recorded yet.
 *
 * @returns The zero snapshot.
 */
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

/**
 * A number, or a fallback.
 *
 * @param value - Candidate of unknown shape.
 * @param fallback - Value to use instead.
 * @returns The number.
 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/**
 * A string, or the empty string.
 *
 * @param value - Candidate of unknown shape.
 * @returns The string.
 */
function stringOr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
