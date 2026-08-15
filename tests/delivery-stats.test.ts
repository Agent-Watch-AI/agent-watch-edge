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
    await fs.rm(path.dirname(dirs.queueDir), { recursive: true, force: true });
  });
});
