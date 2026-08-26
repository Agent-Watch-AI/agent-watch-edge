import { z } from 'zod';
import {
  DEFAULT_DRAIN_BATCH_SIZE,
  DEFAULT_ENFORCEMENT_CACHE_TTL_MS,
  DEFAULT_ENFORCEMENT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_EVENT_AGE_DAYS,
  DEFAULT_MAX_QUEUE_EVENTS,
  DEFAULT_SEND_TIMEOUT_MS
} from '../constants/config.constants.js';

/**
 * Everything is captured by default so the backend gets full turn context
 * (prompts, responses, tool I/O, tokens); users opt out per field. Secrets are
 * still scrubbed by the sanitizer regardless of these flags.
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

/** Tuning for the in-hook send and the machine-global offline queue. */
export const deliverySchema = z
  .object({
    /** Budget for the in-hook direct send. Keep small: we are on the agent's critical path. */
    timeoutMs: z.number().int().positive().default(DEFAULT_SEND_TIMEOUT_MS),
    /** How many queued events one drain pass may send. */
    drainBatchSize: z.number().int().positive().default(DEFAULT_DRAIN_BATCH_SIZE),
    maxQueueEvents: z.number().int().positive().default(DEFAULT_MAX_QUEUE_EVENTS),
    maxAttempts: z.number().int().positive().default(DEFAULT_MAX_ATTEMPTS),
    maxEventAgeDays: z.number().int().positive().default(DEFAULT_MAX_EVENT_AGE_DAYS)
  })
  .strip();

/**
 * Which native OTLP signals agents export straight to the backend. Logs are
 * the per-request usage/cost ledger the backend turns into llm.call — the
 * default. Traces add latency/subagent spans, metrics add aggregate counters
 * (cost, tokens, active time); both are off unless asked for.
 */
export const otelSchema = z
  .object({
    logs: z.boolean().default(true),
    traces: z.boolean().default(false),
    metrics: z.boolean().default(false)
  })
  .strip();

/**
 * The pre-turn budget check.
 *
 * On by default: a cap a tenant marked `block` in the dashboard is meant to
 * block, and a guardrail nobody switched on is the same notification nobody
 * acted on. Only an explicit refusal from the platform ever stops a turn — see
 * `src/enforcement/enforcement.ts` — so leaving it on costs a developer one
 * bounded request per turn and nothing else.
 */
export const enforcementSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Hard ceiling for the check; it sits between enter and the agent's first call. */
    timeoutMs: z.number().int().positive().default(DEFAULT_ENFORCEMENT_TIMEOUT_MS),
    /** Mirrors the platform's own cache TTL for the same decision. */
    cacheTtlMs: z.number().int().positive().default(DEFAULT_ENFORCEMENT_CACHE_TTL_MS)
  })
  .strip();

/** Which records the edge itself emits. */
export const emitSchema = z
  .object({
    /** One flat summary per prompt→response turn, emitted on Stop. */
    turnSummaries: z.boolean().default(true),
    /**
     * Every provider request is mandatory: it is the lossless usage ledger.
     * Accept a legacy `false` on input, but migrate that field to `true`
     * instead of invalidating the entire global config.
     */
    llmCalls: z
      .boolean()
      .default(true)
      .transform(() => true as const)
  })
  .strip();

/**
 * One project root's identity. Only the fields that decide *who* the events
 * belong to and *where* they go: capture and emission stay machine-wide, so a
 * second tenant cannot quietly widen what is collected under it.
 *
 * `.strip()` rather than passthrough, so a nested `roots` key cannot recurse
 * and a mistyped block cannot smuggle in delivery tuning.
 */
export const rootOverrideSchema = z
  .object({
    endpoint: z.string().url().optional(),
    eventsUrl: z.string().url().optional(),
    otlpUrl: z.string().url().optional(),
    token: z.string().optional(),
    installationId: z.string().optional(),
    developerEmail: z.string().optional()
  })
  .strip();

/** The whole configuration file. Passthrough: forward compatibility. */
export const configSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    /** Backend base URL, e.g. https://backend.example.com */
    endpoint: z.string().url().optional(),
    /** Overrides; derived from endpoint when absent. */
    eventsUrl: z.string().url().optional(),
    otlpUrl: z.string().url().optional(),
    enforcementUrl: z.string().url().optional(),
    token: z.string().optional(),
    installationId: z.string().optional(),
    /** Developer identity attached to turn summaries; falls back to `git config user.email`. */
    developerEmail: z.string().optional(),
    /**
     * Absolute project root -> the identity to use beneath it. Longest match
     * wins, so a nested checkout can override the workspace above it.
     */
    roots: z.record(z.string(), rootOverrideSchema).optional(),
    capture: captureSchema.default({}),
    emit: emitSchema.default({}),
    otel: otelSchema.default({}),
    delivery: deliverySchema.default({}),
    enforcement: enforcementSchema.default({})
  })
  .passthrough();
