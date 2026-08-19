import { readJsonFile } from '../../storage/json-file.js';
import { backupFile, writeFileAtomic } from '../../storage/atomic-file.js';
import { isAgentWatchHookCommand, type SetupContext, type SetupOutcome } from '../provider.js';
import { geminiSettingsPath } from './gemini.detect.js';

export const GEMINI_HOOK_EVENTS = [
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

const MATCHED_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
const HOOK_TIMEOUT_SECONDS = 30;

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
  [key: string]: unknown;
}

function isAgentWatchHandler(hook: unknown): boolean {
  return typeof hook === 'object' && hook !== null && typeof (hook as { command?: unknown }).command === 'string' && isAgentWatchHookCommand((hook as { command: string }).command);
}

function withoutAgentWatchHandlers(entries: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || !Array.isArray((entry as HookEntry).hooks)) {
      out.push(entry);
      continue;
    }
    const kept = (entry as HookEntry).hooks.filter((hook) => !isAgentWatchHandler(hook));
    if (kept.length === (entry as HookEntry).hooks.length) out.push(entry);
    else if (kept.length > 0) out.push({ ...(entry as HookEntry), hooks: kept });
  }
  return out;
}

export async function installGeminiHooks(context: SetupContext): Promise<SetupOutcome> {
  const settingsPath = geminiSettingsPath(context.env);
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

  for (const eventName of GEMINI_HOOK_EVENTS) {
    const existing: unknown[] = Array.isArray(hooks[eventName]) ? (hooks[eventName] as unknown[]) : [];
    const entries = withoutAgentWatchHandlers(existing);
    entries.push({
      ...(MATCHED_EVENTS.has(eventName) ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: context.hookCommand, timeout: HOOK_TIMEOUT_SECONDS }]
    } satisfies HookEntry);
    hooks[eventName] = entries;
  }

  for (const [eventName, value] of Object.entries(hooks)) {
    if ((GEMINI_HOOK_EVENTS as readonly string[]).includes(eventName) || !Array.isArray(value)) continue;
    const filtered = withoutAgentWatchHandlers(value);
    if (filtered.length !== value.length || JSON.stringify(filtered) !== JSON.stringify(value)) {
      if (filtered.length === 0) delete hooks[eventName];
      else hooks[eventName] = filtered;
    }
  }

  const changed = JSON.stringify(settings) !== before;
  if (changed) {
    await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
    await writeSettingsValidated(settingsPath, settings);
  }

  context.installState.agents['gemini'] = {
    ...context.installState.agents['gemini'],
    hooksInstalledAt: context.env.now().toISOString(),
    hookConfigPath: settingsPath,
    hookEvents: [...GEMINI_HOOK_EVENTS],
    hookCommand: context.hookCommand,
    otelOwnedKeys: context.installState.agents['gemini']?.otelOwnedKeys ?? [],
    notes: context.installState.agents['gemini']?.notes ?? []
  };

  return {
    ok: true,
    changed,
    messages: [
      `hooks registered in ${settingsPath}`
    ]
  };
}

export async function uninstallGeminiHooks(context: SetupContext): Promise<SetupOutcome> {
  const settingsPath = geminiSettingsPath(context.env);
  const read = await readJsonFile(settingsPath);
  if (read.state === 'missing') {
    delete context.installState.agents['gemini'];
    return { ok: true, changed: false, messages: ['no Gemini settings file'] };
  }
  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
  }
  if (!isRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
  }
  const settings = read.value as Record<string, unknown>;
  const hooks = isRecord(settings['hooks']) ? (settings['hooks'] as Record<string, unknown>) : undefined;
  if (!hooks) {
    delete context.installState.agents['gemini'];
    return { ok: true, changed: false, messages: ['no hooks block in settings.json'] };
  }

  let changed = false;
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const filtered = withoutAgentWatchHandlers(entries);
    if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
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
  delete context.installState.agents['gemini'];

  return {
    ok: true,
    changed,
    messages: ['AgentWatch hooks removed']
  };
}

async function writeSettingsValidated(targetPath: string, settings: Record<string, unknown>): Promise<void> {
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  JSON.parse(serialized);
  await writeFileAtomic(targetPath, serialized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
