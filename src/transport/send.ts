import type { ProductEvent } from '../events/product-event.js';
import type { DeliveryResult, EventTransport } from './types/transport.types.js';

/**
 * Convert adapter exceptions to retryable failures without exposing request data.
 * HTTP status owns retry semantics: the gateway reports partial publish failure
 * as 503; accepted-batch counters are diagnostic, not transport failures.
 * @param transport - The selected destination adapter.
 * @param events - Records whose delivery must be confirmed.
 * @returns The adapter result, or a safe retryable failure.
 */
export async function sendEvents(transport: EventTransport, events: readonly ProductEvent[]): Promise<DeliveryResult> {
  try {
    return await transport.send(events);
  } catch {
    // Adapter errors can contain URLs, headers or captured content.
    return { ok: false, retryable: true, error: 'transport failed' };
  }
}
