import type { FeatureCandidate, UsageBillingMode } from '../events/canonical-event.js';
import { buildLlmCall, type LlmCallEvent } from '../events/llm-call.js';
import { sha256Hex } from '../events/event-id.js';

type Attributes = Record<string, unknown>;

export interface OtlpCorrelationContext {
  /** Root product scope resolved from prompt/span/spawn edges. */
  sessionId?: string;
  turnId?: string;
  surface?: string;
  billingMode?: UsageBillingMode;
  agentId?: string;
  parentAgentId?: string;
  agentType?: string;
  git?: {
    repository?: string;
    branch?: string;
    commit?: string;
  };
  featureCandidates?: FeatureCandidate[];
}

export interface NormalizeOtlpOptions {
  /**
   * Backend lookup populated from hook summaries and agent lifecycle/spawn
   * telemetry. It is intentionally synchronous so a batch can be normalized
   * inside one database transaction.
   */
  correlate?: (identity: {
    provider: 'claude' | 'codex';
    sessionId?: string;
    turnId?: string;
    threadId?: string;
    agentId?: string;
    agentType?: string;
    endedAt: string;
  }) => OtlpCorrelationContext | undefined;
  /**
   * Ingest time of the batch, used for records that carry no usable
   * timestamp of their own. Epoch 0 is never fabricated — it would push the
   * call outside every aggregation window — so without this fallback such
   * records are skipped.
   */
  receivedAt?: string;
}

/**
 * Normalize OTLP/JSON logs into the only atomic usage record: llm.call.
 * Duplicate OTLP delivery is safe because call ids and event ids are stable;
 * the backend must upsert on call_id (scoped by provider).
 */
export function normalizeOtlpLogs(payload: unknown, options: NormalizeOtlpOptions = {}): LlmCallEvent[] {
  const root = asRecord(payload);
  const calls: LlmCallEvent[] = [];
  for (const resource of asArray(root?.['resourceLogs'])) {
    const resourceRecord = asRecord(resource);
    const resourceAttributes = attributes(asRecord(resourceRecord?.['resource'])?.['attributes']);
    for (const scope of asArray(resourceRecord?.['scopeLogs'])) {
      const scopeRecord = asRecord(scope);
      for (const log of asArray(scopeRecord?.['logRecords'])) {
        const logRecord = asRecord(log);
        if (!logRecord) continue;
        const attrs = { ...resourceAttributes, ...attributes(logRecord['attributes']) };
        const normalized = normalizeLogRecord(logRecord, attrs, options);
        if (normalized) calls.push(normalized);
      }
    }
  }
  return calls;
}

function normalizeLogRecord(log: Attributes, attrs: Attributes, options: NormalizeOtlpOptions): LlmCallEvent | undefined {
  const eventName = firstString(attrs, ['event.name', 'name']) ?? bodyString(log['body']);
  const eventType = firstString(attrs, ['event.type', 'event.kind', 'type', 'sse_event.type', 'response.type']);
  const provider = detectProvider(eventName, eventType, attrs);
  if (!provider || !isCompletedLlmRequest(provider, eventName, eventType)) return undefined;

  const endedAt = otlpTimestamp(log) ?? firstString(attrs, ['event.timestamp', 'timestamp']) ?? options.receivedAt;
  if (!endedAt) return undefined;
  const sessionId = firstString(attrs, provider === 'claude' ? ['session.id'] : ['conversation.id', 'thread.id', 'session.id']);
  const turnId = firstString(attrs, ['prompt.id', 'turn.id', 'turn_id']);
  const threadId = firstString(attrs, ['thread.id']);
  const requestId = firstString(attrs, ['request_id', 'request.id', 'response.id', 'response_id', 'client_request_id']);
  const sequence = firstString(attrs, ['event.sequence', 'sequence']);
  const traceId = firstString(log, ['traceId']);
  const spanId = firstString(log, ['spanId']);
  const callId = requestId ?? traceIdAndSpan(traceId, spanId) ?? stableFallback(provider, sessionId, turnId, sequence, endedAt, log, attrs);

  const observedAgentId = firstString(attrs, ['agent_id', 'agent.id', 'subagent.id']) ?? (provider === 'codex' ? threadId : undefined);
  const observedAgentType = firstString(attrs, ['query_source', 'agent.name', 'agent.type', 'subagent.type']);
  const correlated = options.correlate?.({ provider, sessionId, turnId, threadId, agentId: observedAgentId, agentType: observedAgentType, endedAt });
  const productSessionId = correlated?.sessionId ?? sessionId;
  const productTurnId = correlated?.turnId ?? turnId;
  const model = firstString(attrs, ['model', 'gen_ai.request.model', 'gen_ai.response.model']);
  const durationMs = firstNumber(attrs, ['duration_ms', 'request.duration_ms', 'codex.api_request.duration_ms']);

  return buildLlmCall({
    provider: provider === 'claude' ? 'claude-code' : 'codex',
    surface: correlated?.surface ?? 'cli',
    callId,
    providerRequestId: requestId,
    providerSessionId: productSessionId !== sessionId ? sessionId : undefined,
    providerTurnId: productTurnId !== turnId ? turnId : undefined,
    sessionId: productSessionId,
    turnId: productTurnId,
    agentId: correlated?.agentId ?? observedAgentId,
    parentAgentId: correlated?.parentAgentId,
    agentType: correlated?.agentType ?? observedAgentType,
    model,
    billingMode: correlated?.billingMode ?? billingMode(attrs),
    status: firstString(attrs, ['error', 'error.message']) ? 'failed' : 'completed',
    correlation: correlated?.turnId ? 'exact' : productTurnId ? 'turn' : 'session',
    usage: {
      inputTokens: firstNumber(attrs, ['input_tokens', 'input_token_count', 'gen_ai.usage.input_tokens', 'codex.turn.token_usage.input_tokens']),
      cachedInputTokens: firstNumber(attrs, ['cache_read_tokens', 'cached_input_tokens', 'cached_input_token_count', 'gen_ai.usage.cache_read.input_tokens']),
      cacheCreationInputTokens: firstNumber(attrs, ['cache_creation_tokens', 'cache_write_input_tokens', 'gen_ai.usage.cache_write.input_tokens']),
      outputTokens: firstNumber(attrs, ['output_tokens', 'output_token_count', 'gen_ai.usage.output_tokens', 'codex.turn.token_usage.output_tokens']),
      reasoningOutputTokens: firstNumber(attrs, ['reasoning_output_tokens', 'reasoning_token_count', 'codex.usage.reasoning_output_tokens']),
      totalTokens: firstNumber(attrs, ['total_tokens', 'codex.usage.total_tokens', 'codex.turn.token_usage.total_tokens'])
    },
    costUsd: firstNumber(attrs, ['cost_usd', 'cost.usd']),
    durationMs,
    startedAt: durationMs !== undefined ? new Date(Date.parse(endedAt) - durationMs).toISOString() : undefined,
    endedAt,
    git: correlated?.git,
    featureCandidates: correlated?.featureCandidates
  });
}

