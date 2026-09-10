import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
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

  it('retries gateway partial-publish 503 with original IDs within the receiver dedupe window', async () => {
    const accepted = new Set<string>();
    const requests: string[][] = [];
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 1000, fetchFn: async (_url, init) => {
      const ids = (JSON.parse(String(init?.body)) as { events: ProductEvent[] }).events.map((value) => value.id);

      requests.push(ids);

      if (requests.length === 1) {
        accepted.add(ids[0]!);

        return Response.json({ statusCode: 503, message: 'Some events could not be published; retry the batch' }, { status: 503 });
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

  it('records accepted-batch rejections, clears cooldown and continues draining on 202', async () => {
    await queue.enqueue([event('backlog-one'), event('backlog-two')], DESTINATION);

    const cooldown = new BackendCooldown(path.join(world.home, 'cooldown.json'));
    const clear = vi.spyOn(cooldown, 'clear');
    const block = new BackendAuthBlock(path.join(world.home, 'auth.json'));
    const clearBlock = vi.spyOn(block, 'clear');
    const stats = new DeliveryStats(path.join(world.home, 'stats.json'));
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 1000, fetchFn: async () => Response.json({ accepted: 1, rejected: 1, failed: 0 }, { status: 202 }) });
    const outcome = await deliverEvents([event('one'), event('two')], transport, queue, 10, cooldown, stats, block);

    expect(outcome).toMatchObject({ delivered: 2, queued: 0, drained: 2, rejected: 2 });
    expect(clear).toHaveBeenCalled();
    expect(clearBlock).toHaveBeenCalled();
    expect(await cooldown.active()).toBe(false);
    expect((await stats.read())?.totalRejected).toBe(2);
    expect(await queue.pendingCount()).toBe(0);
  });

  it('does not reinterpret custom accepted-batch failed counters as HTTP outages', async () => {
    const cooldown = new BackendCooldown(path.join(world.home, 'cooldown.json'));
    const stats = new DeliveryStats(path.join(world.home, 'stats.json'));
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 1000, fetchFn: async () => Response.json({ accepted: 6, rejected: 3, failed: 1 }, { status: 202 }) });

    expect(await deliverEvents([event('one')], transport, queue, 10, cooldown, stats)).toMatchObject({ queued: 0, rejected: 3 });
    expect(await cooldown.active()).toBe(false);
    expect((await stats.read())?.totalRejected).toBe(3);
  });

  it('preserves the original filesystem failure and identifies the failed stage', async () => {
    const cause = Object.assign(new Error('disk full'), { code: 'ENOSPC', path: queueDir });

    vi.spyOn(queue, 'enqueue').mockRejectedValue(cause);

    await expect(deliverEvents([event('one')], undefined, queue, 10)).rejects.toMatchObject({ message: 'delivery failed at preserve-unsent: disk full', cause });
  });

  it('runs retention maintenance while cooldown skips delivery', async () => {
    const cooldown = new BackendCooldown(path.join(world.home, 'cooldown.json'));

    await cooldown.trip(60_000);

    const sweep = vi.spyOn(queue, 'sweep');
    const send = vi.fn();

    await deliverEvents([event('one')], { destination: DESTINATION, send }, queue, 10, cooldown);

    expect(send).not.toHaveBeenCalled();
    expect(sweep).toHaveBeenCalledOnce();
    expect(await queue.pendingCount()).toBe(1);
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

  it.each([100, 99.6, 99.5])('defers drain at clock %s without charging retries', async (clock) => {
    await queue.enqueue([event('backlog')], DESTINATION);

    let nowMs = 0;
    const fetchFn = vi.fn(async () => {
      nowMs = clock;

      return Response.json({ accepted: 1, failed: 0 });
    });
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 100, deadline: 100, nowMs: () => nowMs, fetchFn });
    const outcome = await deliverEvents([event('current')], transport, queue, 10);

    expect(outcome).toMatchObject({ delivered: 1, drained: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await queue.pendingCount()).toBe(1);
    expect((await readJson(path.join(queueDir, 'backlog.json'))).attempts).toBe(0);
  });

  it.each([100, 99.6, 99.5])('does not trip cooldown when clock %s prevents the request', async (clock) => {
    const cooldown = new BackendCooldown(path.join(world.home, 'cooldown.json'));
    const fetchFn = vi.fn();
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 100, deadline: 100, nowMs: () => clock, fetchFn });

    expect((await deliverEvents([event('deferred')], transport, queue, 10, cooldown)).queued).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await cooldown.active()).toBe(false);
    expect(await queue.pendingCount()).toBe(1);
  });

  it.each([100, 99.6])('stops isolation at clock %s and keeps unattempted entries due', async (clock) => {
    await queue.enqueue([event('one'), event('two')], DESTINATION);

    let nowMs = 0;
    const fetchFn = vi.fn(async () => {
      nowMs = clock;

      return new Response(null, { status: 400 });
    });
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 100, deadline: 100, nowMs: () => nowMs, fetchFn });

    expect(await queue.drain(transport, 10)).toMatchObject({ sent: 0, failed: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await queue.pendingCount()).toBe(2);

    for (const name of ['one.json', 'two.json']) expect((await readJson(path.join(queueDir, name))).attempts).toBe(0);
  });

  it('keeps CLI transports reusable after construction and between sends', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, { ...defaultConfig(), endpoint: 'https://backend.example.com', delivery: { timeoutMs: 1 } });

    const fetchFn = vi.fn(async () => Response.json({ accepted: 1 }));

    vi.stubGlobal('fetch', fetchFn);

    const transport = buildTransport(await buildCliContext(world.env));

    try {
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(await transport?.send([event('late')])).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await transport?.send([event('later')])).toMatchObject({ ok: true });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('starts a hook budget on first send and shares it with later requests', async () => {
    let nowMs = 0;
    const fetchFn = vi.fn(async () => Response.json({ accepted: 1 }));
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 100, budgetMs: 100, nowMs: () => nowMs, fetchFn });

    nowMs = 1000;
    expect(await transport.send([event('first')])).toMatchObject({ ok: true });
    nowMs = 1099.6;
    expect(await transport.send([event('second')])).toMatchObject({ deferred: true });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('does not charge a shortened request that exhausts the remaining pass budget', async () => {
    await queue.enqueue([event('one')], DESTINATION);

    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 100, deadline: 100, nowMs: () => 80, fetchFn: async () => { throw new DOMException('budget elapsed', 'TimeoutError'); } });

    expect(await queue.drain(transport, 10)).toMatchObject({ sent: 0, failed: 1 });
    expect((await readJson(path.join(queueDir, 'one.json'))).attempts).toBe(0);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null])('ignores invalid counters %s', async (value) => {
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 100, fetchFn: async () => Response.json({ accepted: value, duplicate: value, rejected: value, failed: value }) });

    expect((await transport.send([event('one')])).counters).toEqual({ accepted: 0, duplicate: 0, rejected: 0, failed: 0 });
  });

  it('cancels unread non-success response bodies', async () => {
    const cancel = vi.fn();
    const transport = new HttpTransport({ eventsUrl: DESTINATION, timeoutMs: 100, fetchFn: async () => new Response(new ReadableStream({ cancel }), { status: 503 }) });

    expect(await transport.send([event('one')])).toMatchObject({ ok: false, status: 503 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('refuses a real redirect without sending a bearer or records to its target', async () => {
    const target = vi.fn();
    const origin = vi.fn();
    const server = createServer((request, response) => {
      if (request.url === '/target') {
        target(request.headers.authorization);
        response.end('{}');

        return;
      }

      origin(request.headers.authorization);
      response.writeHead(302, { location: '/target' });
      response.end();
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();

    if (!address || typeof address === 'string') throw new Error('missing port');

    try {
      const transport = new HttpTransport({ eventsUrl: `http://127.0.0.1:${address.port}/events`, token: 'test-only-bearer', timeoutMs: 1000 });

      expect(await transport.send([event('one')])).toMatchObject({ ok: false });
      expect(origin).toHaveBeenCalledWith('Bearer test-only-bearer');
      expect(target).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
