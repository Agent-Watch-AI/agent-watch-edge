import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventQueue } from '../src/transport/queue.js';
import type { DeliveryResult, EventTransport } from '../src/transport/transport.js';
import type { ProductEvent } from '../src/events/product-event.js';
import { buildLlmCall } from '../src/events/llm-call.js';
import { buildTurnSummary } from '../src/turns/turn-summary.js';
import { deliverEvents } from '../src/transport/delivery.js';
import { makeTempEnv, writeJson, type TempWorld } from './helpers.js';
import { resolvePaths } from '../src/storage/paths.js';
import { defaultConfig } from '../src/config/config.js';
import { runHook } from '../src/cli/hook.js';

function makeSummary(id: string): ProductEvent {
  return { ...buildTurnSummary({ provider: 'claude', surface: 'cli', sessionId: 's1', prompts: [], tools: [], endedAt: new Date().toISOString() }), id };
}

function makeCall(id: string): ProductEvent {
  return { ...buildLlmCall({ provider: 'claude-code', surface: 'cli', callId: id, sessionId: 's1', correlation: 'session', endedAt: new Date().toISOString() }), id };
}

class FakeTransport implements EventTransport {
  calls: ProductEvent[][] = [];
  constructor(private readonly result: DeliveryResult) {}
  async send(events: ProductEvent[]): Promise<DeliveryResult> {
    this.calls.push(events);
    return this.result;
  }
}

describe('public event offline queue', () => {
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

  const mixed = () => [makeCall('evt_call'), makeSummary('evt_sum')];

  it('a dead backend keeps both public product types', async () => {
    const transport = new FakeTransport({ ok: false, retryable: true });
    const outcome = await deliverEvents(mixed(), transport, queue, 10);
    expect(outcome.queued).toBe(2);
    expect(await queue.pendingCount()).toBe(2);
  });

  it('always keeps everything in the two-type contract', async () => {
    const transport = new FakeTransport({ ok: false, retryable: true });
    await deliverEvents(mixed(), transport, queue, 10);
    expect(await queue.pendingCount()).toBe(2);
  });

  it('has no policy that can drop usage records', async () => {
    const transport = new FakeTransport({ ok: false, retryable: true });
    await deliverEvents(mixed(), transport, queue, 10);
    expect(await queue.pendingCount()).toBe(2);
  });

  it('queues both types when no endpoint is configured yet', async () => {
    const outcome = await deliverEvents(mixed(), undefined, queue, 10);
    expect(outcome.queued).toBe(2);
    expect(await queue.pendingCount()).toBe(2);
  });

  it('queued summaries are sent once the backend is back', async () => {
    await deliverEvents(mixed(), new FakeTransport({ ok: false, retryable: true }), queue, 10);
    expect(await queue.pendingCount()).toBe(2);

    const alive = new FakeTransport({ ok: true, retryable: false });
    const outcome = await deliverEvents([makeSummary('evt_next')], alive, queue, 10);
    expect(outcome.delivered).toBe(1);
    expect(outcome.drained).toBe(2);
    expect(await queue.pendingCount()).toBe(0);
  });

  it('hook path: unreachable backend queues only the summary, silently', async () => {
    const paths = resolvePaths(world.env);
    await writeJson(paths.configFile, {
      ...defaultConfig(),
      endpoint: 'http://127.0.0.1:9',
      capture: { ...defaultConfig().capture, prompts: true },
      delivery: { ...defaultConfig().delivery, timeoutMs: 300 }
    });

    let stdout = '';
    const run = async (payload: Record<string, unknown>) =>
      runHook('claude', {
        env: world.env,
        input: JSON.stringify(payload),
        writeStdout: (text) => {
          stdout += text;
        }
      });

    expect(await run({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-q', prompt: 'hi', cwd: world.home })).toBe(0);
    expect(await run({ hook_event_name: 'PostToolUse', session_id: 'sess-q', tool_name: 'Bash', tool_use_id: 't1', cwd: world.home })).toBe(0);
    expect(await run({ hook_event_name: 'Stop', session_id: 'sess-q', last_assistant_message: 'ok', cwd: world.home })).toBe(0);
    expect(stdout).toBe(''); // no errors, no output: the agent never notices

    const files = await fs.readdir(paths.queueDir);
    const queued = await Promise.all(files.map(async (name) => JSON.parse(await fs.readFile(path.join(paths.queueDir, name), 'utf8'))));
    const types = queued.map((entry) => entry.event.event.type);
    expect(types).toEqual(['turn.summary']);
  });

  it('hook path drains old summaries when turn summary emission is disabled', async () => {
    const paths = resolvePaths(world.env);
    const endpoint = 'https://backend.example.com';
    await writeJson(paths.configFile, {
      ...defaultConfig(),
      endpoint,
      emit: { ...defaultConfig().emit, turnSummaries: false }
    });
    const runtimeQueue = new EventQueue({
      queueDir: paths.queueDir,
      locksDir: paths.locksDir,
      maxEvents: 100,
      maxAttempts: 3,
      maxEventAgeDays: 7
    });
    await runtimeQueue.enqueue([makeSummary('evt_backlog')], `${endpoint}/v1/events`);

    const originalFetch = globalThis.fetch;
    const delivered: ProductEvent[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      delivered.push(...JSON.parse(String(init?.body)).events);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      expect(await runHook('claude', {
        env: world.env,
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-drain', prompt: 'hi', cwd: world.home })
      })).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(delivered.map((event) => event.id)).toEqual(['evt_backlog']);
    expect(await runtimeQueue.pendingCount()).toBe(0);
  });
});
