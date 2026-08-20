/**
 * OTLP/JSON -> llm.call.
 *
 * Exported as `@agentwatch-ai/bridge/otlp` for a backend that wants to decode
 * agent telemetry itself. The AgentWatch platform has its own copy of this
 * logic in `@agent-watch/otlp`, and the two have to be changed together:
 * provider detection, the completed-request filter and the usage attribute
 * names are the parts that silently disagree when they drift. All three now
 * live in `constants/otlp.constants.ts`, which is the file to diff.
 */
import { asArray, asRecord, firstNumber, firstString } from '../core/object.js';
import { buildLlmCall } from '../events/llm-call.js';
import { sha256Hex } from '../events/event-id.js';
import type { UsageBillingMode } from '../events/types/events.types.js';
import type { LlmCallCorrelation, LlmCallEvent } from '../events/types/llm-call.types.js';
import {
  AGENT_ID_KEYS,
  AGENT_TYPE_KEYS,
  BILLING_MODE_KEYS,
  CACHED_INPUT_TOKEN_KEYS,
  CACHE_CREATION_TOKEN_KEYS,
  CANONICAL_PROVIDER_NAMES,
  CLAUDE_SESSION_KEYS,
  CODEX_SESSION_KEYS,
  COST_KEYS,
  DEFAULT_SURFACE,
  DERIVED_CALL_ID_HEX_LENGTH,
  DERIVED_CALL_ID_PREFIX,
  DURATION_KEYS,
  ERROR_KEYS,
  EVENT_NAME_KEYS,
  EVENT_TYPE_KEYS,
  GEMINI_SYSTEM_VALUES,
  GENERIC_SESSION_KEYS,
  INPUT_TOKEN_KEYS,
  LOG_RECORDS_KEY,
  MODEL_KEYS,
  NANOS_PER_MILLI,
  OTLP_VALUE_KEYS,
  OUTPUT_TOKEN_KEYS,
  PROVIDER_SYSTEM_KEYS,
  REASONING_TOKEN_KEYS,
  REQUEST_ID_KEYS,
  RESOURCE_LOGS_KEY,
  RE_API_REQUEST,
  RE_CLAUDE_EVENT,
  RE_CODEX_COMPLETED,
  RE_CODEX_EVENT,
  RE_GEMINI_COMPLETED,
  RE_GEMINI_EVENT,
  RE_RESPONSE_COMPLETED,
  SCOPE_LOGS_KEY,
  SEQUENCE_KEYS,
  SPAN_ID_KEYS,
  THREAD_KEYS,
  TIMESTAMP_KEYS,
  TIME_NANO_KEYS,
  TOTAL_TOKEN_KEYS,
  TRACE_ID_KEYS,
  TURN_KEYS,
  UNSET_TIME_VALUES
} from './constants/otlp.constants.js';
import type { Attributes, NormalizeOtlpOptions, OtlpProvider, OtlpUsage, RecordIdentity } from './types/otlp.types.js';

export type { DecodedOtlpJson, NormalizeOtlpOptions, OtlpCallIdentity, OtlpCorrelationContext, OtlpHttpSignal } from './types/otlp.types.js';

/**
 * Normalize OTLP/JSON logs into the only atomic usage record: llm.call.
 *
 * Duplicate OTLP delivery is safe because call ids and event ids are stable;
 * the backend must upsert on call_id, scoped by provider.
 *
 * @param payload - A decoded OTLP/JSON logs envelope.
 * @param options - Correlation lookup and the batch's ingest time.
 * @returns One llm.call per usable record, in envelope order.
 */
export function normalizeOtlpLogs(payload: unknown, options: NormalizeOtlpOptions = {}): LlmCallEvent[] {
  const root = asRecord(payload);
  const calls: LlmCallEvent[] = [];

  for (const resource of asArray(root?.[RESOURCE_LOGS_KEY])) {
    const resourceRecord = asRecord(resource);
    const resourceAttributes = attributes(asRecord(resourceRecord?.['resource'])?.['attributes']);

    for (const scope of asArray(resourceRecord?.[SCOPE_LOGS_KEY])) {
      for (const log of asArray(asRecord(scope)?.[LOG_RECORDS_KEY])) {
        const normalized = normalizeOne(asRecord(log), resourceAttributes, options);

        if (normalized) calls.push(normalized);
      }
    }
  }

  return calls;
}

/**
 * Normalize one log record, swallowing anything it throws.
 *
 * One malformed record must never abort the batch: every other call's usage and
 * cost would silently vanish from the ledger with it.
 *
 * @param logRecord - The record, or undefined when the entry was not an object.
 * @param resourceAttributes - Attributes inherited from the resource.
 * @param options - Correlation lookup and the batch's ingest time.
 * @returns The call, or undefined.
 */
