import { z } from 'zod';

/**
 * One persisted offline-queue entry.
 *
 * Passthrough so an entry written by a newer version survives a downgrade with
 * its unknown fields intact rather than being dropped as invalid — which, for
 * this file, would mean losing the event.
 */
export const queueEntrySchema = z
  .object({
    event: z.record(z.unknown()),
    attempts: z.number().int().nonnegative().default(0),
    firstQueuedAt: z.string(),
    nextAttemptAt: z.string(),
    /** Events URL this entry was queued for; absent on pre-destination entries. */
    destination: z.string().optional()
  })
  .passthrough();
