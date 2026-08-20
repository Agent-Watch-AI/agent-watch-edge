/**
 * The canonical event model: what a record looks like, how its identity is
 * derived, and how development context is attached before it is sent.
 */
export type {
  AgentWatchEvent,
  CanonicalEventType,
  ContentEvidence,
  EventAi,
  EventGit,
  EventIdInput,
  EventPatch,
  EventSession,
  EventTool,
  EventUsage,
  FeatureCandidate,
  InternalHookEventType,
  ProductEventType,
  UsageBillingMode,
  UsageSource
} from './types/events.types.js';
export type { BuildLlmCallInput, LlmCallCorrelation, LlmCallEvent, LlmCallStatus, LlmCallUsage } from './types/llm-call.types.js';
export type { EnrichOptions, PathRewriter, PathRule } from './types/enrich.types.js';
export type { ProductEvent } from './product-event.js';

export {
  CANONICAL_EVENT_TYPES,
  EVENT_SCHEMA_VERSION,
  INTERNAL_HOOK_EVENT_TYPES,
  PRODUCT_EVENT_TYPES,
  PRODUCT_EVENT_TYPE_SET,
  TURN_CLOSING_EVENT_TYPE
} from './constants/events.constants.js';

export { deriveEventId, providerEventId, sha256Hex } from './event-id.js';
export { buildLlmCall } from './llm-call.js';
export { isProductEvent } from './product-event.js';
export { enrichEvents } from './enrich.js';
