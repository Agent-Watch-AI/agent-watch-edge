import { z } from 'zod';
import { asRecord } from '../../core/object.js';
import type { CONTENT_CAPTURE_KEYS } from '../constants/config.constants.js';
import {
  DELIVERABLE_URL_MESSAGE,
  URL_FIELDS,
  LOOPBACK_HOSTS,
  DEFAULT_DRAIN_BATCH_SIZE,
  DEFAULT_ENFORCEMENT_CACHE_TTL_MS,
  DEFAULT_ENFORCEMENT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_EVENT_AGE_DAYS,
  DEFAULT_MAX_QUEUE_EVENTS,
  DEFAULT_SEND_TIMEOUT_MS
} from '../constants/config.constants.js';

/**
 * The four content flags, off.
 *
 * Keyed on `CONTENT_CAPTURE_KEYS` rather than spelled loose, so a fifth content
 * flag added there fails to compile here instead of quietly escaping the gate.
 * At module scope because it is a constant, not a per-parse allocation
 * (STYLEGUIDE 3.1).
 */
const CONTENT_OFF: Readonly<Record<(typeof CONTENT_CAPTURE_KEYS)[number], false>> = {
  prompts: false,
  responses: false,
  toolInput: false,
  toolOutput: false
};

/**
 * Content is opt-IN; metadata stays on.
 *
 * The first four flags carry raw content off the machine — what the developer
 * typed, what the agent answered, what went into and came out of a tool. That
 * is the material an IT review will not wave through, so nothing ships it
 * unless someone deliberately turned it on. `git` and `files` are a different
 * kind of thing: they gate the repo/branch/SHA and the per-file *path*, which
 * is metadata about where work happened, not the work itself — and it is what
 * feature and project attribution is made of, so it stays on by default.
 *
 * Independent of all six: `contentEvidence()` still records a length and a
 * SHA-256 of prompts and responses (never the text), and the sanitizer scrubs
 * secrets from whatever does get sent.
 *
 * The four content flags are gated a second time by the global
 * `contentCaptureConsent` marker below: a config carrying `prompts: true`
 * without it collects nothing, which is what keeps an upgrade of an older
 * install from silently continuing to ship content.
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
  .strip();

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
 * A URL the edge may send a bearer and captured content to.
 *
 * `z.string().url()` alone accepts `file:`, `javascript:`, `data:`, `ftp:` and
 * plain `http:` to anywhere. Hand-editing `~/.agentwatch/config.json` is the
 * documented way to enable content capture, so one slipped character or one
 * templating bug in an MDM payload would otherwise ship
 * `Authorization: Bearer <token>` plus every captured prompt in cleartext, with
 * nothing in `setup`, `status` or `doctor` saying so.
 *
 * The check lives in the schema because the schema is what governs every
 * subsequent *load* of the file, not just the interactive path that wrote it.
 * `http:` survives for loopback only, which is what the tests and a local
 * collector need and is not a network hop anything can intercept.
 *
 * @param value - The URL as written in the file.
 * @returns True when the edge may talk to it.
 */
export function isDeliverableUrl(value: string): boolean {
  const url = parseUrl(value);

  if (!url) return false;

  if (url.protocol === 'https:') return true;

  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Parse a URL without throwing.
 *
 * @param value - Candidate URL.
 * @returns The parsed URL, or undefined when it is not one.
 */
function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Every backend URL in the file, validated the same way. One definition, so a
 * fifth URL field cannot be added without the rule.
 *
 * An offending value is *dropped*, not fatal, and the field reads as absent.
 * Failing the parse instead took the whole file down with it, and `loadConfig`
 * answers a failed parse with `fallbackConfig()` — no endpoint, no token, no
 * installation id. Two consequences, both worse than the misconfiguration:
 *
 * - An upgrade of a fleet pointed at an internal `http://collector.corp:4318`
 *   lost its *token* along with its endpoint, so every hook queued into
 *   `unconfigured/` under `ANY_DESTINATION` while the existing backlog stayed
 *   pinned to `sha256(token)` — a partition nothing would ever drain again.
 * - `roots` is a record of these same fields, so one typo in one project's
 *   entry stopped delivery for every other project on the machine.
 *
 * Dropping keeps the identity, keeps the backlog claimable, and confines the
 * damage to the field that is actually wrong. Delivery still stops for that
 * destination — which is the point: the alternative is a bearer token and
 * captured prompts in cleartext — but it stops loudly, and only there.
 * `loadConfig` reports each dropped field, the hook path warns on stderr, and
 * `doctor` and `status` name it. New values never take this path: `enrollment`
 * rejects a non-deliverable `--endpoint` outright, at the moment someone can
 * still fix it.
 */
const deliverableUrl = z
  .string()
  .url()
  .refine(isDeliverableUrl, { message: DELIVERABLE_URL_MESSAGE })
  .optional()
  .catch(undefined);

/**
 * Which fields of a config object hold a URL the edge refuses to talk to.
 *
 * Read from the *raw* value, because the schema has already dropped them by the
 * time anything can be said about it. Reported by `loadConfig`, so a dropped
 * field is a line on stderr and in `doctor` rather than a silent stop.
 *
 * @param value - The parsed JSON of the config file, whatever shape it has.
 * @returns Dotted paths of the offending fields, empty when there are none.
 */
export function nonDeliverableUrlFields(value: unknown): string[] {
  const found: string[] = [];
  const record = asRecord(value);

  if (!record) return found;

  collectNonDeliverable(record, '', found);

  for (const [root, override] of Object.entries(asRecord(record['roots']) ?? {})) {
    const entry = asRecord(override);

    if (entry) collectNonDeliverable(entry, `roots.${root}.`, found);
  }

  return found;
}

/**
 * Append the offending URL fields of one flat object.
 *
 * @param record - The config or one `roots[]` entry.
 * @param prefix - Dotted prefix for the reported path.
 * @param found - Accumulator.
 */
function collectNonDeliverable(record: Record<string, unknown>, prefix: string, found: string[]): void {
  for (const field of URL_FIELDS) {
    const value = record[field];

    if (typeof value === 'string' && !isDeliverableUrl(value)) found.push(`${prefix}${field}`);
  }
}

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
    endpoint: deliverableUrl,
    eventsUrl: deliverableUrl,
    otlpUrl: deliverableUrl,
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
    endpoint: deliverableUrl,
    /** Overrides; derived from endpoint when absent. */
    eventsUrl: deliverableUrl,
    otlpUrl: deliverableUrl,
    enforcementUrl: deliverableUrl,
    token: z.string().optional(),
    installationId: z.string().optional(),
    /** Developer identity attached to turn summaries; falls back to `git config user.email`. */
    developerEmail: z.string().optional(),
    /**
     * Absolute project root -> the identity to use beneath it. Longest match
     * wins, so a nested checkout can override the workspace above it.
     */
    roots: z.record(z.string(), rootOverrideSchema).optional(),
    contentCaptureConsent: z.boolean().default(false),
    capture: captureSchema.default({}),
    emit: emitSchema.default({}),
    otel: otelSchema.default({}),
    delivery: deliverySchema.default({}),
    enforcement: enforcementSchema.default({})
  })
  .passthrough()
  .transform((config) => ({
    ...config,
    capture: config.contentCaptureConsent ? config.capture : { ...config.capture, ...CONTENT_OFF }
  }));
