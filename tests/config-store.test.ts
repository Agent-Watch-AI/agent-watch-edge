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

  it('defaults to the two-record product contract', () => {
    const config = defaultConfig();
    expect(config.emit.turnSummaries).toBe(true);
    expect(config.emit.llmCalls).toBe(true);
    expect(Object.keys(config.emit).sort()).toEqual(['llmCalls', 'turnSummaries']);
  });

  it('a parsed config keeps its capture settings', async () => {
    const paths = resolvePaths(world.env);
    await writeJson(paths.configFile, defaultConfig());
    const result = await loadConfig(paths);
    expect(result.state).toBe('ok');
    expect(result.config.capture.prompts).toBe(true);
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
