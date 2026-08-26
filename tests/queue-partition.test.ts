import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempEnv, writeJson, type TempWorld } from './helpers.js';
import { queuePartition, settleLegacyQueue, unattributedCount, unattributedQueue } from '../src/transport/queue-partition.js';
import { EventQueue } from '../src/transport/queue.js';
import type { DeliveryResult, EventTransport } from '../src/transport/transport.js';
import type { ProductEvent } from '../src/events/product-event.js';
import { buildTurnSummary } from '../src/turns/turn-summary.js';
import { runHook } from '../src/cli/hook.js';
import { defaultConfig } from '../src/config/config.js';
import { resolvePaths } from '../src/storage/paths.js';

const TRIP_TOKEN = 'aw_brg_trip';
const WATCH_TOKEN = 'aw_brg_watch';

function makeEvent(id: string): ProductEvent {
  return {
    ...buildTurnSummary({ provider: 'claude', surface: 'cli', sessionId: id, prompts: [], tools: [], endedAt: new Date().toISOString() }),
    id
  };
}

/** Records what it was asked to send, and under which bearer it was built. */
class RecordingTransport implements EventTransport {
  readonly sent: string[] = [];

  constructor(readonly destination: string) {}

  async send(events: readonly ProductEvent[]): Promise<DeliveryResult> {
    for (const event of events) this.sent.push(event.id);

    return { ok: true, status: 200, retryable: false };
  }
}

function queueFor(world: TempWorld, token: string | undefined): EventQueue {
  return new EventQueue({
    queueDir: queuePartition(path.join(world.home, 'queue'), token),
    locksDir: path.join(world.home, 'locks'),
    maxEvents: 100,
    maxAttempts: 3,
    maxEventAgeDays: 7,
    now: () => new Date(Date.now() + 60_000)
  });
}

