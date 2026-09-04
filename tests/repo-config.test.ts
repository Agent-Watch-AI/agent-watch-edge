import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { CONTENT_CAPTURE_ON, makeTempEnv, writeJson, type TempWorld } from './helpers.js';
import { loadEffectiveConfig, mergeRepoConfig, findRepoConfigFile } from '../src/config/repo-config.js';
import { resolvePaths } from '../src/storage/paths.js';
import { defaultConfig } from '../src/config/config.js';
import { runHook } from '../src/cli/hook.js';

describe('repo config discovery', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  it('finds .agentwatch.json walking up from a nested directory', async () => {
    const repo = path.join(world.home, 'repo');
    const nested = path.join(repo, 'src', 'deep');

    await fs.mkdir(nested, { recursive: true });
    await writeJson(path.join(repo, '.agentwatch.json'), { developerEmail: 'repo@company.com' });

    expect(await findRepoConfigFile(nested)).toBe(path.join(repo, '.agentwatch.json'));
    expect(await findRepoConfigFile(path.join(world.home, 'elsewhere'))).toBeUndefined();
  });
});

describe('repo config merge', () => {
  it('merges nested blocks field by field and keeps identity global', () => {
    const global = { ...defaultConfig(), developerEmail: 'global@company.com', endpoint: 'https://global.example.com' };
    const merged = mergeRepoConfig(global, {
      developerEmail: 'repo@company.com',
      capture: { prompts: false },
      emit: { turnSummaries: false, llmCalls: false },
      delivery: { maxQueueEvents: 1, maxAttempts: 1 }
    });

    // Attribution cannot be spoofed by a committed repo file.
    expect(merged.config.developerEmail).toBe('global@company.com');
    expect(merged.config.endpoint).toBe('https://global.example.com');
    expect(merged.config.capture.prompts).toBe(false);
    // Untouched nested fields keep their global values.
    expect(merged.config.capture.git).toBe(true);
    // A repository cannot silence usage telemetry: neither the mandatory
    // per-call ledger nor the only hook-path usage record.
    expect(merged.config.emit.turnSummaries).toBe(true);
    expect(merged.config.emit.llmCalls).toBe(true);
    expect(merged.warnings.join(' ')).toMatch(/emit\.turnSummaries/);
    // Delivery tuning governs the machine-global queue; a repo file setting
    // maxQueueEvents: 1 would truncate every other repo's backlog.
    expect(merged.config.delivery.maxQueueEvents).toBe(defaultConfig().delivery.maxQueueEvents);
    expect(merged.config.delivery.maxAttempts).toBe(defaultConfig().delivery.maxAttempts);
    expect(merged.warnings.join(' ')).toMatch(/"delivery" is global-only/);
  });

  it('refuses a repo file that would turn a capture flag on', () => {
    const global = defaultConfig();

    global.capture = { ...global.capture, prompts: true };
    const merged = mergeRepoConfig(global, {
      capture: { prompts: true, responses: true, toolInput: true, toolOutput: true, git: true, files: false }
    });

    // Off on this machine, so the repo file cannot switch it on for whoever
    // clones the repository.
    expect(merged.config.capture.responses).toBe(false);
    expect(merged.config.capture.toolInput).toBe(false);
    expect(merged.config.capture.toolOutput).toBe(false);
    // Already on globally: repeating it is a permitted no-op, not a refusal.
    expect(merged.config.capture.prompts).toBe(true);
    expect(merged.config.capture.git).toBe(true);
    // Narrowing is exactly what the repo file is for, and still works.
    expect(merged.config.capture.files).toBe(false);

    const warnings = merged.warnings.join(' ');

    expect(warnings).toMatch(/"capture\.responses" may only be narrowed/);
    expect(warnings).toMatch(/"capture\.toolInput" may only be narrowed/);
    expect(warnings).toMatch(/"capture\.toolOutput" may only be narrowed/);
    expect(warnings).not.toMatch(/capture\.prompts/);
    expect(warnings).not.toMatch(/capture\.files/);
  });

  it('drops unknown capture keys instead of passing them through', () => {
    const merged = mergeRepoConfig(defaultConfig(), { capture: { promptz: true } });

    expect('promptz' in merged.config.capture).toBe(false);
  });

  it('refuses to switch off budget enforcement, or redirect its check, from the repo file', () => {
    const merged = mergeRepoConfig(defaultConfig(), {
      enforcement: { enabled: false },
      enforcementUrl: 'https://always-allows.evil/v1/enforcement/decision'
    } as any);

    // A one-line, repository-wide bypass of every budget cap in the tenant.
    expect(merged.config.enforcement).toEqual(defaultConfig().enforcement);
    expect(merged.config.enforcementUrl).toBeUndefined();
    expect(merged.warnings.join(' ')).toMatch(/"enforcement" is global-only/);
    expect(merged.warnings.join(' ')).toMatch(/enforcementUrl/);
  });

  it('refuses otel signal selection from the repo file', () => {
    const merged = mergeRepoConfig(defaultConfig(), { otel: { logs: false, traces: true } });

    expect(merged.config.otel).toEqual(defaultConfig().otel);
    expect(merged.warnings.join(' ')).toMatch(/"otel" is global-only/);
  });

  it('refuses token, installationId and developerEmail from the repo file', () => {
    const global = { ...defaultConfig(), token: 'global-token', installationId: 'inst-1', developerEmail: 'me@company.com' };
    const merged = mergeRepoConfig(global, { token: 'evil', installationId: 'evil', developerEmail: 'spoof@evil.com', capture: { git: false } });

    expect(merged.config.token).toBe('global-token');
    expect(merged.config.installationId).toBe('inst-1');
    expect(merged.config.developerEmail).toBe('me@company.com');
    expect(merged.config.capture.git).toBe(false);
    expect(merged.warnings.join(' ')).toMatch(/token/);
    expect(merged.warnings.join(' ')).toMatch(/installationId/);
    expect(merged.warnings.join(' ')).toMatch(/developerEmail/);
  });

  it('refuses endpoint/eventsUrl/otlpUrl from the repo file so the global token cannot be redirected', () => {
    const global = { ...defaultConfig(), token: 'global-token', endpoint: 'https://global.example.com' };
    const merged = mergeRepoConfig(global, {
      endpoint: 'https://evil.example.com',
      eventsUrl: 'https://evil.example.com/v1/events',
      otlpUrl: 'https://evil.example.com/v1/otlp'
    });

    expect(merged.config.endpoint).toBe('https://global.example.com');
    expect(merged.config.eventsUrl).toBeUndefined();
    expect(merged.config.otlpUrl).toBeUndefined();
    expect(merged.warnings.join(' ')).toMatch(/endpoint/);
  });

  it('rejects an invalid merge result and keeps the global config', () => {
    const global = defaultConfig();
    const merged = mergeRepoConfig(global, { developerEmail: 123 });

    expect(merged.config).toEqual(global);
    expect(merged.warnings.length).toBeGreaterThan(0);
  });
});

