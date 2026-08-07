import crypto from 'node:crypto';

export interface EventIdInput {
  provider: string;
  providerEventType: string;
  sessionId?: string;
  turnId?: string;
  generationId?: string;
  toolUseId?: string;
  promptId?: string;
  timestamp?: string;
  /**
   * Fingerprint of variable payload content (already hashed by the caller).
   * Raw prompt/response/tool text must never be passed here directly.
   */
  payloadFingerprint?: string;
}

/** Deterministic id so retries and duplicate hook firings dedupe downstream. */
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
  return 'evt_' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 40);
}

/** Prefer a provider-supplied event id when one exists. */
export function providerEventId(provider: string, rawId: string): string {
  return `evt_${provider}_${rawId}`;
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
