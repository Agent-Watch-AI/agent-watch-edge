import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventQueue } from '../src/transport/queue.js';

function summary(id: string) {
  return {
    schemaVersion: '1',
    id,
    timestamp: '2026-08-15T10:00:00.000Z',
    event: { type: 'turn.summary', providerEventType: 'turn.summary' },
    agent: { provider: 'claude-code', name: 'claude-code' },
    session: { id: 'session-1' },
    provider: 'claude-code',
    surface: 'cli',
    tool_calls: 0,
    tools_used: {},
    usage_status: 'pending',
    ended_at: '2026-08-15T10:00:00.000Z'
  } as never;
}

function dirs() {
  const base = path.join(os.tmpdir(), `aw-queue-${Math.random().toString(36).slice(2)}`);

  return { base, queueDir: path.join(base, 'queue'), locksDir: path.join(base, 'locks') };
}

describe('queue fairness', () => {
  it('evicts by firstQueuedAt, not by file mtime', async () => {
    const { base, queueDir, locksDir } = dirs();
    let nowMs = Date.parse('2026-08-15T10:00:00Z');
    const queue = new EventQueue({
      queueDir,
      locksDir,
      maxEvents: 2,
      maxAttempts: 20,
      maxEventAgeDays: 7,
      now: () => new Date(nowMs)
    });

    await queue.enqueue([summary('evt_old')]);
    nowMs += 60_000;
    await queue.enqueue([summary('evt_mid')]);

    // A retry rewrites the oldest entry, refreshing its mtime.
    const failing = {
      async send() {
        return { ok: false, retryable: true, error: 'HTTP 500' } as const;
      },
      destination: undefined
    };

    await queue.drain(failing as never, 10);

    nowMs += 60_000;
    await queue.enqueue([summary('evt_new')]);

    const remaining = await fs.readdir(queueDir);

    // The bound is 2: the entry that has genuinely waited longest (evt_old)
    // is sacrificed, even though its retry made its file the newest on disk.
    expect(remaining.some((name) => name.includes('evt_old'))).toBe(false);
    expect(remaining.some((name) => name.includes('evt_mid'))).toBe(true);
    expect(remaining.some((name) => name.includes('evt_new'))).toBe(true);
    await fs.rm(base, { recursive: true, force: true });
  });

  it('reports the oldest pending age from firstQueuedAt', async () => {
    const { base, queueDir, locksDir } = dirs();
    let nowMs = Date.parse('2026-08-15T10:00:00Z');
    const queue = new EventQueue({
      queueDir,
      locksDir,
      maxEvents: 10,
      maxAttempts: 20,
      maxEventAgeDays: 7,
      now: () => new Date(nowMs)
    });

    await queue.enqueue([summary('evt_aged')]);
    nowMs += 3_600_000;

    expect(await queue.oldestPendingAgeMs()).toBe(3_600_000);
    await fs.rm(base, { recursive: true, force: true });
  });

  it('sends the oldest first among the entries one pass scans, and starves none', async () => {
    // A pass reads only as many entries as it may send, so the batch is the
    // oldest of what it *scanned*, not of the whole backlog: global age order
    // would mean reading and parsing every entry on every hook. What must hold
    // is that no entry is deferred forever — a sent entry is deleted and a
    // refused one takes a backoff, so the scan always moves on.
    const { base, queueDir, locksDir } = dirs();
    let nowMs = Date.parse('2026-08-15T10:00:00Z');
    const queue = new EventQueue({
      queueDir,
      locksDir,
      maxEvents: 10,
      maxAttempts: 20,
      maxEventAgeDays: 7,
      now: () => new Date(nowMs)
    });

    // Enqueue in an order whose hash order differs from age order.
    await queue.enqueue([summary('evt_zzz_first')]);
    nowMs += 1000;
    await queue.enqueue([summary('evt_aaa_second')]);

    const sent: string[][] = [];
    const transport = {
      async send(events: { id: string }[]) {
        sent.push(events.map((event) => event.id));

        return { ok: true, retryable: false } as const;
      },
      destination: undefined
    };

    // One entry per pass: both leave, each exactly once, and the queue empties.
    await queue.drain(transport as never, 1);
    await queue.drain(transport as never, 1);

    expect(sent.flat().sort()).toEqual(['evt_aaa_second', 'evt_zzz_first']);
    expect(await queue.pendingCount()).toBe(0);

    // A pass that scans both orders them by age, not by filename.
    await queue.enqueue([summary('evt_zzz_first')]);
    nowMs += 1000;
    await queue.enqueue([summary('evt_aaa_second')]);
    sent.length = 0;
    await queue.drain(transport as never, 2);

    expect(sent[0]).toEqual(['evt_zzz_first', 'evt_aaa_second']);
    await fs.rm(base, { recursive: true, force: true });
  });

  it('reads a number of entries bounded by the batch size, whatever the backlog holds', async () => {
    const { base, queueDir, locksDir } = dirs();
    const queue = new EventQueue({ queueDir, locksDir, maxEvents: 500, maxAttempts: 20, maxEventAgeDays: 7 });

    await queue.enqueue(Array.from({ length: 200 }, (_, index) => summary(`evt_${index}`)));
    expect(await queue.pendingCount()).toBe(200);

    // The sweep already ran on that enqueue's own pass, so this drain measures
    // the bounded scan alone.
    await queue.drain({ async send() { return { ok: true, retryable: false } as const; }, destination: undefined } as never, 5);

    const opened = await countOpenedEntries(queueDir, () =>
      queue.drain({ async send() { return { ok: true, retryable: false } as const; }, destination: undefined } as never, 5)
    );

    // Five sent, so at most five parsed. Without the bound this was 195. The
    // lower bound proves the counter is actually seeing the reads.
    expect(opened).toBeGreaterThan(0);
    expect(opened).toBeLessThanOrEqual(5);
    await fs.rm(base, { recursive: true, force: true });
  });
});

/**
 * How many queue entry files a call reads, counted by patching `fs.readFile`.
 *
 * @param queueDir - Partition whose entries to count.
 * @param run - The call to measure.
 * @returns The number of distinct entry reads it made.
 */
async function countOpenedEntries(queueDir: string, run: () => Promise<unknown>): Promise<number> {
  const real = fs.readFile.bind(fs);
  let reads = 0;

  (fs as { readFile: typeof fs.readFile }).readFile = ((file: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
    if (typeof file === 'string' && file.startsWith(queueDir) && file.endsWith('.json')) reads += 1;

    return (real as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFile;

  try {
    await run();
  } finally {
    (fs as { readFile: typeof fs.readFile }).readFile = real;
  }

  return reads;
}
