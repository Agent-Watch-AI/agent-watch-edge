import fs from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { readJsonFile } from '../../storage/json-file.js';
import { backupFile, writeFileAtomic } from '../../storage/atomic-file.js';
import { HOOK_COMMAND_MARKER, type SetupContext, type SetupOutcome } from '../provider.js';
import { codexConfigTomlPath, codexHooksJsonPath } from './codex.detect.js';

/**
 * Codex lifecycle hooks (verified against openai/codex source, 2026-08).
 * File: ~/.codex/hooks.json. Top level is strictly {description?, hooks}
 * (deny_unknown_fields) — we must not add any other key. Matcher is optional
 * (absent = match everything). Hooks are enabled by default, but NON-MANAGED
 * HOOKS DO NOT RUN UNTIL THE USER TRUSTS THEM via /hooks in the Codex TUI.
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop'
] as const;

const HOOK_TIMEOUT_SECONDS = 30;

interface MatcherGroup {
  matcher?: string;
  hooks: { type: string; command?: string; timeout?: number; [key: string]: unknown }[];
  [key: string]: unknown;
}

function isAgentWatchGroup(group: unknown): group is MatcherGroup {
  if (typeof group !== 'object' || group === null) return false;
  const hooks = (group as MatcherGroup).hooks;
  return Array.isArray(hooks) && hooks.some((hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_COMMAND_MARKER));
}

export async function installCodexHooks(context: SetupContext): Promise<SetupOutcome> {
  const hooksPath = codexHooksJsonPath(context.env);
  const read = await readJsonFile(hooksPath);
  if (read.state === 'invalid') {
    return { ok: false, changed: false, messages: [`refusing to modify unparseable ${hooksPath} (${read.error})`] };
  }
  const file: Record<string, unknown> = read.state === 'ok' && isRecord(read.value) ? read.value : {};
  if (read.state === 'ok' && !isRecord(read.value)) {
    return { ok: false, changed: false, messages: [`refusing to modify ${hooksPath}: top level is not an object`] };
  }
  // Codex parses hooks.json with deny_unknown_fields: an unknown top-level key
  // makes it skip the whole file. Never write anything except description/hooks,
  // and refuse to proceed if foreign keys are already present (the file is
  // already broken for Codex; overwriting would hide the user's problem).
  const foreignKeys = Object.keys(file).filter((key) => key !== 'description' && key !== 'hooks');
  if (foreignKeys.length > 0) {
    return { ok: false, changed: false, messages: [`${hooksPath} has keys Codex rejects (${foreignKeys.join(', ')}); fix it first`] };
  }

  const before = JSON.stringify(file);
  const hooks: Record<string, unknown> = isRecord(file['hooks']) ? (file['hooks'] as Record<string, unknown>) : {};
  file['hooks'] = hooks;

  for (const eventName of CODEX_HOOK_EVENTS) {
    const groups: unknown[] = Array.isArray(hooks[eventName]) ? (hooks[eventName] as unknown[]) : [];
    hooks[eventName] = groups;
    const desired: MatcherGroup = {
      hooks: [{ type: 'command', command: context.hookCommand, timeout: HOOK_TIMEOUT_SECONDS }]
    };
    const existingIndex = groups.findIndex(isAgentWatchGroup);
    if (existingIndex >= 0) groups[existingIndex] = desired;
    else groups.push(desired);
  }
  for (const [eventName, value] of Object.entries(hooks)) {
    if ((CODEX_HOOK_EVENTS as readonly string[]).includes(eventName) || !Array.isArray(value)) continue;
    const filtered = value.filter((group) => !isAgentWatchGroup(group));
    if (filtered.length === 0) delete hooks[eventName];
    else if (filtered.length !== value.length) hooks[eventName] = filtered;
  }

  const changed = JSON.stringify(file) !== before;
  if (changed) {
    await backupFile(hooksPath, context.paths.backupsDir, context.env.now());
    const serialized = JSON.stringify(file, null, 2) + '\n';
    JSON.parse(serialized);
    await writeFileAtomic(hooksPath, serialized);
  }

  const messages = changed ? [`hooks registered in ${hooksPath}`] : ['hooks already registered'];
  const trustNote = 'Codex requires trusting new hooks: run `codex`, then `/hooks`, and trust the AgentWatch entries.';
  if (changed) messages.push(trustNote);
  const featureWarning = await checkHooksFeatureDisabled(context);
  if (featureWarning) messages.push(featureWarning);

  context.installState.agents['codex'] = {
    ...context.installState.agents['codex'],
    hooksInstalledAt: context.env.now().toISOString(),
    hookConfigPath: hooksPath,
    hookEvents: [...CODEX_HOOK_EVENTS],
    hookCommand: context.hookCommand,
    otelOwnedKeys: context.installState.agents['codex']?.otelOwnedKeys ?? [],
    notes: changed ? [trustNote] : (context.installState.agents['codex']?.notes ?? [])
  };

  return { ok: true, changed, messages };
}

export async function uninstallCodexHooks(context: SetupContext): Promise<SetupOutcome> {
  const hooksPath = codexHooksJsonPath(context.env);
  const read = await readJsonFile(hooksPath);
  if (read.state === 'missing') return { ok: true, changed: false, messages: ['no Codex hooks file'] };
  if (read.state === 'invalid' || !isRecord(read.value)) {
    return { ok: false, changed: false, messages: [`cannot parse ${hooksPath}; not modified`] };
  }
  const file = read.value as Record<string, unknown>;
  const hooks = file['hooks'];
  if (!isRecord(hooks)) return { ok: true, changed: false, messages: ['no hooks configured'] };

  let changed = false;
  for (const [eventName, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const filtered = value.filter((group) => !isAgentWatchGroup(group));
    if (filtered.length !== value.length) {
      changed = true;
      if (filtered.length === 0) delete hooks[eventName];
      else hooks[eventName] = filtered;
    }
  }

  if (changed) {
    await backupFile(hooksPath, context.paths.backupsDir, context.env.now());
    if (Object.keys(hooks).length === 0 && Object.keys(file).every((key) => key === 'hooks' || key === 'description')) {
      // File only ever contained hook config; leave an empty-but-valid file.
      await writeFileAtomic(hooksPath, JSON.stringify({ hooks: {} }, null, 2) + '\n');
    } else {
      await writeFileAtomic(hooksPath, JSON.stringify(file, null, 2) + '\n');
    }
  }
  const codexState = context.installState.agents['codex'];
  if (codexState) {
    delete codexState.hooksInstalledAt;
    codexState.hookEvents = [];
  }
  return { ok: true, changed, messages: changed ? ['AgentWatch hooks removed'] : ['no AgentWatch hooks found'] };
}

/** Hooks are on by default; warn when the user disabled the feature. */
async function checkHooksFeatureDisabled(context: SetupContext): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(codexConfigTomlPath(context.env), 'utf8');
    const parsed = parseToml(raw) as Record<string, unknown>;
    const features = parsed['features'];
    if (typeof features === 'object' && features !== null && (features as Record<string, unknown>)['hooks'] === false) {
      return 'warning: [features] hooks = false in ~/.codex/config.toml — Codex hooks are disabled';
    }
  } catch {
    // Missing or unparseable config.toml: nothing to warn about here.
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
