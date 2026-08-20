import { describe, expect, it } from 'vitest';
import { parseClaudeHookEvent } from '../src/providers/claude/claude.adapter.js';
import { parseCodexHookEvent } from '../src/providers/codex/codex.adapter.js';
import { defaultConfig } from '../src/config/config.js';
import type { HookContext } from '../src/providers/provider.js';
import { realEnv } from '../src/core/env.js';
import * as claude from './fixtures/claude.js';
import * as codex from './fixtures/codex.js';

function context(overrides: Partial<ReturnType<typeof defaultConfig>['capture']> = {}): HookContext {
  const config = defaultConfig();

  config.capture = { ...config.capture, ...overrides };

  return { env: realEnv(), config };
}

describe('Claude adapter', () => {
  it('maps SessionStart to session.started with model', () => {
    const [event] = parseClaudeHookEvent(claude.claudeSessionStart, context());

    expect(event!.event.type).toBe('session.started');
    expect(event!.event.providerEventType).toBe('SessionStart');
    expect(event!.agent).toEqual({ provider: 'claude', name: 'Claude Code' });
    expect(event!.session.id).toBe(claude.claudeSessionStart.session_id);
    expect(event!.session.providerId).toBe(claude.claudeSessionStart.session_id);
    expect(event!.ai?.model).toBe('claude-sonnet-5');
  });

  it('excludes prompt text when capture.prompts is off but keeps length+hash evidence', () => {
    const [event] = parseClaudeHookEvent(claude.claudeUserPromptSubmit, context({ prompts: false }));
    const json = JSON.stringify(event);

    expect(event!.event.type).toBe('prompt.submitted');
    expect(json).not.toContain('Refactor the auth middleware');
    const prompt = event!.metadata?.['prompt'] as { length: number; sha256: string };

    expect(prompt.length).toBe(claude.claudeUserPromptSubmit.prompt.length);
    expect(prompt.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes prompt text by default', () => {
    const [event] = parseClaudeHookEvent(claude.claudeUserPromptSubmit, context());

    expect(event!.metadata?.['promptText']).toContain('Refactor the auth middleware');
  });

  it('carries prompt_id as the turn id on every event of the turn', () => {
    const [prompt] = parseClaudeHookEvent(claude.claudeUserPromptSubmit, context());

    expect(prompt!.session.turnId).toBe(claude.claudeUserPromptSubmit.prompt_id);
    const [tool] = parseClaudeHookEvent(claude.claudePostToolUseEdit, context());

    expect(tool!.session.turnId).toBe(claude.claudePostToolUseEdit.prompt_id);
    const [stop] = parseClaudeHookEvent(claude.claudeStop, context());

    expect(stop!.session.turnId).toBe(claude.claudeStop.prompt_id);
  });

  it('classifies Bash as shell.started and hides the command when capture.toolInput is off', () => {
    const [event] = parseClaudeHookEvent(claude.claudePreToolUseBash, context({ toolInput: false }));

    expect(event!.event.type).toBe('shell.started');
    expect(event!.tool?.name).toBe('Bash');
    expect(JSON.stringify(event)).not.toContain('npm test');
  });

  it('includes shell command by default', () => {
    const [event] = parseClaudeHookEvent(claude.claudePreToolUseBash, context());

    expect(event!.metadata?.['command']).toBe('npm test');
  });

  it('maps Edit PostToolUse to file.edited with the file path', () => {
    const [event] = parseClaudeHookEvent(claude.claudePostToolUseEdit, context({ toolInput: false }));

    expect(event!.event.type).toBe('file.edited');
    expect(event!.metadata?.['filePath']).toBe('/Users/dev/acme/src/auth/middleware.ts');
    expect(JSON.stringify(event)).not.toContain('old_string');
  });

  it('capture.files=false drops per-file paths, not just Git changedFiles', () => {
    const [event] = parseClaudeHookEvent(claude.claudePostToolUseEdit, context({ files: false, toolInput: false }));

    expect(event!.event.type).toBe('file.edited');
    expect(event!.metadata?.['filePath']).toBeUndefined();
  });

  it('parses MCP tool names into server/tool', () => {
    const [event] = parseClaudeHookEvent(claude.claudePostToolUseMcp, context());

    expect(event!.event.type).toBe('mcp.completed');
    const provider = event!.metadata?.['provider'] as Record<string, unknown>;

    expect(provider['mcpServer']).toBe('linear');
    expect(provider['mcpTool']).toBe('create_issue');
  });

  it('maps failures to tool.failed with hashed error evidence', () => {
    const [event] = parseClaudeHookEvent(claude.claudePostToolUseFailure, context({ toolInput: false, toolOutput: false }));

    expect(event!.event.type).toBe('tool.failed');
    expect(event!.tool?.status).toBe('failed');
    expect(JSON.stringify(event)).not.toContain('Command failed');
  });

  it('maps Stop to generation.completed without response text when capture.responses is off', () => {
    const [event] = parseClaudeHookEvent(claude.claudeStop, context({ responses: false }));

    expect(event!.event.type).toBe('generation.completed');
    expect(JSON.stringify(event)).not.toContain('refactored the middleware');
  });

  it('preserves unknown event types as agent.other', () => {
    const [event] = parseClaudeHookEvent(claude.claudeUnknownEvent, context());

    expect(event!.event.type).toBe('agent.other');
    expect(event!.event.providerEventType).toBe('PostToolBatch');
  });

  it('never throws on malformed payloads', () => {
    expect(parseClaudeHookEvent(null, context())).toEqual([]);
    expect(parseClaudeHookEvent('garbage', context())).toEqual([]);
    expect(parseClaudeHookEvent(42, context())).toEqual([]);
    expect(parseClaudeHookEvent({ hook_event_name: 12345 }, context())).toEqual([]);
    expect(parseClaudeHookEvent({}, context())).toHaveLength(1);
  });

  it('derives stable ids for identical payloads and distinct ids per tool use', () => {
    const [a] = parseClaudeHookEvent(claude.claudePreToolUseBash, context());
    const [b] = parseClaudeHookEvent(claude.claudePreToolUseBash, context());
    const [c] = parseClaudeHookEvent({ ...claude.claudePreToolUseBash, tool_use_id: 'other' }, context());

    expect(a!.id).toBe(b!.id);
    expect(a!.id).not.toBe(c!.id);
  });
});

describe('Codex adapter', () => {
  it('maps SessionStart with session/thread id and model', () => {
    const [event] = parseCodexHookEvent(codex.codexSessionStart, context());

    expect(event!.event.type).toBe('session.started');
    expect(event!.agent.provider).toBe('codex');
    expect(event!.session.id).toBe(codex.codexSessionStart.session_id);
    expect(event!.ai?.model).toBe('gpt-5.2-codex');
    expect(event!.ai?.billingMode).toBe('unknown');
  });

  it('carries turn ids for correlation', () => {
    const [event] = parseCodexHookEvent(codex.codexUserPromptSubmit, context());

    expect(event!.session.turnId).toBe('turn-42');
  });

  it('classifies the shell tool and apply_patch', () => {
    const [pre] = parseCodexHookEvent(codex.codexPreToolUseShell, context());

    expect(pre!.event.type).toBe('shell.started');
    const [post] = parseCodexHookEvent(codex.codexPostToolUseShell, context());

    expect(post!.event.type).toBe('shell.completed');
    const [patch] = parseCodexHookEvent(codex.codexPostToolUseApplyPatch, context());

    expect(patch!.event.type).toBe('file.edited');
    expect(patch!.metadata?.['filePath']).toBe('/Users/dev/acme/src/users.ts');
  });

  it('excludes prompt and tool output when capture is off', () => {
    const off = { prompts: false, toolInput: false, toolOutput: false };
    const [prompt] = parseCodexHookEvent(codex.codexUserPromptSubmit, context(off));

    expect(JSON.stringify(prompt)).not.toContain('pagination');
    const [post] = parseCodexHookEvent(codex.codexPostToolUseShell, context(off));

    expect(JSON.stringify(post)).not.toContain('package.json');
  });

  it('accepts thread_id as a session id fallback', () => {
    const [event] = parseCodexHookEvent({ hook_event_name: 'Stop', thread_id: 'tid-1' }, context());

    expect(event!.session.id).toBe('tid-1');
  });

  it('never throws on malformed payloads', () => {
    expect(parseCodexHookEvent(undefined, context())).toEqual([]);
    expect(parseCodexHookEvent([], context())).toEqual([]);
    expect(parseCodexHookEvent({ tool_input: { weird: { deeply: [1, 2, 3] } } }, context())).toHaveLength(1);
  });
});
