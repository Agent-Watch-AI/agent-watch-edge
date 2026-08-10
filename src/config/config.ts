import { z } from 'zod';

/**
 * Everything is captured by default so the backend gets full turn context
 * (prompts, responses, tool I/O, tokens); users opt out per field.
 * Secrets are still scrubbed by the sanitizer regardless of these flags.
 */
export const captureSchema = z
  .object({
    prompts: z.boolean().default(true),
    responses: z.boolean().default(true),
    toolInput: z.boolean().default(true),
    toolOutput: z.boolean().default(true),
    git: z.boolean().default(true),
    files: z.boolean().default(true)
  })
  .passthrough();

export const deliverySchema = z
  .object({
    /** Budget for the in-hook direct send. Keep small: we are on the agent's critical path. */
    timeoutMs: z.number().int().positive().default(1500),
    /** How many queued events one drain pass may send. */
    drainBatchSize: z.number().int().positive().default(25),
    maxQueueEvents: z.number().int().positive().default(2000),
    maxAttempts: z.number().int().positive().default(20),
    maxEventAgeDays: z.number().int().positive().default(7),
  })
  .strip();

/**
 * Which native OTLP signals agents export straight to the backend. Logs are
 * the per-request usage/cost ledger the backend turns into llm.call — the
 * default. Traces add latency/subagent spans, metrics add aggregate
 * counters (cost, tokens, active time); both are off unless asked for.
 */
export const otelSchema = z
  .object({
    logs: z.boolean().default(true),
    traces: z.boolean().default(false),
    metrics: z.boolean().default(false)
  })
  .strip();

export const emitSchema = z
  .object({
    /** One flat summary per prompt→response turn, emitted on Stop. */
    turnSummaries: z.boolean().default(true),
    /**
     * Every provider request is mandatory: it is the lossless usage ledger.
     * Accept a legacy `false` on input, but migrate that field to `true`
     * instead of invalidating the entire global config.
     */
    llmCalls: z.boolean().default(true).transform(() => true as const)
  })
  .strip();

export const configSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    /** Backend base URL, e.g. https://backend.example.com */
    endpoint: z.string().url().optional(),
    /** Overrides; derived from endpoint when absent. */
    eventsUrl: z.string().url().optional(),
    otlpUrl: z.string().url().optional(),
    token: z.string().optional(),
    installationId: z.string().optional(),
    /** Developer identity attached to turn summaries; falls back to `git config user.email`. */
    developerEmail: z.string().optional(),
    capture: captureSchema.default({}),
    emit: emitSchema.default({}),
    otel: otelSchema.default({}),
    delivery: deliverySchema.default({})
  })
  .passthrough();

export type CaptureConfig = z.infer<typeof captureSchema>;
export type OtelConfig = z.infer<typeof otelSchema>;
export type AgentWatchConfig = z.infer<typeof configSchema>;

/** True when at least one native OTLP signal is enabled. */
export function otelEnabled(config: AgentWatchConfig): boolean {
  return config.otel.logs || config.otel.traces || config.otel.metrics;
}

/** Names of the enabled OTLP signals, for setup/status messages. */
export function enabledSignalNames(otel: OtelConfig): string[] {
  return (['logs', 'traces', 'metrics'] as const).filter((name) => otel[name]);
}

/**
 * Parse the `--otel` CLI value: "all", "none", or a comma list of
 * logs/traces/metrics. Returns undefined on any unknown signal name.
 */
export function parseOtelSignals(value: string): OtelConfig | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'all') return { logs: true, traces: true, metrics: true };
  if (normalized === 'none') return { logs: false, traces: false, metrics: false };
  const signals: OtelConfig = { logs: false, traces: false, metrics: false };
  for (const part of normalized.split(',')) {
    const name = part.trim();
    if (name === '') continue;
    if (name !== 'logs' && name !== 'traces' && name !== 'metrics') return undefined;
    signals[name] = true;
  }
  return signals;
}

export function defaultConfig(): AgentWatchConfig {
  return configSchema.parse({});
}

export function eventsUrl(config: AgentWatchConfig): string | undefined {
  if (config.eventsUrl) return config.eventsUrl;
  if (config.endpoint) return joinUrl(config.endpoint, '/v1/events');
  return undefined;
}

/**
 * Base URL agents' native OTLP exporters point at. Standard OTLP/HTTP
 * exporters append /v1/metrics, /v1/logs and /v1/traces to this base.
 */
export function otlpBaseUrl(config: AgentWatchConfig): string | undefined {
  if (config.otlpUrl) return config.otlpUrl;
  if (config.endpoint) return joinUrl(config.endpoint, '/v1/otlp');
  return undefined;
}

export function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}
