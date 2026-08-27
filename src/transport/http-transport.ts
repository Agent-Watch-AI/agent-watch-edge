import type { ProductEvent } from '../events/product-event.js';
import {
  CONTENT_TYPE_HEADER,
  JSON_CONTENT_TYPE,
  RETRYABLE_STATUSES
} from './constants/transport.constants.js';
import { edgeHeaders } from './headers.js';
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

    try {
      const response = await this.fetchFn(this.options.eventsUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });

      if (response.ok) {
        return { ok: true, status: response.status, retryable: false, counters: await readCounters(response) };
      }

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
 * backend that returns no JSON body is treated as counter-less, not failed.
 *
 * @param response - The backend's response.
 * @returns The counters, or undefined when the body carried none.
 */
async function readCounters(response: Response): Promise<DeliveryResult['counters']> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const numeric = (key: string): number => (typeof body[key] === 'number' ? (body[key] as number) : 0);

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
 * Auth and rate-limit problems are usually transient misconfiguration, so they
 * count as retryable; retries are capped by `delivery.maxAttempts`, so they
 * cannot accumulate forever.
 *
 * @param status - HTTP status.
 * @returns True when the batch should be queued for another attempt.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUSES.has(status);
}
