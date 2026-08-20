import { debugLog } from '../core/logger.js';
import type { ProductEvent } from '../events/product-event.js';
import type { BackendCooldown } from './cooldown.js';
import type { DeliveryStats } from './delivery-stats.js';
import { ANY_DESTINATION, BACKEND_COOLDOWN_MS } from './constants/transport.constants.js';
import type { EventQueue } from './queue.js';
import type { DeliveryOutcome, EventTransport } from './types/transport.types.js';

export { BACKEND_COOLDOWN_MS } from './constants/transport.constants.js';
export type { DeliveryOutcome } from './types/transport.types.js';

/**
 * Hook-path delivery: one quick direct send, then whatever the backlog allows.
 *
 * Three properties this has to keep, in order of importance. It never loses a
 * product record — a failed send always ends in the queue, never in a discard.
 * It never blocks the agent for long — a backend that just failed is skipped
 * entirely for the cooldown window rather than costing every hook a full
 * timeout. And it keeps the backlog moving even on hooks that emit nothing,
 * because those are the majority.
 *
 * @param events - Product events this hook produced; often empty.
 * @param transport - Where to send, or undefined before setup configures one.
 * @param queue - The offline queue.
 * @param drainBatchSize - Ceiling on events one drain pass may send.
 * @param cooldown - Persisted circuit breaker, when enabled.
 * @param stats - Sink for permanent losses, when enabled.
 * @returns What was delivered, queued, drained and rejected.
 */
export async function deliverEvents(
  events: readonly ProductEvent[],
  transport: EventTransport | undefined,
  queue: EventQueue,
  drainBatchSize: number,
  cooldown?: BackendCooldown,
  stats?: DeliveryStats
): Promise<DeliveryOutcome> {
  if (!transport) {
    // No endpoint configured yet: keep the events for whatever backend setup
    // configures first.
    if (events.length > 0) await queue.enqueue(events, ANY_DESTINATION);

    return { delivered: 0, queued: events.length, drained: 0, rejected: 0 };
  }

  if (await isCoolingDown(cooldown)) {
    // Circuit breaker: a recently-dead backend must not cost every hook the
    // full send timeout. Skip straight to the queue.
    if (events.length > 0) await queue.enqueue(events, transport.destination);

    return { delivered: 0, queued: events.length, drained: 0, rejected: 0 };
  }

  if (events.length === 0) {
    // Hooks that emit no summary still keep the offline queue moving; there is
    // just no direct request to make.
    const drained = await queue.drain(transport, drainBatchSize, stats);

    return { delivered: 0, queued: 0, drained: drained.sent, rejected: drained.rejected };
  }

  const result = await transport.send(events);

  if (!result.ok) {
    debugLog('direct send failed', result.error ?? `status ${result.status}`);

    if (result.retryable && cooldown) await cooldown.trip(BACKEND_COOLDOWN_MS);

    // A refusal the transport will not retry is the whole diagnosis: without it
    // a developer sees only a backlog that grows and then empties itself when
    // the entries age out.
    if (!result.retryable && stats) await stats.recordRefusal(result.status);

    // Product records are never discarded on the direct path. A permanent
    // response can be caused by a temporarily incompatible route or schema, and
    // the queued copy may succeed once the backend is corrected.
    await queue.enqueue(events, transport.destination);

    return { delivered: 0, queued: events.length, drained: 0, rejected: 0 };
  }

  const rejected = result.counters?.rejected ?? 0;

  if (rejected > 0) {
    debugLog(`backend permanently rejected ${rejected} event(s) from the direct send`);

    if (stats) await stats.recordRejected(rejected);
  }

  if (cooldown) await cooldown.clear();

  const drained = await queue.drain(transport, drainBatchSize, stats);

  return { delivered: events.length, queued: 0, drained: drained.sent, rejected: rejected + drained.rejected };
}

/**
 * Whether the backend is inside its cooldown window.
 *
 * @param cooldown - The breaker, when one is configured.
 * @returns True when direct sends should be skipped.
 */
async function isCoolingDown(cooldown: BackendCooldown | undefined): Promise<boolean> {
  if (!cooldown) return false;

  return cooldown.active();
}
