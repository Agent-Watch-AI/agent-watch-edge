import { performance } from 'node:perf_hooks';
import type { ProductEvent } from '../events/product-event.js';
import { applyProductCapture } from '../privacy/product-capture.js';
import {
  CONTENT_TYPE_HEADER,
  JSON_CONTENT_TYPE,
  RETRYABLE_STATUSES
} from './constants/transport.constants.js';
import { edgeHeaders } from './headers.js';
import { discardResponseBody, readCappedJson } from './response-body.js';
import type { DeliveryResult, EventTransport, HttpTransportOptions } from './types/transport.types.js';

export type { HttpTransportOptions } from './types/transport.types.js';

/**
 * POST `{events: [...]}` to the configured backend.
 *
 * Bounded by a short timeout: this runs on the coding agent's critical path, so
 * a slow backend must cost the developer milliseconds, not seconds.
 */
export class HttpTransport implements EventTransport {
  private readonly fetchFn: typeof fetch;

  /**
   * Bind the transport to one backend.
   *
   * @param options - Destination, credentials, timeout and fetch override.
   */
  constructor(private readonly options: HttpTransportOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * Where this transport sends events.
   *
   * @returns The events URL.
   */
  get destination(): string {
    return this.options.eventsUrl;
  }

  /**
   * Send one batch.
   *
   * @param events - Product events to deliver.
   * @returns Whether the backend took them, and whether a failure is worth
   *   retrying.
   */
  async send(events: readonly ProductEvent[]): Promise<DeliveryResult> {
    if (events.length === 0) return { ok: true, retryable: false };

    // Current policy, not the policy the record was written under: a queued
    // event may predate a revoked consent or capture flag.
    const payload: ProductEvent[] = [];

    for (const event of events) {
      const captured = applyProductCapture(event, this.options.capture);

      if (captured) payload.push(captured);
    }

    if (payload.length === 0) return { ok: true, retryable: false };

    const remaining = this.options.deadline === undefined ? this.options.timeoutMs : this.options.deadline - (this.options.nowMs?.() ?? performance.now());

    if (remaining <= 0) return { ok: false, retryable: true, deferred: true };

    try {
      const response = await this.fetchFn(this.options.eventsUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ events: payload }),
        // A redirect would move a batch that carries a bearer to an endpoint
        // nothing configured; refusing is the only safe answer.
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(this.options.timeoutMs, remaining))))
      });

      if (response.ok) {
        return { ok: true, status: response.status, retryable: false, counters: await readCounters(response) };
      }

      discardResponseBody(response);

      return { ok: false, status: response.status, retryable: isRetryableStatus(response.status), error: `HTTP ${response.status}` };
    } catch (error) {
      // Never include response or request bodies in errors: they carry event
      // content, and this string ends up in logs.
      return { ok: false, retryable: true, error: (error as Error).name || 'network error' };
    }
  }

  /**
   * Headers for one request.
   *
   * @returns The header map.
   */
  private headers(): Record<string, string> {
    return {
      [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
      ...edgeHeaders(this.options.token, this.options.installationId)
    };
  }
}

/**
 * Per-event counters from an accepted batch.
 *
 * A 202 can still carry per-event rejections, and the batch "succeeding" while
 * events inside it were dropped is exactly the case the caller must see. A
 * backend that returns no JSON body — or one too large to be counters — is
 * treated as counter-less, not failed.
 *
 * @param response - The backend's response.
 * @returns The counters, or undefined when the body carried none.
 */
async function readCounters(response: Response): Promise<DeliveryResult['counters']> {
  try {
    const body = (await readCappedJson(response)) as Record<string, unknown>;
    // Own properties only: this object came off the network, so a `__proto__`
    // in the body must not answer for a counter nobody sent.
    const numeric = (key: string): number => (Object.hasOwn(body, key) && Number.isSafeInteger(body[key]) && (body[key] as number) >= 0 ? body[key] as number : 0);

    return {
      accepted: numeric('accepted'),
      duplicate: numeric('duplicate'),
      rejected: numeric('rejected'),
      failed: numeric('failed')
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether a failing status is worth retrying.
 *
 * A rate limit or a timeout is transient, so those count as retryable and are
 * capped by `delivery.maxAttempts`. A refused *credential* is deliberately not
 * here: see `AUTH_REJECTED_STATUSES` and `BackendAuthBlock` — the records stay
 * queued, but re-presenting a rejected bearer on every hook does not.
 *
 * @param status - HTTP status.
 * @returns True when the batch should be queued for another attempt.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUSES.has(status);
}
