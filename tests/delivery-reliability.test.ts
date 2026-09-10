import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config/config.js';
import { buildCliContext, buildTransport } from '../src/cli/context.js';
import type { ProductEvent } from '../src/events/product-event.js';
import { BackendAuthBlock } from '../src/transport/auth-block.js';
import { BackendCooldown } from '../src/transport/cooldown.js';
import { deliverEvents } from '../src/transport/delivery.js';
import { DeliveryStats } from '../src/transport/delivery-stats.js';
import { HttpTransport } from '../src/transport/http-transport.js';
import { EventQueue } from '../src/transport/queue.js';
import { resolvePaths } from '../src/storage/paths.js';
import { makeTempEnv, readJson, writeJson, type TempWorld } from './helpers.js';

const DESTINATION = 'https://backend.example.com/v1/events';

function event(id: string): ProductEvent {
  return { id, event: { type: 'turn.summary' }, timestamp: '2026-09-10T10:00:00Z' } as ProductEvent;
}

describe('delivery preserves records across partial responses and failures', () => {
  let world: TempWorld;
  let queue: EventQueue;
  let queueDir: string;

  beforeEach(async () => {
    world = await makeTempEnv();
    queueDir = path.join(world.home, 'queue');
    queue = new EventQueue({ queueDir, locksDir: path.join(world.home, 'locks'), maxEvents: 100, maxAttempts: 2, maxEventAgeDays: 7 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await world.cleanup();
  });

  it('replays a partially accepted batch with the same IDs and keeps usage unique at the backend', async () => {
    const accepted = new Set<string>();
    const requests: string[][] = [];
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 1000, fetchFn: async (_url, init) => {
      const ids = (JSON.parse(String(init?.body)) as { events: ProductEvent[] }).events.map((value) => value.id);

      requests.push(ids);

      if (requests.length === 1) {
        accepted.add(ids[0]!);

        return Response.json({ accepted: 1, duplicate: 0, rejected: 0, failed: 1 }, { status: 202 });
      }

      const duplicate = ids.filter((id) => accepted.has(id)).length;

      for (const id of ids) accepted.add(id);

      return Response.json({ accepted: ids.length - duplicate, duplicate, rejected: 0, failed: 0 }, { status: 202 });
    } });
    const outcome = await deliverEvents([event('one'), event('two')], transport, queue, 10);

    expect(outcome).toMatchObject({ delivered: 0, queued: 2 });
    expect(await queue.pendingCount()).toBe(2);
    expect(await queue.drain(transport, 10)).toMatchObject({ sent: 2 });
    expect(requests[1]).toEqual(expect.arrayContaining(['one', 'two']));
    expect(accepted.size).toBe(2);
    expect(await queue.pendingCount()).toBe(0);
  });

  it('does not delete a queued batch on a partial 2xx response', async () => {
    await queue.enqueue([event('one'), event('two')], DESTINATION);

    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 1000, fetchFn: async () => Response.json({ accepted: 1, failed: 1 }, { status: 202 }) });

    expect(await queue.drain(transport, 10)).toMatchObject({ sent: 0, failed: 2 });
    expect(await queue.pendingCount()).toBe(2);
  });

  it('queues when an adapter throws and persists before optional diagnostics run', async () => {
    const stats = new DeliveryStats(path.join(world.home, 'stats.json'));

    vi.spyOn(stats, 'recordRefusal').mockRejectedValue(new Error('diagnostic write failed'));

    await expect(deliverEvents([event('refused')], { destination: DESTINATION, send: async () => ({ ok: false, retryable: false, status: 400 }) }, queue, 10, undefined, stats)).rejects.toThrow('diagnostic write failed');
    expect(await queue.pendingCount()).toBe(1);

    const outcome = await deliverEvents([event('thrown')], { destination: DESTINATION, send: async () => { throw new Error('secret request details'); } }, queue, 10);

    expect(outcome.queued).toBe(1);
    expect(await queue.pendingCount()).toBe(2);
  });

  it.each([401, 403])('stops isolation on %s without spending record attempts', async (status) => {
    await queue.enqueue([event('one'), event('two'), event('three')], DESTINATION);

    const send = vi.fn().mockResolvedValueOnce({ ok: false, retryable: false, status: 400 }).mockResolvedValue({ ok: false, retryable: false, status });
    const block = new BackendAuthBlock(path.join(world.home, 'auth.json'));

    expect(await queue.drain({ destination: DESTINATION, send }, 10, undefined, block)).toMatchObject({ sent: 0, failed: 3 });
    expect(send).toHaveBeenCalledTimes(2);
    expect((await block.active(DESTINATION))?.status).toBe(status);

    for (const name of (await fs.readdir(queueDir)).filter((name) => name.endsWith('.json'))) {
      expect((await readJson(path.join(queueDir, name))).attempts).toBe(0);
    }
  });

  it('shares one network deadline across direct delivery and drain without charging deferred retries', async () => {
    await queue.enqueue([event('backlog')], DESTINATION);

    let nowMs = 0;
    const fetchFn = vi.fn(async () => {
      nowMs = 100;

      return Response.json({ accepted: 1, failed: 0 });
    });
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 100, deadline: 100, nowMs: () => nowMs, fetchFn });
    const outcome = await deliverEvents([event('current')], transport, queue, 10);

    expect(outcome).toMatchObject({ delivered: 1, drained: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await queue.pendingCount()).toBe(1);
    expect((await readJson(path.join(queueDir, 'backlog.json'))).attempts).toBe(0);
  });

  it('does not trip backend cooldown when a local deadline prevents the request', async () => {
    const cooldown = new BackendCooldown(path.join(world.home, 'cooldown.json'));
    const fetchFn = vi.fn();
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 100, deadline: 100, nowMs: () => 100, fetchFn });

    expect((await deliverEvents([event('deferred')], transport, queue, 10, cooldown)).queued).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await cooldown.active()).toBe(false);
    expect(await queue.pendingCount()).toBe(1);
  });

  it('stops isolation when the deadline expires and keeps the unattempted entries due', async () => {
    await queue.enqueue([event('one'), event('two')], DESTINATION);

    let nowMs = 0;
    const fetchFn = vi.fn(async () => {
      nowMs = 100;

      return new Response(null, { status: 400 });
    });
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 100, deadline: 100, nowMs: () => nowMs, fetchFn });

    expect(await queue.drain(transport, 10)).toMatchObject({ sent: 0, failed: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await queue.pendingCount()).toBe(2);

    for (const name of ['one.json', 'two.json']) expect((await readJson(path.join(queueDir, name))).attempts).toBe(0);
  });

  it('applies the shared deadline to transports built by CLI commands', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, { ...defaultConfig(), endpoint: 'https://backend.example.com', delivery: { timeoutMs: 1 } });

    const fetchFn = vi.fn();

    vi.stubGlobal('fetch', fetchFn);

    const transport = buildTransport(await buildCliContext(world.env));

    try {
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(await transport?.send([event('late')])).toMatchObject({ ok: false, deferred: true });
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
