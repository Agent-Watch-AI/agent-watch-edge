import { asRecord } from '../../core/object.js';
import type { UnknownRecord } from '../../core/types/core.types.js';
import { backupFile } from '../../storage/atomic-file.js';
import { readJsonFile } from '../../storage/json-file.js';
import { registerOurHandlers, stripOurHandlers, sweepUnregisteredEvents, writeJsonValidated } from '../shared/hook-config.js';
import { withHookInstall, withoutHookInstall } from '../shared/install-record.js';
import type { SetupContext, SetupOutcome } from '../types/provider.types.js';
import { cursorHooksJsonPath } from './cursor.detect.js';
import {
  CURSOR_HOOKS_VERSION,
  CURSOR_HOOK_EVENTS,
  CURSOR_HOOK_TIMEOUT_SECONDS,
  CURSOR_PROVIDER_ID,
  CURSOR_USAGE_NOTE,
  CURSOR_VERSION_KEY
} from './constants/cursor.constants.js';

export { CURSOR_HOOK_EVENTS } from './constants/cursor.constants.js';

/**
 * Register AgentWatch's hooks in `~/.cursor/hooks.json`.
 *
 * Cursor's entries are flat command objects rather than matcher groups, so ours
 * is one entry per event. An existing `version` is preserved verbatim — the
 * documented schema is 1, but the user's file is the authority on what Cursor
 * build wrote it.
 *
 * @param context - Environment, paths, config and the hook command to write.
 * @returns Whether the file changed, what to tell the user, and the next
 *   install state.
 */
export async function installCursorHooks(context: SetupContext): Promise<SetupOutcome> {
  const hooksPath = cursorHooksJsonPath(context.env);
  const read = await readJsonFile(hooksPath);

  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${hooksPath} (${read.error})`] };
  }

  if (read.state === 'ok' && !asRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${hooksPath}: top level is not an object`] };
  }

  const file: UnknownRecord = (read.state === 'ok' ? asRecord(read.value) : undefined) ?? {};
  const hooks = asRecord(file['hooks']) ?? {};
  const registered = registerOurHandlers(hooks, CURSOR_HOOK_EVENTS, () => ourEntry(context.hookCommand), { allowBareHandlers: true });
  const nextFile: UnknownRecord = {
    ...file,
    [CURSOR_VERSION_KEY]: typeof file[CURSOR_VERSION_KEY] === 'number' ? file[CURSOR_VERSION_KEY] : CURSOR_HOOKS_VERSION,
    hooks: sweepUnregisteredEvents(registered, CURSOR_HOOK_EVENTS, { allowBareHandlers: true })
  };
  const changed = JSON.stringify(nextFile) !== JSON.stringify(file);

  if (changed) {
    await backupFile(hooksPath, context.paths.backupsDir, context.env.now());
    await writeJsonValidated(hooksPath, nextFile);
  }

  return {
    ok: true,
    changed,
    messages: [changed ? `hooks registered in ${hooksPath}` : 'hooks already registered', CURSOR_USAGE_NOTE],
    installState: withHookInstall(context.installState, CURSOR_PROVIDER_ID, {
      hookConfigPath: hooksPath,
      hookEvents: CURSOR_HOOK_EVENTS,
      hookCommand: context.hookCommand,
      installedAt: context.env.now()
    })
  };
}

/**
 * Remove AgentWatch's hooks from `~/.cursor/hooks.json`.
 *
 * Every other top-level field, `version` included, is preserved.
 *
 * @param context - Environment, paths and current install state.
 * @returns Whether the file changed, what to tell the user, and the next
 *   install state.
 */
export async function uninstallCursorHooks(context: SetupContext): Promise<SetupOutcome> {
  const hooksPath = cursorHooksJsonPath(context.env);
  const read = await readJsonFile(hooksPath);

  if (read.state === 'missing') return { ok: true, changed: false, messages: ['no Cursor hooks file'] };

  const file = read.state === 'ok' ? asRecord(read.value) : undefined;

  if (!file) return { ok: false, changed: false, messages: [`cannot parse ${hooksPath}; not modified`] };

  const hooks = asRecord(file['hooks']);

  if (!hooks) return { ok: true, changed: false, messages: ['no hooks configured'] };

  const stripped = stripOurHandlers(hooks, { allowBareHandlers: true });

  if (stripped.changed) {
    await backupFile(hooksPath, context.paths.backupsDir, context.env.now());
    await writeJsonValidated(hooksPath, { ...file, hooks: stripped.hooks });
  }

  return {
    ok: true,
    changed: stripped.changed,
    messages: stripped.changed ? ['AgentWatch hooks removed'] : ['no AgentWatch hooks found'],
    installState: withoutHookInstall(context.installState, CURSOR_PROVIDER_ID)
  };
}

/**
 * Our entry: a flat command object, which is the only shape Cursor accepts.
 *
 * @param hookCommand - Command line agents will invoke.
 * @returns The entry.
 */
function ourEntry(hookCommand: string): unknown {
  return { command: hookCommand, timeout: CURSOR_HOOK_TIMEOUT_SECONDS };
}
