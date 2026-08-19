import type { Env } from '../core/env.js';
import type { AgentWatchConfig } from '../config/config.js';
import type { AgentWatchEvent } from '../events/canonical-event.js';
import type { AgentWatchPaths } from '../storage/paths.js';
import type { InstallState } from '../storage/install-state.js';

export interface DetectionResult {
  detected: boolean;
  /** Human-readable reasons, e.g. "~/.claude exists", "claude on PATH". */
  evidence: string[];
  executablePath?: string;
  /** File AgentWatch hooks are (or would be) registered in. */
  hookConfigPath: string;
  hooksInstalled: boolean;
}

export interface SetupContext {
  env: Env;
  paths: AgentWatchPaths;
  config: AgentWatchConfig;
  /** Command line agents will invoke, e.g. "/usr/local/bin/agentwatch hook --agent claude". */
  hookCommand: string;
  /** Mutated in place by install/uninstall; persisted by the caller. */
  installState: InstallState;
}

export interface SetupOutcome {
  ok: boolean;
  changed: boolean;
  /** User-facing notes: required manual steps, skip reasons, errors. */
  messages: string[];
}

export interface HookContext {
  env: Env;
  config: AgentWatchConfig;
}

export interface ProviderHookResponse {
  /** Written verbatim to stdout; omit for protocol-safe silence. */
  stdout?: string;
  exitCode: number;
}

export interface NativeTelemetryStatus {
  supported: boolean;
  /** Configured by AgentWatch. */
  configured: boolean;
  /** Foreign telemetry configuration we refuse to overwrite. */
  conflict?: string;
  detail?: string;
}

export interface NativeTelemetryConfigurator {
  supported(env: Env): Promise<boolean>;
  inspect(context: SetupContext): Promise<NativeTelemetryStatus>;
  configure(context: SetupContext): Promise<SetupOutcome>;
  uninstall(context: SetupContext): Promise<SetupOutcome>;
}

export interface AgentProvider {
  id: string;
  displayName: string;
  detect(env: Env): Promise<DetectionResult>;
  installHooks(context: SetupContext): Promise<SetupOutcome>;
  uninstallHooks(context: SetupContext): Promise<SetupOutcome>;
  parseHookEvent(payload: unknown, context: HookContext): Promise<AgentWatchEvent[]>;
  getHookResponse(payload: unknown): ProviderHookResponse;
  nativeTelemetry?: NativeTelemetryConfigurator;
}

/** Substring identifying AgentWatch-owned hook entries in agent configs. */
export const HOOK_COMMAND_MARKER = 'agentwatch';

/**
 * A hook command is ours only when the executable actually invoked before
 * `hook --agent` is the agentwatch CLI: either a binary named `agentwatch`,
 * or the generated `dist/cli.js` entry point run via node. A user's
 * `my-agentwatch-notifier hook --agent x` or a compound
 * `echo agentwatch && my-tool hook --agent x` must never be claimed
 * (and deleted) as AgentWatch-owned.
 */
export function isAgentWatchHookCommand(command: string): boolean {
  const tokens = tokenizeHookCommand(command);
  if (!tokens) return false;
  const hookIndex = tokens.indexOf('hook');
  if (hookIndex < 1 || tokens[hookIndex + 1] !== '--agent') return false;
  const agent = tokens[hookIndex + 2];
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'cursor' && agent !== 'gemini' && agent !== 'antigravity') return false;
  // Installed commands contain no trailing shell fragments or extra argv.
  if (hookIndex + 3 !== tokens.length) return false;

  const prefix = tokens.slice(0, hookIndex);
  if (prefix.length === 1) return isAgentWatchBinary(prefix[0]!);
  if (prefix.length === 2) return isNodeBinary(prefix[0]!) && isAgentWatchCliScript(prefix[1]!);
  return false;
}

function isAgentWatchBinary(value: string): boolean {
  const base = pathBase(value).toLowerCase();
  return /^(?:agentwatch)(?:\.(?:exe|cmd|ps1|js|cjs|mjs))?$/.test(base);
}

/**
 * buildHookCommand embeds process.execPath, so hooks written by earlier
 * installs may name any Node-compatible runtime — including versioned
 * binaries (node22) and TypeScript runners (tsx, deno). Failing to recognize
 * one would leave the stale hook in place next to a fresh duplicate, and
 * every turn would then be processed (and counted) twice.
 */
function isNodeBinary(value: string): boolean {
  return /^(?:node[\d.]*|nodejs|bun|tsx|deno)(?:\.exe)?$/i.test(pathBase(value));
}

function isAgentWatchCliScript(value: string): boolean {
  const segments = value.split(/[\\/]/).filter(Boolean);
  if (segments.length < 2) return false;
  const lower = segments.map((segment) => segment.toLowerCase());
  // The exact script suffix emitted by buildHookCommand for local or
  // otherwise non-global installs; the parent directory need not contain the
  // package name (for example a renamed checkout).
  if (lower.at(-1) === 'cli.js' && lower.at(-2) === 'dist') return true;
  // Dev installs ran the TypeScript entry point directly. Require the
  // package name somewhere in the path so a foreign tool's cli.ts is never
  // claimed (and deleted) as ours.
  return /^cli\.(?:ts|mts|js|mjs|cjs)$/.test(lower.at(-1)!) && lower.some((segment) => segment.includes('agentwatch'));
}

function pathBase(value: string): string {
  return value.split(/[\\/]/).pop() ?? '';
}

/**
 * Minimal tokenizer for the exact commands buildHookCommand emits. It
 * supports quoted paths and their escaped quote/backslash forms, while
 * rejecting shell control operators anywhere in the command.
 */
function tokenizeHookCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let tokenStarted = false;

  const push = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = '';
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && char === '\\' && index + 1 < command.length && /["\\$`]/.test(command[index + 1]!)) {
        token += command[++index]!;
      } else {
        token += char;
      }
      tokenStarted = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      push();
    } else if (/[|&;<>\r\n]/.test(char)) {
      return undefined;
    } else {
      token += char;
      tokenStarted = true;
    }
  }
  if (quote) return undefined;
  push();
  return tokens;
}
