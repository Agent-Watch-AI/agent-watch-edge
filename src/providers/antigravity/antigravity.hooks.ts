import { readJsonFile } from '../../storage/json-file.js';
import { backupFile, writeFileAtomic } from '../../storage/atomic-file.js';
import { isAgentWatchHookCommand, type SetupContext, type SetupOutcome } from '../provider.js';
import { antigravityHooksPath } from './antigravity.detect.js';

export const ANTIGRAVITY_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'] as const;
const GROUPED = new Set(['PreToolUse', 'PostToolUse']);
function ours(value: unknown): boolean { return typeof value === 'object' && value !== null && isAgentWatchHookCommand(String((value as { command?: unknown }).command ?? '')); }
function strip(entries: unknown[]): unknown[] { return entries.flatMap((entry) => {
  if (typeof entry !== 'object' || entry === null || !Array.isArray((entry as { hooks?: unknown }).hooks)) return ours(entry) ? [] : [entry];
  const hooks = ((entry as { hooks: unknown[] }).hooks).filter((hook) => !ours(hook));
  return hooks.length ? [{ ...(entry as Record<string, unknown>), hooks }] : [];
}); }
export async function installAntigravityHooks(context: SetupContext): Promise<SetupOutcome> {
  const target = antigravityHooksPath(context.env); const read = await readJsonFile(target);
  if (read.state === 'invalid' || (read.state === 'ok' && (typeof read.value !== 'object' || read.value === null || Array.isArray(read.value)))) return { ok: false, changed: false, messages: [`refusing to modify invalid ${target}`] };
  const file = (read.state === 'ok' ? read.value : {}) as Record<string, unknown>; const before = JSON.stringify(file);
  const name = 'agentwatch'; const current = (typeof file[name] === 'object' && file[name] !== null ? file[name] : {}) as Record<string, unknown>;
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    const existing = Array.isArray(current[event]) ? current[event] : [];
    const kept = strip(existing);
    current[event] = GROUPED.has(event) ? [...kept, { matcher: '*', hooks: [{ type: 'command', command: context.hookCommand, timeout: 30 }] }] : [...kept, { type: 'command', command: context.hookCommand, timeout: 30 }];
  }
  file[name] = current; const changed = JSON.stringify(file) !== before;
  if (changed) { await backupFile(target, context.paths.backupsDir, context.env.now()); await writeFileAtomic(target, JSON.stringify(file, null, 2) + '\n'); }
  context.installState.agents['antigravity'] = { ...context.installState.agents['antigravity'], hooksInstalledAt: context.env.now().toISOString(), hookConfigPath: target, hookEvents: [...ANTIGRAVITY_HOOK_EVENTS], hookCommand: context.hookCommand, otelOwnedKeys: [], notes: [] };
  return { ok: true, changed, messages: [changed ? `hooks registered in ${target}` : 'hooks already registered'] };
}
export async function uninstallAntigravityHooks(context: SetupContext): Promise<SetupOutcome> { return { ok: true, changed: false, messages: ['uninstall Antigravity hooks manually from ~/.gemini/config/hooks.json'] }; }
