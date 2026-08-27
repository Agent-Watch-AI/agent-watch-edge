import type { CanonicalEventType } from '../../../events/types/events.types.js';

export const GEMINI_PROVIDER_ID = 'gemini';
export const GEMINI_DISPLAY_NAME = 'Gemini CLI';

export const GEMINI_HOME_VAR = 'GEMINI_HOME';
export const GEMINI_CLI_VAR = 'GEMINI_CLI';
export const GEMINI_HOME_DIR = '.gemini';
export const GEMINI_SETTINGS_FILE = 'settings.json';
export const GEMINI_EXECUTABLES = ['gemini', 'gemini-cli'] as const;

/** Hook events AgentWatch registers in Gemini CLI. */
export const GEMINI_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool', 'Notification', 'PreCompress'] as const;

/** Events that take a matcher; "*" observes everything. */
export const GEMINI_MATCHED_EVENTS: ReadonlySet<string> = new Set(['BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool', 'Notification', 'PreCompress']);

/**
 * Gemini CLI reads this field as MILLISECONDS (its own default is 60,000).
 *
 * A bare `30` here made every AgentWatch hook time out before node could
 * start. The same unit applies in antigravity.hooks.ts — it is the same Google
 * hook runner.
 */
export const GEMINI_HOOK_TIMEOUT_MILLISECONDS = 30_000;

/** Provider hook name to canonical event type, where the mapping is direct. */
export const GEMINI_EVENT_TYPE_MAP: Readonly<Record<string, CanonicalEventType>> = {
  SessionStart: 'session.started',
  SessionEnd: 'session.ended',
  // Current Gemini CLI hook names.
  BeforeAgent: 'prompt.submitted',
  AfterAgent: 'generation.completed',
  PreCompress: 'compaction.started',
  // Kept for payload compatibility with old installations; new registrations
  // use the names above.
  UserPromptSubmit: 'prompt.submitted',
  PermissionRequest: 'permission.requested',
  Stop: 'generation.completed',
  SubagentStart: 'subagent.started',
  SubagentStop: 'subagent.completed',
  PreCompact: 'compaction.started',
  PostCompact: 'compaction.completed'
};

/**
 * Hooks reporting a prompt, across old and new naming. Also the gate a budget
 * refusal travels on — see the provider's `getBlockResponse`.
 */
export const GEMINI_PROMPT_EVENTS: ReadonlySet<string> = new Set(['BeforeAgent', 'UserPromptSubmit']);

/** Hooks reporting a completed generation, across old and new naming. */
export const GEMINI_STOP_EVENTS: ReadonlySet<string> = new Set(['AfterAgent', 'Stop']);

/** Hooks whose canonical type depends on which tool ran. */
export const GEMINI_TOOL_EVENTS: ReadonlySet<string> = new Set([
  'BeforeTool',
  'AfterTool',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest'
]);

/** Tool hooks that report a start rather than a completion. */
export const GEMINI_TOOL_START_EVENTS: ReadonlySet<string> = new Set(['BeforeTool', 'PreToolUse', 'PermissionRequest']);

/** Tool hooks that report a completion. */
export const GEMINI_TOOL_COMPLETE_EVENTS: ReadonlySet<string> = new Set(['AfterTool', 'PostToolUse', 'PostToolUseFailure']);

export const GEMINI_UNKNOWN_EVENT = 'unknown';