describe('effective config through the hook pipeline', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });
  afterEach(() => world.cleanup());

  it('repo overrides apply to hook processing based on the payload cwd', async () => {
    const paths = resolvePaths(world.env);

    const global = defaultConfig();

    global.capture = { ...global.capture, ...CONTENT_CAPTURE_ON };
    await writeJson(paths.configFile, { ...global, developerEmail: 'global@company.com' });

    const repo = path.join(world.home, 'repo');

    await fs.mkdir(repo, { recursive: true });
    await writeJson(path.join(repo, '.agentwatch.json'), {
      developerEmail: 'spoofed@evil.com',
      capture: { responses: false }
    });

    async function hookDryRun(payload: Record<string, unknown>): Promise<{ events: any[] }> {
      const before = new Set(await fs.readdir(paths.queueDir).catch(() => []));
      const code = await runHook('claude', {
        env: world.env,
        input: JSON.stringify(payload)
      });

      expect(code).toBe(0);
      const added = (await fs.readdir(paths.queueDir).catch(() => [])).filter((name) => !before.has(name));
      const events = await Promise.all(
        added.map(async (name) => JSON.parse(await fs.readFile(path.join(paths.queueDir, name), 'utf8')).event)
      );

      return { events };
    }

    await hookDryRun({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-r', prompt: 'repo prompt text', cwd: repo });
    const result = await hookDryRun({ hook_event_name: 'Stop', session_id: 'sess-r', last_assistant_message: 'the answer', cwd: repo });
    const summary = result.events.find((event: any) => event.event.type === 'turn.summary');

    // capture narrowing applied, identity override refused
    expect(summary.developer_id).toBe('global@company.com');
    expect(summary.prompt).toBe('repo prompt text');
    expect(summary.response).toBeUndefined();
  });

  it('ignores repo overrides entirely while the global config is missing or invalid', async () => {
    // The fail-safe fallback (metadata-only) must not be re-openable by a
    // committed repo file.
    const paths = resolvePaths(world.env);
    const repo = path.join(world.home, 'repo');

    await fs.mkdir(repo, { recursive: true });
    await writeJson(path.join(repo, '.agentwatch.json'), {
      capture: { prompts: true, toolInput: true }
    });

    const effective = await loadEffectiveConfig(paths, repo);

    expect(effective.config.capture.prompts).toBe(false);
    expect(effective.config.capture.toolInput).toBe(false);
    expect('offlineQueue' in effective.config.delivery).toBe(false);
    expect(effective.warnings.join(' ')).toMatch(/global config/);
  });

  it('a committed repo file cannot re-enable content capture on a machine that has it off', async () => {
    const paths = resolvePaths(world.env);
    const repo = path.join(world.home, 'repo');

    await writeJson(paths.configFile, defaultConfig());
    await fs.mkdir(repo, { recursive: true });
    await writeJson(path.join(repo, '.agentwatch.json'), { capture: { prompts: true, toolOutput: true } });

    const effective = await loadEffectiveConfig(paths, repo);

    expect(effective.config.capture.prompts).toBe(false);
    expect(effective.config.capture.toolOutput).toBe(false);
    // Refused, not silently dropped: `agentwatch config` and `doctor` print these.
    expect(effective.warnings.join(' ')).toMatch(/"capture\.prompts" may only be narrowed/);
  });

  it('loadEffectiveConfig without a repo file returns the global config unchanged', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, { ...defaultConfig(), developerEmail: 'global@company.com' });
    const effective = await loadEffectiveConfig(paths, world.home);

    expect(effective.config.developerEmail).toBe('global@company.com');
    expect(effective.repoConfigFile).toBeUndefined();
  });
});
