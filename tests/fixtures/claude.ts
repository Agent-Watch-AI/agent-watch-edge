/** Realistic Claude Code hook payloads (shape per code.claude.com/docs/en/hooks, 2026-08). */

const common = {
  session_id: 'a2f1c9e0-5b7d-4c1e-9f3a-8d2b6c4e0a11',
  prompt_id: 'prompt-0193f2',
  transcript_path: '/Users/dev/.claude/projects/-Users-dev-acme/a2f1c9e0.jsonl',
  cwd: '/Users/dev/acme',
  permission_mode: 'default'
};

export const claudeSessionStart = {
  ...common,
  hook_event_name: 'SessionStart',
  source: 'startup',
  model: 'claude-sonnet-5'
};

export const claudeUserPromptSubmit = {
  ...common,
  hook_event_name: 'UserPromptSubmit',
  prompt: 'Refactor the auth middleware and add tests. My key is sk-abc1234567890abcdef too.'
};

export const claudePreToolUseBash = {
  ...common,
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_use_id: 'toolu_01AbCdEfGh',
  tool_input: { command: 'npm test', description: 'Run tests' }
};

export const claudePostToolUseEdit = {
  ...common,
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_use_id: 'toolu_02XyZ',
  tool_input: { file_path: '/Users/dev/acme/src/auth/middleware.ts', old_string: 'a', new_string: 'b' },
  tool_response: { success: true }
};

export const claudePostToolUseMcp = {
  ...common,
  hook_event_name: 'PostToolUse',
  tool_name: 'mcp__linear__create_issue',
  tool_use_id: 'toolu_03Mcp',
  tool_input: { title: 'Bug' },
  tool_response: { id: 'LIN-1' }
};

export const claudePostToolUseFailure = {
  ...common,
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_use_id: 'toolu_04Fail',
  tool_input: { command: 'npm run build' },
  tool_error: 'Command failed with exit code 2'
};

export const claudeStop = {
  ...common,
  hook_event_name: 'Stop',
  stop_hook_active: false,
  last_assistant_message: 'Done. I refactored the middleware and added 4 tests.'
};

export const claudeSubagentStart = {
  ...common,
  hook_event_name: 'SubagentStart',
  agent_id: 'agent-77',
  agent_type: 'general-purpose'
};

export const claudeSessionEnd = {
  ...common,
  hook_event_name: 'SessionEnd',
  reason: 'prompt_input_exit'
};

/** An event type we don't model (arrives if a future setup registers more). */
export const claudeUnknownEvent = {
  ...common,
  hook_event_name: 'PostToolBatch',
  some_new_field: { nested: true }
};
