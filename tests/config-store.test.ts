import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeTempEnv, writeJson, type TempWorld } from './helpers.js';
import { loadConfig } from '../src/config/config-store.js';
import { resolvePaths } from '../src/storage/paths.js';
import { defaultConfig, parseOtelSignals } from '../src/config/config.js';

describe('config load fallback', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  it('defaults to mandatory usage and turn-summary emission', () => {
    const config = defaultConfig();

    expect(config.emit.turnSummaries).toBe(true);
    expect(config.emit.llmCalls).toBe(true);
    expect(Object.keys(config.emit).sort()).toEqual(['llmCalls', 'turnSummaries']);
  });

  it('the shipped defaults capture metadata but no content', () => {
    const capture = defaultConfig().capture;

    expect(capture.prompts).toBe(false);
    expect(capture.responses).toBe(false);
    expect(capture.toolInput).toBe(false);
    expect(capture.toolOutput).toBe(false);
    // Repo/branch/SHA and per-file paths are metadata, and are what feature
    // and project attribution is built from.
    expect(capture.git).toBe(true);
    expect(capture.files).toBe(true);
  });

  it('a parsed config keeps its capture settings', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, { ...defaultConfig(), capture: { ...defaultConfig().capture, prompts: true } });
    const result = await loadConfig(paths);

    expect(result.state).toBe('ok');
    expect(result.config.capture.prompts).toBe(false);
  });

  it('migrates legacy emit.llmCalls=false without invalidating the rest of the config', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, {
      ...defaultConfig(),
      endpoint: 'https://backend.example.com',
      capture: { ...defaultConfig().capture, prompts: false },
      emit: { turnSummaries: false, llmCalls: false }
    });
    const result = await loadConfig(paths);

    expect(result.state).toBe('ok');
    expect(result.config.endpoint).toBe('https://backend.example.com');
    expect(result.config.capture.prompts).toBe(false);
    expect(result.config.emit.turnSummaries).toBe(false);
    expect(result.config.emit.llmCalls).toBe(true);
  });

  it('fails safe to metadata-only capture when the config file is missing', async () => {
    const result = await loadConfig(resolvePaths(world.env));

    expect(result.state).toBe('missing');
    expect(result.config.capture.prompts).toBe(false);
    expect(result.config.capture.responses).toBe(false);
    expect(result.config.capture.toolInput).toBe(false);
    expect(result.config.capture.toolOutput).toBe(false);
  });

  it('fails safe to metadata-only capture when the config file is corrupt', async () => {
    const paths = resolvePaths(world.env);

    await fs.mkdir(path.dirname(paths.configFile), { recursive: true });
    await fs.writeFile(paths.configFile, '{ broken json');
    const result = await loadConfig(paths);

    expect(result.state).toBe('invalid');
    expect(result.config.capture.prompts).toBe(false);
    expect(result.config.capture.toolOutput).toBe(false);
  });
});

describe('otel signal selection', () => {
  it('defaults to the logs ledger only', () => {
    expect(defaultConfig().otel).toEqual({ logs: true, traces: false, metrics: false });
  });

  it('parses --otel values', () => {
    expect(parseOtelSignals('all')).toEqual({ logs: true, traces: true, metrics: true });
    expect(parseOtelSignals('none')).toEqual({ logs: false, traces: false, metrics: false });
    expect(parseOtelSignals('logs,metrics')).toEqual({ logs: true, traces: false, metrics: true });
    expect(parseOtelSignals(' Traces ')).toEqual({ logs: false, traces: true, metrics: false });
    expect(parseOtelSignals('logz')).toBeUndefined();
  });
});

describe('a bearer may only travel over a URL that cannot leak it', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  /** Load a hand-edited config file, which is how capture is documented to be enabled. */
  async function loadWith(overrides: Record<string, unknown>) {
    await writeJson(resolvePaths(world.env).configFile, { ...defaultConfig(), token: 'aw_edge_secret', ...overrides });

    return loadConfig(resolvePaths(world.env));
  }

  it('accepts https anywhere and http on loopback', async () => {
    expect((await loadWith({ endpoint: 'https://backend.example.com' })).state).toBe('ok');
    expect((await loadWith({ endpoint: 'http://127.0.0.1:4318' })).state).toBe('ok');
    expect((await loadWith({ endpoint: 'http://localhost:4318' })).state).toBe('ok');
  });

  it('refuses plain http to anywhere else, so the token cannot cross a network in cleartext', async () => {
    const result = await loadWith({ endpoint: 'http://backend.example.com' });

    expect(result.state).toBe('invalid');
    expect(result.state === 'invalid' ? result.error : '').toContain('https');
  });

  it('refuses the schemes z.string().url() would otherwise wave through', async () => {
    for (const endpoint of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x', 'ftp://backend.example.com']) {
      expect((await loadWith({ endpoint })).state, endpoint).toBe('invalid');
    }
  });

  it('applies the same rule to every URL field, including a per-root override', async () => {
    expect((await loadWith({ eventsUrl: 'http://backend.example.com/v1/events' })).state).toBe('invalid');
    expect((await loadWith({ otlpUrl: 'http://backend.example.com' })).state).toBe('invalid');
    expect((await loadWith({ enforcementUrl: 'http://backend.example.com/v1/decide' })).state).toBe('invalid');
    expect((await loadWith({ roots: { '/repo': { endpoint: 'http://backend.example.com' } } })).state).toBe('invalid');
  });
});
