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
import { queuePartition } from '../src/transport/queue-partition.js';
import { CONTENT_CAPTURE_ON, captureStdout, makeTempEnv, queueEntryFiles, readJson, readQueueEntries, writeJson, type TempWorld } from './helpers.js';
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
      developerEmail: 'dev@company.com',
      yes: true,
      hookCommandFor: (id) => `agentwatch hook --agent ${id}`
    });
  }

  describe('setup', () => {
    // The run has to say so and still leave the line alone. Writing the parsed
    // config back would delete the URL the developer hand-wrote — and with it
    // the only thing still reporting the problem, since
    // `nonDeliverableUrlFields` reads the raw file. Refusing the run instead
    // left one tenant's typo blocking every other tenant's install, and left
    // the machine with no CLI repair path at all.
    it('names a URL the edge will not send to, and leaves it exactly as written', async () => {
      const repo = path.join(world.home, 'work', 'clientA');

      await writeJson(resolvePaths(world.env).configFile, {
        ...defaultConfig(),
        endpoint: 'https://mycorp.example.com',
        token: 'tok-global',
        roots: { [repo]: { endpoint: 'http://collector.clienta.internal', token: 'tok-client-a' } }
      });

      const { result, stdout } = await captureStdout(setupOnce);

      expect(result).toBe(0);
      expect(stdout).toContain('will not send to');
      expect(stdout).toContain(`roots.${repo}.endpoint`);

      const onDisk = await readJson(resolvePaths(world.env).configFile);

      expect(onDisk.roots[repo].endpoint).toBe('http://collector.clienta.internal');
      expect(onDisk.roots[repo].token).toBe('tok-client-a');
      // The unrelated half of the run still landed.
      expect(onDisk.endpoint).toBe('https://backend.example.com');
      expect(onDisk.token).toBe('tok-1');
    });

    // The invocation that supplies a replacement for the very field that is
    // refused has to be the one that works: `setup` is the only command in
    // `cli.ts` that writes the file, so refusing it left hand-editing JSON or
    // an MDM re-push as the only remedy.
    it('repairs a refused endpoint from the flag that replaces it', async () => {
      await writeJson(resolvePaths(world.env).configFile, {
        ...defaultConfig(),
        endpoint: 'http://collector.corp:4318',
        token: 'tok-global'
      });

      expect(await captureStdout(setupOnce).then((run) => run.result)).toBe(0);

      const onDisk = await readJson(resolvePaths(world.env).configFile);

      expect(onDisk.endpoint).toBe('https://backend.example.com');
    });

    it('takes the token from the environment when no flag carries it', async () => {
      // How an MDM policy passes a secret: argv is visible to `ps` for the life
      // of the process, and a root script has no other private channel.
      world.env.vars['AGENTWATCH_TOKEN'] = 'tok-from-env';
      const code = await runSetup({
        env: world.env,
        endpoint: 'https://backend.example.com',
        developerEmail: 'dev@company.com',
        yes: true,
        hookCommandFor: (id) => `agentwatch hook --agent ${id}`
      });

      expect(code).toBe(0);
      expect((await readJson(resolvePaths(world.env).configFile)).token).toBe('tok-from-env');
    });

    it('treats an exported-but-empty token as absent, not as a token', async () => {
      // Enrollment takes any defined token as final, so an empty one would skip
      // the prompt and leave an install that authenticates against nothing.
      world.env.vars['AGENTWATCH_TOKEN'] = '';
      await saveConfig(resolvePaths(world.env), { ...defaultConfig(), token: 'tok-existing' });
      const code = await runSetup({
        env: world.env,
        endpoint: 'https://backend.example.com',
        developerEmail: 'dev@company.com',
        yes: true,
        hookCommandFor: (id) => `agentwatch hook --agent ${id}`
      });

      expect(code).toBe(0);
      expect((await readJson(resolvePaths(world.env).configFile)).token).toBe('tok-existing');
    });

    it('prefers an explicit --token over the environment', async () => {
      world.env.vars['AGENTWATCH_TOKEN'] = 'tok-from-env';

      expect(await setupOnce()).toBe(0);
      expect((await readJson(resolvePaths(world.env).configFile)).token).toBe('tok-1');
    });

    it('configures both detected agents end to end', async () => {
      const code = await setupOnce();

      expect(code).toBe(0);

      const paths = resolvePaths(world.env);
      const config = await readJson(paths.configFile);

      expect(config.endpoint).toBe('https://backend.example.com');
      expect(config.installationId).toBeTruthy();
      // Setup never turns content capture on: prompts and tool I/O stay on the
      // machine until someone edits the config deliberately.
      expect(config.capture.prompts).toBe(false);
      expect(config.capture.responses).toBe(false);
      expect(config.capture.toolInput).toBe(false);
      expect(config.capture.toolOutput).toBe(false);
      // Metadata, which attribution is built from, is on.
      expect(config.capture.git).toBe(true);
      expect(config.capture.files).toBe(true);

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

      expect(codexToml).not.toContain('[otel]');

      const installState = await readJson(paths.installStateFile);

      expect(installState.agents.claude.hookEvents).toContain('SessionStart');
      expect(installState.agents.codex.hookEvents).toContain('Stop');
    });

    it('keeps unsafe native provider logs off without content consent', async () => {
      expect(await setupOnce()).toBe(0);
      const paths = resolvePaths(world.env);

      expect((await readJson(paths.configFile)).emit).toEqual({ turnSummaries: true, llmCalls: true });
      const claudeSettings = await readJson(path.join(world.home, '.claude', 'settings.json'));

      expect(claudeSettings.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
      expect(await fs.readFile(path.join(world.home, '.codex', 'config.toml'), 'utf8').catch(() => '')).not.toContain('[otel]');
    });

    it('honors --otel all and persists the selection', async () => {
      await writeJson(resolvePaths(world.env).configFile, {
        ...defaultConfig(),
        contentCaptureConsent: true,
        capture: { ...CONTENT_CAPTURE_ON, git: true, files: true }
      });

      const code = await runSetup({
        env: world.env,
        endpoint: 'https://backend.example.com',
        token: 'tok-1',
        developerEmail: 'dev@company.com',
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
        developerEmail: 'dev@company.com',
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
        developerEmail: 'dev@company.com',
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

          if (question.includes('URL')) return 'https://asked.example.com';

          return question.includes('Developer email') ? 'dev@company.com' : '';
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
      const config = await readJson<{ token?: string }>(paths.configFile);
      // Seed the partition the configured identity actually drains.
      const queue = new EventQueue({
        queueDir: queuePartition(paths.queueDir, config.token),
        locksDir: paths.locksDir,
        maxEvents: 100,
        maxAttempts: 3,
        maxEventAgeDays: 7
      });

      await queue.enqueue([{ id: 'evt_pinned', event: { type: 'turn.summary' } } as unknown as Parameters<EventQueue['enqueue']>[0][number]], 'https://backend.example.com/v1/events');

      return queue;
    }

    async function pinnedDestination(): Promise<string> {
      const paths = resolvePaths(world.env);
      const queued = await readQueueEntries<{ destination?: string }>(paths.queueDir);

      return queued[0]!.destination!;
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
        developerEmail: 'dev@company.com',
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

      expect(await queueEntryFiles(paths.queueDir)).toEqual([]);
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

    it('does not warn about Codex and Gemini logs on a machine without them', async () => {
      // otel.logs defaults on and consent is absent, so this check used to fire
      // on every default install — a permanent warning naming agents that are
      // not there is how a report stops being read.
      await fs.rm(path.join(world.home, '.codex'), { recursive: true, force: true });
      await saveConfig(resolvePaths(world.env), { ...defaultConfig(), endpoint: 'http://127.0.0.1:9', token: 'tok-1' });
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

      const privacy = JSON.parse(logs.join('')).checks.find((check: any) => check.name === 'native telemetry privacy');

      expect(privacy.level).toBe('ok');
      expect(privacy.detail).not.toMatch(/Codex|Gemini/);
    });

    async function privacyCheck(): Promise<{ level: string; detail: string }> {
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

      return JSON.parse(logs.join('')).checks.find((check: any) => check.name === 'native telemetry privacy');
    }

    it('reports Codex traces withheld even though otel.logs is off', async () => {
      // Keying the check on otel.logs alone printed "compatible" here while the
      // [otel] block was in fact being removed for want of tool-content consent.
      await saveConfig(resolvePaths(world.env), {
        ...defaultConfig(),
        endpoint: 'http://127.0.0.1:9',
        token: 'tok-1',
        otel: { logs: false, traces: true, metrics: false }
      });

      const privacy = await privacyCheck();

      expect(privacy.level).toBe('warn');
      expect(privacy.detail).toContain('Codex (traces)');
    });

    it('reports Gemini traces withheld when tool content is consented but prompts are not', async () => {
      // Gemini's two consent bars differ: its logs need the tool flags, its
      // detailed traces need prompts and responses too. One global predicate
      // could not tell the second case from compatible.
      await fs.mkdir(path.join(world.home, '.gemini'), { recursive: true });
      await saveConfig(resolvePaths(world.env), {
        ...defaultConfig(),
        endpoint: 'http://127.0.0.1:9',
        token: 'tok-1',
        contentCaptureConsent: true,
        capture: { ...defaultConfig().capture, toolInput: true, toolOutput: true },
        otel: { logs: true, traces: true, metrics: false }
      });

      const privacy = await privacyCheck();

      expect(privacy.level).toBe('warn');
      expect(privacy.detail).toContain('Gemini CLI (traces)');
      expect(privacy.detail).not.toContain('Gemini CLI (logs');
    });

    it('does not claim an llm.call ledger the consent gate has withheld', async () => {
      // Configured and exporting metrics only still printed the flat
      // "configured (llm.call ledger enabled)", which is a capability claim.
      await fs.mkdir(path.join(world.home, '.gemini'), { recursive: true });
      await runSetup({
        env: world.env,
        endpoint: 'https://backend.example.com',
        token: 'tok-1',
        developerEmail: 'dev@company.com',
        otel: 'all',
        yes: true,
        hookCommandFor: (id) => `agentwatch hook --agent ${id}`
      });

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

      const gemini = JSON.parse(logs.join('')).checks.find((check: any) => check.name === 'Gemini CLI native OpenTelemetry');

      expect(gemini.detail).toContain('configured for metrics');
      expect(gemini.detail).toContain('no llm.call ledger');
    });

    it('says compatible when every requested signal actually gets through', async () => {
      await saveConfig(resolvePaths(world.env), {
        ...defaultConfig(),
        endpoint: 'http://127.0.0.1:9',
        token: 'tok-1',
        contentCaptureConsent: true,
        capture: { ...defaultConfig().capture, ...CONTENT_CAPTURE_ON },
        otel: { logs: true, traces: true, metrics: true }
      });

      expect((await privacyCheck()).level).toBe('ok');
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

describe('setup --root: a second tenant on one machine', () => {
  let world: TempWorld;

  beforeEach(async () => {
    world = await makeTempEnv();
    await fs.mkdir(path.join(world.home, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await world.cleanup();
  });

  function machineSetup() {
    return runSetup({
      env: world.env,
      endpoint: 'https://backend.example.com',
      token: 'tok-machine',
      developerEmail: 'dev@company.com',
      yes: true,
      hookCommandFor: (id) => `agentwatch hook --agent ${id}`
    });
  }

  async function rootDir(name = 'acme'): Promise<string> {
    const dir = path.join(world.home, name);

    await fs.mkdir(dir, { recursive: true });

    return fs.realpath(dir);
  }

  function rootSetup(overrides: Partial<Parameters<typeof runSetup>[0]>) {
    return runSetup({
      env: world.env,
      endpoint: 'https://backend.example.com',
      developerEmail: 'dev@company.com',
      yes: true,
      hookCommandFor: (id) => `agentwatch hook --agent ${id}`,
      ...overrides
    });
  }

  it('refuses a root before the machine has an identity of its own', async () => {
    // Without a machine token, native OTLP would be installed unauthenticated
    // and every hook outside the root would send with no bearer.
    expect(await rootSetup({ root: await rootDir(), token: 'tok-acme' })).toBe(1);
    await expect(fs.access(resolvePaths(world.env).configFile)).rejects.toThrow();
  });

  it('refuses to inherit the machine token into a root', async () => {
    await machineSetup();

    expect(await rootSetup({ root: await rootDir() })).toBe(1);

    const config = await readJson(resolvePaths(world.env).configFile);

    expect(config.token).toBe('tok-machine');
    expect(config.roots).toBeUndefined();
  });

  it('refuses --otel under a root, because the signal selection is machine-wide', async () => {
    await machineSetup();

    expect(await rootSetup({ root: await rootDir(), token: 'tok-acme', otel: 'none' })).toBe(1);
    expect((await readJson(resolvePaths(world.env).configFile)).otel.logs).toBe(true);
  });

  it('refuses a root that does not exist', async () => {
    await machineSetup();

    expect(await rootSetup({ root: path.join(world.home, 'typo'), token: 'tok-acme' })).toBe(1);
    expect((await readJson(resolvePaths(world.env).configFile)).roots).toBeUndefined();
  });

  it('files the root by its real path and leaves the machine identity untouched', async () => {
    await machineSetup();

    const alias = path.join(world.home, 'link-to-acme');

    await fs.symlink(await rootDir(), alias);

    expect(await rootSetup({ root: alias, token: 'tok-acme', developerEmail: 'me@acme.example' })).toBe(0);

    const config = await readJson(resolvePaths(world.env).configFile);

    expect(config.token).toBe('tok-machine');
    expect(config.developerEmail).toBe('dev@company.com');
    expect(config.roots).toEqual({ [await rootDir()]: { endpoint: 'https://backend.example.com', token: 'tok-acme', developerEmail: 'me@acme.example' } });
  });

  it('rotating the machine token moves its backlog to the new partition, after asking', async () => {
    await machineSetup();

    const paths = resolvePaths(world.env);
    const before = new EventQueue({ queueDir: queuePartition(paths.queueDir, 'tok-machine'), locksDir: paths.locksDir, maxEvents: 100, maxAttempts: 3, maxEventAgeDays: 7 });

    await before.enqueue([{ id: 'evt_rotated', event: { type: 'turn.summary' } } as unknown as Parameters<EventQueue['enqueue']>[0][number]], 'https://backend.example.com/v1/events');

    const questions: string[] = [];

    expect(
      await rootSetup({
        token: 'tok-rotated',
        yes: false,
        ask: async (question) => {
          questions.push(question);

          return question.includes('new token') ? 'y' : '';
        }
      })
    ).toBe(0);

    expect(questions.some((question) => question.includes('previous token'))).toBe(true);
    expect(await queueEntryFiles(queuePartition(paths.queueDir, 'tok-machine'))).toEqual([]);
    expect(await queueEntryFiles(queuePartition(paths.queueDir, 'tok-rotated'))).toHaveLength(1);
  });

  it('otel-headers signs with the root token on the shared collector, and with nothing for a foreign one', async () => {
    await machineSetup();

    const shared = await rootDir('shared');
    const foreign = await rootDir('foreign');

    expect(await rootSetup({ root: shared, token: 'tok-shared' })).toBe(0);
    expect(await rootSetup({ root: foreign, token: 'tok-foreign', endpoint: 'https://other.example.com' })).toBe(0);

    const headersIn = async (cwd: string) => JSON.parse((await captureStdout(() => runOtelHeaders({ ...world.env, cwd }))).stdout);

    expect(await headersIn(shared)).toEqual({ Authorization: 'Bearer tok-shared' });
    // The agent exports to the machine's collector, which must never see the
    // foreign tenant's credential.
    expect(await headersIn(foreign)).toEqual({});
    expect(await headersIn(world.env.cwd)).toEqual({ Authorization: 'Bearer tok-machine' });
  });

  // A root whose own OTLP URL was refused is a foreign tenant too. Read by
  // truthiness the refusal fell through to the machine's base, which made the
  // two bases equal and handed that root's bearer to the machine's collector.
  it('otel-headers signs with nothing for a root whose otlpUrl was refused', async () => {
    await machineSetup();

    const repo = await rootDir('clientA');
    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      roots: { [repo]: { otlpUrl: 'http://collector.clienta.internal:4318', token: 'tok-client-a' } }
    });

    const { stdout } = await captureStdout(() => runOtelHeaders({ ...world.env, cwd: repo }));

    expect(JSON.parse(stdout)).toEqual({});
  });
});
