import type { AgentWatchEvent } from '../events/canonical-event.js';

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  /** Whether a failure is worth retrying later (network error, 5xx, 429...). */
  retryable: boolean;
  error?: string;
}

export interface EventTransport {
  send(events: AgentWatchEvent[]): Promise<DeliveryResult>;
}
