import type { UnknownRecord } from '../../core/types/core.types.js';
import type { EventGit, FeatureCandidate, UsageBillingMode } from '../../events/types/events.types.js';
import type { LlmCallUsage } from '../../events/types/llm-call.types.js';
import type { OTLP_HTTP_SIGNALS } from '../constants/otlp.constants.js';

/** A flattened OTLP attribute bag. */
export type Attributes = UnknownRecord;

/** Providers whose native telemetry the normalizer understands. */
export type OtlpProvider = 'claude' | 'codex' | 'gemini';

/** What the backend knows about the scope a call belongs to. */
export interface OtlpCorrelationContext {
  /** Root product scope resolved from prompt/span/spawn edges. */
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly surface?: string;
  readonly billingMode?: UsageBillingMode;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly agentType?: string;
  readonly git?: Pick<EventGit, 'repository' | 'branch' | 'commit'>;
  readonly featureCandidates?: readonly FeatureCandidate[];
}

/** The identity a correlation lookup is given. */
export interface OtlpCallIdentity {
  readonly provider: OtlpProvider;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly threadId?: string;
  readonly agentId?: string;
  readonly agentType?: string;
  readonly endedAt: string;
}

export interface NormalizeOtlpOptions {
  /**
   * Backend lookup populated from hook summaries and agent lifecycle/spawn
   * telemetry. Intentionally synchronous, so a whole batch can be normalized
   * inside one database transaction.
   */
  readonly correlate?: (identity: OtlpCallIdentity) => OtlpCorrelationContext | undefined;
  /**
   * Ingest time of the batch, used for records that carry no usable timestamp
   * of their own. Epoch 0 is never fabricated — it would push the call outside
   * every aggregation window — so without this fallback such records are
   * skipped.
   */
  readonly receivedAt?: string;
}

/** Identity fields read off one log record before correlation. */
export interface RecordIdentity {
  readonly provider: OtlpProvider;
  readonly endedAt: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly threadId?: string;
  readonly requestId?: string;
  readonly callId: string;
  readonly observedAgentId?: string;
  readonly observedAgentType?: string;
}

/** Usage as read from OTLP attributes. */
export type OtlpUsage = LlmCallUsage;

/** OTLP/HTTP signal name. */
export type OtlpHttpSignal = (typeof OTLP_HTTP_SIGNALS)[number];

/** Outcome of decoding an OTLP/JSON request body. */
export type DecodedOtlpJson = { readonly ok: true; readonly payload: UnknownRecord } | { readonly ok: false };
