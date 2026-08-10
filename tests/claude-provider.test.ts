import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectClaude, claudeSettingsPath } from '../src/providers/claude/claude.detect.js';
import { installClaudeHooks, uninstallClaudeHooks, CLAUDE_HOOK_EVENTS } from '../src/providers/claude/claude.hooks.js';
import { isAgentWatchHookCommand } from '../src/providers/provider.js';
import { ClaudeOtelConfigurator } from '../src/providers/claude/claude.otel.js';
import { resolvePaths } from '../src/storage/paths.js';
import { defaultConfig } from '../src/config/config.js';
import type { SetupContext } from '../src/providers/provider.js';
import { makeTempEnv, readJson, writeJson, type TempWorld } from './helpers.js';

const HOOK_CMD = 'agentwatch hook --agent claude';

describe('Claude provider', () => {
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
      const result = await detectClaude(world.env);
      expect(result.detected).toBe(false);
    });

    it('detects via ~/.claude directory', async () => {
      await fs.mkdir(path.join(world.home, '.claude'), { recursive: true });
      const result = await detectClaude(world.env);
      expect(result.detected).toBe(true);
      expect(result.evidence[0]).toContain('.claude');
      expect(result.hooksInstalled).toBe(false);
    });

    it('detects via executable on PATH', async () => {
      const binDir = path.join(world.home, 'bin');
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(path.join(binDir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
      world.env.vars['PATH'] = binDir;
      const result = await detectClaude(world.env);
      expect(result.detected).toBe(true);
    });
  });

  describe('hook installation', () => {
    it('installs hooks into a fresh settings.json', async () => {
      const context = setupContext();
      const outcome = await installClaudeHooks(context);
      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(true);

      const settings = await readJson(claudeSettingsPath(world.env));
      for (const eventName of CLAUDE_HOOK_EVENTS) {
        expect(settings.hooks[eventName]).toHaveLength(1);
        expect(settings.hooks[eventName][0].hooks[0].command).toBe(HOOK_CMD);
      }
      expect(settings.hooks.PreToolUse[0].matcher).toBe('*');
      expect(settings.hooks.SessionStart[0].matcher).toBeUndefined();
      expect((await detectClaude(world.env)).hooksInstalled).toBe(true);
    });

    it('preserves existing configuration and user hooks', async () => {
      const settingsPath = claudeSettingsPath(world.env);
      await writeJson(settingsPath, {
        model: 'opus',
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter --check' }] }]
        }
      });
      await installClaudeHooks(setupContext());
      const settings = await readJson(settingsPath);
      expect(settings.model).toBe('opus');
      expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
      expect(settings.hooks.PreToolUse).toHaveLength(2);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('my-linter --check');
    });

    it('is idempotent: running twice adds nothing', async () => {
      await installClaudeHooks(setupContext());
      const first = await fs.readFile(claudeSettingsPath(world.env), 'utf8');
      const second = await installClaudeHooks(setupContext());
      expect(second.changed).toBe(false);
      expect(await fs.readFile(claudeSettingsPath(world.env), 'utf8')).toBe(first);
    });

    it('updates a stale command in place', async () => {
      await installClaudeHooks(setupContext());
      const context = setupContext();
      context.hookCommand = '/new/path/agentwatch hook --agent claude';
      await installClaudeHooks(context);
      const settings = await readJson(claudeSettingsPath(world.env));
      expect(settings.hooks.Stop).toHaveLength(1);
      expect(settings.hooks.Stop[0].hooks[0].command).toBe('/new/path/agentwatch hook --agent claude');
    });

    it('refuses to touch malformed settings.json', async () => {
      const settingsPath = claudeSettingsPath(world.env);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, '{ not json !!!');
      const outcome = await installClaudeHooks(setupContext());
      expect(outcome.ok).toBe(false);
      expect(await fs.readFile(settingsPath, 'utf8')).toBe('{ not json !!!');
    });

    it('preserves restrictive file permissions on rewrite', async () => {
      const settingsPath = claudeSettingsPath(world.env);
      await writeJson(settingsPath, { model: 'opus' });
      await fs.chmod(settingsPath, 0o600);
      await installClaudeHooks(setupContext());
      const mode = (await fs.stat(settingsPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('creates a backup before modifying an existing file', async () => {
      const settingsPath = claudeSettingsPath(world.env);
      await writeJson(settingsPath, { model: 'opus' });
      const context = setupContext();
      await installClaudeHooks(context);
      const backups = await fs.readdir(context.paths.backupsDir);
      expect(backups.some((name) => name.startsWith('settings.json.'))).toBe(true);
    });
  });

  describe('hook uninstall', () => {
    it('removes only AgentWatch entries', async () => {
      const settingsPath = claudeSettingsPath(world.env);
      await writeJson(settingsPath, {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter --check' }] }]
        }
      });
      const context = setupContext();
      await installClaudeHooks(context);
      const outcome = await uninstallClaudeHooks(context);
      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(true);
      const settings = await readJson(settingsPath);
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('my-linter --check');
      expect(settings.hooks.SessionStart).toBeUndefined();
      expect(JSON.stringify(settings)).not.toContain('agentwatch');
    });

    it('is a no-op without a settings file', async () => {
      const outcome = await uninstallClaudeHooks(setupContext());
      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(false);
    });

    it('ownership requires the agentwatch executable, not independent substrings', async () => {
      // Ours in every installed shape:
      expect(isAgentWatchHookCommand('agentwatch hook --agent claude')).toBe(true);
      expect(isAgentWatchHookCommand('/Users/dev/.local/bin/agentwatch hook --agent claude')).toBe(true);
      expect(isAgentWatchHookCommand('"/usr/bin/node" "/Users/dev/Projects/agentwatch/dist/cli.js" hook --agent claude')).toBe(true);
      expect(isAgentWatchHookCommand('"/Applications/Node JS/node" "/Users/dev/My Projects/agentwatch/dist/cli.js" hook --agent claude')).toBe(true);
      expect(isAgentWatchHookCommand('node /opt/@agentwatch/bridge/dist/cli.js hook --agent codex')).toBe(true);
      expect(isAgentWatchHookCommand('node /Users/dev/Projects/renamed-checkout/dist/cli.js hook --agent claude')).toBe(true);
      // Hooks written by earlier installs embed process.execPath, which may
      // be any Node-compatible runtime; a .ps1 shim is still our binary.
      expect(isAgentWatchHookCommand('/opt/homebrew/bin/bun /Users/dev/node_modules/agentwatch/dist/cli.js hook --agent claude')).toBe(true);
      expect(isAgentWatchHookCommand('agentwatch.ps1 hook --agent claude')).toBe(true);
      // Not ours — foreign executables and compound commands:
      expect(isAgentWatchHookCommand('my-agentwatch-notifier --send')).toBe(false);
      expect(isAgentWatchHookCommand('my-agentwatch-notifier hook --agent codex')).toBe(false);
      expect(isAgentWatchHookCommand('echo agentwatch && my-tool hook --agent x')).toBe(false);
      expect(isAgentWatchHookCommand('agentwatch-linter check; my-tool hook --agent x')).toBe(false);
      expect(isAgentWatchHookCommand('agentwatch hook --agent claude && notify-send done')).toBe(false);
      expect(isAgentWatchHookCommand('agentwatch hook --agent claude | tee log')).toBe(false);
      expect(isAgentWatchHookCommand('agentwatch hook --agent imaginary')).toBe(false);
    });

    it('does not claim user commands that merely contain the word agentwatch', async () => {
      const settingsPath = claudeSettingsPath(world.env);
      await writeJson(settingsPath, {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'my-agentwatch-notifier --send' }] }]
        }
      });
      const outcome = await uninstallClaudeHooks(setupContext());
      expect(outcome.changed).toBe(false);
      const settings = await readJson(settingsPath);
      expect(settings.hooks.Stop[0].hooks[0].command).toBe('my-agentwatch-notifier --send');
    });

    it('keeps a user handler that shares a matcher group with AgentWatch', async () => {
      const settingsPath = claudeSettingsPath(world.env);
      // The user manually added their own handler INTO the AgentWatch group.
      await writeJson(settingsPath, {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: HOOK_CMD, timeout: 30 },
                { type: 'command', command: 'my-notifier --send' }
              ]
            }
          ]
        }
      });
      const outcome = await uninstallClaudeHooks(setupContext());
      expect(outcome.changed).toBe(true);
      const settings = await readJson(settingsPath);
      expect(settings.hooks.Stop).toHaveLength(1);
      expect(settings.hooks.Stop[0].hooks).toEqual([{ type: 'command', command: 'my-notifier --send' }]);
    });

    it('install does not displace a user handler sharing the AgentWatch group', async () => {
      const settingsPath = claudeSettingsPath(world.env);
      await writeJson(settingsPath, {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: '/old/path/agentwatch hook --agent claude', timeout: 30 },
                { type: 'command', command: 'my-notifier --send' }
              ]
            }
          ]
        }
      });
      await installClaudeHooks(setupContext());
      const settings = await readJson(settingsPath);
      const flat = JSON.stringify(settings.hooks.Stop);
      expect(flat).toContain('my-notifier --send');
      expect(flat).not.toContain('/old/path/agentwatch');
      expect(flat).toContain(HOOK_CMD);
    });
  });

  describe('native OpenTelemetry', () => {
    it('writes the documented env vars and reports configured (logs-only default)', async () => {
      const context = setupContext();
      const configurator = new ClaudeOtelConfigurator();
      const outcome = await configurator.configure(context);
      expect(outcome.ok).toBe(true);
      const settings = await readJson(claudeSettingsPath(world.env));
      expect(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
      expect(settings.env.OTEL_LOGS_EXPORTER).toBe('otlp');
      expect(settings.env.OTEL_METRICS_EXPORTER).toBe('none');
      expect(settings.env.OTEL_TRACES_EXPORTER).toBe('none');
      expect(settings.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBeUndefined();
      expect(settings.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json');
      expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://backend.example.com/v1/otlp');
      expect((await configurator.inspect(context)).configured).toBe(true);
    });

    it('enables traces and metrics exporters when configured', async () => {
      const context = setupContext();
      context.config.otel = { logs: true, traces: true, metrics: true };
      const configurator = new ClaudeOtelConfigurator();
      expect((await configurator.configure(context)).ok).toBe(true);
      const settings = await readJson(claudeSettingsPath(world.env));
      expect(settings.env.OTEL_LOGS_EXPORTER).toBe('otlp');
      expect(settings.env.OTEL_TRACES_EXPORTER).toBe('otlp');
      expect(settings.env.OTEL_METRICS_EXPORTER).toBe('otlp');
      expect(settings.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe('1');
      expect((await configurator.inspect(context)).configured).toBe(true);
    });

    it('drops stale owned keys when a signal is disabled later', async () => {
      const configurator = new ClaudeOtelConfigurator();
      const withTraces = setupContext();
      withTraces.config.otel = { logs: true, traces: true, metrics: false };
      await configurator.configure(withTraces);

      const logsOnly = setupContext();
      logsOnly.installState = withTraces.installState;
      await configurator.configure(logsOnly);
      const settings = await readJson(claudeSettingsPath(world.env));
      expect(settings.env.OTEL_TRACES_EXPORTER).toBe('none');
      expect(settings.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBeUndefined();
    });

    it('otel none removes the configuration and reports configured', async () => {
      const configurator = new ClaudeOtelConfigurator();
      const enabled = setupContext();
      await configurator.configure(enabled);

      const disabled = setupContext();
      disabled.installState = enabled.installState;
      disabled.config.otel = { logs: false, traces: false, metrics: false };
      const outcome = await configurator.configure(disabled);
      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(true);
      const settings = await readJson(claudeSettingsPath(world.env));
      expect(settings.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
      const status = await configurator.inspect(disabled);
      expect(status.configured).toBe(true);
      expect(status.detail).toContain('disabled in config');
    });

    it('uses otelHeadersHelper for tokens instead of embedding them', async () => {
      const context = setupContext();
      context.config.token = 'secret-token';
      context.hookCommand = '/usr/local/bin/agentwatch hook --agent claude';
      await new ClaudeOtelConfigurator().configure(context);
      const raw = await fs.readFile(claudeSettingsPath(world.env), 'utf8');
      expect(raw).not.toContain('secret-token');
      const settings = JSON.parse(raw);
      expect(settings.otelHeadersHelper).toBe('/usr/local/bin/agentwatch otel-headers');
    });

    it('skips when foreign OTEL env vars exist', async () => {
      await writeJson(claudeSettingsPath(world.env), {
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://my-collector.internal:4318' }
      });
      const context = setupContext();
      const outcome = await new ClaudeOtelConfigurator().configure(context);
      expect(outcome.ok).toBe(false);
      const settings = await readJson(claudeSettingsPath(world.env));
      expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://my-collector.internal:4318');
      expect(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
      const status = await new ClaudeOtelConfigurator().inspect(context);
      expect(status.configured).toBe(false);
      expect(status.conflict).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    });

    it('uninstall removes only AgentWatch-owned keys', async () => {
      await writeJson(claudeSettingsPath(world.env), { env: { MY_VAR: 'keep' } });
      const context = setupContext();
      context.config.token = 'tok';
      const configurator = new ClaudeOtelConfigurator();
      await configurator.configure(context);
      const outcome = await configurator.uninstall(context);
      expect(outcome.changed).toBe(true);
      const settings = await readJson(claudeSettingsPath(world.env));
      expect(settings.env.MY_VAR).toBe('keep');
      expect(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
      expect(settings.otelHeadersHelper).toBeUndefined();
    });
  });
});
