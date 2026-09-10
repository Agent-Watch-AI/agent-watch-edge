import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadConfig, saveConfig } from '../src/config/config-store.js';
import { resolvePaths } from '../src/storage/paths.js';
import { defaultConfig, eventsUrl, otlpBaseUrl, parseOtelSignals } from '../src/config/config.js';
import { applyRootOverride } from '../src/config/root-config.js';
import { makeTempEnv, readJson, writeJson, type TempWorld } from './helpers.js';

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

    // Null, not absent: "a URL was written here and refused". See the per-root
    // case below for why the distinction decides where events go.
    expect(result.config.endpoint).toBeNull();
    expect(result.warnings.join(' ')).toContain('https');
  });

  it('refuses the schemes z.string().url() would otherwise wave through', async () => {
    for (const endpoint of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x', 'ftp://backend.example.com']) {
      const result = await loadWith({ endpoint });

      expect(result.config.endpoint, endpoint).toBeNull();
      expect(result.warnings, endpoint).toEqual([expect.stringContaining('endpoint')]);
    }
  });

  it('applies the same rule to every URL field, including a per-root override', async () => {
    expect((await loadWith({ eventsUrl: 'http://backend.example.com/v1/events' })).config.eventsUrl).toBeNull();
    expect((await loadWith({ otlpUrl: 'http://backend.example.com' })).config.otlpUrl).toBeNull();
    expect((await loadWith({ enforcementUrl: 'http://backend.example.com/v1/decide' })).config.enforcementUrl).toBeNull();

    const rooted = await loadWith({ roots: { '/repo': { endpoint: 'http://backend.example.com' } } });

    expect(rooted.config.roots?.['/repo']?.endpoint).toBeNull();
    expect(rooted.warnings).toEqual([expect.stringContaining('roots./repo.endpoint')]);
  });

  // The whole reason the rule refuses a field instead of failing the parse: a
  // failed parse answers with `fallbackConfig()`, which has no token, so an
  // upgrade of a fleet on an internal http endpoint lost the identity its
  // existing backlog is partitioned under — and one typo in one project's
  // `roots[]` entry stopped delivery for every other project on the machine.
  it('keeps the identity, and the rest of the file, when one URL is refused', async () => {
    const result = await loadWith({
      endpoint: 'https://backend.example.com',
      roots: { '/repo': { endpoint: 'http://collector.corp:4318', token: 'aw_edge_root' } }
    });

    expect(result.state).toBe('ok');
    expect(result.config.token).toBe('aw_edge_secret');
    expect(result.config.endpoint).toBe('https://backend.example.com');
    expect(result.config.roots?.['/repo']?.token).toBe('aw_edge_root');
    expect(result.warnings).toEqual([expect.stringContaining('roots./repo.endpoint')]);
  });

  // A refused root URL must read as "unusable", never as "absent". Absent, the
  // override is skipped by `compact` — which exists so an override cannot erase
  // a global — and the root inherits the *machine's* endpoint while keeping its
  // own bearer. On a consultant's machine that is every prompt, response and
  // branch name under `/work/clientA` POSTed to the other tenant's backend,
  // authenticated with clientA's token. Segregating tenants is the only reason
  // `roots` exists.
  it('does not let a root with a refused URL inherit the machine\'s backend', async () => {
    const repo = path.join(world.home, 'work', 'clientA');
    const result = await loadWith({
      endpoint: 'https://mycorp.example.com',
      roots: { [repo]: { endpoint: 'http://collector.clienta.internal', token: 'aw_edge_client_a' } }
    });

    expect(result.config.roots?.[repo]?.endpoint).toBeNull();

    const rooted = applyRootOverride(result.config, repo).config;

    expect(rooted.token).toBe('aw_edge_client_a');
    expect(rooted.endpoint).not.toBe('https://mycorp.example.com');
    expect(eventsUrl(rooted)).toBeUndefined();
  });

  // `endpoint` is not the only URL a `roots[]` entry may carry, and the two
  // siblings are read through `eventsUrl()`/`otlpBaseUrl()`, which fell back to
  // `endpoint` on any falsy value — so `null` ("refused") read as "not
  // overridden" and the root inherited the machine's backend through a sibling
  // key. The OTLP case is worse than the events one: `otel-headers` hands the
  // root's bearer to the agent's exporter only when the root's OTLP base equals
  // the machine's, so the fallback made them equal and opened that guard.
  it('does not let a refused eventsUrl or otlpUrl inherit the machine\'s backend either', async () => {
    const repo = path.join(world.home, 'work', 'clientA');
    const events = await loadWith({
      endpoint: 'https://mycorp.example.com',
      roots: { [repo]: { eventsUrl: 'http://collector.clienta.internal/v1/events', token: 'aw_edge_client_a' } }
    });

    expect(eventsUrl(applyRootOverride(events.config, repo).config)).toBeUndefined();

    const otlp = await loadWith({
      endpoint: 'https://mycorp.example.com',
      roots: { [repo]: { otlpUrl: 'http://collector.clienta.internal:4318', token: 'aw_edge_client_a' } }
    });
    const rooted = applyRootOverride(otlp.config, repo).config;

    expect(otlpBaseUrl(rooted)).toBeUndefined();
    expect(otlpBaseUrl(rooted)).not.toBe(otlpBaseUrl(otlp.config));
  });

  // A save must not answer a refusal by deleting it. The parsed config holds
  // `null` where the file holds the URL the developer typed, so writing the
  // parsed shape back is data loss — and it deletes the report with it, because
  // `nonDeliverableUrlFields` reads the raw file.
  it('carries a refused URL over a save instead of writing the parse back', async () => {
    const paths = resolvePaths(world.env);
    const repo = path.join(world.home, 'work', 'clientA');

    await writeJson(paths.configFile, {
      ...defaultConfig(),
      endpoint: 'https://mycorp.example.com',
      token: 'tok-global',
      roots: { [repo]: { endpoint: 'http://collector.clienta.internal', token: 'tok-client-a' } }
    });

    const loaded = await loadConfig(paths);

    await saveConfig(paths, { ...loaded.config, installationId: 'inst-1' });

    const onDisk = await readJson(paths.configFile);

    expect(onDisk.roots[repo].endpoint).toBe('http://collector.clienta.internal');
    expect(onDisk.roots[repo].token).toBe('tok-client-a');
    expect(onDisk.installationId).toBe('inst-1');
    expect((await loadConfig(paths)).warnings).toEqual([expect.stringContaining(`roots.${repo}.endpoint`)]);
  });

  // The other half of the same rule: a run that supplies a working URL is a
  // repair, not something to preserve the old value against.
  it('lets a replacement URL overwrite the refused one', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, { ...defaultConfig(), endpoint: 'http://collector.corp:4318', token: 'tok-global' });

    const loaded = await loadConfig(paths);

    await saveConfig(paths, { ...loaded.config, endpoint: 'https://collector.corp' });

    expect((await readJson(paths.configFile)).endpoint).toBe('https://collector.corp');
    expect((await loadConfig(paths)).warnings).toEqual([]);
  });

  // `.catch(null)` swallows every failure, not only a bad URL string, so the
  // report has to cover more than strings — a `null` from a config-management
  // tool that had no value to substitute is the same silent misroute as above.
  it('refuses and reports a URL field that is not even a string', async () => {
    const numbered = await loadWith({ endpoint: 12345 });

    expect(numbered.state).toBe('ok');
    expect(numbered.config.endpoint).toBeNull();
    expect(numbered.warnings).toEqual([expect.stringContaining('endpoint')]);

    const nulled = await loadWith({ roots: { '/repo': { otlpUrl: null, token: 'aw_edge_root' } } });

    expect(nulled.warnings).toEqual([expect.stringContaining('roots./repo.otlpUrl')]);
  });

  // `rootOverrideSchema` strips `enforcementUrl` as an unknown key whatever its
  // value, so it has never had any effect — and `doctor` turns any warning into
  // a failure, so reporting it failed the diagnostic over a field being
  // discarded either way.
  it('does not report a root field the schema does not accept', async () => {
    const result = await loadWith({ roots: { '/repo': { enforcementUrl: 'http://x.corp', token: 'aw_edge_root' } } });

    expect(result.warnings).toEqual([]);
  });
});
