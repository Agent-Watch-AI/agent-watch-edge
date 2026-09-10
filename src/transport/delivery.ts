import { debugLog } from '../core/logger.js';
import type { ProductEvent } from '../events/product-event.js';
import type { BackendAuthBlock } from './auth-block.js';
import type { BackendCooldown } from './cooldown.js';
import type { DeliveryStats } from './delivery-stats.js';
import { ANY_DESTINATION, AUTH_REJECTED_STATUSES, BACKEND_COOLDOWN_MS } from './constants/transport.constants.js';
import type { EventQueue } from './queue.js';
import type { DeliveryOutcome, EventTransport } from './types/transport.types.js';

export { BACKEND_COOLDOWN_MS } from './constants/transport.constants.js';
export type { DeliveryOutcome } from './types/transport.types.js';

/**
 * Hook-path delivery: one quick direct send, then whatever the backlog allows.
 *
 * Three properties this has to keep, in order of importance. It never loses a
 * product record — a failed send always ends in the queue, never in a discard,
 * and that holds for a refused credential too. It never blocks the agent for
 * long — a backend that just failed is skipped entirely for the cooldown
 * window, and one that refused the credential until that credential changes,
 * rather than costing every hook a full timeout. And it keeps the backlog
 * moving even on hooks that emit nothing, because those are the majority.
 *
 * Every path that skips a drain runs `queue.sweep` before returning, because
 * the retention bound has to hold on exactly those paths: they are the
 * week-long outages it exists for, a credential block has no timer to end it,
 * and an endpoint the edge refuses is a state a machine can sit in for good.
 *
 * @param events - Product events this hook produced; often empty.
 * @param transport - Where to send, or undefined before setup configures one.
 * @param queue - The offline queue.
 * @param drainBatchSize - Ceiling on events one drain pass may send.
 * @param cooldown - Persisted circuit breaker, when enabled.
 * @param stats - Sink for permanent losses, when enabled.
 * @param authBlock - Persisted credential refusal, when enabled.
 * @returns What was delivered, queued, drained and rejected.
 */
export async function deliverEvents(
  events: readonly ProductEvent[],
  transport: EventTransport | undefined,
  queue: EventQueue,
  drainBatchSize: number,
  cooldown?: BackendCooldown,
  stats?: DeliveryStats,
  authBlock?: BackendAuthBlock
): Promise<DeliveryOutcome> {
  if (!transport) {
    // No endpoint configured yet: keep the events for whatever backend setup
    // configures first.
    if (events.length > 0) await queue.enqueue(events, ANY_DESTINATION);

    // Sweeping here mattered less when `!transport` only meant "before setup",
    // where the queue is empty. It is now a durable steady state for a
    // *configured* machine: a refused endpoint reads as unusable, the file still
    // parses and the token survives, so hooks go on queueing under that token
    // and every one of them takes this branch. Without the sweep, nothing past
    // `maxEventAgeDays` is ever removed and the partition sits at
    // `maxQueueEvents` files of prompt and response text indefinitely — on a
    // machine whose owner set an age bound. `enforceBound` keeps the disk
    // bounded, but retention is a promise about age, not size.
    await queue.sweep(stats);

    return { delivered: 0, queued: events.length, drained: 0, rejected: 0 };
  }

  if (transport.destination && authBlock && (await authBlock.active(transport.destination))) {
    // The backend is refusing this identity's credential. The records are kept
    // — that part never changes — but re-presenting a rejected bearer on every
    // hook is both useless and indistinguishable from credential stuffing at
    // the backend. Sending resumes when the fingerprint changes or `doctor`
    // proves the credential good again.
    if (events.length > 0) await queue.enqueue(events, transport.destination);

    await queue.sweep(stats);

    return { delivered: 0, queued: events.length, drained: 0, rejected: 0 };
  }

  if (await isCoolingDown(cooldown)) {
    // Circuit breaker: a recently-dead backend must not cost every hook the
    // full send timeout. Skip straight to the queue.
    if (events.length > 0) await queue.enqueue(events, transport.destination);

    await queue.sweep(stats);

    return { delivered: 0, queued: events.length, drained: 0, rejected: 0 };
  }

  if (events.length === 0) {
    // Hooks that emit no summary still keep the offline queue moving; there is
    // just no direct request to make.
    const drained = await queue.drain(transport, drainBatchSize, stats, authBlock);

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

    // A refused credential suspends sending rather than being retried for a
    // week; the enqueue below still happens, so nothing is lost.
    if (result.status !== undefined && AUTH_REJECTED_STATUSES.has(result.status) && authBlock && transport.destination) {
      await authBlock.raise(transport.destination, result.status);
    }

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

  // The backend just accepted this credential, so any block standing against it
  // is stale by proof rather than by timer.
  if (authBlock) await authBlock.clear();

  const drained = await queue.drain(transport, drainBatchSize, stats, authBlock);

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
