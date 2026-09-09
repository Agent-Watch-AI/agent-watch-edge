import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackendAuthBlock } from '../src/transport/auth-block.js';
import { deliverEvents } from '../src/transport/delivery.js';
import { DeliveryStats } from '../src/transport/delivery-stats.js';
import { EventQueue } from '../src/transport/queue.js';
import type { DeliveryResult, EventTransport } from '../src/transport/transport.js';
import type { ProductEvent } from '../src/events/product-event.js';
import { buildTurnSummary } from '../src/turns/turn-summary.js';
import { makeTempEnv, type TempWorld } from './helpers.js';

const BACKEND = 'https://backend.example.com/v1/events';

function makeEvent(id: string): ProductEvent {
  return { ...buildTurnSummary({ provider: 'claude', surface: 'cli', sessionId: 's1', prompts: [], tools: [], endedAt: new Date().toISOString() }), id };
}

class FakeTransport implements EventTransport {
  calls = 0;
  constructor(
    private readonly result: DeliveryResult,
    readonly destination = BACKEND
  ) {}

  async send(): Promise<DeliveryResult> {
    this.calls += 1;

    return this.result;
  }
}

describe('a rejected credential suspends sending without losing a record', () => {
  let world: TempWorld;
  let queue: EventQueue;
  let authBlock: BackendAuthBlock;
  let stats: DeliveryStats;

  beforeEach(async () => {
    world = await makeTempEnv();
    queue = new EventQueue({
      queueDir: path.join(world.home, 'q'),
      locksDir: path.join(world.home, 'locks'),
      maxEvents: 50,
      // Deliberately low: a bug that spends an attempt per refusal would delete
      // the backlog within two passes, and this test would see it.
      maxAttempts: 2,
      maxEventAgeDays: 7
    });
    authBlock = new BackendAuthBlock(path.join(world.home, 'auth-block.json'));
    stats = new DeliveryStats(path.join(world.home, 'stats.json'), undefined, path.join(world.home, 'locks'));
  });

  afterEach(() => world.cleanup());

  it('keeps the record, records the refusal and raises the block on a 401', async () => {
    const refusing = new FakeTransport({ ok: false, status: 401, retryable: false, error: 'HTTP 401' });
    const outcome = await deliverEvents([makeEvent('evt_1')], refusing, queue, 10, undefined, stats, authBlock);

    expect(outcome.queued).toBe(1);
    expect(await queue.pendingCount()).toBe(1);

    const snapshot = await stats.read();

    expect(snapshot?.lastRefusalStatus).toBe(401);
    expect(snapshot?.lastRefusalAt).toBeTruthy();

    const block = await authBlock.active(BACKEND);

    expect(block?.status).toBe(401);
    expect(block?.since).toBeTruthy();
  });

  it('makes no request at all while the block stands, and still queues the turn', async () => {
    await authBlock.raise(BACKEND, 403);

    const transport = new FakeTransport({ ok: true, retryable: false });
    const outcome = await deliverEvents([makeEvent('evt_2')], transport, queue, 10, undefined, stats, authBlock);

    expect(transport.calls).toBe(0);
    expect(outcome.queued).toBe(1);
    expect(await queue.pendingCount()).toBe(1);
  });

  it('leaves the block alone for another destination and another credential', async () => {
    await authBlock.raise(BACKEND, 401);

    expect(await authBlock.active('https://other.example.com/v1/events')).toBeUndefined();

    // A new token means a new state directory, so a fresh block sees nothing.
    const afterRotation = new BackendAuthBlock(path.join(world.home, 'rotated', 'auth-block.json'));

    expect(await afterRotation.active(BACKEND)).toBeUndefined();
  });

  it('never spends a queued entry\'s attempts on a refused credential', async () => {
    const refusing = new FakeTransport({ ok: false, status: 401, retryable: false, error: 'HTTP 401' });

    await queue.enqueue([makeEvent('evt_a'), makeEvent('evt_b')], BACKEND);

    // maxAttempts is 2: three refused passes would delete both entries if a
    // refused credential counted as a failed attempt against them.
    for (let pass = 0; pass < 3; pass += 1) {
      await queue.drain(refusing, 10, stats, authBlock);
    }

    expect(await queue.pendingCount()).toBe(2);
    expect((await stats.read())?.totalDropped ?? 0).toBe(0);
    expect((await authBlock.active(BACKEND))?.status).toBe(401);
  });

  it('resumes and drains once the credential is accepted again', async () => {
    await queue.enqueue([makeEvent('evt_c')], BACKEND);
    await authBlock.raise(BACKEND, 401);

    const healthy = new FakeTransport({ ok: true, retryable: false });

    // The operator configured a new token; `doctor`'s authenticated probe
    // proved it, which is what lifts the block.
    await authBlock.clear();

    const outcome = await deliverEvents([makeEvent('evt_d')], healthy, queue, 10, undefined, stats, authBlock);

    expect(outcome.delivered).toBe(1);
    expect(outcome.drained).toBe(1);
    expect(await queue.pendingCount()).toBe(0);
  });

  // The block's early return in `deliverEvents` skips `queue.drain`, and the
  // whole-partition retention pass used to live inside it. A revoked token
  // therefore aged nothing out for as long as the block stood — and a block has
  // no timer — while `enforceBound` quietly shed the oldest entries at the
  // ceiling without counting them. That is the week-long, invisible loss the
  // bound and the tally both exist to prevent.
  it('still ages the backlog out while the credential is refused', async () => {
    const clock = { at: new Date('2026-09-01T10:00:00.000Z') };
    const aging = new EventQueue({
      queueDir: path.join(world.home, 'aging'),
      locksDir: path.join(world.home, 'locks'),
      maxEvents: 50,
      maxAttempts: 20,
      maxEventAgeDays: 7,
      now: () => clock.at
    });

    await aging.enqueue([makeEvent('evt_old')], BACKEND);
    await authBlock.raise(BACKEND, 401);

    clock.at = new Date('2026-09-30T10:00:00.000Z');

    const refusing = new FakeTransport({ ok: false, status: 401, retryable: false, error: 'HTTP 401' });
    const outcome = await deliverEvents([], refusing, aging, 10, undefined, stats, authBlock);

    // Nothing was sent — the block stands — and the expired entry is gone and
    // counted rather than held for a backend that will never take it.
    expect(refusing.calls).toBe(0);
    expect(outcome.delivered).toBe(0);
    expect(await aging.pendingCount()).toBe(0);
    expect((await stats.read())?.totalDropped).toBe(1);
  });

  // `enforceBound` was the one permanent loss that never reached the tally, so a
  // machine steadily shedding records at the ceiling reported `totalDropped: 0`.
  it('counts the entries the queue bound sacrifices', async () => {
    const bounded = new EventQueue({
      queueDir: path.join(world.home, 'bounded'),
      locksDir: path.join(world.home, 'locks'),
      maxEvents: 2,
      maxAttempts: 20,
      maxEventAgeDays: 7,
      stats
    });

    await bounded.enqueue([makeEvent('evt_1'), makeEvent('evt_2'), makeEvent('evt_3'), makeEvent('evt_4')], BACKEND);

    expect(await bounded.pendingCount()).toBe(2);
    expect((await stats.read())?.totalDropped).toBe(2);
  });

  it('keeps the first refusal time across later refusals', async () => {
    const clock = { at: new Date('2026-09-01T10:00:00.000Z') };
    const block = new BackendAuthBlock(path.join(world.home, 'timed.json'), () => clock.at);

    await block.raise(BACKEND, 401);
    clock.at = new Date('2026-09-05T10:00:00.000Z');
    await block.raise(BACKEND, 401);

    expect((await block.active(BACKEND))?.since).toBe('2026-09-01T10:00:00.000Z');
  });
});
