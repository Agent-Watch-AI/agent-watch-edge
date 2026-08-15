import type { ProductEvent } from '../events/product-event.js';

export interface DeliveryCounters {
  accepted: number;
  duplicate: number;
  rejected: number;
  failed: number;
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  /** Whether a failure is worth retrying later (network error, 5xx, 429...). */
  retryable: boolean;
  error?: string;
  /** Per-event outcome counters from an accepted batch, when the backend sent them. */
  counters?: DeliveryCounters;
}

export interface EventTransport {
  send(events: ProductEvent[]): Promise<DeliveryResult>;
  /** Where events go (events URL). Queued entries are pinned to it so a
   *  later endpoint change never replays old events to the new backend;
   *  re-routing the backlog takes the user's explicit consent in setup. */
  readonly destination?: string;
}
