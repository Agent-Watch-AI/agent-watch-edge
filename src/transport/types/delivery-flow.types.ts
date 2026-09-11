import type { ProductEvent } from '../../events/product-event.js';
import type { BackendAuthBlock } from '../auth-block.js';
import type { BackendCooldown } from '../cooldown.js';
import type { DeliveryStats } from '../delivery-stats.js';
import type { EventQueue } from '../queue.js';
import type { DeliveryOutcome, DeliveryResult, EventTransport } from './transport.types.js';

/** Immutable state for deciding, attempting, preserving and reporting delivery. */
export interface DeliveryFlowState {
  readonly events: readonly ProductEvent[];
  readonly transport: EventTransport | undefined;
  readonly queue: EventQueue;
  readonly drainBatchSize: number;
  readonly cooldown: BackendCooldown | undefined;
  readonly stats: DeliveryStats | undefined;
  readonly authBlock: BackendAuthBlock | undefined;
  readonly canSend: boolean;
  readonly result?: DeliveryResult;
  readonly outcome: DeliveryOutcome;
}
