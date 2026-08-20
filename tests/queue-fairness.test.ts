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

  it('drains oldest-first by firstQueuedAt', async () => {
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

    await queue.drain(transport as never, 1);

    expect(sent[0]).toEqual(['evt_zzz_first']);
    await fs.rm(base, { recursive: true, force: true });
  });
});
