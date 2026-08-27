import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempEnv, type TempWorld } from './helpers.js';
import { claudePreToolUseBash, claudeUserPromptSubmit } from './fixtures/claude.js';
import { codexUserPromptSubmit } from './fixtures/codex.js';
import { cursorBeforeSubmitPrompt } from './fixtures/cursor.js';
import { antigravityPreTool } from './fixtures/antigravity.js';
import { runHook } from '../src/cli/hook.js';
import { configSchema, defaultConfig } from '../src/config/config.js';
import { saveConfig } from '../src/config/config-store.js';
import type { AgentWatchConfig } from '../src/config/types/config.types.js';
import { resolveEnforcement } from '../src/enforcement/enforcement.js';
import { DecisionCache, decisionKey } from '../src/enforcement/decision-cache.js';
import { ENFORCEMENT_CACHE_FILE_NAME } from '../src/enforcement/constants/enforcement.constants.js';
import { resolvePaths } from '../src/storage/paths.js';

const DEVELOPER = 'ivan@acme.test';
const MESSAGE = 'Ivan Petrov passed his $500 hard limit and has now spent $612 this month.';
const ENDPOINT = 'https://backend.example.com';

/** A fetch that answers every request the same way and counts the calls. */
function answering(body: unknown, status = 200): { fetchFn: typeof fetch; calls: () => number; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (url: any) => {
    urls.push(String(url));

    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;

  return { fetchFn, calls: () => urls.length, urls };
}

/** A fetch that fails the way an unreachable backend does. */
const failing = (async () => {
  throw new Error('connect ECONNREFUSED');
}) as typeof fetch;

describe('enforcement decision', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  function config(overrides: Record<string, unknown> = {}): AgentWatchConfig {
    return configSchema.parse({ ...defaultConfig(), endpoint: ENDPOINT, token: 'aw_edge_test', ...overrides });
  }

  function ask(overrides: Record<string, unknown> = {}, fetchFn?: typeof fetch, identity: { developerId?: string } = { developerId: DEVELOPER }) {
    return resolveEnforcement({
      config: config(overrides),
      paths: resolvePaths(world.env),
      developerId: identity.developerId,
      now: world.env.now,
      fetchFn
    });
  }

  describe('only an explicit block blocks', () => {
    it('blocks on a decision that carries a message', async () => {
      const server = answering({ decision: 'block', message: MESSAGE });

      expect(await ask({}, server.fetchFn)).toEqual({ decision: 'block', message: MESSAGE });
      // The identity asked about is the one turn summaries carry.
      expect(server.urls[0]).toBe(`${ENDPOINT}/v1/enforcement/decision?developer_id=${encodeURIComponent(DEVELOPER)}`);
    });

    it('allows when nothing was asked: no endpoint, no token, disabled, nobody to ask about', async () => {
      const unasked = answering({ decision: 'block', message: MESSAGE });

      expect(await ask({ endpoint: undefined }, unasked.fetchFn)).toEqual({ decision: 'allow' });
      expect(await ask({ token: undefined }, unasked.fetchFn)).toEqual({ decision: 'allow' });
      expect(await ask({ enforcement: { enabled: false } }, unasked.fetchFn)).toEqual({ decision: 'allow' });
      expect(await ask({}, unasked.fetchFn, {})).toEqual({ decision: 'allow' });
      expect(await ask({}, unasked.fetchFn, { developerId: '' })).toEqual({ decision: 'allow' });
      // None of those five reached the network at all.
      expect(unasked.calls()).toBe(0);
    });

    it('allows on a network failure', async () => {
      expect(await ask({}, failing)).toEqual({ decision: 'allow' });
    });

    it('allows on every status that is not a 2xx', async () => {
      for (const status of [400, 401, 403, 404, 429, 500, 503]) {
        const server = answering({ decision: 'block', message: MESSAGE }, status);

        expect(await ask({}, server.fetchFn)).toEqual({ decision: 'allow' });
      }
    });

    it('allows on a body it cannot read as a decision', async () => {
      const bodies: unknown[] = [
        'not json at all',
        JSON.stringify([{ decision: 'block', message: MESSAGE }]),
        JSON.stringify({}),
        JSON.stringify({ decision: 'allow' }),
        // A decision this code does not know must never become a refusal.
        JSON.stringify({ decision: 'throttle', message: MESSAGE }),
        JSON.stringify({ decision: 'BLOCK', message: MESSAGE }),
        // A refusal a developer cannot act on is worse than no refusal.
        JSON.stringify({ decision: 'block' }),
        JSON.stringify({ decision: 'block', message: '   ' }),
        JSON.stringify({ decision: 'block', message: 42 })
      ];

      for (const body of bodies) {
        const server = answering(body);

        expect(await ask({}, server.fetchFn)).toEqual({ decision: 'allow' });
      }
    });

    it('allows when the backend needs longer than the timeout', async () => {
      // Honors the abort signal, so this asserts the timeout is actually wired
      // to the request and not just configured.
      const slow = ((_url: any, init: any) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(JSON.stringify({ decision: 'block', message: MESSAGE }))), 200);

          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('TimeoutError'));
          });
        })) as typeof fetch;

      expect(await ask({ enforcement: { timeoutMs: 20 } }, slow)).toEqual({ decision: 'allow' });
    });
  });

  describe('local cache', () => {
    const cacheFile = () => path.join(resolvePaths(world.env).dataDir, ENFORCEMENT_CACHE_FILE_NAME);

    it('asks once per TTL, for both answers', async () => {
      for (const answer of [{ decision: 'block', message: MESSAGE }, { decision: 'allow' }]) {
        const world2 = await makeTempEnv();
        const server = answering(answer);

        try {
          const first = await resolveEnforcement({ config: config(), paths: resolvePaths(world2.env), developerId: DEVELOPER, now: world2.env.now, fetchFn: server.fetchFn });
          const second = await resolveEnforcement({ config: config(), paths: resolvePaths(world2.env), developerId: DEVELOPER, now: world2.env.now, fetchFn: server.fetchFn });

          expect(second).toEqual(first);
          expect(server.calls()).toBe(1);
        } finally {
          await world2.cleanup();
        }
      }
    });

    it('asks again once the entry expires', async () => {
      let clock = new Date('2026-08-26T10:00:00.000Z');
      const server = answering({ decision: 'block', message: MESSAGE });
      const options = { config: config(), paths: resolvePaths(world.env), developerId: DEVELOPER, now: () => clock, fetchFn: server.fetchFn };

      await resolveEnforcement(options);
      clock = new Date('2026-08-26T10:00:59.000Z');
      await resolveEnforcement(options);

      expect(server.calls()).toBe(1);

      clock = new Date('2026-08-26T10:01:01.000Z');

      expect(await resolveEnforcement(options)).toEqual({ decision: 'block', message: MESSAGE });
      expect(server.calls()).toBe(2);
    });

    it('never caches a failure', async () => {
      await ask({}, failing);

      await expect(fs.readFile(cacheFile(), 'utf8')).rejects.toThrow();
    });

    it('treats an unreadable cache as a miss and never as a refusal', async () => {
      const key = decisionKey(`${ENDPOINT}/v1/enforcement/decision`, 'aw_edge_test', DEVELOPER);
      const entries: unknown[] = [
        'not json at all',
        JSON.stringify({ [key]: { decision: { decision: 'block' }, expiresAt: Number.MAX_SAFE_INTEGER } }),
        JSON.stringify({ [key]: { decision: { decision: 'unknown' }, expiresAt: Number.MAX_SAFE_INTEGER } }),
        JSON.stringify({ [key]: { decision: { decision: 'block', message: MESSAGE } } }),
        JSON.stringify({ [key]: 'block' })
      ];

      for (const entry of entries) {
        await fs.mkdir(path.dirname(cacheFile()), { recursive: true });
        await fs.writeFile(cacheFile(), entry as string);

        const server = answering({ decision: 'allow' });

        // A cache entry that does not validate must send the code to the
        // platform, not refuse a turn on its own.
        expect(await ask({}, server.fetchFn)).toEqual({ decision: 'allow' });
        expect(server.calls()).toBe(1);
      }
    });

    it('keeps the token and the identity out of the file', async () => {
      const server = answering({ decision: 'block', message: MESSAGE });

      await ask({}, server.fetchFn);

      const raw = await fs.readFile(cacheFile(), 'utf8');

      expect(raw).not.toContain('aw_edge_test');
      expect(raw).not.toContain(DEVELOPER);
      expect(raw).toContain(MESSAGE);
    });

    it('is a miss, not a throw, when the file cannot be written', async () => {
      // A path whose parents do not exist yet: the cache creates them.
      const nested = new DecisionCache(path.join(world.home, 'missing-dir', 'nested', 'cache.json'), world.env.now);

      await nested.write('key', { decision: 'allow' }, 1000);
      expect(await nested.read('key')).toEqual({ decision: 'allow' });

      // A path that is a directory: writing throws inside, and the read that
      // follows is a miss rather than a refusal.
      const unwritable = new DecisionCache(world.home, world.env.now);

      await unwritable.write('key', { decision: 'allow' }, 1000);
      expect(await unwritable.read('key')).toBeUndefined();
    });
  });
});

