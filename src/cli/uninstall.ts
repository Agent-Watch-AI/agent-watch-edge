import fs from 'node:fs/promises';
import { getProvider, providerIds, providers } from '../providers/registry.js';
import type { AgentProvider, SetupContext, SetupOutcome } from '../providers/types/provider.types.js';
import { saveInstallState } from '../storage/install-state.js';
import type { InstallState } from '../storage/types/storage.types.js';
import { buildCliContext, buildHookCommand } from './context.js';
import type { UninstallOptions } from './types/cli.types.js';
import { bold, println, symbols } from './ui.js';

export type { UninstallOptions } from './types/cli.types.js';

/**
 * `agentwatch uninstall` — remove AgentWatch's own entries from agent configs.
 *
 * Only our entries: a user's own hooks, and every unrelated setting in the same
 * files, survive. Local configuration and the queue are kept unless `--purge`
 * asks for them, because a reinstall should not have to be re-configured.
 *
 * @param options - Environment, optional single agent, purge flag.
 * @returns 0 when every step succeeded, else 1.
 */
export async function runUninstall(options: UninstallOptions): Promise<number> {
  const context = await buildCliContext(options.env);

  println(bold('AgentWatch Uninstall'));
  println();

  const targets = resolveTargets(options.agent);

  if (!targets) {
    println(`${symbols.fail} unknown agent "${options.agent}" (known: ${providerIds.join(', ')})`);

    return 1;
  }

  let installState = context.installState;
  let failures = 0;

  for (const provider of targets) {
    println(bold(provider.displayName));

    const setupContext: SetupContext = {
      env: options.env,
      paths: context.paths,
      config: context.config,
      hookCommand: buildHookCommand(options.env, provider.id),
      installState
    };
    const hooks = await provider.uninstallHooks(setupContext);

    installState = report(hooks, installState);

    if (!hooks.ok) failures++;

    if (provider.nativeTelemetry) {
      const otel = await provider.nativeTelemetry.uninstall({ ...setupContext, installState });

      installState = report(otel, installState);

      if (!otel.ok) failures++;
    }

    println();
  }

  await saveInstallState(context.paths, installState);

  if (options.purge && !options.agent) {
    await fs.rm(context.paths.dataDir, { recursive: true, force: true });
    await fs.rm(context.paths.configDir, { recursive: true, force: true });
    println(`${symbols.ok} local configuration and queued data removed`);
  }

  if (!options.purge || options.agent) {
    println(`local config kept at ${context.paths.configFile} (use --purge to remove)`);
  }

  return failures === 0 ? 0 : 1;
}

/**
 * Which providers this run touches.
 *
 * @param agent - Value of `--agent`, when given.
 * @returns The providers, or undefined when the named agent is unknown.
 */
function resolveTargets(agent: string | undefined): readonly AgentProvider[] | undefined {
  if (!agent) return providers;

  const provider = getProvider(agent);

  return provider ? [provider] : undefined;
}

/**
 * Print an outcome and carry its install state forward.
 *
 * @param outcome - What the operation reported.
 * @param current - Install state before it ran.
 * @returns The install state to pass to the next operation.
 */
function report(outcome: SetupOutcome, current: InstallState): InstallState {
  for (const message of outcome.messages) {
    println(`${outcome.ok ? symbols.ok : symbols.fail} ${message}`);
  }

  return outcome.installState ?? current;
}
