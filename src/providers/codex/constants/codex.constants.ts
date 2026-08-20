import type { CanonicalEventType } from '../../../events/types/events.types.js';

export const CODEX_PROVIDER_ID = 'codex';
export const CODEX_DISPLAY_NAME = 'OpenAI Codex';

/** Codex's config root, overridable through its own environment variable. */
export const CODEX_HOME_VAR = 'CODEX_HOME';
export const CODEX_HOME_DIR = '.codex';
export const CODEX_HOOKS_FILE = 'hooks.json';
export const CODEX_CONFIG_FILE = 'config.toml';
export const CODEX_EXECUTABLE = 'codex';

/**
 * Codex lifecycle hooks (verified against openai/codex source, 2026-08).
 *
 * File: `~/.codex/hooks.json`. Its top level is strictly
 * `{description?, hooks}` (serde `deny_unknown_fields`), so we must not add any
 * other key. The matcher is optional — absent means match everything. Hooks are
 * enabled by default, but NON-MANAGED HOOKS DO NOT RUN UNTIL THE USER TRUSTS
 * THEM via `/hooks` in the Codex TUI.
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact'
] as const;

/** Codex reads this field as seconds. */
export const CODEX_HOOK_TIMEOUT_SECONDS = 30;

/** The only two top-level keys Codex's parser accepts in hooks.json. */
export const CODEX_ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['description', 'hooks']);

/** Manual step Codex requires before a newly registered hook will run. */
export const CODEX_TRUST_NOTE = 'Codex requires trusting new hooks: run `codex`, then `/hooks`, and trust the AgentWatch entries.';

export const CODEX_HOOKS_DISABLED_WARNING = 'warning: [features] hooks = false in ~/.codex/config.toml — Codex hooks are disabled';

/** Provider hook name to canonical event type, where the mapping is direct. */
export const CODEX_EVENT_TYPE_MAP: Readonly<Record<string, CanonicalEventType>> = {
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
export const CODEX_TOOL_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);

export const CODEX_UNKNOWN_EVENT = 'unknown';
