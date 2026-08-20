import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectGemini, geminiSettingsPath } from '../src/providers/gemini/gemini.detect.js';
import { installGeminiHooks, uninstallGeminiHooks, GEMINI_HOOK_EVENTS } from '../src/providers/gemini/gemini.hooks.js';
import { GeminiOtelConfigurator } from '../src/providers/gemini/gemini.otel.js';
import { parseGeminiHookEvent } from '../src/providers/gemini/gemini.adapter.js';
import { resolvePaths } from '../src/storage/paths.js';
import { defaultConfig } from '../src/config/config.js';
import type { SetupContext } from '../src/providers/provider.js';
import { makeTempEnv, readJson, writeJson, type TempWorld } from './helpers.js';

const HOOK_CMD = 'agentwatch hook --agent gemini';

describe('Gemini provider', () => {
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
      const result = await detectGemini(world.env);
      expect(result.detected).toBe(false);
    });

    it('detects via ~/.gemini directory', async () => {
      await fs.mkdir(path.join(world.home, '.gemini'), { recursive: true });
      const result = await detectGemini(world.env);
      expect(result.detected).toBe(true);
      expect(result.evidence[0]).toContain('.gemini');
      expect(result.hooksInstalled).toBe(false);
    });

    it('detects via executable on PATH', async () => {
      const binDir = path.join(world.home, 'bin');
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(path.join(binDir, 'gemini'), '#!/bin/sh\n', { mode: 0o755 });
      world.env.vars['PATH'] = binDir;
      const result = await detectGemini(world.env);
      expect(result.detected).toBe(true);
    });

    it('detects via GEMINI_CLI environment variable', async () => {
      world.env.vars['GEMINI_CLI'] = '1';
      const result = await detectGemini(world.env);
      expect(result.detected).toBe(true);
      expect(result.evidence[0]).toContain('GEMINI_CLI');
    });
  });

  describe('hook installation', () => {
    it('installs hooks into a fresh settings.json', async () => {
      const context = setupContext();
      const outcome = await installGeminiHooks(context);
      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(true);

      const settings = await readJson(geminiSettingsPath(world.env));
      for (const eventName of GEMINI_HOOK_EVENTS) {
        expect(settings.hooks[eventName]).toHaveLength(1);
        expect(settings.hooks[eventName][0].hooks[0].command).toBe(HOOK_CMD);
      }
      expect(settings.hooks.BeforeTool[0].matcher).toBe('*');
      expect(settings.hooks.SessionStart[0].matcher).toBeUndefined();
      expect(settings.hooks.AfterAgent[0].hooks[0].timeout).toBe(30_000);
      expect((await detectGemini(world.env)).hooksInstalled).toBe(true);
    });

    it('preserves existing configuration and user hooks', async () => {
      const settingsPath = geminiSettingsPath(world.env);
      await writeJson(settingsPath, {
        model: 'gemini-2.5-pro',
        hooks: {
          BeforeTool: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter --check' }] }]
        }
      });
      await installGeminiHooks(setupContext());
      const settings = await readJson(settingsPath);
      expect(settings.model).toBe('gemini-2.5-pro');
      expect(settings.hooks.BeforeTool).toHaveLength(2);
      expect(settings.hooks.BeforeTool[0].hooks[0].command).toBe('my-linter --check');
    });

    it('uninstalls hooks cleanly', async () => {
      const context = setupContext();
      await installGeminiHooks(context);
      const outcome = await uninstallGeminiHooks(context);
      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(true);

      const settings = await readJson(geminiSettingsPath(world.env));
      expect(settings.hooks).toBeUndefined();
    });
  });

  describe('OTel configurator', () => {
    it('configures native OTel in settings.json', async () => {
      const configurator = new GeminiOtelConfigurator();
      const context = setupContext();
      context.config.token = 'token-123';
      const outcome = await configurator.configure(context);
      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(true);

      const settings = await readJson(geminiSettingsPath(world.env));
      // Gemini reads GEMINI_TELEMETRY_ENABLED; GEMINI_ENABLE_TELEMETRY (the
      // name this used to write) appears nowhere in the CLI, so telemetry
      // never initialized at all.
      expect(settings.env.GEMINI_TELEMETRY_ENABLED).toBe('true');
      expect(settings.env.GEMINI_ENABLE_TELEMETRY).toBeUndefined();
      expect(settings.env.GEMINI_TELEMETRY_TARGET).toBe('local');
      // grpc|http only: 'http/json' makes Gemini throw FatalConfigError.
      expect(settings.env.GEMINI_TELEMETRY_OTLP_PROTOCOL).toBe('http');
      expect(settings.env.OTEL_LOGS_EXPORTER).toBe('otlp');
      expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://backend.example.com/v1/otlp');
      expect(settings.env.GEMINI_TELEMETRY_OTLP_ENDPOINT).toBe('https://backend.example.com/v1/otlp');
    });

    it('sends the ingest token in OTEL_EXPORTER_OTLP_HEADERS, not via a helper', async () => {
      const configurator = new GeminiOtelConfigurator();
      const context = setupContext();
      context.config.token = 'token-123';
      await configurator.configure(context);

      const settings = await readJson(geminiSettingsPath(world.env));
      // Gemini CLI has no otelHeadersHelper (that is a Claude Code setting), so
      // the exporter previously posted with no Authorization header and the
      // fail-closed gateway answered 401 to every batch.
      expect(settings.env.OTEL_EXPORTER_OTLP_HEADERS).toBe('Authorization=Bearer token-123');
      expect(settings.otelHeadersHelper).toBeUndefined();
    });

    it('removes an otelHeadersHelper entry left by an older version', async () => {
      await writeJson(geminiSettingsPath(world.env), { otelHeadersHelper: '/usr/local/bin/agentwatch otel-headers' });
      const configurator = new GeminiOtelConfigurator();
      const context = setupContext();
      context.config.token = 'token-123';
      await configurator.configure(context);

      const settings = await readJson(geminiSettingsPath(world.env));
      expect(settings.otelHeadersHelper).toBeUndefined();
    });

    it('leaves a foreign otelHeadersHelper alone', async () => {
      await writeJson(geminiSettingsPath(world.env), { otelHeadersHelper: '/opt/other-tool headers' });
      const configurator = new GeminiOtelConfigurator();
      const context = setupContext();
      context.config.token = 'token-123';
      await configurator.configure(context);

      const settings = await readJson(geminiSettingsPath(world.env));
      expect(settings.otelHeadersHelper).toBe('/opt/other-tool headers');
    });

    it('uninstalls native OTel cleanly', async () => {
      const configurator = new GeminiOtelConfigurator();
      const context = setupContext();
      await configurator.configure(context);
      const outcome = await configurator.uninstall(context);
      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(true);

      const settings = await readJson(geminiSettingsPath(world.env));
      expect(settings.env).toBeUndefined();
    });
  });

  describe('hook adapter', () => {
    it('parses SessionStart and BeforeAgent events', () => {
      const context = { env: world.env, config: defaultConfig() };
      const sessionEvents = parseGeminiHookEvent(
        {
          hook_event_name: 'SessionStart',
          session_id: 'session-gem-1',
          model: 'gemini-2.5-flash',
          source: 'cli'
        },
        context
      );
      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0]!.event.type).toBe('session.started');
      expect(sessionEvents[0]!.agent.provider).toBe('gemini');
      expect(sessionEvents[0]!.ai?.model).toBe('gemini-2.5-flash');

      const promptEvents = parseGeminiHookEvent(
        {
          hook_event_name: 'BeforeAgent',
          session_id: 'session-gem-1',
          prompt_id: 'turn-gem-1',
          prompt: 'Fix the bug'
        },
        context
      );
      expect(promptEvents).toHaveLength(1);
      expect(promptEvents[0]!.event.type).toBe('prompt.submitted');
      expect(promptEvents[0]!.session.turnId).toBe('turn-gem-1');
    });

    it('parses BeforeTool, AfterTool and AfterAgent', () => {
      const context = { env: world.env, config: defaultConfig() };
      const toolEvents = parseGeminiHookEvent(
        {
          hook_event_name: 'BeforeTool',
          session_id: 'session-gem-1',
          tool_name: 'Bash',
          tool_use_id: 'tool-1'
        },
        context
      );
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0]!.event.type).toBe('shell.started');
      expect(toolEvents[0]!.tool?.name).toBe('Bash');

      const stopEvents = parseGeminiHookEvent(
        {
          hook_event_name: 'AfterAgent',
          session_id: 'session-gem-1',
          prompt_response: 'Done fixing!'
        },
        context
      );
      expect(stopEvents).toHaveLength(1);
      expect(stopEvents[0]!.event.type).toBe('generation.completed');
    });
  });
});
