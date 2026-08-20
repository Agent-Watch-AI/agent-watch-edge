import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpTransport } from '../src/transport/http-transport.js';
import { deliverEvents } from '../src/transport/delivery.js';
import { DeliveryStats } from '../src/transport/delivery-stats.js';
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

function tempDirs() {
  const base = path.join(os.tmpdir(), `aw-stats-${Math.random().toString(36).slice(2)}`);
  return {
    queueDir: path.join(base, 'queue'),
    locksDir: path.join(base, 'locks'),
    statsFile: path.join(base, 'delivery-stats.json')
  };
}

describe('rejected-event accounting', () => {
  it('transport surfaces the response counters', async () => {
    const transport = new HttpTransport({
      eventsUrl: 'https://backend.example/v1/events',
      timeoutMs: 1000,
      fetchFn: async () =>
        new Response(JSON.stringify({ accepted: 1, duplicate: 0, rejected: 2, failed: 0 }), {
          status: 202,
          headers: { 'content-type': 'application/json' }
        })
    });

    const result = await transport.send([summary('evt_a')]);

    expect(result.ok).toBe(true);
    expect(result.counters).toEqual({ accepted: 1, duplicate: 0, rejected: 2, failed: 0 });
  });

  it('deliverEvents persists a running rejected tally', async () => {
    const dirs = tempDirs();
    try {
      const queue = new EventQueue({
        queueDir: dirs.queueDir,
        locksDir: dirs.locksDir,
        maxEvents: 100,
        maxAttempts: 5,
        maxEventAgeDays: 7
      });
      const transport = new HttpTransport({
        eventsUrl: 'https://backend.example/v1/events',
        timeoutMs: 1000,
        fetchFn: async () =>
          new Response(JSON.stringify({ accepted: 0, duplicate: 0, rejected: 1, failed: 0 }), {
            status: 202,
            headers: { 'content-type': 'application/json' }
          })
      });
      const stats = new DeliveryStats(dirs.statsFile);

      const outcome = await deliverEvents([summary('evt_b')], transport, queue, 25, undefined, stats);

      expect(outcome.rejected).toBe(1);
      const snapshot = await stats.read();
      expect(snapshot?.totalRejected).toBe(1);
      expect(snapshot?.lastRejectedCount).toBe(1);
    } finally {
      await fs.rm(path.dirname(dirs.queueDir), { recursive: true, force: true });
    }
  });

  it('sequential records accumulate the running total', async () => {
    const dirs = tempDirs();
    try {
      const stats = new DeliveryStats(dirs.statsFile, undefined, dirs.locksDir);

      await stats.recordRejected(1);
      await stats.recordRejected(2);

      const snapshot = await stats.read();
      expect(snapshot?.totalRejected).toBe(3);
      expect(snapshot?.lastRejectedCount).toBe(2);
    } finally {
      await fs.rm(path.dirname(dirs.queueDir), { recursive: true, force: true });
    }
  });

  it('waits for a held lock and records once it frees', async () => {
    const dirs = tempDirs();
    try {
      const stats = new DeliveryStats(dirs.statsFile, undefined, dirs.locksDir);
      await stats.recordRejected(1);

      // Simulate another hook holding the lock; free it mid-wait.
      const lockFile = path.join(dirs.locksDir, 'delivery-stats.lock');
      await fs.mkdir(dirs.locksDir, { recursive: true });
      await fs.writeFile(lockFile, JSON.stringify({ pid: 0, at: new Date().toISOString() }));
      const started = Date.now();
      const pending = stats.recordRejected(2);
      setTimeout(() => {
        void fs.rm(lockFile, { force: true });
      }, 60);
      await pending;

      // It genuinely waited for the lock instead of falling straight through
      // to the unlocked write.
      expect(Date.now() - started).toBeGreaterThanOrEqual(50);
      const snapshot = await stats.read();
      expect(snapshot?.totalRejected).toBe(3);
      expect(snapshot?.lastRejectedCount).toBe(2);
    } finally {
      await fs.rm(path.dirname(dirs.queueDir), { recursive: true, force: true });
    }
  });

  it('falls back to a best-effort unlocked write when the lock never frees', async () => {
    const dirs = tempDirs();
    try {
      const stats = new DeliveryStats(dirs.statsFile, undefined, dirs.locksDir);
      await stats.recordRejected(1);

      // Lock held for the whole bounded wait (fresh enough to not be stale-broken).
      const lockFile = path.join(dirs.locksDir, 'delivery-stats.lock');
      await fs.mkdir(dirs.locksDir, { recursive: true });
      await fs.writeFile(lockFile, JSON.stringify({ pid: 0, at: new Date().toISOString() }));

      await stats.recordRejected(2);

      // The record still lands: bounded wait expired, then unlocked best-effort.
      const snapshot = await stats.read();
      expect(snapshot?.totalRejected).toBe(3);
      expect(snapshot?.lastRejectedCount).toBe(2);
    } finally {
      await fs.rm(path.dirname(dirs.queueDir), { recursive: true, force: true });
    }
  });
});

describe('lost-event accounting', () => {
  it('records events the queue gave up on, instead of losing them silently', async () => {
    const dirs = tempDirs();
    try {
      const queue = new EventQueue({
        queueDir: dirs.queueDir,
        locksDir: dirs.locksDir,
        maxEvents: 100,
        maxAttempts: 1,
        maxEventAgeDays: 7
      });
      const stats = new DeliveryStats(dirs.statsFile, () => new Date('2026-08-20T10:00:00.000Z'), dirs.locksDir);
      // A backend that refuses everything: the batch is queued, the single
      // permitted attempt fails, and the entry is abandoned.
      const transport = new HttpTransport({
        eventsUrl: 'https://backend.example/v1/events',
        timeoutMs: 1000,
        fetchFn: async () => new Response('{"message":"schema_invalid"}', { status: 422 })
      });

      await queue.enqueue([summary('evt_lost')], transport.destination);
      const drained = await queue.drain(transport, 10, stats);

      expect(drained.dropped).toBe(1);
      expect(await queue.pendingCount()).toBe(0);
      const snapshot = await stats.read();
      expect(snapshot?.totalDropped).toBe(1);
      expect(snapshot?.lastDroppedAt).toBe('2026-08-20T10:00:00.000Z');
    } finally {
      await fs.rm(path.dirname(dirs.queueDir), { recursive: true, force: true });
    }
  });

  it('records the status a refused direct send came back with', async () => {
    const dirs = tempDirs();
    try {
      const queue = new EventQueue({
        queueDir: dirs.queueDir,
        locksDir: dirs.locksDir,
        maxEvents: 100,
        maxAttempts: 5,
        maxEventAgeDays: 7
      });
      const stats = new DeliveryStats(dirs.statsFile, () => new Date('2026-08-20T10:00:00.000Z'), dirs.locksDir);
      const transport = new HttpTransport({
        eventsUrl: 'https://backend.example/v1/events',
        timeoutMs: 1000,
        fetchFn: async () => new Response('{"message":"no event passed validation"}', { status: 422 })
      });

      const outcome = await deliverEvents([summary('evt_refused')], transport, queue, 10, undefined, stats);

      // The event is kept — a permanent status can be a temporary backend bug —
      // but the reason it was kept is now on the record.
      expect(outcome.queued).toBe(1);
      const snapshot = await stats.read();
      expect(snapshot?.lastRefusalStatus).toBe(422);
      expect(snapshot?.lastRefusalAt).toBe('2026-08-20T10:00:00.000Z');
    } finally {
      await fs.rm(path.dirname(dirs.queueDir), { recursive: true, force: true });
    }
  });
});
