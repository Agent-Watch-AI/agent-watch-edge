import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSetup } from '../src/cli/setup.js';
import { runToggle } from '../src/cli/toggle.js';
import { runUninstall } from '../src/cli/uninstall.js';
import { runHook } from '../src/cli/hook.js';
import { runConfig, runOtelHeaders } from '../src/cli/misc.js';
import { runStatus } from '../src/cli/status.js';
import { runDoctor } from '../src/cli/doctor.js';
import { queuePartition } from '../src/transport/queue-partition.js';
import { loadProvider } from '../src/providers/loaders.js';
import { resolvePaths } from '../src/storage/paths.js';
import { disabledFile, isDisabled } from '../src/storage/disabled.js';
import { defaultConfig } from '../src/config/config.js';
import { BLOCK_END, BLOCK_START } from '../src/providers/codex/constants/codex.otel.constants.js';
import { CONTENT_CAPTURE_ON, makeTempEnv, readJson, writeJson, type TempWorld } from './helpers.js';
import { antigravityPostTool, antigravityPreTool, antigravityStop } from './fixtures/antigravity.js';

describe('local off switch', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await writeJson(path.join(world.home, '.claude/settings.json'), { theme: 'dark' });
    await writeJson(path.join(world.home, '.gemini/settings.json'), { env: { UNRELATED: 'keep' }, theme: 'dark' });
    await fs.mkdir(path.join(world.home, '.codex'));
    await fs.writeFile(path.join(world.home, '.codex/config.toml'), '# user comment\nmodel = "user-model"\n');
    await writeJson(resolvePaths(world.env).configFile, {
      ...defaultConfig(),
      contentCaptureConsent: true,
      capture: { ...CONTENT_CAPTURE_ON, git: true, files: true }
    });
    expect(await runSetup({ env: world.env, endpoint: 'https://example.com', token: 'test-token', developerEmail: 'dev@example.com', yes: true, hookCommandFor: (id) => `agentwatch hook --agent ${id}` })).toBe(0);
  });
  afterEach(async () => { await world.cleanup(); vi.restoreAllMocks(); });

  it('repeated off/on preserves hooks, config, queue and unrelated settings', async () => {
    const paths = resolvePaths(world.env);
    const config = await fs.readFile(paths.configFile, 'utf8');
    const hooks = await fs.readFile(path.join(world.home, '.codex/hooks.json'), 'utf8');

    // Where the configured identity's entries live; a legacy flat file would be
    // settled into it on the next command anyway.
    const kept = path.join(queuePartition(paths.queueDir, 'test-token'), 'kept.json');

    await writeJson(kept, { retained: true });
    expect(await runToggle(world.env, false)).toBe(0);
    expect(await runToggle(world.env, false)).toBe(0);
    expect(await isDisabled(paths)).toBe(true);
    expect(await fs.readFile(paths.configFile, 'utf8')).toBe(config);
    expect(await readJson(kept)).toEqual({ retained: true });
    expect(await readJson(path.join(world.home, '.gemini/settings.json'))).toMatchObject({ env: { UNRELATED: 'keep' }, theme: 'dark' });
    expect(JSON.stringify(await readJson(path.join(world.home, '.gemini/settings.json')))).not.toContain('test-token');
    expect(await fs.readFile(path.join(world.home, '.codex/config.toml'), 'utf8')).not.toContain('[otel]');
    expect(await runSetup({ env: world.env, yes: true })).toBe(1);
    expect(await runToggle(world.env, true)).toBe(0);
    expect(await runToggle(world.env, true)).toBe(0);
    expect(await isDisabled(paths)).toBe(false);
    expect(await fs.readFile(path.join(world.home, '.codex/hooks.json'), 'utf8')).toBe(hooks);
    expect(await fs.readFile(path.join(world.home, '.codex/config.toml'), 'utf8')).toContain('# user comment');
    expect((await readJson(path.join(world.home, '.gemini/settings.json'))).env.OTEL_EXPORTER_OTLP_HEADERS).toContain('test-token');
  });

  it('disabled hooks skip stdin, networking, queueing and diagnostics never send or reveal a token', async () => {
    await runToggle(world.env, false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not send'));
    const stdout = vi.mocked(process.stdout.write);

    stdout.mockClear();
    expect(await runHook('claude', { env: world.env })).toBe(0);
    expect(await fs.readdir(resolvePaths(world.env).queueDir).catch(() => [])).toEqual([]);
    await runOtelHeaders(world.env);
    expect(stdout.mock.calls.flat().join('')).toBe('{}');
    await runConfig(world.env);
    await runStatus(world.env);
    await runDoctor(world.env, { json: true });
    expect(stdout.mock.calls.flat().join('')).toContain('DISABLED');
    expect(stdout.mock.calls.flat().join('')).not.toContain('test-token');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([false, true])('uninstall while disabled (purge=%s) does not resurrect telemetry', async (purge) => {
    await runToggle(world.env, false);
    expect(await runUninstall({ env: world.env, purge })).toBe(0);
    expect(await runToggle(world.env, true)).toBe(0);
    expect(await fs.readFile(path.join(world.home, '.codex/config.toml'), 'utf8')).not.toContain('[otel]');
    expect((await readJson(path.join(world.home, '.gemini/settings.json'))).env).toEqual({ UNRELATED: 'keep' });
  });

  it('a retried off finishes a disable that failed part way', async () => {
    await runToggle(world.env, false);
    // A user (or a crashed first pass) leaves a managed exporter behind; the
    // marker is already on disk, which is exactly when the retry must still work.
    await fs.appendFile(path.join(world.home, '.codex/config.toml'), `\n${BLOCK_START}\n[otel]\nexporter = "leftover"\n${BLOCK_END}\n`);
    expect(await runToggle(world.env, false)).toBe(0);
    expect(await fs.readFile(path.join(world.home, '.codex/config.toml'), 'utf8')).not.toContain('leftover');
    expect(await isDisabled(resolvePaths(world.env))).toBe(true);
  });

  it('a disabled hook still answers a provider that needs a decision', async () => {
    await runToggle(world.env, false);
    const stdout = vi.mocked(process.stdout.write);

    stdout.mockClear();
    expect(await runHook('antigravity', { env: world.env })).toBe(0);
    expect(JSON.parse(stdout.mock.calls.flat().join(''))).toEqual({ decision: 'allow' });
  });

  it('sweeps every managed exporter even when install state is unreadable', async () => {
    const paths = resolvePaths(world.env);

    // loadInstallState degrades a corrupt file to {agents:{}}. Deriving the work
    // from it made `off` a no-op that reported success while the Codex block and
    // the Gemini headers kept the bearer token in place.
    await fs.writeFile(paths.installStateFile, '{ not json');
    expect(await runToggle(world.env, false)).toBe(0);
    expect(await fs.readFile(path.join(world.home, '.codex/config.toml'), 'utf8')).not.toContain('test-token');
    expect((await readJson(path.join(world.home, '.gemini/settings.json'))).env).toEqual({ UNRELATED: 'keep' });
  });

  it('recovers from a marker it cannot read instead of wedging both directions', async () => {
    const paths = resolvePaths(world.env);

    await runToggle(world.env, false);
    await fs.writeFile(disabledFile(paths), '');
    // Previously both `off` and `on` returned 1 here and only hand-deleting the
    // file got the machine moving again.
    expect(await runToggle(world.env, false)).toBe(0);
    expect(await runToggle(world.env, true)).toBe(0);
    expect(await isDisabled(paths)).toBe(false);
  });

  it('answers each Antigravity hook shape, not one fallback for all of them', async () => {
    await runToggle(world.env, false);
    const stdout = vi.mocked(process.stdout.write);
    const run = async (payload: unknown) => {
      stdout.mockClear();
      await runHook('antigravity', { env: world.env, input: JSON.stringify(payload) });

      return stdout.mock.calls.flat().join('');
    };

    expect(JSON.parse(await run(antigravityStop()))).toEqual({ decision: 'stop' });
    expect(JSON.parse(await run(antigravityPreTool('Bash', { command: 'ls' })))).toEqual({ decision: 'allow' });
    // A post-tool result carries no decision; sending one is not silence.
    expect(await run(antigravityPostTool('Bash', { command: 'ls' }))).toBe('{}');
  });

  it('off/on keeps the trust hashes Codex parks inside our markers', async () => {
    const configPath = path.join(world.home, '.codex/config.toml');
    const withTrust = (await fs.readFile(configPath, 'utf8')).replace(
      BLOCK_END,
      '\n[hooks.state."/Users/dev/.codex/hooks.json:abc123"]\ntrusted_hash = "sha256:abc123"\n\n' + BLOCK_END
    );

    // Codex re-serializes config.toml as it runs and appends its own tables
    // after [otel] but before our end marker. Removing the whole marker span
    // took the trust hashes with it, so every off/on cost the developer another
    // `codex` -> /hooks -> trust round.
    await fs.writeFile(configPath, withTrust);
    expect(await runToggle(world.env, false)).toBe(0);

    const stopped = await fs.readFile(configPath, 'utf8');

    expect(stopped).toContain('trusted_hash = "sha256:abc123"');
    expect(stopped).not.toContain('[otel]');
    expect(stopped).toContain('# user comment');
    expect(await runToggle(world.env, true)).toBe(0);

    const resumed = await fs.readFile(configPath, 'utf8');

    expect(resumed).toContain('trusted_hash = "sha256:abc123"');
    expect(resumed).toContain('[otel]');
    // The lifted table has to land as a table, not as keys of [otel].
    expect(parseToml(resumed)).toMatchObject({ otel: {}, hooks: { state: { '/Users/dev/.codex/hooks.json:abc123': { trusted_hash: 'sha256:abc123' } } } });
  });

  it('an off run before enrollment does not lock the machine out of setup', async () => {
    const paths = resolvePaths(world.env);

    // off -> on -> setup all refused each other: `on` would not clear the marker
    // without a valid config, and setup would not run while the marker was there.
    await runToggle(world.env, false);
    await fs.rm(paths.configFile);
    expect(await runToggle(world.env, true)).toBe(0);
    expect(await isDisabled(paths)).toBe(false);
    expect(await runSetup({ env: world.env, endpoint: 'https://example.com', token: 'test-token', developerEmail: 'dev@example.com', yes: true, hookCommandFor: (id) => `agentwatch hook --agent ${id}` })).toBe(0);
  });

  it('a refusal to re-enable names the marker that has to go', async () => {
    const paths = resolvePaths(world.env);
    const stdout = vi.mocked(process.stdout.write);

    await runToggle(world.env, false);
    await fs.writeFile(paths.configFile, '{ not json');
    stdout.mockClear();
    expect(await runToggle(world.env, true)).toBe(1);
    expect(stdout.mock.calls.flat().join('')).toContain(disabledFile(paths));
  });

  it('a disabled hook that throws still answers the agent', async () => {
    const provider = await loadProvider('antigravity');
    const stdout = vi.mocked(process.stdout.write);

    await runToggle(world.env, false);
    // The fast path used to sit outside the try that exists so telemetry can
    // never break the agent: a throw here exited 0 with nothing on stdout, and
    // an Antigravity PreToolUse reads that as no decision at all.
    vi.spyOn(provider!, 'getHookResponse').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    stdout.mockClear();
    expect(await runHook('antigravity', { env: world.env, input: JSON.stringify(antigravityPreTool('Bash', { command: 'ls' })) })).toBe(0);
    expect(JSON.parse(stdout.mock.calls.flat().join(''))).toEqual({ decision: 'allow' });
  });

  it('restoration refuses conflicting user telemetry and retains the marker', async () => {
    await runToggle(world.env, false);
    await fs.appendFile(path.join(world.home, '.codex/config.toml'), '\n[otel]\nexporter = "none"\n');
    expect(await runToggle(world.env, true)).toBe(1);
    expect(await isDisabled(resolvePaths(world.env))).toBe(true);
    expect(await fs.readFile(path.join(world.home, '.codex/config.toml'), 'utf8')).not.toContain('test-token');
  });
});
