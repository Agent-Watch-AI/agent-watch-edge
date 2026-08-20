/**
 * AgentWatch canonical event schema, version 1.
 *
 * Provider adapters translate native hook payloads into this shape. The schema
 * is deliberately decoupled from OpenTelemetry semantic conventions: native
 * agent OTel flows to the backend separately and is correlated there.
 *
 * Every field is readonly. Events are values: an adapter that needed to
 * "adjust" one after the fact would be mutating something another stage may
 * already be reading, so enrichment and turn tracking build new events
 * instead.
 */
import type { CANONICAL_EVENT_TYPES, INTERNAL_HOOK_EVENT_TYPES, PRODUCT_EVENT_TYPES } from '../constants/events.constants.js';

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];
export type InternalHookEventType = (typeof INTERNAL_HOOK_EVENT_TYPES)[number];
export type ProductEventType = (typeof PRODUCT_EVENT_TYPES)[number];

/** Where a usage number came from; decides how much to trust it. */
export type UsageSource = 'native_otel' | 'hook_payload' | 'transcript' | 'unknown';

/** How the developer pays for this agent. */
export type UsageBillingMode = 'api' | 'subscription' | 'unknown';

/** Evidence linking a turn to a unit of work. Attribution happens in the backend. */
export interface FeatureCandidate {
  readonly type: 'ticket' | 'branch' | 'other';
  readonly value: string;
  readonly source: string;
}

export interface EventSession {
  /** Normalized session identifier (provider session/thread id, verbatim). */
  readonly id?: string;
  /** The provider-native identifier this `id` was taken from, unmodified. */
  readonly providerId?: string;
  readonly turnId?: string;
  readonly generationId?: string;
  readonly agentId?: string;
}

export interface EventGit {
  readonly repository?: string;
  readonly repositoryHash?: string;
  readonly remote?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly workingDirectory?: string;
  readonly changedFiles?: readonly string[];
}

export interface EventUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cachedOutputTokens?: number;
  readonly totalTokens?: number;
  readonly source?: UsageSource;
}

export interface EventAi {
  readonly provider?: string;
  readonly model?: string;
  readonly billingMode?: UsageBillingMode;
  readonly usage?: EventUsage;
}

export interface EventTool {
  readonly name?: string;
  readonly status?: 'started' | 'completed' | 'failed';
  readonly durationMs?: number;
}

export interface AgentWatchEvent<TType extends CanonicalEventType = CanonicalEventType> {
  readonly schemaVersion: '1';
  readonly id: string;
  readonly timestamp: string;

  readonly event: {
    readonly type: TType;
    readonly providerEventType: string;
  };

  readonly agent: {
    readonly provider: string;
    readonly name: string;
    readonly version?: string;
  };

  readonly session: EventSession;

  readonly developer?: {
    readonly installationId?: string;
  };

  readonly git?: EventGit;

  readonly feature?: {
    readonly candidates?: readonly FeatureCandidate[];
  };

  readonly ai?: EventAi;

  readonly tool?: EventTool;

  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Everything an adapter may contribute on top of the base event. */
export type EventPatch = Partial<Omit<AgentWatchEvent, 'schemaVersion' | 'id' | 'timestamp' | 'event' | 'agent'>>;

/** Length and hash of text we may not be transmitting verbatim. */
export interface ContentEvidence {
  readonly length: number;
  readonly sha256: string;
}

/** Inputs to the deterministic event id. */
export interface EventIdInput {
  readonly provider: string;
  readonly providerEventType: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly generationId?: string;
  readonly toolUseId?: string;
  readonly promptId?: string;
  readonly timestamp?: string;
  /**
   * Fingerprint of variable payload content (already hashed by the caller).
   * Raw prompt/response/tool text must never be passed here directly.
   */
  readonly payloadFingerprint?: string;
}
