import { asRecord } from '../../core/object.js';
import type { UnknownRecord } from '../../core/types/core.types.js';
import { backupFile } from '../../storage/atomic-file.js';
import { readJsonFile } from '../../storage/json-file.js';
import { registerOurHandlers, stripOurHandlers, sweepUnregisteredEvents, withHooksBlock, writeJsonValidated } from '../shared/hook-config.js';
import { withHookInstall, withoutHookInstall } from '../shared/install-record.js';
import type { SetupContext, SetupOutcome } from '../types/provider.types.js';
import { CLAUDE_HOOK_EVENTS, CLAUDE_HOOK_TIMEOUT_SECONDS, CLAUDE_MATCHED_EVENTS, CLAUDE_PROVIDER_ID } from './constants/claude.constants.js';
import { claudeSettingsPath } from './claude.detect.js';

export { CLAUDE_HOOK_EVENTS } from './constants/claude.constants.js';

/**
 * Register AgentWatch's hooks in `~/.claude/settings.json`.
 *
 * Everything the user owns survives: their handlers inside our matcher groups,
 * their own groups, and every unrelated setting in the file. Our previous
 * handlers are stripped before the fresh one is added, because two
 * registrations would make every turn be processed — and counted — twice.
 *
 * @param context - Environment, paths, config and the hook command to write.
 * @returns Whether the file changed, what to tell the user, and the next
 *   install state.
 */
export async function installClaudeHooks(context: SetupContext): Promise<SetupOutcome> {
  const settingsPath = claudeSettingsPath(context.env);
  const read = await readJsonFile(settingsPath);

  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${settingsPath} (${read.error})`] };
  }

  if (read.state === 'ok' && !asRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${settingsPath}: top level is not an object`] };
  }

  const settings: UnknownRecord = (read.state === 'ok' ? asRecord(read.value) : undefined) ?? {};
  const hooks = asRecord(settings['hooks']) ?? {};
  const registered = registerOurHandlers(hooks, CLAUDE_HOOK_EVENTS, hookEntryFor(context.hookCommand));
  const nextSettings: UnknownRecord = { ...settings, hooks: sweepUnregisteredEvents(registered, CLAUDE_HOOK_EVENTS) };
  const changed = JSON.stringify(nextSettings) !== JSON.stringify(settings);

  if (changed) {
    await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
    await writeJsonValidated(settingsPath, nextSettings);
  }

  return {
    ok: true,
    changed,
    messages: changed ? [`hooks registered in ${settingsPath}`] : ['hooks already registered'],
    installState: withHookInstall(context.installState, CLAUDE_PROVIDER_ID, {
      hookConfigPath: settingsPath,
      hookEvents: CLAUDE_HOOK_EVENTS,
      hookCommand: context.hookCommand,
      installedAt: context.env.now()
    })
  };
}

/**
 * Remove AgentWatch's hooks from `~/.claude/settings.json`.
 *
 * @param context - Environment, paths and current install state.
 * @returns Whether the file changed, what to tell the user, and the next
 *   install state.
 */
export async function uninstallClaudeHooks(context: SetupContext): Promise<SetupOutcome> {
  const settingsPath = claudeSettingsPath(context.env);
  const read = await readJsonFile(settingsPath);

  if (read.state === 'missing') return { ok: true, changed: false, messages: ['no Claude settings file'] };

  const settings = read.state === 'ok' ? asRecord(read.value) : undefined;

  if (!settings) return { ok: false, changed: false, messages: [`cannot parse ${settingsPath}; not modified`] };

  const hooks = asRecord(settings['hooks']);

  if (!hooks) return { ok: true, changed: false, messages: ['no hooks configured'] };

  const stripped = stripOurHandlers(hooks);
  const nextSettings = withHooksBlock(settings, stripped.hooks);

  if (stripped.changed) {
    await backupFile(settingsPath, context.paths.backupsDir, context.env.now());
    await writeJsonValidated(settingsPath, nextSettings);
  }

  return {
    ok: true,
    changed: stripped.changed,
    messages: stripped.changed ? ['AgentWatch hooks removed'] : ['no AgentWatch hooks found'],
    installState: withoutHookInstall(context.installState, CLAUDE_PROVIDER_ID)
  };
}

/**
 * Our entry for one event: a dedicated matcher group holding one handler.
 *
 * @param hookCommand - Command line agents will invoke.
 * @returns A factory producing the entry for a given event name.
 */
function hookEntryFor(hookCommand: string): (eventName: string) => unknown {
  return (eventName: string) => ({
    // Tool-scoped events require a matcher; "*" observes every tool.
    ...(CLAUDE_MATCHED_EVENTS.has(eventName) ? { matcher: '*' } : {}),
    hooks: [{ type: 'command', command: hookCommand, timeout: CLAUDE_HOOK_TIMEOUT_SECONDS }]
  });
}
