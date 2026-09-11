import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProductEvent } from '../src/events/product-event.js';
import { EventQueue } from '../src/transport/queue.js';
import type { DeliveryResult, EventTransport } from '../src/transport/transport.js';
import { buildTurnSummary } from '../src/turns/turn-summary.js';
import { makeTempEnv, type TempWorld } from './helpers.js';

const DESTINATION = 'https://backend.example.com/v1/events';

function summary(id: string): ProductEvent {
  return { ...buildTurnSummary({ provider: 'claude', surface: 'cli', sessionId: 's1', prompts: [], tools: [], endedAt: new Date().toISOString() }), id };
}

/** Deterministic PRNG, so a failing schedule is reproducible from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A transport whose answer the schedule chooses, per send. */
class ScriptedTransport implements EventTransport {
  result: DeliveryResult = { ok: false, retryable: true, error: 'network error' };
  readonly destination = DESTINATION;
  sent: string[] = [];

  async send(events: readonly ProductEvent[]): Promise<DeliveryResult> {
    if (this.result.ok) this.sent.push(...events.map((event) => event.id));

    return this.result;
  }
}

describe('a product record is never discarded on a failed send, across arbitrary schedules', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  /**
   * A queue whose bounds this property does not depend on.
   *
   * `maxAttempts` and `maxEventAgeDays` are the two documented ways an entry may
   * legitimately disappear, so they are set out of reach: whatever remains is a
   * loss the queue is not allowed to have.
   *
   * @param dir - Suffix for this run's partition, so runs cannot share files.
   * @param nowMs - The queue's clock, held still for the whole schedule.
   * @returns The queue.
   */
  function queueFor(dir: string, nowMs: number): EventQueue {
    return new EventQueue({
      queueDir: path.join(world.home, 'q', dir),
      locksDir: path.join(world.home, 'locks'),
      maxEvents: 1000,
      maxAttempts: 10_000,
      maxEventAgeDays: 3650,
      now: () => new Date(nowMs)
    });
  }

  it('keeps every enqueued record through 40 random schedules of failures', async () => {
    for (let run = 0; run < 40; run += 1) {
      const next = rng(1000 + run);
      const nowMs = Date.parse('2026-09-08T10:00:00.000Z');
      const queue = queueFor(`run${run}`, nowMs);
      const transport = new ScriptedTransport();
      const enqueued = new Set<string>();

      for (let step = 0; step < 12; step += 1) {
        const roll = next();

        if (roll < 0.45) {
          const ids = Array.from({ length: 1 + Math.floor(next() * 3) }, () => `evt_${run}_${step}_${Math.floor(next() * 1000)}`);

          for (const id of ids) enqueued.add(id);

          await queue.enqueue(ids.map(summary), DESTINATION);
          continue;
        }

        // Every failure shape the transport can answer with, none of which may
        // cost a record: a network error, a 5xx, a rate limit, a hard refusal
        // the drain will isolate, and a refused credential.
        transport.result = [
          { ok: false, retryable: true, error: 'network error' },
          { ok: false, status: 503, retryable: true, error: 'HTTP 503' },
          { ok: false, status: 429, retryable: true, error: 'HTTP 429' },
          { ok: false, status: 400, retryable: false, error: 'HTTP 400' },
          { ok: false, status: 401, retryable: false, error: 'HTTP 401' }
        ][Math.floor(next() * 5)]!;

        await makeAllDue(path.join(world.home, 'q', `run${run}`));
        await queue.drain(transport, 1 + Math.floor(next() * 4));
      }

      const survivors = await readIds(path.join(world.home, 'q', `run${run}`));

      expect(transport.sent, `run ${run}: nothing was accepted, so nothing may have been sent`).toEqual([]);
      expect([...survivors].sort(), `run ${run}: a record was lost on a failed send`).toEqual([...enqueued].sort());
    }
  });

  it('delivers every record exactly once when the backend recovers, whatever it refused before', async () => {
    for (let run = 0; run < 20; run += 1) {
      const next = rng(9000 + run);
      const nowMs = Date.parse('2026-09-08T10:00:00.000Z');
      const dir = `recover${run}`;
      const queue = queueFor(dir, nowMs);
      const transport = new ScriptedTransport();
      const ids = Array.from({ length: 3 + Math.floor(next() * 6) }, (_, index) => `evt_r${run}_${index}`);

      await queue.enqueue(ids.map(summary), DESTINATION);

      for (let step = 0; step < 3; step += 1) {
        transport.result = { ok: false, status: next() < 0.5 ? 503 : 400, retryable: next() < 0.5, error: 'refused' };
        await makeAllDue(path.join(world.home, 'q', dir));
        await queue.drain(transport, 1 + Math.floor(next() * 3));
      }

      transport.result = { ok: true, status: 202, retryable: false };

      // Drain until it empties; each pass is bounded by the batch size.
      for (let pass = 0; pass < ids.length + 2 && (await queue.pendingCount()) > 0; pass += 1) {
        await makeAllDue(path.join(world.home, 'q', dir));
        await queue.drain(transport, 2);
      }

      expect(await queue.pendingCount(), `run ${run}: the backlog did not empty`).toBe(0);
      expect(transport.sent.slice().sort(), `run ${run}: a record was lost or sent twice`).toEqual(ids.slice().sort());
    }
  });
});

/**
 * Bring every entry's next attempt forward, so a schedule is not waiting on
 * backoff. The backoff itself is tested by example; this property is about what
 * survives, not when it is tried.
 *
 * @param dir - Partition directory.
 */
async function makeAllDue(dir: string): Promise<void> {
  for (const name of (await fs.readdir(dir).catch(() => [])).filter((entry) => entry.endsWith('.json'))) {
    const file = path.join(dir, name);
    const entry = JSON.parse(await fs.readFile(file, 'utf8'));

    entry.nextAttemptAt = new Date(0).toISOString();
    await fs.writeFile(file, JSON.stringify(entry));
  }
}

/**
 * The event ids currently waiting in a partition.
 *
 * @param dir - Partition directory.
 * @returns The ids.
 */
async function readIds(dir: string): Promise<string[]> {
  const names = (await fs.readdir(dir).catch(() => [])).filter((entry) => entry.endsWith('.json'));

  return Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')).event.id as string));
}
