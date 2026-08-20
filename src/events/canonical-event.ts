/**
 * The canonical event vocabulary and shape.
 *
 * Kept as the module's stable entry point: the vocabulary lives in
 * `constants/events.constants.ts` and the shape in `types/events.types.ts`, so
 * a reader looking for "what can happen" and a reader looking for "what a
 * record looks like" each land in one file.
 */
export {
  CANONICAL_EVENT_TYPES,
  EVENT_SCHEMA_VERSION,
  INTERNAL_HOOK_EVENT_TYPES,
  PRODUCT_EVENT_TYPES,
  PRODUCT_EVENT_TYPE_SET,
  TURN_CLOSING_EVENT_TYPE
} from './constants/events.constants.js';

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
