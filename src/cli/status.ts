import { eventsUrl } from '../config/config.js';
import type { Env } from '../core/types/core.types.js';
import { collectGitContext } from '../git/git-context.js';
import type { GitContext } from '../git/types/git.types.js';
import { providers } from '../providers/registry.js';
import type { AgentProvider, SetupContext } from '../providers/types/provider.types.js';
import type { DeliveryStats } from '../transport/delivery-stats.js';
import type { DeliveryStatsSnapshot } from '../transport/types/transport.types.js';
import type { EventQueue } from '../transport/queue.js';
import { buildCliContext, buildDeliveryStats, buildHookCommand, buildQueue, buildTransport } from './context.js';
import { STATUS_SEND_TIMEOUT_MS } from './constants/cli.constants.js';
import type { CliContext } from './types/cli.types.js';
import { bold, dim, println, symbols } from './ui.js';

/**
 * `agentwatch status` — is telemetry actually flowing, and if not, why.
 *
 * Reads as the four questions a developer has: is a backend configured, where
 * am I, is each agent wired up, and is anything stuck or lost.
 *
 * @param env - Ambient environment.
 * @returns Exit code 0; status reports, it does not judge.
 */
export async function runStatus(env: Env): Promise<number> {
  const context = await buildCliContext(env);

  println(bold('AgentWatch Edge'));
  println();

  reportBackend(context);
  println();

  reportRepository(await collectGitContext({ cwd: env.cwd, includeChangedFiles: false }));
  println();

  println(bold('Agents'));

  for (const provider of providers) {
    await reportAgent(provider, context);
  }

  println();

  await reportDelivery(context);

  return 0;
}

/**
 * Whether a backend is configured.
 *
 * @param context - Resolved CLI context.
 */
function reportBackend(context: CliContext): void {
  println(bold('Backend'));

  if (context.configState === 'invalid') {
    println(`${symbols.fail} config invalid: ${context.configError}`);

    return;
  }

  if (context.config.endpoint) {
    println(`${symbols.ok} ${context.config.endpoint}`);
    reportEnforcement(context);

    return;
  }

  println(`${symbols.off} not configured — run \`agentwatch setup\``);
}

/**
 * Whether a budget cap marked `block` is acted on here.
 *
 * Worth a line of its own: it is the one setting that can stop a developer's
 * turn, so a developer whose prompt was refused should be able to see where that
 * came from without reading the config file.
 *
 * @param context - Resolved CLI context.
 */
function reportEnforcement(context: CliContext): void {
  if (!context.config.enforcement.enabled) {
    println(`${symbols.off} budget enforcement: off`);

    return;
  }

  println(`${symbols.ok} budget enforcement: on — a turn stops only when the backend answers "block"`);
}

/**
 * Where this command was run.
 *
 * @param git - Collected git context.
 */
function reportRepository(git: GitContext): void {
  println(bold('Repository'));

  if (!git.repositoryRoot) {
    println(`${symbols.off} not inside a Git repository`);

    return;
  }

  println(`${symbols.ok} ${git.repository ?? git.repositoryRoot}`);

  if (git.branch) println(dim(`  branch: ${git.branch}`));
}

/**
 * Whether one agent is detected, hooked and exporting telemetry.
 *
 * @param provider - The agent's provider.
 * @param context - Resolved CLI context.
 */
async function reportAgent(provider: AgentProvider, context: CliContext): Promise<void> {
  const detection = await provider.detect(context.env);

  println();
  println(provider.displayName);

  if (!detection.detected) {
    println(`${symbols.off} not detected`);

    return;
  }

  println(`${symbols.ok} detected ${dim(`(${detection.evidence[0] ?? ''})`)}`);
  println(detection.hooksInstalled ? `${symbols.ok} hooks installed` : `${symbols.off} hooks not installed`);

  if (!provider.nativeTelemetry) return;

  const setupContext: SetupContext = {
    env: context.env,
    paths: context.paths,
    config: context.config,
    hookCommand: buildHookCommand(context.env, provider.id),
    installState: context.installState
  };
  const otel = await provider.nativeTelemetry.inspect(setupContext);

  if (otel.configured) {
    println(`${symbols.ok} native OpenTelemetry ${otel.detail ?? 'configured'}`);

    return;
  }

  println(otel.conflict ? `${symbols.warn} native OpenTelemetry: ${otel.conflict}` : `${symbols.off} native OpenTelemetry not configured`);
}

/**
 * The backlog, and everything the queue has lost.
 *
 * A pending backlog is retried here first: we are already out of every agent's
 * critical path, so this is the reasonable moment to try again.
 *
 * @param context - Resolved CLI context.
 */
async function reportDelivery(context: CliContext): Promise<void> {
  println(bold('Delivery'));

  const queue = buildQueue(context);
  const deliveryStats = buildDeliveryStats(context);
  const pending = await retryBacklog(context, queue, deliveryStats);

  println(pending === 0 ? `${symbols.ok} healthy` : `${symbols.warn} backlog`);
  println(`${pending} pending event(s)`);

  reportLosses(context, await deliveryStats.read());
}

/**
 * Drain what can be drained, and report the backlog that remains.
 *
 * @param context - Resolved CLI context.
 * @param queue - The offline queue.
 * @param deliveryStats - Sink for anything the drain loses.
 * @returns The remaining entry count.
 */
async function retryBacklog(context: CliContext, queue: EventQueue, deliveryStats: DeliveryStats): Promise<number> {
  const pending = await queue.pendingCount();

  if (pending === 0 || !eventsUrl(context.config)) return pending;

  const transport = buildTransport(context, STATUS_SEND_TIMEOUT_MS);

  if (!transport) return pending;

  const drained = await queue.drain(transport, context.config.delivery.drainBatchSize, deliveryStats);

  if (drained.sent > 0) println(dim(`  retried: ${drained.sent} event(s) delivered`));

  return queue.pendingCount();
}

/**
 * What the queue has permanently lost, and what to do about it.
 *
 * @param context - Resolved CLI context.
 * @param stats - The persisted tally, when there is one.
 */
function reportLosses(context: CliContext, stats: DeliveryStatsSnapshot | undefined): void {
  if (!stats) return;

  if (stats.totalRejected > 0) {
    const last = stats.lastRejectedAt ? ` (last ${stats.lastRejectedCount} at ${stats.lastRejectedAt})` : '';

    println(`${symbols.warn} ${stats.totalRejected} event(s) permanently rejected by the backend${last}`);
  }

  if (stats.totalDropped > 0) {
    const last = stats.lastDroppedAt ? ` (last ${stats.lastDroppedCount} at ${stats.lastDroppedAt})` : '';

    // Attempts exhausted, past the age bound, or unreadable on disk: whichever
    // it was, the event is gone — and used to be gone silently.
    println(`${symbols.warn} ${stats.totalDropped} event(s) lost from the local queue${last}`);
    println(dim(`  the queue gives up after ${context.config.delivery.maxAttempts} attempts or ${context.config.delivery.maxEventAgeDays} day(s)`));
  }

  if (stats.lastRefusalStatus > 0) {
    println(`${symbols.warn} backend last refused a batch with HTTP ${stats.lastRefusalStatus}${stats.lastRefusalAt ? ` at ${stats.lastRefusalAt}` : ''}`);
    println(dim('  a refusal is not retried on its own; check the endpoint, the token and the event schema'));
  }
}
