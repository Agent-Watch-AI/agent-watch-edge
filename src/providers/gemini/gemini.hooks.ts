import { asRecord } from '../../core/object.js';
import type { UnknownRecord } from '../../core/types/core.types.js';
import { backupFile } from '../../storage/atomic-file.js';
import { readJsonFile } from '../../storage/json-file.js';
import { registerOurHandlers, stripOurHandlers, sweepUnregisteredEvents, withHooksBlock, writeJsonValidated } from '../shared/hook-config.js';
import { withHookInstall, withoutAgent } from '../shared/install-record.js';
import type { SetupContext, SetupOutcome } from '../types/provider.types.js';
import { geminiSettingsPath } from './gemini.detect.js';
import {
  GEMINI_HOOK_EVENTS,
  GEMINI_HOOK_TIMEOUT_MILLISECONDS,
  GEMINI_MATCHED_EVENTS,
  GEMINI_PROVIDER_ID
} from './constants/gemini.constants.js';

export { GEMINI_HOOK_EVENTS } from './constants/gemini.constants.js';

/**
 * Register AgentWatch's hooks in Gemini CLI's `settings.json`.
 *
 * @param context - Environment, paths, config and the hook command to write.
 * @returns Whether the file changed, what to tell the user, and the next
 *   install state.
 */
export async function installGeminiHooks(context: SetupContext): Promise<SetupOutcome> {
  const settingsPath = geminiSettingsPath(context.env);
  const read = await readJsonFile(settingsPath);

  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
  }

  if (read.state === 'ok' && !asRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
  }

  const settings: UnknownRecord = (read.state === 'ok' ? asRecord(read.value) : undefined) ?? {};
  const hooks = asRecord(settings['hooks']) ?? {};
  const registered = registerOurHandlers(hooks, GEMINI_HOOK_EVENTS, hookEntryFor(context.hookCommand));
  const nextSettings: UnknownRecord = { ...settings, hooks: sweepUnregisteredEvents(registered, GEMINI_HOOK_EVENTS) };
  const changed = JSON.stringify(nextSettings) !== JSON.stringify(settings);

  if (changed) {
    await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
    await writeJsonValidated(settingsPath, nextSettings);
  }

  return {
    ok: true,
    changed,
    messages: [`hooks registered in ${settingsPath}`],
    installState: withHookInstall(context.installState, GEMINI_PROVIDER_ID, {
      hookConfigPath: settingsPath,
      hookEvents: GEMINI_HOOK_EVENTS,
      hookCommand: context.hookCommand,
      installedAt: context.env.now()
    })
  };
}

/**
 * Remove AgentWatch's hooks from Gemini CLI's `settings.json`.
 *
 * The agent is forgotten entirely rather than just having its hook fields
 * cleared: Gemini's hooks and its telemetry live in the same file, so once that
 * file has nothing of ours left there is nothing to describe.
 *
 * @param context - Environment, paths and current install state.
 * @returns Whether the file changed, what to tell the user, and the next
 *   install state.
 */
export async function uninstallGeminiHooks(context: SetupContext): Promise<SetupOutcome> {
  const settingsPath = geminiSettingsPath(context.env);
  const read = await readJsonFile(settingsPath);
  const forgotten = withoutAgent(context.installState, GEMINI_PROVIDER_ID);

  if (read.state === 'missing') {
    return { ok: true, changed: false, messages: ['no Gemini settings file'], installState: forgotten };
  }

  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
  }

  const settings = asRecord(read.value);

  if (!settings) {
    return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
  }

  const hooks = asRecord(settings['hooks']);

  if (!hooks) {
    return { ok: true, changed: false, messages: ['no hooks block in settings.json'], installState: forgotten };
  }

  const stripped = stripOurHandlers(hooks);

  if (stripped.changed) {
    await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
    await writeJsonValidated(settingsPath, withHooksBlock(settings, stripped.hooks));
  }

  return { ok: true, changed: stripped.changed, messages: ['AgentWatch hooks removed'], installState: forgotten };
}

/**
 * Our entry for one event: a matcher group holding one handler.
 *
 * @param hookCommand - Command line agents will invoke.
 * @returns A factory producing the entry for a given event name.
 */
function hookEntryFor(hookCommand: string): (eventName: string) => unknown {
  return (eventName: string) => ({
    ...(GEMINI_MATCHED_EVENTS.has(eventName) ? { matcher: '*' } : {}),
    hooks: [{ type: 'command', command: hookCommand, timeout: GEMINI_HOOK_TIMEOUT_MILLISECONDS }]
  });
}
