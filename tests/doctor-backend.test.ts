import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/cli/doctor.js';
import { defaultConfig, eventsUrl } from '../src/config/config.js';
import { loadConfig, saveConfig } from '../src/config/config-store.js';
import { resolvePaths } from '../src/storage/paths.js';
import { BackendAuthBlock } from '../src/transport/auth-block.js';
import { identityPaths } from '../src/transport/queue-partition.js';
import { captureStdout, makeTempEnv, type TempWorld } from './helpers.js';

const TOKEN = 'aw_edge_doctor';

interface Backend {
  readonly url: string;
  readonly seen: { authorization: string }[];
  close(): Promise<void>;
}

/** A backend that answers every POST with one status, remembering the bearer. */
async function backendAnswering(status: number): Promise<Backend> {
  const seen: { authorization: string }[] = [];
  const server = http.createServer((request, response) => {
    seen.push({ authorization: request.headers.authorization ?? '' });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  server.keepAliveTimeout = 1;

  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

describe('doctor tells a rejected credential from a healthy install', () => {
  let world: TempWorld;
  let backend: Backend | undefined;

  beforeEach(async () => {
    world = await makeTempEnv();
  });

  afterEach(async () => {
    await backend?.close();
    backend = undefined;
    await world.cleanup();
  });

  async function configure(endpoint: string): Promise<void> {
    await saveConfig(resolvePaths(world.env), { ...defaultConfig(), endpoint, token: TOKEN, installationId: 'inst-doctor', developerEmail: 'dev@company.com' });
  }

  /** The one check an install script reads, from the machine-readable report. */
  async function connectivityCheck(): Promise<{ code: number; level: string; detail: string }> {
    const { result, stdout } = await captureStdout(() => runDoctor(world.env, { json: true }));
    const check = JSON.parse(stdout).checks.find((entry: { name: string }) => entry.name === 'backend connectivity');

    return { code: result, level: check.level, detail: check.detail };
  }

  it('passes with no warning, under the install\'s own credential, when the backend accepts it', async () => {
    backend = await backendAnswering(202);
    await configure(backend.url);

    const check = await connectivityCheck();

    expect(check.level).toBe('ok');
    expect(check.code).toBe(0);
    // The probe describes *this* install, so it must present its bearer.
    expect(backend.seen.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('fails and names the credential when the backend rejects it', async () => {
    backend = await backendAnswering(401);
    await configure(backend.url);

    const check = await connectivityCheck();

    expect(check.level).toBe('fail');
    expect(check.code).toBe(1);
    expect(check.detail).toContain('credential rejected');
    expect(check.detail).toContain('401');
  });

  it('says "unreachable", not "rejected", when nothing answers', async () => {
    // A port nothing is listening on: connection refused, not a status.
    await configure('http://127.0.0.1:1');

    const check = await connectivityCheck();

    expect(check.level).toBe('fail');
    expect(check.code).toBe(1);
    expect(check.detail).toContain('unreachable');
    expect(check.detail).not.toContain('rejected');
  });

  it('reads as "not configured yet" before setup names a backend', async () => {
    const check = await connectivityCheck();

    expect(check.level).toBe('warn');
    expect(check.detail).toContain('no backend configured yet');
  });

  it('probes even while a block stands, and a 2xx lifts it', async () => {
    backend = await backendAnswering(202);
    await configure(backend.url);

    const paths = resolvePaths(world.env);
    const block = new BackendAuthBlock(identityPaths(paths, TOKEN).authBlockFile);
    // The exact URL a delivery would send to, so the block really applies.
    const eventsEndpoint = eventsUrl((await loadConfig(paths)).config)!;

    await block.raise(eventsEndpoint, 401);
    expect(await block.active(eventsEndpoint)).toBeDefined();

    const check = await connectivityCheck();

    expect(check.level).toBe('ok');
    expect(backend.seen.length).toBeGreaterThan(0);
    expect(await block.active(eventsEndpoint)).toBeUndefined();
  });
});
