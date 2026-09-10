import { debugLog } from '../core/logger.js';
import { next, runFlow, step } from '../core/pipe.js';
import type { Step, StepOutcome } from '../core/types/core.types.js';
import type { ProductEvent } from '../events/product-event.js';
import type { BackendAuthBlock } from './auth-block.js';
import type { BackendCooldown } from './cooldown.js';
import type { DeliveryStats } from './delivery-stats.js';
import { ANY_DESTINATION, AUTH_REJECTED_STATUSES, BACKEND_COOLDOWN_MS, DELIVERY_STAGE_NAMES } from './constants/transport.constants.js';
import { sendEvents } from './send.js';
import type { EventQueue } from './queue.js';
import type { DeliveryFlowState } from './types/delivery-flow.types.js';
import type { DeliveryOutcome, EventTransport } from './types/transport.types.js';

export { BACKEND_COOLDOWN_MS } from './constants/transport.constants.js';
export type { DeliveryOutcome } from './types/transport.types.js';

const DELIVERY_STAGES: readonly Step<DeliveryFlowState>[] = [
  step(DELIVERY_STAGE_NAMES.select, selectDelivery),
  step(DELIVERY_STAGE_NAMES.send, sendCurrent),
  step(DELIVERY_STAGE_NAMES.preserve, preserveUnsent),
  step(DELIVERY_STAGE_NAMES.report, reportBackend),
  step(DELIVERY_STAGE_NAMES.maintain, maintainQueue)
];

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
  const flow = await runFlow(DELIVERY_STAGES, {
    events, transport, queue, drainBatchSize, cooldown, stats, authBlock,
    canSend: false,
    outcome: { delivered: 0, queued: 0, drained: 0, rejected: 0 }
  });

  // A failed filesystem write must remain observable to the enclosing hook
  // flow; returning a successful outcome would falsely claim durable delivery.
  if (!flow.completed) throw new Error(`delivery failed at ${flow.stoppedAt}: ${flow.reason}`, { cause: flow.cause });

  return flow.state.outcome;
}

async function selectDelivery(state: DeliveryFlowState): Promise<StepOutcome<DeliveryFlowState>> {
  const { transport, authBlock, cooldown } = state;

  if (!transport) return next(state);

  if (transport.destination && authBlock && await authBlock.active(transport.destination)) return next(state);

  if (cooldown && await cooldown.active()) return next(state);

  return next({ ...state, canSend: true });
}

async function sendCurrent(state: DeliveryFlowState): Promise<StepOutcome<DeliveryFlowState>> {
  if (!state.canSend || !state.transport || state.events.length === 0) return next(state);

  const result = await sendEvents(state.transport, state.events);
  const outcome = result.ok ? { ...state.outcome, delivered: state.events.length, rejected: result.counters?.rejected ?? 0 } : state.outcome;

  return next({ ...state, result, outcome });
}

async function preserveUnsent(state: DeliveryFlowState): Promise<StepOutcome<DeliveryFlowState>> {
  if (state.events.length === 0 || state.result?.ok) return next(state);

  // One queue path for absence, auth block, cooldown and transport failures.
  // It precedes diagnostic writes so a stats failure cannot discard a record.
  await state.queue.enqueue(state.events, state.transport?.destination ?? ANY_DESTINATION);

  return next({ ...state, outcome: { ...state.outcome, queued: state.events.length } });
}

async function reportBackend(state: DeliveryFlowState): Promise<StepOutcome<DeliveryFlowState>> {
  const { result, cooldown, stats, authBlock, transport } = state;

  if (!result || result.deferred) return next(state);

  if (!result.ok) {
    debugLog('direct send failed', result.error ?? `status ${result.status}`);

    if (result.retryable && (result.status === undefined || result.status >= 400) && cooldown) await cooldown.trip(BACKEND_COOLDOWN_MS);

    if (!result.retryable && stats) await stats.recordRefusal(result.status);

    if (result.status !== undefined && AUTH_REJECTED_STATUSES.has(result.status) && authBlock && transport?.destination) {
      await authBlock.raise(transport.destination, result.status);
    }

    return next(state);
  }

  if (state.outcome.rejected > 0 && stats) await stats.recordRejected(state.outcome.rejected);

  if (cooldown) await cooldown.clear();

  if (authBlock) await authBlock.clear();

  return next(state);
}

async function maintainQueue(state: DeliveryFlowState): Promise<StepOutcome<DeliveryFlowState>> {
  if (!state.canSend || !state.transport || (state.result && !state.result.ok)) {
    await state.queue.sweep(state.stats);

    return next(state);
  }

  const drained = await state.queue.drain(state.transport, state.drainBatchSize, state.stats, state.authBlock);

  return next({ ...state, outcome: { ...state.outcome, drained: drained.sent, rejected: state.outcome.rejected + drained.rejected } });
}
