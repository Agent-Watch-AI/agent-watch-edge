import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antigravityProvider } from '../src/providers/antigravity/antigravity.provider.js';
import { canonicalModelName } from '../src/providers/antigravity/antigravity.adapter.js';
import { antigravityHooksPath, detectAntigravity } from '../src/providers/antigravity/antigravity.detect.js';
import { ANTIGRAVITY_HOOK_EVENTS, installAntigravityHooks, uninstallAntigravityHooks } from '../src/providers/antigravity/antigravity.hooks.js';
import { resolvePaths } from '../src/storage/paths.js';
import { defaultConfig } from '../src/config/config.js';
import { isAgentWatchHookCommand, type SetupContext } from '../src/providers/provider.js';
import { runHook } from '../src/cli/hook.js';
import { makeTempEnv, readJson, readQueueEntries, writeJson, type TempWorld } from './helpers.js';
import {
  ANTIGRAVITY_COMMON,
  EDIT_FILE_ARGS,
  RUN_COMMAND_ARGS,
  antigravityPostInvocation,
  antigravityPostTool,
  antigravityPreInvocation,
  antigravityPreTool,
  antigravitySessionStart,
  antigravityStop
} from './fixtures/antigravity.js';

const HOOK_CMD = 'agentwatch hook --agent antigravity';