function normalizeOne(logRecord: Attributes | undefined, resourceAttributes: Attributes, options: NormalizeOtlpOptions): LlmCallEvent | undefined {
  if (!logRecord) return undefined;

  try {
    return normalizeLogRecord(logRecord, { ...resourceAttributes, ...attributes(logRecord['attributes']) }, options);
  } catch {
    return undefined;
  }
}

/**
 * Turn one recognized, completed provider request into an llm.call.
 *
 * @param log - The raw log record.
 * @param attrs - Its attributes, merged with the resource's.
 * @param options - Correlation lookup and the batch's ingest time.
 * @returns The call, or undefined when the record is not one.
 */
function normalizeLogRecord(log: Attributes, attrs: Attributes, options: NormalizeOtlpOptions): LlmCallEvent | undefined {
  const identity = readIdentity(log, attrs, options);

  if (!identity) return undefined;

  const correlated = options.correlate?.({
    provider: identity.provider,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    threadId: identity.threadId,
    agentId: identity.observedAgentId,
    agentType: identity.observedAgentType,
    endedAt: identity.endedAt
  });
  const productSessionId = correlated?.sessionId ?? identity.sessionId;
  const productTurnId = correlated?.turnId ?? identity.turnId;
  const durationMs = firstNumber(attrs, DURATION_KEYS);

  return buildLlmCall({
    provider: CANONICAL_PROVIDER_NAMES[identity.provider] ?? identity.provider,
    surface: correlated?.surface ?? DEFAULT_SURFACE,
    callId: identity.callId,
    providerRequestId: identity.requestId,
    // Only report the native scope when correlation actually replaced it.
    providerSessionId: productSessionId !== identity.sessionId ? identity.sessionId : undefined,
    providerTurnId: productTurnId !== identity.turnId ? identity.turnId : undefined,
    sessionId: productSessionId,
    turnId: productTurnId,
    agentId: correlated?.agentId ?? identity.observedAgentId,
    parentAgentId: correlated?.parentAgentId,
    agentType: correlated?.agentType ?? identity.observedAgentType,
    model: firstString(attrs, MODEL_KEYS),
    billingMode: correlated?.billingMode ?? billingMode(attrs),
    status: firstString(attrs, ERROR_KEYS) ? 'failed' : 'completed',
    correlation: correlationLevel(correlated?.turnId, productTurnId),
    usage: readUsage(attrs),
    costUsd: firstNumber(attrs, COST_KEYS),
    durationMs,
    startedAt: derivedStartedAt(identity.endedAt, durationMs),
    endedAt: identity.endedAt,
    git: correlated?.git,
    featureCandidates: correlated?.featureCandidates
  });
}

/**
 * Everything identifying a record, or undefined when it is not a usable one.
 *
 * @param log - The raw log record.
 * @param attrs - Its merged attributes.
 * @param options - Supplies the ingest-time fallback.
 * @returns The identity, or undefined.
 */
function readIdentity(log: Attributes, attrs: Attributes, options: NormalizeOtlpOptions): RecordIdentity | undefined {
  const eventName = firstString(attrs, EVENT_NAME_KEYS) ?? bodyString(log['body']);
  const eventType = firstString(attrs, EVENT_TYPE_KEYS);
  const provider = detectProvider(eventName, eventType, attrs);

  if (!provider || !isCompletedLlmRequest(provider, attrs, eventName, eventType)) return undefined;

  const endedAt = otlpTimestamp(log) ?? firstString(attrs, TIMESTAMP_KEYS) ?? options.receivedAt;

  if (!endedAt) return undefined;

  const sessionId = firstString(attrs, provider === 'claude' ? CLAUDE_SESSION_KEYS : GENERIC_SESSION_KEYS);
  const turnId = firstString(attrs, TURN_KEYS);
  const threadId = firstString(attrs, THREAD_KEYS);
  const requestId = firstString(attrs, REQUEST_ID_KEYS);
  const sequence = firstString(attrs, SEQUENCE_KEYS);
  const traceId = firstString(log, TRACE_ID_KEYS);
  const spanId = firstString(log, SPAN_ID_KEYS);

  return {
    provider,
    endedAt,
    sessionId,
    turnId,
    threadId,
    requestId,
    callId: requestId ?? traceIdAndSpan(traceId, spanId) ?? stableFallback(provider, sessionId, turnId, sequence, endedAt, log, attrs),
    // Codex identifies a child agent by its thread rather than an agent id.
    observedAgentId: firstString(attrs, AGENT_ID_KEYS) ?? (provider === 'codex' ? threadId : undefined),
    observedAgentType: firstString(attrs, AGENT_TYPE_KEYS)
  };
}

/**
 * Token counts, under every name an agent gives them.
 *
 * @param attrs - Merged attributes.
 * @returns The usage; every field undefined when nothing was reported.
 */
