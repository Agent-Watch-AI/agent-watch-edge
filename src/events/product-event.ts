import type { LlmCallEvent } from './llm-call.js';
import type { TurnSummaryEvent } from '../turns/turn-summary.js';

export { PRODUCT_EVENT_TYPES } from './canonical-event.js';
export type { ProductEventType } from './canonical-event.js';
export type { LlmCallEvent, LlmCallCorrelation, LlmCallStatus } from './llm-call.js';
export type { AgentUsageSummary, TurnSummaryEvent, TurnUsageStatus } from '../turns/turn-summary.js';

/** The complete public AgentWatch domain contract. No lifecycle/tool event is public. */
export type ProductEvent = LlmCallEvent | TurnSummaryEvent;

export function isProductEvent(value: { event?: { type?: string } }): value is ProductEvent {
  return value.event?.type === 'llm.call' || value.event?.type === 'turn.summary';
}
