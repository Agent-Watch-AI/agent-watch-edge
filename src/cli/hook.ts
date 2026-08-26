import process from 'node:process';
import { loadConfig } from '../config/config-store.js';
import { debugLog, warnLog } from '../core/logger.js';
import { runHookPipeline } from '../pipeline/hook-pipeline.js';
import type { HookPipelineState } from '../pipeline/types/pipeline.types.js';
import { getProvider } from '../providers/registry.js';
import type { AgentProvider, ProviderHookResponse } from '../providers/types/provider.types.js';
import { resolvePaths } from '../storage/paths.js';
import { MAX_STDIN_BYTES, STDIN_TIMEOUT_MS } from './constants/cli.constants.js';
import type { HookRunOptions } from './types/cli.types.js';

export type { HookRunOptions } from './types/cli.types.js';

/**
 * The `hook` command: read stdin, run the flow, answer the agent.
 *
 * This runs inside the coding agent's critical path, and it must NEVER fail the
 * agent. Every failure — an unknown agent, an unreadable payload, a broken
 * config, a stage that throws — degrades to the provider's safe response with
 * exit code 0. Telemetry is worth strictly less than the developer's session.
 *
 * The one answer that is not passive comes from the flow: when the platform
 * explicitly refused this developer's turn, the provider's own refusal is
 * written instead of silence. It is still exit code 0 — a refusal the agent
 * understands, not a hook that failed.
 *
 * @param agentId - Value of `--agent`.
 * @param options - Environment, injected stdin, dry-run flag, stdout sink.
 * @returns The process exit code; always one the agent tolerates.
 */
export async function runHook(agentId: string, options: HookRunOptions): Promise<number> {
  const provider = getProvider(agentId);

  if (!provider) {
    warnLog(`unknown agent "${agentId}"; passing through`);

    return 0;
  }

  const payload = await readPayload(options);

  try {
    const result = payload === undefined ? undefined : await processPayload(provider, payload, options);
    const response = respondToDecision(provider, payload, result);

    if (response.stdout) writeStdout(options, response.stdout);

    return response.exitCode;
  } catch (error) {
    // Telemetry must never break the coding agent.
    debugLog('hook processing failed:', error);

    return 0;
  }
}

/**
 * What to answer the agent with.
 *
 * The provider's passive response unless the flow came back carrying a refusal
 * *and* the provider knows how to express one for this hook. A provider that
 * returns nothing is not overridden into silence-plus-block: no refusal is sent
 * on a protocol whose contract for it is unverified.
 *
 * @param provider - The agent's provider.
 * @param payload - Decoded hook payload.
 * @param result - Final flow state, when the payload was processed.
 * @returns The response to write.
 */
function respondToDecision(provider: AgentProvider, payload: unknown, result?: HookPipelineState): ProviderHookResponse {
  const message = result?.blockMessage;

  if (message === undefined) return provider.getHookResponse(payload);

  const refusal = provider.getBlockResponse?.(payload, message);

  if (!refusal) return provider.getHookResponse(payload);

  // The agent shows `message` through its own protocol, but a prompt that
  // vanishes with its explanation buried in a transcript view is a support
  // ticket: say it on stderr too.
  warnLog(message);

  return refusal;
}

/**
 * Run one payload through the hook flow and print a dry run's result.
 *
 * @param provider - The agent's provider.
 * @param payload - Decoded hook payload.
 * @param options - Environment, dry-run flag and stdout sink.
 * @returns The flow's final state.
 */
async function processPayload(provider: AgentProvider, payload: unknown, options: HookRunOptions): Promise<HookPipelineState> {
  const paths = resolvePaths(options.env);
  const loaded = await loadConfig(paths);
  const result = await runHookPipeline({
    provider,
    env: options.env,
    paths,
    globalConfig: loaded.config,
    payload,
    dryRun: options.dryRun === true
  });

  if (options.dryRun) writeStdout(options, JSON.stringify({ events: result.state.outbound }, null, 2) + '\n');

  return result.state;
}

/**
 * Decode the hook payload.
 *
 * An empty payload is a valid `{}` — some hooks fire with no body — while an
 * unreadable one becomes undefined, which tells the caller to answer the agent
 * without processing anything.
 *
 * @param options - Environment and injected stdin.
 * @returns The decoded payload, or undefined.
 */
async function readPayload(options: HookRunOptions): Promise<unknown> {
  try {
    const input = options.input ?? (await readStdin());

    return input.trim() === '' ? {} : JSON.parse(input);
  } catch (error) {
    debugLog('failed to read/parse hook payload:', error);

    return undefined;
  }
}

/**
 * Write to the hook's stdout.
 *
 * @param options - Carries the injectable sink.
 * @param text - Exactly what the agent's protocol expects.
 */
function writeStdout(options: HookRunOptions, text: string): void {
  const write = options.writeStdout ?? ((value: string) => process.stdout.write(value));

  write(text);
}

/**
 * Read stdin to the end, bounded by size and time.
 *
 * Both bounds exist because the writer is the agent, not us: a hook that waited
 * forever, or buffered an unbounded payload, would take the agent's session
 * down with it.
 *
 * @returns The payload text; whatever arrived, if the timeout fires first.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const cleanup = (): void => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };
    const finish = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;

      if (size > MAX_STDIN_BYTES) {
        cleanup();
        reject(new Error('hook payload exceeds size limit'));

        return;
      }

      chunks.push(chunk);
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}
