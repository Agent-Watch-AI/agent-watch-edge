import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetup } from '../src/cli/setup.js';
import { runStatus } from '../src/cli/status.js';
import { runDoctor } from '../src/cli/doctor.js';
import { runUninstall } from '../src/cli/uninstall.js';
import { runHook } from '../src/cli/hook.js';
import { runConfig, runOtelHeaders } from '../src/cli/misc.js';
import { loadEffectiveConfig } from '../src/config/repo-config.js';
import { resolvePaths } from '../src/storage/paths.js';
import { EventQueue } from '../src/transport/queue.js';
import { loadConfig, saveConfig } from '../src/config/config-store.js';
import { defaultConfig, enforcementUrl, eventsUrl, otlpBaseUrl } from '../src/config/config.js';
import { queuePartition } from '../src/transport/queue-partition.js';
import { CONTENT_CAPTURE_ON, captureStdout, makeTempEnv, queueEntryFiles, readJson, readQueueEntries, writeJson, type TempWorld } from './helpers.js';
import { claudePostToolUseEdit, claudeUserPromptSubmit } from './fixtures/claude.js';

async function queueOwnership(queueDir: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  for (const entry of await fs.readdir(queueDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;

    const count = (await queueEntryFiles(path.join(queueDir, entry.name))).length;

    if (count > 0) result[entry.name] = count;
  }

  return result;
}

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

          return question.includes('Deliver them to https://new.example.com/v1/events') ? 'y' : '';
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
    expect(questions).toEqual([expect.stringContaining('Deliver them to https://backend.example.com/v1/events with the new token')]);
    expect(questions[0]).toContain('tenant attribution may change');
    expect(await queueEntryFiles(queuePartition(paths.queueDir, 'tok-machine'))).toEqual([]);
    expect(await queueEntryFiles(queuePartition(paths.queueDir, 'tok-rotated'))).toHaveLength(1);
    expect(await queueOwnership(paths.queueDir)).toEqual({ [path.basename(queuePartition(paths.queueDir, 'tok-rotated'))]: 1 });
  });

  it('retargets the selected root backlog even when setup runs outside that root', async () => {
    await machineSetup();

    const repo = await rootDir('queued-root');
    const paths = resolvePaths(world.env);

    await rootSetup({ root: repo, endpoint: 'https://old.example.com', token: 'root-old' });

    const before = new EventQueue({ queueDir: queuePartition(paths.queueDir, 'root-old'), locksDir: paths.locksDir, maxEvents: 100, maxAttempts: 3, maxEventAgeDays: 7 });

    await before.enqueue([{ id: 'root-event', event: { type: 'turn.summary' } } as unknown as Parameters<EventQueue['enqueue']>[0][number]], 'https://old.example.com/v1/events');

    const questions: string[] = [];
    const { result } = await captureStdout(() => rootSetup({ root: repo, endpoint: 'https://new.example.com', token: 'root-new', yes: false, ask: async (question) => {
      questions.push(question);

      return 'y';
    } }));

    expect(result).toBe(0);
    expect(questions).toEqual([expect.stringContaining(`captured under ${repo}`)]);
    expect(questions[0]).toContain('Deliver them to https://new.example.com/v1/events');
    expect(questions[0]).not.toContain('root-new');
    expect(await queueOwnership(paths.queueDir)).toEqual({ [path.basename(queuePartition(paths.queueDir, 'root-new'))]: 1 });
    expect(await queueEntryFiles(queuePartition(paths.queueDir, 'root-old'))).toHaveLength(0);
    expect(await queueEntryFiles(queuePartition(paths.queueDir, 'root-new'))).toHaveLength(1);
    expect(await queueEntryFiles(queuePartition(paths.queueDir, 'tok-machine'))).toHaveLength(0);
  });

  it.each([
    { kind: 'new', backend: 'https://backend.example.com' },
    { kind: 'new', backend: 'https://other.example.com' },
    { kind: 'nested', backend: 'https://other.example.com' },
    { kind: 'inherited-token', backend: 'https://other.example.com' },
    { kind: 'machine-token', backend: 'https://other.example.com' },
    { kind: 'sibling-token', backend: 'https://other.example.com' },
    { kind: 'machine-with-shared-root', backend: 'https://other.example.com' },
    { kind: 'shared-same-token', backend: 'https://other.example.com' },
    { kind: 'destination-root', backend: 'https://other.example.com' },
    { kind: 'destination-machine', backend: 'https://other.example.com' }
  ])('never offers a non-exclusive backlog during $kind enrollment to $backend', async ({ kind, backend }) => {
    await machineSetup();

    const paths = resolvePaths(world.env);
    const parent = await rootDir('parent');
    const repo = await rootDir(kind === 'nested' ? 'parent/child' : 'new-root');
    const sibling = await rootDir('sibling');
    const stored = await readJson(paths.configFile);
    const sourceToken = kind === 'nested' || kind === 'sibling-token' ? 'tok-shared' : 'tok-machine';
    const roots = {
      ...(kind === 'nested' ? { [parent]: { token: sourceToken } } : {}),
      ...(kind === 'inherited-token' ? { [repo]: { developerEmail: 'root@example.com' } } : {}),
      ...(kind === 'machine-token' || kind === 'sibling-token' ? { [repo]: { token: sourceToken } } : {}),
      ...(kind === 'sibling-token' || kind === 'machine-with-shared-root' || kind === 'shared-same-token' ? { [sibling]: { token: sourceToken } } : {})
    };

    const targetToken = kind === 'shared-same-token' ? sourceToken : 'tok-new';
    const finalRoots = {
      ...roots,
      ...(kind === 'destination-root' ? { [repo]: { token: sourceToken === 'tok-machine' ? 'tok-own' : sourceToken }, [sibling]: { token: targetToken } } : {}),
      ...(kind === 'destination-machine' ? { [sibling]: { token: targetToken } } : {})
    };
    const actualSource = kind === 'destination-root' ? 'tok-own' : sourceToken;

    await writeJson(paths.configFile, { ...stored, roots: finalRoots });

    const sourceDir = queuePartition(paths.queueDir, actualSource);
    const source = new EventQueue({ queueDir: sourceDir, locksDir: paths.locksDir, maxEvents: 100, maxAttempts: 3, maxEventAgeDays: 7 });

    await source.enqueue([{ id: 'unrelated-record', event: { type: 'turn.summary' } } as unknown as Parameters<EventQueue['enqueue']>[0][number]], 'https://backend.example.com/v1/events');

    const before = await fs.readFile(path.join(sourceDir, 'unrelated-record.json'), 'utf8');
    const questions: string[] = [];
    const beforeOwners = await queueOwnership(paths.queueDir);
    const machine = ['machine-with-shared-root', 'shared-same-token', 'destination-machine'].includes(kind);
    const { result, stdout } = await captureStdout(() => rootSetup({ root: machine ? undefined : repo, endpoint: backend, token: targetToken, yes: false, ask: async (question) => {
      questions.push(question);

      return 'y';
    } }));

    expect(result).toBe(0);
    expect(questions).toEqual([]);
    expect(await queueOwnership(paths.queueDir)).toEqual(beforeOwners);

    if (!['new', 'nested'].includes(kind)) expect(stdout).toContain('automatic migration skipped');

    expect(await fs.readFile(path.join(sourceDir, 'unrelated-record.json'), 'utf8')).toBe(before);

    if (targetToken !== actualSource) expect(await queueEntryFiles(queuePartition(paths.queueDir, targetToken))).toHaveLength(0);
  });

  it('treats an empty token flag as unset and never migrates a credentialed backlog to the adoption pool', async () => {
    await machineSetup();

    const paths = resolvePaths(world.env);
    const sourceDir = queuePartition(paths.queueDir, 'tok-machine');
    const queue = new EventQueue({ queueDir: sourceDir, locksDir: paths.locksDir, maxEvents: 100, maxAttempts: 3, maxEventAgeDays: 7 });

    await queue.enqueue([{ id: 'owned', event: { type: 'turn.summary' } } as unknown as Parameters<EventQueue['enqueue']>[0][number]], 'https://backend.example.com/v1/events');

    const questions: string[] = [];
    const { result } = await captureStdout(() => rootSetup({ endpoint: 'https://new.example.com', token: '', yes: false, ask: async (question) => {
      questions.push(question);

      return 'y';
    } }));

    expect(result).toBe(0);
    expect((await readJson(paths.configFile)).token).toBe('tok-machine');
    expect(await queueOwnership(paths.queueDir)).toEqual({ [path.basename(sourceDir)]: 1 });
    expect((await readJson(path.join(sourceDir, 'owned.json'))).destination).toBe('https://new.example.com/v1/events');
    expect(questions).toEqual([expect.stringContaining('Deliver them to https://new.example.com/v1/events')]);
  });

  it.each([
    { kind: 'a trailing newline on the flag', flag: 'tok-machine\n', env: undefined },
    { kind: 'a trailing newline from the environment', flag: undefined, env: 'tok-machine\n' },
    { kind: 'surrounding whitespace', flag: '  tok-machine  ', env: undefined }
  ])('treats $kind as the same credential, not a new exclusive identity', async ({ flag, env }) => {
    // A partition is keyed by sha(token) and a bearer is the token verbatim, so an
    // untrimmed value both strands the backlog in a partition no hook will list and
    // writes a malformed Authorization header - silently, since Request accepts it.
    // A mounted secret file, `read` and most .env loaders all hand over the newline.
    await machineSetup();

    const paths = resolvePaths(world.env);
    const sourceDir = queuePartition(paths.queueDir, 'tok-machine');
    const queue = new EventQueue({ queueDir: sourceDir, locksDir: paths.locksDir, maxEvents: 100, maxAttempts: 3, maxEventAgeDays: 7 });

    await queue.enqueue([{ id: 'owned', event: { type: 'turn.summary' } } as unknown as Parameters<EventQueue['enqueue']>[0][number]], 'https://backend.example.com/v1/events');

    const questions: string[] = [];
    const world2 = env === undefined ? world.env : { ...world.env, vars: { ...world.env.vars, AGENTWATCH_TOKEN: env } };
    // Same endpoint as the machine already has, so the only thing that could move
    // the backlog is the token. Any question here is setup proposing a migration.
    const { result } = await captureStdout(() => rootSetup({ token: flag, yes: false, env: world2, ask: async (question) => {
      questions.push(question);

      return 'y';
    } }));

    expect(result).toBe(0);
    expect((await readJson(paths.configFile)).token).toBe('tok-machine');
    expect(await queueOwnership(paths.queueDir)).toEqual({ [path.basename(sourceDir)]: 1 });
    expect(questions).toEqual([]);
  });

  it('does not claim a tokenless previous identity owns a backlog to migrate', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, { ...defaultConfig(), endpoint: 'https://old.example.com', developerEmail: 'dev@company.com' });

    const queue = new EventQueue({ queueDir: path.join(paths.queueDir, 'unconfigured'), locksDir: paths.locksDir, maxEvents: 100, maxAttempts: 3, maxEventAgeDays: 7 });

    await queue.enqueue([{ id: 'unconfigured-event', event: { type: 'turn.summary' } } as unknown as Parameters<EventQueue['enqueue']>[0][number]], 'https://old.example.com/v1/events');

    const questions: string[] = [];
    const { result } = await captureStdout(() => rootSetup({ endpoint: 'https://new.example.com', token: 'new-owner', yes: false, ask: async (question) => {
      questions.push(question);

      return 'y';
    } }));

    expect(result).toBe(0);
    expect(questions).toEqual([]);
    expect(await queueOwnership(paths.queueDir)).toEqual({ unconfigured: 1 });
  });

  it.each([false, true])('inspects an empty shared partition without adopting unrelated legacy records: %s', async (legacy) => {
    await machineSetup();

    const paths = resolvePaths(world.env);
    const repo = await rootDir('shared-empty');

    await writeJson(paths.configFile, { ...(await readJson(paths.configFile)), roots: { [repo]: { token: 'tok-machine' } } });

    if (legacy) {
      const unconfigured = new EventQueue({ queueDir: path.join(paths.queueDir, 'unconfigured'), locksDir: paths.locksDir, maxEvents: 100, maxAttempts: 3, maxEventAgeDays: 7 });

      await unconfigured.enqueue([{ id: 'legacy-unowned', event: { type: 'turn.summary' } } as unknown as Parameters<EventQueue['enqueue']>[0][number]], 'https://backend.example.com/v1/events');
    }

    const { result, stdout } = await captureStdout(() => rootSetup({ endpoint: 'https://new.example.com', token: 'tok-machine' }));

    expect(result).toBe(0);
    expect(stdout).not.toContain('automatic migration skipped');
    expect(stdout).not.toContain('expires under retention');
    expect(await queueOwnership(paths.queueDir)).toEqual(legacy ? { unconfigured: 1 } : {});
  });

  it.each([
    { kind: 'token-only', policy: 'https://policy.example.com/decision', route: undefined, level: 'warn' },
    { kind: 'same-host-route', policy: undefined, route: 'https://backend.example.com/v2/events', level: 'ok' },
    { kind: 'foreign-route', policy: undefined, route: 'https://vendor.example.com/events', level: 'warn' },
    { kind: 'shared-token-only', policy: undefined, route: undefined, level: 'ok' }
  ])('checks actual policy hosts for $kind roots', async ({ policy, route, level }) => {
    await machineSetup();

    const paths = resolvePaths(world.env);
    const repo = await rootDir('policy-hosts');

    await writeJson(paths.configFile, { ...(await readJson(paths.configFile)), enforcementUrl: policy, roots: { [repo]: { token: 'root-secret', eventsUrl: route } } });

    const report = JSON.parse((await captureStdout(() => runDoctor({ ...world.env, cwd: repo }, { json: true }))).stdout);
    const check = report.checks.find((entry: { name: string }) => entry.name === 'budget enforcement');

    expect(check.level).toBe(level);
    expect(check.detail).toContain(policy ? 'policy.example.com' : 'backend.example.com');
    expect(JSON.stringify(report)).not.toContain('root-secret');
  });

  it('accepts a split-ingest root whose decision host is one of its own routes', async () => {
    // The four cases above each declare at most one route, so none of them can tell
    // "any route differs" from "no route matches". A root that sends events to the
    // backend and OTLP to its own collector is a normal enterprise layout: the
    // decision host matches the first and not the second, and that is not foreign.
    await machineSetup();

    const paths = resolvePaths(world.env);
    const repo = await rootDir('split-ingest');

    await writeJson(paths.configFile, {
      ...(await readJson(paths.configFile)),
      enforcementUrl: 'https://backend.example.com/v1/enforcement',
      roots: { [repo]: { token: 'root-secret', eventsUrl: 'https://backend.example.com/v1/events', otlpUrl: 'https://otlp-collector.example.com/v1/traces' } }
    });

    const report = JSON.parse((await captureStdout(() => runDoctor({ ...world.env, cwd: repo }, { json: true }))).stdout);
    const check = report.checks.find((entry: { name: string }) => entry.name === 'budget enforcement');

    expect(check.level).toBe('ok');
    expect(check.detail).toContain('backend.example.com');
    expect(JSON.stringify(report)).not.toContain('root-secret');
  });

  it('updates an existing symlink root in place so runtime selects the new identity', async () => {
    await machineSetup();

    const repo = await rootDir('canonical-root');
    const alias = path.join(world.home, 'configured-alias');
    const paths = resolvePaths(world.env);

    await fs.symlink(repo, alias);
    await writeJson(paths.configFile, { ...(await readJson(paths.configFile)), roots: { [alias]: { endpoint: 'https://old.example.com', token: 'old-root' } } });

    const source = new EventQueue({ queueDir: queuePartition(paths.queueDir, 'old-root'), locksDir: paths.locksDir, maxEvents: 100, maxAttempts: 3, maxEventAgeDays: 7 });

    await source.enqueue([{ id: 'alias-record', event: { type: 'turn.summary' } } as unknown as Parameters<EventQueue['enqueue']>[0][number]], 'https://old.example.com/v1/events');

    const questions: string[] = [];
    const { result } = await captureStdout(() => rootSetup({ root: repo, endpoint: 'https://new.example.com', token: 'new-root', yes: false, ask: async (question) => {
      questions.push(question);

      return 'y';
    } }));

    expect(result).toBe(0);
    expect(Object.keys((await readJson(paths.configFile)).roots)).toEqual([alias]);
    expect((await loadEffectiveConfig(paths, repo)).config.token).toBe('new-root');
    expect(questions).toEqual([expect.stringContaining(`captured under ${alias}`)]);
    expect(await queueOwnership(paths.queueDir)).toEqual({ [path.basename(queuePartition(paths.queueDir, 'new-root'))]: 1 });
  });

  it('refuses ambiguous canonical root aliases without modifying config', async () => {
    await machineSetup();

    const repo = await rootDir('ambiguous-root');
    const alias = path.join(world.home, 'duplicate-alias');
    const paths = resolvePaths(world.env);

    await fs.symlink(repo, alias);
    await writeJson(paths.configFile, { ...(await readJson(paths.configFile)), roots: { [alias]: { token: 'one' }, [repo]: { token: 'two' } } });

    const before = await fs.readFile(paths.configFile, 'utf8');
    const { result, stdout } = await captureStdout(() => rootSetup({ root: repo, token: 'three' }));

    expect(result).toBe(1);
    expect(stdout).toContain('multiple configured root keys');
    expect(await fs.readFile(paths.configFile, 'utf8')).toBe(before);
  });

  it.each([
    { kind: 'disabled', message: 'disabled; budget caps are not enforced' },
    { kind: 'no-credential', message: 'no credential configured; budget caps are not enforced' },
    { kind: 'route-only', message: "budget decisions at backend.example.com use this root's credential" }
  ])('explains budget enforcement for $kind identities', async ({ kind, message }) => {
    await machineSetup();

    const repo = await rootDir('budget-root');
    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      token: kind === 'no-credential' ? undefined : stored.token,
      enforcement: { ...stored.enforcement, enabled: kind !== 'disabled' },
      ...(kind === 'route-only' ? { roots: { [repo]: { eventsUrl: 'https://vendor.example.com/events', token: 'root-secret' } } } : {})
    });

    const report = JSON.parse((await captureStdout(() => runDoctor({ ...world.env, cwd: repo }, { json: true }))).stdout);
    const check = report.checks.find((entry: { name: string }) => entry.name === 'budget enforcement');

    expect(check.level).toBe('warn');
    expect(check.detail).toContain(message);
    expect(JSON.stringify(report)).not.toContain('root-secret');
  });

  it('reports collector sharing consistently with otel-headers for a trailing-slash machine base', async () => {
    await machineSetup();

    const paths = resolvePaths(world.env);
    const repo = await rootDir('shared-slash');
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, { ...stored, endpoint: 'https://backend.example.com/' });

    const { result, stdout } = await captureStdout(() => rootSetup({ root: repo, endpoint: undefined, token: 'tok-seat' }));

    expect(result).toBe(0);
    expect(stdout).not.toContain('native OTLP');
    expect(JSON.parse((await captureStdout(() => runOtelHeaders({ ...world.env, cwd: repo }))).stdout)).toEqual({ Authorization: 'Bearer tok-seat' });
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

  // Re-enrolling a root replaced its whole override, so every key the run does
  // not set went with it: the root's own `installationId`, and a refused sibling
  // URL — which ends up *absent* rather than `null` and is therefore invisible
  // to the carry-over in `saveConfig`, so the line the developer wrote is gone
  // and `doctor` reports `configuration: ok` for a machine that just lost it.
  it('re-enrolling a root keeps the keys the run does not set', async () => {
    await machineSetup();

    const repo = await rootDir('clientA');
    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      roots: {
        [repo]: {
          endpoint: 'https://clienta.example.com',
          eventsUrl: 'http://collector.clienta.internal/v1/events',
          token: 'tok-client-a',
          installationId: 'inst-root'
        }
      }
    });

    const { result } = await captureStdout(() => rootSetup({ root: repo, token: 'tok-client-a' }));

    expect(result).toBe(0);

    const onDisk = await readJson(paths.configFile);

    expect(onDisk.roots[repo].eventsUrl).toBe('http://collector.clienta.internal/v1/events');
    expect(onDisk.roots[repo].installationId).toBe('inst-root');
    // And the field is still reported, which is what the erasure took with it.
    expect((await loadConfig(paths)).warnings).toEqual([expect.stringContaining(`roots.${repo}.eventsUrl`)]);
  });

  // A split-route machine is the deployment the `eventsUrl`/`otlpUrl` overrides
  // exist for, and `setup --root` always writes `endpoint`. So a second seat on
  // the same backend names a URL field without claiming a destination: it has
  // to keep the machine's routes and its bearer, or its events 4xx against a
  // host that is not an ingest route and its exporter goes unauthenticated.
  it('leaves a second seat on a split-route machine on the machine\'s routes', async () => {
    await machineSetup();

    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      eventsUrl: 'https://ingest.backend.example.com/v1/events',
      otlpUrl: 'https://otlp.backend.example.com'
    });

    const repo = await rootDir('seat2');

    expect(await captureStdout(() => rootSetup({ root: repo, token: 'tok-seat2' })).then((run) => run.result)).toBe(0);

    const rooted = (await loadEffectiveConfig(paths, repo)).config;

    expect(eventsUrl(rooted)).toBe('https://ingest.backend.example.com/v1/events');
    expect(rooted.token).toBe('tok-seat2');
    expect(JSON.parse((await captureStdout(() => runOtelHeaders({ ...world.env, cwd: repo }))).stdout)).toEqual({ Authorization: 'Bearer tok-seat2' });
  });

  // The carry-over must not keep a *live* route from the previous engagement:
  // a sibling `eventsUrl` out-ranks the new `endpoint`, so re-enrolling against
  // another backend would POST this root's prompts to the old tenant's ingest
  // under the new tenant's bearer, while setup printed the new backend.
  it('drops a live sibling route when a root is re-enrolled against another backend', async () => {
    await machineSetup();

    const repo = await rootDir('clientA');
    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      roots: { [repo]: { endpoint: 'https://clienta.example.com', eventsUrl: 'https://ingest.clienta.example.com/v1/events', token: 'tok-a' } }
    });

    const { result } = await captureStdout(() => rootSetup({ root: repo, endpoint: 'https://clientb.example.com', token: 'tok-b' }));

    expect(result).toBe(0);
    expect((await readJson(paths.configFile)).roots[repo].eventsUrl).toBeUndefined();

    const rooted = (await loadEffectiveConfig(paths, repo)).config;

    expect(eventsUrl(rooted)).toBe('https://clientb.example.com/v1/events');
    expect(rooted.token).toBe('tok-b');
  });

  // `undefined === undefined` is true, so the guard opened exactly when neither
  // side has a collector at all — printing the root's bearer for nobody.
  it('otel-headers signs with nothing when no OTLP base is configured either side', async () => {
    await machineSetup();

    const repo = await rootDir('clientC');
    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      endpoint: 'http://collector.corp:4318',
      roots: { [repo]: { eventsUrl: 'https://ingest.clientc.example.com/v1/events', token: 'tok-c' } }
    });

    const { stdout } = await captureStdout(() => runOtelHeaders({ ...world.env, cwd: repo }));

    expect(JSON.parse(stdout)).toEqual({});
  });

  // Rotating a root's token changes no destination, so a route override an
  // operator wrote for that seat — a regional ingest — must survive the run.
  // Nothing else records it: `storedRefusedUrls` rescues a refused `null`, not
  // a live string, so dropping it here is unrecoverable.
  it('keeps a root\'s own live route when the run only rotates its token', async () => {
    await machineSetup();

    const repo = await rootDir('seat-eu');
    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      roots: { [repo]: { endpoint: 'https://backend.example.com', eventsUrl: 'https://ingest-eu.backend.example.com/v1/events', token: 'tok-old' } }
    });

    expect(await captureStdout(() => rootSetup({ root: repo, token: 'tok-new' })).then((run) => run.result)).toBe(0);

    expect((await readJson(paths.configFile)).roots[repo].eventsUrl).toBe('https://ingest-eu.backend.example.com/v1/events');

    const rooted = (await loadEffectiveConfig(paths, repo)).config;

    expect(eventsUrl(rooted)).toBe('https://ingest-eu.backend.example.com/v1/events');
    expect(rooted.token).toBe('tok-new');
  });

  // The three shapes the entry's endpoint can take, since the branch that keeps
  // a live route is reached by all of them and each answers differently.
  it('carries a live route for an entry that named no endpoint of its own', async () => {
    await machineSetup();

    const repo = await rootDir('inherited-seat');
    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      roots: { [repo]: { eventsUrl: 'https://ingest-eu.backend.example.com/v1/events', token: 'tok-old' } }
    });

    expect(await captureStdout(() => rootSetup({ root: repo, token: 'tok-new' })).then((run) => run.result)).toBe(0);

    // It was sending to the machine's endpoint, and still is, so nothing moved.
    expect((await readJson(paths.configFile)).roots[repo].eventsUrl).toBe('https://ingest-eu.backend.example.com/v1/events');
  });

  // A refusal is not a destination anyone can compare against. Reading it as
  // "was sending to the machine's" carried the previous engagement's live
  // ingest onto the new token — the cross-tenant POST, through a typo.
  it('drops a live route when the entry it sat beside was a refused endpoint', async () => {
    await machineSetup();

    const repo = await rootDir('clientA-typo');
    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      roots: {
        [repo]: {
          endpoint: 'http://collector.clienta.internal',
          eventsUrl: 'https://ingest.clienta.example.com/v1/events',
          token: 'tok-a'
        }
      }
    });

    expect(await captureStdout(() => rootSetup({ root: repo, token: 'tok-b' })).then((run) => run.result)).toBe(0);

    expect((await readJson(paths.configFile)).roots[repo].eventsUrl).toBeUndefined();

    const rooted = (await loadEffectiveConfig(paths, repo)).config;

    expect(eventsUrl(rooted)).toBe('https://backend.example.com/v1/events');
    expect(rooted.token).toBe('tok-b');
  });

  // The machine identity is held to the same rule: a consultant winding one
  // engagement down and starting the next on the same laptop never has to learn
  // about `--root` to reach the same misroute.
  it('drops the machine\'s live route when setup names another backend', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, {
      ...defaultConfig(),
      endpoint: 'https://clienta.example.com',
      eventsUrl: 'https://ingest.clienta.example.com/v1/events',
      token: 'tok-a'
    });

    const { result } = await captureStdout(() => rootSetup({ endpoint: 'https://clientb.example.com', token: 'tok-b' }));

    expect(result).toBe(0);

    const onDisk = await readJson(paths.configFile);

    expect(onDisk.eventsUrl).toBeUndefined();
    expect(eventsUrl((await loadConfig(paths)).config)).toBe('https://clientb.example.com/v1/events');
  });

  it.each([
    { scope: 'machine', slash: '' },
    { scope: 'machine', slash: '/' },
    { scope: 'root', slash: '' },
    { scope: 'root', slash: '/' }
  ])('keeps split routes on $scope token rotation with stored suffix "$slash"', async ({ scope, slash }) => {
    await machineSetup();

    const paths = resolvePaths(world.env);
    const repo = await rootDir('rotation');
    const stored = await readJson(paths.configFile);
    const routes = { eventsUrl: 'https://ingest-eu.example.com/v1/events', otlpUrl: 'https://otlp-eu.example.com' };
    const identity = { ...routes, endpoint: `https://clienta.example.com${slash}`, token: 'tok-old' };
    const before = scope === 'machine'
      ? { ...stored, ...identity, enforcementUrl: 'https://policy.clienta.example.com/decision' }
      : { ...stored, roots: { [repo]: identity } };

    await writeJson(paths.configFile, before);

    const { result, stdout } = await captureStdout(() => rootSetup({ endpoint: undefined, root: scope === 'root' ? repo : undefined, token: 'tok-new' }));

    expect(result).toBe(0);
    expect(stdout).not.toContain('cleared');

    const disk = await readJson(paths.configFile);
    const updated = scope === 'machine' ? disk : disk.roots[repo];
    const config = (await loadEffectiveConfig(paths, scope === 'root' ? repo : world.env.cwd)).config;

    expect(updated).toMatchObject({ ...routes, endpoint: 'https://clienta.example.com', token: 'tok-new' });
    expect(eventsUrl(config)).toBe(routes.eventsUrl);
    expect(otlpBaseUrl(config)).toBe(routes.otlpUrl);

    if (scope === 'machine') expect(enforcementUrl(config)).toBe('https://policy.clienta.example.com/decision');
  });

  it.each([
    { scope: 'machine', endpoint: undefined },
    { scope: 'machine', endpoint: 'http://refused.internal' },
    { scope: 'root', endpoint: 'http://refused.internal' },
    { scope: 'root', endpoint: 'https://previous.example.com' }
  ])('reports every cleared route on $scope repair/reroute from $endpoint', async ({ scope, endpoint }) => {
    await machineSetup();

    const paths = resolvePaths(world.env);
    const repo = await rootDir('repair');
    const stored = await readJson(paths.configFile);
    const identity = { endpoint, eventsUrl: 'https://old.example.com/events', otlpUrl: 'https://old.example.com/otel', token: 'tok-old' };

    await writeJson(paths.configFile, scope === 'machine' ? { ...stored, ...identity } : { ...stored, roots: { [repo]: identity } });

    const { result, stdout } = await captureStdout(() => rootSetup({ root: scope === 'root' ? repo : undefined, endpoint: 'https://new.example.com', token: 'tok-new' }));

    expect(result).toBe(0);
    expect(stdout).toContain('cleared eventsUrl (https://old.example.com/events)');
    expect(stdout).toContain('cleared otlpUrl (https://old.example.com/otel)');

    const disk = await readJson(paths.configFile);
    const updated = scope === 'machine' ? disk : disk.roots[repo];
    const config = (await loadEffectiveConfig(paths, scope === 'root' ? repo : world.env.cwd)).config;

    expect(updated.eventsUrl).toBeUndefined();
    expect(updated.otlpUrl).toBeUndefined();
    expect(eventsUrl(config)).toBe('https://new.example.com/v1/events');
    expect(otlpBaseUrl(config)).toBe('https://new.example.com/v1/otlp');
  });

  it('moves an explicit machine enforcement route with its backend', async () => {
    const paths = resolvePaths(world.env);

    await writeJson(paths.configFile, { ...defaultConfig(), endpoint: 'https://old.example.com', enforcementUrl: 'https://policy.old.example.com/decision', token: 'tok-old' });

    const { result, stdout } = await captureStdout(() => rootSetup({ endpoint: 'https://new.example.com', token: 'tok-new' }));

    expect(result).toBe(0);
    expect(stdout).toContain('cleared enforcementUrl');
    expect((await readJson(paths.configFile)).enforcementUrl).toBeUndefined();
    expect(enforcementUrl((await loadConfig(paths)).config)).toBe('https://new.example.com/v1/enforcement/decision');
  });

  it('explains refused endpoints and absent root routes in doctor and config', async () => {
    await machineSetup();

    const paths = resolvePaths(world.env);
    const repo = await rootDir('refused');
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, { ...stored, roots: { [repo]: { endpoint: 'http://refused.internal', token: 'root-secret' } } });

    const report = JSON.parse((await captureStdout(() => runDoctor({ ...world.env, cwd: repo }, { json: true }))).stdout);
    const check = report.checks.find((entry: { name: string }) => entry.name === 'backend connectivity');

    expect(check.detail).toContain('fix the refused endpoint');
    expect(check.detail).not.toContain('remove its other URL');
    expect(report.checks.find((entry: { name: string }) => entry.name === 'budget enforcement')).toMatchObject({ level: 'fail', detail: expect.stringContaining('budget caps are not enforced') });

    const refusedConfig = (await captureStdout(() => runConfig({ ...world.env, cwd: repo }))).stdout;

    expect(refusedConfig).toContain(`# warning: roots.${repo}.endpoint`);
    expect(refusedConfig).toContain('# warning: this project root has no usable OTLP route');
    expect(refusedConfig).not.toContain('root-secret');

    await writeJson(paths.configFile, { ...stored, roots: { [repo]: { otlpUrl: 'https://root.example.com/otel', token: 'root-secret' } } });

    const { stdout } = await captureStdout(() => runConfig({ ...world.env, cwd: repo }));

    expect(stdout).toContain('# warning: this project root has no usable events route');
    expect(stdout).not.toContain('root-secret');
    expect(stdout).toContain('"eventsUrl": null');
  });

  // The cleared route is a deliberate stop, and it read as an unconfigured
  // machine two lines under this root's own endpoint — with `agentwatch setup`
  // offered as the remedy, which would quietly make it a second seat instead.
  it('doctor names the root that has no events route, rather than calling it unconfigured', async () => {
    await machineSetup();

    const repo = await rootDir('clientC');
    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      roots: { [repo]: { otlpUrl: 'https://otlp.clientc.example.com', token: 'tok-c' } }
    });

    const { stdout } = await captureStdout(() => runDoctor({ ...world.env, cwd: repo }, { json: true }));
    const check = JSON.parse(stdout).checks.find((entry: { name: string }) => entry.name === 'backend connectivity');

    expect(check.detail).toContain(repo);
    expect(check.detail).not.toContain('no backend configured yet');
  });

  // A root that names one route and not the other must not get the other from
  // the machine — here the machine's collector is derived from a healthy
  // endpoint, so the `Boolean(base)` guard never sees it and the bases matched.
  it('otel-headers signs with nothing for a root that names only its own ingest', async () => {
    await machineSetup();

    const repo = await rootDir('clientC');
    const paths = resolvePaths(world.env);
    const stored = await readJson(paths.configFile);

    await writeJson(paths.configFile, {
      ...stored,
      roots: { [repo]: { eventsUrl: 'https://ingest.clientc.example.com/v1/events', token: 'tok-c' } }
    });

    const { stdout } = await captureStdout(() => runOtelHeaders({ ...world.env, cwd: repo }));

    expect(JSON.parse(stdout)).toEqual({});
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
