import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, defaultConfig } from '../src/config/config.js';
import { ENFORCEMENT_COOLDOWN_FILE_NAME, ENFORCEMENT_COOLDOWN_MS } from '../src/enforcement/constants/enforcement.constants.js';
import { resolveEnforcement } from '../src/enforcement/enforcement.js';
import { resolvePaths } from '../src/storage/paths.js';
import { BackendCooldown } from '../src/transport/cooldown.js';
import { identityPaths } from '../src/transport/queue-partition.js';
import { makeTempEnv, type TempWorld } from './helpers.js';

const DEVELOPER = 'ivan@acme.test';
const MESSAGE = 'Ivan Petrov passed his $500 hard limit and has now spent $612 this month.';
const ENDPOINT = 'https://backend.example.com';
const TOKEN = 'aw_edge_test';
const START = Date.parse('2026-09-28T10:00:00.000Z');

/** A fetch whose answer the test can change between turns, counting every call. */
function switchable(): { fetchFn: typeof fetch; calls: () => number; fail: (down: boolean) => void } {
  let calls = 0;
  let down = false;
  const fetchFn = (async () => {
    calls += 1;

    if (down) throw new Error('connect ECONNREFUSED');

    return new Response(JSON.stringify({ decision: 'block', message: MESSAGE, cache_ttl_ms: 0 }));
  }) as typeof fetch;

  return { fetchFn, calls: () => calls, fail: (value) => { down = value; } };
}

describe('enforcement breaker', () => {
  let world: TempWorld;
  let clock: number;

  beforeEach(async () => {
    world = await makeTempEnv();
    clock = START;
  });

  afterEach(() => world.cleanup());

  // A fresh options object per call, and nothing shared but the data directory:
  // each call stands for a separate hook process.
  function turn(fetchFn: typeof fetch, token = TOKEN) {
    return resolveEnforcement({
      config: configSchema.parse({ ...defaultConfig(), endpoint: ENDPOINT, token }),
      paths: resolvePaths(world.env),
      developerId: DEVELOPER,
      now: () => new Date(clock),
      fetchFn
    });
  }

  const breakerFile = (token = TOKEN) =>
    path.join(path.dirname(identityPaths(resolvePaths(world.env), token).cooldownFile), ENFORCEMENT_COOLDOWN_FILE_NAME);

  it('skips the request after a failure, and allows the turn without asking', async () => {
    const server = switchable();

    server.fail(true);

    expect(await turn(server.fetchFn)).toEqual({ decision: 'allow' });
    expect(server.calls()).toBe(1);

    // The platform is back and would refuse, but nobody asks until the cooldown
    // ends: the breaker skips a wait and never turns a skip into a refusal.
    server.fail(false);
    clock += ENFORCEMENT_COOLDOWN_MS - 1;

    expect(await turn(server.fetchFn)).toEqual({ decision: 'allow' });
    expect(server.calls()).toBe(1);
  });

  it('asks again once the cooldown ends, and a decision clears it', async () => {
    const server = switchable();

    server.fail(true);
    await turn(server.fetchFn);
    server.fail(false);
    clock += ENFORCEMENT_COOLDOWN_MS + 1;

    expect(await turn(server.fetchFn)).toEqual({ decision: 'block', message: MESSAGE });
    expect(server.calls()).toBe(2);
    await expect(fs.access(breakerFile())).rejects.toThrow();
  });

  it('writes its state 0600', async () => {
    const server = switchable();

    server.fail(true);
    await turn(server.fetchFn);

    expect((await fs.stat(breakerFile())).mode & 0o777).toBe(0o600);
  });

  it('is independent of the delivery breaker, both ways', async () => {
    const paths = resolvePaths(world.env);
    const delivery = new BackendCooldown(identityPaths(paths, TOKEN).cooldownFile, () => new Date(clock));
    const server = switchable();

    // Delivery down does not stop the check.
    await delivery.trip(60_000);

    expect(await turn(server.fetchFn)).toEqual({ decision: 'block', message: MESSAGE });
    expect(server.calls()).toBe(1);

    // Enforcement down does not touch delivery's breaker.
    await delivery.clear();
    server.fail(true);
    await turn(server.fetchFn);

    expect(await delivery.active()).toBe(false);
    expect(await new BackendCooldown(breakerFile(), () => new Date(clock)).active()).toBe(true);
  });

  it('is per identity: one tenant’s outage does not skip another tenant’s check', async () => {
    const server = switchable();

    server.fail(true);
    await turn(server.fetchFn, 'aw_edge_tenant_a');
    server.fail(false);

    expect(await turn(server.fetchFn, 'aw_edge_tenant_b')).toEqual({ decision: 'block', message: MESSAGE });
    expect(server.calls()).toBe(2);
  });

  it('only the first turn of an outage pays the timeout, and the turn after recovery asks', async () => {
    // A platform that accepts the connection and never answers: the case that
    // costs a developer the whole timeout.
    const timeoutMs = 250;
    let requests = 0;
    let hang = true;
    const hanging = http.createServer((_request, response) => {
      requests += 1;

      if (hang) return;

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ decision: 'allow', cache_ttl_ms: 0 }));
    });

    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));

    const address = hanging.address();
    const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const timed = async () => {
      const started = performance.now();

      await resolveEnforcement({
        config: configSchema.parse({ ...defaultConfig(), endpoint, token: TOKEN, enforcement: { timeoutMs } }),
        paths: resolvePaths(world.env),
        developerId: DEVELOPER,
        now: () => new Date(clock),
        fetchFn: fetch
      });

      return performance.now() - started;
    };

    try {
      const first = await timed();
      const second = await timed();
      const third = await timed();

      expect(first).toBeGreaterThanOrEqual(timeoutMs - 10);
      expect(second).toBeLessThan(timeoutMs);
      expect(third).toBeLessThan(timeoutMs);
      expect(requests).toBe(1);

      hang = false;
      clock += ENFORCEMENT_COOLDOWN_MS + 1;
      await timed();

      expect(requests).toBe(2);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });
});
