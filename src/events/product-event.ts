import type { LlmCallEvent } from './types/llm-call.types.js';
import type { TurnSummaryEvent } from '../turns/types/turn-summary.types.js';

export { PRODUCT_EVENT_TYPES } from './constants/events.constants.js';
export type { ProductEventType } from './types/events.types.js';
export type { LlmCallEvent, LlmCallCorrelation, LlmCallStatus } from './types/llm-call.types.js';
export type { AgentUsageSummary, TurnSummaryEvent, TurnUsageStatus } from '../turns/types/turn-summary.types.js';

/**
 * The complete public AgentWatch domain contract.
 *
 * Two record types, deliberately: `llm.call` is the lossless per-request usage
 * ledger, `turn.summary` is the human unit of work. No lifecycle or tool event
 * is public — those exist only to assemble a summary locally.
 */
export type ProductEvent = LlmCallEvent | TurnSummaryEvent;

/** The least a value must look like for {@link isProductEvent} to judge it. */
export interface EventTypeCarrier {
  readonly event?: { readonly type?: string };
}

/**
 * Whether a record is one the backend accepts.
 *
 * The guard the offline queue uses before draining an entry: a backlog written
 * by an older release can hold internal lifecycle events, and draining one
 * would poison every batch it rides in.
 *
 * @param value - Any record carrying an `event.type`.
 * @returns True when it is an llm.call or a turn.summary.
 */
export function isProductEvent(value: EventTypeCarrier): value is EventTypeCarrier & ProductEvent {
  return value.event?.type === 'llm.call' || value.event?.type === 'turn.summary';
}
