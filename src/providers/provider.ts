import {
  HOOK_COMMAND_MARKER,
  KNOWN_AGENT_IDS,
  RE_AGENTWATCH_BINARY,
  RE_CLI_SCRIPT,
  RE_DOUBLE_QUOTE_ESCAPABLE,
  RE_NODE_BINARY,
  RE_PATH_SEPARATOR,
  RE_SHELL_CONTROL,
  RE_WHITESPACE
} from './constants/provider.constants.js';

export { HOOK_COMMAND_MARKER } from './constants/provider.constants.js';
export type {
  AgentProvider,
  DetectionResult,
  HookContext,
  McpToolName,
  NativeTelemetryConfigurator,
  NativeTelemetryStatus,
  ProviderHookResponse,
  SetupContext,
  SetupOutcome,
  ToolKind,
  ToolStatus
} from './types/provider.types.js';

/**
 * Whether a hook command registered in an agent's config is ours.
 *
 * Ownership decides what uninstall is allowed to delete, so the test is
 * deliberately narrow: the executable invoked before `hook --agent` must
 * actually be the agentwatch CLI — a binary named `agentwatch`, or the
 * generated `dist/cli.js` run via node — the agent id must be one we support,
 * and nothing may follow. A user's `my-agentwatch-notifier hook --agent x`, or
 * a compound `echo agentwatch && my-tool hook --agent x`, must never be claimed.
 *
 * @param command - The command line found in the agent's config.
 * @returns True only when AgentWatch wrote it.
 */
export function isAgentWatchHookCommand(command: string): boolean {
  const tokens = tokenizeHookCommand(command);

  if (!tokens) return false;

  const hookIndex = tokens.indexOf('hook');

  if (hookIndex < 1 || tokens[hookIndex + 1] !== '--agent') return false;

  if (!KNOWN_AGENT_IDS.has(tokens[hookIndex + 2] ?? '')) return false;

  // Installed commands carry no trailing shell fragments or extra argv.
  if (hookIndex + 3 !== tokens.length) return false;

  return isOurExecutable(tokens.slice(0, hookIndex));
}

/**
 * Whether the tokens before `hook` name the agentwatch CLI.
 *
 * @param prefix - Tokens preceding the subcommand.
 * @returns True for `agentwatch` or `<node> <cli script>`.
 */
function isOurExecutable(prefix: readonly string[]): boolean {
  if (prefix.length === 1) return isAgentWatchBinary(prefix[0]!);

  if (prefix.length === 2) return isNodeBinary(prefix[0]!) && isAgentWatchCliScript(prefix[1]!);

  return false;
}

/**
 * Whether a path names the installed agentwatch binary.
 *
 * @param value - Executable path or bare name.
 * @returns True when its basename is ours.
 */
function isAgentWatchBinary(value: string): boolean {
  return RE_AGENTWATCH_BINARY.test(pathBase(value).toLowerCase());
}

/**
 * Whether a path names a Node-compatible runtime.
 *
 * @param value - Executable path or bare name.
 * @returns True when it is one we may have embedded.
 */
function isNodeBinary(value: string): boolean {
  return RE_NODE_BINARY.test(pathBase(value));
}

/**
 * Whether a path is the agentwatch CLI entry script.
 *
 * `dist/cli.js` is accepted on its own — that exact suffix is what
 * buildHookCommand emits, and the parent directory need not carry the package
 * name (a renamed checkout). A dev install running the TypeScript entry point
 * directly must additionally have the package name somewhere in its path, so a
 * foreign tool's `cli.ts` is never claimed as ours.
 *
 * @param value - Script path.
 * @returns True when it is our entry point.
 */
function isAgentWatchCliScript(value: string): boolean {
  const segments = value.split(RE_PATH_SEPARATOR).filter(Boolean);

  if (segments.length < 2) return false;

  const lower = segments.map((segment) => segment.toLowerCase());
  const basename = lower.at(-1)!;

  if (basename === 'cli.js' && lower.at(-2) === 'dist') return true;

  return RE_CLI_SCRIPT.test(basename) && lower.some((segment) => segment.includes(HOOK_COMMAND_MARKER));
}

/**
 * Last path segment of a path using either platform's separator.
 *
 * @param value - The path.
 * @returns Its basename.
 */
function pathBase(value: string): string {
  return value.split(RE_PATH_SEPARATOR).pop() ?? '';
}

/**
 * Minimal tokenizer for the exact commands buildHookCommand emits.
 *
 * Supports quoted paths and their escaped quote/backslash forms, and rejects
 * any command containing a shell control operator — a command we cannot fully
 * understand is one we must not claim ownership of.
 *
 * @param command - The command line.
 * @returns Its tokens, or undefined when the command is not one we emit.
 */
function tokenizeHookCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;

    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }

      // Inside double quotes a backslash still escapes the shell's own
      // specials; inside single quotes it is a literal character.
      if (quote === '"' && char === '\\' && index + 1 < command.length && RE_DOUBLE_QUOTE_ESCAPABLE.test(command[index + 1]!)) {
        token += command[++index]!;
        started = true;
        continue;
      }

      token += char;
      started = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (RE_WHITESPACE.test(char)) {
      if (started) tokens.push(token);

      token = '';
      started = false;
      continue;
    }

    // A command we cannot fully understand is one we must not claim.
    if (RE_SHELL_CONTROL.test(char)) return undefined;

    token += char;
    started = true;
  }

  // An unterminated quote means the command is not one we wrote.
  if (quote) return undefined;

  if (started) tokens.push(token);

  return tokens;
}
