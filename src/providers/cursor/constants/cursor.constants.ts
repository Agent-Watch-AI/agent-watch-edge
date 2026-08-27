import type { CanonicalEventType } from '../../../events/types/events.types.js';
import type { ToolKind } from '../../types/provider.types.js';

export const CURSOR_PROVIDER_ID = 'cursor';
export const CURSOR_DISPLAY_NAME = 'Cursor';

export const CURSOR_HOME_DIR = '.cursor';
export const CURSOR_HOOKS_FILE = 'hooks.json';
export const CURSOR_EXECUTABLES = ['cursor', 'cursor-agent'] as const;

/**
 * Cursor lifecycle hooks (verified against cursor.com/docs/hooks, 2026-08).
 *
 * File: `~/.cursor/hooks.json`, format
 * `{ version: 1, hooks: { <event>: [entry] } }` — flat command entries per
 * event, no matcher groups. Hooks need no trust step, unlike Codex. Cursor also
 * reads project, team and enterprise hooks.json files; AgentWatch manages only
 * the user-level one.
 *
 * `beforeTabFileRead` is deliberately NOT registered: it fires on every inline
 * completion and carries the full file content — pure noise with a privacy cost.
 * `afterAgentThought` and `workspaceOpen` carry nothing the data model uses.
 */
export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'afterAgentResponse',
  'stop',
  'afterTabFileEdit'
] as const;

/** Cursor reads this field as seconds. */
export const CURSOR_HOOK_TIMEOUT_SECONDS = 30;

/** Cursor's documented hooks.json schema version. */
export const CURSOR_HOOKS_VERSION = 1;
export const CURSOR_VERSION_KEY = 'version';

/** Note surfaced at install time about Cursor's missing token usage. */
export const CURSOR_USAGE_NOTE =
  'note: Cursor transcripts carry no token usage yet — Cursor turn summaries stay usage_status=pending until Cursor enriches them.';

/** Provider hook name to canonical event type, where the mapping is direct. */
export const CURSOR_EVENT_TYPE_MAP: Readonly<Record<string, CanonicalEventType>> = {
  sessionStart: 'session.started',
  sessionEnd: 'session.ended',
  beforeSubmitPrompt: 'prompt.submitted',
  beforeShellExecution: 'shell.started',
  afterShellExecution: 'shell.completed',
  beforeMCPExecution: 'mcp.started',
  afterMCPExecution: 'mcp.completed',
  beforeReadFile: 'file.read',
  afterFileEdit: 'file.edited',
  afterTabFileEdit: 'file.edited',
  subagentStart: 'subagent.started',
  subagentStop: 'subagent.completed',
  preCompact: 'compaction.started',
  afterAgentResponse: 'agent.other',
  stop: 'generation.completed'
};

/**
 * Tool kinds whose completions arrive through Cursor's dedicated hooks.
 *
 * Cursor fires BOTH the generic `postToolUse` and a dedicated hook
 * (afterShellExecution / afterMCPExecution / beforeReadFile / afterFileEdit)
 * for these kinds. The dedicated hooks are the authoritative completion source;
 * mapping the generic duplicate to a completion type as well would count every
 * such call twice in tool_calls and tools_used.
 */
export const CURSOR_DEDICATED_COMPLETION_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(['shell', 'mcp', 'file-read', 'file-edit']);

/** Cursor's own generic tool names, on top of the shared vocabularies. */
export const CURSOR_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  Shell: 'shell',
  MCP: 'mcp',
  Write: 'file-edit'
};

/** Default tool names for the dedicated file hooks, which report none. */
export const CURSOR_READ_TOOL_NAME = 'Read';
export const CURSOR_EDIT_TOOL_NAME = 'Edit';
export const CURSOR_SHELL_TOOL_NAME = 'Shell';

/** Attachment field carrying a file path. */
export const ATTACHMENT_FILE_PATH_KEY = 'file_path';

/**
 * The one hook a budget refusal may travel on.
 *
 * `beforeSubmitPrompt` is the only Cursor hook whose refusal precedes the turn's
 * first request, and it blocks through `continue: false` rather than the
 * `permission` field the tool and shell hooks use (verified against
 * cursor.com/docs, 2026-08). `user_message` is what Cursor shows the developer.
 */
export const CURSOR_PROMPT_SUBMIT_EVENTS: ReadonlySet<string> = new Set(['beforeSubmitPrompt']);

export const CURSOR_UNKNOWN_EVENT = 'unknown';
