import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventQueue } from '../src/transport/queue.js';
import { HttpTransport } from '../src/transport/http-transport.js';
import type { DeliveryResult, EventTransport } from '../src/transport/transport.js';
import type { AgentWatchEvent } from '../src/events/canonical-event.js';
import { deliverEvents } from '../src/transport/delivery.js';
import { makeTempEnv, type TempWorld } from './helpers.js';

function makeEvent(id: string): AgentWatchEvent {
  return {
    schemaVersion: '1',
    id,
    timestamp: new Date().toISOString(),
    event: { type: 'prompt.submitted', providerEventType: 'UserPromptSubmit' },
    agent: { provider: 'claude', name: 'Claude Code' },
    session: { id: 's1' }
  };
}

class FakeTransport implements EventTransport {
  calls: AgentWatchEvent[][] = [];
  constructor(private readonly result: DeliveryResult) {}
  async send(events: AgentWatchEvent[]): Promise<DeliveryResult> {
    this.calls.push(events);
    return this.result;
  }
}

describe('EventQueue', () => {
  let world: TempWorld;
  let queue: EventQueue;

  beforeEach(async () => {
    world = await makeTempEnv();
    queue = new EventQueue({
      queueDir: path.join(world.home, 'q'),
      locksDir: path.join(world.home, 'locks'),
      maxEvents: 5,
      maxAttempts: 3,
      maxEventAgeDays: 7
    });
  });

  afterEach(async () => {
    await world.cleanup();
  });

  it('persists events and dedupes by event id', async () => {
    await queue.enqueue([makeEvent('evt_1'), makeEvent('evt_1'), makeEvent('evt_2')]);
    expect(await queue.pendingCount()).toBe(2);
    await queue.enqueue([makeEvent('evt_1')]);
    expect(await queue.pendingCount()).toBe(2);
  });

  it('drains successfully and clears the queue', async () => {
    await queue.enqueue([makeEvent('evt_1'), makeEvent('evt_2')]);
    const transport = new FakeTransport({ ok: true, retryable: false });
    const stats = await queue.drain(transport, 10);
    expect(stats.sent).toBe(2);
    expect(await queue.pendingCount()).toBe(0);
    expect(transport.calls).toHaveLength(1);
  });

  it('keeps events with backoff on retryable failure', async () => {
    await queue.enqueue([makeEvent('evt_1')]);
    const transport = new FakeTransport({ ok: false, retryable: true, error: 'HTTP 503' });
    const stats = await queue.drain(transport, 10);
    expect(stats.failed).toBe(1);
    expect(await queue.pendingCount()).toBe(1);
    // Not due yet: an immediate second drain sends nothing.
    const again = await queue.drain(new FakeTransport({ ok: true, retryable: false }), 10);
    expect(again.sent).toBe(0);
  });

  it('drops events after maxAttempts and on non-retryable failure', async () => {
    await queue.enqueue([makeEvent('evt_permanent')]);
    const transport = new FakeTransport({ ok: false, retryable: false, error: 'HTTP 400' });
    const stats = await queue.drain(transport, 10);
    expect(stats.dropped).toBe(1);
    expect(await queue.pendingCount()).toBe(0);
  });

  it('bounds the queue size', async () => {
    await queue.enqueue(Array.from({ length: 9 }, (_, i) => makeEvent(`evt_${i}`)));
    expect(await queue.pendingCount()).toBeLessThanOrEqual(5);
  });

  it('never delivers a duplicate event twice across retries', async () => {
    await queue.enqueue([makeEvent('evt_dup')]);
    const ok = new FakeTransport({ ok: true, retryable: false });
    await queue.drain(ok, 10);
    await queue.enqueue([makeEvent('evt_dup')]); // same event re-enqueued later
    await queue.drain(ok, 10);
    const delivered = ok.calls.flat().map((event) => event.id);
    expect(delivered.filter((id) => id === 'evt_dup')).toHaveLength(2); // two distinct sends, one per enqueue
    expect(ok.calls.every((batch) => batch.length === new Set(batch.map((e) => e.id)).size)).toBe(true);
  });
});

describe('deliverEvents', () => {
  let world: TempWorld;
  let queue: EventQueue;

  beforeEach(async () => {
    world = await makeTempEnv();
    queue = new EventQueue({
      queueDir: path.join(world.home, 'q'),
      locksDir: path.join(world.home, 'locks'),
      maxEvents: 100,
      maxAttempts: 3,
      maxEventAgeDays: 7
    });
  });

  afterEach(async () => {
    await world.cleanup();
  });

  it('queues when no transport is configured', async () => {
    const outcome = await deliverEvents([makeEvent('evt_a')], undefined, queue, 10);
    expect(outcome.queued).toBe(1);
    expect(await queue.pendingCount()).toBe(1);
  });

  it('queues on failed send and retries on a later invocation', async () => {
    const failing = new FakeTransport({ ok: false, retryable: true, error: 'ECONNREFUSED' });
    await deliverEvents([makeEvent('evt_a')], failing, queue, 10);
    expect(await queue.pendingCount()).toBe(1);

    // Simulate the next hook invocation with a healthy backend: direct send
    // succeeds and the backlog drains. Force the queued entry to be due.
    const file = (await fs.readdir(path.join(world.home, 'q')))[0]!;
    const full = path.join(world.home, 'q', file);
    const entry = JSON.parse(await fs.readFile(full, 'utf8'));
    entry.nextAttemptAt = new Date(0).toISOString();
    await fs.writeFile(full, JSON.stringify(entry));

    const healthy = new FakeTransport({ ok: true, retryable: false });
    const outcome = await deliverEvents([makeEvent('evt_b')], healthy, queue, 10);
    expect(outcome.delivered).toBe(1);
    expect(outcome.drained).toBe(1);
    expect(await queue.pendingCount()).toBe(0);
  });
});

describe('HttpTransport', () => {
  const event = makeEvent('evt_http');

  it('sends events with auth headers and succeeds on 2xx', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const transport = new HttpTransport({
      eventsUrl: 'https://backend.example.com/v1/events',
      token: 'tok123',
      installationId: 'inst-1',
      timeoutMs: 1000,
      fetchFn: (async (url: any, init: any) => {
        captured = { url: String(url), init };
        return new Response('{}', { status: 202 });
      }) as typeof fetch
    });
    const result = await transport.send([event]);
    expect(result.ok).toBe(true);
    expect(captured!.url).toBe('https://backend.example.com/v1/events');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok123');
    expect(JSON.parse(String(captured!.init.body)).events).toHaveLength(1);
  });

  it('classifies 5xx as retryable and 400 as permanent', async () => {
    const make = (status: number) =>
      new HttpTransport({
        eventsUrl: 'https://x.example/v1/events',
        timeoutMs: 1000,
        fetchFn: (async () => new Response('no', { status })) as typeof fetch
      });
    expect((await make(503).send([event])).retryable).toBe(true);
    expect((await make(400).send([event])).retryable).toBe(false);
    expect((await make(429).send([event])).retryable).toBe(true);
  });

  it('classifies network errors as retryable and hides details', async () => {
    const transport = new HttpTransport({
      eventsUrl: 'https://down.example/v1/events',
      timeoutMs: 50,
      fetchFn: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch
    });
    const result = await transport.send([event]);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });
});