describe('Antigravity provider', () => {
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

  async function parse(payload: unknown) {
    const config = defaultConfig();

    return antigravityProvider.parseHookEvent(payload, { env: world.env, config });
  }

  describe('hook payload parsing', () => {
    it('reads identity out of `common`, not the top level', async () => {
      const [event] = await parse(antigravityPreTool('edit_file', EDIT_FILE_ARGS));

      expect(event?.session.id).toBe(ANTIGRAVITY_COMMON.conversationId);
      expect(event?.session.providerId).toBe(ANTIGRAVITY_COMMON.conversationId);
      expect(event?.session.turnId).toBe(ANTIGRAVITY_COMMON.executionId);
      // `Claude Opus 4.6 (Thinking)` reaches the event as the id every other
      // agent reports, with the picker's own wording kept beside it.
      expect(event?.ai?.model).toBe('claude-opus-4-6');
      expect((event?.metadata?.['provider'] as Record<string, unknown>)['modelDisplayName']).toBe(ANTIGRAVITY_COMMON.modelName);
      expect(event?.agent.provider).toBe('antigravity');
    });

    it('translates every model label the picker produces into an id', () => {
      const cases: [string, string | undefined][] = [
        ['Claude Opus 4.6 (Thinking)', 'claude-opus-4-6'],
        ['Claude Sonnet 4.5', 'claude-sonnet-4-5'],
        ['Claude Opus 4.5 (Thinking)', 'claude-opus-4-5'],
        // Google and OpenAI keep the dot: `gemini-3-1-pro` matches nothing.
        ['Gemini 3 Pro (High)', 'gemini-3-pro'],
        ['Gemini 3.1 Pro', 'gemini-3.1-pro'],
        ['GPT-5.2', 'gpt-5.2'],
        ['GPT-OSS 120B', 'gpt-oss-120b'],
        // An id is already an id: applying this twice must not change it.
        ['claude-opus-4-6', 'claude-opus-4-6'],
        ['gemini-3-pro-preview', 'gemini-3-pro-preview'],
        ['', undefined],
        ['   ', undefined],
        [undefined as unknown as string, undefined]
      ];

      for (const [displayName, expected] of cases) {
        expect(canonicalModelName(displayName)).toBe(expected);
      }
    });

    it('selects the event from the oneof member, since no name field exists', async () => {
      const cases: [unknown, string, string][] = [
        [antigravitySessionStart(), 'session.started', 'SessionStart'],
        [antigravityPreInvocation(1), 'prompt.submitted', 'PreInvocation'],
        [antigravityPostInvocation(1), 'agent.other', 'PostInvocation'],
        [antigravityPreTool('edit_file', EDIT_FILE_ARGS), 'tool.started', 'PreToolUse'],
        [antigravityPostTool('edit_file', EDIT_FILE_ARGS), 'file.edited', 'PostToolUse'],
        [antigravityStop(), 'generation.completed', 'Stop']
      ];

      for (const [payload, type, providerEventType] of cases) {
        const [event] = await parse(payload);

        expect(event?.event.type, providerEventType).toBe(type);
        expect(event?.event.providerEventType).toBe(providerEventType);
      }
    });

    it('takes the turn prompt from common.lastUserInput on the first invocation only', async () => {
      const config = defaultConfig();
      const [first] = await antigravityProvider.parseHookEvent(antigravityPreInvocation(1), { env: world.env, config });

      expect(first?.event.type).toBe('prompt.submitted');
      expect(first?.metadata?.['promptText']).toBe(ANTIGRAVITY_COMMON.lastUserInput);

      // Invocations 2..n are model calls inside the same turn, not new prompts.
      const [later] = await antigravityProvider.parseHookEvent(antigravityPreInvocation(4), { env: world.env, config });

      expect(later?.event.type).toBe('agent.other');
      expect(later?.metadata?.['promptText']).toBeUndefined();
    });

    it('treats invocation 0 as the first one too: the counter base is not documented', async () => {
      const [event] = await parse(antigravityPreInvocation(0));

      expect(event?.event.type).toBe('prompt.submitted');
    });

    it('closes the turn on Stop and carries the final response', async () => {
      const [event] = await parse(antigravityStop({ finalModelOutput: 'raised it to 30s' }));

      expect(event?.event.type).toBe('generation.completed');
      expect(event?.metadata?.['responseText']).toBe('raised it to 30s');
      expect(event?.metadata?.['response']).toMatchObject({ length: 'raised it to 30s'.length });
    });

    it('never maps Stop to session.ended, which would delete the turn state', async () => {
      const [event] = await parse(antigravityStop());

      expect(event?.event.type).not.toBe('session.ended');
    });

    it('reads PascalCase tool arguments: TargetFile and CommandLine', async () => {
      const [edited] = await parse(antigravityPostTool('edit_file', EDIT_FILE_ARGS));

      expect(edited?.event.type).toBe('file.edited');
      expect(edited?.metadata?.['filePath']).toBe(EDIT_FILE_ARGS.TargetFile);

      const [ran] = await parse(antigravityPostTool('run_command', RUN_COMMAND_ARGS));

      expect(ran?.event.type).toBe('shell.completed');
      expect(ran?.metadata?.['command']).toBe(RUN_COMMAND_ARGS.CommandLine);
    });

    it('marks a tool call that reported an error as failed', async () => {
      const [event] = await parse(antigravityPostTool('run_command', RUN_COMMAND_ARGS, { error: 'exit 1' }));

      expect(event?.event.type).toBe('tool.failed');
      expect(event?.tool?.status).toBe('failed');
    });

    it('produces nothing for a payload that is not a HookArgs message', async () => {
      expect(await parse({ hookEventName: 'PreToolUse', conversationId: 'x' })).toEqual([]);
      expect(await parse(null)).toEqual([]);
    });
  });

  describe('hook response', () => {
    it('allows the tool call: PreToolHookResult.decision is required', () => {
      const response = antigravityProvider.getHookResponse(antigravityPreTool('edit_file', EDIT_FILE_ARGS));

      expect(response.exitCode).toBe(0);
      expect(JSON.parse(response.stdout ?? '{}')).toEqual({ decision: 'allow' });
    });

    it('lets the agent stop: StopHookResult.decision is required', () => {
      const response = antigravityProvider.getHookResponse(antigravityStop());

      expect(JSON.parse(response.stdout ?? '{}')).toEqual({ decision: 'stop' });
    });

    it('stays silent for the hooks whose result message carries no decision', () => {
      for (const payload of [
        antigravityPostTool('edit_file', EDIT_FILE_ARGS),
        antigravityPreInvocation(1),
        antigravityPostInvocation(1),
        antigravitySessionStart()
      ]) {
        expect(JSON.parse(antigravityProvider.getHookResponse(payload).stdout ?? '{}')).toEqual({});
      }
    });

    it('allows by default when the payload is unreadable, so telemetry never blocks a tool', () => {
      expect(JSON.parse(antigravityProvider.getHookResponse(undefined).stdout ?? '{}')).toEqual({ decision: 'allow' });
    });
  });

  describe('hook installation', () => {
    it('registers a named hook group with a millisecond timeout', async () => {
      const context = setupContext();
      const outcome = await installAntigravityHooks(context);

      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(true);

      const file = await readJson<Record<string, Record<string, unknown[]>>>(antigravityHooksPath(world.env));

      expect(Object.keys(file)).toEqual(['agentwatch']);

      for (const event of ANTIGRAVITY_HOOK_EVENTS) {
        expect(file['agentwatch']?.[event]).toBeDefined();
      }

      // 30 was read as 30ms and timed every hook out before node could start.
      const timeouts = JSON.stringify(file).match(/"timeout":\s*(\d+)/g) ?? [];

      expect(timeouts.length).toBeGreaterThan(0);

      for (const timeout of timeouts) expect(timeout).toContain('30000');
    });

    it('is idempotent and never duplicates its own entry', async () => {
      const context = setupContext();

      await installAntigravityHooks(context);
      const second = await installAntigravityHooks(context);

      expect(second.changed).toBe(false);

      const file = await readJson<Record<string, Record<string, unknown[]>>>(antigravityHooksPath(world.env));

      expect(file['agentwatch']?.['PreInvocation']).toHaveLength(1);
    });

    it('keeps a foreign hook group untouched', async () => {
      await writeJson(antigravityHooksPath(world.env), {
        'other-tool': { PreToolUse: [{ type: 'command', command: 'other-tool run' }] }
      });
      await installAntigravityHooks(setupContext());
      const file = await readJson<Record<string, unknown>>(antigravityHooksPath(world.env));

      expect(file['other-tool']).toEqual({ PreToolUse: [{ type: 'command', command: 'other-tool run' }] });
    });

    it('refuses to touch an unparseable hooks file', async () => {
      await fs.mkdir(path.dirname(antigravityHooksPath(world.env)), { recursive: true });
      await fs.writeFile(antigravityHooksPath(world.env), '{ not json');
      const outcome = await installAntigravityHooks(setupContext());

      expect(outcome.ok).toBe(false);
      expect(outcome.changed).toBe(false);
    });
  });

  describe('hook uninstallation', () => {
    it('actually removes the hooks it installed', async () => {
      const context = setupContext();

      await installAntigravityHooks(context);
      const outcome = await uninstallAntigravityHooks(context);

      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(true);
      const read = await fs.readFile(antigravityHooksPath(world.env), 'utf8').catch(() => '{}');

      expect(read).not.toContain('agentwatch hook --agent antigravity');
      expect(context.installState.agents['antigravity']).toBeUndefined();
    });

    it('leaves a foreign group in place while removing ours', async () => {
      await writeJson(antigravityHooksPath(world.env), {
        'other-tool': { PreToolUse: [{ type: 'command', command: 'other-tool run' }] }
      });
      const context = setupContext();

      await installAntigravityHooks(context);
      await uninstallAntigravityHooks(context);

      const file = await readJson<Record<string, unknown>>(antigravityHooksPath(world.env));

      expect(file['other-tool']).toBeDefined();
      expect(file['agentwatch']).toBeUndefined();
    });

    it('reports success when there is nothing installed', async () => {
      const context = setupContext();
      const outcome = await uninstallAntigravityHooks(context);

      expect(outcome.ok).toBe(true);
      expect(outcome.changed).toBe(false);
    });
  });

  describe('detection', () => {
    it('is not detected in a clean environment', async () => {
      const result = await detectAntigravity(world.env);

      expect(result.detected).toBe(false);
      expect(result.hooksInstalled).toBe(false);
    });

    it('detects the CLI home and reports installed hooks', async () => {
      await fs.mkdir(path.join(world.home, '.gemini', 'antigravity-cli'), { recursive: true });
      await installAntigravityHooks(setupContext());
      const result = await detectAntigravity(world.env);

      expect(result.detected).toBe(true);
      expect(result.hooksInstalled).toBe(true);
      expect(isAgentWatchHookCommand(HOOK_CMD)).toBe(true);
    });
  });

  describe('through the hook pipeline', () => {
    it('emits one turn.summary per execution, with prompt, response and tools', async () => {
      const paths = resolvePaths(world.env);
      const config = defaultConfig();

      // Unroutable endpoint: the direct send fails and the event lands in the
      // queue exactly as it would have been posted.
      config.endpoint = 'http://127.0.0.1:1';
      config.token = 'test-token';
      config.installationId = 'inst-1';
      config.delivery.timeoutMs = 200;
      await writeJson(paths.configFile, config);

      const payloads = [
        antigravityPreInvocation(1),
        antigravityPostTool('edit_file', EDIT_FILE_ARGS),
        antigravityPostTool('run_command', RUN_COMMAND_ARGS),
        antigravityPostInvocation(2, 'partial'),
        antigravityStop({ finalModelOutput: 'raised it to 30s' })
      ];

      for (const payload of payloads) {
        await runHook('antigravity', { env: world.env, input: JSON.stringify(payload), writeStdout: () => {} });
      }

      const queued = await readQueueEntries<{ event: Record<string, unknown> }>(paths.queueDir);
      const summaries = queued.map((entry) => entry.event).filter((event) => (event['event'] as { type?: string }).type === 'turn.summary');

      expect(summaries).toHaveLength(1);
      const summary = summaries[0]!;

      expect(summary['provider']).toBe('antigravity');
      expect(summary['surface']).toBe('ide');
      expect(summary['session_id']).toBe(ANTIGRAVITY_COMMON.conversationId);
      expect(summary['turn_id']).toBe(ANTIGRAVITY_COMMON.executionId);
      expect(summary['prompt']).toBe(ANTIGRAVITY_COMMON.lastUserInput);
      expect(summary['response']).toBe('raised it to 30s');
      expect(summary['tool_calls']).toBe(2);
      expect(summary['tools_used']).toEqual({ edit_file: 1, run_command: 1 });
      // Basename only: the workspace is not a git checkout here, and an
      // absolute path outside a repo root leaks the machine layout.
      expect(summary['files_touched']).toEqual(['timeout.ts']);
      expect(summary['usage_status']).toBe('pending');
    });

    it('does not double the prompt when the first-invocation hook fires twice', async () => {
      const paths = resolvePaths(world.env);
      const config = defaultConfig();

      config.endpoint = 'http://127.0.0.1:1';
      config.delivery.timeoutMs = 200;
      await writeJson(paths.configFile, config);

      for (const payload of [antigravityPreInvocation(1), antigravityPreInvocation(0), antigravityStop({ finalModelOutput: 'done' })]) {
        await runHook('antigravity', { env: world.env, input: JSON.stringify(payload), writeStdout: () => {} });
      }

      const queued = await readQueueEntries<{ event: Record<string, unknown> }>(paths.queueDir);
      const summary = queued.map((entry) => entry.event).find((event) => (event['event'] as { type?: string }).type === 'turn.summary');

      expect(summary?.['prompt']).toBe(ANTIGRAVITY_COMMON.lastUserInput);
    });
  });
});
