/**
 * Getting product records to the backend without ever losing one and without
 * ever making the coding agent wait: one bounded direct send, a persisted
 * circuit breaker, and a file-per-event offline queue behind it.
 */
export type {
  DeliveryCounters,
  DeliveryOutcome,
  DeliveryResult,
  DeliveryStatsSnapshot,
  DrainStats,
  DrainStatsRecorder,
  EventTransport,
  HttpTransportOptions,
  QueueEntry,
  QueueOptions
} from './types/transport.types.js';

export { ANY_DESTINATION, BACKEND_COOLDOWN_MS } from './constants/transport.constants.js';
export { HttpTransport } from './http-transport.js';
export { bridgeHeaders } from './headers.js';
export { EventQueue } from './queue.js';
export { BackendCooldown } from './cooldown.js';
export { DeliveryStats } from './delivery-stats.js';
export { deliverEvents } from './delivery.js';
