import path from 'node:path';
import process from 'node:process';
import { eventsUrl } from '../config/config.js';
import { loadConfig } from '../config/config-store.js';
import type { Env } from '../core/types/core.types.js';
import { findExecutable } from '../core/which.js';
import { loadInstallState } from '../storage/install-state.js';
import { resolvePaths } from '../storage/paths.js';
import { DeliveryStats } from '../transport/delivery-stats.js';
import { HttpTransport } from '../transport/http-transport.js';
import { EventQueue } from '../transport/queue.js';
import { queuePartition } from '../transport/queue-partition.js';
import { DELIVERY_STATS_FILE_NAME } from '../transport/constants/transport.constants.js';
import type { EventTransport } from '../transport/types/transport.types.js';
import { RE_NEEDS_QUOTING, RE_QUOTE_ESCAPE } from './constants/cli.constants.js';
import type { CliContext } from './types/cli.types.js';

export type { CliContext } from './types/cli.types.js';

/**
 * Resolve everything a command needs from the environment.
 *
 * One read of the config and install state per command: the individual
 * commands then work from this value instead of each reaching for the disk.
 *
 * @param env - Ambient environment.
 * @returns The context.
 */
export async function buildCliContext(env: Env): Promise<CliContext> {
  const paths = resolvePaths(env);
  const configResult = await loadConfig(paths);

  return {
    env,
    paths,
    config: configResult.config,
    configState: configResult.state,
    configError: configResult.state === 'invalid' ? configResult.error : undefined,
    installState: await loadInstallState(paths)
  };
}

/**
 * The offline queue for this context.
 *
 * Partitioned by the same token `buildTransport` signs with, so a command can
 * only ever drain the backlog belonging to the identity it is sending as.
 *
 * @param context - Resolved CLI context.
 * @returns The queue.
 */
export function buildQueue(context: CliContext): EventQueue {
  return new EventQueue({
    queueDir: queuePartition(context.paths.queueDir, context.config.token),
    locksDir: context.paths.locksDir,
    maxEvents: context.config.delivery.maxQueueEvents,
    maxAttempts: context.config.delivery.maxAttempts,
    maxEventAgeDays: context.config.delivery.maxEventAgeDays,
    now: context.env.now
  });
}

/**
 * The delivery-loss tally for this context.
 *
 * @param context - Resolved CLI context.
 * @returns The tally.
 */
export function buildDeliveryStats(context: CliContext): DeliveryStats {
  return new DeliveryStats(path.join(context.paths.dataDir, DELIVERY_STATS_FILE_NAME), context.env.now, context.paths.locksDir);
}

/**
 * The transport for this context, when a backend is configured.
 *
 * @param context - Resolved CLI context.
 * @param timeoutMs - Override for the configured send timeout.
 * @returns The transport, or undefined before setup has run.
 */
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
 * The command agents should invoke for hook callbacks.
 *
 * Prefers the installed bin, and falls back to `node <this script>` for a local
 * or linked install. The exact shape matters: `isAgentWatchHookCommand` has to
 * recognize whatever is written here later, or uninstall will not clean it up.
 *
 * @param env - Ambient environment, for the PATH lookup.
 * @param providerId - Agent the hook is for.
 * @param scriptPath - This script's path; defaults to argv[1].
 * @returns The command line.
 */
export function buildHookCommand(env: Env, providerId: string, scriptPath = process.argv[1]): string {
  const bin = findExecutable(env, 'agentwatch');

  if (bin) return `${quoteArg(bin)} hook --agent ${providerId}`;

  const script = scriptPath ? path.resolve(scriptPath) : 'agentwatch';

  if (script === 'agentwatch') return `agentwatch hook --agent ${providerId}`;

  return `${quoteArg(process.execPath)} ${quoteArg(script)} hook --agent ${providerId}`;
}

/**
 * Quote a path for embedding in a shell-executed command.
 *
 * @param value - The path.
 * @returns The value, quoted only when it needs to be.
 */
function quoteArg(value: string): string {
  if (!RE_NEEDS_QUOTING.test(value)) return value;

  return `"${value.replace(RE_QUOTE_ESCAPE, '\\$1')}"`;
}