describe('enforcement through the hook', () => {
  let world: TempWorld;
  let server: http.Server;
  let endpoint: string;
  let answer: { status: number; body: unknown };
  let decisionRequests: number;

  beforeEach(async () => {
    world = await makeTempEnv();
    answer = { status: 200, body: { decision: 'block', message: MESSAGE } };
    decisionRequests = 0;

    server = http.createServer((request, response) => {
      if ((request.url ?? '').startsWith('/v1/enforcement/decision')) {
        decisionRequests += 1;
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));

        return;
      }

      // The events route: a refused prompt must still let the queue drain.
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: 1 }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();

    endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    await saveConfig(resolvePaths(world.env), {
      ...defaultConfig(),
      endpoint,
      token: 'aw_edge_test',
      installationId: 'inst-enforce',
      developerEmail: DEVELOPER
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.cleanup();
  });

  async function hook(agent: string, payload: unknown, dryRun = false): Promise<{ code: number; stdout: string }> {
    let stdout = '';
    const code = await runHook(agent, {
      env: world.env,
      input: JSON.stringify(payload),
      dryRun,
      writeStdout: (text) => {
        stdout += text;
      }
    });

    return { code, stdout };
  }

  it('refuses the prompt in each agent’s own protocol, with exit code 0', async () => {
    const cases: [string, unknown, unknown][] = [
      ['claude', claudeUserPromptSubmit, { decision: 'block', reason: MESSAGE }],
      ['codex', codexUserPromptSubmit, { continue: false, stopReason: MESSAGE, systemMessage: MESSAGE }],
      ['cursor', cursorBeforeSubmitPrompt, { continue: false, user_message: MESSAGE }],
      [
        'gemini',
        { hook_event_name: 'BeforeAgent', session_id: 'session-gem-1', prompt_id: 'turn-gem-1', prompt: 'Fix the bug' },
        { decision: 'deny', reason: MESSAGE }
      ]
    ];

    for (const [agent, payload, expected] of cases) {
      const result = await hook(agent, payload);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expected);
      // A prompt that never reached a model leaves no turn behind to be folded
      // into the next one.
      expect(await fs.readdir(resolvePaths(world.env).turnsDir).catch(() => [])).toEqual([]);
    }
  });

  it('stays silent — and records the turn — when the platform allows', async () => {
    answer = { status: 200, body: { decision: 'allow' } };

    const result = await hook('claude', claudeUserPromptSubmit);

    expect(result.stdout).toBe('');
    expect(await fs.readdir(resolvePaths(world.env).turnsDir).catch(() => [])).not.toEqual([]);
  });

  it('stays silent when the platform is broken, whatever it answers', async () => {
    for (const broken of [
      { status: 500, body: { decision: 'block', message: MESSAGE } },
      { status: 403, body: { message: 'This endpoint accepts Edge tokens only' } },
      { status: 200, body: { decision: 'block' } },
      { status: 200, body: 'not a decision' }
    ]) {
      const fresh = await makeTempEnv();

      answer = broken;

      await saveConfig(resolvePaths(fresh.env), { ...defaultConfig(), endpoint, token: 'aw_edge_test', developerEmail: DEVELOPER });

      let stdout = '';
      const code = await runHook('claude', {
        env: fresh.env,
        input: JSON.stringify(claudeUserPromptSubmit),
        writeStdout: (text) => {
          stdout += text;
        }
      });

      expect(code).toBe(0);
      expect(stdout).toBe('');
      await fresh.cleanup();
    }
  });

  it('asks only at the prompt, and never on a hook it cannot refuse', async () => {
    // A tool hook: the money for this turn is already spent, and no refusal
    // contract is used there.
    const preTool = await hook('claude', claudePreToolUseBash);

    expect(preTool.stdout).toBe('');
    expect(decisionRequests).toBe(0);

    // Antigravity has no prompt-level refusal contract: its own decision stands
    // even while the platform is answering `block`.
    const antigravity = await hook('antigravity', antigravityPreTool('run_command', { Command: 'npm test' }));

    expect(JSON.parse(antigravity.stdout)).toEqual({ decision: 'allow' });
    expect(decisionRequests).toBe(0);
  });

  it('never asks on a dry run', async () => {
    const result = await hook('claude', claudeUserPromptSubmit, true);

    expect(decisionRequests).toBe(0);
    expect(JSON.parse(result.stdout).events).toEqual([]);
  });

  it('asks once per TTL across hook processes', async () => {
    await hook('claude', claudeUserPromptSubmit);
    await hook('claude', { ...claudeUserPromptSubmit, prompt_id: 'prompt-second' });

    expect(decisionRequests).toBe(1);
  });
});
