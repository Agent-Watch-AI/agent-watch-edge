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
      expect(config.capture.prompts).toBe(false);

      const claudeSettings = await readJson(path.join(world.home, '.claude', 'settings.json'));
      expect(claudeSettings.hooks.SessionStart[0].hooks[0].command).toContain('agentwatch hook --agent claude');
      expect(claudeSettings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');

      const codexHooks = await readJson(path.join(world.home, '.codex', 'hooks.json'));
      expect(codexHooks.hooks.Stop[0].hooks[0].command).toContain('agentwatch hook --agent codex');
      const codexToml = await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8');
      expect(codexToml).toContain('[otel]');

      const installState = await readJson(paths.installStateFile);
      expect(installState.agents.claude.hookEvents).toContain('SessionStart');
      expect(installState.agents.codex.hookEvents).toContain('Stop');
    });

    it('is idempotent across runs', async () => {
      await setupOnce();
      const claudeBefore = await fs.readFile(path.join(world.home, '.claude', 'settings.json'), 'utf8');
      const codexBefore = await fs.readFile(path.join(world.home, '.codex', 'hooks.json'), 'utf8');
      const tomlBefore = await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8');
      await setupOnce();
      expect(await fs.readFile(path.join(world.home, '.claude', 'settings.json'), 'utf8')).toBe(claudeBefore);
      expect(await fs.readFile(path.join(world.home, '.codex', 'hooks.json'), 'utf8')).toBe(codexBefore);
      expect(await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8')).toBe(tomlBefore);
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
  });

  describe('hook', () => {
    it('processes a payload, enqueues on unreachable backend, and never fails the agent', async () => {
      await setupOnce();
      // Point at a closed local port: direct send fails fast and queues.
      const paths = resolvePaths(world.env);
      const config = { ...defaultConfig(), endpoint: 'http://127.0.0.1:9', installationId: 'inst-t', delivery: { ...defaultConfig().delivery, timeoutMs: 300 } };
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

      const queueFiles = await fs.readdir(paths.queueDir);
      expect(queueFiles).toHaveLength(1);
      const entry = JSON.parse(await fs.readFile(path.join(paths.queueDir, queueFiles[0]!), 'utf8'));
      expect(entry.event.event.type).toBe('file.edited');
      expect(entry.event.developer.installationId).toBe('inst-t');
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
      let stdout = '';
      const code = await runHook('claude', {
        env: world.env,
        input: JSON.stringify(claudeUserPromptSubmit),
        dryRun: true,
        writeStdout: (text) => {
          stdout += text;
        }
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.events[0].event.type).toBe('prompt.submitted');
      // default privacy: no prompt text even in dry-run output
      expect(stdout).not.toContain('Refactor the auth middleware');
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
      const codexToml = await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8');
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
