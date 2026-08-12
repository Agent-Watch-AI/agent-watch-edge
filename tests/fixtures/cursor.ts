/** Cursor hook payload fixtures, shaped per cursor.com/docs/hooks (2026-08). */

const universal = {
  conversation_id: 'conv-1',
  generation_id: 'gen-1',
  model: 'gpt-5.2',
  cursor_version: '1.7.2',
  workspace_roots: ['/work/project'],
  transcript_path: '/tmp/cursor-transcript.jsonl'
};

export const cursorSessionStart = {
  ...universal,
  hook_event_name: 'sessionStart',
  session_id: 'conv-1',
  is_background_agent: false,
  composer_mode: 'agent'
};

export const cursorSessionEnd = {
  ...universal,
  hook_event_name: 'sessionEnd',
  session_id: 'conv-1',
  reason: 'completed',
  duration_ms: 45000
};

export const cursorBeforeSubmitPrompt = {
  ...universal,
  hook_event_name: 'beforeSubmitPrompt',
  prompt: 'Refactor the auth middleware to use JWT',
  attachments: [{ type: 'file', file_path: '/work/project/src/auth.ts' }]
};

export const cursorPreToolUseShell = {
  ...universal,
  hook_event_name: 'preToolUse',
  tool_name: 'Shell',
  tool_input: { command: 'npm test', working_directory: '/work/project' },
  tool_use_id: 'tool-1',
  cwd: '/work/project'
};

export const cursorPostToolUseRead = {
  ...universal,
  hook_event_name: 'postToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '/work/project/src/auth.ts' },
  tool_output: '"file contents"',
  tool_use_id: 'tool-2',
  cwd: '/work/project',
  duration: 12
};

export const cursorPostToolUseFailure = {
  ...universal,
  hook_event_name: 'postToolUseFailure',
  tool_name: 'Shell',
  tool_input: { command: 'npm test' },
  tool_use_id: 'tool-3',
  error_message: 'command timed out',
  failure_type: 'timeout',
  duration: 5000,
  is_interrupt: false
};

export const cursorBeforeShellExecution = {
  ...universal,
  hook_event_name: 'beforeShellExecution',
  command: 'git status --porcelain',
  cwd: '/work/project',
  sandbox: false
};

export const cursorAfterShellExecution = {
  ...universal,
  hook_event_name: 'afterShellExecution',
  command: 'git status --porcelain',
  output: ' M src/auth.ts',
  duration: 80,
  sandbox: false
};

export const cursorBeforeMCPExecution = {
  ...universal,
  hook_event_name: 'beforeMCPExecution',
  tool_name: 'search_issues',
  tool_input: '{"query":"auth bug"}',
  url: 'https://mcp.linear.app/sse'
};

export const cursorAfterMCPExecution = {
  ...universal,
  hook_event_name: 'afterMCPExecution',
  tool_name: 'search_issues',
  tool_input: '{"query":"auth bug"}',
  result_json: '{"issues":[]}',
  duration: 230
};

export const cursorBeforeReadFile = {
  ...universal,
  hook_event_name: 'beforeReadFile',
  file_path: '/work/project/src/secrets.ts',
  content: 'const API_KEY = "sk-super-secret";',
  attachments: []
};

export const cursorAfterFileEdit = {
  ...universal,
  hook_event_name: 'afterFileEdit',
  file_path: '/work/project/src/auth.ts',
  edits: [{ old_string: 'const a = 1;', new_string: 'const a = 2;' }]
};

export const cursorAfterTabFileEdit = {
  hook_event_name: 'afterTabFileEdit',
  cursor_version: '1.7.2',
  workspace_roots: ['/work/project'],
  file_path: '/work/project/src/tab.ts',
  edits: [{ old_string: 'x', new_string: 'y', old_line: 'x', new_line: 'y' }]
};

export const cursorSubagentStart = {
  ...universal,
  hook_event_name: 'subagentStart',
  subagent_id: 'sub-9',
  subagent_type: 'explore',
  task: 'Find all usages of authMiddleware',
  parent_conversation_id: 'conv-1',
  tool_call_id: 'tool-4',
  subagent_model: 'gpt-5.2-mini',
  is_parallel_worker: false
};

export const cursorSubagentStop = {
  ...universal,
  hook_event_name: 'subagentStop',
  subagent_id: 'sub-9',
  subagent_type: 'explore',
  status: 'completed',
  task: 'Find all usages of authMiddleware',
  summary: 'Found 3 usages',
  duration_ms: 4500,
  message_count: 4,
  tool_call_count: 3,
  modified_files: []
};

export const cursorPreCompact = {
  ...universal,
  hook_event_name: 'preCompact',
  trigger: 'auto',
  context_usage_percent: 85,
  context_tokens: 120000,
  context_window_size: 128000
};

export const cursorAfterAgentResponse = {
  ...universal,
  hook_event_name: 'afterAgentResponse',
  text: 'I refactored the middleware to verify JWTs.'
};

export const cursorStop = {
  ...universal,
  hook_event_name: 'stop',
  status: 'completed',
  loop_count: 0
};
