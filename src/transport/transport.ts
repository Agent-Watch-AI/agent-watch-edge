/**
 * The contract between delivery and whatever actually moves bytes. Kept
 * separate from the HTTP implementation so the queue, the cooldown and the
 * whole test suite can substitute their own.
 */
export type { DeliveryCounters, DeliveryResult, EventTransport, HttpTransportOptions } from './types/transport.types.js';
