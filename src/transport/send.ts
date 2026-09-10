import type { ProductEvent } from '../events/product-event.js';
import type { DeliveryResult, EventTransport } from './types/transport.types.js';

/**
 * Keep transport exceptions and partially accepted batches on the retry path.
 * Aggregate counters cannot identify the failed records, so the entire batch
 * must be retried with its original event IDs for backend deduplication.
 * @param transport - The selected destination adapter.
 * @param events - Records whose delivery must be confirmed.
 * @returns A failure value instead of an exception or a false acknowledgement.
 */
export async function sendEvents(transport: EventTransport, events: readonly ProductEvent[]): Promise<DeliveryResult> {
  try {
    const result = await transport.send(events);

    if (result.ok && (result.counters?.failed ?? 0) > 0) {
      return { ...result, ok: false, retryable: true, error: 'backend reported failed events' };
    }

    return result;
  } catch {
    // Adapter errors can contain URLs, headers or captured content.
    return { ok: false, retryable: true, error: 'transport failed' };
  }
}
