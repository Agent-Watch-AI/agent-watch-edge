import path from 'node:path';
import process from 'node:process';
import type { Env } from '../core/env.js';
import { findExecutable } from '../core/which.js';
import { resolvePaths, type AgentWatchPaths } from '../storage/paths.js';
import { loadConfig, type ConfigLoadResult } from '../config/config-store.js';
import { loadInstallState, type InstallState } from '../storage/install-state.js';
import { eventsUrl, type AgentWatchConfig } from '../config/config.js';
import { EventQueue } from '../transport/queue.js';
import { HttpTransport } from '../transport/http-transport.js';
import { DeliveryStats } from '../transport/delivery-stats.js';
import type { EventTransport } from '../transport/transport.js';

export interface CliContext {
  env: Env;
  paths: AgentWatchPaths;
  config: AgentWatchConfig;
  configState: ConfigLoadResult['state'];
  configError?: string;
  installState: InstallState;
}

export async function buildCliContext(env: Env): Promise<CliContext> {
  const paths = resolvePaths(env);
  const configResult = await loadConfig(paths);
  const installState = await loadInstallState(paths);
  return {
    env,
    paths,
    config: configResult.config,
    configState: configResult.state,
    configError: configResult.state === 'invalid' ? configResult.error : undefined,
    installState
  };
}

export function buildQueue(context: CliContext): EventQueue {
  return new EventQueue({
    queueDir: context.paths.queueDir,
    locksDir: context.paths.locksDir,
    maxEvents: context.config.delivery.maxQueueEvents,
    maxAttempts: context.config.delivery.maxAttempts,
    maxEventAgeDays: context.config.delivery.maxEventAgeDays,
    now: env0(context).now
  });
}

export function buildDeliveryStats(context: CliContext): DeliveryStats {
  return new DeliveryStats(path.join(context.paths.dataDir, 'delivery-stats.json'), context.env.now, context.paths.locksDir);
}

export function buildTransport(context: CliContext, timeoutMs?: number): EventTransport | undefined {
  const url = eventsUrl(context.config);
  if (!url) return undefined;
  return new HttpTransport({
    eventsUrl: url,
    token: context.config.token,
    installationId: context.config.installationId,
    timeoutMs: timeoutMs ?? context.config.delivery.timeoutMs
  });
}

/**
 * Command line agents should invoke for hook callbacks. Prefer the installed
 * bin; fall back to `node <this script>` for non-global installs.
 */
export function buildHookCommand(env: Env, providerId: string, scriptPath = process.argv[1]): string {
  const bin = findExecutable(env, 'agentwatch');
  if (bin) return `${quoteArg(bin)} hook --agent ${providerId}`;
  const script = scriptPath ? path.resolve(scriptPath) : 'agentwatch';
  if (script === 'agentwatch') return `agentwatch hook --agent ${providerId}`;
  return `${quoteArg(process.execPath)} ${quoteArg(script)} hook --agent ${providerId}`;
}

function quoteArg(value: string): string {
  return /[\s"'\\$`]/.test(value) ? `"${value.replace(/(["\\$`])/g, '\\$1')}"` : value;
}

function env0(context: CliContext): { now: () => Date } {
  return { now: context.env.now };
}
