/**
 * AgentWatch canonical event schema, version 1.
 *
 * Provider adapters translate native hook payloads into this shape. The
 * schema is deliberately decoupled from OpenTelemetry semantic conventions:
 * native agent OTel flows to the backend separately and is correlated there.
 */

/**
 * Hook lifecycle events are an internal assembly format. They are consumed
 * locally to build a turn summary and must never be exposed as product
 * records. The public data model is deliberately limited to
 * PRODUCT_EVENT_TYPES below.
 */
export const INTERNAL_HOOK_EVENT_TYPES = [
  'session.started',
  'session.ended',
  'prompt.submitted',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'permission.requested',
  'file.read',
  'file.edited',
  'shell.started',
  'shell.completed',
  'mcp.started',
  'mcp.completed',
  'subagent.started',
  'subagent.completed',
  'generation.completed',
  'compaction.started',
  'compaction.completed',
  'agent.error',
  /** Provider event we don't model yet; preserved as metadata instead of dropped. */
  'agent.other'
] as const;

/** The only two record types accepted by the AgentWatch product backend. */
export const PRODUCT_EVENT_TYPES = ['llm.call', 'turn.summary'] as const;

export const CANONICAL_EVENT_TYPES = [...INTERNAL_HOOK_EVENT_TYPES, ...PRODUCT_EVENT_TYPES] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];
export type InternalHookEventType = (typeof INTERNAL_HOOK_EVENT_TYPES)[number];
export type ProductEventType = (typeof PRODUCT_EVENT_TYPES)[number];

export type UsageSource = 'native_otel' | 'hook_payload' | 'transcript' | 'unknown';
export type UsageBillingMode = 'api' | 'subscription' | 'unknown';

export interface FeatureCandidate {
  type: 'ticket' | 'branch' | 'other';
  value: string;
  source: string;
}

export interface AgentWatchEvent<TType extends CanonicalEventType = CanonicalEventType> {
  schemaVersion: '1';
  id: string;
  timestamp: string;

  event: {
    type: TType;
    providerEventType: string;
  };

  agent: {
    provider: string;
    name: string;
    version?: string;
  };

  session: {
    /** Normalized session identifier (provider session/thread id, verbatim). */
    id?: string;
    /** The provider-native identifier this `id` was taken from, unmodified. */
    providerId?: string;
    turnId?: string;
    generationId?: string;
    agentId?: string;
  };

  developer?: {
    installationId?: string;
  };

  git?: {
    repository?: string;
    repositoryHash?: string;
    remote?: string;
    branch?: string;
    commit?: string;
    workingDirectory?: string;
    changedFiles?: string[];
  };

  feature?: {
    candidates?: FeatureCandidate[];
  };

  ai?: {
    provider?: string;
    model?: string;
    billingMode?: UsageBillingMode;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      cacheCreationInputTokens?: number;
      cachedOutputTokens?: number;
      totalTokens?: number;
      source?: UsageSource;
    };
  };

  tool?: {
    name?: string;
    status?: 'started' | 'completed' | 'failed';
    durationMs?: number;
  };

  metadata?: Record<string, unknown>;
}
