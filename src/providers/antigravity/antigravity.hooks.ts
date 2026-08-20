import { asRecord, omitKeys } from '../../core/object.js';
import type { UnknownRecord } from '../../core/types/core.types.js';
import { backupFile } from '../../storage/atomic-file.js';
import { readJsonFile } from '../../storage/json-file.js';
import { registerOurHandlers, stripOurHandlers, sweepUnregisteredEvents, writeJsonValidated } from '../shared/hook-config.js';
import { withHookInstall, withoutAgent } from '../shared/install-record.js';
import type { SetupContext, SetupOutcome } from '../types/provider.types.js';
import { antigravityHooksPath } from './antigravity.detect.js';
import {
  ANTIGRAVITY_GROUP_NAME,
  ANTIGRAVITY_HOOK_EVENTS,
  ANTIGRAVITY_HOOK_TIMEOUT_MILLISECONDS,
  ANTIGRAVITY_MATCHED_EVENTS,
  ANTIGRAVITY_PROVIDER_ID
} from './constants/antigravity.constants.js';

export { ANTIGRAVITY_HOOK_EVENTS } from './constants/antigravity.constants.js';

/** Antigravity accepts a bare handler as well as a matcher group. */
const STRIP_OPTIONS = { allowBareHandlers: true } as const;

/**
 * Register AgentWatch's hooks in `~/.gemini/config/hooks.json`.
 *
 * The file is a map of *named* groups, so AgentWatch owns exactly one top-level
 * key and never touches another tool's group.
 *
 * @param context - Environment, paths, config and the hook command to write.
 * @returns Whether the file changed, what to tell the user, and the next
 *   install state.
 */
export async function installAntigravityHooks(context: SetupContext): Promise<SetupOutcome> {
  const target = antigravityHooksPath(context.env);
  const read = await readJsonFile(target);

  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${target} (${read.error})`] };
  }

  if (read.state === 'ok' && !asRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${target}: top level is not an object`] };
  }

  const file: UnknownRecord = (read.state === 'ok' ? asRecord(read.value) : undefined) ?? {};
  const group = asRecord(file[ANTIGRAVITY_GROUP_NAME]) ?? {};
  const registered = registerOurHandlers(group, ANTIGRAVITY_HOOK_EVENTS, hookEntryFor(context.hookCommand), STRIP_OPTIONS);
  const nextFile: UnknownRecord = {
    ...file,
    [ANTIGRAVITY_GROUP_NAME]: sweepUnregisteredEvents(registered, ANTIGRAVITY_HOOK_EVENTS, STRIP_OPTIONS)
  };
  const changed = JSON.stringify(nextFile) !== JSON.stringify(file);

  if (changed) {
    await backupFile(target, context.paths.backupsDir, context.env.now());
    await writeJsonValidated(target, nextFile);
  }

  return {
    ok: true,
    changed,
    messages: [
      changed ? `hooks registered in ${target}` : 'hooks already registered',
      ...(changed ? ['restart running Antigravity sessions to pick them up'] : [])
    ],
    installState: withHookInstall(context.installState, ANTIGRAVITY_PROVIDER_ID, {
      hookConfigPath: target,
      hookEvents: ANTIGRAVITY_HOOK_EVENTS,
      hookCommand: context.hookCommand,
      installedAt: context.env.now()
    })
  };
}

/**
 * Remove AgentWatch's hooks from `~/.gemini/config/hooks.json`.
 *
 * Our own group goes wholesale; a group somebody else owns is only filtered, in
 * case an AgentWatch command was hand-added to it.
 *
 * @param context - Environment, paths and current install state.
 * @returns Whether the file changed, what to tell the user, and the next
 *   install state.
 */
export async function uninstallAntigravityHooks(context: SetupContext): Promise<SetupOutcome> {
  const target = antigravityHooksPath(context.env);
  const read = await readJsonFile(target);
  const forgotten = withoutAgent(context.installState, ANTIGRAVITY_PROVIDER_ID);

  if (read.state === 'missing') {
    return { ok: true, changed: false, messages: ['no Antigravity hooks file'], installState: forgotten };
  }

  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${target} (${read.error})`] };
  }

  const file = asRecord(read.value);

  if (!file) {
    return { ok: false, changed: false, messages: [`refusing to modify ${target}: top level is not an object`] };
  }

  const nextFile = strippedGroups(file);
  const changed = JSON.stringify(nextFile) !== JSON.stringify(file);

  if (changed) {
    await backupFile(target, context.paths.backupsDir, context.env.now());
    await writeJsonValidated(target, nextFile);
  }

  return {
    ok: true,
    changed,
    messages: [changed ? 'AgentWatch hooks removed' : 'no AgentWatch hooks found'],
    installState: forgotten
  };
}

/**
 * Every group with our handlers removed, and emptied groups dropped.
 *
 * @param file - The whole hooks file.
 * @returns The next file contents.
 */
function strippedGroups(file: UnknownRecord): UnknownRecord {
  const emptied = new Set<string>();
  const next: UnknownRecord = { ...file };

  for (const [name, value] of Object.entries(file)) {
    const group = asRecord(value);

    if (!group) continue;

    const stripped = stripOurHandlers(group, STRIP_OPTIONS).hooks;

    if (Object.keys(stripped).length === 0) {
      emptied.add(name);
      continue;
    }

    next[name] = stripped;
  }

  return omitKeys(next, emptied);
}

/**
 * Our entry for one event: a matcher group for tool events, a bare handler
 * otherwise — both shapes Antigravity accepts.
 *
 * @param hookCommand - Command line agents will invoke.
 * @returns A factory producing the entry for a given event name.
 */
function hookEntryFor(hookCommand: string): (eventName: string) => unknown {
  const handler = { type: 'command', command: hookCommand, timeout: ANTIGRAVITY_HOOK_TIMEOUT_MILLISECONDS };

  return (eventName: string) => (ANTIGRAVITY_MATCHED_EVENTS.has(eventName) ? { matcher: '*', hooks: [handler] } : handler);
}
