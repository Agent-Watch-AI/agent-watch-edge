/**
 * Bounded delivery with durable retries: failed sends stay queued until
 * delivered or removed by the configured retention and retry limits.
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
export { edgeHeaders } from './headers.js';
export { EventQueue } from './queue.js';
export { identityPaths, queuePartition, settleLegacyQueue, unattributedCount, unattributedQueue } from './queue-partition.js';
export type { IdentityPaths } from './queue-partition.js';
export { BackendCooldown } from './cooldown.js';
export { DeliveryStats } from './delivery-stats.js';
export { deliverEvents } from './delivery.js';

export { sendEvents } from './send.js';
export { discardResponseBody, readCappedJson } from './response-body.js';
