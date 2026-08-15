import type { ProductEvent } from '../events/product-event.js';
import type { EventTransport } from './transport.js';
import { ANY_DESTINATION, type EventQueue } from './queue.js';
import type { BackendCooldown } from './cooldown.js';
import type { DeliveryStats } from './delivery-stats.js';
import { debugLog } from '../core/logger.js';

/** How long hooks skip direct sends after the backend failed one. */
export const BACKEND_COOLDOWN_MS = 60_000;

export interface DeliveryOutcome {
  delivered: number;
  queued: number;
  drained: number;
  /** Events the backend permanently rejected (they are never resent). */
  rejected: number;
}

/**
 * Hook-path delivery: one quick direct send; on failure persist locally
 * (per the offline policy) and move on. When the backend is healthy,
 * opportunistically drain a bounded batch of previously queued events.
 */
export async function deliverEvents(
  events: ProductEvent[],
  transport: EventTransport | undefined,
  queue: EventQueue,
  drainBatchSize: number,
  cooldown?: BackendCooldown,
  stats?: DeliveryStats
): Promise<DeliveryOutcome> {
  if (!transport) {
    // No endpoint configured yet: keep (policy-filtered) events for whatever
    // backend setup configures first.
    if (events.length > 0) await queue.enqueue(events, ANY_DESTINATION);
    return { delivered: 0, queued: events.length, drained: 0, rejected: 0 };
  }

  // Hooks that do not emit a summary still keep the offline queue moving.
  // Avoid an empty direct request and only attempt the existing backlog.
  if (events.length === 0) {
    if (cooldown && (await cooldown.active())) return { delivered: 0, queued: 0, drained: 0, rejected: 0 };
    const drainStats = await queue.drain(transport, drainBatchSize, stats);
    return { delivered: 0, queued: 0, drained: drainStats.sent, rejected: drainStats.rejected };
  }

  // Circuit breaker: a recently-dead backend must not cost every hook the
  // full send timeout. During the cooldown, skip straight to the queue.
  if (cooldown && (await cooldown.active())) {
    if (events.length > 0) await queue.enqueue(events, transport.destination);
    return { delivered: 0, queued: events.length, drained: 0, rejected: 0 };
  }

  const result = await transport.send(events);
  if (!result.ok) {
    debugLog('direct send failed', result.error ?? `status ${result.status}`);
    if (result.retryable) {
      if (cooldown) await cooldown.trip(BACKEND_COOLDOWN_MS);
    }
    // Product records are never discarded on the direct path. A permanent
    // response can be caused by a temporarily incompatible route/schema and
    // the queued copy may succeed after the backend is corrected.
    await queue.enqueue(events, transport.destination);
    return { delivered: 0, queued: events.length, drained: 0, rejected: 0 };
  }

  const rejected = result.counters?.rejected ?? 0;
  if (rejected > 0) {
    debugLog(`backend permanently rejected ${rejected} event(s) from the direct send`);
    if (stats) await stats.recordRejected(rejected);
  }

  if (cooldown) await cooldown.clear();
  const drainStats = await queue.drain(transport, drainBatchSize, stats);
  return { delivered: events.length, queued: 0, drained: drainStats.sent, rejected: rejected + drainStats.rejected };
}
