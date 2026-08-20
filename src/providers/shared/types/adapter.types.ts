import type { CanonicalEventType, EventAi, EventPatch, EventTool } from '../../../events/types/events.types.js';
import type { UnknownRecord } from '../../../core/types/core.types.js';
import type { ToolKind, ToolStatus } from '../../types/provider.types.js';

/** Everything the base of a canonical event is derived from. */
export interface BaseEventInput {
  /** Internal provider id, e.g. 'claude'. */
  readonly provider: string;
  /** Human-facing agent name, e.g. 'Claude Code'. */
  readonly displayName: string;
  /** The provider's own name for this hook. */
  readonly providerEventType: string;
  readonly eventType: CanonicalEventType;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly toolUseId?: string;
  readonly promptId?: string;
  /**
   * Hash of the variable part of the payload, so two otherwise-identical
   * events of one turn get distinct ids. Never raw content.
   */
  readonly payloadFingerprint: string;
  readonly ai?: EventAi;
  /** Provider-specific fields, kept under `metadata.provider`. */
  readonly providerMetadata?: UnknownRecord;
  /** ISO timestamp; injectable so a build is reproducible in tests. */
  readonly timestamp: string;
}

/** A tool call as the shared builder understands it. */
export interface ToolCallInput {
  readonly name?: string;
  readonly status: ToolStatus;
  readonly kind: ToolKind;
  readonly durationMs?: number;
  readonly toolUseId?: string;
  /** Raw arguments, whatever shape the provider used. */
  readonly input?: unknown;
  /** Raw result, whatever shape the provider used. */
  readonly output?: unknown;
  /** Error detail, when the call failed. */
  readonly error?: unknown;
  /** Extra provider-specific fields for `metadata.provider`, e.g. MCP routing. */
  readonly providerFields?: UnknownRecord;
}

/** What the effective config allows to be captured. */
export interface CapturePolicy {
  readonly prompts: boolean;
  readonly responses: boolean;
  readonly toolInput: boolean;
  readonly toolOutput: boolean;
  readonly files: boolean;
}

/** The pieces of an event a per-hook mapping contributes. */
export type { EventPatch, EventTool };
