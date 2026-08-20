import type { CanonicalEventType } from '../../../events/types/events.types.js';

export const CLAUDE_PROVIDER_ID = 'claude';
export const CLAUDE_DISPLAY_NAME = 'Claude Code';

/** Directory and settings file Claude Code reads its configuration from. */
export const CLAUDE_HOME_DIR = '.claude';
export const CLAUDE_SETTINGS_FILE = 'settings.json';
export const CLAUDE_EXECUTABLE = 'claude';

/**
 * Hook events AgentWatch registers in Claude Code.
 *
 * Schema: hooks -> EventName -> [{matcher?, hooks: [{type:"command", command,
 * timeout}]}] (verified against code.claude.com/docs/en/hooks, 2026-08).
 */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop'
] as const;

/** Tool-scoped events take a tool-name matcher; "*" observes every tool. */
export const CLAUDE_MATCHED_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

/** Claude Code reads this field as seconds. */
export const CLAUDE_HOOK_TIMEOUT_SECONDS = 30;

/** Provider hook name to canonical event type, where the mapping is direct. */
export const CLAUDE_EVENT_TYPE_MAP: Readonly<Record<string, CanonicalEventType>> = {
  SessionStart: 'session.started',
  SessionEnd: 'session.ended',
  UserPromptSubmit: 'prompt.submitted',
  PermissionRequest: 'permission.requested',
  Stop: 'generation.completed',
  SubagentStart: 'subagent.started',
  SubagentStop: 'subagent.completed',
  PreCompact: 'compaction.started',
  PostCompact: 'compaction.completed'
};

/** Hooks whose canonical type depends on which tool ran. */
export const CLAUDE_TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

/** Hooks that report a tool call as starting rather than finishing. */
export const CLAUDE_TOOL_START_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PermissionRequest']);

export const CLAUDE_UNKNOWN_EVENT = 'unknown';