function readUsage(attrs: Attributes): OtlpUsage {
  return {
    inputTokens: firstNumber(attrs, INPUT_TOKEN_KEYS),
    cachedInputTokens: firstNumber(attrs, CACHED_INPUT_TOKEN_KEYS),
    cacheCreationInputTokens: firstNumber(attrs, CACHE_CREATION_TOKEN_KEYS),
    outputTokens: firstNumber(attrs, OUTPUT_TOKEN_KEYS),
    reasoningOutputTokens: firstNumber(attrs, REASONING_TOKEN_KEYS),
    totalTokens: firstNumber(attrs, TOTAL_TOKEN_KEYS)
  };
}

/**
 * Which agent produced a record.
 *
 * @param eventName - Its event name, when it has one.
 * @param eventType - Its event type, when it has one.
 * @param attrs - Merged attributes.
 * @returns The provider, or undefined when the record is not an agent's.
 */
function detectProvider(eventName: string | undefined, eventType: string | undefined, attrs: Attributes): OtlpProvider | undefined {
  const names = `${eventName ?? ''} ${eventType ?? ''}`;

  if (isGeminiLog(names, attrs)) return 'gemini';

  // The `codex.` / `codex_` prefix is unambiguous — no other agent produces it —
  // so a conversation or thread id is not needed to claim the record.
  if (RE_CODEX_EVENT.test(names)) return 'codex';

  // `response.completed` is generic; there a session attribute is what stops
  // another provider's record being misclassified.
  if (RE_RESPONSE_COMPLETED.test(names) && firstString(attrs, CODEX_SESSION_KEYS)) return 'codex';

  if (RE_CLAUDE_EVENT.test(names) && firstString(attrs, CLAUDE_SESSION_KEYS)) return 'claude';

  // Older Claude logs may use the bare event name. That generic alias must not
  // steal a provider-qualified Codex record that also carries a compatibility
  // session.id attribute.
  const bareApiRequest = eventName === 'api_request' || eventType === 'api_request';

  if (bareApiRequest && firstString(attrs, CLAUDE_SESSION_KEYS) && !firstString(attrs, CODEX_SESSION_KEYS)) return 'claude';

  return undefined;
}

/**
 * Whether a record is Gemini's.
 *
 * @param names - Event name and type, joined.
 * @param attrs - Merged attributes.
 * @returns True when it is.
 */
function isGeminiLog(names: string, attrs: Attributes): boolean {
  if (RE_GEMINI_EVENT.test(names)) return true;

  const system = firstString(attrs, PROVIDER_SYSTEM_KEYS);

  return system !== undefined && GEMINI_SYSTEM_VALUES.has(system);
}

/**
 * Whether a record represents a request that actually consumed tokens.
 *
 * @param provider - The detected provider.
 * @param attrs - Merged attributes.
 * @param eventName - Its event name, when it has one.
 * @param eventType - Its event type, when it has one.
 * @returns True when the record should become an llm.call.
 */
function isCompletedLlmRequest(provider: OtlpProvider, attrs: Attributes, eventName?: string, eventType?: string): boolean {
  const names = `${eventName ?? ''} ${eventType ?? ''}`;

  if (provider === 'claude') return RE_API_REQUEST.test(names);

  if (provider === 'gemini') return isCompletedGeminiRequest(names, attrs);

  return RE_CODEX_COMPLETED.test(names);
}

/**
 * Whether a Gemini record is the *completion* half of a call.
 *
 * Gemini splits a call across a request record and a response record, and only
 * the response carries token counts, so counting the request too would double
 * every Gemini call. An error is still a call that happened. An unfamiliar name
 * is admitted only when the record actually reports usage.
 *
 * @param names - Event name and type, joined.
 * @param attrs - Merged attributes.
 * @returns True when the record should become an llm.call.
 */
function isCompletedGeminiRequest(names: string, attrs: Attributes): boolean {
  if (RE_API_REQUEST.test(names)) return false;

  if (RE_GEMINI_COMPLETED.test(names)) return true;

  return names.trim() === '' || reportsUsage(attrs);
}

/**
 * Whether any token count is present.
 *
 * @param attrs - Merged attributes.
 * @returns True when at least one usage field was reported.
 */
function reportsUsage(attrs: Attributes): boolean {
  return Object.values(readUsage(attrs)).some((value) => value !== undefined);
}

/**
 * Flatten an OTLP attribute list into a keyed record.
 *
 * @param value - The `attributes` array of a resource or record.
 * @returns The flattened attributes.
 */
function attributes(value: unknown): Attributes {
  const out: Attributes = {};

  for (const item of asArray(value)) {
    const record = asRecord(item);
    const key = record?.['key'];

    if (typeof key !== 'string' || key === '') continue;

    out[key] = otlpValue(record?.['value']);
  }

  return out;
}

