import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectCursor, cursorHooksJsonPath } from '../src/providers/cursor/cursor.detect.js';
import { installCursorHooks, uninstallCursorHooks, CURSOR_HOOK_EVENTS } from '../src/providers/cursor/cursor.hooks.js';
import { parseCursorHookEvent } from '../src/providers/cursor/cursor.adapter.js';
import { cursorProvider } from '../src/providers/cursor/cursor.provider.js';
import { getProvider } from '../src/providers/registry.js';
import { isAgentWatchHookCommand, type HookContext, type SetupContext } from '../src/providers/provider.js';
import { readCursorTurnUsage } from '../src/turns/cursor-transcript.js';
import { resolvePaths } from '../src/storage/paths.js';
import { defaultConfig } from '../src/config/config.js';
import { realEnv } from '../src/core/env.js';
import { runHook } from '../src/cli/hook.js';
import { CONTENT_CAPTURE_ON, makeTempEnv, readJson, writeJson, type TempWorld } from './helpers.js';
import * as cursor from './fixtures/cursor.js';

const HOOK_CMD = 'agentwatch hook --agent cursor';

// Adapter *mapping* is the subject here, not the shipped default, so these
// contexts opt into content capture and each test narrows what it is about.
function context(overrides: Partial<ReturnType<typeof defaultConfig>['capture']> = {}): HookContext {
  const config = defaultConfig();

  config.capture = { ...config.capture, ...CONTENT_CAPTURE_ON, ...overrides };

  return { env: realEnv(), config };
}

