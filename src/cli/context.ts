import path from 'node:path';
import process from 'node:process';
import { eventsUrl } from '../config/config.js';
import { loadConfig } from '../config/config-store.js';
import type { Env } from '../core/types/core.types.js';
import { findExecutable } from '../core/which.js';
import { isDisabled } from '../storage/disabled.js';
import { loadInstallState } from '../storage/install-state.js';
import { resolvePaths } from '../storage/paths.js';
import { BackendAuthBlock } from '../transport/auth-block.js';
import { DeliveryStats } from '../transport/delivery-stats.js';
import { HttpTransport } from '../transport/http-transport.js';
import { EventQueue } from '../transport/queue.js';
import { identityPaths, settleLegacyQueue } from '../transport/queue-partition.js';
import { applyRootOverride, servesMultipleIdentities } from '../config/root-config.js';
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
  // Resolved once, here, because every identity-scoped file a command touches is
  // named after the token the *hooks in this directory* use. `buildAuthBlock`
  // reading the global token was a per-root block nothing could see or lift: a
  // 401 under a root's own token wrote a block file under that token's
  // fingerprint, `status` read the global one and printed nothing, and `doctor`
  // proved the global credential good and cleared a block that was never the
  // one standing. That root's telemetry stayed suspended with no diagnostic and
  // no remedy, and a block has no timer to end it.
  const rooted = applyRootOverride(configResult.config, env.cwd);

  return {
    env,
    disabled: await isDisabled(paths),
    paths,
    config: configResult.config,
    identityConfig: rooted.config,
    ...(rooted.root === undefined ? {} : { identityRoot: rooted.root.path }),
    configState: configResult.state,
    configError: configResult.state === 'invalid' ? configResult.error : undefined,
    configWarnings: configResult.warnings,
    installState: await loadInstallState(paths)
  };
}

/**
 * The offline queue for this context.
 *
 * Partitioned by the same token `buildTransport` signs with, so a command can
 * only ever drain the backlog belonging to the identity it is sending as. A
 * backlog written by a pre-partition edge is settled first, so `status`,
 * `doctor` and setup's retarget offer agree about what is in the partition.
 *
 * @param context - Resolved CLI context.
 * @returns The queue.
 */
export async function buildQueue(context: CliContext): Promise<EventQueue> {
  // `config` for the multi-identity question and `identityConfig` for the
  // partition, exactly as the hook path does it: whether the machine serves two
  // bearers is a fact about the whole file, and which partition this command
  // owns is a fact about where it was run.
  await settleLegacyQueue(context.paths.queueDir, context.identityConfig.token, servesMultipleIdentities(context.config));

  return new EventQueue({
    queueDir: identityPaths(context.paths, context.identityConfig.token).queueDir,
    locksDir: context.paths.locksDir,
    maxEvents: context.identityConfig.delivery.maxQueueEvents,
    maxAttempts: context.identityConfig.delivery.maxAttempts,
    maxEventAgeDays: context.identityConfig.delivery.maxEventAgeDays,
    now: context.env.now,
    stats: buildDeliveryStats(context)
  });
}

/**
 * The delivery-loss tally for this context.
 *
 * @param context - Resolved CLI context.
 * @returns The tally.
 */
export function buildDeliveryStats(context: CliContext): DeliveryStats {
  return new DeliveryStats(identityPaths(context.paths, context.identityConfig.token).statsFile, context.env.now, context.paths.locksDir);
}

/**
 * The standing credential refusal for this context.
 *
 * @param context - Resolved CLI context.
 * @returns The block.
 */
export function buildAuthBlock(context: CliContext): BackendAuthBlock {
  return new BackendAuthBlock(identityPaths(context.paths, context.identityConfig.token).authBlockFile, context.env.now);
}

/**
 * The transport for this context, when a backend is configured.
 *
 * @param context - Resolved CLI context.
 * @param timeoutMs - Override for the configured send timeout.
 * @returns The transport, or undefined before setup has run.
 */
export function buildTransport(context: CliContext, timeoutMs?: number): EventTransport | undefined {
  // The rooted identity throughout, so `doctor` probes the credential the hooks
  // in this directory present and `status` drains the partition they fill. Only
  // that credential can prove itself good, and only that proof may lift the
  // block standing against it.
  const url = eventsUrl(context.identityConfig);

  if (!url || context.disabled) return undefined;

  return new HttpTransport({
    eventsUrl: url,
    capture: context.identityConfig.capture,
    token: context.identityConfig.token,
    installationId: context.identityConfig.installationId,
    timeoutMs: timeoutMs ?? context.identityConfig.delivery.timeoutMs
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