/**
 * Unwrap an OTLP AnyValue.
 *
 * @param value - The wrapped value.
 * @returns The primitive, or undefined for an unsupported wrapper.
 */
function otlpValue(value: unknown): unknown {
  const record = asRecord(value);

  if (!record) return undefined;

  for (const key of OTLP_VALUE_KEYS) {
    if (record[key] !== undefined) return record[key];
  }

  return undefined;
}

/**
 * A record's own timestamp, as an ISO string.
 *
 * proto3 JSON encodes an unset uint64 as `"0"`, which is not nullish: it has to
 * fall through to the collector-observed time rather than become 1970 and push
 * the call outside every aggregation window.
 *
 * @param log - The raw log record.
 * @returns The timestamp, or undefined when it has no usable one.
 */
function otlpTimestamp(log: Attributes): string | undefined {
  const raw = TIME_NANO_KEYS.map((key) => log[key]).find(
    (value): value is string | number => (typeof value === 'string' || typeof value === 'number') && !UNSET_TIME_VALUES.has(value)
  );

  if (raw === undefined) return undefined;

  try {
    return new Date(Number(BigInt(raw) / NANOS_PER_MILLI)).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * The `body.stringValue` of a record, when it has one.
 *
 * @param value - The record's body.
 * @returns The string, or undefined.
 */
function bodyString(value: unknown): string | undefined {
  const record = asRecord(value);

  return typeof record?.['stringValue'] === 'string' ? (record['stringValue'] as string) : undefined;
}

/**
 * Billing mode as the agent reported it.
 *
 * @param attrs - Merged attributes.
 * @returns The mode, or undefined when none was reported.
 */
function billingMode(attrs: Attributes): UsageBillingMode | undefined {
  const mode = firstString(attrs, BILLING_MODE_KEYS)?.toLowerCase();

  if (!mode) return undefined;

  if (mode.includes('api')) return 'api';

  if (mode.includes('chatgpt') || mode.includes('subscription')) return 'subscription';

  return 'unknown';
}

/**
 * How confidently a call was joined to a product turn.
 *
 * @param correlatedTurnId - Turn the backend resolved, when it did.
 * @param productTurnId - Turn the call will carry.
 * @returns The correlation level.
 */
function correlationLevel(correlatedTurnId: string | undefined, productTurnId: string | undefined): LlmCallCorrelation {
  if (correlatedTurnId) return 'exact';

  if (productTurnId) return 'turn';

  return 'session';
}

/**
 * Start time derived from the end time and duration.
 *
 * `endedAt` can be an unparseable attribute string, and NaN arithmetic would
 * make toISOString() throw — so a start is derived only from a real time.
 *
 * @param endedAt - The call's end time.
 * @param durationMs - Its duration, when reported.
 * @returns The start time, or undefined.
 */
function derivedStartedAt(endedAt: string, durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;

  const ended = Date.parse(endedAt);

  if (!Number.isFinite(ended)) return undefined;

  return new Date(ended - durationMs).toISOString();
}

/**
 * A call id built from the trace context.
 *
 * @param traceId - Trace id, when present.
 * @param spanId - Span id, when present.
 * @returns The composed id, or undefined when there is no trace at all.
 */
function traceIdAndSpan(traceId?: string, spanId?: string): string | undefined {
  if (!traceId) return undefined;

  return spanId ? `${traceId}:${spanId}` : traceId;
}

/**
 * A deterministic call id for a record that carries no identifier at all.
 *
 * The raw nanosecond timestamp and the full canonical record identity both go
 * in: `endedAt` is millisecond precision and is not unique for concurrent
 * calls, so hashing it alone would collapse two real calls into one.
 *
 * @param provider - Detected provider.
 * @param sessionId - Session, when known.
 * @param turnId - Turn, when known.
 * @param sequence - Provider sequence number, when reported.
 * @param endedAt - Resolved end time.
 * @param log - The raw log record.
 * @param attrs - Merged attributes.
 * @returns The derived id.
 */
function stableFallback(
  provider: string,
  sessionId: string | undefined,
  turnId: string | undefined,
  sequence: string | undefined,
  endedAt: string,
  log: Attributes,
  attrs: Attributes
): string {
  const recordIdentity = {
    timeUnixNano: log['timeUnixNano'],
    observedTimeUnixNano: log['observedTimeUnixNano'],
    severityNumber: log['severityNumber'],
    severityText: log['severityText'],
    body: log['body'],
    attrs: Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)))
  };
  const digest = sha256Hex(JSON.stringify([provider, sessionId, turnId, sequence, endedAt, recordIdentity]));

  return `${DERIVED_CALL_ID_PREFIX}${digest.slice(0, DERIVED_CALL_ID_HEX_LENGTH)}`;
}