describe('queue partitions', () => {
  let world: TempWorld;
  let root: string;

  beforeEach(async () => {
    world = await makeTempEnv();
    root = path.join(world.home, 'queue');
  });
  afterEach(() => world.cleanup());

  it('names a partition by a digest, never by the bearer it stands for', () => {
    const partition = queuePartition(root, TRIP_TOKEN);

    expect(path.basename(partition)).toMatch(/^[0-9a-f]{12}$/);
    expect(partition).not.toContain(TRIP_TOKEN);
    expect(queuePartition(root, TRIP_TOKEN)).toBe(partition);
    expect(queuePartition(root, WATCH_TOKEN)).not.toBe(partition);
    // Nothing to sign with yet: pre-setup entries wait in their own partition.
    expect(path.basename(queuePartition(root, undefined))).toBe('unconfigured');
  });

  it('never lets one identity drain another identity\'s backlog', async () => {
    await queueFor(world, TRIP_TOKEN).enqueue([makeEvent('evt_trip')], 'https://backend.example.com/v1/events');
    await queueFor(world, WATCH_TOKEN).enqueue([makeEvent('evt_watch')], 'https://backend.example.com/v1/events');

    // Same backend, same destination pin, different bearer: before partitioning
    // this drained both under whichever token got there first.
    const asWatch = new RecordingTransport('https://backend.example.com/v1/events');
    const drained = await queueFor(world, WATCH_TOKEN).drain(asWatch, 25);

    expect(asWatch.sent).toEqual(['evt_watch']);
    expect(drained.sent).toBe(1);
    expect(await queueFor(world, TRIP_TOKEN).pendingCount()).toBe(1);

    const asTrip = new RecordingTransport('https://backend.example.com/v1/events');

    await queueFor(world, TRIP_TOKEN).drain(asTrip, 25);

    expect(asTrip.sent).toEqual(['evt_trip']);
  });

  it('adopts an unpartitioned backlog when the machine has one identity', async () => {
    await new EventQueue({
      queueDir: root,
      locksDir: path.join(world.home, 'locks'),
      maxEvents: 100,
      maxAttempts: 3,
      maxEventAgeDays: 7
    }).enqueue([makeEvent('evt_legacy')], 'https://backend.example.com/v1/events');
    // Pre-setup entries wait in `unconfigured/` for exactly this moment.
    await queueFor(world, undefined).enqueue([makeEvent('evt_presetup')], '*');

    const moved = await settleLegacyQueue(root, WATCH_TOKEN, false);

    expect(moved).toBe(2);
    expect(await queueFor(world, WATCH_TOKEN).pendingCount()).toBe(2);
    expect(await unattributedCount(root)).toBe(0);
    // Nothing is left loose in the root for a later identity to pick up.
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('refuses to guess an owner when the machine serves several, and loses nothing', async () => {
    await new EventQueue({
      queueDir: root,
      locksDir: path.join(world.home, 'locks'),
      maxEvents: 100,
      maxAttempts: 3,
      maxEventAgeDays: 7
    }).enqueue([makeEvent('evt_ambiguous')], 'https://backend.example.com/v1/events');

    const moved = await settleLegacyQueue(root, WATCH_TOKEN, true);
    const asWatch = new RecordingTransport('https://backend.example.com/v1/events');

    await queueFor(world, WATCH_TOKEN).drain(asWatch, 25);

    expect(moved).toBe(1);
    expect(asWatch.sent).toEqual([]);
    expect(await unattributedCount(root)).toBe(1);
    // Held, not dropped: the operator is the only one who knows whose it is.
    expect(await fs.readdir(unattributedQueue(root))).toHaveLength(1);
  });

  it('does nothing at all until an identity exists to adopt into', async () => {
    await new EventQueue({
      queueDir: root,
      locksDir: path.join(world.home, 'locks'),
      maxEvents: 100,
      maxAttempts: 3,
      maxEventAgeDays: 7
    }).enqueue([makeEvent('evt_legacy')], '*');

    expect(await settleLegacyQueue(root, undefined, false)).toBe(0);
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });
});

/** One request the fake backend accepted. */
interface Received {
  readonly authorization: string;
  readonly ids: readonly string[];
}

describe('two tenants on one machine, through the hook path', () => {
  let world: TempWorld;
  let server: http.Server;
  let received: Received[];
  let status: number;

  beforeEach(async () => {
    world = await makeTempEnv();
    received = [];
    status = 200;
    server = http.createServer((request, response) => {
      let body = '';

      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        if (status === 200) {
          const events = (JSON.parse(body) as { events: { id: string }[] }).events;

          received.push({ authorization: request.headers.authorization ?? '', ids: events.map((event) => event.id) });
        }

        response.writeHead(status, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.cleanup();
  });

  async function turn(cwd: string, session: string): Promise<void> {
    await runHook('claude', { env: world.env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'hi', cwd }) });
    await runHook('claude', { env: world.env, input: JSON.stringify({ hook_event_name: 'Stop', session_id: session, last_assistant_message: 'ok', cwd }) });
  }

  it('delivers each project\'s backlog under its own bearer, never the other\'s', async () => {
    const paths = resolvePaths(world.env);
    const port = (server.address() as { port: number }).port;
    const trip = path.join(world.home, 'tripPlanner');
    const watch = path.join(world.home, 'agent-watch');

    await fs.mkdir(trip, { recursive: true });
    await fs.mkdir(watch, { recursive: true });
    await writeJson(paths.configFile, {
      ...defaultConfig(),
      endpoint: `http://127.0.0.1:${port}`,
      token: 'machine-token',
      roots: { [trip]: { token: TRIP_TOKEN }, [watch]: { token: WATCH_TOKEN } }
    });

    // The backend refuses permanently, so tripPlanner's summary lands in
    // tripPlanner's partition. 400 and not 503: a retryable failure would trip
    // the machine-wide cooldown and the next phase would never send at all.
    status = 400;
    await turn(trip, 'sess-trip');
    status = 200;

    // A hook in the *other* project. It sends its own summary and drains its own
    // backlog — and before partitioning it drained tripPlanner's too, under this
    // bearer, into the wrong tenant's ledger.
    await turn(watch, 'sess-watch');

    expect(received).toHaveLength(1);
    expect(received[0]!.authorization).toBe(`Bearer ${WATCH_TOKEN}`);
    expect(received[0]!.ids).toHaveLength(1);

    // tripPlanner's own next hook is what delivers tripPlanner's backlog.
    await turn(trip, 'sess-trip-2');

    const asTrip = received.filter((entry) => entry.authorization === `Bearer ${TRIP_TOKEN}`);

    expect(asTrip.length).toBeGreaterThan(0);
    expect(received.every((entry) => entry.authorization !== 'Bearer machine-token')).toBe(true);
    // Every event that reached the backend under watch's bearer was watch's.
    expect(received.filter((entry) => entry.authorization === `Bearer ${WATCH_TOKEN}`).flatMap((entry) => entry.ids)).toEqual(received[0]!.ids);
  });
});
