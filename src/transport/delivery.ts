import type { AgentWatchEvent } from '../events/canonical-event.js';
import type { EventTransport } from './transport.js';
import type { EventQueue } from './queue.js';
import { debugLog } from '../core/logger.js';

export interface DeliveryOutcome {
  delivered: number;
  queued: number;
  drained: number;
}

/**
 * Hook-path delivery: one quick direct send; on failure persist locally and
 * move on. When the backend is healthy, opportunistically drain a bounded
 * batch of previously queued events.
 */
export async function deliverEvents(
  events: AgentWatchEvent[],
  transport: EventTransport | undefined,
  queue: EventQueue,
  drainBatchSize: number
): Promise<DeliveryOutcome> {
  if (!transport) {
    // No endpoint configured yet: keep events until setup completes.
    await queue.enqueue(events);
    return { delivered: 0, queued: events.length, drained: 0 };
  }

  const result = await transport.send(events);
  if (!result.ok) {
    debugLog('direct send failed', result.error ?? `status ${result.status}`);
    if (result.retryable) {
      await queue.enqueue(events);
      return { delivered: 0, queued: events.length, drained: 0 };
    }
    return { delivered: 0, queued: 0, drained: 0 };
  }

  const stats = await queue.drain(transport, drainBatchSize);
  return { delivered: events.length, queued: 0, drained: stats.sent };
}
