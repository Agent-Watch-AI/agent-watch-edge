/**
 * AgentWatch canonical event schema, version 1.
 *
 * Provider adapters translate native hook payloads into this shape. The
 * schema is deliberately decoupled from OpenTelemetry semantic conventions:
 * native agent OTel flows to the backend separately and is correlated there.
 */

export const CANONICAL_EVENT_TYPES = [
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

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export type UsageSource = 'native_otel' | 'hook_payload' | 'unknown';
export type UsageBillingMode = 'api' | 'subscription' | 'unknown';

export interface FeatureCandidate {
  type: 'ticket' | 'branch' | 'other';
  value: string;
  source: string;
}

export interface AgentWatchEvent {
  schemaVersion: '1';
  id: string;
  timestamp: string;

  event: {
    type: CanonicalEventType;
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
