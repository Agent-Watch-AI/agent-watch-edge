import process from 'node:process';
import type { Env } from '../core/env.js';
import { debugLog, warnLog } from '../core/logger.js';
import { getProvider } from '../providers/registry.js';
import { loadEffectiveConfig } from '../config/repo-config.js';
import { enrichEvents } from '../events/enrich.js';
import { trackTurn } from '../turns/turn-tracker.js';
import type { TurnSummaryEvent } from '../turns/turn-summary.js';
import { deliverEvents } from '../transport/delivery.js';
import { BackendCooldown } from '../transport/cooldown.js';
import path from 'node:path';
import { buildCliContext, buildDeliveryStats, buildQueue, buildTransport } from './context.js';

const MAX_STDIN_BYTES = 10 * 1024 * 1024;
const STDIN_TIMEOUT_MS = 5000;

export interface HookRunOptions {
  env: Env;
  /** Raw stdin payload; tests inject a string instead of reading process.stdin. */
  input?: string;
  dryRun?: boolean;
  writeStdout?: (text: string) => void;
}

/**
 * The hook fast path: read → normalize → enrich → deliver/enqueue → respond →
 * exit. This runs inside the coding agent's critical path, so it must be
 * quick, and it must NEVER fail the agent: any internal error degrades to the
 * provider's safe no-op response with exit code 0.
 */
export async function runHook(agentId: string, options: HookRunOptions): Promise<number> {
  const writeStdout = options.writeStdout ?? ((text: string) => process.stdout.write(text));
  const provider = getProvider(agentId);
  if (!provider) {
    warnLog(`unknown agent "${agentId}"; passing through`);
    return 0;
  }

  let exitCode = 0;
  let rawPayload: unknown;
  try {
    const input = options.input ?? (await readStdin());
    rawPayload = input.trim() === '' ? {} : JSON.parse(input);
  } catch (error) {
    debugLog('failed to read/parse hook payload:', error);
    rawPayload = undefined;
  }

  try {
    const response = provider.getHookResponse(rawPayload);
    if (rawPayload !== undefined) {
      await processPayload(agentId, rawPayload, options);
    }
    if (response.stdout) writeStdout(response.stdout);
    exitCode = response.exitCode;
  } catch (error) {
    // Telemetry must never break the coding agent.
    debugLog('hook processing failed:', error);
    exitCode = 0;
  }
  return exitCode;
}

async function processPayload(agentId: string, rawPayload: unknown, options: HookRunOptions): Promise<void> {
  const provider = getProvider(agentId);
  if (!provider) return;
  const baseContext = await buildCliContext(options.env);
  const payloadCwd = typeof (rawPayload as Record<string, unknown>)?.['cwd'] === 'string' ? ((rawPayload as Record<string, unknown>)['cwd'] as string) : options.env.cwd;
  // Repository-level .agentwatch.json overrides the global config for
  // content capture derived from this payload; identity, endpoints, emission
  // toggles and delivery tuning stay global-only.
  const effective = await loadEffectiveConfig(baseContext.paths, payloadCwd);
  const context = { ...baseContext, config: effective.config };

  const events = await provider.parseHookEvent(rawPayload, { env: options.env, config: context.config });
  if (events.length === 0) {
    debugLog('no canonical events produced');
    return;
  }
  const enriched = await enrichEvents(events, { config: context.config, cwd: payloadCwd, home: options.env.home });

  // Lifecycle events are internal assembly state. Only turn.summary leaves
  // this path; llm.call records arrive through the native OTLP path.
  const outbound: TurnSummaryEvent[] = [];
  // Turn tracking always runs: besides producing the summary it resolves
  // token usage and mirrors it onto the raw generation.completed event.
  try {
    const summary = await trackTurn({
      agentId,
      rawPayload,
      events: enriched,
      config: context.config,
      turnsDir: context.paths.turnsDir,
      locksDir: context.paths.locksDir,
      env: options.env,
      cwd: payloadCwd,
      readOnly: options.dryRun === true
    });
    if (summary && context.config.emit.turnSummaries) outbound.push(summary);
  } catch (error) {
    debugLog('turn summary failed:', error);
  }

  if (options.dryRun) {
    const writeStdout = options.writeStdout ?? ((text: string) => process.stdout.write(text));
    writeStdout(JSON.stringify({ events: outbound }, null, 2) + '\n');
    return;
  }
  const queue = buildQueue(context);
  const transport = buildTransport(context);
  const cooldown = new BackendCooldown(path.join(context.paths.dataDir, 'backend-cooldown.json'), options.env.now);
  const stats = buildDeliveryStats(context);
  const outcome = await deliverEvents(outbound, transport, queue, context.config.delivery.drainBatchSize, cooldown, stats);
  debugLog(`delivery: sent=${outcome.delivered} queued=${outcome.queued} drained=${outcome.drained} rejected=${outcome.rejected}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }, STDIN_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        cleanup();
        reject(new Error('hook payload exceeds size limit'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}
