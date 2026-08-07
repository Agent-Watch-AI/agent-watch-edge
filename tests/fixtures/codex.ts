/** Realistic Codex hook payloads (shape per openai/codex hook schemas, 2026-08). */

const common = {
  session_id: '0199a213-e29b-41d4-a716-446655440000',
  turn_id: 'turn-42',
  cwd: '/Users/dev/acme',
  transcript_path: '/Users/dev/.codex/sessions/2026/08/07/rollout-2026-08-07T10-00-00-0199a213.jsonl',
  model: 'gpt-5.2-codex',
  permission_mode: 'default'
};

export const codexSessionStart = {
  session_id: common.session_id,
  cwd: common.cwd,
  transcript_path: common.transcript_path,
  model: common.model,
  permission_mode: common.permission_mode,
  hook_event_name: 'SessionStart',
  source: 'startup'
};

export const codexUserPromptSubmit = {
  ...common,
  hook_event_name: 'UserPromptSubmit',
  prompt: 'Add pagination to the users endpoint'
};

export const codexPreToolUseShell = {
  ...common,
  hook_event_name: 'PreToolUse',
  tool_name: 'shell',
  tool_use_id: 'call_abc123',
  tool_input: { command: ['bash', '-lc', 'ls'] }
};

export const codexPostToolUseShell = {
  ...common,
  hook_event_name: 'PostToolUse',
  tool_name: 'shell',
  tool_use_id: 'call_abc123',
  tool_input: { command: ['bash', '-lc', 'ls'] },
  tool_response: { exit_code: 0, output: 'src\npackage.json' }
};

export const codexPostToolUseApplyPatch = {
  ...common,
  hook_event_name: 'PostToolUse',
  tool_name: 'apply_patch',
  tool_use_id: 'call_patch9',
  tool_input: { file_path: '/Users/dev/acme/src/users.ts' },
  tool_response: { success: true }
};

export const codexStop = {
  ...common,
  hook_event_name: 'Stop',
  last_assistant_message: 'Pagination added with cursor-based paging.',
  stop_hook_active: false
};

export const codexSessionEnd = {
  session_id: common.session_id,
  cwd: common.cwd,
  transcript_path: common.transcript_path,
  hook_event_name: 'SessionEnd',
  reason: 'exit'
};
