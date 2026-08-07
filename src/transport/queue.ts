import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AgentWatchEvent } from '../events/canonical-event.js';
import type { EventTransport } from './transport.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { acquireLock } from '../storage/lock.js';
import { debugLog } from '../core/logger.js';

const queueEntrySchema = z
  .object({
    event: z.record(z.unknown()),
    attempts: z.number().int().nonnegative().default(0),
    firstQueuedAt: z.string(),
    nextAttemptAt: z.string()
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
  skipped: boolean;
}

/**
 * File-per-event offline queue. The filename is the deterministic event id,
 * which makes enqueueing idempotent: the same event never queues twice.
 */
export class EventQueue {
  private readonly now: () => Date;

  constructor(private readonly options: QueueOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(events: AgentWatchEvent[]): Promise<void> {
    if (events.length === 0) return;
    await fs.mkdir(this.options.queueDir, { recursive: true });
    for (const event of events) {
      const file = this.fileFor(event.id);
      if (await exists(file)) continue; // dedup by deterministic id
      const entry = {
        event,
        attempts: 0,
        firstQueuedAt: this.now().toISOString(),
        nextAttemptAt: this.now().toISOString()
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
      try {
        const stat = await fs.stat(path.join(this.options.queueDir, file));
        if (oldest === undefined || stat.mtimeMs < oldest) oldest = stat.mtimeMs;
      } catch {
        // removed concurrently
      }
    }
    return oldest === undefined ? undefined : this.now().getTime() - oldest;
  }

  /**
   * Send due queued events through the transport. Serialized by a lock so
   * concurrent hook invocations don't double-send; bounded by maxBatch.
   */
  async drain(transport: EventTransport, maxBatch: number): Promise<DrainStats> {
    const release = await acquireLock(this.options.locksDir, 'queue-drain', this.now);
    if (!release) return { sent: 0, failed: 0, dropped: 0, skipped: true };
    try {
      const stats: DrainStats = { sent: 0, failed: 0, dropped: 0, skipped: false };
      const nowMs = this.now().getTime();
      const due: { file: string; entry: z.infer<typeof queueEntrySchema> }[] = [];

      for (const name of await this.listFiles()) {
        if (due.length >= maxBatch) break;
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
        if (Date.parse(entry.nextAttemptAt) <= nowMs) {
          due.push({ file, entry });
        }
      }
      if (due.length === 0) return stats;

      const events = due.map(({ entry }) => entry.event as unknown as AgentWatchEvent);
      const result = await transport.send(events);
      if (result.ok) {
        await Promise.all(due.map(({ file }) => fs.rm(file, { force: true })));
        stats.sent = due.length;
        return stats;
      }

      debugLog('queue drain failed', result.error ?? `status ${result.status}`);
      for (const { file, entry } of due) {
        const attempts = entry.attempts + 1;
        if (!result.retryable || attempts >= this.options.maxAttempts) {
          await fs.rm(file, { force: true });
          stats.dropped++;
          continue;
        }
        const next = new Date(nowMs + backoffMs(attempts)).toISOString();
        await writeFileAtomic(file, JSON.stringify({ ...entry, attempts, nextAttemptAt: next }), 0o600);
        stats.failed++;
      }
      return stats;
    } finally {
      await release();
    }
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

  /** Keep the queue bounded: oldest entries are sacrificed first. */
  private async enforceBound(): Promise<void> {
    const files = await this.listFiles();
    const excess = files.length - this.options.maxEvents;
    if (excess <= 0) return;
    const withTimes = await Promise.all(
      files.map(async (name) => {
        const full = path.join(this.options.queueDir, name);
        try {
          const stat = await fs.stat(full);
          return { full, mtime: stat.mtimeMs };
        } catch {
          return undefined;
        }
      })
    );
    const sorted = withTimes.filter((f): f is { full: string; mtime: number } => Boolean(f)).sort((a, b) => a.mtime - b.mtime);
    for (const { full } of sorted.slice(0, excess)) {
      await fs.rm(full, { force: true });
    }
  }
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
