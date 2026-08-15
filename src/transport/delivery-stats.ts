import fs from 'node:fs/promises';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { acquireLock } from '../storage/lock.js';

export interface DeliveryStatsSnapshot {
  totalRejected: number;
  lastRejectedCount: number;
  lastRejectedAt: string;
}

/**
 * Persisted tally of events the backend accepted the batch for but rejected
 * individually. Rejected events are never resent — the schema refused them —
 * so this file is the only local trace that data was discarded;
 * `agentwatch status` surfaces it.
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
      if (typeof raw.totalRejected !== 'number') return undefined;
      return {
        totalRejected: raw.totalRejected,
        lastRejectedCount: typeof raw.lastRejectedCount === 'number' ? raw.lastRejectedCount : 0,
        lastRejectedAt: typeof raw.lastRejectedAt === 'string' ? raw.lastRejectedAt : ''
      };
    } catch {
      return undefined;
    }
  }

  /** Never throws: stats are diagnostics and must not break the hook path. */
  async recordRejected(count: number): Promise<void> {
    if (count <= 0) return;
    // Two hooks can finish sends concurrently; without the lock one
    // increment of the read-modify-write below is silently lost. When the
    // lock cannot be acquired (or locking itself fails), still record
    // best-effort: a rare lost increment beats losing the record entirely.
    let release: (() => Promise<void>) | undefined;
    if (this.locksDir) {
      try {
        release = await acquireLock(this.locksDir, 'delivery-stats', this.now);
      } catch {
        // fall through to an unlocked best-effort write
      }
    }
    try {
      const current = await this.read();
      const next: DeliveryStatsSnapshot = {
        totalRejected: (current?.totalRejected ?? 0) + count,
        lastRejectedCount: count,
        lastRejectedAt: this.now().toISOString()
      };
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
}
