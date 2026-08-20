/**
 * Tool-name vocabularies, as O(1) sets.
 *
 * `run_command`, `edit_file` and `write_to_file` are Antigravity's names, read
 * off the tool schemas in the `agy` binary. A name no set lists falls through
 * to 'other' -> tool.completed, which is accurate rather than guessed.
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'run_command']);
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
