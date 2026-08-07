import { z } from 'zod';

/**
 * Privacy-first defaults: no prompt/response/tool content leaves the machine
 * unless the user opts in explicitly.
 */
export const captureSchema = z
  .object({
    prompts: z.boolean().default(false),
    responses: z.boolean().default(false),
    toolInput: z.boolean().default(false),
    toolOutput: z.boolean().default(false),
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
    maxEventAgeDays: z.number().int().positive().default(7)
  })
  .passthrough();

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
    capture: captureSchema.default({}),
    delivery: deliverySchema.default({})
  })
  .passthrough();

export type CaptureConfig = z.infer<typeof captureSchema>;
export type AgentWatchConfig = z.infer<typeof configSchema>;

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
 * exporters append /v1/metrics, /v1/logs etc. to this base.
 */
export function otlpBaseUrl(config: AgentWatchConfig): string | undefined {
  if (config.otlpUrl) return config.otlpUrl;
  if (config.endpoint) return joinUrl(config.endpoint, '/v1/otlp');
  return undefined;
}

export function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}
