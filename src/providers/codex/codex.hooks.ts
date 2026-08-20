import fs from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { asRecord } from '../../core/object.js';
import type { UnknownRecord } from '../../core/types/core.types.js';
import { backupFile } from '../../storage/atomic-file.js';
import { readJsonFile } from '../../storage/json-file.js';
import { registerOurHandlers, stripOurHandlers, sweepUnregisteredEvents, writeJsonValidated } from '../shared/hook-config.js';
import { withHookInstall, withoutHookInstall } from '../shared/install-record.js';
import type { SetupContext, SetupOutcome } from '../types/provider.types.js';
import { codexConfigTomlPath, codexHooksJsonPath } from './codex.detect.js';
import {
  CODEX_ALLOWED_TOP_LEVEL_KEYS,
  CODEX_HOOKS_DISABLED_WARNING,
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_TIMEOUT_SECONDS,
  CODEX_PROVIDER_ID,
  CODEX_TRUST_NOTE
} from './constants/codex.constants.js';

export { CODEX_HOOK_EVENTS } from './constants/codex.constants.js';

/**
 * Register AgentWatch's hooks in `~/.codex/hooks.json`.
 *
 * Codex parses that file with `deny_unknown_fields`, so an unknown top-level
 * key makes it skip the whole file. We therefore write nothing but
 * description/hooks — and refuse to proceed when foreign keys are already
 * present, because the file is already broken for Codex and overwriting it
 * would hide the user's problem instead of surfacing it.
 *
 * @param context - Environment, paths, config and the hook command to write.
 * @returns Whether the file changed, what to tell the user, and the next
 *   install state.
 */
export async function installCodexHooks(context: SetupContext): Promise<SetupOutcome> {
  const hooksPath = codexHooksJsonPath(context.env);
  const read = await readJsonFile(hooksPath);

  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${hooksPath} (${read.error})`] };
  }

  if (read.state === 'ok' && !asRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${hooksPath}: top level is not an object`] };
  }

  const file: UnknownRecord = (read.state === 'ok' ? asRecord(read.value) : undefined) ?? {};
  const foreignKeys = Object.keys(file).filter((key) => !CODEX_ALLOWED_TOP_LEVEL_KEYS.has(key));

  if (foreignKeys.length > 0) {
    return { ok: false, changed: false, messages: [`${hooksPath} has keys Codex rejects (${foreignKeys.join(', ')}); fix it first`] };
  }

  const hooks = asRecord(file['hooks']) ?? {};
  const registered = registerOurHandlers(hooks, CODEX_HOOK_EVENTS, () => ourEntry(context.hookCommand));
  const nextFile: UnknownRecord = { ...file, hooks: sweepUnregisteredEvents(registered, CODEX_HOOK_EVENTS) };
  const changed = JSON.stringify(nextFile) !== JSON.stringify(file);

  if (changed) {
    await backupFile(hooksPath, context.paths.backupsDir, context.env.now());
    await writeJsonValidated(hooksPath, nextFile);
  }

  const messages = [changed ? `hooks registered in ${hooksPath}` : 'hooks already registered'];

  if (changed) messages.push(CODEX_TRUST_NOTE);

  const featureWarning = await hooksFeatureDisabledWarning(context);

  if (featureWarning) messages.push(featureWarning);

  return {
    ok: true,
    changed,
    messages,
    installState: withHookInstall(context.installState, CODEX_PROVIDER_ID, {
      hookConfigPath: hooksPath,
      hookEvents: CODEX_HOOK_EVENTS,
      hookCommand: context.hookCommand,
      installedAt: context.env.now(),
      // The trust step is the one thing setup cannot do for the user, so it is
      // remembered rather than just printed once.
      notes: changed ? [CODEX_TRUST_NOTE] : undefined
    })
  };
}

/**
 * Remove AgentWatch's hooks from `~/.codex/hooks.json`.
 *
 * Every top-level field Codex accepts is preserved; only the hook entries we
 * own are gone.
 *
 * @param context - Environment, paths and current install state.
 * @returns Whether the file changed, what to tell the user, and the next
 *   install state.
 */
export async function uninstallCodexHooks(context: SetupContext): Promise<SetupOutcome> {
  const hooksPath = codexHooksJsonPath(context.env);
  const read = await readJsonFile(hooksPath);

  if (read.state === 'missing') return { ok: true, changed: false, messages: ['no Codex hooks file'] };

  const file = read.state === 'ok' ? asRecord(read.value) : undefined;

  if (!file) return { ok: false, changed: false, messages: [`cannot parse ${hooksPath}; not modified`] };

  const hooks = asRecord(file['hooks']);

  if (!hooks) return { ok: true, changed: false, messages: ['no hooks configured'] };

  const stripped = stripOurHandlers(hooks);

  if (stripped.changed) {
    await backupFile(hooksPath, context.paths.backupsDir, context.env.now());
    await writeJsonValidated(hooksPath, { ...file, hooks: stripped.hooks });
  }

  return {
    ok: true,
    changed: stripped.changed,
    messages: stripped.changed ? ['AgentWatch hooks removed'] : ['no AgentWatch hooks found'],
    installState: withoutHookInstall(context.installState, CODEX_PROVIDER_ID)
  };
}

/**
 * Our entry: a matcher-less group, which Codex reads as "match everything".
 *
 * @param hookCommand - Command line agents will invoke.
 * @returns The entry.
 */
function ourEntry(hookCommand: string): unknown {
  return { hooks: [{ type: 'command', command: hookCommand, timeout: CODEX_HOOK_TIMEOUT_SECONDS }] };
}

/**
 * Warn when the user has turned the whole hooks feature off.
 *
 * Hooks are on by default, so this is a rare but completely silent failure:
 * registration succeeds and nothing ever fires.
 *
 * @param context - Environment supplying the config path.
 * @returns The warning, or undefined when the feature is on.
 */
async function hooksFeatureDisabledWarning(context: SetupContext): Promise<string | undefined> {
  try {
    const parsed = asRecord(parseToml(await fs.readFile(codexConfigTomlPath(context.env), 'utf8')));
    const features = asRecord(parsed?.['features']);

    if (features?.['hooks'] === false) return CODEX_HOOKS_DISABLED_WARNING;
  } catch {
    // Missing or unparseable config.toml: nothing to warn about here.
  }

  return undefined;
}
