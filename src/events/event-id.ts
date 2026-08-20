import crypto from 'node:crypto';
import { EVENT_ID_HEX_LENGTH, EVENT_ID_PREFIX } from './constants/events.constants.js';
import type { EventIdInput } from './types/events.types.js';

export type { EventIdInput } from './types/events.types.js';

/**
 * Deterministic event id, so retries and duplicate hook firings dedupe
 * downstream.
 *
 * The id is a function of the event's identity alone. That is what makes the
 * offline queue idempotent (the filename *is* the id) and what lets the
 * backend upsert instead of counting the same turn twice.
 *
 * @param input - Identity fields; content is passed pre-hashed only.
 * @returns The `evt_`-prefixed id.
 */
export function deriveEventId(input: EventIdInput): string {
  const canonical = JSON.stringify([
    input.provider,
    input.providerEventType,
    input.sessionId ?? '',
    input.turnId ?? '',
    input.generationId ?? '',
    input.toolUseId ?? '',
    input.promptId ?? '',
    input.timestamp ?? '',
    input.payloadFingerprint ?? ''
  ]);

  return EVENT_ID_PREFIX + sha256Hex(canonical).slice(0, EVENT_ID_HEX_LENGTH);
}

/**
 * Event id built from an id the provider already guarantees to be unique.
 *
 * @param provider - Internal provider id, which scopes the namespace.
 * @param rawId - The provider's own identifier.
 * @returns The namespaced event id.
 */
export function providerEventId(provider: string, rawId: string): string {
  return `${EVENT_ID_PREFIX}${provider}_${rawId}`;
}

/**
 * SHA-256 of a string, hex encoded.
 *
 * Used both for ids and as the one-way function behind every pseudonymous
 * field (repository hash, content evidence, session directory name).
 *
 * @param text - Text to digest.
 * @returns Lowercase hex digest.
 */
export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
