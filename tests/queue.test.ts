import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANY_DESTINATION, EventQueue } from '../src/transport/queue.js';
import { HttpTransport } from '../src/transport/http-transport.js';
import type { DeliveryResult, EventTransport } from '../src/transport/transport.js';
import type { ProductEvent } from '../src/events/product-event.js';
import { buildTurnSummary } from '../src/turns/turn-summary.js';
import { deliverEvents } from '../src/transport/delivery.js';
import { BackendCooldown } from '../src/transport/cooldown.js';
import { makeTempEnv, type TempWorld } from './helpers.js';

function makeEvent(id: string): ProductEvent {
  return { ...buildTurnSummary({ provider: 'claude', surface: 'cli', sessionId: 's1', prompts: [], tools: [], endedAt: new Date().toISOString() }), id };
}

class FakeTransport implements EventTransport {
  calls: ProductEvent[][] = [];
  constructor(
    private readonly result: DeliveryResult,
    readonly destination?: string
  ) {}
  async send(events: ProductEvent[]): Promise<DeliveryResult> {
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

  async function makeAllDue(): Promise<void> {
    const dir = path.join(world.home, 'q');

    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const entry = JSON.parse(await fs.readFile(file, 'utf8'));

      entry.nextAttemptAt = new Date(0).toISOString();
      await fs.writeFile(file, JSON.stringify(entry));
    }
  }

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

  it('retries non-retryable rejections with backoff and drops only at maxAttempts', async () => {
    // A "permanent" HTTP status can be a transient backend route/schema
    // mismatch, so the first refusal must not destroy the event.
    await queue.enqueue([makeEvent('evt_permanent')]);
    const transport = new FakeTransport({ ok: false, retryable: false, error: 'HTTP 400' });

    const first = await queue.drain(transport, 10);

    expect(first.failed).toBe(1);
    expect(first.dropped).toBe(0);
    expect(await queue.pendingCount()).toBe(1);

    // maxAttempts is 3: two more refusals exhaust the entry.
    await makeAllDue();
    expect((await queue.drain(transport, 10)).failed).toBe(1);
    await makeAllDue();
    expect((await queue.drain(transport, 10)).dropped).toBe(1);
    expect(await queue.pendingCount()).toBe(0);
  });

