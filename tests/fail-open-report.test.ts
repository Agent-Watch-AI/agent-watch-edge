import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHook } from '../src/cli/hook.js';
import { defaultConfig } from '../src/config/config.js';
import { saveConfig } from '../src/config/config-store.js';
import { resolvePaths } from '../src/storage/paths.js';
import { claudeStop, claudeUserPromptSubmit } from './fixtures/claude.js';
import { makeTempEnv, type TempWorld } from './helpers.js';

const DEVELOPER = 'ivan@acme.test';
const MESSAGE = 'Ivan Petrov passed his $500 hard limit and has now spent $612 this month.';
const TIMEOUT_MS = 50;

/**
 * The pair's end-to-end proof: the gate and the summary are separate hook
 * processes, and what the gate learned about a missing decision has to reach
 * the platform on the summary the later one delivers.
 */
describe('a fail-open is reported on the turn that ran unchecked', () => {
  let world: TempWorld;
  let server: http.Server;
  let answer: { status: number; body: unknown } | 'hang';
  let decisionRequests: number;
  let delivered: Record<string, unknown>[];

  beforeEach(async () => {
    world = await makeTempEnv();
    decisionRequests = 0;
    delivered = [];

    server = http.createServer((request, response) => {
      if ((request.url ?? '').startsWith('/v1/enforcement/decision')) {
        decisionRequests += 1;

        // Never answers inside the edge's timeout: the platform as the hook sees
        // it when it is unreachable. The response is torn down in afterEach.
        if (answer === 'hang') return;

        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));

        return;
      }

      let body = '';

      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        delivered.push(...(JSON.parse(body) as { events: Record<string, unknown>[] }).events);
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ accepted: 1 }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    server.keepAliveTimeout = 1;

    const address = server.address();
    const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    await saveConfig(resolvePaths(world.env), {
      ...defaultConfig(),
      endpoint,
      token: 'aw_edge_test',
      installationId: 'inst-fail-open',
      developerEmail: DEVELOPER,
      enforcement: { ...defaultConfig().enforcement, timeoutMs: TIMEOUT_MS }
    });
  });

  afterEach(async () => {
    server.closeAllConnections();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.cleanup();
  });

  async function hook(payload: unknown): Promise<{ code: number; stdout: string }> {
    let stdout = '';
    const code = await runHook('claude', {
      env: world.env,
      input: JSON.stringify(payload),
      writeStdout: (text) => {
        stdout += text;
      }
    });

    return { code, stdout };
  }

  /** One whole turn — the gated prompt, then the Stop that closes it — and the summary it delivered. */
  async function turn(): Promise<{ prompt: { code: number; stdout: string }; summary: Record<string, unknown> | undefined }> {
    const prompt = await hook(claudeUserPromptSubmit);

    delivered = [];
    await hook(claudeStop);

    return { prompt, summary: delivered.find((event) => (event['event'] as { type?: string }).type === 'turn.summary') };
  }

  it('carries the timeout on the summary of a turn the platform never answered, and the turn runs', async () => {
    answer = 'hang';

    const { prompt, summary } = await turn();

    expect(prompt).toEqual({ code: 0, stdout: '' });
    expect(decisionRequests).toBe(1);
    expect(summary?.['enforcement_fail_open_reason']).toBe('timeout');
    // Top-level beside usage_status, which is the only place the platform reads it.
    expect(summary).toHaveProperty('usage_status');
  });

  it('carries circuit_open on the next turn, which the breaker let through without asking', async () => {
    answer = 'hang';
    await turn();

    const { summary } = await turn();

    expect(decisionRequests).toBe(1);
    expect(summary?.['enforcement_fail_open_reason']).toBe('circuit_open');
  });

  it('carries http_error, and never the body, when the platform answers with a failure status', async () => {
    answer = { status: 503, body: { decision: 'block', message: MESSAGE } };

    const { summary } = await turn();

    expect(summary?.['enforcement_fail_open_reason']).toBe('http_error');
    expect(JSON.stringify(summary)).not.toContain('Ivan');
  });

  it('carries nothing — the key is absent, not null — when the platform answered', async () => {
    answer = { status: 200, body: { decision: 'allow' } };

    const { summary } = await turn();

    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('enforcement_fail_open_reason');
  });

  it('carries nothing on the turn after, once a real answer arrived', async () => {
    answer = { status: 503, body: {} };
    await turn();

    // Past the breaker's cooldown, so the platform is asked again and answers.
    // The earlier turn's reason was consumed with the turn it belonged to.
    answer = { status: 200, body: { decision: 'allow' } };
    world.env.now = () => new Date(Date.now() + 60_000);

    const { summary } = await turn();

    expect(summary).not.toHaveProperty('enforcement_fail_open_reason');
  });
});
