import fs from 'node:fs/promises';
import type { Env } from '../core/env.js';
import { providers, getProvider } from '../providers/registry.js';
import type { AgentProvider, SetupContext } from '../providers/provider.js';
import { saveInstallState } from '../storage/install-state.js';
import { buildCliContext, buildHookCommand } from './context.js';
import { bold, println, symbols } from './ui.js';

export interface UninstallOptions {
  env: Env;
  agent?: string;
  /** Also delete local config/queue/state. Off by default. */
  purge?: boolean;
}

export async function runUninstall(options: UninstallOptions): Promise<number> {
  const context = await buildCliContext(options.env);
  println(bold('AgentWatch Uninstall'));
  println();

  let targets: AgentProvider[];
  if (options.agent) {
    const provider = getProvider(options.agent);
    if (!provider) {
      println(`${symbols.fail} unknown agent "${options.agent}" (known: ${providers.map((p) => p.id).join(', ')})`);
      return 1;
    }
    targets = [provider];
  } else {
    targets = providers;
  }

  let failures = 0;
  for (const provider of targets) {
    println(bold(provider.displayName));
    const setupContext: SetupContext = {
      env: options.env,
      paths: context.paths,
      config: context.config,
      hookCommand: buildHookCommand(options.env, provider.id),
      installState: context.installState
    };
    const hooks = await provider.uninstallHooks(setupContext);
    for (const message of hooks.messages) println(`${hooks.ok ? symbols.ok : symbols.fail} ${message}`);
    if (!hooks.ok) failures++;
    if (provider.nativeTelemetry) {
      const otel = await provider.nativeTelemetry.uninstall(setupContext);
      for (const message of otel.messages) println(`${otel.ok ? symbols.ok : symbols.fail} ${message}`);
      if (!otel.ok) failures++;
    }
    println();
  }
  await saveInstallState(context.paths, context.installState);

  if (options.purge && !options.agent) {
    await fs.rm(context.paths.dataDir, { recursive: true, force: true });
    await fs.rm(context.paths.configDir, { recursive: true, force: true });
    println(`${symbols.ok} local configuration and queued data removed`);
  } else {
    println(`local config kept at ${context.paths.configFile} (use --purge to remove)`);
  }
  return failures === 0 ? 0 : 1;
}
