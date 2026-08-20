import type { z } from 'zod';
import type { ProductEvent } from '../../events/product-event.js';
import type { queueEntrySchema } from '../schemas/queue.schema.js';

/** Per-event outcome counters the backend reports for an accepted batch. */
export interface DeliveryCounters {
  readonly accepted: number;
  readonly duplicate: number;
  readonly rejected: number;
  readonly failed: number;
}

export interface DeliveryResult {
  readonly ok: boolean;
  readonly status?: number;
  /** Whether a failure is worth retrying later (network error, 5xx, 429...). */
  readonly retryable: boolean;
  readonly error?: string;
  /** Per-event outcomes from an accepted batch, when the backend sent them. */
  readonly counters?: DeliveryCounters;
}

export interface EventTransport {
  send(events: readonly ProductEvent[]): Promise<DeliveryResult>;
  /**
   * Where events go (the events URL).
   *
   * Queued entries are pinned to it so a later endpoint change never replays old
   * events to a new backend; re-routing the backlog takes the user's explicit
   * consent in setup.
   */
  readonly destination?: string;
}

export interface HttpTransportOptions {
  readonly eventsUrl: string;
  readonly token?: string;
  readonly installationId?: string;
  readonly timeoutMs: number;
  readonly fetchFn?: typeof fetch;
}

/** What one hook-path delivery attempt did. */
export interface DeliveryOutcome {
  readonly delivered: number;
  readonly queued: number;
  readonly drained: number;
  /** Events the backend permanently rejected; they are never resent. */
  readonly rejected: number;
}

export interface QueueOptions {
  readonly queueDir: string;
  readonly locksDir: string;
  readonly maxEvents: number;
  readonly maxAttempts: number;
  readonly maxEventAgeDays: number;
  readonly now?: () => Date;
}

export interface DrainStats {
  readonly sent: number;
  readonly failed: number;
  readonly dropped: number;
  /** Events the backend accepted the batch for but rejected individually. */
  readonly rejected: number;
  /** True when the drain lock was held elsewhere and this pass did nothing. */
  readonly skipped: boolean;
}

export interface DrainStatsRecorder {
  recordRejected(count: number): Promise<void>;
  recordDropped(count: number): Promise<void>;
}

/** One persisted queue entry. */
export type QueueEntry = z.infer<typeof queueEntrySchema>;

/** A due entry together with the file it lives in. */
export interface DueEntry {
  readonly file: string;
  readonly entry: QueueEntry;
}

/**
 * Persisted tally of everything the local queue lost, and why.
 *
 * Three separate outcomes, because they need three different fixes:
 *
 * - `rejected` — the backend accepted the batch and refused the event inside it.
 *   Never resent: the schema said no.
 * - `dropped` — the entry ran out of attempts or aged out. This is the one that
 *   used to be invisible: drain counted it and the caller threw the count away,
 *   so a backend answering 400 to everything looked exactly like a healthy queue
 *   right up to the moment the events were gone.
 * - `refusal` — the last non-retryable status seen. Without it a developer
 *   watching a growing backlog cannot tell a dead endpoint from a rejected token
 *   from a schema mismatch.
 *
 * `agentwatch status` surfaces all three.
 */
export interface DeliveryStatsSnapshot {
  readonly totalRejected: number;
  readonly lastRejectedCount: number;
  readonly lastRejectedAt: string;
  /** Events abandoned after maxAttempts or the age bound: real data loss. */
  readonly totalDropped: number;
  readonly lastDroppedCount: number;
  readonly lastDroppedAt: string;
  /** Last non-retryable HTTP status the backend answered with, if any. */
  readonly lastRefusalStatus: number;
  readonly lastRefusalAt: string;
}
