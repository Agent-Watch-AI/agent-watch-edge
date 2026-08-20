import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectCodex, codexHooksJsonPath, codexConfigTomlPath } from '../src/providers/codex/codex.detect.js';
import { installCodexHooks, uninstallCodexHooks, CODEX_HOOK_EVENTS } from '../src/providers/codex/codex.hooks.js';
import { CodexOtelConfigurator } from '../src/providers/codex/codex.otel.js';
import { resolvePaths } from '../src/storage/paths.js';
import { defaultConfig } from '../src/config/config.js';
import type { SetupContext } from '../src/providers/provider.js';
import { parse as parseToml } from 'smol-toml';
import { makeTempEnv, readJson, writeJson, type TempWorld } from './helpers.js';

const HOOK_CMD = 'agentwatch hook --agent codex';

describe('Codex provider', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
  });

  afterEach(async () => {
    await world.cleanup();
  });

  function setupContext(): SetupContext {
    const config = defaultConfig();

    config.endpoint = 'https://backend.example.com';
    config.installationId = 'inst-1';

    return {
      env: world.env,
      paths: resolvePaths(world.env),
      config,
      hookCommand: HOOK_CMD,
      installState: { schemaVersion: 1, agents: {} }
    };
  }

  describe('detection', () => {
    it('is not detected in a clean environment', async () => {
      expect((await detectCodex(world.env)).detected).toBe(false);
    });

    it('detects via ~/.codex directory and honors CODEX_HOME', async () => {
      await fs.mkdir(path.join(world.home, '.codex'), { recursive: true });
      expect((await detectCodex(world.env)).detected).toBe(true);

      const custom = path.join(world.home, 'custom-codex');

      world.env.vars['CODEX_HOME'] = custom;
      expect(codexHooksJsonPath(world.env)).toBe(path.join(custom, 'hooks.json'));
    });
  });

  describe('hook installation', () => {
    it('writes a strictly-valid hooks.json (only description/hooks keys)', async () => {
      const outcome = await installCodexHooks(setupContext());

      expect(outcome.ok).toBe(true);
      const file = await readJson(codexHooksJsonPath(world.env));

      expect(Object.keys(file).every((key) => key === 'hooks' || key === 'description')).toBe(true);

      for (const eventName of CODEX_HOOK_EVENTS) {
        expect(file.hooks[eventName][0].hooks[0]).toEqual({ type: 'command', command: HOOK_CMD, timeout: 30 });
      }
    });

    it('mentions the /hooks trust step', async () => {
      const outcome = await installCodexHooks(setupContext());

      expect(outcome.messages.join(' ')).toContain('/hooks');
    });

    it('preserves user hook groups and is idempotent', async () => {
      const hooksPath = codexHooksJsonPath(world.env);

      await writeJson(hooksPath, {
        hooks: { PreToolUse: [{ matcher: '^shell$', hooks: [{ type: 'command', command: 'my-checker' }] }] }
      });
      await installCodexHooks(setupContext());
      const first = await fs.readFile(hooksPath, 'utf8');
      const second = await installCodexHooks(setupContext());

      expect(second.changed).toBe(false);
      expect(await fs.readFile(hooksPath, 'utf8')).toBe(first);
      const file = JSON.parse(first);

      expect(file.hooks.PreToolUse[0].hooks[0].command).toBe('my-checker');
      expect(file.hooks.PreToolUse).toHaveLength(2);
    });

    it('refuses files with keys Codex would reject', async () => {
      await writeJson(codexHooksJsonPath(world.env), { version: 1, hooks: {} });
      const outcome = await installCodexHooks(setupContext());

      expect(outcome.ok).toBe(false);
      expect(outcome.messages[0]).toContain('version');
    });

    it('warns when the hooks feature is disabled', async () => {
      await fs.mkdir(path.dirname(codexConfigTomlPath(world.env)), { recursive: true });
      await fs.writeFile(codexConfigTomlPath(world.env), '[features]\nhooks = false\n');
      const outcome = await installCodexHooks(setupContext());

      expect(outcome.messages.join(' ')).toContain('hooks are disabled');
    });
  });

  describe('hook uninstall', () => {
    it('removes only AgentWatch groups', async () => {
      const hooksPath = codexHooksJsonPath(world.env);

      await writeJson(hooksPath, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] }
      });
      const context = setupContext();

      await installCodexHooks(context);
      const outcome = await uninstallCodexHooks(context);

      expect(outcome.changed).toBe(true);
      const file = await readJson(hooksPath);

      expect(file.hooks.Stop).toHaveLength(1);
      expect(file.hooks.Stop[0].hooks[0].command).toBe('notify-send done');
      expect(JSON.stringify(file)).not.toContain('agentwatch');
    });

    it('keeps a user handler that shares a group with AgentWatch', async () => {
      const hooksPath = codexHooksJsonPath(world.env);

      await writeJson(hooksPath, {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'agentwatch hook --agent codex', timeout: 30 },
                { type: 'command', command: 'notify-send done' }
              ]
            }
          ]
        }
      });
      const outcome = await uninstallCodexHooks(setupContext());

      expect(outcome.changed).toBe(true);
      const file = await readJson(hooksPath);

      expect(file.hooks.Stop).toHaveLength(1);
      expect(file.hooks.Stop[0].hooks).toEqual([{ type: 'command', command: 'notify-send done' }]);
    });

    it('preserves the top-level description when the last hook is removed', async () => {
      const hooksPath = codexHooksJsonPath(world.env);

      await writeJson(hooksPath, { description: 'my hooks file', hooks: {} });
      const context = setupContext();

      await installCodexHooks(context);
      await uninstallCodexHooks(context);
      const file = await readJson(hooksPath);

      expect(file.description).toBe('my hooks file');
      expect(file.hooks).toEqual({});
    });
  });

  describe('native OpenTelemetry', () => {
    it('appends a marker-delimited [otel] block preserving user content', async () => {
      const configPath = codexConfigTomlPath(world.env);

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = '# my precious comment\nmodel = "gpt-5.2-codex"\n\n[tui]\nnotifications = true\n';

      await fs.writeFile(configPath, original);

      const context = setupContext();

      context.config.token = 'tok-abc';
      const outcome = await new CodexOtelConfigurator().configure(context);

      expect(outcome.ok).toBe(true);

      const raw = await fs.readFile(configPath, 'utf8');

      expect(raw).toContain('# my precious comment');
      expect(raw).toContain('model = "gpt-5.2-codex"');
      expect(raw).toContain('>>> agentwatch managed block');
      const parsed = parseToml(raw) as any;

      expect(parsed.otel.exporter['otlp-http'].endpoint).toBe('https://backend.example.com/v1/otlp/v1/logs');
      expect(parsed.otel.exporter['otlp-http'].protocol).toBe('json');
      expect(parsed.otel.exporter['otlp-http'].headers.Authorization).toBe('Bearer tok-abc');
      // Default signal selection: logs only.
      expect(parsed.otel.trace_exporter).toBe('none');
      expect(parsed.otel.metrics_exporter).toBe('none');
    });

    it('enables the trace exporter when otel.traces is on', async () => {
      const context = setupContext();

      context.config.otel = { logs: true, traces: true, metrics: false };
      await new CodexOtelConfigurator().configure(context);
      const parsed = parseToml(await fs.readFile(codexConfigTomlPath(world.env), 'utf8')) as any;

      expect(parsed.otel.trace_exporter['otlp-http'].endpoint).toBe('https://backend.example.com/v1/otlp/v1/traces');
    });

    it('otel none removes the managed block and reports configured', async () => {
      const configurator = new CodexOtelConfigurator();
      const enabled = setupContext();
      const first = await configurator.configure(enabled);

      const disabled: SetupContext = { ...setupContext(), installState: first.installState ?? enabled.installState };

      disabled.config.otel = { logs: false, traces: false, metrics: false };
      const outcome = await configurator.configure(disabled);

      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(true);
      expect(await fs.readFile(codexConfigTomlPath(world.env), 'utf8')).not.toContain('[otel]');
      const status = await configurator.inspect(disabled);

      expect(status.configured).toBe(true);
      expect(status.detail).toContain('disabled in config');
    });

    it('is idempotent and updates the managed block in place', async () => {
      const context = setupContext();
      const configurator = new CodexOtelConfigurator();

      await configurator.configure(context);
      const first = await fs.readFile(codexConfigTomlPath(world.env), 'utf8');
      const again = await configurator.configure(context);

      expect(again.changed).toBe(false);
      expect(await fs.readFile(codexConfigTomlPath(world.env), 'utf8')).toBe(first);

      context.config.endpoint = 'https://other.example.com';
      await configurator.configure(context);
      const updated = await fs.readFile(codexConfigTomlPath(world.env), 'utf8');

      expect(updated).toContain('other.example.com');
      expect(updated.match(/\[otel\]/g)).toHaveLength(1);
    });

    it('reports a stale managed block as incomplete', async () => {
      const context = setupContext();
      const configurator = new CodexOtelConfigurator();

      await configurator.configure(context);
      const configPath = codexConfigTomlPath(world.env);
      const raw = await fs.readFile(configPath, 'utf8');

      await fs.writeFile(configPath, raw.replace(/\ntrace_exporter = .*\n/, '\n'));

      const status = await configurator.inspect(context);

      expect(status.configured).toBe(false);
      expect(status.detail).toContain('incomplete or stale');
    });

    it('skips when a foreign [otel] section exists', async () => {
      const configPath = codexConfigTomlPath(world.env);

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, '[otel]\nexporter = "statsig"\n');
      const outcome = await new CodexOtelConfigurator().configure(setupContext());

      expect(outcome.ok).toBe(false);
      expect(await fs.readFile(configPath, 'utf8')).toBe('[otel]\nexporter = "statsig"\n');
    });

    it('refuses unparseable config.toml', async () => {
      const configPath = codexConfigTomlPath(world.env);

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, '[[[broken');
      const outcome = await new CodexOtelConfigurator().configure(setupContext());

      expect(outcome.ok).toBe(false);
      expect(await fs.readFile(configPath, 'utf8')).toBe('[[[broken');
    });

    it('keeps config.toml private when it carries a token', async () => {
      const context = setupContext();

      context.config.token = 'tok-abc';
      await new CodexOtelConfigurator().configure(context);
      const mode = (await fs.stat(codexConfigTomlPath(world.env))).mode & 0o777;

      expect(mode).toBe(0o600);
    });

    it('uninstall removes exactly the managed block', async () => {
      const configPath = codexConfigTomlPath(world.env);

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const original = 'model = "gpt-5.2-codex"\n';

      await fs.writeFile(configPath, original);
      const context = setupContext();
      const configurator = new CodexOtelConfigurator();

      await configurator.configure(context);
      const outcome = await configurator.uninstall(context);

      expect(outcome.changed).toBe(true);
      const raw = await fs.readFile(configPath, 'utf8');

      expect(raw).toContain('model = "gpt-5.2-codex"');
      expect(raw).not.toContain('agentwatch');
      expect(raw).not.toContain('[otel]');
    });
  });
});
