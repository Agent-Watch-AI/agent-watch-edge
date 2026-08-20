import type { Env } from '../core/env.js';
import { providers } from '../providers/registry.js';
import type { SetupContext } from '../providers/provider.js';
import { collectGitContext } from '../git/git-context.js';
import { eventsUrl } from '../config/config.js';
import { buildCliContext, buildDeliveryStats, buildHookCommand, buildQueue, buildTransport } from './context.js';
import { bold, dim, println, symbols } from './ui.js';

export async function runStatus(env: Env): Promise<number> {
  const context = await buildCliContext(env);
  println(bold('AgentWatch Bridge'));
  println();

  println(bold('Backend'));
  if (context.configState === 'invalid') {
    println(`${symbols.fail} config invalid: ${context.configError}`);
  } else if (context.config.endpoint) {
    println(`${symbols.ok} ${context.config.endpoint}`);
  } else {
    println(`${symbols.off} not configured — run \`agentwatch setup\``);
  }
  println();

  println(bold('Repository'));
  const git = await collectGitContext({ cwd: env.cwd, includeChangedFiles: false });
  if (git.repositoryRoot) {
    println(`${symbols.ok} ${git.repository ?? git.repositoryRoot}`);
    if (git.branch) println(dim(`  branch: ${git.branch}`));
  } else {
    println(`${symbols.off} not inside a Git repository`);
  }
  println();

  println(bold('Agents'));
  for (const provider of providers) {
    const detection = await provider.detect(env);
    println();
    println(provider.displayName);
    if (!detection.detected) {
      println(`${symbols.off} not detected`);
      continue;
    }
    println(`${symbols.ok} detected ${dim(`(${detection.evidence[0] ?? ''})`)}`);
    println(detection.hooksInstalled ? `${symbols.ok} hooks installed` : `${symbols.off} hooks not installed`);
    if (provider.nativeTelemetry) {
      const setupContext: SetupContext = {
        env,
        paths: context.paths,
        config: context.config,
        hookCommand: buildHookCommand(env, provider.id),
        installState: context.installState
      };
      const otel = await provider.nativeTelemetry.inspect(setupContext);
      if (otel.configured) println(`${symbols.ok} native OpenTelemetry ${otel.detail ?? 'configured'}`);
      else if (otel.conflict) println(`${symbols.warn} native OpenTelemetry: ${otel.conflict}`);
      else println(`${symbols.off} native OpenTelemetry not configured`);
    }
  }
  println();

  println(bold('Delivery'));
  const queue = buildQueue(context);
  const deliveryStats = buildDeliveryStats(context);
  let pending = await queue.pendingCount();
  if (pending > 0 && eventsUrl(context.config)) {
    // Reasonable moment to retry: we're already out of any agent's critical path.
    const transport = buildTransport(context, 3000);
    if (transport) {
      const drained = await queue.drain(transport, context.config.delivery.drainBatchSize, deliveryStats);
      if (drained.sent > 0) println(dim(`  retried: ${drained.sent} event(s) delivered`));
      pending = await queue.pendingCount();
    }
  }
  println(pending === 0 ? `${symbols.ok} healthy` : `${symbols.warn} backlog`);
  println(`${pending} pending event(s)`);
  const stats = await deliveryStats.read();
  if (stats && stats.totalRejected > 0) {
    const last = stats.lastRejectedAt ? ` (last ${stats.lastRejectedCount} at ${stats.lastRejectedAt})` : '';
    println(`${symbols.warn} ${stats.totalRejected} event(s) permanently rejected by the backend${last}`);
  }
  if (stats && stats.totalDropped > 0) {
    const last = stats.lastDroppedAt ? ` (last ${stats.lastDroppedCount} at ${stats.lastDroppedAt})` : '';
    // Attempts exhausted, past the age bound, or unreadable on disk: whichever
    // it was, the event is gone and used to be gone silently.
    println(`${symbols.warn} ${stats.totalDropped} event(s) lost from the local queue${last}`);
    println(dim(`  the queue gives up after ${context.config.delivery.maxAttempts} attempts or ${context.config.delivery.maxEventAgeDays} day(s)`));
  }
  if (stats && stats.lastRefusalStatus > 0) {
    println(`${symbols.warn} backend last refused a batch with HTTP ${stats.lastRefusalStatus}${stats.lastRefusalAt ? ` at ${stats.lastRefusalAt}` : ''}`);
    println(dim('  a refusal is not retried on its own; check the endpoint, the token and the event schema'));
  }
  return 0;
}
