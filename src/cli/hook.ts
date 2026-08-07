import process from 'node:process';
import type { Env } from '../core/env.js';
import { debugLog, warnLog } from '../core/logger.js';
import { getProvider } from '../providers/registry.js';
import { enrichEvents } from '../events/enrich.js';
import { deliverEvents } from '../transport/delivery.js';
import { buildCliContext, buildQueue, buildTransport } from './context.js';

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
  const context = await buildCliContext(options.env);
  const events = await provider.parseHookEvent(rawPayload, { env: options.env, config: context.config });
  if (events.length === 0) {
    debugLog('no canonical events produced');
    return;
  }
  const payloadCwd = typeof (rawPayload as Record<string, unknown>)?.['cwd'] === 'string' ? ((rawPayload as Record<string, unknown>)['cwd'] as string) : options.env.cwd;
  const enriched = await enrichEvents(events, { config: context.config, cwd: payloadCwd });

  if (options.dryRun) {
    const writeStdout = options.writeStdout ?? ((text: string) => process.stdout.write(text));
    writeStdout(JSON.stringify({ events: enriched }, null, 2) + '\n');
    return;
  }

  const queue = buildQueue(context);
  const transport = buildTransport(context);
  const outcome = await deliverEvents(enriched, transport, queue, context.config.delivery.drainBatchSize);
  debugLog(`delivery: sent=${outcome.delivered} queued=${outcome.queued} drained=${outcome.drained}`);
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
