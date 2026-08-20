import { readJsonFile } from '../../storage/json-file.js';
import { backupFile, writeFileAtomic } from '../../storage/atomic-file.js';
import { isAgentWatchHookCommand, type SetupContext, type SetupOutcome } from '../provider.js';
import { antigravityHooksPath } from './antigravity.detect.js';

/**
 * Antigravity reads `~/.gemini/config/hooks.json` as a map of *named* hook
 * groups — its log line is "loaded N named hooks from N hooks.json file(s)" —
 * so AgentWatch owns exactly one top-level key and never touches another
 * tool's group.
 */
const GROUP_NAME = 'agentwatch';

export const ANTIGRAVITY_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'] as const;

/** Tool-scoped events take a matcher; the rest are plain handler lists. */
const MATCHED_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse']);

/**
 * `HookHandlerConfig.timeout` carries no unit suffix, and Gemini CLI — the
 * same Google hook runner — reads the field as milliseconds with a 60,000
 * default. A bare `30` there timed every AgentWatch hook out before node could
 * start; see the identical constant in gemini.hooks.ts. Milliseconds is also
 * the safe reading of the two: an over-large upper bound costs nothing,
 * because the hook exits in well under a second either way.
 */
const HOOK_TIMEOUT_MILLISECONDS = 30_000;

interface HookHandler {
  type: string;
  command: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks: HookHandler[];
  [key: string]: unknown;
}

function isAgentWatchHandler(hook: unknown): boolean {
  return (
    typeof hook === 'object' &&
    hook !== null &&
    typeof (hook as { command?: unknown }).command === 'string' &&
    isAgentWatchHookCommand((hook as { command: string }).command)
  );
}

/**
 * Drop AgentWatch's own handlers from one event's entry list. Handles both
 * shapes Antigravity accepts: a bare handler and a matcher entry wrapping a
 * handler list.
 */
function withoutAgentWatchHandlers(entries: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const entry of entries) {
    if (isAgentWatchHandler(entry)) continue;
    if (typeof entry !== 'object' || entry === null || !Array.isArray((entry as HookEntry).hooks)) {
      kept.push(entry);
      continue;
    }
    const hooks = (entry as HookEntry).hooks.filter((hook) => !isAgentWatchHandler(hook));
    if (hooks.length > 0) kept.push({ ...(entry as HookEntry), hooks });
  }
  return kept;
}

export async function installAntigravityHooks(context: SetupContext): Promise<SetupOutcome> {
  const target = antigravityHooksPath(context.env);
  const read = await readJsonFile(target);
  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${target} (${read.error})`] };
  }
  if (read.state === 'ok' && !isRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${target}: top level is not an object`] };
  }

  const file: Record<string, unknown> = read.state === 'ok' ? (read.value as Record<string, unknown>) : {};
  const before = JSON.stringify(file);
  const group: Record<string, unknown> = isRecord(file[GROUP_NAME]) ? (file[GROUP_NAME] as Record<string, unknown>) : {};

  const handler: HookHandler = { type: 'command', command: context.hookCommand, timeout: HOOK_TIMEOUT_MILLISECONDS };
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    const existing = Array.isArray(group[event]) ? (group[event] as unknown[]) : [];
    const kept = withoutAgentWatchHandlers(existing);
    group[event] = MATCHED_EVENTS.has(event) ? [...kept, { matcher: '*', hooks: [handler] }] : [...kept, handler];
  }

  // An event we registered in an earlier version and no longer use would
  // otherwise keep firing a hook nothing reads.
  for (const [event, value] of Object.entries(group)) {
    if ((ANTIGRAVITY_HOOK_EVENTS as readonly string[]).includes(event) || !Array.isArray(value)) continue;
    const kept = withoutAgentWatchHandlers(value);
    if (kept.length === 0) delete group[event];
    else group[event] = kept;
  }

  file[GROUP_NAME] = group;
  const changed = JSON.stringify(file) !== before;
  if (changed) {
    await backupFile(target, context.paths.backupsDir, context.env.now());
    await writeValidated(target, file);
  }

  context.installState.agents['antigravity'] = {
    ...context.installState.agents['antigravity'],
    hooksInstalledAt: context.env.now().toISOString(),
    hookConfigPath: target,
    hookEvents: [...ANTIGRAVITY_HOOK_EVENTS],
    hookCommand: context.hookCommand,
    otelOwnedKeys: [],
    notes: context.installState.agents['antigravity']?.notes ?? []
  };

  return {
    ok: true,
    changed,
    messages: [
      changed ? `hooks registered in ${target}` : 'hooks already registered',
      ...(changed ? ['restart running Antigravity sessions to pick them up'] : [])
    ]
  };
}

export async function uninstallAntigravityHooks(context: SetupContext): Promise<SetupOutcome> {
  const target = antigravityHooksPath(context.env);
  const read = await readJsonFile(target);
  if (read.state === 'missing') {
    delete context.installState.agents['antigravity'];
    return { ok: true, changed: false, messages: ['no Antigravity hooks file'] };
  }
  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${target} (${read.error})`] };
  }
  if (!isRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${target}: top level is not an object`] };
  }

  const file = read.value as Record<string, unknown>;
  const before = JSON.stringify(file);

  // Our own group goes wholesale; a group somebody else owns is only filtered,
  // in case an AgentWatch command was hand-added to it.
  for (const [name, value] of Object.entries(file)) {
    if (!isRecord(value)) continue;
    const group = value as Record<string, unknown>;
    for (const [event, entries] of Object.entries(group)) {
      if (!Array.isArray(entries)) continue;
      const kept = withoutAgentWatchHandlers(entries);
      if (kept.length === 0) delete group[event];
      else group[event] = kept;
    }
    if (Object.keys(group).length === 0) delete file[name];
  }

  const changed = JSON.stringify(file) !== before;
  if (changed) {
    await backupFile(target, context.paths.backupsDir, context.env.now());
    await writeValidated(target, file);
  }
  delete context.installState.agents['antigravity'];

  return {
    ok: true,
    changed,
    messages: [changed ? 'AgentWatch hooks removed' : 'no AgentWatch hooks found']
  };
}

async function writeValidated(targetPath: string, file: Record<string, unknown>): Promise<void> {
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  JSON.parse(serialized);
  await writeFileAtomic(targetPath, serialized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