  it('one rejected event does not destroy healthy events in the same batch', async () => {
    await queue.enqueue([makeEvent('evt_good_a'), makeEvent('evt_poison'), makeEvent('evt_good_b')]);
    const transport: EventTransport = {
      async send(events: ProductEvent[]): Promise<DeliveryResult> {
        if (events.some((event) => event.id === 'evt_poison')) return { ok: false, retryable: false, status: 400, error: 'HTTP 400' };

        return { ok: true, retryable: false };
      }
    };

    const stats = await queue.drain(transport, 10);

    // The batch is rejected, but the individual retry delivers the healthy
    // events; only the poison event stays behind for backoff.
    expect(stats.sent).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.dropped).toBe(0);
    expect(await queue.pendingCount()).toBe(1);
  });

  it('retarget re-pins only the previous backend backlog, never a third backend', async () => {
    await queue.enqueue([makeEvent('evt_old')], 'https://old.example.com/v1/events');
    await queue.enqueue([makeEvent('evt_other_org')], 'https://other-org.example.com/v1/events');
    await queue.enqueue([makeEvent('evt_presetup')], ANY_DESTINATION);

    expect(await queue.pendingFor('https://old.example.com/v1/events')).toBe(1);
    expect(await queue.retarget('https://new.example.com/v1/events', 'https://old.example.com/v1/events')).toBe(true);

    const transport = new FakeTransport({ ok: true, retryable: false }, 'https://new.example.com/v1/events');
    const stats = await queue.drain(transport, 10);

    // Old-URL entry re-routed, ANY entry always flows; the entry pinned to a
    // different backend must never follow a reconfiguration it wasn't part of.
    expect(stats.sent).toBe(2);
    expect(await queue.pendingCount()).toBe(1);
    expect(await queue.pendingFor('https://other-org.example.com/v1/events')).toBe(1);
  });

  it('caps poison-isolation probes per drain to keep the hook fast', async () => {
    await queue.enqueue(Array.from({ length: 5 }, (_, i) => makeEvent(`evt_reject_${i}`)));
    const rejectAll = new FakeTransport({ ok: false, retryable: false, status: 400, error: 'HTTP 400' });
    const stats = await queue.drain(rejectAll, 10);

    // One batch send plus at most 3 individual probes; the rest just backs off.
    expect(rejectAll.calls.length).toBe(4);
    expect(stats.failed).toBe(5);
    expect(await queue.pendingCount()).toBe(5);
  });

  it('drops legacy non-product entries instead of draining them to the backend', async () => {
    const internal = { ...makeEvent('evt_legacy_internal'), event: { type: 'prompt.submitted', providerEventType: 'UserPromptSubmit' } } as unknown as ProductEvent;

    await queue.enqueue([internal, makeEvent('evt_real')]);
    const transport = new FakeTransport({ ok: true, retryable: false });
    const stats = await queue.drain(transport, 10);

    expect(stats.dropped).toBe(1);
    expect(stats.sent).toBe(1);
    expect(transport.calls.flat().map((event) => event.id)).toEqual(['evt_real']);
  });

  it('bounds the queue size', async () => {
    await queue.enqueue(Array.from({ length: 9 }, (_, i) => makeEvent(`evt_${i}`)));
    expect(await queue.pendingCount()).toBeLessThanOrEqual(5);
  });

  it('drains only entries queued for the transport destination', async () => {
    await queue.enqueue([makeEvent('evt_a')], 'https://backend-a.example.com/v1/events');
    await queue.enqueue([makeEvent('evt_b')], 'https://backend-b.example.com/v1/events');
    // Pre-setup entry: explicitly queued for whatever backend gets configured.
    await queue.enqueue([makeEvent('evt_presetup')], ANY_DESTINATION);
    // Legacy pre-upgrade entry: deliver to the first configured backend.
    await queue.enqueue([makeEvent('evt_legacy')]);

    const transportB = new FakeTransport({ ok: true, retryable: false }, 'https://backend-b.example.com/v1/events');
    const stats = await queue.drain(transportB, 10);

    expect(stats.sent).toBe(3);
    const sentIds = transportB.calls.flat().map((event) => event.id);

    expect(sentIds).toContain('evt_b');
    expect(sentIds).toContain('evt_presetup');
    expect(sentIds).not.toContain('evt_a');
    expect(sentIds).toContain('evt_legacy');
    // Only the entry pinned to another destination stays queued.
    expect(await queue.pendingCount()).toBe(1);
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

  it('queues when no transport is configured and drains to the first configured backend', async () => {
    const outcome = await deliverEvents([makeEvent('evt_a')], undefined, queue, 10);

    expect(outcome.queued).toBe(1);
    expect(await queue.pendingCount()).toBe(1);

    const healthy = new FakeTransport({ ok: true, retryable: false }, 'https://first.example.com/v1/events');
    const after = await deliverEvents([makeEvent('evt_b')], healthy, queue, 10);

    expect(after.drained).toBe(1);
    expect(await queue.pendingCount()).toBe(0);
  });

  it('trips a cooldown after a failed send so later hooks skip the direct send', async () => {
    let clock = Date.parse('2026-08-07T12:00:00.000Z');
    const now = () => new Date(clock);
    const cooldown = new BackendCooldown(path.join(world.home, 'cooldown.json'), now);

    const failing = new FakeTransport({ ok: false, retryable: true, error: 'ECONNREFUSED' }, 'https://b.example/v1/events');

    await deliverEvents([makeEvent('evt_1')], failing, queue, 10, cooldown);
    expect(failing.calls).toHaveLength(1);

    // Backend still dead: within the cooldown no direct send is attempted,
    // events go straight to the queue.
    const stillFailing = new FakeTransport({ ok: false, retryable: true, error: 'ECONNREFUSED' }, 'https://b.example/v1/events');
    const during = await deliverEvents([makeEvent('evt_2')], stillFailing, queue, 10, cooldown);

    expect(stillFailing.calls).toHaveLength(0);
    expect(during.queued).toBe(1);
    expect(await queue.pendingCount()).toBe(2);

    // After the cooldown expires the direct send is attempted again.
    clock += 120_000;
    const healthy = new FakeTransport({ ok: true, retryable: false }, 'https://b.example/v1/events');
    const after = await deliverEvents([makeEvent('evt_3')], healthy, queue, 10, cooldown);

    expect(healthy.calls.length).toBeGreaterThan(0);
    expect(after.delivered).toBe(1);
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

  it('queues product records after a non-retryable direct-send failure', async () => {
    const failing = new FakeTransport({ ok: false, retryable: false, status: 400, error: 'HTTP 400' }, 'https://b.example/v1/events');
    const outcome = await deliverEvents([makeEvent('evt_bad_route')], failing, queue, 10);

    expect(outcome.queued).toBe(1);
    expect(await queue.pendingCount()).toBe(1);
  });

  it('drains queued records even when the current hook has no outbound event', async () => {
    await queue.enqueue([makeEvent('evt_backlog')], 'https://b.example/v1/events');
    const healthy = new FakeTransport({ ok: true, retryable: false }, 'https://b.example/v1/events');
    const outcome = await deliverEvents([], healthy, queue, 10);

    expect(outcome).toMatchObject({ delivered: 0, queued: 0, drained: 1 });
    expect(healthy.calls).toHaveLength(1);
    expect(healthy.calls[0]?.map((event) => event.id)).toEqual(['evt_backlog']);
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