describe('Cursor adapter', () => {
  it('maps sessionStart to session.started with model and mode', () => {
    const [event] = parseCursorHookEvent(cursor.cursorSessionStart, context());

    expect(event!.event.type).toBe('session.started');
    expect(event!.agent).toEqual({ provider: 'cursor', name: 'Cursor' });
    expect(event!.session.id).toBe('conv-1');
    expect(event!.session.providerId).toBe('conv-1');
    expect(event!.ai?.model).toBe('gpt-5.2');
    expect(event!.metadata?.['sessionSource']).toBe('agent');
  });

  it('maps sessionEnd with reason', () => {
    const [event] = parseCursorHookEvent(cursor.cursorSessionEnd, context());

    expect(event!.event.type).toBe('session.ended');
    expect(event!.metadata?.['sessionEndReason']).toBe('completed');
  });

  it('carries generation_id as the turn id on every event of the turn', () => {
    for (const payload of [cursor.cursorBeforeSubmitPrompt, cursor.cursorPostToolUseRead, cursor.cursorStop]) {
      const [event] = parseCursorHookEvent(payload, context());

      expect(event!.session.turnId).toBe('gen-1');
    }
  });

  it('excludes prompt text when capture.prompts is off but keeps length+hash evidence', () => {
    const [event] = parseCursorHookEvent(cursor.cursorBeforeSubmitPrompt, context({ prompts: false }));

    expect(event!.event.type).toBe('prompt.submitted');
    expect(JSON.stringify(event)).not.toContain('Refactor the auth middleware');
    const prompt = event!.metadata?.['prompt'] as { length: number; sha256: string };

    expect(prompt.length).toBe(cursor.cursorBeforeSubmitPrompt.prompt.length);
    expect(prompt.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes prompt text when capture.prompts is on', () => {
    const [event] = parseCursorHookEvent(cursor.cursorBeforeSubmitPrompt, context());

    expect(event!.metadata?.['promptText']).toContain('Refactor the auth middleware');
  });

  it('classifies Cursor tool names and starts: Shell -> shell.started', () => {
    const [shell] = parseCursorHookEvent(cursor.cursorPreToolUseShell, context());

    expect(shell!.event.type).toBe('shell.started');
    expect(shell!.tool?.name).toBe('Shell');
  });

  it('never double-counts tools covered by dedicated hooks: generic postToolUse is observation-only', () => {
    // Cursor fires BOTH postToolUse and the dedicated hook (afterShellExecution,
    // beforeReadFile, afterFileEdit, afterMCPExecution) for these kinds; only
    // the dedicated hook may produce a completion, or tool_calls doubles.
    const [read] = parseCursorHookEvent(cursor.cursorPostToolUseRead, context());

    expect(read!.event.type).toBe('agent.other');
    expect(read!.metadata?.['filePath']).toBe('/work/project/src/auth.ts');
    const [shell] = parseCursorHookEvent({ ...cursor.cursorPreToolUseShell, hook_event_name: 'postToolUse' }, context());

    expect(shell!.event.type).toBe('agent.other');
    // Tools with no dedicated hook still complete through the generic surface.
    const [task] = parseCursorHookEvent({ ...cursor.cursorPostToolUseRead, tool_name: 'Task' }, context());

    expect(task!.event.type).toBe('tool.completed');
    // Failures only ever arrive generically: they stay tool.failed for all kinds.
    const [failure] = parseCursorHookEvent(cursor.cursorPostToolUseFailure, context());

    expect(failure!.event.type).toBe('tool.failed');
  });

  it('hides the shell command when capture.toolInput is off', () => {
    const [event] = parseCursorHookEvent(cursor.cursorBeforeShellExecution, context({ toolInput: false }));

    expect(event!.event.type).toBe('shell.started');
    expect(JSON.stringify(event)).not.toContain('git status');
  });

  it('maps dedicated shell hooks with duration and output gating', () => {
    const [after] = parseCursorHookEvent(cursor.cursorAfterShellExecution, context());

    expect(after!.event.type).toBe('shell.completed');
    expect(after!.tool?.durationMs).toBe(80);
    expect(after!.metadata?.['command']).toBe('git status --porcelain');
    expect(after!.metadata?.['toolOutput']).toBe(' M src/auth.ts');
    const [gated] = parseCursorHookEvent(cursor.cursorAfterShellExecution, context({ toolOutput: false }));

    expect(JSON.stringify(gated)).not.toContain('M src/auth.ts');
  });

  it('maps MCP hooks with server endpoint metadata', () => {
    const [before] = parseCursorHookEvent(cursor.cursorBeforeMCPExecution, context());

    expect(before!.event.type).toBe('mcp.started');
    const provider = before!.metadata?.['provider'] as Record<string, unknown>;

    expect(provider['mcpServer']).toBe('https://mcp.linear.app/sse');
    expect(provider['mcpTool']).toBe('search_issues');
    const [after] = parseCursorHookEvent(cursor.cursorAfterMCPExecution, context());

    expect(after!.event.type).toBe('mcp.completed');
    expect(after!.metadata?.['toolOutput']).toBe('{"issues":[]}');
  });

  it('never captures file content from beforeReadFile, only the path', () => {
    const [event] = parseCursorHookEvent(cursor.cursorBeforeReadFile, context());

    expect(event!.event.type).toBe('file.read');
    expect(event!.metadata?.['filePath']).toBe('/work/project/src/secrets.ts');
    expect(JSON.stringify(event)).not.toContain('sk-super-secret');
  });

  it('drops the file path when capture.files is off', () => {
    const [event] = parseCursorHookEvent(cursor.cursorAfterFileEdit, context({ files: false }));

    expect(event!.metadata?.['filePath']).toBeUndefined();
  });

  it('maps afterFileEdit with edits gated by capture.toolOutput', () => {
    const [event] = parseCursorHookEvent(cursor.cursorAfterFileEdit, context());

    expect(event!.event.type).toBe('file.edited');
    expect(event!.metadata?.['toolOutput']).toEqual(cursor.cursorAfterFileEdit.edits);
    const [gated] = parseCursorHookEvent(cursor.cursorAfterFileEdit, context({ toolOutput: false }));

    expect(gated!.metadata?.['toolOutput']).toBeUndefined();
  });

  it('marks tab edits and tolerates their missing conversation ids', () => {
    const [event] = parseCursorHookEvent(cursor.cursorAfterTabFileEdit, context());

    expect(event!.event.type).toBe('file.edited');
    expect(event!.metadata?.['tab']).toBe(true);
    expect(event!.session.id).toBeUndefined();
  });

  it('maps subagent lifecycle with agent identity', () => {
    const [start] = parseCursorHookEvent(cursor.cursorSubagentStart, context());

    expect(start!.event.type).toBe('subagent.started');
    expect(start!.session.agentId).toBe('sub-9');
    expect(start!.metadata?.['agentType']).toBe('explore');
    expect(start!.ai?.model).toBe('gpt-5.2-mini');
    const [stop] = parseCursorHookEvent(cursor.cursorSubagentStop, context());

    expect(stop!.event.type).toBe('subagent.completed');
    expect(stop!.metadata?.['subagentStatus']).toBe('completed');
  });

  it('maps preCompact to compaction.started', () => {
    const [event] = parseCursorHookEvent(cursor.cursorPreCompact, context());

    expect(event!.event.type).toBe('compaction.started');
    expect(event!.metadata?.['contextUsagePercent']).toBe(85);
  });

  it('captures the response from afterAgentResponse with capture gating', () => {
    const [event] = parseCursorHookEvent(cursor.cursorAfterAgentResponse, context());

    expect(event!.event.type).toBe('agent.other');
    expect(event!.metadata?.['responseText']).toContain('refactored the middleware');
    const [gated] = parseCursorHookEvent(cursor.cursorAfterAgentResponse, context({ responses: false }));

    expect(JSON.stringify(gated)).not.toContain('refactored the middleware');
    const evidence = gated!.metadata?.['response'] as { length: number };

    expect(evidence.length).toBe(cursor.cursorAfterAgentResponse.text.length);
  });

  it('prefers the structured model_id over the legacy model slug', () => {
    const [event] = parseCursorHookEvent({ ...cursor.cursorSessionStart, model_id: 'openai/gpt-5.2-high' }, context());

    expect(event!.ai?.model).toBe('openai/gpt-5.2-high');
    // Non-string model_id shapes must not drop the event or the legacy slug.
    const [fallback] = parseCursorHookEvent({ ...cursor.cursorSessionStart, model_id: { vendor: 'openai' } }, context());

    expect(fallback!.ai?.model).toBe('gpt-5.2');
  });

  it('keeps structured inference params from model_params', () => {
    const [event] = parseCursorHookEvent(
      { ...cursor.cursorStop, model_params: [{ id: 'thinking', value: 'high' }, { id: 'effort', value: 'max' }, 'garbage', { value: 'orphan' }] },
      context()
    );
    const provider = event!.metadata?.['provider'] as Record<string, unknown>;

    expect(provider['modelParams']).toEqual({ thinking: 'high', effort: 'max' });
  });

  it('records prompt attachments: count always, paths gated by capture.files', () => {
    const [event] = parseCursorHookEvent(cursor.cursorBeforeSubmitPrompt, context());

    expect(event!.metadata?.['attachmentCount']).toBe(1);
    expect(event!.metadata?.['attachments']).toEqual(['/work/project/src/auth.ts']);
    const [gated] = parseCursorHookEvent(cursor.cursorBeforeSubmitPrompt, context({ files: false }));

    expect(gated!.metadata?.['attachmentCount']).toBe(1);
    expect(gated!.metadata?.['attachments']).toBeUndefined();
  });

  it('maps stop to generation.completed with the turn id', () => {
    const [event] = parseCursorHookEvent(cursor.cursorStop, context());

    expect(event!.event.type).toBe('generation.completed');
    expect(event!.session.turnId).toBe('gen-1');
    expect(event!.metadata?.['stopStatus']).toBe('completed');
  });

  it('derives stable ids for identical payloads and distinct ids per tool use', () => {
    const [a] = parseCursorHookEvent(cursor.cursorPreToolUseShell, context());
    const [b] = parseCursorHookEvent(cursor.cursorPreToolUseShell, context());
    const [c] = parseCursorHookEvent({ ...cursor.cursorPreToolUseShell, tool_use_id: 'other' }, context());

    expect(a!.id).toBe(b!.id);
    expect(a!.id).not.toBe(c!.id);
  });

  it('never throws on malformed payloads', () => {
    expect(parseCursorHookEvent(null, context())).toEqual([]);
    expect(parseCursorHookEvent('garbage', context())).toEqual([]);
    expect(parseCursorHookEvent(42, context())).toEqual([]);
    expect(parseCursorHookEvent({ hook_event_name: 12345 }, context())).toEqual([]);
    expect(parseCursorHookEvent({}, context())).toHaveLength(1);
  });

  it('preserves unknown event types as agent.other', () => {
    const [event] = parseCursorHookEvent({ hook_event_name: 'afterAgentThought', conversation_id: 'conv-1' }, context());

    expect(event!.event.type).toBe('agent.other');
    expect(event!.event.providerEventType).toBe('afterAgentThought');
  });
});

describe('Cursor provider wiring', () => {
  it('is registered and returns the safe silent hook response', () => {
    expect(getProvider('cursor')).toBe(cursorProvider);
    expect(cursorProvider.getHookResponse({})).toEqual({ exitCode: 0 });
    expect(cursorProvider.nativeTelemetry).toBeUndefined();
  });

  it('accepts --agent cursor as an AgentWatch-owned hook command', () => {
    expect(isAgentWatchHookCommand('agentwatch hook --agent cursor')).toBe(true);
    expect(isAgentWatchHookCommand('agentwatch hook --agent windsurf')).toBe(false);
  });
});

describe('Cursor provider files', () => {
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
      expect((await detectCursor(world.env)).detected).toBe(false);
    });

    it('detects via ~/.cursor directory and reports installed hooks', async () => {
      await fs.mkdir(path.join(world.home, '.cursor'), { recursive: true });
      const before = await detectCursor(world.env);

      expect(before.detected).toBe(true);
      expect(before.hooksInstalled).toBe(false);
      await installCursorHooks(setupContext());
      expect((await detectCursor(world.env)).hooksInstalled).toBe(true);
    });
  });

  describe('hook installation', () => {
    it('writes version 1 and an entry for every registered event', async () => {
      const outcome = await installCursorHooks(setupContext());

      expect(outcome.ok).toBe(true);
      const file = await readJson(cursorHooksJsonPath(world.env));

      expect(file.version).toBe(1);

      for (const eventName of CURSOR_HOOK_EVENTS) {
        expect(file.hooks[eventName]).toEqual([{ command: HOOK_CMD, timeout: 30 }]);
      }

      expect(file.hooks['beforeTabFileRead']).toBeUndefined();
    });

    it('preserves user entries and is idempotent', async () => {
      const hooksPath = cursorHooksJsonPath(world.env);

      await writeJson(hooksPath, { version: 1, hooks: { stop: [{ command: 'my-notifier' }] } });
      await installCursorHooks(setupContext());
      const first = await fs.readFile(hooksPath, 'utf8');
      const second = await installCursorHooks(setupContext());

      expect(second.changed).toBe(false);
      expect(await fs.readFile(hooksPath, 'utf8')).toBe(first);
      const file = JSON.parse(first);

      expect(file.hooks.stop[0].command).toBe('my-notifier');
      expect(file.hooks.stop).toHaveLength(2);
    });

    it('refuses an unparseable hooks.json', async () => {
      const hooksPath = cursorHooksJsonPath(world.env);

      await fs.mkdir(path.dirname(hooksPath), { recursive: true });
      await fs.writeFile(hooksPath, '{broken');
      const outcome = await installCursorHooks(setupContext());

      expect(outcome.ok).toBe(false);
      expect(await fs.readFile(hooksPath, 'utf8')).toBe('{broken');
    });

    it('sweeps our entries out of events no longer registered', async () => {
      const hooksPath = cursorHooksJsonPath(world.env);

      await writeJson(hooksPath, { version: 1, hooks: { beforeTabFileRead: [{ command: HOOK_CMD, timeout: 30 }] } });
      await installCursorHooks(setupContext());
      const file = await readJson(cursorHooksJsonPath(world.env));

      expect(file.hooks['beforeTabFileRead']).toBeUndefined();
    });
  });

  describe('hook uninstall', () => {
    it('removes only AgentWatch entries and preserves version', async () => {
      const hooksPath = cursorHooksJsonPath(world.env);

      await writeJson(hooksPath, { version: 1, hooks: { stop: [{ command: 'notify-send done' }] } });
      const setup = setupContext();

      await installCursorHooks(setup);
      const outcome = await uninstallCursorHooks(setup);

      expect(outcome.changed).toBe(true);
      const file = await readJson(hooksPath);

      expect(file.version).toBe(1);
      expect(file.hooks.stop).toEqual([{ command: 'notify-send done' }]);
      expect(JSON.stringify(file)).not.toContain('agentwatch');
    });
  });

  describe('transcript reader', () => {
    async function writeTranscript(lines: unknown[]): Promise<string> {
      const file = path.join(world.home, 'cursor-transcript.jsonl');

      await fs.writeFile(file, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));

      return file;
    }

    it("returns undefined for today's usage-less Cursor transcript format", async () => {
      const file = await writeTranscript([
        { role: 'user', message: { content: [{ type: 'text', text: 'do the thing' }] } },
        { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } }] } },
        'not json'
      ]);

      expect(await readCursorTurnUsage(file)).toBeUndefined();
    });

    it('bails out immediately on a usage-less transcript instead of paying the settle loop', async () => {
      // Regression: the 6×250 ms retry/settle loop added ~1.25 s to EVERY
      // Cursor Stop although today's format never contains usage.
      const file = await writeTranscript([{ role: 'assistant', message: { content: [] } }]);
      const startedAt = Date.now();
      const usage = await readCursorTurnUsage(file, { attempts: 6, delayMs: 250, minSettleMs: 500 });

      expect(usage).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(200);
    });

    it('picks up usage, dedupes by message id and reports the dominant model once Cursor adds them', async () => {
      const file = await writeTranscript([
        { role: 'assistant', message: { id: 'm1', model: 'gpt-5.2', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } } },
        // Duplicate line for the same message: must not double-count.
        { role: 'assistant', message: { id: 'm1', model: 'gpt-5.2', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } } },
        // Row-level usage variant with a tiny side-model: must not win the model.
        { role: 'assistant', model: 'gpt-5.2-mini', usage: { input_tokens: 5, output_tokens: 1 } }
      ]);
      const usage = await readCursorTurnUsage(file);

      expect(usage!.inputTokens).toBe(105);
      expect(usage!.outputTokens).toBe(21);
      expect(usage!.cachedInputTokens).toBe(50);
      expect(usage!.model).toBe('gpt-5.2');
      expect(usage!.messageIds).toHaveLength(2);
    });

    it('never re-counts messages already claimed by another turn', async () => {
      const file = await writeTranscript([
        { role: 'assistant', message: { id: 'm1', usage: { input_tokens: 100 } } },
        { role: 'assistant', message: { id: 'm2', usage: { input_tokens: 30 } } }
      ]);
      const usage = await readCursorTurnUsage(file, undefined, new Set(['m1']));

      expect(usage!.inputTokens).toBe(30);
      expect(usage!.messageIds).toEqual(['m2']);
    });

    it('returns undefined when the transcript is missing', async () => {
      expect(await readCursorTurnUsage(path.join(world.home, 'nope.jsonl'))).toBeUndefined();
    });
  });

  describe('turn tracking through the hook pipeline', () => {
    async function hookRun(payload: Record<string, unknown>): Promise<{ events: any[] }> {
      const paths = resolvePaths(world.env);
      const before = new Set(await fs.readdir(paths.queueDir).catch(() => []));
      const code = await runHook('cursor', { env: world.env, input: JSON.stringify(payload) });

      expect(code).toBe(0);
      const added = (await fs.readdir(paths.queueDir).catch(() => [])).filter((name) => !before.has(name));
      const events = await Promise.all(
        added.map(async (name) => JSON.parse(await fs.readFile(path.join(paths.queueDir, name), 'utf8')).event)
      );

      return { events };
    }

    it('closes a Cursor turn with prompt, tools and the afterAgentResponse text, pending usage', async () => {
      const paths = resolvePaths(world.env);

      await writeJson(paths.configFile, {
        ...defaultConfig(),
        developerEmail: 'dev@company.com',
        capture: { ...defaultConfig().capture, prompts: true, responses: true }
      });
      // Today's Cursor transcript format: no usage anywhere.
      const transcript = path.join(world.home, 'cursor-transcript.jsonl');

      await fs.writeFile(transcript, JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }));

      const base = { conversation_id: 'conv-t', generation_id: 'gen-t', model: 'gpt-5.2', transcript_path: transcript, cwd: world.home };

      await hookRun({ ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'fix the refund bug' });
      await hookRun({ ...base, hook_event_name: 'afterFileEdit', file_path: path.join(world.home, 'src/refund.ts') });
      await hookRun({ ...base, hook_event_name: 'afterAgentResponse', text: 'Fixed the refund bug.' });
      const result = await hookRun({ ...base, hook_event_name: 'stop', status: 'completed' });

      const summary = result.events.find((event: any) => event.event.type === 'turn.summary');

      expect(summary).toBeDefined();
      expect(summary.provider).toBe('cursor');
      expect(summary.surface).toBe('ide');
      expect(summary.session_id).toBe('conv-t');
      expect(summary.turn_id).toBe('gen-t');
      expect(summary.developer_id).toBe('dev@company.com');
      expect(summary.prompt).toBe('fix the refund bug');
      // Cursor's stop has no response text; it comes from afterAgentResponse.
      expect(summary.response).toBe('Fixed the refund bug.');
      expect(summary.files_touched).toEqual(['refund.ts']);
      expect(summary.model).toBe('gpt-5.2');
      // No usage source exists for Cursor today: stays pending for the backend.
      expect(summary.input_tokens).toBeUndefined();
      expect(summary.usage_status).toBe('pending');

      // The turn is consumed: a repeated stop emits no duplicate summary.
      const again = await hookRun({ ...base, hook_event_name: 'stop', status: 'completed' });

      expect(again.events.some((event: any) => event.event.type === 'turn.summary')).toBe(false);
    });
  });
});
