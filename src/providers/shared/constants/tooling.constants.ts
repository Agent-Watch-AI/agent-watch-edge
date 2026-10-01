/**
 * Tool-name vocabularies, as O(1) sets.
 *
 * `run_command`, `edit_file` and `write_to_file` are Antigravity's names, read
 * off the tool schemas in the `agy` binary. `run_shell_command` is Gemini CLI's
 * (`SHELL_TOOL_NAME` in gemini-cli `packages/core/src/tools/definitions/base-declarations.ts`).
 * Cursor's hooks call their shell tool `Shell` (cursor.com/docs/hooks), which
 * `CURSOR_TOOL_KINDS` maps. A name no set lists falls through to 'other' ->
 * tool.completed, which is accurate rather than guessed.
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'run_command', 'run_shell_command']);
export const FILE_READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'read_file', 'view_image']);
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'edit_file', 'write_to_file']);

/** Prefix and separator of an MCP tool name. */
export const MCP_TOOL_PREFIX = 'mcp__';
export const MCP_TOOL_SEPARATOR = '__';

/**
 * Keys a file path may arrive under, in priority order.
 *
 * Antigravity's tool arguments are PascalCase (`TargetFile`); every other
 * provider uses snake_case or camelCase.
 */
export const FILE_PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'TargetFile', 'AbsolutePath'] as const;

/**
 * Keys a shell command may arrive under, in priority order. `CommandLine` is
 * Antigravity's name for it (`run_command`); everything else uses `command`.
 */
export const COMMAND_KEYS = ['CommandLine', 'command'] as const;

/** Where Codex and Gemini put the command in a shell call's `tool_input`. */
export const SHELL_COMMAND_KEY = 'command';

/**
 * A block the agent's harness injected into the prompt, not something the
 * developer typed. Claude Desktop prepends a `<system-reminder>` of ~2,000
 * characters to a session's first prompt; sent as prompt text it would bury the
 * person's words under the harness's. Only a closed block is a harness block:
 * the text is stripped before any bound, so the harness's own are always whole,
 * and an unclosed tag the person pasted keeps everything after it.
 * ponytail: each unclosed tag scans to the end, quadratic only in a prompt
 * stuffed with them; the agent bounds the prompt before the hook sees it.
 */
export const RE_HARNESS_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
