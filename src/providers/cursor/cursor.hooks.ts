import { readJsonFile } from '../../storage/json-file.js';
import { backupFile, writeFileAtomic } from '../../storage/atomic-file.js';
import { isAgentWatchHookCommand, type SetupContext, type SetupOutcome } from '../provider.js';
import { cursorHooksJsonPath } from './cursor.detect.js';

/**
 * Cursor lifecycle hooks (verified against cursor.com/docs/hooks, 2026-08).
 * File: ~/.cursor/hooks.json, format { version: 1, hooks: { <event>: [entry] } }
 * — flat command entries per event, no matcher groups. Hooks need no trust
 * step (unlike Codex). Cursor also reads project/enterprise/team hooks.json
 * files; AgentWatch manages only the user-level one.
 *
 * beforeTabFileRead is deliberately NOT registered: it fires on every inline
 * completion and carries the full file content — pure noise with a privacy
 * cost. afterAgentThought and workspaceOpen carry nothing the data model uses.
 */
export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'afterAgentResponse',
  'stop',
  'afterTabFileEdit'
] as const;

const HOOK_TIMEOUT_SECONDS = 30;

interface HookEntry {
  command?: string;
  [key: string]: unknown;
}

function isAgentWatchEntry(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && typeof (entry as HookEntry).command === 'string' && isAgentWatchHookCommand((entry as HookEntry).command!);
}

/** Remove AgentWatch entries, preserving user entries in the same event list. */
function withoutAgentWatchEntries(entries: unknown[]): unknown[] {
  return entries.filter((entry) => !isAgentWatchEntry(entry));
}

export async function installCursorHooks(context: SetupContext): Promise<SetupOutcome> {
  const hooksPath = cursorHooksJsonPath(context.env);
  const read = await readJsonFile(hooksPath);
  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${hooksPath} (${read.error})`] };
  }
  if (read.state === 'ok' && !isRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${hooksPath}: top level is not an object`] };
  }
  const file: Record<string, unknown> = read.state === 'ok' && isRecord(read.value) ? read.value : {};

  const before = JSON.stringify(file);
  // Preserve an existing version verbatim; Cursor's documented schema is 1.
  if (typeof file['version'] !== 'number') file['version'] = 1;
  const hooks: Record<string, unknown> = isRecord(file['hooks']) ? (file['hooks'] as Record<string, unknown>) : {};
  file['hooks'] = hooks;

  for (const eventName of CURSOR_HOOK_EVENTS) {
    const existing: unknown[] = Array.isArray(hooks[eventName]) ? (hooks[eventName] as unknown[]) : [];
    const entries = withoutAgentWatchEntries(existing);
    entries.push({ command: context.hookCommand, timeout: HOOK_TIMEOUT_SECONDS } satisfies HookEntry);
    hooks[eventName] = entries;
  }
  // Sweep our entries out of events we no longer register.
  for (const [eventName, value] of Object.entries(hooks)) {
    if ((CURSOR_HOOK_EVENTS as readonly string[]).includes(eventName) || !Array.isArray(value)) continue;
    const filtered = withoutAgentWatchEntries(value);
    if (filtered.length === 0) delete hooks[eventName];
    else if (JSON.stringify(filtered) !== JSON.stringify(value)) hooks[eventName] = filtered;
  }

  const changed = JSON.stringify(file) !== before;
  if (changed) {
    await backupFile(hooksPath, context.paths.backupsDir, context.env.now());
    const serialized = JSON.stringify(file, null, 2) + '\n';
    JSON.parse(serialized);
    await writeFileAtomic(hooksPath, serialized);
  }

  const messages = changed ? [`hooks registered in ${hooksPath}`] : ['hooks already registered'];
  messages.push('note: Cursor transcripts carry no token usage yet — Cursor turn summaries stay usage_status=pending until Cursor enriches them.');

  context.installState.agents['cursor'] = {
    ...context.installState.agents['cursor'],
    hooksInstalledAt: context.env.now().toISOString(),
    hookConfigPath: hooksPath,
    hookEvents: [...CURSOR_HOOK_EVENTS],
    hookCommand: context.hookCommand,
    otelOwnedKeys: context.installState.agents['cursor']?.otelOwnedKeys ?? [],
    notes: context.installState.agents['cursor']?.notes ?? []
  };

  return { ok: true, changed, messages };
}

export async function uninstallCursorHooks(context: SetupContext): Promise<SetupOutcome> {
  const hooksPath = cursorHooksJsonPath(context.env);
  const read = await readJsonFile(hooksPath);
  if (read.state === 'missing') return { ok: true, changed: false, messages: ['no Cursor hooks file'] };
  if (read.state === 'invalid' || !isRecord(read.value)) {
    return { ok: false, changed: false, messages: [`cannot parse ${hooksPath}; not modified`] };
  }
  const file = read.value as Record<string, unknown>;
  const hooks = file['hooks'];
  if (!isRecord(hooks)) return { ok: true, changed: false, messages: ['no hooks configured'] };

  let changed = false;
  for (const [eventName, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const filtered = withoutAgentWatchEntries(value);
    if (JSON.stringify(filtered) !== JSON.stringify(value)) {
      changed = true;
      if (filtered.length === 0) delete hooks[eventName];
      else hooks[eventName] = filtered;
    }
  }

  if (changed) {
    await backupFile(hooksPath, context.paths.backupsDir, context.env.now());
    // Preserve every other top-level field (version included); only the hook
    // entries we own are gone.
    await writeFileAtomic(hooksPath, JSON.stringify(file, null, 2) + '\n');
  }
  const cursorState = context.installState.agents['cursor'];
  if (cursorState) {
    delete cursorState.hooksInstalledAt;
    cursorState.hookEvents = [];
  }
  return { ok: true, changed, messages: changed ? ['AgentWatch hooks removed'] : ['no AgentWatch hooks found'] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