function detectProvider(eventName: string | undefined, eventType: string | undefined, attrs: Attributes): 'claude' | 'codex' | undefined {
  const names = `${eventName ?? ''} ${eventType ?? ''}`;
  if (/codex[._](sse_event|api_request)|response\.completed/.test(names) && firstString(attrs, ['conversation.id', 'thread.id'])) return 'codex';
  if (/claude_code[._](api_request|llm_request)/.test(names) && firstString(attrs, ['session.id'])) return 'claude';
  // Older Claude logs may use the bare event name. Do not let that generic
  // alias steal a provider-qualified Codex record that also carries a
  // compatibility session.id attribute.
  if ((eventName === 'api_request' || eventType === 'api_request') && firstString(attrs, ['session.id']) && !firstString(attrs, ['conversation.id', 'thread.id'])) {
    return 'claude';
  }
  return undefined;
}

function isCompletedLlmRequest(provider: 'claude' | 'codex', eventName?: string, eventType?: string): boolean {
  const names = `${eventName ?? ''} ${eventType ?? ''}`;
  if (provider === 'claude') return /api_request/.test(names);
  return /codex[._]api_request|response\.completed/.test(names);
}

function attributes(value: unknown): Attributes {
  const out: Attributes = {};
  for (const item of asArray(value)) {
    const record = asRecord(item);
    const key = typeof record?.['key'] === 'string' ? record['key'] : undefined;
    if (!key) continue;
    out[key] = otlpValue(record?.['value']);
  }
  return out;
}

function otlpValue(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['stringValue', 'intValue', 'doubleValue', 'boolValue'] as const) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function otlpTimestamp(log: Attributes): string | undefined {
  // proto3 JSON encodes an unset uint64 as "0", which is not nullish: it must
  // fall through to the collector-observed time, not become 1970 and push the
  // call outside every aggregation window.
  const raw = [log['timeUnixNano'], log['observedTimeUnixNano']].find(
    (value): value is string | number => (typeof value === 'string' || typeof value === 'number') && value !== '0' && value !== 0
  );
  if (raw === undefined) return undefined;
  try {
    return new Date(Number(BigInt(raw) / 1_000_000n)).toISOString();
  } catch {
    return undefined;
  }
}

function bodyString(value: unknown): string | undefined {
  const record = asRecord(value);
  return typeof record?.['stringValue'] === 'string' ? record['stringValue'] : undefined;
}

function billingMode(attrs: Attributes): UsageBillingMode | undefined {
  const mode = firstString(attrs, ['billing_mode', 'auth_mode'])?.toLowerCase();
  if (!mode) return undefined;
  if (mode.includes('api')) return 'api';
  if (mode.includes('chatgpt') || mode.includes('subscription')) return 'subscription';
  return 'unknown';
}

function firstString(record: Attributes, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function firstNumber(record: Attributes, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function traceIdAndSpan(traceId?: string, spanId?: string): string | undefined {
  return traceId && spanId ? `${traceId}:${spanId}` : traceId;
}

function stableFallback(
  provider: string,
  sessionId: string | undefined,
  turnId: string | undefined,
  sequence: string | undefined,
  endedAt: string,
  log: Attributes,
  attrs: Attributes
): string {
  // Keep the raw nanosecond timestamp and the full canonical record identity.
  // endedAt is millisecond precision and is not unique for concurrent calls.
  const recordIdentity = {
    timeUnixNano: log['timeUnixNano'],
    observedTimeUnixNano: log['observedTimeUnixNano'],
    severityNumber: log['severityNumber'],
    severityText: log['severityText'],
    body: log['body'],
    attrs: Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)))
  };
  return `derived_${sha256Hex(JSON.stringify([provider, sessionId, turnId, sequence, endedAt, recordIdentity])).slice(0, 40)}`;
}

function asRecord(value: unknown): Attributes | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Attributes) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
