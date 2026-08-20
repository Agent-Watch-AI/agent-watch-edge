import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetup } from '../src/cli/setup.js';
import { runStatus } from '../src/cli/status.js';
import { runDoctor } from '../src/cli/doctor.js';
import { runUninstall } from '../src/cli/uninstall.js';
import { runHook } from '../src/cli/hook.js';
import { runOtelHeaders } from '../src/cli/misc.js';
import { resolvePaths } from '../src/storage/paths.js';
import { EventQueue } from '../src/transport/queue.js';
import { saveConfig } from '../src/config/config-store.js';
import { defaultConfig } from '../src/config/config.js';
import { makeTempEnv, readJson, type TempWorld } from './helpers.js';
import { claudePostToolUseEdit, claudeUserPromptSubmit } from './fixtures/claude.js';

describe('CLI commands', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
    // Both agents "installed"
    await fs.mkdir(path.join(world.home, '.claude'), { recursive: true });
    await fs.mkdir(path.join(world.home, '.codex'), { recursive: true });
  });

  afterEach(async () => {
    await world.cleanup();
  });

  function setupOnce() {
    return runSetup({
      env: world.env,
      endpoint: 'https://backend.example.com',
      token: 'tok-1',
      yes: true,
      hookCommandFor: (id) => `agentwatch hook --agent ${id}`
    });
  }

  describe('setup', () => {
    it('configures both detected agents end to end', async () => {
      const code = await setupOnce();

      expect(code).toBe(0);

      const paths = resolvePaths(world.env);
      const config = await readJson(paths.configFile);

      expect(config.endpoint).toBe('https://backend.example.com');
      expect(config.installationId).toBeTruthy();
      expect(config.capture.prompts).toBe(true);
      expect(config.capture.responses).toBe(true);
      expect(config.capture.toolInput).toBe(true);
      expect(config.capture.toolOutput).toBe(true);

      const claudeSettings = await readJson(path.join(world.home, '.claude', 'settings.json'));

      expect(claudeSettings.hooks.SessionStart[0].hooks[0].command).toContain('agentwatch hook --agent claude');
      expect(claudeSettings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
      expect(claudeSettings.env.OTEL_LOGS_EXPORTER).toBe('otlp');
      // Logs are the default signal; traces/metrics stay off unless asked for.
      expect(claudeSettings.env.OTEL_TRACES_EXPORTER).toBe('none');
      expect(claudeSettings.env.OTEL_METRICS_EXPORTER).toBe('none');

      const codexHooks = await readJson(path.join(world.home, '.codex', 'hooks.json'));

      expect(codexHooks.hooks.Stop[0].hooks[0].command).toContain('agentwatch hook --agent codex');
      const codexToml = await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8').catch(() => '');

      expect(codexToml).toContain('[otel]');
      expect(codexToml).toContain('exporter = { otlp-http');
      expect(codexToml).toContain('trace_exporter = "none"');

      const installState = await readJson(paths.installStateFile);

      expect(installState.agents.claude.hookEvents).toContain('SessionStart');
      expect(installState.agents.codex.hookEvents).toContain('Stop');
    });

    it('always configures the lossless llm.call telemetry path', async () => {
      expect(await setupOnce()).toBe(0);
      const paths = resolvePaths(world.env);

      expect((await readJson(paths.configFile)).emit).toEqual({ turnSummaries: true, llmCalls: true });
      const claudeSettings = await readJson(path.join(world.home, '.claude', 'settings.json'));

      expect(claudeSettings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
      expect(await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8')).toContain('[otel]');
    });

    it('honors --otel all and persists the selection', async () => {
      const code = await runSetup({
        env: world.env,
        endpoint: 'https://backend.example.com',
        token: 'tok-1',
        otel: 'all',
        yes: true,
        hookCommandFor: (id) => `agentwatch hook --agent ${id}`
      });

      expect(code).toBe(0);
      const config = await readJson(resolvePaths(world.env).configFile);

      expect(config.otel).toEqual({ logs: true, traces: true, metrics: true });
      const claudeSettings = await readJson(path.join(world.home, '.claude', 'settings.json'));

      expect(claudeSettings.env.OTEL_TRACES_EXPORTER).toBe('otlp');
      expect(claudeSettings.env.OTEL_METRICS_EXPORTER).toBe('otlp');
      expect(claudeSettings.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe('1');
      const codexToml = await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8');

      expect(codexToml).toContain('trace_exporter = { otlp-http');
    });

    it('honors --otel none by writing no agent telemetry config', async () => {
      const code = await runSetup({
        env: world.env,
        endpoint: 'https://backend.example.com',
        token: 'tok-1',
        otel: 'none',
        yes: true,
        hookCommandFor: (id) => `agentwatch hook --agent ${id}`
      });

      expect(code).toBe(0);
      const config = await readJson(resolvePaths(world.env).configFile);

      expect(config.otel).toEqual({ logs: false, traces: false, metrics: false });
      const claudeSettings = await readJson(path.join(world.home, '.claude', 'settings.json'));

      expect(claudeSettings.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
      const codexToml = await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8').catch(() => '');

      expect(codexToml).not.toContain('[otel]');
    });

    it('rejects an invalid --otel value without touching config', async () => {
      const code = await runSetup({
        env: world.env,
        endpoint: 'https://backend.example.com',
        token: 'tok-1',
        otel: 'logz',
        yes: true,
        hookCommandFor: (id) => `agentwatch hook --agent ${id}`
      });

      expect(code).toBe(1);
      await expect(fs.stat(resolvePaths(world.env).configFile)).rejects.toThrow();
    });

    it('is idempotent across runs', async () => {
      await setupOnce();
      const claudeBefore = await fs.readFile(path.join(world.home, '.claude', 'settings.json'), 'utf8');
      const codexBefore = await fs.readFile(path.join(world.home, '.codex', 'hooks.json'), 'utf8');
      const tomlBefore = await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8').catch(() => '');

      await setupOnce();
      expect(await fs.readFile(path.join(world.home, '.claude', 'settings.json'), 'utf8')).toBe(claudeBefore);
      expect(await fs.readFile(path.join(world.home, '.codex', 'hooks.json'), 'utf8')).toBe(codexBefore);
      expect(await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8').catch(() => '')).toBe(tomlBefore);
    });

    it('prompts for the endpoint when not supplied', async () => {
      const questions: string[] = [];
      const code = await runSetup({
        env: world.env,
        ask: async (question) => {
          questions.push(question);

          return question.includes('URL') ? 'https://asked.example.com' : '';
        },
        hookCommandFor: (id) => `agentwatch hook --agent ${id}`
      });

      expect(code).toBe(0);
      expect(questions[0]).toContain('backend URL');
      const config = await readJson(resolvePaths(world.env).configFile);

      expect(config.endpoint).toBe('https://asked.example.com');
    });

    it('fails cleanly with no endpoint in non-interactive mode', async () => {
      const code = await runSetup({ env: world.env, yes: true });

      expect(code).toBe(1);
    });

    async function enqueuePinned(): Promise<EventQueue> {
      const paths = resolvePaths(world.env);
      const queue = new EventQueue({ queueDir: paths.queueDir, locksDir: paths.locksDir, maxEvents: 100, maxAttempts: 3, maxEventAgeDays: 7 });

      await queue.enqueue([{ id: 'evt_pinned', event: { type: 'turn.summary' } } as unknown as Parameters<EventQueue['enqueue']>[0][number]], 'https://backend.example.com/v1/events');

      return queue;
    }

    async function pinnedDestination(): Promise<string> {
      const paths = resolvePaths(world.env);
      const files = await fs.readdir(paths.queueDir);

      return JSON.parse(await fs.readFile(path.join(paths.queueDir, files[0]!), 'utf8')).destination;
    }

    it('re-routes the offline backlog to a new backend only after asking', async () => {
      await setupOnce();
      await enqueuePinned();

      const questions: string[] = [];
      const code = await runSetup({
        env: world.env,
        endpoint: 'https://new.example.com',
        token: 'tok-2',
        ask: async (question) => {
          questions.push(question);

          return question.includes('Deliver them to the new backend') ? 'y' : '';
        },
        hookCommandFor: (id) => `agentwatch hook --agent ${id}`
      });

      expect(code).toBe(0);
      expect(questions.some((question) => question.includes('previous backend'))).toBe(true);
      expect(await pinnedDestination()).toBe('https://new.example.com/v1/events');
    });

    it('keeps the backlog pinned to the previous backend without explicit consent', async () => {
      await setupOnce();
      await enqueuePinned();

      const code = await runSetup({
        env: world.env,
        endpoint: 'https://new.example.com',
        token: 'tok-2',
        yes: true,
        hookCommandFor: (id) => `agentwatch hook --agent ${id}`
      });

      expect(code).toBe(0);
      // Non-interactive runs must never silently replay one backend's data
      // to another; the entries stay pinned (and eventually expire).
      expect(await pinnedDestination()).toBe('https://backend.example.com/v1/events');
    });
  });

  describe('hook', () => {
    it('keeps lifecycle hooks internal and never queues a third product type', async () => {
      await setupOnce();
      // Point at a closed local port: direct send fails fast and queues.
      const paths = resolvePaths(world.env);
      const config = {
        ...defaultConfig(),
        endpoint: 'http://127.0.0.1:9',
        installationId: 'inst-t',
        delivery: { ...defaultConfig().delivery, timeoutMs: 300 }
      };

      await saveConfig(paths, config);

      let stdout = '';
      const code = await runHook('claude', {
        env: world.env,
        input: JSON.stringify(claudePostToolUseEdit),
        writeStdout: (text) => {
          stdout += text;
        }
      });

      expect(code).toBe(0);
      expect(stdout).toBe(''); // passive observer: silence on stdout

      const queueFiles = await fs.readdir(paths.queueDir).catch(() => []);

      expect(queueFiles).toEqual([]);
    });

    it('tolerates malformed stdin', async () => {
      const code = await runHook('claude', { env: world.env, input: '{{{not json' });

      expect(code).toBe(0);
    });

    it('tolerates unknown agents', async () => {
      const code = await runHook('imaginary', { env: world.env, input: '{}' });

      expect(code).toBe(0);
    });

    it('dry-run prints canonical events without delivering', async () => {
      // No config file in this world: the runtime fails safe to metadata-only
      // capture; lifecycle events are internal and are never emitted. A dry
      // prompt must not create persistent turn state.
      const paths = resolvePaths(world.env);
      let stdout = '';
      let code = await runHook('claude', {
        env: world.env,
        input: JSON.stringify(claudeUserPromptSubmit),
        dryRun: true,
        writeStdout: (text) => {
          stdout += text;
        }
      });

      expect(code).toBe(0);
      expect(JSON.parse(stdout).events).toEqual([]);
      expect(await fs.readdir(paths.turnsDir).catch(() => [])).toEqual([]);

      // Seed a real pending turn. The following dry Stop previews it without
      // consuming the stored prompt record.
      await runHook('claude', { env: world.env, input: JSON.stringify(claudeUserPromptSubmit) });
      const before = await fs.readdir(paths.turnsDir, { recursive: true });

      // The summary is printed, with evidence instead of prompt text
      // (fail-safe capture), but persistent state is unchanged.
      stdout = '';
      code = await runHook('claude', {
        env: world.env,
        input: JSON.stringify({ ...claudeUserPromptSubmit, hook_event_name: 'Stop', prompt: undefined }),
        dryRun: true,
        writeStdout: (text) => {
          stdout += text;
        }
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);

      expect(parsed.events[0].event.type).toBe('turn.summary');
      expect(stdout).not.toContain('Refactor the auth middleware');
      expect(JSON.stringify(parsed.events[0].prompt_evidence)).toContain('sha256');
      expect(await fs.readdir(paths.turnsDir, { recursive: true })).toEqual(before);
    });
  });

  describe('status/doctor', () => {
    it('status runs end to end', async () => {
      await setupOnce();
      expect(await runStatus(world.env)).toBe(0);
    });

    it('doctor reports json without leaking the token', async () => {
      await setupOnce();
      // Keep doctor's connectivity probe off the network: closed local port.
      const paths = resolvePaths(world.env);

      await saveConfig(paths, { ...defaultConfig(), endpoint: 'http://127.0.0.1:9', token: 'tok-1', installationId: 'inst-t' });
      const logs: string[] = [];
      const original = process.stdout.write.bind(process.stdout);

      process.stdout.write = ((chunk: any) => {
        logs.push(String(chunk));

        return true;
      }) as typeof process.stdout.write;

      try {
        await runDoctor(world.env, { json: true });
      } finally {
        process.stdout.write = original;
      }

      const output = logs.join('');

      expect(output).toContain('"checks"');
      expect(output).not.toContain('tok-1');
    });
  });

  describe('uninstall', () => {
    it('removes AgentWatch config from both agents but keeps local config', async () => {
      await setupOnce();
      const code = await runUninstall({ env: world.env });

      expect(code).toBe(0);

      const claudeSettings = await readJson(path.join(world.home, '.claude', 'settings.json'));

      expect(JSON.stringify(claudeSettings)).not.toContain('agentwatch');
      expect(claudeSettings.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();

      const codexHooks = await readJson(path.join(world.home, '.codex', 'hooks.json'));

      expect(JSON.stringify(codexHooks)).not.toContain('agentwatch');
      const codexToml = await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8').catch(() => '');

      expect(codexToml).not.toContain('agentwatch');

      const paths = resolvePaths(world.env);

      await expect(fs.access(paths.configFile)).resolves.toBeUndefined();
    });

    it('respects --agent filtering', async () => {
      await setupOnce();
      await runUninstall({ env: world.env, agent: 'claude' });
      const claudeSettings = await readJson(path.join(world.home, '.claude', 'settings.json'));

      expect(JSON.stringify(claudeSettings)).not.toContain('agentwatch');
      const codexHooks = await readJson(path.join(world.home, '.codex', 'hooks.json'));

      expect(JSON.stringify(codexHooks)).toContain('agentwatch');
    });

    it('purge removes local data', async () => {
      await setupOnce();
      await runUninstall({ env: world.env, purge: true });
      const paths = resolvePaths(world.env);

      await expect(fs.access(paths.configFile)).rejects.toThrow();
    });
  });

  describe('otel-headers', () => {
    it('prints exactly the auth header JSON', async () => {
      await setupOnce();
      const logs: string[] = [];
      const original = process.stdout.write.bind(process.stdout);

      process.stdout.write = ((chunk: any) => {
        logs.push(String(chunk));

        return true;
      }) as typeof process.stdout.write;

      try {
        await runOtelHeaders(world.env);
      } finally {
        process.stdout.write = original;
      }

      expect(JSON.parse(logs.join(''))).toEqual({ Authorization: 'Bearer tok-1' });
    });
  });
});
