import fs from 'node:fs/promises';
import { z } from 'zod';
import type { Env } from '../core/types/core.types.js';
import { providers } from '../providers/registry.js';
import type { AgentProvider } from '../providers/types/provider.types.js';
import { writeFileAtomic } from '../storage/atomic-file.js';
import { SECRET_FILE_MODE } from '../storage/constants/storage.constants.js';
import { disabledFile, isDisabled } from '../storage/disabled.js';
import { saveInstallState } from '../storage/install-state.js';
import { readJsonFile } from '../storage/json-file.js';
import { buildCliContext, buildHookCommand } from './context.js';
import { println } from './ui.js';

const suspendedSchema = z.object({ providers: z.array(z.string()) });

/**
 * Stop hooks first, then remove or restore only managed native exporters.
 * The marker survives partial failures so a retry cannot silently resume hooks.
 * @param env - User environment.
 * @param enabled - Whether operation should resume.
 * @returns Nonzero when manual repair or a retry is required.
 */
export async function runToggle(env: Env, enabled: boolean): Promise<number> {
  const context = await buildCliContext(env);
  const file = disabledFile(context.paths);
  const disabled = await isDisabled(context.paths);

  if (enabled && !disabled) {
    println('AgentWatch is already enabled.');

    return 0;
  }

  // No early return: `off` is the retry the failure path asks for, and the
  // marker is already written by then. The uninstall loop below is idempotent,
  // so re-running it is how leftover exporters finally come out.
  if (!enabled && disabled) println('AgentWatch is already disabled; re-checking native exporters. Restart running coding agents if they were not restarted after the first call.');

  if (enabled && context.configState !== 'ok') {
    // A machine stopped before it was ever enrolled has nothing to restore, and
    // `setup` refuses while the marker is there — so refusing here too is a
    // deadlock with no exit. Clearing the marker costs nothing: with no config
    // there is no endpoint, no token and no exporter that was ever written.
    if (context.configState === 'missing') {
      await fs.rm(file, { force: true });
      println('AgentWatch enabled. No configuration found — run agentwatch setup to enroll.');

      return 0;
    }

    println(`AgentWatch remains disabled. Repair ${context.paths.configFile} before running agentwatch on, or delete ${file} to clear the off switch by hand.`);

    return 1;
  }

  const read = await readJsonFile(file);
  const saved = read.state === 'ok' ? suspendedSchema.safeParse(read.value) : undefined;
  const everyExporter = providers.filter((provider) => provider.nativeTelemetry).map((provider) => provider.id);

  // `off` never narrows its work from a record it might not have. Install state
  // degrades to `{agents:{}}` on a missing or corrupt file, and a marker can be
  // empty or hand-edited — either would have made this a no-op that reports
  // success while the Codex and Gemini exporters keep shipping with their bearer
  // token. Uninstall is ownership-scoped and idempotent, so asking a provider
  // that has nothing of ours costs one read and says so.
  //
  // `on` prefers the recorded list, so a provider the machine never had is not
  // configured by a restore; anything unreadable falls back to the same full
  // set, where the hooks-installed check below is the guard.
  const targets = enabled && saved?.success ? saved.data.providers : everyExporter;

  if (!enabled && !saved?.success && read.state === 'ok') {
    println('disabled.json could not be read; re-checking every managed exporter rather than trusting it.');
  }

  if (!enabled) await writeFileAtomic(file, JSON.stringify({ providers: targets }), SECRET_FILE_MODE);

  let installState = context.installState;
  let failures = 0;
  const restored: AgentProvider[] = [];

  for (const provider of providers) {
    if (!targets.includes(provider.id) || !provider.nativeTelemetry) continue;

    // An uninstall performed while stopped must not be undone by `on`.
    if (enabled && !(await provider.detect(env)).hooksInstalled) continue;

    const setupContext = { ...context, installState, hookCommand: buildHookCommand(env, provider.id) };

    try {
      const outcome = enabled
        ? await provider.nativeTelemetry.configure(setupContext)
        : await provider.nativeTelemetry.uninstall(setupContext);

      installState = outcome.installState ?? installState;
      await saveInstallState(context.paths, installState);

      if (enabled && outcome.ok) restored.push(provider);

      for (const message of outcome.messages) println(`${provider.displayName}: ${message}`);

      if (!outcome.ok) failures++;
    } catch {
      failures++;
      println(`${provider.displayName}: telemetry configuration could not be updated; repair permissions/configuration and retry.`);
    }
  }

  if (enabled && failures > 0) {
    for (const provider of restored) {
      if (!provider.nativeTelemetry) continue;

      try {
        const outcome = await provider.nativeTelemetry.uninstall({ ...context, installState, hookCommand: buildHookCommand(env, provider.id) });

        installState = outcome.installState ?? installState;
        await saveInstallState(context.paths, installState);
      } catch {
        println(`${provider.displayName}: failed to roll back restored telemetry; close agents and run agentwatch off again.`);
      }
    }
  }

  if (enabled && failures === 0) await fs.rm(file);

  println(enabled && failures === 0 ? 'AgentWatch enabled.' : 'AgentWatch disabled for hooks and otel-headers.');
  println('Restart all running coding agents to apply native telemetry changes; existing processes may retain exporters and credentials.');

  if (failures > 0) println('Native telemetry changes are incomplete. Close running agents and retry this command after repair.');

  return failures === 0 ? 0 : 1;
}
