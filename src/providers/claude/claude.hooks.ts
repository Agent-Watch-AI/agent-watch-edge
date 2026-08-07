import { readJsonFile } from '../../storage/json-file.js';
import { backupFile, writeFileAtomic } from '../../storage/atomic-file.js';
import { HOOK_COMMAND_MARKER, type SetupContext, type SetupOutcome } from '../provider.js';
import { claudeSettingsPath } from './claude.detect.js';

/**
 * Hook events AgentWatch registers in Claude Code.
 * Schema: hooks -> EventName -> [{matcher?, hooks: [{type:"command", command, timeout}]}]
 * (verified against code.claude.com/docs/en/hooks, 2026-08).
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
const MATCHED_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
const HOOK_TIMEOUT_SECONDS = 30;

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
  [key: string]: unknown;
}

function isAgentWatchEntry(entry: unknown): entry is HookEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const hooks = (entry as HookEntry).hooks;
  return Array.isArray(hooks) && hooks.some((hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_COMMAND_MARKER));
}

export async function installClaudeHooks(context: SetupContext): Promise<SetupOutcome> {
  const settingsPath = claudeSettingsPath(context.env);
  const read = await readJsonFile(settingsPath);
  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
  }
  const settings: Record<string, unknown> = read.state === 'ok' && isRecord(read.value) ? read.value : {};
  if (read.state === 'ok' && !isRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
  }

  const before = JSON.stringify(settings);
  const hooks: Record<string, unknown> = isRecord(settings['hooks']) ? (settings['hooks'] as Record<string, unknown>) : {};
  settings['hooks'] = hooks;

  for (const eventName of CLAUDE_HOOK_EVENTS) {
    const entries: unknown[] = Array.isArray(hooks[eventName]) ? (hooks[eventName] as unknown[]) : [];
    hooks[eventName] = entries;
    const desired: HookEntry = {
      ...(MATCHED_EVENTS.has(eventName) ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: context.hookCommand, timeout: HOOK_TIMEOUT_SECONDS }]
    };
    const existingIndex = entries.findIndex(isAgentWatchEntry);
    if (existingIndex >= 0) {
      entries[existingIndex] = desired;
    } else {
      entries.push(desired);
    }
  }

  // Drop stale AgentWatch registrations on events we no longer subscribe to.
  for (const [eventName, value] of Object.entries(hooks)) {
    if ((CLAUDE_HOOK_EVENTS as readonly string[]).includes(eventName) || !Array.isArray(value)) continue;
    const filtered = value.filter((entry) => !isAgentWatchEntry(entry));
    if (filtered.length !== value.length) {
      if (filtered.length === 0) delete hooks[eventName];
      else hooks[eventName] = filtered;
    }
  }

  const changed = JSON.stringify(settings) !== before;
  if (changed) {
    await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
    await writeSettingsValidated(settingsPath, settings);
  }

  context.installState.agents['claude'] = {
    ...context.installState.agents['claude'],
    hooksInstalledAt: context.env.now().toISOString(),
    hookConfigPath: settingsPath,
    hookEvents: [...CLAUDE_HOOK_EVENTS],
    hookCommand: context.hookCommand,
    otelOwnedKeys: context.installState.agents['claude']?.otelOwnedKeys ?? [],
    notes: context.installState.agents['claude']?.notes ?? []
  };

  return { ok: true, changed, messages: changed ? [`hooks registered in ${settingsPath}`] : ['hooks already registered'] };
}

export async function uninstallClaudeHooks(context: SetupContext): Promise<SetupOutcome> {
  const settingsPath = claudeSettingsPath(context.env);
  const read = await readJsonFile(settingsPath);
  if (read.state === 'missing') return { ok: true, changed: false, messages: ['no Claude settings file'] };
  if (read.state === 'invalid' || !isRecord(read.value)) {
    return { ok: false, changed: false, messages: [`cannot parse ${settingsPath}; not modified`] };
  }
  const settings = read.value as Record<string, unknown>;
  const hooks = settings['hooks'];
  if (!isRecord(hooks)) return { ok: true, changed: false, messages: ['no hooks configured'] };

  let changed = false;
  for (const [eventName, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const filtered = value.filter((entry) => !isAgentWatchEntry(entry));
    if (filtered.length !== value.length) {
      changed = true;
      if (filtered.length === 0) delete hooks[eventName];
      else hooks[eventName] = filtered;
    }
  }
  if (Object.keys(hooks).length === 0) delete settings['hooks'];

  if (changed) {
    await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
    await writeSettingsValidated(settingsPath, settings);
  }
  const claudeState = context.installState.agents['claude'];
  if (claudeState) {
    delete claudeState.hooksInstalledAt;
    claudeState.hookEvents = [];
  }
  return { ok: true, changed, messages: changed ? ['AgentWatch hooks removed'] : ['no AgentWatch hooks found'] };
}

/** Claude rejects invalid settings files wholesale; verify what we wrote parses. */
async function writeSettingsValidated(settingsPath: string, settings: Record<string, unknown>): Promise<void> {
  const serialized = JSON.stringify(settings, null, 2) + '\n';
  JSON.parse(serialized); // throws before we touch the file if serialization is broken
  await writeFileAtomic(settingsPath, serialized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
